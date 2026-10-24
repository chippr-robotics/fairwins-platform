/**
 * Bitcoin proxy routes — /v1/bitcoin/* (spec 061).
 *
 * Contract: specs/061-bitcoin-transactions/contracts/bitcoin-gateway-api.md — implemented
 * faithfully, including its FLAT error body `{ error: <slug>, message }` (unlike the nested
 * `{error:{code,reason}}` of the intent/opensea/polymarket contracts).
 *
 * Pipeline per request: killswitch (503 bitcoin_killed) -> enabled check (503 bitcoin_disabled)
 * -> param validation -> quota (429) -> TTL cache -> upstream (failure => 502
 * upstream_unavailable). Quotas are keyed per caller IP (nothing to sign on these routes);
 * broadcast uses the separate, tighter write quota. Nothing here touches intents, funds, or
 * signing keys — the member's client holds the only Bitcoin keys, and a total outage of this
 * group leaves every value path intact.
 */
import crypto from 'node:crypto'
import express from 'express'
import { GatewayError } from '../errors.js'
import { callerQuotaKey } from '../identity/quotaKey.js'
import { BitcoinRequestError } from './client.js'
import {
  MAX_ADDRESSES_PER_REQUEST,
  isValidBitcoinAddress,
  isTxid,
  isRawTxHex,
  normalizeAddressResult,
  normalizeFeeRates,
  normalizeTxStatus,
  normalizeStampsBalance,
} from './normalize.js'
import { FEES_TTL_MS, ADDRESSES_TTL_MS, TX_STATUS_TTL_MS, fetchStampsThrough } from './cache.js'

/** Stable cache key for an address SET: order-insensitive (contract: sorted address set hash). */
const addressSetHash = (addresses) =>
  crypto.createHash('sha256').update([...addresses].sort().join(',')).digest('hex').slice(0, 32)

/**
 * @param {object} config full gateway config (only .bitcoin is read)
 * @param {{
 *   esploraClients: {mainnet: object, testnet: object},
 *   stampsClient: object|null,
 *   cache: {fetchThrough: Function},
 *   quotas: {hit: Function},
 *   writeQuotas: {hit: Function},
 *   killSwitch: {isActive: () => boolean},
 *   now?: () => number,               // unix milliseconds (cache-age checks)
 * }} deps
 */
