/**
 * Member-configured RPC endpoints (spec 069).
 *
 * FairWins is a multi-network control plane: every asset carries its own chainId and
 * reads fan out across all supported networks at once, independent of whichever chain
 * the wallet happens to sit on. That makes the RPC route a piece of infrastructure the
 * MEMBER owns, not a build-time constant — a member with a paid Alchemy/QuickNode key
 * wants their reads on it, with a failover for when it rate-limits.
 *
 * This module is the single source of truth for those overrides.
 *
 * Three deliberate choices:
 *
 * 1. DEVICE-SCOPED, NOT ACCOUNT-SCOPED. Reads happen with no wallet connected (the
 *    landing portfolio, capability probes), so an account-keyed store would leave the
 *    app's busiest read paths on the build defaults. Endpoints live in the non-wallet
 *    global preference blob (`utils/userStorage#saveGlobalPreference`).
 *
 * 2. NEVER IN A BACKUP. An endpoint entry can carry a provider credential. The spec-032
 *    backup blob is exportable plaintext-at-rest for everything except the spec-062 key
 *    vault, so endpoints are intentionally absent from `lib/backup/syncedObjects.js` —
 *    a member re-enters them per device. Do not "fix" that by adding an entry there.
 *
 * 3. SYNCHRONOUS + FRAMEWORK-FREE. `wagmi.js` builds its transports at module load and
 *    ~20 non-React read paths call `makeReadProvider` outside any component, so
 *    resolution must work without React and without awaiting anything.
 *
 * Credentials are redacted (`redactRpcUrl`) at every display and log boundary — see the
 * T148 leak (scripts/ops/verify-protocol-addresses.js printed keyed URLs verbatim into
 * CI logs). Nothing in this module ever console-logs a URL or token unredacted.
 */

import { getGlobalPreference, saveGlobalPreference } from '../../utils/userStorage'

/** Global-preference key holding the per-chain override map. */
export const ENDPOINTS_PREF_KEY = 'network_endpoints'

/** Auth modes a provider credential can be presented in. */
export const AUTH_MODES = {
  /** No credential, or one already embedded in the URL path/query (Alchemy, QuickNode). */
  NONE: 'none',
  /** Custom header, e.g. `x-api-key: …` (Chainstack, NOWNodes, self-hosted gateways). */
  HEADER: 'header',
  /** `Authorization: Bearer …` (Tenderly, dRPC tokens, JWT-gated nodes). */
  BEARER: 'bearer',
}

const MAX_URL_LENGTH = 2048
const MAX_TOKEN_LENGTH = 512
const MAX_HEADER_NAME_LENGTH = 64

/**
 * What the production Content-Security-Policy `connect-src` admits for RPC
 * (frontend/nginx.conf + nginx.conf.template), and therefore what a member may point a
 * network at. The browser blocks anything else before a request leaves the page.
 *
 * The policy is deliberately BROAD: `https:` at any host, plus the loopback origins. A
 * member's own node lives on a domain we cannot know at build time — a box in their cloud,
 * or their laptop — and a static header served to everyone cannot express a per-member
 * allowlist. Curating provider hostnames would have made every self-hosted endpoint a dead
 * network, which is the opposite of "bring your own node".
 *
 * Loopback is the local-node case. `http://` is otherwise unusable from an https page
 * (mixed content), and loopback is the only http origin browsers treat as potentially
 * trustworthy — so `http://192.168.1.5:8545` is blocked by the browser no matter what this
 * policy says, and `validateRpcUrl` says so rather than letting it fail mysteriously.
 *
 * Keep in sync with `src/test/nginxCspConnectSrc.test.js`, which asserts the shipped header
 * carries exactly these grants.
 */
export const CSP_RPC_GRANTS = {
  /** Any host on these schemes is reachable. */
  schemes: ['https:'],
  /**
   * http is reachable only on these hostnames (any port).
   *
   * The IPv6 loopback literal is deliberately ABSENT. CSP's host-source grammar has no
   * syntax for a bracketed IPv6 address, so `http://[::1]:*` is rejected as an invalid
   * source and dropped — the browser blocks the endpoint regardless of it being listed
   * (and says so, once per page load, in the console). Listing it here would only make the
   * app promise a route the browser refuses; a member running a local node reaches it on
   * `localhost` or `127.0.0.1`, which are grantable and do work.
   */
  httpHosts: ['localhost', '127.0.0.1'],
}

/**
 * Hostnames that are loopback, as a fact about the address — NOT a claim that the CSP
 * grants them (IPv6 loopback is loopback but ungrantable; see `CSP_RPC_GRANTS`). `URL`
 * keeps the brackets on an IPv6 literal, so both spellings are recognised.
 */
export function isLoopbackHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)
}

/**
 * Whether the browser will be allowed to connect to this URL under the production CSP.
 *
 * With the scheme-wide grant this is true for every https endpoint, so it is no longer a
 * gate members trip over — it exists to keep the http rule (grantable loopback only) in one
 * place and to keep the policy assertion in the test suite meaningful. Note this is
 * narrower than `isLoopbackHost`: an IPv6-loopback endpoint is genuinely local but cannot
 * be expressed in CSP, so answering `true` for it would be a promise the browser breaks.
 */
