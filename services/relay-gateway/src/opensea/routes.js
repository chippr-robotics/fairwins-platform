/**
 * Read-only OpenSea proxy routes — /v1/opensea/* (spec 055 collectibles portfolio).
 *
 * Contract: specs/055-collectibles-portfolio/contracts/gateway-opensea-api.md.
 * Pipeline per request: killswitch -> fail-closed key check -> param validation -> quota ->
 * cached fetch (TTL + single-flight + serve-stale). GET-only; the gateway holds the OpenSea
 * key (FR-009) and clients only ever see normalized DTOs with {fetchedAt, stale} envelopes.
 * Nothing here touches intents, funds, or signing — a total outage of this group leaves every
 * value path intact (FR-011).
 */
import express from 'express'
import { GatewayError } from '../errors.js'
import { callerQuotaKey } from '../identity/quotaKey.js'
import { OpenSeaRequestError } from './client.js'
import { attachReferral } from './referral.js'
import { seaportProtocol } from './seaport.js'
import {
  chainSlug,
  isAddress,
  isIdentifier,
  isSlug,
  isCursor,
  isOrderHash,
  normalizeAccountPage,
  normalizeItemDetail,
  normalizeCollection,
  normalizeFeeBreakdown,
  normalizeFulfillment,
  validateListingBody,
} from './normalize.js'

/**
 * @param {object} config          full gateway config (only .opensea is read)
 * @param {{
 *   client: {get: Function, post: Function},
 *   cache: {fetchThrough: Function},
 *   quotas: {hit: Function},
 *   writeQuotas: {hit: Function},   // spec 056 sell-side (separate from read quotas)
 *   killSwitch: {isActive: () => boolean},
 * }} deps
 */
