/**
 * Caller-identity resolution (spec 106, data-model §2/§3).
 *
 * Runs every registered verifier over one request and folds their verdicts into a single
 * `CallerIdentity`. This is where the feature's two most load-bearing rules live.
 *
 * ── RULE 1: `verificationState` IS NOT A BOOLEAN ──────────────────────────────────────────────
 *
 * A credential can fail in two categorically different ways:
 *
 *   rejected      the credential was examined and is not valid
 *   unverifiable  a dependency could not be reached, so nothing is known
 *
 * A boolean has ONE falsy value and would force those to share it. That collapse is exactly the bug
 * FR-009 exists to prevent: `rejected` is a denial, `unverifiable` is a retryable 503, and telling a
 * member their own signature is forged because an RPC was slow is the specific failure the spec-084
 * message-signing rules already forbid elsewhere. A contract account (a passkey member) has no
 * public key, so "we could not check" is what a perfectly legitimate signature looks like from
 * outside. The type is what keeps them apart.
 *
 * ── RULE 2: AN ACCEPTANCE SETTLES IT, EVEN IF ANOTHER VERIFIER TIMED OUT ──────────────────────
 *
 * Precedence, in order:
 *
 *   1. any verifier ACCEPTED   -> verified, at the highest accepted tier
 *   2. else any UNVERIFIABLE   -> unverifiable, at anonymous
 *   3. otherwise               -> verified, at anonymous
 *
 * Rule 1 before rule 2 is deliberate and is the single easiest thing to get wrong here. A member
 * holding a valid grant must NOT be downgraded, or handed a 503, because an unrelated challenge
 * service was unreachable. Their credential was checked and it was good; another verifier's outage
 * is not evidence about them.
 *
 * Note what rule 3 does NOT do: it does not treat "nobody presented anything" as an error. An
 * anonymous caller is a first-class, expected outcome — read routes sit at the anonymous minimum
 * precisely so they never refuse for want of a tier (FR-006).
 *
 * ── VERIFIER CONTRACT ────────────────────────────────────────────────────────────────────────
 *
 *   verify(req) -> { kind, outcome, tierIfAccepted, subject?, detail? }
 *   outcome     : 'accepted' | 'rejected' | 'unverifiable' | 'absent'
 *
 * Verifiers are independent and ORDER-FREE — none may depend on another having run — and none may
 * throw to deny. A thrown error is indistinguishable from a bug, so one is caught here and recorded
 * as `unverifiable`, never as `rejected`: a crashing verifier must not silently start denying real
 * callers.
 */

import { TIERS, maxTier, rankOf } from './tiers.js'

/** @typedef {'accepted'|'rejected'|'unverifiable'|'absent'} Outcome */

const ANON = Object.freeze({
  tier: TIERS.ANONYMOUS,
  subject: null,
  verificationState: 'verified',
  reason: null,
  evidence: Object.freeze([]),
})

/** A verifier answer we could not make sense of is a bug in that verifier, not a denial. */
function normalise(kind, raw) {
  const outcome = raw && raw.outcome
  if (outcome === 'accepted' || outcome === 'rejected' || outcome === 'unverifiable' || outcome === 'absent') {
    return {
      kind,
      outcome,
      tierIfAccepted: raw.tierIfAccepted ?? TIERS.ANONYMOUS,
      subject: raw.subject ?? null,
      detail: raw.detail ?? null,
    }
  }
  return {
    kind,
    outcome: 'unverifiable',
    tierIfAccepted: TIERS.ANONYMOUS,
    subject: null,
    detail: 'verifier returned an unrecognised outcome',
  }
}

/**
 * @param {Array<{kind: string, verify: Function}>} verifiers
 * @returns {(req: object) => Promise<object>} resolver
 */
export function createResolver(verifiers = []) {
  return async function resolve(req) {
    if (verifiers.length === 0) return { ...ANON, evidence: [] }

    const evidence = await Promise.all(
      verifiers.map(async (v) => {
        try {
          return normalise(v.kind, await v.verify(req))
        } catch (err) {
          // A verifier that throws is broken, and a broken verifier must not become a denial
          // machine. `detail` carries a shape, never the error's message — an upstream error body
          // can contain credential material (FR-037).
          return {
            kind: v.kind,
            outcome: 'unverifiable',
            tierIfAccepted: TIERS.ANONYMOUS,
            subject: null,
            detail: `verifier threw (${err?.name || 'Error'})`,
          }
        }
      })
    )

    const accepted = evidence.filter((e) => e.outcome === 'accepted')

    if (accepted.length > 0) {
      // Rule 2: an acceptance settles it. Take the highest tier, and the subject that BELONGS to
      // that tier — not merely the first subject seen, or a lower-tier verifier's subject could
      // become the metering key for a higher-tier caller.
      const tier = accepted.reduce((acc, e) => maxTier(acc, e.tierIfAccepted), TIERS.ANONYMOUS)
      const winner = accepted
        .filter((e) => e.tierIfAccepted === tier)
        .find((e) => e.subject != null)
      return {
        tier,
        subject: winner ? winner.subject : null,
        verificationState: 'verified',
        reason: null,
        evidence,
      }
    }

    const unverifiable = evidence.find((e) => e.outcome === 'unverifiable')
    if (unverifiable) {
      return {
        tier: TIERS.ANONYMOUS,
        subject: null,
        verificationState: 'unverifiable',
        reason: `${unverifiable.kind}: ${unverifiable.detail || 'verification dependency unreachable'}`,
        evidence,
      }
    }

    const rejected = evidence.find((e) => e.outcome === 'rejected')
    return {
      tier: TIERS.ANONYMOUS,
      subject: null,
      verificationState: 'verified',
      reason: rejected ? `${rejected.kind}: ${rejected.detail || 'credential rejected'}` : null,
      evidence,
    }
  }
}

/**
 * The metering key for a caller (FR-011).
 *
 * Falls back to a network identifier ONLY at anonymous. Above that a caller has proven something
 * stable, and metering on the network address instead would put everyone behind one NAT or one
 * mobile carrier into a single bucket.
 *
 * The value returned is never a caller-asserted identifier. That is the whole repair: quotas
 * previously keyed on an address written into the request path, which is a name the caller chooses
 * and can change per request, so it metered nothing.
 */
export function subjectFor(identity, req) {
  if (identity && identity.subject) return `${identity.tier}:${identity.subject}`
  return `${TIERS.ANONYMOUS}:ip:${(req && req.ip) || 'unknown'}`
}

/** True when this identity satisfies a route's declared minimum. */
export function satisfies(identity, minimumTier) {
  return rankOf(identity.tier) >= rankOf(minimumTier)
}

export const ANONYMOUS_IDENTITY = ANON
