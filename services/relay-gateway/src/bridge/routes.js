/**
 * Bridge proxy routes — /v1/bridge/* (spec 067, US1).
 *
 * Structured exactly like src/polymarket/routes.js: killswitch -> fail-closed enable check ->
 * supported-chain check -> param validation -> quota -> TTL-cached upstream fetch, with the same
 * nested `{ error: { code, reason } }` body as the intent/opensea/polymarket contracts.
 *
 * OPTIONAL INFRASTRUCTURE. The module is off unless BRIDGE_ENABLED=true, and off means every route
 * answers 503 `bridge_disabled` so the SPA hides the Bridge tab for a stated reason (FR-053). The
 * router is mounted unconditionally on purpose — an unmounted path would 404 with no machine-readable
 * code, and the client could not tell "operator turned it off" from "gateway too old", which is the
 * silent-failure this feature is least allowed to have. Same reasoning (and the same comment) as the
 * spec-061 Bitcoin proxy.
 *
 * Nothing here touches intents, funds, or signing keys. A total outage of this group leaves every
 * value path intact: quoting stops (there is no client-side substitute for Across's relayer-fee
 * oracle — research R10), while an already-submitted bridge keeps resolving from on-chain events.
 */
import express from 'express'
import { GatewayError } from '../errors.js'
import { callerQuotaKey } from '../identity/quotaKey.js'
import { AcrossRequestError, parseChainId, isAddress, isAmount, fetchSuggestedFees } from './quotes.js'
import { isDepositId, fetchDepositStatus } from './status.js'

/**
 * @param {object} config full gateway config (only .bridge is read)
 * @param {{
 *   client: {get: Function},
 *   cache: {fetchThrough: Function},
 *   quotas: {hit: Function},
 *   killSwitch: {isActive: () => boolean},
 * }} deps
 */
