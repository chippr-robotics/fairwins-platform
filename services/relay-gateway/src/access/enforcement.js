/**
 * Per-endpoint enforcement verification (spec 107, FR-026/FR-032/FR-033).
 *
 * Before ANY access is served for an endpoint, the provider is asked — per endpoint, from its
 * admin API — whether that endpoint actually enforces the expiring credential and actually
 * restricts operations. Account-level availability is NOT per-endpoint enforcement: an endpoint
 * with `jwts` switched off is identical in every log to one with it on, right up until the address
 * we transmitted turns out to have been sufficient by itself.
 *
 * ── THE ONE PLACE "COULD NOT TELL" MEANS "NO" ────────────────────────────────────────────────
 *
 * Everywhere else in this gateway, `unverifiable` is a retryable 503 and never a denial, because
 * failing closed would refuse a member over an RPC timeout. HERE THE ASYMMETRY INVERTS, on
 * purpose: failing open transmits a credential that may be sufficient on its own. So `absent`
 * refuses, and `unverifiable` refuses identically. The caller's correct response is a degraded
 * read via public capacity, never an error surface — which is why the refusal is a distinct code
 * the client maps to fallback, not to a message.
 *
 * ── WHAT "ENFORCING" REQUIRES, EXACTLY ───────────────────────────────────────────────────────
 *
 *   options.jwts === true              the expiring credential is demanded
 *   options.requestFilters === true    the method whitelist is SWITCHED ON — a filter can exist
 *                                      while disabled, which is precisely the silent failure mode
 *   a filter present, with NO method   the read-only guarantee (FR-023) lives at the PROVIDER,
 *   outside the read allowlist         not in client convention
 *
 * `options.tokens` is deliberately not required either way: with `jwts` on, the URL token alone is
 * insufficient (the provider ANDs enabled methods), and stand-alone mode (`tokens: false`) is the
 * target configuration the runbook drives toward.
 *
 * ── THIS RESPONSE CARRIES LIVE CREDENTIALS ───────────────────────────────────────────────────
 *
 * The admin API returns `data.tokens[].token` — the endpoint's live URL tokens in PLAINTEXT —
 * alongside the booleans this module actually wants. The fetch below destructures the few fields
 * it needs and drops the rest ON THE SPOT, before anything can serialise the body into a log,
 * an error, or a cache entry (FR-033 / SC-012).
 */

/**
 * Methods a read-only issuance endpoint may whitelist. Anything outside this set appearing in the
 * endpoint's filter fails verification — a whitelist containing eth_sendRawTransaction is not a
 * read-only endpoint no matter what else it contains.
 */
export const READ_METHOD_ALLOWLIST = Object.freeze(
  new Set([
    'eth_blockNumber',
    'eth_call',
    'eth_chainId',
    'eth_estimateGas',
    'eth_gasPrice',
    'eth_feeHistory',
    'eth_getBalance',
    'eth_getBlockByHash',
    'eth_getBlockByNumber',
    'eth_getCode',
    'eth_getLogs',
    'eth_getStorageAt',
    'eth_getTransactionByHash',
    'eth_getTransactionCount',
    'eth_getTransactionReceipt',
    'eth_maxPriorityFeePerGas',
    'net_version',
    'web3_clientVersion',
  ])
)

/**
 * @param {object} opts
 * @param {string} opts.adminBaseUrl  provider admin API base
 * @param {string} opts.adminKey     admin API key (never logged)
 * @param {number} opts.cacheTtlMs   how long a verified verdict may be reused
 * @param {number} opts.timeoutMs
 * @param {() => number} [opts.now]  ms clock
 * @param {typeof fetch} [opts.fetchImpl]
 */
export function createEnforcementVerifier({ adminBaseUrl, adminKey, cacheTtlMs = 60_000, timeoutMs = 5000, now = () => Date.now(), fetchImpl = fetch }) {
  /** @type {Map<string, {verdict: object, at: number}>} endpointId -> cached verdict */
  const cache = new Map()

  async function fetchState(endpointId) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${adminBaseUrl}/v0/endpoints/${endpointId}/security`, {
        headers: { accept: 'application/json', 'x-api-key': adminKey },
        signal: controller.signal,
      })
      if (!res.ok) return { state: 'unverifiable', detail: `admin api answered ${res.status}` }
      const body = await res.json()
      // DESTRUCTURE AND DROP. `body` holds live endpoint tokens in plaintext; only these few
      // booleans and the filter methods survive this scope.
      const options = body?.data?.options ?? {}
      const filters = Array.isArray(body?.data?.request_filters) ? body.data.request_filters : []
      const methods = filters.flatMap((f) => (Array.isArray(f?.method) ? f.method : []))
      return {
        state: 'read',
        jwts: options.jwts === true,
        requestFilters: options.requestFilters === true,
        methods,
      }
    } catch {
      // No detail from the error: an upstream error body can quote the request, and the request
      // carries the admin key header.
      return { state: 'unverifiable', detail: 'admin api unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * @returns {Promise<{enforcement: 'verified', methods: string[]}
     *                  | {enforcement: 'absent'|'unverifiable', reason: string}>}
     */
    async check(endpointId) {
      const cached = cache.get(endpointId)
      // Only a VERIFIED verdict is cached. A refusal is re-checked every time: enforcement being
      // switched on should take effect on the next request, and caching a refusal would stretch an
      // operator's fix into a mystery.
      if (cached && now() - cached.at < cacheTtlMs) return cached.verdict

      const state = await fetchState(endpointId)
      if (state.state === 'unverifiable') {
        return { enforcement: 'unverifiable', reason: state.detail }
      }
      if (!state.jwts) {
        return { enforcement: 'absent', reason: 'endpoint does not require the expiring credential (jwts off)' }
      }
      if (!state.requestFilters) {
        // A filter that exists while switched off is the silent failure mode this check exists for.
        return { enforcement: 'absent', reason: 'method whitelist is not enabled on the endpoint' }
      }
      if (state.methods.length === 0) {
        return { enforcement: 'absent', reason: 'method whitelist is enabled but empty — nothing is provably read-only' }
      }
      const disallowed = state.methods.filter((m) => !READ_METHOD_ALLOWLIST.has(m))
      if (disallowed.length > 0) {
        return { enforcement: 'absent', reason: `whitelist permits non-read methods: ${disallowed.slice(0, 3).join(', ')}` }
      }

      const verdict = { enforcement: 'verified', methods: state.methods }
      cache.set(endpointId, { verdict, at: now() })
      return verdict
    },
  }
}