export function createOpenSeaRouter(config, { client, cache, quotas, writeQuotas, killSwitch }) {
  const os = config.opensea
  const router = express.Router()

  /** Killswitch + fail-closed key (shared by reads and writes). */
  function requireLive() {
    if (killSwitch.isActive()) {
      throw new GatewayError(503, 'killswitch_active', 'the gateway is temporarily disabled; try again later')
    }
    if (!os.apiKey) {
      throw new GatewayError(503, 'collectibles_unconfigured', 'collectible data is not configured on this gateway')
    }
  }

  /**
   * Read pre-flight: live check + read quota, keyed on the CALLER (spec 106, FR-011).
   *
   * This used to key on values out of the request — the account address, the collection slug, the
   * search terms. All caller-chosen, so walking any of them minted a fresh bucket per request and
   * the ceiling was never reached. It also throttled a hundred members reading one popular
   * collection against each other while never limiting one script reading a hundred collections.
   */
  function guard(req) {
    requireLive()
    const q = quotas.hit(callerQuotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} collectibles read quota exceeded`, {
        retryAfterSec: q.retryAfterSec,
      })
    }
  }

  /**
   * Write pre-flight (spec 056): live check + the tighter write quota, keyed on the CALLER.
   *
   * Formerly keyed by the seller address FROM THE BODY — which the caller writes, so it metered
   * nothing. These routes now also require proof of control (spec 106 route table), so the caller
   * subject is an account we verified rather than one they asserted.
   */
  function guardWrite(req) {
    requireLive()
    const q = (writeQuotas ?? quotas).hit(callerQuotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} collectibles write quota exceeded`, {
        retryAfterSec: q.retryAfterSec,
      })
    }
  }

  /** chainId param -> OpenSea slug, or 404 unsupported_chain (soft-fail contract, FR-007). */
  function requireSlugForChain(chainIdParam) {
    const slug = chainSlug(chainIdParam)
    if (!slug) {
      throw new GatewayError(404, 'unsupported_chain', 'collectibles are not available on this network')
    }
    return slug
  }

  const respond = (res, { value, fetchedAt, stale }) =>
    res.json({ ...value, fetchedAt: new Date(fetchedAt).toISOString(), stale })

  function handleError(res, err) {
    if (err instanceof GatewayError) {
      if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
      return res.status(err.status).json(err.toBody())
    }
    if (err instanceof OpenSeaRequestError) {
      // Definitive upstream 404 (unknown item/collection) is honest data, not an outage.
      if (err.status === 404) {
        return res.status(404).json({ error: { code: 'not_found', reason: 'the marketplace does not know this item' } })
      }
      // Surface the marketplace's own rejection reason (e.g. fee mismatch) so the seller can act
      // (FR-002/FR-010). This is OpenSea's message, not gateway internals.
      const reason = typeof err.message === 'string' ? err.message.replace(/^opensea rejected request \(\d+\): /, '').slice(0, 200) : ''
      return res.status(502).json({
        error: { code: 'upstream_rejected', reason: reason || 'the marketplace rejected this request' },
      })
    }
    // OpenSeaUnavailableError and anything unexpected: degraded, cache had nothing to serve.
    return res
      .status(503)
      .json({ error: { code: 'upstream_unavailable', reason: 'collectible data is temporarily unavailable; try again later' } })
  }

  // ---- GET /v1/opensea/:chainId/account/:address/nfts --------------------------------------
  router.get('/v1/opensea/:chainId/account/:address/nfts', async (req, res) => {
    try {
      const { address } = req.params
      const next = req.query.next ?? null
      const slug = requireSlugForChain(req.params.chainId)
      if (!isAddress(address)) throw new GatewayError(400, 'invalid_address', 'address must be a 0x-prefixed 20-byte hex address')
      if (!isCursor(next)) throw new GatewayError(400, 'invalid_cursor', 'malformed pagination cursor')
      guard(req)

      const chainId = Number(req.params.chainId)
      const result = await cache.fetchThrough(
        `nfts:${chainId}:${address.toLowerCase()}:${next ?? ''}`,
        os.cacheTtlMs,
        async () => {
          const body = await client.get(`/api/v2/chain/${slug}/account/${address}/nfts`, {
            limit: '50',
            ...(next ? { next } : {}),
          })
          return normalizeAccountPage(body, chainId)
        }
      )
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/opensea/:chainId/contract/:contract/nfts/:identifier -------------------------
  // Composed: item detail + collection metadata + floor stats + best offer in one response, so
  // the detail sheet costs one round-trip and one cache entry. Floor/offer legs degrade to null
  // on failure (honest "unavailable" beats a failed sheet); only the item leg is fatal.
  router.get('/v1/opensea/:chainId/contract/:contract/nfts/:identifier', async (req, res) => {
    try {
      const { contract, identifier } = req.params
      const slug = requireSlugForChain(req.params.chainId)
      if (!isAddress(contract)) throw new GatewayError(400, 'invalid_address', 'contract must be a 0x-prefixed 20-byte hex address')
      if (!isIdentifier(identifier)) throw new GatewayError(400, 'invalid_identifier', 'token identifier must be 1-128 digits')
      guard(req)

      const chainId = Number(req.params.chainId)
      const result = await cache.fetchThrough(
        `item:${chainId}:${contract.toLowerCase()}:${identifier}`,
        os.cacheTtlMs,
        async () => {
          const nftBody = await client.get(`/api/v2/chain/${slug}/contract/${contract}/nfts/${identifier}`)
          const collectionSlug = typeof nftBody?.nft?.collection === 'string' ? nftBody.nft.collection : null
          const soft = (p) => p.catch(() => null) // degraded leg -> null field, not a failed sheet
          const [collectionBody, statsBody, offerBody, listingBody] = collectionSlug
            ? await Promise.all([
                soft(client.get(`/api/v2/collections/${collectionSlug}`)),
                soft(client.get(`/api/v2/collections/${collectionSlug}/stats`)),
                soft(client.get(`/api/v2/offers/collection/${collectionSlug}/nfts/${identifier}/best`)),
                // Best listing for the item (spec 056) — drives the Cancel affordance; degrades to null.
                soft(client.get(`/api/v2/listings/collection/${collectionSlug}/nfts/${identifier}/best`)),
              ])
            : [null, null, null, null]
          const detail = normalizeItemDetail({ nftBody, collectionBody, statsBody, offerBody, listingBody }, chainId)
          if (!detail) throw new OpenSeaRequestError(404, 'item not present upstream')
          return detail
        }
      )
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/opensea/collections/:slug/stats ----------------------------------------------
  // Floor prices for the Portfolio estimate (US3) — longer TTL, floors move slowly.
  router.get('/v1/opensea/collections/:slug/stats', async (req, res) => {
    try {
      const { slug } = req.params
      if (!isSlug(slug)) throw new GatewayError(400, 'invalid_slug', 'collection slug must be lowercase alphanumeric/hyphen')
      guard(req)

      const result = await cache.fetchThrough(`stats:${slug}`, os.statsCacheTtlMs, async () => {
        const statsBody = await client.get(`/api/v2/collections/${slug}/stats`)
        const { floorPrice } = normalizeCollection(slug, null, statsBody)
        return { slug, floorPrice }
      })
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ===== sell-side write routes (spec 056) =====================================================

  // ---- GET /v1/opensea/:chainId/collections/:slug/required-fees --------------------------------
  // The live fee basis (marketplace fee + creator royalty + protocol/conduit) the client bakes into
  // the order consideration AND shows as net proceeds. Read semantics (cached briefly). A null fee
  // breakdown -> 503 so the client blocks signing rather than guessing (FR-009).
  router.get('/v1/opensea/:chainId/collections/:slug/required-fees', async (req, res) => {
    try {
      const { slug } = req.params
      const chainId = Number(req.params.chainId)
      if (!seaportProtocol(chainId)) throw new GatewayError(404, 'unsupported_chain', 'selling is not available on this network')
      if (!isSlug(slug)) throw new GatewayError(400, 'invalid_slug', 'collection slug must be lowercase alphanumeric/hyphen')
      guard(req)

      const result = await cache.fetchThrough(`fees:${chainId}:${slug}`, os.cacheTtlMs, async () => {
        const collectionBody = await client.get(`/api/v2/collections/${slug}`)
        const fees = normalizeFeeBreakdown(collectionBody, chainId, slug)
        if (!fees) throw new OpenSeaRequestError(404, 'no fee data for collection')
        return fees
      })
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- POST /v1/opensea/:chainId/listings -----------------------------------------------------
  // Publish a client-signed Seaport listing. Write quota keyed by the seller (offerer). attachReferral
  // records FairWins as OpenSea's referral beneficiary at no user cost (never a surcharge). NOT retried
  // on 5xx (client.post) — publishing is not idempotent.
  router.post('/v1/opensea/:chainId/listings', async (req, res) => {
    try {
      const chainId = Number(req.params.chainId)
      const proto = seaportProtocol(chainId)
      if (!proto) throw new GatewayError(404, 'unsupported_chain', 'selling is not available on this network')
      const invalid = validateListingBody(req.body)
      if (invalid) throw new GatewayError(400, invalid, 'the listing order is malformed')
      const offerer = req.body.order.offerer
      guardWrite(req)

      const slug = chainSlug(chainId)
      const referral = attachReferral(config, { chainId, kind: 'listing' })
      const upstream = await client.post(`/api/v2/orders/${slug}/seaport/listings`, {
        parameters: req.body.order,
        signature: req.body.signature,
        protocol_address: req.body.protocolAddress || proto.protocolAddress,
      })
      res.json({
        orderHash: upstream?.order?.order_hash ?? upstream?.order_hash ?? null,
        listing: upstream?.order ?? null,
        referral: { source: referral.source, appliedAtNoUserCost: referral.appliedAtNoUserCost },
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- POST /v1/opensea/:chainId/offers/fulfillment -------------------------------------------
  // Return the transaction the seller submits to accept an offer. A best offer that no longer exists
  // (upstream 4xx) surfaces as 409 offer_changed so the client re-confirms (FR-007).
  router.post('/v1/opensea/:chainId/offers/fulfillment', async (req, res) => {
    try {
      const chainId = Number(req.params.chainId)
      const proto = seaportProtocol(chainId)
      if (!proto) throw new GatewayError(404, 'unsupported_chain', 'selling is not available on this network')
      const { orderHash, fulfiller } = req.body ?? {}
      if (!isOrderHash(orderHash)) throw new GatewayError(400, 'invalid_order', 'orderHash must be a 32-byte hex hash')
      if (!isAddress(fulfiller)) throw new GatewayError(400, 'invalid_address', 'fulfiller must be a 0x address')
      guardWrite(req)

      const slug = chainSlug(chainId)
      let upstream
      try {
        upstream = await client.post('/api/v2/offers/fulfillment_data', {
          offer: { hash: orderHash, chain: slug, protocol_address: proto.protocolAddress },
          fulfiller: { address: fulfiller },
        })
      } catch (e) {
        // A gone/changed offer is not an outage — ask the client to re-confirm the current best offer.
        if (e instanceof OpenSeaRequestError) {
          throw new GatewayError(409, 'offer_changed', 'this offer is no longer available; review the current best offer')
        }
        throw e
      }
      const fulfillment = normalizeFulfillment(upstream, orderHash)
      if (!fulfillment) throw new GatewayError(502, 'upstream_rejected', 'the marketplace returned no fulfillment transaction')
      const referral = attachReferral(config, { chainId, kind: 'fulfillment' })
      res.json({ ...fulfillment, referral: { source: referral.source, appliedAtNoUserCost: referral.appliedAtNoUserCost } })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- POST /v1/opensea/:chainId/listings/cancel ----------------------------------------------
  // Prefer OpenSea's gas-free off-chain cancel; if the marketplace can't cancel off-chain, tell the
  // client to submit an on-chain Seaport cancel (gas disclosed there) — FR-008.
  router.post('/v1/opensea/:chainId/listings/cancel', async (req, res) => {
    try {
      const chainId = Number(req.params.chainId)
      const proto = seaportProtocol(chainId)
      if (!proto) throw new GatewayError(404, 'unsupported_chain', 'selling is not available on this network')
      const { orderHash, offerer } = req.body ?? {}
      if (!isOrderHash(orderHash)) throw new GatewayError(400, 'invalid_order', 'orderHash must be a 32-byte hex hash')
      if (!isAddress(offerer)) throw new GatewayError(400, 'invalid_address', 'offerer must be a 0x address')
      guardWrite(req)

      const slug = chainSlug(chainId)
      try {
        await client.post(`/api/v2/orders/chain/${slug}/${proto.protocolAddress}/${orderHash}/cancel`, {
          offerer,
          ...(req.body.signature ? { signature: req.body.signature } : {}),
        })
        res.json({ cancelled: true, method: 'offchain' })
      } catch (e) {
        // Off-chain cancel unavailable for this order -> the client falls back to an on-chain cancel.
        if (e instanceof OpenSeaRequestError) {
          res.json({ cancelled: false, method: 'onchain', protocolAddress: proto.protocolAddress })
          return
        }
        throw e
      }
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}
