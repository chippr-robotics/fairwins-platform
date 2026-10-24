/**
 * Endpoint resolution (spec 069).
 *
 * One question, answered in one place: "which RPC route should a read for chain X take,
 * right now?" Precedence, highest first:
 *
 *   1. the member's override for that chain (Network settings, `endpointStore`)
 *   2. platform-ISSUED keyed access for that chain (spec 107, `issuedAccess` — module memory,
 *      acquired in the background; the route carries the URL only, never the credential)
 *   3. the build default for that chain (`NETWORKS[chainId].rpcUrl`, itself
 *      `VITE_RPC_URL_*` or a curated public endpoint)
 *
 * Consumers never re-implement that order — `utils/rpcProvider#makeReadProvider` (every
 * ethers read in the app) and `wagmi.js` (the wallet transports) both come through here,
 * which is what makes "services use the member's routes" true rather than aspirational.
 *
 * The member's API key is attached to the PRIMARY endpoint only. A failover is usually a
 * different provider, and fanning a credential out to a second host the app has no reason
 * to trust it with is a leak we would be choosing on the member's behalf; a failover that
 * needs its own key carries it in its URL (which is how Alchemy/QuickNode do it anyway).
 */

import { NETWORKS } from '../../config/networks'
import { AUTH_MODES, getEndpointSettings, redactRpcUrl } from './endpointStore'
import { getIssuedAccessSync } from './issuedAccess'

/** Build-time default endpoint for a chain (env override or curated public RPC). */
export function defaultRpcUrlForChain(chainId) {
  return NETWORKS[Number(chainId)]?.rpcUrl || null
}

/**
 * Build-time failover for a chain, where one is curated. Only some chains define this —
 * it exists for networks served by community-run RPCs, where the single default going
 * down would otherwise leave a member on default settings with no route at all.
 */
export function defaultRpcFailoverUrlForChain(chainId) {
  return NETWORKS[Number(chainId)]?.rpcFailoverUrl || null
}

/** Request headers implied by an entry's auth settings. `{}` when there are none. */
export function authHeadersFor(entry) {
  if (!entry || !entry.authToken) return {}
  if (entry.authMode === AUTH_MODES.BEARER) return { Authorization: `Bearer ${entry.authToken}` }
  if (entry.authMode === AUTH_MODES.HEADER && entry.authHeaderName) {
    return { [entry.authHeaderName]: entry.authToken }
  }
  return {}
}

/**
 * The full route for a chain.
 *
 * @param {number} chainId
 * @returns {{
 *   chainId: number,
 *   primary: { url: string, headers: Record<string,string> } | null,
 *   failover: { url: string, headers: Record<string,string> } | null,
 *   source: 'member' | 'issued' | 'default',
 *   defaultUrl: string | null,
 * }}
 */
export function resolveRpcEndpoints(chainId) {
  const id = Number(chainId)
  const defaultUrl = defaultRpcUrlForChain(id)
  const entry = getEndpointSettings(id)

  if (!entry?.url) {
    // Platform-issued keyed access (spec 107) slots between the member's choice and the build
    // default. THE ROUTE CARRIES NO CREDENTIAL: headers stay empty, and the token reaches the
    // wire per request via the provider's preflight hook — which is what lets it rotate without
    // rebuilding providers, and what keeps the failover leg (a different host) from ever seeing
    // it. The build default becomes the failover, so issued access going dark degrades to the
    // public route rather than to nothing.
    const issued = getIssuedAccessSync(id)
    if (issued?.url) {
      return {
        chainId: id,
        primary: { url: issued.url, headers: {} },
        failover: defaultUrl && defaultUrl !== issued.url ? { url: defaultUrl, headers: {} } : null,
        source: 'issued',
        defaultUrl,
      }
    }
    // A member on default settings still gets the build's curated failover where one exists,
    // so a community-run primary going dark degrades to a slower route rather than to nothing.
    const builtInFailover = defaultRpcFailoverUrlForChain(id)
    return {
      chainId: id,
      primary: defaultUrl ? { url: defaultUrl, headers: {} } : null,
      failover: defaultUrl && builtInFailover && builtInFailover !== defaultUrl
        ? { url: builtInFailover, headers: {} }
        : null,
      source: 'default',
      defaultUrl,
    }
  }

  const headers = authHeadersFor(entry)
  // The build default becomes the last resort behind an explicit failover: a member's
  // custom endpoint going dark must never take the whole network down with it.
  const failoverUrl = entry.failoverUrl || (defaultUrl !== entry.url ? defaultUrl : null)
  return {
    chainId: id,
    primary: { url: entry.url, headers },
    failover: failoverUrl ? { url: failoverUrl, headers: {} } : null,
    source: 'member',
    defaultUrl,
  }
}

