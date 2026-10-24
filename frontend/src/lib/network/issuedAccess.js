/**
 * Issued RPC access — the client half of spec 107.
 *
 * The gateway's `POST /v1/access/rpc` mints a short-lived, read-only credential for a dedicated
 * keyed endpoint; this module holds it and renews it. The SPA then reads DIRECTLY from the
 * provider — no read traffic is proxied — and nothing keyed is ever compiled into the build.
 *
 * ── THE THREE RULES THIS FILE EXISTS TO KEEP ─────────────────────────────────────────────────
 *
 * MODULE MEMORY ONLY. The credential is never written through `endpointStore.commit()` — that
 * persists into `fw_global_prefs.network_endpoints`, which rides the device backup, and a test
 * asserts that key's absence from the synced set. An issued credential outliving its TTL in a
 * backup would be a stored secret nobody can revoke. Lose the tab, lose the token, mint again:
 * that is the design, not a limitation.
 *
 * THE RESOLUTION PATH STAYS SYNCHRONOUS. `resolveRpcEndpoints` is consumed during module
 * evaluation, inside render, and by the frozen mini-app host contract — it can never await.
 * So acquisition runs in the BACKGROUND (`ensureIssuedAccess`, fire-and-forget, single-flight)
 * and resolution reads whatever this module already holds, synchronously. Until the first mint
 * lands, reads ride the public default — degraded, working, honest.
 *
 * ROTATION MUST NOT CHURN THE APP. The endpoints revision is global: bumping it re-derives every
 * provider memo on every chain in every mounted hook, and the provider cache keys on headers, so
 * a token baked into either would tear down and rebuild providers on every renewal — including
 * the mini-app host's identity-stable wrappers, whose whole reason for existing is that a
 * changing provider identity in a package's effect deps was an infinite loop. So the revision
 * bumps ONLY on acquisition and loss (the URL appearing or disappearing — rare transitions), and
 * the TOKEN is read per request via `currentTokenFor`, reaching the wire through a preflight
 * hook on a provider whose identity never changes across renewals.
 */
import { bumpEndpointsRevision } from './endpointStore'

/** Renew this far ahead of expiry, so a read never straddles a dead credential. */
const RENEW_AHEAD_MS = 60_000
/** After a failed mint, leave the chain on public capacity this long before retrying. */
const FAILURE_COOLDOWN_MS = 90_000

/** @type {Map<number, {url: string, token: string, expiresAtMs: number, permits: string[]}>} */
const held = new Map()
/** @type {Map<number, Promise<void>>} single-flight per chain */
const inflight = new Map()
/** @type {Map<number, number>} chainId -> earliest next attempt (ms) */
const cooldownUntil = new Map()
/** @type {Map<number, 'declined'|'failed'>} last refusal class: 404 = chain deliberately unserved */
const lastRefusal = new Map()
/** Disclosure listeners (#1471). NOT the endpoints revision: bumping THAT re-derives every
 * provider memo in the app, and a cooldown transition is not a route change. These fire on the
 * rare state edges (acquired, lost, refused) so a disclosure surface can re-read cheaply. */
const stateListeners = new Set()
let stateVersion = 0
function notifyState() {
  stateVersion += 1
  for (const l of stateListeners) { try { l(stateVersion) } catch { /* a bad subscriber must not break acquisition */ } }
}
export function subscribeIssuedAccessState(listener) {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}
export function issuedAccessStateVersion() { return stateVersion }

/** The gateway base, resolved the same way the other relay clients resolve it (spec 036). */
function gatewayBaseUrl() {
  const url = import.meta.env?.VITE_RELAYER_URL
  return typeof url === 'string' && url.trim() ? url.trim().replace(/\/+$/, '') : null
}

/**
 * Synchronous view for the resolution seam: the issued endpoint URL for a chain, or null.
 * Deliberately EXCLUDES the token — the route carries no credential, the preflight does.
 */
export function getIssuedAccessSync(chainId) {
  const entry = held.get(Number(chainId))
  if (!entry) return null
  if (entry.expiresAtMs <= Date.now()) return null // expired-and-unrenewed reads as absent, honestly
  return { url: entry.url, permits: entry.permits }
}

/** The CURRENT token for a chain — read per request by the provider preflight, never cached by callers. */
export function currentTokenFor(chainId) {
  const entry = held.get(Number(chainId))
  if (!entry || entry.expiresAtMs <= Date.now()) return null
  return entry.token
}

/**
 * Acquire or renew issued access for a chain, in the background.
 *
 * Fire-and-forget by design: callers are on the synchronous resolution path and must not wait.
 * Single-flight per chain; a failure sets a cooldown so an unconfigured gateway costs one quiet
 * request per window, not one per read. NEVER throws — every failure mode is "stay on public
 * capacity", which is the never-stranded rule applied to reads.
 */
