/**
 * Protected-route declarations (spec 106, data-model §4) — THE ONE TABLE.
 *
 * The middleware, the operator disclosure, the metering attribution and the least-privilege tests
 * all read this file. Two rules govern it, and both are the point rather than decoration.
 *
 * ── SILENCE IS NOT PERMISSION ─────────────────────────────────────────────────────────────────
 *
 * A route absent from this table is a CONFIGURATION ERROR, not an implicitly public route. That is
 * the deny-by-default posture the platform already applies to vault policy, and it is what stops a
 * new credential-spending route from shipping unlisted and unmetered — which is precisely how the
 * gateway arrived at the state this feature repairs. `routeTableTest` asserts the mounted set and
 * the declared set are the same, in both directions: a declared route that is not mounted is dead
 * configuration, and a mounted route that is not declared is a hole.
 *
 * ── A CHALLENGE IS A METERING UPGRADE, NEVER AN ACCESS GATE ───────────────────────────────────
 *
 * Every READ sits at `anonymous`. Tier does not decide WHETHER a read is served — it decides HOW
 * MUCH (the per-tier ceilings in the quota layer). This is FR-006 and FR-017 together, and the
 * first draft of the data model got it wrong: putting a `human` minimum on reads turns an
 * unreachable challenge service into a non-retryable 403 on exactly the surfaces that must keep
 * working. A logged-out visitor also then needs a challenge ceremony during boot, before the first
 * market fetch, which is a worse product for no security gain. Reads never refuse for want of a
 * tier; they slow down.
 *
 * ── WHY WRITES ASK FOR `address` AND NOT `member` ─────────────────────────────────────────────
 *
 * These routes are irreversible (a broadcast), or they spend the platform's commercial standing (an
 * order signed with our builder credentials). What they need is an ANSWERABLE PARTY — someone
 * stable, revocable and attributable. They do not need a customer. The spec-095 verifier refuses
 * without an active PAID membership, so demanding `member` here would stop an unpaid member from
 * trading at all: a severe regression, and one this table would have introduced silently.
 *
 * ── WHY SOME ROUTES SIT AT `anonymous` DESPITE MOVING VALUE ───────────────────────────────────
 *
 * `/v1/intents` and `/v1/paymaster` are SELF-AUTHENTICATING: the member's own signature is inside
 * the payload and is verified by the route, and both already enforce spend caps and per-account
 * quotas. Adding a tier minimum in front of them would not make them safer — it would break the
 * never-stranded rule by requiring a second credential to submit an intent the member already
 * signed. `/v1/member/*` likewise runs its own verifier and answers its own errors; this layer
 * observes it and does not second-guess it.
 */

import { TIERS } from './tiers.js'

/** @typedef {{pattern: string, method: string, minimumTier: string, upstream: string|null, class: 'read'|'write'|'sign'|'ops'}} ProtectedRoute */

const r = (method, pattern, minimumTier, cls, upstream = null) =>
  Object.freeze({ method, pattern, minimumTier, class: cls, upstream })