export function createBitcoinRouter(config, { esploraClients, stampsClient, cache, quotas, writeQuotas, killSwitch, now = () => Date.now() }) {
  const btc = config.bitcoin
  const router = express.Router()

  /** Killswitch (module env + global runtime switch) then the master enable — contract order. */
  function requireLive() {
    if (btc.killSwitch || killSwitch.isActive()) {
      throw new GatewayError(503, 'bitcoin_killed', 'bitcoin services are temporarily disabled; try again later')
    }
    if (!btc.enabled) {
      throw new GatewayError(503, 'bitcoin_disabled', 'bitcoin services are not enabled on this gateway')
    }
  }

  /** :network ∈ {mainnet, testnet} -> the network's Esplora client, else 404 (soft-fail). */
  function requireNetwork(networkParam) {
    const client = esploraClients[networkParam]
    if (networkParam !== 'mainnet' && networkParam !== 'testnet') {
      throw new GatewayError(404, 'unknown_network', 'network must be mainnet or testnet')
    }
    if (!client) throw new GatewayError(404, 'unknown_network', 'network is not configured on this gateway')
    return client
  }

  // Keyed on the resolved caller (spec 106, FR-011) rather than on `req.ip` alone — see
  // identity/quotaKey.js for why the network address is a fallback and not the default.
  const quotaKey = callerQuotaKey

  /** Read pre-flight: per-IP + global read quota. */
  function guard(req) {
    const q = quotas.hit(quotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} bitcoin read quota exceeded`, { retryAfterSec: q.retryAfterSec })
    }
  }

  /** Broadcast pre-flight: the tighter per-IP write quota (contract: stricter than reads). */
  function guardWrite(req) {
    const q = (writeQuotas ?? quotas).hit(quotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} bitcoin broadcast quota exceeded`, { retryAfterSec: q.retryAfterSec })
    }
  }

  /** Parse + validate a batch address list per network, or 400 invalid_address. */
  function requireAddresses(list, network) {
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ADDRESSES_PER_REQUEST) {
      throw new GatewayError(400, 'invalid_address', `addresses must be a list of 1-${MAX_ADDRESSES_PER_REQUEST} bitcoin addresses`)
    }
    for (const address of list) {
      if (!isValidBitcoinAddress(address, network)) {
        throw new GatewayError(400, 'invalid_address', `"${String(address).slice(0, 90)}" is not a valid ${network} bitcoin address`)
      }
    }
    return list
  }

  function handleError(res, err) {
    if (err instanceof GatewayError) {
      if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
      // Flat body per the bitcoin contract (not GatewayError.toBody()'s nested shape).
      return res.status(err.status).json({ error: err.code, message: err.reason })
    }
    if (err instanceof BitcoinRequestError && err.status === 404) {
      // Only the tx-status route can surface an upstream 404 here (address/utxo reads answer
      // empty sets, never 404): unknown-to-upstream => the client keeps polling (contract).
      return res.status(404).json({ error: 'tx_not_found', message: 'the network does not know this transaction yet' })
    }
    // BitcoinUnavailableError, unexpected upstream 4xx, shape surprises: degraded, cache had
    // nothing to serve. The client renders stale/degraded, never zero (contract).
    return res.status(502).json({ error: 'upstream_unavailable', message: 'bitcoin network data is temporarily unavailable; try again later' })
  }

  // ---- POST /v1/bitcoin/:network/addresses (batch balances + UTXOs) ---------------------------
  router.post('/v1/bitcoin/:network/addresses', async (req, res) => {
    try {
      requireLive()
      const client = requireNetwork(req.params.network)
      const addresses = requireAddresses(req.body?.addresses, req.params.network)
      guard(req)

      const key = `addrs:${req.params.network}:${addressSetHash(addresses)}`
      const result = await cache.fetchThrough(key, ADDRESSES_TTL_MS, async () => {
        const tipHeight = await client.getTipHeight()
        const results = await Promise.all(
          addresses.map(async (address) => {
            const [info, utxos] = await Promise.all([client.getAddress(address), client.getAddressUtxos(address)])
            return normalizeAddressResult(address, info, utxos, tipHeight)
          })
        )
        return { tipHeight, results }
      })
      res.json(result.value)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/bitcoin/:network/fees ----------------------------------------------------------
  router.get('/v1/bitcoin/:network/fees', async (req, res) => {
    try {
      requireLive()
      const client = requireNetwork(req.params.network)
      guard(req)

      const result = await cache.fetchThrough(`fees:${req.params.network}`, FEES_TTL_MS, async () => {
        const [feesBody, tipHeight] = await Promise.all([client.getFees(), client.getTipHeight()])
        const rates = normalizeFeeRates(feesBody, btc.maxFeeRate)
        // Unusable fee data must never become an invented rate — degrade honestly instead.
        if (!rates) throw new GatewayError(502, 'upstream_unavailable', 'fee estimates are temporarily unavailable; try again later')
        return { rates, tipHeight }
      })
      res.json(result.value)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- POST /v1/bitcoin/:network/tx (broadcast; never cached) ---------------------------------
  router.post('/v1/bitcoin/:network/tx', async (req, res) => {
    try {
      requireLive()
      const client = requireNetwork(req.params.network)
      const rawTx = req.body?.rawTx
      if (!isRawTxHex(rawTx)) {
        throw new GatewayError(400, 'invalid_rawtx', 'rawTx must be an even-length hex string of at most 100 kB')
      }
      guardWrite(req)

      let txid
      try {
        txid = await client.broadcastTx(rawTx)
      } catch (e) {
        if (e instanceof BitcoinRequestError) {
          // Surface the node's own rejection reason (verbatim-safe: it describes the member's
          // OWN transaction — e.g. min-relay-fee, missing inputs) so they can act on it.
          const message = typeof e.message === 'string' ? e.message.replace(/^esplora rejected request \(\d+\): /, '').slice(0, 200) : ''
          throw new GatewayError(400, 'broadcast_rejected', message || 'the network rejected this transaction')
        }
        throw e
      }
      res.json({ txid })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/bitcoin/:network/tx/:txid (confirmation status) --------------------------------
  router.get('/v1/bitcoin/:network/tx/:txid', async (req, res) => {
    try {
      requireLive()
      const client = requireNetwork(req.params.network)
      const { txid } = req.params
      if (!isTxid(txid)) throw new GatewayError(400, 'invalid_txid', 'txid must be a 64-character hex string')
      guard(req)

      // An upstream 404 (tx unknown) throws BitcoinRequestError from the loader; with nothing
      // cached, fetchThrough propagates it and handleError maps it to 404 tx_not_found.
      const result = await cache.fetchThrough(`tx:${req.params.network}:${txid.toLowerCase()}`, TX_STATUS_TTL_MS, async () => {
        const [status, tipHeight] = await Promise.all([client.getTxStatus(txid), client.getTipHeight()])
        return normalizeTxStatus(txid, status, tipHeight)
      })
      res.json(result.value)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/bitcoin/:network/stamps?addresses=a,b,c ----------------------------------------
  // Fail-SAFE, not fail-open (research R6/FR-019): any indexer trouble — unconfigured, down,
  // timeout, unrecognizable shape, partially unparseable entries — answers degraded:true so the
  // client protects unverified coins. The loader therefore never throws; 502 cannot happen here.
  router.get('/v1/bitcoin/:network/stamps', async (req, res) => {
    try {
      requireLive()
      requireNetwork(req.params.network)
      const raw = typeof req.query.addresses === 'string' ? req.query.addresses : ''
      const addresses = raw.split(',').map((s) => s.trim()).filter(Boolean)
      requireAddresses(addresses, req.params.network)
      guard(req)

      if (!stampsClient) {
        // No indexer configured (BTC_STAMPS_URL unset) — a static condition; no cache needed.
        res.json({ degraded: true, stamps: [] })
        return
      }

      const key = `stamps:${req.params.network}:${addressSetHash(addresses)}`
      const result = await fetchStampsThrough(cache, key, now, async () => {
        let degraded = false
        const stamps = []
        await Promise.all(
          addresses.map(async (address) => {
            try {
              const body = await stampsClient.getStampsBalance(address)
              const normalized = normalizeStampsBalance(body, address)
              if (!normalized) {
                degraded = true // unrecognizable body — treat the whole result as unverified
                return
              }
              if (normalized.dropped > 0) degraded = true // partial parse still degrades (fail-safe)
              stamps.push(...normalized.stamps)
            } catch {
              degraded = true // indexer down/timeout for this address
            }
          })
        )
        return { degraded, stamps }
      })
      res.json(result.value)
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}