export function ensureIssuedAccess(chainId, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const id = Number(chainId)
  const base = gatewayBaseUrl()
  if (!base) return // no gateway configured: keyed access is dormant, public capacity is the path

  const entry = held.get(id)
  if (entry && entry.expiresAtMs - RENEW_AHEAD_MS > now()) return // current and not near expiry
  if ((cooldownUntil.get(id) ?? 0) > now()) return
  if (inflight.has(id)) return

  const attempt = (async () => {
    try {
      const res = await fetchImpl(`${base}/v1/access/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chainId: id }),
      })
      if (!res.ok) {
        // 404 = the chain deliberately has no keyed endpoint (ETC/Mordor — public is the permanent
        // path there, not a degradation); everything else = temporarily unavailable. Both mean
        // "public capacity", they differ only in how long to wait before asking again — and, for
        // the disclosure surface, in WHETHER there is anything to disclose (#1471): a declined
        // chain is normal and renders as nothing, a failed one is a degradation and may say so.
        cooldownUntil.set(id, now() + (res.status === 404 ? 6 * FAILURE_COOLDOWN_MS : FAILURE_COOLDOWN_MS))
        lastRefusal.set(id, res.status === 404 ? 'declined' : 'failed')
        dropIfExpired(id, now())
        notifyState()
        return
      }
      const body = await res.json()
      const expiresAtMs = Date.parse(body.expiresAt)
      if (!body.endpoint || !body.credential || !Number.isFinite(expiresAtMs)) {
        cooldownUntil.set(id, now() + FAILURE_COOLDOWN_MS)
        lastRefusal.set(id, 'failed')
        notifyState()
        return
      }
      const hadUrl = held.get(id)?.url
      held.set(id, {
        url: body.endpoint,
        token: body.credential,
        expiresAtMs,
        permits: Array.isArray(body.permits) ? body.permits : [],
      })
      lastRefusal.delete(id)
      // Revision bumps ONLY when the ROUTE changes (acquisition, or the endpoint moving) — a
      // renewal that keeps the URL replaces the token in place and nothing re-derives.
      if (hadUrl !== body.endpoint) bumpEndpointsRevision()
      notifyState()
    } catch {
      cooldownUntil.set(id, now() + FAILURE_COOLDOWN_MS)
      lastRefusal.set(id, 'failed')
      dropIfExpired(id, now())
      notifyState()
    } finally {
      inflight.delete(id)
    }
  })()
  inflight.set(id, attempt)
}

/** An expired, unrenewable credential is a LOSS: the route must fall back, and re-derive once. */
function dropIfExpired(id, nowMs) {
  const entry = held.get(id)
  if (entry && entry.expiresAtMs <= nowMs) {
    held.delete(id)
    bumpEndpointsRevision()
  }
}

/**
 * The disclosure verdict for one chain (#1471). Five states, and only ONE of them is a
 * degradation to surface:
 *
 *   dormant     no gateway configured — keyed access does not exist in this build; say nothing
 *   active      an issued credential is live; say nothing
 *   acquiring   nothing has happened yet (or a mint is in flight); say nothing — FR-017's
 *               discipline applies: silence until there is a settled fact
 *   declined    the gateway answered 404: this chain deliberately has no keyed endpoint. NORMAL,
 *               permanent, and rendered as nothing — public capacity is its correct path
 *   degraded    issuance was tried and FAILED (outage, refusal, bad shape) — the one state a
 *               surface may disclose, as "using public networks right now", never as an error
 */
export function issuedAccessState(chainId) {
  const id = Number(chainId)
  if (!gatewayBaseUrl()) return 'dormant'
  if (getIssuedAccessSync(id)) return 'active'
  const refusal = lastRefusal.get(id)
  if (refusal === 'declined') return 'declined'
  if (refusal === 'failed') return 'degraded'
  return 'acquiring'
}

/**
 * Per-request fetch for the wagmi/viem rail (#1470). viem's `http(url, { fetchFn })` calls this
 * with the transport's own URL; when an issued credential is live the request is RETARGETED to
 * the issued endpoint with the current token attached — per request, so rotation never rebuilds
 * a transport and the failover leg (built without this fetchFn) never sees a credential. When
 * nothing is issued it is exactly `fetch`, and it also keeps acquisition warm from the wallet
 * rail the same way the ethers rail does.
 */
export function issuedFetchFor(chainId, { fetchImpl = fetch } = {}) {
  const id = Number(chainId)
  return (url, init) => {
    // Acquisition deliberately does NOT ride the injected fetch: `fetchImpl` is the TRANSPORT's
    // fetch (viem may hand something request-shaped and rpc-specific), and the mint is a plain
    // gateway POST with its own default. Conflating them also made tests unreadable — the mint
    // call masqueraded as the first RPC call — which is usually the smell that callers will be
    // confused too.
    ensureIssuedAccess(id)
    const issued = getIssuedAccessSync(id)
    const token = issued ? currentTokenFor(id) : null
    if (!issued?.url || !token) return fetchImpl(url, init)
    const headers = new Headers(init?.headers || {})
    headers.set('authorization', `Bearer ${token}`)
    return fetchImpl(issued.url, { ...init, headers })
  }
}

/** Test seam: reset module state. Not exported through any barrel; production code never calls it. */
export function __resetIssuedAccessForTests() {
  held.clear()
  inflight.clear()
  cooldownUntil.clear()
  lastRefusal.clear()
  stateListeners.clear()
  stateVersion = 0
}