export const ROUTE_TABLE = Object.freeze([
  // ── Operations. Unchanged, and deliberately reachable without any credential. ──────────────
  r('GET', '/healthz', TIERS.ANONYMOUS, 'ops'),
  r('GET', '/status', TIERS.ANONYMOUS, 'ops'),

  // ── Self-authenticating value paths. The signature is IN the payload. ──────────────────────
  r('POST', '/v1/intents', TIERS.ANONYMOUS, 'ops'),
  r('GET', '/v1/intents/:id', TIERS.ANONYMOUS, 'read'),
  r('POST', '/v1/paymaster', TIERS.ANONYMOUS, 'ops'),
  r('POST', '/v1/engine/webhook', TIERS.ANONYMOUS, 'ops'), // own shared secret; lock-exempt

  // Keyed-access issuance (spec 107). ANONYMOUS on purpose — FR-022: tier shapes what is issued
  // (lifetime), never WHETHER. Gating it higher would make keyed reads a member benefit, which is
  // the product regression that spec's US1 exists to forbid. It meters itself per subject and
  // consumes no data-plane upstream; the admin-API check behind it is cache-bounded.
  r('POST', '/v1/access/rpc', TIERS.ANONYMOUS, 'ops'),

  // ── Reads. All anonymous: a challenge buys throughput, not entry. ──────────────────────────
  r('GET', '/v1/opensea/collections/:slug/stats', TIERS.ANONYMOUS, 'read', 'opensea'),
  r('GET', '/v1/opensea/:chainId/account/:address/nfts', TIERS.ANONYMOUS, 'read', 'opensea'),
  r('GET', '/v1/opensea/:chainId/contract/:contract/nfts/:identifier', TIERS.ANONYMOUS, 'read', 'opensea'),
  r('GET', '/v1/opensea/:chainId/collections/:slug/required-fees', TIERS.ANONYMOUS, 'read', 'opensea'),
  r('GET', '/v1/polymarket/:chainId/markets', TIERS.ANONYMOUS, 'read', 'polymarket'),
  r('GET', '/v1/polymarket/:chainId/markets/:conditionId', TIERS.ANONYMOUS, 'read', 'polymarket'),
  r('GET', '/v1/polymarket/:chainId/positions', TIERS.ANONYMOUS, 'read', 'polymarket'),
  r('GET', '/v1/polymarket/:chainId/fee-rate', TIERS.ANONYMOUS, 'read', 'polymarket'),
  r('GET', '/v1/perps/config', TIERS.ANONYMOUS, 'read', 'perps'),
  r('GET', '/v1/perps/pairs', TIERS.ANONYMOUS, 'read', 'perps'),
  r('GET', '/v1/perps/positions', TIERS.ANONYMOUS, 'read', 'perps'),
  r('GET', '/v1/news/:chainId/:asset', TIERS.ANONYMOUS, 'read', 'news'),
  r('GET', '/v1/bitcoin/:network/fees', TIERS.ANONYMOUS, 'read', 'bitcoin'),
  r('GET', '/v1/bitcoin/:network/stamps', TIERS.ANONYMOUS, 'read', 'bitcoin'),
  r('GET', '/v1/bitcoin/:network/tx/:txid', TIERS.ANONYMOUS, 'read', 'bitcoin'),
  r('GET', '/v1/bridge/:chainId/quote', TIERS.ANONYMOUS, 'read', 'bridge'),
  r('GET', '/v1/bridge/:chainId/status', TIERS.ANONYMOUS, 'read', 'bridge'),
  r('POST', '/v1/bitcoin/:network/addresses', TIERS.ANONYMOUS, 'read', 'bitcoin'), // a POST-shaped read

  // ── Writes and signing. `address`: an answerable party, not a customer. ────────────────────
  // Signs an order with the PLATFORM's builder credentials. Abuse here risks the commercial
  // relationship itself, not merely the bill — the strongest reason in the table.
  r('POST', '/v1/polymarket/:chainId/builder-sign', TIERS.ADDRESS, 'sign', 'polymarket'),
  // Irreversible once broadcast.
  r('POST', '/v1/bitcoin/:network/tx', TIERS.ADDRESS, 'write', 'bitcoin'),
  // Marketplace writes against the platform's API key and referral attribution.
  r('POST', '/v1/opensea/:chainId/listings', TIERS.ADDRESS, 'write', 'opensea'),
  r('POST', '/v1/opensea/:chainId/listings/cancel', TIERS.ADDRESS, 'write', 'opensea'),
  r('POST', '/v1/opensea/:chainId/offers/fulfillment', TIERS.ADDRESS, 'write', 'opensea'),
])

/**
 * Route trees this layer OBSERVES but does not gate.
 *
 * `/v1/member/*` runs the spec-095 verifier and answers its own error codes, including the
 * three-verdict `auth_unverifiable` / `membership_unreadable` distinction. Layering a second
 * minimum in front of it would produce two different refusals for one condition, and the outer one
 * would be the less informative.
 */
export const DELEGATED_PREFIXES = Object.freeze(['/v1/member/'])

/** Express-style `:param` pattern -> matcher. Anchored, so a prefix cannot masquerade as a match. */
function toRegExp(pattern) {
  const src = pattern
    .split('/')
    .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/')
  return new RegExp(`^${src}$`)
}

const COMPILED = ROUTE_TABLE.map((route) => ({ route, re: toRegExp(route.pattern) }))

/**
 * The declaration governing this request, or `null` when none does.
 *
 * A `null` is NOT permission — the middleware treats it as a configuration error for a mounted
 * route. It is returned rather than thrown so the caller decides the consequence, because the right
 * answer differs between production (refuse, and say the route is not configured) and the test that
 * enumerates the mounted set.
 */
export function lookupRoute(method, path) {
  if (DELEGATED_PREFIXES.some((p) => path.startsWith(p))) return { delegated: true }
  const hit = COMPILED.find(({ route, re }) => route.method === method && re.test(path))
  return hit ? hit.route : null
}

/** Every upstream this table attributes consumption to — a bounded metric label set (FR-036). */
export const UPSTREAMS = Object.freeze([
  ...new Set(ROUTE_TABLE.map((route) => route.upstream).filter(Boolean)),
])
