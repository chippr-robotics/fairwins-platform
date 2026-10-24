/**
 * Polymarket Predict proxy routes — /v1/polymarket/* (spec 057).
 *
 * Contract: specs/057-predict-polymarket/contracts/gateway-predict-api.md.
 * Pipeline per request: killswitch -> fail-closed key check -> Polygon-only check -> param validation
 * -> quota -> (reads) cached fetch / (writes) attach builder code + forward the client-signed order.
 * The gateway holds the Polymarket key + L2 creds (FR-016); clients only ever see normalized DTOs.
 * Nothing here touches intents, funds, or signing keys — a total outage leaves every value path intact
 * (FR-020). The member's own wallet is the only order signer; the gateway just forwards signed orders.
 */
import express from 'express'
import { GatewayError } from '../errors.js'
import { callerQuotaKey } from '../identity/quotaKey.js'
import { PolymarketRequestError } from './client.js'
import { BuilderConfig } from '@polymarket/builder-signing-sdk'
import { attachBuilderCode } from './builderCode.js'
import {
  isSupportedChain,
  isAddress,
  isTokenId,
  isCursor,
  normalizeMarket,
  normalizeGammaMarket,
  normalizeGammaPage,
  normalizeFeeRate,
  normalizePositionsList,
} from './normalize.js'

/**
 * @param {object} config full gateway config (only .polymarket is read)
 * @param {{
 *   client: {get: Function, post: Function},
 *   cache: {fetchThrough: Function},
 *   quotas: {hit: Function},
 *   writeQuotas: {hit: Function},
 *   killSwitch: {isActive: () => boolean},
 * }} deps
 */
