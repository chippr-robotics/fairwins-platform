/**
 * Shared read-provider factory.
 *
 * Every ethers read in the app comes through here, which makes this the seam where the
 * member's own RPC route (spec 069, `lib/network/rpcEndpoints`) is applied: pass a chainId
 * and you get a provider pointed at their endpoint, with their API-key header attached and
 * their failover behind it. Callers that still pass a URL keep working — the URL is used
 * only when the chain has no member override (see `makeReadProvider`).
 *
 * ethers v6 batches concurrent JSON-RPC calls into a single request by default
 * (batchMaxCount = 100). Some chains' public RPC endpoints — notably Ethereum
 * Classic / Mordor (Caddy-fronted core-geth/besu nodes) — return batch
 * responses that ethers cannot decode, surfacing as
 *   `bad response data (… code=SERVER_ERROR …)` / `invalid BytesLike value`.
 *
 * The failure is intermittent and environment-dependent (it reproduces in the
 * browser/DOM runtime even when a plain Node process tolerates it), and it takes
 * down EVERY read on the chain — `fetchFriendMarketsForUser` (My Wagers) and
 * `hasRoleOnChain` (the membership banner) both go through the same provider, so
 * a single batched failure leaves the UI looking empty.
 *
 * For these chains we disable batching so each eth_call is sent on its own
 * request, which the endpoints handle reliably. Chains known to support batching
 * (Polygon, Amoy) keep the default behavior so we don't regress their request
 * volume.
 */
import { ethers } from 'ethers'
import { resolveRpcEndpoints } from '../lib/network/rpcEndpoints'
import { ensureIssuedAccess, currentTokenFor } from '../lib/network/issuedAccess'

// Ethereum Classic mainnet (61) and Mordor testnet (63).
const NO_BATCH_CHAIN_IDS = new Set([61, 63])

// Every ethers provider runs its own `_detectNetwork` polling loop, which retries forever
// (once a second) when the endpoint is unreachable — there is no signal back to the app
// when that happens, and nothing ever calls `.destroy()`. Building a fresh provider on
// every read (as this used to) means a single flaky chain accumulates one more permanent
// retry loop per read, all hammering the endpoint independently and forever. Caching one
// provider per resolved route keeps that to at most one loop per chain, and rebuilds
// (replacing, not stacking) the moment the resolved route actually changes — e.g. a
// member edits their endpoint in Network settings.
const providerCache = new Map() // chainId -> { key, provider }

function cachedProvider(chainId, key, build) {
  if (chainId == null) return build()
  const existing = providerCache.get(chainId)
  if (existing && existing.key === key) return existing.provider
  if (typeof existing?.provider?.destroy === 'function') {
    try {
      existing.provider.destroy()
    } catch {
      // best-effort cleanup — a provider that fails to tear down cleanly shouldn't block
      // building its replacement.
    }
  }
  const provider = build()
  providerCache.set(chainId, { key, provider })
  return provider
}

/**
 * Build one JsonRpcProvider for a single endpoint.
 *
 * Auth headers ride on a `FetchRequest` rather than the URL, so a provider credential
 * never lands in a URL that could be logged. `staticNetwork` is set only when the chainId
 * is known AND the caller is building a failover set (see below) — a single provider keeps
 * ethers' own network detection so a misconfigured endpoint fails loudly instead of
 * silently answering for another chain.
 */
function buildProvider(url, headers, chainId, { staticNetwork = false, preflight = null } = {}) {
  const options = {}
  if (chainId != null && NO_BATCH_CHAIN_IDS.has(Number(chainId))) options.batchMaxCount = 1

  let target = url
  if ((headers && Object.keys(headers).length > 0) || preflight) {
    const request = new ethers.FetchRequest(url)
    for (const [name, value] of Object.entries(headers || {})) request.setHeader(name, value)
    // Issued-access tokens attach here, per request, so a rotation needs no rebuild and no
    // credential ever sits in a provider cache key or a URL (spec 107; spec 069's header rule).
    if (preflight) request.preflightFunc = preflight
    target = request
  }

  let network
  if (staticNetwork && chainId != null) {
    // A FallbackProvider needs every member to agree on the network up front; ethers only
    // knows the well-known chains by number, so name the rest explicitly.
    network = new ethers.Network(`chain-${Number(chainId)}`, Number(chainId))
    options.staticNetwork = network
  }

  return new ethers.JsonRpcProvider(target, network, Object.keys(options).length ? options : undefined)
}

/**
 * Build a provider for read calls.
 *
 * Resolution order for the endpoint (spec 069):
 *   1. the member's configured endpoint + failover for `chainId`
 *   2. `rpcUrl` as passed by the caller (the build default, `NETWORKS[chainId].rpcUrl`)
 *
 * With a failover configured the result is an `ethers.FallbackProvider` at quorum 1: the
 * primary is tried first and the failover answers when it stalls or errors, which is the
 * whole point of the member setting one.
 *
 * @param {string} rpcUrl - default endpoint; used when the chain has no member override
 * @param {number|null} [chainId] - selects the member's route and the batching decision
 * @returns {ethers.JsonRpcProvider|ethers.FallbackProvider}
 */
