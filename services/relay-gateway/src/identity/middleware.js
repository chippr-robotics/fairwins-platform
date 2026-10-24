/**
 * Caller-identity middleware (spec 106, contracts/gateway-api.md Part 1).
 *
 * TWO SWITCHES, NOT ONE, AND THE SECOND IS THE POINT.
 *
 *   enabled: false            inert. Every caller resolves anonymous; no verifier runs.
 *   enabled, enforce: false   OBSERVE. Identity resolves and is reported; no status code changes.
 *   enabled, enforce: true    refuse a route whose declared minimum is not met.
 *
 * Observe exists so the tier model can be validated against real traffic before anything depends on
 * it. If the model is wrong, the cost is a wrong header rather than refused members — and a safety
 * layer that starts refusing the moment it is deployed fails in the shape "the product is broken",
 * which is the worst way for this particular change to be wrong.
 *
 * ── ORDERING, AND WHY EACH POSITION IS LOAD-BEARING ───────────────────────────────────────────
 *
 *   CORS/preflight -> body parse -> ORIGIN LOCK -> [ CALLER IDENTITY ] -> route + quota -> handler
 *
 * AFTER the origin lock. The lock is a cheap string comparison that rejects non-edge traffic;
 * resolution may make a network call. Resolving first would let an off-edge caller cost us an
 * upstream round trip per request — turning an identity layer into an amplifier.
 *
 * BEFORE route dispatch. Identity must resolve for a route that does not exist, or an
 * unauthenticated prober could enumerate the route surface by the difference between "404" and
 * "403", which is a map of exactly which paths are worth attacking.
 *
 * NEVER on a preflight. `OPTIONS` short-circuits at CORS above, because a browser cannot attach
 * credentials to a preflight — it carries none by definition. If resolution ever saw one it would
 * resolve `anonymous` every time and pollute the metering it exists to make honest.
 *
 * ── THE HEADER IS DIAGNOSTIC, NEVER AN INPUT ─────────────────────────────────────────────────
 *
 * `X-FairWins-Tier` reports what the gateway concluded. It is never read back, and it deliberately
 * names no application, because the web cannot prove one (FR-005). A caller sending it is ignored.
 */

import { createResolver, subjectFor, satisfies, ANONYMOUS_IDENTITY } from './resolve.js'
import { lookupRoute } from './routeTable.js'
import { TIERS } from './tiers.js'
import { GatewayError } from '../errors.js'

export const TIER_HEADER = 'X-FairWins-Tier'

/**
 * The refusal for a route whose minimum was not met.
 *
 * Each code names WHAT IS MISSING, not merely that something is (FR-008). "Forbidden" tells a
 * caller nothing they can act on; "this action needs a member session, authorise one in Settings"
 * tells them exactly what to do next.
 */
const REFUSALS = Object.freeze({
  [TIERS.HUMAN]: {
    code: 'challenge_required',
    reason: 'this request needs a completed verification challenge; reload the page and try again',
  },
  [TIERS.ADDRESS]: {
    code: 'account_proof_required',
    reason:
      'this action signs or broadcasts on your behalf and needs a session proving control of your account; authorise one in Settings ▸ API access',
  },
  [TIERS.MEMBER]: {
    code: 'member_grant_required',
    reason: 'this action needs an active FairWins membership session; authorise one in Settings ▸ API access',
  },
})

/**
 * @param {{enabled: boolean, enforce?: boolean}} options
 * @param {Array<{kind: string, verify: Function}>} verifiers
 */