/**
 * The single endpoint URL to use for a chain — for callers that need a string rather than
 * a provider (display, deep links, service clients that build their own transport).
 */
export function getRpcUrlForChain(chainId) {
  return resolveRpcEndpoints(chainId).primary?.url || null
}

/** Redacted, display-safe description of a chain's route. Never contains a credential. */
export function describeRpcRoute(chainId) {
  const route = resolveRpcEndpoints(chainId)
  return {
    source: route.source,
    primary: route.primary ? redactRpcUrl(route.primary.url) : '',
    failover: route.failover ? redactRpcUrl(route.failover.url) : '',
    hasAuth: Object.keys(route.primary?.headers || {}).length > 0,
  }
}

/**
 * Ask an endpoint what chain it serves.
 *
 * This is the honest-state gate on saving an override: an endpoint that answers with a
 * DIFFERENT chainId would silently serve another network's state into every balance,
 * position and policy read for this one, so the panel refuses to save it. An endpoint
 * that cannot be reached at all (offline, CSP-blocked, provider down) is reported as
 * such and left to the member's judgement — they may be configuring ahead of a change.
 *
 * @param {string} url
 * @param {{ headers?: Record<string,string>, expectedChainId?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ ok: boolean, chainId: number|null, code: 'ok'|'unreachable'|'chain-mismatch'|'bad-response'|'invalid-url', message: string }>}
 */
export async function probeRpcEndpoint(url, opts = {}) {
  const { headers = {}, expectedChainId = null, timeoutMs = 8000, fetchImpl } = opts
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null)
  const safeUrl = redactRpcUrl(url)

  if (!url || safeUrl === '(unparseable endpoint)') {
    return { ok: false, chainId: null, code: 'invalid-url', message: 'That is not a valid endpoint URL.' }
  }
  if (!doFetch) {
    return { ok: false, chainId: null, code: 'unreachable', message: 'No network client available.' }
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller?.signal,
    })
    if (!response.ok) {
      return {
        ok: false,
        chainId: null,
        code: 'bad-response',
        // Redacted host only: the URL may carry the member's key.
        message: `${safeUrl} answered HTTP ${response.status}.`,
      }
    }
    const body = await response.json()
    const reported = body?.result != null ? Number(body.result) : NaN
    if (!Number.isFinite(reported)) {
      return {
        ok: false,
        chainId: null,
        code: 'bad-response',
        message: `${safeUrl} did not return a chain id.`,
      }
    }
    if (expectedChainId != null && reported !== Number(expectedChainId)) {
      return {
        ok: false,
        chainId: reported,
        code: 'chain-mismatch',
        message: `${safeUrl} serves chain ${reported}, not chain ${Number(expectedChainId)}.`,
      }
    }
    return { ok: true, chainId: reported, code: 'ok', message: `${safeUrl} answered for chain ${reported}.` }
  } catch {
    // No error detail echoed — a thrown fetch error can contain the full URL. The causes are
    // listed in the order they actually occur for a self-hosted node: the browser refuses the
    // cross-origin call far more often than the node is genuinely down.
    return {
      ok: false,
      chainId: null,
      code: 'unreachable',
      message:
        `Could not reach ${safeUrl}. Check that the node is running and reachable from this ` +
        'device, and that it allows cross-origin requests from this site (CORS).',
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