export function makeReadProvider(rpcUrl, chainId = null) {
  const route = chainId != null ? resolveRpcEndpoints(chainId) : null

  // Keep issued access warm (spec 107): fire-and-forget, single-flight, cooldown-guarded — the
  // synchronous path never waits on it. Until the first mint lands this call is what causes it
  // to land; afterwards it renews ahead of expiry. On a chain the gateway declines (404) the
  // store cools down and reads simply stay on the public default.
  if (chainId != null && route?.source !== 'member') ensureIssuedAccess(chainId)

  // A member endpoint replaces the caller's URL outright. Without one, platform-ISSUED keyed
  // access (spec 107) takes the primary with the build default as failover. Without either, the
  // caller's URL stays the primary (pre-069 behavior) and only picks up the build's curated
  // failover where the chain defines one — so a community-run default going dark degrades to a
  // slower route instead of leaving the chain with no route at all.
  const memberRoute = route?.source === 'member' && route.primary ? route.primary : null
  const issuedRoute = route?.source === 'issued' && route.primary ? route.primary : null
  const primaryUrl = memberRoute ? memberRoute.url : issuedRoute ? issuedRoute.url : rpcUrl
  const primaryHeaders = memberRoute ? memberRoute.headers : null
  const failoverUrl =
    route?.failover && route.failover.url !== primaryUrl ? route.failover.url : null

  // The issued credential reaches the wire PER REQUEST via a preflight hook, never via the
  // provider's construction: the cache key stays stable across token renewals (a token in the
  // key would tear down and rebuild the provider on every rotation, breaking the mini-app
  // host's identity-stable wrappers), and the failover leg — a different host — never sees it.
  const issuedPreflight = issuedRoute
    ? async (req) => {
        const token = currentTokenFor(chainId)
        if (token) req.setHeader('authorization', `Bearer ${token}`)
        return req
      }
    : null

  if (!failoverUrl) {
    const key = JSON.stringify(['single', route?.source ?? 'caller', primaryUrl, primaryHeaders])
    return cachedProvider(chainId, key, () =>
      buildProvider(primaryUrl, primaryHeaders, chainId, { preflight: issuedPreflight }),
    )
  }

  const key = JSON.stringify(['fallback', route?.source ?? 'caller', primaryUrl, primaryHeaders, failoverUrl])
  return cachedProvider(chainId, key, () => {
    const primary = buildProvider(primaryUrl, primaryHeaders, chainId, {
      staticNetwork: true,
      preflight: issuedPreflight,
    })
    const failover = buildProvider(failoverUrl, null, chainId, { staticNetwork: true })
    const fp = new ethers.FallbackProvider(
      [
        { provider: primary, priority: 1, weight: 1, stallTimeout: 2000 },
        { provider: failover, priority: 2, weight: 1 },
      ],
      new ethers.Network(`chain-${Number(chainId)}`, Number(chainId)),
      { quorum: 1 },
    )
    // ethers' FallbackProvider marks a member config `_lastFatalError` when its block-number
    // probe fails and NEVER clears it. Once every member has failed once — one bad minute of
    // connectivity kills both rails — the instance rejects everything instantly with
    // "no runners?!" and no request ever reaches the wire again. Cached module-wide, that turns
    // a transient outage into "dead until full reload" while every surface honestly offers a
    // retry that cannot work. Evicting the cache entry on that terminal state makes the NEXT
    // read rebuild fresh members; the failing call still fails (the network really was down
    // when the instance died), which keeps the degradation honest.
    // (Guarded: the vitest suite substitutes a global ethers mock without `_perform`.)
    const perform = typeof fp._perform === 'function' ? fp._perform.bind(fp) : null
    if (perform) {
      fp._perform = async (req) => {
        try {
          return await perform(req)
        } catch (err) {
          if (String(err?.message ?? '').includes('no runners')) {
            const cached = providerCache.get(chainId)
            if (cached?.provider === fp) providerCache.delete(chainId)
          }
          throw err
        }
      }
    }
    return fp
  })
}

/**
 * Provider for a chain, resolving the endpoint itself. Preferred in new code — it cannot
 * be called with a URL that contradicts the member's settings.
 *
 * @param {number} chainId
 * @returns {ethers.JsonRpcProvider|ethers.FallbackProvider|null} null when the chain has no endpoint at all
 */
export function getReadProvider(chainId) {
  const route = resolveRpcEndpoints(chainId)
  if (!route.primary) return null
  return makeReadProvider(route.primary.url, chainId)
}

/** Exported for tests / callers that need the batching decision directly. */
export function chainNeedsUnbatchedRpc(chainId) {
  return chainId != null && NO_BATCH_CHAIN_IDS.has(Number(chainId))
}