export function isCspAllowedRpcUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (CSP_RPC_GRANTS.schemes.includes(parsed.protocol)) return true
  if (parsed.protocol === 'http:') return CSP_RPC_GRANTS.httpHosts.includes(parsed.hostname)
  return false
}

/**
 * An endpoint string safe to render or log.
 *
 * Providers embed the API key in the URL PATH (Alchemy, QuickNode) or a query parameter,
 * so protocol + host is the most that can be shown; `/…` states that a credential exists
 * without revealing it. Mirrors `safeRpcLabel` in scripts/ops/verify-protocol-addresses.js.
 */
export function redactRpcUrl(url) {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    const hasSecret = (parsed.pathname && parsed.pathname !== '/') || parsed.search !== ''
    return `${parsed.protocol}//${parsed.host}${hasSecret ? '/…' : ''}`
  } catch {
    // Unparseable — say nothing rather than risk echoing a raw secret.
    return '(unparseable endpoint)'
  }
}

/**
 * Validate one URL a member typed.
 * @returns {{ ok: boolean, error?: string, warning?: string }}
 */
export function validateRpcUrl(url, { label = 'RPC URL' } = {}) {
  const trimmed = (url || '').trim()
  if (!trimmed) return { ok: true } // empty = "use the default"; not an error
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, error: `${label} is too long.` }

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: `${label} is not a valid URL.` }
  }

  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    return { ok: false, error: `${label} must be an HTTP(S) endpoint — WebSocket RPC is not supported.` }
  }
  const isLoopback = isLoopbackHost(parsed.hostname)
  if (parsed.protocol === 'http:' && !isLoopback) {
    // Not a policy choice we can reverse: browsers block insecure requests from a secure
    // page, and only loopback is exempt. Say which two options actually work.
    return {
      ok: false,
      error:
        `${label} must use https:// — browsers block insecure http:// requests from this page. ` +
        'Only a node on this device (localhost / 127.0.0.1) may use http://; put a remote node ' +
        'behind https or reach it through an SSH tunnel to localhost.',
    }
  }
  if (parsed.protocol === 'http:' && !CSP_RPC_GRANTS.httpHosts.includes(parsed.hostname)) {
    // Reached only by the IPv6 loopback literal: genuinely a local node, but CSP has no
    // syntax for a bracketed IPv6 host, so the browser blocks it whatever the policy says.
    // Refusing here beats saving an endpoint that can only ever fail.
    return {
      ok: false,
      error:
        `${label} cannot use an IPv6 address — browser security policy has no way to allow ` +
        'one. Use http://localhost or http://127.0.0.1 for a node on this device.',
    }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: `${label} must be an https:// endpoint.` }
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: `${label} must not carry credentials in the URL — use the API key fields instead.`,
    }
  }
  if (isLoopback) {
    // Not a problem — just a property of a local node worth stating, since endpoint settings
    // are per-device and other devices on this account will keep using their own route.
    return {
      ok: true,
      warning:
        'Local node: reachable only from this device, and it must allow cross-origin requests ' +
        'from this site (enable CORS on the node, e.g. geth --http.corsdomain). Test it to confirm.',
    }
  }
  return { ok: true }
}

/**
 * Validate a whole endpoint entry as typed in the panel.
 * @returns {{ ok: boolean, errors: Record<string,string>, warnings: string[] }}
 */
export function validateEndpointEntry(entry = {}) {
  const errors = {}
  const warnings = []

  const primary = validateRpcUrl(entry.url, { label: 'RPC URL' })
  if (!primary.ok) errors.url = primary.error
  else if (primary.warning) warnings.push(primary.warning)

  const failover = validateRpcUrl(entry.failoverUrl, { label: 'Failover RPC URL' })
  if (!failover.ok) errors.failoverUrl = failover.error
  else if (failover.warning) warnings.push(failover.warning)

  const url = (entry.url || '').trim()
  const failoverUrl = (entry.failoverUrl || '').trim()
  if (url && failoverUrl && url === failoverUrl) {
    errors.failoverUrl = 'The failover endpoint must differ from the primary endpoint.'
  }
  if (!url && failoverUrl) {
    errors.url = 'Set a primary RPC URL before adding a failover.'
  }

  const mode = entry.authMode || AUTH_MODES.NONE
  if (![AUTH_MODES.NONE, AUTH_MODES.HEADER, AUTH_MODES.BEARER].includes(mode)) {
    errors.authMode = 'Unknown authentication mode.'
  }
  const token = (entry.authToken || '').trim()
  if (mode !== AUTH_MODES.NONE) {
    if (!token) errors.authToken = 'Enter the API key or token, or set authentication to None.'
    else if (token.length > MAX_TOKEN_LENGTH) errors.authToken = 'API key is too long.'
    else if (/\s/.test(token)) errors.authToken = 'API key must not contain spaces.'
  }
  if (mode === AUTH_MODES.HEADER) {
    const headerName = (entry.authHeaderName || '').trim()
    if (!headerName) errors.authHeaderName = 'Enter the header name your provider expects.'
    else if (headerName.length > MAX_HEADER_NAME_LENGTH) errors.authHeaderName = 'Header name is too long.'
    // RFC 7230 token: no separators, no whitespace, no control characters.
    else if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(headerName)) {
      errors.authHeaderName = 'Header name may only contain letters, numbers and - _ . characters.'
    }
  }
  if (!url && (mode !== AUTH_MODES.NONE || token)) {
    errors.url = 'Set a primary RPC URL before adding an API key.'
  }

  return { ok: Object.keys(errors).length === 0, errors, warnings }
}

