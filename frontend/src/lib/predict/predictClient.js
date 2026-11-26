/**
 * Predict gateway client (spec 057) — the SPA side of the relay-gateway's /v1/polymarket/* proxy for the
 * PUBLIC read surface only: market browse/search, market detail, the fee schedule, and positions (all
 * public Polymarket data — no per-user auth). Soft-fail by design: with VITE_RELAYER_URL unset the feature
 * reports unavailable and every Predict surface hides (FR-018) — mirroring the collectibles gateway client.
 *
 * AUTHED trading (submit / cancel / open-orders) does NOT go through here — CLOB V2 binds every order to
 * its signer, so each member calls clob.polymarket.com DIRECTLY with their OWN derived L2 creds. See
 * lib/predict/clobSession.js. The gateway only signs the builder attribution headers (/builder-sign).
 */
import { getNetwork } from '../../config/networks'

const FETCH_TIMEOUT_MS = 12_000

/** Transport failure, timeout, 5xx, killswitch, or quota exhaustion — callers show the degraded state. */
export class PredictUnavailable extends Error {
  constructor(message, { code, cause } = {}) {
    super(message)
    this.name = 'PredictUnavailable'
    this.code = code || 'unavailable'
    if (cause !== undefined) this.cause = cause
  }
}

/** The configured gateway base URL, or '' when unset. Read at call time so tests can stub the env. */
export function predictGatewayUrl() {
  return (import.meta.env.VITE_RELAYER_URL || '').trim().replace(/\/$/, '')
}

/**
 * Whether Predict exists at all for this chain: Polymarket must serve the network (capability flag,
 * Polygon only) AND a gateway must be configured. False hides the tab entirely (FR-018).
 */
export function predictAvailable(chainId) {
  return Boolean(getNetwork(chainId)?.capabilities?.predict) && predictGatewayUrl() !== ''
}

async function request(path, { method = 'GET', body } = {}) {
  const base = predictGatewayUrl()
  if (!base) throw new PredictUnavailable('predict gateway is not configured', { code: 'unconfigured' })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  let res
  try {
    res = await fetch(`${base}${path}`, {
      method,
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    })
  } catch (e) {
    throw new PredictUnavailable(`predict gateway unreachable: ${e?.message || e}`, {
      code: e?.name === 'AbortError' ? 'timeout' : 'network_error',
      cause: e,
    })
  } finally {
    clearTimeout(timer)
  }

  if (res.ok) return res.json()

  let errBody = null
  try {
    errBody = await res.json()
  } catch {
    /* non-JSON error */
  }
  const code = errBody?.error?.code || `http_${res.status}`
  const err = new PredictUnavailable(errBody?.error?.reason || `predict request failed (${res.status})`, { code })
  err.status = res.status
  throw err
}

/** Browse/search markets → { markets, next, fetchedAt, stale }. */
export function fetchMarkets(chainId, { q = '', category = '', next = '' } = {}) {
  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  if (category) qs.set('category', category)
  if (next) qs.set('next', next)
  const suffix = qs.toString() ? `?${qs}` : ''
  return request(`/v1/polymarket/${chainId}/markets${suffix}`)
}

/** Market detail → normalized Market DTO. */
export function fetchMarket(chainId, conditionId) {
  return request(`/v1/polymarket/${chainId}/markets/${encodeURIComponent(conditionId)}`)
}

/**
 * Live fee schedule for a token → { feeRateBps, builderTakerFeeBps, builderMakerFeeBps }. Throws when
 * unavailable → the caller blocks signing rather than guessing a fee (FR-010).
 */
export function fetchFeeRate(chainId, tokenId) {
  return request(`/v1/polymarket/${chainId}/fee-rate?token_id=${encodeURIComponent(tokenId)}`)
}

/** The connected address's positions → { positions } (public Data API; no auth). */
export function fetchPositions(chainId, address) {
  return request(`/v1/polymarket/${chainId}/positions?address=${encodeURIComponent(address)}`)
}

/* ── Spec 114 — live markets reads. Every success body ends with { confirmedAt, serverNow, stale }. ── */

/** Events list → { events, next, confirmedAt, serverNow, stale }. `q` ignores category/sort (gateway rule). */
export function fetchEvents(chainId, { category = '', sort = '', q = '', next = '' } = {}) {
  const qs = new URLSearchParams()
  if (q) qs.set('q', q)
  if (category) qs.set('category', category)
  if (sort) qs.set('sort', sort)
  if (next) qs.set('next', next)
  const suffix = qs.toString() ? `?${qs}` : ''
  return request(`/v1/polymarket/${chainId}/events${suffix}`)
}

/** One event with all its markets → EventDetail + envelope. */
export function fetchEvent(chainId, slug) {
  return request(`/v1/polymarket/${chainId}/events/${encodeURIComponent(slug)}`)
}

/** Order books for one to ten token ids → { books, unreadable, confirmedAt, serverNow, stale }. */
export function fetchBooks(chainId, tokenIds) {
  const ids = (Array.isArray(tokenIds) ? tokenIds : [tokenIds]).map((t) => encodeURIComponent(String(t)))
  return request(`/v1/polymarket/${chainId}/books?token_ids=${ids.join(',')}`)
}

/** Price history for one token → { tokenId, range, points: [{ t, p }], confirmedAt, serverNow, stale }. */
export function fetchHistory(chainId, tokenId, range = '1d') {
  const qs = new URLSearchParams({ token_id: String(tokenId), range })
  return request(`/v1/polymarket/${chainId}/prices-history?${qs}`)
}