export function createIdentityMiddleware(options = {}, verifiers = []) {
  const resolve = createResolver(verifiers)

  return async function identityMiddleware(req, res, next) {
    // Read PER REQUEST, not destructured at construction: SIGHUP reload (spec 106 FR-014) flips
    // these on the live options object, and a captured boolean would make the reload a silent
    // no-op for this middleware while /status truthfully reported the new value — the exact
    // "disabled looks enforcing" split FR-015 forbids.
    const enabled = options.enabled === true
    const enforce = enabled && options.enforce === true
    // A disabled layer must be INERT, not permissive-looking. `req.caller` is still populated, so
    // downstream code never has to branch on "is identity configured" — it reads one shape always.
    // FR-015: the disabled state is disclosed loudly at boot and in the gated /status, never
    // inferred from behaviour that happens to look the same.
    if (!enabled) {
      req.caller = { ...ANONYMOUS_IDENTITY, evidence: [], enforcement: 'off' }
      req.callerSubject = subjectFor(req.caller, req)
      res.setHeader(TIER_HEADER, req.caller.tier)
      options.counters?.hitTier(req.caller.tier)
      return next()
    }

    try {
      const identity = await resolve(req)
      req.caller = { ...identity, enforcement: enforce ? 'enforce' : 'observe' }
      req.callerSubject = subjectFor(identity, req)
      // Attach the route declaration so quota attribution and enforcement read the SAME lookup
      // this middleware did. Two lookups is two chances to disagree.
      const route = lookupRoute(req.method, req.path)
      req.callerRoute = route
      res.setHeader(TIER_HEADER, identity.tier)
      // Usage attribution (#1447): counted at RESOLUTION, refusals included — a refused request
      // still consumed identity work, and an attribution series that only counts successes would
      // understate exactly the traffic an operator is trying to see.
      options.counters?.hitTier(identity.tier)

      if (!enforce) return next()

      // `/v1/member/*` runs its own verifier and answers its own error codes, including the
      // three-verdict split. A second minimum in front of it would produce two refusals for one
      // condition, and the outer one would be the less informative.
      if (!route || route.delegated) {
        // An UNLISTED path is deliberately NOT refused here, and this is a design decision rather
        // than an oversight. This middleware runs before route dispatch, so it cannot know whether
        // a path is mounted; refusing everything unlisted would turn every 404 into a 403 and hand
        // an unauthenticated prober a map of which paths exist. The guarantee that no MOUNTED route
        // is missing from the table comes from CI — routeTable.test.js enumerates the real app and
        // fails on any gap — not from a runtime refusal that cannot tell the two cases apart.
        return next()
      }

      if (satisfies(identity, route.minimumTier)) return next()

      // UNVERIFIABLE IS NOT A DENIAL. If a dependency was unreachable we do not know whether this
      // caller qualifies, and answering 403 would tell a member their credential is bad because our
      // RPC was slow. 503 says "ask again", which is the truth (FR-009).
      if (identity.verificationState === 'unverifiable') {
        throw new GatewayError(
          503,
          'auth_unverifiable',
          'your credential could not be checked right now; this is not a decision that it is invalid — try again shortly'
        )
      }

      const refusal = REFUSALS[route.minimumTier] || REFUSALS[TIERS.ADDRESS]
      const err = new GatewayError(403, refusal.code, refusal.reason)
      // Additive, and safe for an older client to ignore.
      err.required = { tier: route.minimumTier }
      throw err
    } catch (err) {
      if (err instanceof GatewayError) {
        const body = err.toBody()
        if (err.required) body.error.required = err.required
        return res.status(err.status).json(body)
      }

      // Resolution ITSELF failing is a bug in this layer (a verifier fault is contained by the
      // resolver and never reaches here). A bug must not take down the gateway — but it must also
      // not silently open a gated route.
      req.caller = { ...ANONYMOUS_IDENTITY, evidence: [], enforcement: 'degraded' }
      req.callerSubject = subjectFor(req.caller, req)
      res.setHeader(TIER_HEADER, req.caller.tier)
      options.counters?.hitTier(req.caller.tier)

      // Reads carry an anonymous minimum, so they keep serving — which is the whole reason the
      // ladder puts them there. A gated route, though, must NOT fall open just because the code
      // that decides who may use it crashed: signing with the platform's credentials is exactly
      // what an attacker would want a bug here to unlock. It answers 503, not 403, because we
      // genuinely do not know who is calling — the same reason `unverifiable` is retryable.
      if (enforce) {
        const route = lookupRoute(req.method, req.path)
        if (route && !route.delegated && route.minimumTier !== TIERS.ANONYMOUS) {
          return res.status(503).json({
            error: {
              code: 'auth_unverifiable',
              reason:
                'caller identity could not be determined right now; this is not a decision about your credential — try again shortly',
            },
          })
        }
      }
      return next()
    }
  }
}
