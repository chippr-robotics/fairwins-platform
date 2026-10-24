/**
 * Grant verifier (spec 106, FR-003) — proof of control, and separately proof of membership.
 *
 * Wraps the EXTRACTED credential core from `memberApi/auth.js` rather than reimplementing it. A
 * second signature path would be exactly the drift this repo's type-parity gates exist to prevent,
 * and the three-verdict rule is too easy to get subtly wrong twice.
 *
 * ── THE ONE SUBTLETY THAT MATTERS ────────────────────────────────────────────────────────────
 *
 * An unreadable membership does NOT make this verifier unverifiable.
 *
 * By the time membership is read, the signature has already been checked and passed. We KNOW who is
 * calling — that fact is established and does not become uncertain because a second, independent
 * read timed out. So the verifier accepts at `address` and simply does not offer the `member`
 * upgrade. Reporting `unverifiable` instead would hand a 503 to a caller whose credential we
 * successfully verified, on a route that only ever needed proof of control — turning an unrelated
 * RPC hiccup into a refusal for the routes this feature exists to protect.
 *
 * This is the same principle as the resolver's precedence rule, one level down: evidence that was
 * obtained stays obtained.
 *
 * ── MAPPING ──────────────────────────────────────────────────────────────────────────────────
 *
 *   no Authorization header            -> absent        (not a rejection; most callers have none)
 *   signature verified                 -> accepted @ address
 *     ...and membership active         -> accepted @ member
 *     ...and membership unreadable     -> accepted @ address   (see above)
 *   signature invalid / expired / revoked -> rejected
 *   reference chain unreachable        -> unverifiable  (401 would say "forged" and be wrong)
 *
 * A contract account (a passkey member) has no public key, so ECDSA recovery does not produce their
 * address and the ERC-1271 leg is a network read. If that read cannot be made the answer is
 * UNKNOWN — never "invalid".
 */

import { verifyGrantCredential } from '../../memberApi/auth.js'
import { TIERS } from '../tiers.js'

export const KIND = 'grant'

/** The scheme this verifier understands. Anything else is somebody else's credential. */
const TOKEN_PREFIX = 'fw1.'

function bearerToken(req) {
  const raw = typeof req.get === 'function' ? req.get('authorization') : null
  if (!raw) return null
  const value = String(raw).trim()
  const token = value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : value
  return token.startsWith(TOKEN_PREFIX) ? value : null
}

/**
 * @param {object} deps
 * @param {object|null} deps.referenceProvider  provider for the membership reference chain
 * @param {{isRevoked: Function}} deps.revocations
 * @param {{read: Function}|null} deps.membership  omit to disable the `member` upgrade entirely
 * @param {number} deps.clockSkewSec
 * @param {number} deps.maxTtlDays
 * @param {() => number} [deps.now] unix seconds
 */
export function createGrantVerifier({
  referenceProvider,
  revocations,
  membership = null,
  clockSkewSec,
  maxTtlDays,
  now = () => Math.floor(Date.now() / 1000),
}) {
  return {
    kind: KIND,
    state: 'configured',
    async verify(req) {
      const authorization = bearerToken(req)
      // No credential presented is the common case and is NOT a rejection — read routes are open
      // and most callers legitimately carry nothing.
      if (!authorization) {
        return { kind: KIND, outcome: 'absent', tierIfAccepted: TIERS.ADDRESS }
      }

      let grant
      try {
        ;({ grant } = await verifyGrantCredential({
          authorization,
          referenceProvider,
          revocations,
          clockSkewSec,
          maxTtlDays,
          nowSec: now(),
        }))
      } catch (err) {
        // The extracted core throws GatewayError with the status that carries the meaning. 503 is
        // the "we could not check" family (auth_unverifiable); everything else is a real refusal.
        // `detail` carries the CODE, never the message body, so nothing upstream can leak here.
        if (err && err.status === 503) {
          return {
            kind: KIND,
            outcome: 'unverifiable',
            tierIfAccepted: TIERS.ADDRESS,
            detail: err.code || 'auth_unverifiable',
          }
        }
        return {
          kind: KIND,
          outcome: 'rejected',
          tierIfAccepted: TIERS.ADDRESS,
          detail: (err && err.code) || 'credential_rejected',
        }
      }

      const account = grant.account
      // Control is established from here on. Nothing below may reduce that.
      if (!membership) {
        return { kind: KIND, outcome: 'accepted', tierIfAccepted: TIERS.ADDRESS, subject: account }
      }

      try {
        const m = await membership.read(account)
        if (m && m.state === 'read' && m.active) {
          return { kind: KIND, outcome: 'accepted', tierIfAccepted: TIERS.MEMBER, subject: account }
        }
      } catch {
        // Deliberately swallowed. An unreadable membership is not evidence about the signature we
        // already verified, and it must not downgrade or refuse a caller whose control is proven.
      }
      return { kind: KIND, outcome: 'accepted', tierIfAccepted: TIERS.ADDRESS, subject: account }
    },
  }
}