/** Strip an entry down to the persisted shape, dropping empty/irrelevant fields. */
function normalizeEntry(entry = {}) {
  const url = (entry.url || '').trim()
  if (!url) return null
  const mode = [AUTH_MODES.HEADER, AUTH_MODES.BEARER].includes(entry.authMode)
    ? entry.authMode
    : AUTH_MODES.NONE
  const out = { url }
  const failoverUrl = (entry.failoverUrl || '').trim()
  if (failoverUrl && failoverUrl !== url) out.failoverUrl = failoverUrl
  const token = (entry.authToken || '').trim()
  if (mode !== AUTH_MODES.NONE && token) {
    out.authMode = mode
    out.authToken = token
    if (mode === AUTH_MODES.HEADER) out.authHeaderName = (entry.authHeaderName || '').trim()
  }
  return out
}

// ---------------------------------------------------------------------------
// Persistence + in-memory snapshot
// ---------------------------------------------------------------------------

/** @type {Record<string, object>|null} lazily loaded snapshot, keyed by chainId string. */
let snapshot = null
/** Bumped on every change so React consumers can re-derive providers. */
let revision = 0
const listeners = new Set()

function readFromStorage() {
  const raw = getGlobalPreference(ENDPOINTS_PREF_KEY, {})
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [chainKey, entry] of Object.entries(raw)) {
    const chainId = Number(chainKey)
    if (!Number.isFinite(chainId) || chainId <= 0) continue
    const normalized = normalizeEntry(entry)
    if (normalized) out[String(chainId)] = normalized
  }
  return out
}

/** The full override map, keyed by chainId string. Never returns null. */
export function loadEndpointSettings() {
  if (snapshot === null) snapshot = readFromStorage()
  return snapshot
}

/** One chain's override entry, or null when the chain runs on its build default. */
export function getEndpointSettings(chainId) {
  return loadEndpointSettings()[String(Number(chainId))] || null
}

/** Monotonic counter that changes whenever any endpoint setting changes. */
export function endpointsRevision() {
  return revision
}

/**
 * Bump the revision WITHOUT persisting anything (spec 107).
 *
 * Exists for state that affects route resolution but must never touch storage — issued RPC
 * access, whose credential living in `fw_global_prefs` would be a stored secret riding the
 * device backup. `commit()` cannot be reused for this precisely because it saves; this is the
 * notify half alone. Rare transitions only (an issued endpoint appearing or disappearing):
 * every mounted provider memo re-derives on a bump, so a caller bumping per token renewal
 * would churn the whole app on a timer.
 */
export function bumpEndpointsRevision() {
  revision += 1
  for (const listener of listeners) {
    try {
      listener(revision)
    } catch {
      // A bad subscriber must not break the notification.
    }
  }
}

/** Subscribe to endpoint changes. Returns an unsubscribe function. */
export function subscribeEndpointSettings(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function commit(next) {
  snapshot = next
  revision += 1
  saveGlobalPreference(ENDPOINTS_PREF_KEY, next)
  for (const listener of listeners) {
    try {
      listener(revision)
    } catch {
      // A bad subscriber must not break the save.
    }
  }
}

/**
 * Persist one chain's endpoint entry. An entry with no primary URL clears the override
 * (that is what "Reset to default" does), so a member can never end up with a stored
 * credential and no endpoint to use it on.
 *
 * @param {number} chainId
 * @param {{url?: string, failoverUrl?: string, authMode?: string, authHeaderName?: string, authToken?: string}} entry
 */
export function saveEndpointSettings(chainId, entry) {
  const key = String(Number(chainId))
  const normalized = normalizeEntry(entry)
  const next = { ...loadEndpointSettings() }
  if (normalized) next[key] = normalized
  else delete next[key]
  commit(next)
  return normalized
}

/** Drop one chain's override, returning it to the build default. */
export function resetEndpointSettings(chainId) {
  const key = String(Number(chainId))
  const current = loadEndpointSettings()
  if (!(key in current)) return
  const next = { ...current }
  delete next[key]
  commit(next)
}

/** Drop every override (used by tests and the panel's "reset all"). */
export function clearAllEndpointSettings() {
  commit({})
}

/** Test seam: forget the in-memory snapshot so the next read hits storage again. */
export function __resetEndpointStoreForTests() {
  snapshot = null
  revision = 0
  listeners.clear()
}