export function createBridgeRouter(config, { client, cache, quotas, killSwitch }) {
  const bridge = config.bridge
  const router = express.Router()
  const supported = new Set(bridge.chainIds)

  /** Module killswitch + global runtime switch, then the master enable. */
  function requireLive() {
    if (bridge.killSwitch || killSwitch.isActive()) {
      throw new GatewayError(503, 'bridge_killed', 'bridging is temporarily disabled; try again later')
    }
    if (!bridge.enabled) {
      throw new GatewayError(503, 'bridge_disabled', 'cross-chain bridging is not enabled on this gateway')
    }
  }

  /**
   * Parse a chain id and assert the settlement protocol is configured there. Bitcoin's string
   * network ids fail `parseChainId` outright (FR-006); ETC/Mordor fail the supported-set check with
   * the same honest 404 rather than being silently missing (FR-006c).
   */
  function requireSupportedChain(raw, label) {
    const chainId = parseChainId(raw)
    if (chainId == null || !supported.has(chainId)) {
      throw new GatewayError(404, 'unsupported_chain', `${label} network is not supported for bridging on this gateway`)
    }
    return chainId
  }

  // No signature to recover on a GET, so quotas are keyed per caller IP like the Bitcoin proxy;
  // the global window is the real backstop for the shared upstream.
  // Keyed on the resolved caller (spec 106, FR-011) rather than on `req.ip` alone — see
  // identity/quotaKey.js for why the network address is a fallback and not the default.
  const quotaKey = callerQuotaKey

  function guard(req) {
    const q = quotas.hit(quotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} bridge read quota exceeded`, { retryAfterSec: q.retryAfterSec })
    }
  }

  const respond = (res, { value, fetchedAt, stale }) =>
    res.json({ ...value, fetchedAt: new Date(fetchedAt).toISOString(), stale })

  function handleError(res, err) {
    if (err instanceof GatewayError) {
      if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
      return res.status(err.status).json(err.toBody())
    }
    if (err instanceof AcrossRequestError) {
      // Surface Across's own rejection reason (unsupported token pair, amount below the relayer
      // minimum) so the member can act on it instead of retrying blindly.
      const reason = typeof err.message === 'string' ? err.message.replace(/^across rejected request \(\d+\): /, '').slice(0, 200) : ''
      return res.status(502).json({ error: { code: 'upstream_rejected', reason: reason || 'the bridge protocol rejected this request' } })
    }
    // AcrossUnavailableError and anything unexpected: degraded with nothing honest to serve.
    return res
      .status(503)
      .json({ error: { code: 'upstream_unavailable', reason: 'bridge quotes are temporarily unavailable; try again later' } })
  }

  // ---- GET /v1/bridge/:chainId/quote ----------------------------------------------------------
  // :chainId is the ORIGIN chain. Query: destinationChainId, inputToken, outputToken, amount,
  // recipient (optional). Returns the raw Across legs; the client itemizes them and adds the
  // FairWins platform-fee line from its own live FeeRouter read (spec 060) — the gateway never
  // becomes a second source of truth for a rate.
  router.get('/v1/bridge/:chainId/quote', async (req, res) => {
    try {
      requireLive()
      const originChainId = requireSupportedChain(req.params.chainId, 'origin')
      const destinationChainId = requireSupportedChain(req.query.destinationChainId, 'destination')
      // The R11b inversion guard, enforced at the gateway boundary too: a bridge whose destination
      // equals its origin is a same-chain transfer wearing a bridge's clothes. Reject it rather than
      // quote it, so a client-side predicate mix-up fails loudly instead of quietly costing a fee.
      if (destinationChainId === originChainId) {
        throw new GatewayError(400, 'invalid_route', 'a bridge destination must be a different network than its origin')
      }
      const { inputToken, outputToken, amount, recipient } = req.query
      if (!isAddress(inputToken) || !isAddress(outputToken)) {
        throw new GatewayError(400, 'invalid_token', 'inputToken and outputToken must be 0x-prefixed 20-byte hex addresses')
      }
      if (!isAmount(amount)) {
        throw new GatewayError(400, 'invalid_amount', 'amount must be a positive integer in the token base units')
      }
      if (recipient != null && recipient !== '' && !isAddress(recipient)) {
        throw new GatewayError(400, 'invalid_address', 'recipient must be a 0x-prefixed 20-byte hex address')
      }
      guard(req)

      const key = `quote:${originChainId}:${destinationChainId}:${inputToken.toLowerCase()}:${outputToken.toLowerCase()}:${amount}:${(recipient || '').toLowerCase()}`
      const result = await cache.fetchThrough(key, bridge.quoteTtlMs, async () => {
        const quote = await fetchSuggestedFees(client, {
          originChainId,
          destinationChainId,
          inputToken,
          outputToken,
          amount,
          recipient: recipient || null,
        })
        if (quote == null) throw new GatewayError(502, 'upstream_malformed', 'the bridge protocol returned an unreadable quote')
        return quote
      })
      // A PRICE MAY NEVER BE SERVED STALE. The shared TTL cache degrades to the last good value on
      // upstream failure, which is right for market data and wrong for a quote the member is about
      // to sign against (FR-008 makes the confirmed figure a hard ceiling). Single-flight and the
      // short TTL window are what we want from the cache here; the serve-stale branch is not.
      if (result.stale) {
        throw new GatewayError(503, 'upstream_unavailable', 'bridge quotes are temporarily unavailable; try again later')
      }
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/bridge/:chainId/status?depositId= -----------------------------------------------
  // :chainId is the ORIGIN chain the deposit was made on. Serving a stale status IS acceptable (it is
  // marked `stale: true` and the client keeps polling); a stale status can only lag reality, and the
  // state machine never promotes to delivered without a destination fill hash.
  router.get('/v1/bridge/:chainId/status', async (req, res) => {
    try {
      requireLive()
      const originChainId = requireSupportedChain(req.params.chainId, 'origin')
      const depositId = typeof req.query.depositId === 'string' ? req.query.depositId : ''
      if (!isDepositId(depositId)) {
        throw new GatewayError(400, 'invalid_deposit', 'depositId must be a positive integer')
      }
      guard(req)

      const result = await cache.fetchThrough(`status:${originChainId}:${depositId}`, bridge.statusTtlMs, async () => {
        const status = await fetchDepositStatus(client, { originChainId, depositId })
        if (status == null) throw new GatewayError(502, 'upstream_malformed', 'the bridge protocol returned an unreadable status')
        return status
      })
      respond(res, result)
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}
