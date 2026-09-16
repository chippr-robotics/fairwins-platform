/**
 * viem PublicClient factory — the read side of spec 110's one EVM seam (Phase 1, #1592).
 *
 * The chain-parameterized replacement for `utils/rpcProvider.js#getReadProvider`. Everything
 * that seam resolved is resolved here, through the same spec-069/107 machinery, with the same
 * precedence: member endpoint → platform-issued keyed access → build default. What it does NOT
 * port is ethers' `_lastFatalError` eviction workaround — viem's fallback transport has no
 * terminal "no runners" state to work around, so the workaround is deleted with its disease.
 *
 * Client identity rules (they are the API, not an optimization):
 * - ONE client per chain, cached keyed on the RESOLVED ROUTE. A member editing their endpoint
 *   in Network settings changes the key and the next read rebuilds; nothing else does.
 * - An issued-access token rides per REQUEST (`onFetchRequest`), never in the cache key or a
 *   URL: rotation must not tear down the client (the mini-app host's identity-stable wrapper
 *   precedent), and the failover leg — a different host — never sees the credential.
 * - Member credential headers attach to the PRIMARY transport only, as static fetch headers,
 *   never written into a URL (spec 069's absolute rule).
 */
import { createPublicClient, fallback, http } from 'viem'
import { resolveRpcEndpoints } from '../network/rpcEndpoints'
import { ensureIssuedAccess, currentTokenFor } from '../network/issuedAccess'

/**
 * ETC mainnet (61) and Mordor (63): their Caddy-fronted core-geth/besu endpoints answer
 * JSON-RPC batches unreliably (see the history in utils/rpcProvider.js, which keeps the
 * legacy copy of this set until Phase 1 retires it). Everything else batches, preserving
 * the request volume the ethers path had (ethers batched by default; viem does not).
 */
const NO_BATCH_CHAIN_IDS = new Set([61, 63])

const clientCache = new Map() // chainId -> { key, client }

/** Minimal chain descriptor — reads pass explicit addresses, so no full chain config is needed. */
function chainDescriptor(chainId) {
  const id = Number(chainId)
  return {
    id,
    name: `chain-${id}`,
    nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  }
}

function primaryTransport(route, chainId) {
  const batch = NO_BATCH_CHAIN_IDS.has(Number(chainId)) ? false : true
  const options = { batch }
  const memberRoute = route.source === 'member' && route.primary ? route.primary : null
  const issuedRoute = route.source === 'issued' && route.primary ? route.primary : null
  if (memberRoute?.headers && Object.keys(memberRoute.headers).length > 0) {
    options.fetchOptions = { headers: { ...memberRoute.headers } }
  }
  if (issuedRoute) {
    // Per-request injection: the token the store holds NOW, not the one held at build time.
    options.onFetchRequest = (request) => {
      const token = currentTokenFor(chainId)
      if (token) request.headers.set('authorization', `Bearer ${token}`)
      return request
    }
  }
  return http(route.primary.url, options)
}

/**
 * The viem client for a chain, or null when the chain has no endpoint at all — the same
 * "null means no route" contract `getReadProvider` had, so three-state readers keep their
 * unreadable path.
 *
 * @param {number} chainId
 * @returns {import('viem').PublicClient|null}
 */
export function getPublicClient(chainId) {
  if (chainId == null) return null
  const route = resolveRpcEndpoints(chainId)
  if (!route.primary) return null

  // Keep issued access warm exactly as the ethers seam did (spec 107): fire-and-forget,
  // single-flight, cooldown-guarded; a member override makes it moot.
  if (route.source !== 'member') ensureIssuedAccess(chainId)

  const failoverUrl =
    route.failover && route.failover.url !== route.primary.url ? route.failover.url : null
  const key = JSON.stringify([
    route.source ?? 'default',
    route.primary.url,
    route.primary.headers ?? null,
    failoverUrl,
  ])

  const existing = clientCache.get(chainId)
  if (existing && existing.key === key) return existing.client

  const batch = NO_BATCH_CHAIN_IDS.has(Number(chainId)) ? false : true
  const transport = failoverUrl
    ? // Ordered, un-ranked: primary first, failover only when it errors or stalls — the
      // quorum-1 semantics the member configured the failover for.
      fallback([primaryTransport(route, chainId), http(failoverUrl, { batch })], { rank: false })
    : primaryTransport(route, chainId)

  const client = createPublicClient({ chain: chainDescriptor(chainId), transport })
  clientCache.set(chainId, { key, client })
  return client
}

/** Exported for tests — clears cached clients so route changes can be exercised. */
export function __resetPublicClientCache() {
  clientCache.clear()
}

/** The batching decision, mirrored from the legacy seam for callers/tests that need it. */
export function chainUsesUnbatchedRpc(chainId) {
  return chainId != null && NO_BATCH_CHAIN_IDS.has(Number(chainId))
}
