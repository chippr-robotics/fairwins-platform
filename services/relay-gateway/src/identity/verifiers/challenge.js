/**
 * Challenge verifier (spec 106 slice 2, #1444) — proof of HUMAN, and only that.
 *
 * Verifies a Cloudflare Turnstile token against siteverify and answers with the standard verifier
 * contract. What a passing challenge proves is "a real browser on a real device, recently" —
 * nothing about WHICH application sent the request (FR-005), and nothing about who is answerable
 * afterwards. It buys THROUGHPUT (the `human` tier's higher ceilings), never entry: no read
 * route requires it, so everything below shapes rate limits, not access.
 *
 * ── THE FOUR OUTCOMES, AND WHY EACH MAPS WHERE IT DOES ───────────────────────────────────────
 *
 *   no token presented        -> absent        most callers, legitimately
 *   verifier unconfigured     -> absent        an unconfigured bot-check must not deny anyone
 *   vendor says invalid       -> rejected      we asked, the answer was no
 *   vendor unreachable        -> unverifiable  an outage is not evidence about the caller
 *
 * `unverifiable` here never blocks anything on its own: reads sit at the anonymous minimum, so a
 * challenge-service outage costs a caller their tier UPGRADE — a lower rate ceiling — and never
 * access (FR-017). That is the property the whole read-tier design hangs on.
 *
 * ── SINGLE-USE TOKENS, AND THE TRAP THAT FOLLOWS ─────────────────────────────────────────────
 *
 * A Turnstile token verifies at the vendor ONCE; the second siteverify for the same token answers
 * `timeout-or-duplicate`. Two rules fall out:
 *
 *   CACHE THE VERDICT. A verified token is honoured for `ttlSec` from OUR verification, keyed by
 *   the token's digest, so one challenge serves a visitor's whole session (SC-003) instead of one
 *   request. Without the cache, the SECOND request carrying a perfectly good token would be
 *   REJECTED by the duplicate rule — the widget would have to re-run per request.
 *
 *   SINGLE-FLIGHT CONCURRENT VERIFIES. A page firing several requests at once presents the same
 *   fresh token in parallel. Verified independently, exactly one wins and the rest are branded
 *   duplicates — a racy 50/50 rejection of honest traffic. Concurrent verifies of one digest
 *   share one in-flight result instead.
 *
 * ── WHAT IS REMEMBERED, AND WHAT NEVER IS ────────────────────────────────────────────────────
 *
 * The cache holds SHA-256 digests and expiry times — never a raw token. The digest doubles as the
 * metering subject for the `human` tier (data-model §2): stable for the token's lifetime, useless
 * to replay, and safe in a quota key. Raw tokens and the shared secret never reach a log, an
 * error, or a cache key (FR-037).
 */
import crypto from 'node:crypto'
import { TIERS } from '../tiers.js'

export const KIND = 'challenge'
export const CHALLENGE_HEADER = 'X-FairWins-Challenge'

/**
 * Cloudflare's PUBLISHED test secrets. Legitimate in development; a MOCK IN A SHIPPED PATH in
 * production (constitution III) — the always-pass one turns the human tier into a stamp anyone
 * can print, silently. Boot refuses them outside development (see config validation / T014).
 */
export const TURNSTILE_TEST_SECRETS = Object.freeze([
  '1x0000000000000000000000000000000AA', // always passes
  '2x0000000000000000000000000000000AA', // always fails
  '3x0000000000000000000000000000000AA', // yields a token already spent
])

const MAX_CACHE_ENTRIES = 10_000

/**
 * @param {{secret: string|null, verifyUrl: string, ttlSec: number, timeoutMs: number}} cfg
 * @param {{now?: () => number, fetchImpl?: typeof fetch}} [deps] now() in ms
 */
export function createChallengeVerifier(cfg, { now = () => Date.now(), fetchImpl = fetch } = {}) {
  /** @type {Map<string, number>} token digest -> verified-until (ms) */
  const verified = new Map()
  /** @type {Map<string, Promise<object>>} digest -> in-flight verification */
  const inflight = new Map()

  const digestOf = (token) => crypto.createHash('sha256').update(token).digest('hex')

  function pruneIfNeeded() {
    if (verified.size <= MAX_CACHE_ENTRIES) return
    const t = now()
    for (const [key, until] of verified) {
      if (until <= t) verified.delete(key)
    }
    // Still over after dropping expired: shed oldest-inserted. Losing a cached verdict costs one
    // re-challenge, which is the correct failure direction for a memory bound.
    while (verified.size > MAX_CACHE_ENTRIES) {
      verified.delete(verified.keys().next().value)
    }
  }

  async function verifyAtVendor(token, digest) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
    try {
      const res = await fetchImpl(cfg.verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: cfg.secret, response: token }).toString(),
        signal: controller.signal,
      })
      if (!res.ok) {
        return { kind: KIND, outcome: 'unverifiable', tierIfAccepted: TIERS.HUMAN, detail: `siteverify answered ${res.status}` }
      }
      const body = await res.json()
      if (body && body.success === true) {
        verified.set(digest, now() + cfg.ttlSec * 1000)
        pruneIfNeeded()
        return { kind: KIND, outcome: 'accepted', tierIfAccepted: TIERS.HUMAN, subject: `chal:${digest}` }
      }
      // The vendor answered and said no. Error CODES are safe detail (a bounded vendor enum);
      // the token itself never is.
      const codes = Array.isArray(body?.['error-codes']) ? body['error-codes'].slice(0, 3).join(',') : 'invalid'
      return { kind: KIND, outcome: 'rejected', tierIfAccepted: TIERS.HUMAN, detail: codes }
    } catch {
      // Timeout or transport failure. An outage at the bot-check is not evidence about the caller.
      return { kind: KIND, outcome: 'unverifiable', tierIfAccepted: TIERS.HUMAN, detail: 'siteverify unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    kind: KIND,
    state: cfg.secret ? 'configured' : 'not-configured',
    async verify(req) {
      // An unconfigured bot-check ABSTAINS. Returning `rejected` here would deny every anonymous
      // caller on every deployment that never set the feature up.
      if (!cfg.secret) return { kind: KIND, outcome: 'absent', tierIfAccepted: TIERS.HUMAN }

      const token = typeof req.get === 'function' ? req.get(CHALLENGE_HEADER) : null
      if (!token || typeof token !== 'string' || token.length > 4096) {
        return { kind: KIND, outcome: 'absent', tierIfAccepted: TIERS.HUMAN }
      }

      const digest = digestOf(token)

      const until = verified.get(digest)
      if (until && until > now()) {
        // One challenge per visitor per lifetime (SC-003): the vendor would call this token a
        // duplicate, but WE verified it, recently, and that verdict is ours to honour.
        return { kind: KIND, outcome: 'accepted', tierIfAccepted: TIERS.HUMAN, subject: `chal:${digest}` }
      }
      if (until) verified.delete(digest)

      // Single-flight: parallel requests carrying the same fresh token must not race each other
      // into the vendor's duplicate rule.
      let pending = inflight.get(digest)
      if (!pending) {
        pending = verifyAtVendor(token, digest).finally(() => inflight.delete(digest))
        inflight.set(digest, pending)
      }
      return pending
    },
  }
}