export function createPolymarketRouter(config, { client, gammaClient, dataClient, cache, quotas, writeQuotas, killSwitch, feeRates }) {
  const pm = config.polymarket
  const gamma = gammaClient ?? client // browse/search host (public)
  const data = dataClient ?? client // positions host (public)
  const router = express.Router()

  const GAMMA_PAGE = 100 // markets fetched per Gamma page (volume-ranked; q filters this set)

  // Builder attribution (spec 057): the shared BUILDER creds (POLYMARKET_API_* — verified valid *builder*
  // creds, NOT user L2 creds) sign the POLY_BUILDER_* headers server-side so they never reach the browser.
  // Order submit/cancel/open-orders run browser->CLOB directly with each member's OWN derived L2 creds; the
  // gateway only signs the attribution headers here. Absent creds => the /builder-sign route 503s and the SPA
  // posts orders UNATTRIBUTED rather than being blocked (never-stranded, FR-015).
  const builderConfig =
    pm.apiKey && pm.apiSecret && pm.apiPassphrase
      ? new BuilderConfig({ localBuilderCreds: { key: pm.apiKey, secret: pm.apiSecret, passphrase: pm.apiPassphrase } })
      : null

  /** Killswitch + fail-closed key (shared by reads and writes). */
  function requireLive() {
    if (killSwitch.isActive()) {
      throw new GatewayError(503, 'killswitch_active', 'the gateway is temporarily disabled; try again later')
    }
    if (!pm.apiKey) {
      throw new GatewayError(503, 'predict_unconfigured', 'prediction-market trading is not configured on this gateway')
    }
  }

  // Keyed on the CALLER, not on request content (spec 106, FR-011). It formerly keyed on the
  // search terms, the condition id or an address out of the path — all caller-chosen, so varying
  // any of them minted a fresh bucket and the ceiling was never approached.
  function guard(req) {
    requireLive()
    const q = quotas.hit(callerQuotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} predict read quota exceeded`, { retryAfterSec: q.retryAfterSec })
    }
  }

  /**
   * Write pre-flight: live check + the tighter write quota, keyed on the CALLER (spec 106, FR-011).
   *
   * This formerly used the CONSTANT key `'builder-sign'`, which is the same defect in a different
   * shape: one bucket shared by everyone means no caller is individually limited, and one script
   * can exhaust the window for every legitimate trader at once. Since this route signs orders with
   * the platform's builder credentials, both halves of that matter.
   */
  function guardWrite(req) {
    requireLive()
    const q = (writeQuotas ?? quotas).hit(callerQuotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} predict write quota exceeded`, { retryAfterSec: q.retryAfterSec })
    }
  }

  /** Polygon-only guard, or 404 unsupported_chain (soft-fail contract, FR-018). */
  function requirePolygon(chainIdParam) {
    if (!isSupportedChain(chainIdParam)) {
      throw new GatewayError(404, 'unsupported_chain', 'prediction markets are only available on Polygon')
    }
  }

  const respond = (res, { value, fetchedAt, stale }) =>
    res.json({ ...value, fetchedAt: new Date(fetchedAt).toISOString(), stale })

  function handleError(res, err) {
    if (err instanceof GatewayError) {
      if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
      return res.status(err.status).json(err.toBody())
    }
    if (err instanceof PolymarketRequestError) {
      if (err.status === 404) {
        return res.status(404).json({ error: { code: 'not_found', reason: 'the marketplace does not know this market' } })
      }
      // Surface Polymarket's own rejection reason (e.g. below-minimum, bad token) so the member can act.
      const reason = typeof err.message === 'string' ? err.message.replace(/^polymarket rejected request \(\d+\): /, '').slice(0, 200) : ''
      return res.status(502).json({ error: { code: 'upstream_rejected', reason: reason || 'the marketplace rejected this request' } })
    }
    // PolymarketUnavailableError and anything unexpected: degraded, cache had nothing to serve.
    return res
      .status(503)
      .json({ error: { code: 'upstream_unavailable', reason: 'prediction-market data is temporarily unavailable; try again later' } })
  }

  // ---- GET /v1/polymarket/:chainId/markets (browse/search via Gamma) --------------------------
  // Live, tradable markets ranked by volume (the CLOB /markets endpoint returns mostly closed
  // historical markets). `q` filters the volume-ranked page by question text; `next` is an offset.
  router.get('/v1/polymarket/:chainId/markets', async (req, res) => {
    try {
      requirePolygon(req.params.chainId)
      const next = req.query.next ?? null
      const search = typeof req.query.q === 'string' ? req.query.q.slice(0, 128) : ''
      if (!isCursor(next)) throw new GatewayError(400, 'invalid_cursor', 'malformed pagination cursor')
      const offset = Number.parseInt(next ?? '0', 10) || 0
      guard(req)

      const result = await cache.fetchThrough(`markets:${search}:${offset}`, pm.cacheTtlMs, async () => {
        const body = await gamma.get('/markets', {
          query: {
            active: 'true',
            closed: 'false',
            archived: 'false',
            limit: String(GAMMA_PAGE),
            offset: String(offset),
            order: 'volumeNum',
            ascending: 'false',
          },
        })
        return normalizeGammaPage(body, { q: search, offset, limit: GAMMA_PAGE })
      })
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/polymarket/:chainId/markets/:conditionId ---------------------------------------
  router.get('/v1/polymarket/:chainId/markets/:conditionId', async (req, res) => {
    try {
      requirePolygon(req.params.chainId)
      const { conditionId } = req.params
      if (typeof conditionId !== 'string' || conditionId.length < 3 || conditionId.length > 128) {
        throw new GatewayError(400, 'invalid_market', 'condition id is malformed')
      }
      guard(req)

      const result = await cache.fetchThrough(`market:${conditionId}`, pm.cacheTtlMs, async () => {
        const body = await gamma.get('/markets', { query: { condition_ids: conditionId } })
        const raw = Array.isArray(body) ? body[0] : (body?.data?.[0] ?? body?.market ?? body)
        const market = normalizeGammaMarket(raw) ?? normalizeMarket(raw)
        if (!market) throw new PolymarketRequestError(404, 'market not present upstream')
        return market
      })
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/polymarket/:chainId/fee-rate?token_id= -----------------------------------------
  // The live platform-fee basis the client shows (and the additive builder fee is layered on from
  // config). A null schedule -> 503 so the client blocks signing rather than guessing (FR-010).
  router.get('/v1/polymarket/:chainId/fee-rate', async (req, res) => {
    try {
      requirePolygon(req.params.chainId)
      const tokenId = typeof req.query.token_id === 'string' ? req.query.token_id : ''
      if (!isTokenId(tokenId)) throw new GatewayError(400, 'invalid_token', 'token_id must be a numeric token id')
      guard(req)

      const result = await cache.fetchThrough(`fee:${tokenId}`, pm.cacheTtlMs, async () => {
        // The builder code + fee are OUR config and are ALWAYS known — trading must never be blocked
        // by a CLOB fee-rate quirk (FR-015). Polymarket's own taker fee (base_fee → the order's
        // feeRateBps) is best-effort: fetched for the signed order, null if the CLOB has none.
        // Since spec 060 the bps come LIVE from the FeeRouter contract (admin-editable on-chain);
        // the env values remain the honest fallback when the router is unset/unreachable.
        const live = feeRates ? await feeRates.getPolymarketBps() : null
        const effectiveConfig = live
          ? { ...config, polymarket: { ...pm, takerFeeBps: live.takerBps, makerFeeBps: live.makerBps } }
          : config
        const builder = attachBuilderCode(effectiveConfig, { chainId: 137 })
        let platform = null
        try {
          platform = normalizeFeeRate(await client.get('/fee-rate', { query: { token_id: tokenId } }), tokenId)
        } catch {
          platform = null
        }
        return {
          tokenId,
          // Platform fee rate the order must carry (bps); null when the CLOB reports none.
          feeRateBps: platform?.feeRateBps ?? null,
          builderCode: builder.builderCode,
          builderTakerFeeBps: builder.takerFeeBps,
          builderMakerFeeBps: builder.makerFeeBps,
          // Where the bps came from: the on-chain FeeRouter, or the env fallback.
          source: live ? 'chain' : 'env-fallback',
        }
      })
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/polymarket/:chainId/positions?address= -----------------------------------------
  router.get('/v1/polymarket/:chainId/positions', async (req, res) => {
    try {
      requirePolygon(req.params.chainId)
      const address = typeof req.query.address === 'string' ? req.query.address : ''
      if (!isAddress(address)) throw new GatewayError(400, 'invalid_address', 'address must be a 0x-prefixed 20-byte hex address')
      guard(req)

      const result = await cache.fetchThrough(`positions:${address.toLowerCase()}`, pm.cacheTtlMs, async () => {
        // Positions live on the public Data API (not the CLOB), keyed by the wallet — no L2 auth.
        const body = await data.get('/positions', { query: { user: address, sizeThreshold: '0.1', limit: '100' } })
        return normalizePositionsList(body)
      })
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- POST /v1/polymarket/:chainId/builder-sign (remote builder-header signing) --------------
  // Attribution ONLY. Order submit/cancel/open-orders are NOT proxied here — CLOB V2 binds every order to
  // its signer, so each member submits browser->CLOB directly with their OWN derived L2 creds (the gateway
  // never sees those). This route just returns the four POLY_BUILDER_* headers the SDK stacks on top for
  // FairWins attribution, computed from the shared builder creds held only here. Origin-locked (global
  // middleware) + killswitch + write-quota gated. Contract (SDK remote signer): POST {method,path,body,
  // timestamp?} -> { POLY_BUILDER_API_KEY, POLY_BUILDER_PASSPHRASE, POLY_BUILDER_SIGNATURE, POLY_BUILDER_TIMESTAMP }.
  router.post('/v1/polymarket/:chainId/builder-sign', async (req, res) => {
    try {
      requirePolygon(req.params.chainId)
      // Absent builder creds => let the SPA post the order unattributed rather than blocking it (FR-015).
      if (!builderConfig) throw new GatewayError(503, 'builder_unconfigured', 'builder attribution is not configured on this gateway')
      guardWrite(req) // killswitch + fail-closed key + tighter per-caller write quota
      const { method, path, body, timestamp } = req.body || {}
      if (typeof method !== 'string' || typeof path !== 'string') {
        throw new GatewayError(400, 'invalid_builder_sign', 'method and path are required')
      }
      const headers = await builderConfig.generateBuilderHeaders(
        method,
        path,
        typeof body === 'string' ? body : undefined,
        typeof timestamp === 'number' ? timestamp : undefined,
      )
      if (!headers) throw new GatewayError(503, 'builder_unconfigured', 'builder attribution is not available')
      res.json(headers)
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}
