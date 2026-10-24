/**
 * Assurance tiers (spec 106, data-model §1) — what was actually PROVEN about a caller.
 *
 * The central idea of the feature, and the reason it exists: the gateway holds every third-party
 * credential the platform owns and, before this, authenticated no caller at all. The origin lock
 * proves a request transited Cloudflare — a header the edge injects zone-wide, for an attacker's
 * request exactly as for ours — and CORS is a browser-only control that a script or a server
 * ignores. Neither says who is calling.
 *
 * FIVE RUNGS, AND THE TOP ONE IS UNREACHABLE ON THE WEB:
 *
 *   anonymous  nothing; the request arrived
 *   human      a real browser on a real device, recently          (a verified challenge)
 *   address    control of a specific account                      (a verified grant signature)
 *   member     that, PLUS an active paid membership               (the grant + a tier read)
 *   app        this exact signed application binary               (device attestation — NOT BUILT)
 *
 * WHY `address` AND `member` ARE SEPARATE. The spec-095 verifier answers 403 `membership_required`
 * unless the account holds a live paid tier. So "member-verified" already means "has paid", not
 * "proved control of this address" — and gating trading, broadcast or listing on it would stop any
 * member without a paid tier from trading at all. Proof of CONTROL is what those routes actually
 * need: a signer is stable, revocable, attributable and rate-limitable, which is everything
 * metering and accountability require. Whether they also bought a membership is a product question
 * this layer must not answer by accident.
 *
 * WHY `address` OUTRANKS `human`. It is strictly more accountable. A challenge token proves a
 * browser existed for a moment; an account proves who is answerable afterwards.
 *
 * WHY `app` EXISTS BUT IS NEVER REACHED. A web application CANNOT cryptographically prove its
 * identity to a server — anything the app can send, a member can read out of the shipped bundle and
 * replay. Real proof-of-app exists only on the native shells (hardware-rooted attestation), which is
 * a separate, deferred piece of work. The rung is declared so the ladder does not have to be
 * reshaped later, and `verifiers/attestation.js` is a registration seam that always abstains. FR-005
 * forbids any surface claiming this tier was reached on the web, and `isProofOfApp` below is how
 * calling code asks that question without re-deriving the answer.
 */

/** @typedef {'anonymous'|'human'|'address'|'member'|'app'} Tier */

export const TIERS = Object.freeze({
  ANONYMOUS: 'anonymous',
  HUMAN: 'human',
  ADDRESS: 'address',
  MEMBER: 'member',
  APP: 'app',
})

/**
 * Ordering, lowest first.
 *
 * Ordinals are for COMPARISON ONLY. They are never serialised, never sent to a client and never
 * stored — `atLeast()` is the entire use. Renumbering must therefore never be observable, and a
 * client must never be able to send an ordinal and have it mean anything.
 */
export const TIER_ORDER = Object.freeze([
  TIERS.ANONYMOUS,
  TIERS.HUMAN,
  TIERS.ADDRESS,
  TIERS.MEMBER,
  TIERS.APP,
])

const RANK = Object.freeze(
  TIER_ORDER.reduce((acc, tier, i) => Object.assign(acc, { [tier]: i }), Object.create(null))
)

/** True when `tier` is a tier this module defines. Anything else is a programming error. */
export function isTier(tier) {
  return typeof tier === 'string' && Object.prototype.hasOwnProperty.call(RANK, tier)
}

/**
 * Rank of a tier.
 *
 * THROWS on an unknown value rather than returning -1 or 0. An unknown tier reaching a comparison
 * means a route table or verifier is wrong; answering "0" would silently downgrade the caller to
 * anonymous and answering "-1" would silently satisfy every minimum. Both fail quietly, in opposite
 * and equally wrong directions, so neither is available.
 */
export function rankOf(tier) {
  if (!isTier(tier)) throw new TypeError(`unknown assurance tier: ${String(tier)}`)
  return RANK[tier]
}

/** `held` satisfies a route asking for `required`. */
export function atLeast(held, required) {
  return rankOf(held) >= rankOf(required)
}

/** The higher of two tiers. Used to fold several verifiers' verdicts into one. */
export function maxTier(a, b) {
  return rankOf(a) >= rankOf(b) ? a : b
}

/**
 * Does this tier constitute proof of APPLICATION identity?
 *
 * Exists so no caller has to re-derive FR-005's rule, and so the answer changes in exactly one place
 * if attestation ever ships. Only `app` qualifies, and nothing on the web can reach it.
 */
export function isProofOfApp(tier) {
  return rankOf(tier) >= rankOf(TIERS.APP)
}

/**
 * Tiers reachable by a web caller — the label set for anything that varies by tier.
 *
 * Metric and log labels MUST come from a bounded set (FR-036): a label built from request content
 * makes series count a function of usage and outgrows the tier in days. This is that set.
 */
export const OBSERVABLE_TIERS = Object.freeze(TIER_ORDER.filter((t) => t !== TIERS.APP))
