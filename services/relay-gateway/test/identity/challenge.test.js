/**
 * Challenge verifier (spec 106 slice 2, #1444 / T013).
 *
 * The tests that matter most, in order:
 *
 *   1. AN OUTAGE AT THE BOT-CHECK NEVER COSTS ACCESS. `unverifiable`, folded through the
 *      resolver's precedence, leaves reads serving at anonymous — a challenge outage costs a
 *      caller their tier UPGRADE, not their reads (FR-017).
 *
 *   2. ONE CHALLENGE PER VISITOR PER LIFETIME (SC-003). Turnstile tokens are SINGLE-USE at the
 *      vendor — the second siteverify answers `timeout-or-duplicate`. Without the verdict cache,
 *      the second request carrying a perfectly good token gets REJECTED and the widget re-runs
 *      per request. The cache test asserts the vendor is asked exactly once.
 *
 *   3. PARALLEL REQUESTS WITH ONE FRESH TOKEN MUST NOT RACE. Verified independently, exactly one
 *      wins and the rest are branded duplicates — a 50/50 rejection of honest traffic. The
 *      single-flight test drives three concurrent verifies through one vendor call.
 *
 *   4. THE PUBLISHED TEST SECRETS ARE REFUSED IN PRODUCTION (T014). The always-pass secret turns
 *      the human tier into a stamp anyone can print, invisibly. Boot throws; a warning would be
 *      a production incident someone reads later.
 */
import { describe, it, expect, vi } from 'vitest'
import { createChallengeVerifier, CHALLENGE_HEADER, TURNSTILE_TEST_SECRETS } from '../../src/identity/verifiers/challenge.js'
import { loadConfig } from '../../src/config/index.js'
import { TIERS } from '../../src/identity/tiers.js'
import { testConfig } from '../helpers.js'

const CFG = { secret: 's3cret', verifyUrl: 'https://challenge.example/siteverify', ttlSec: 900, timeoutMs: 1000 }
const req = (token) => ({ get: (h) => (h === CHALLENGE_HEADER ? token : null) })

const vendor = (answer) => {
  const impl = vi.fn(async () => {
    if (typeof answer === 'function') return answer()
    return { ok: true, status: 200, json: async () => answer }
  })
  return impl
}

describe('challenge verifier — the four outcomes', () => {
  it('abstains with no token — most callers, legitimately', async () => {
    const v = createChallengeVerifier(CFG, { fetchImpl: vendor({ success: true }) })
    expect((await v.verify(req(null))).outcome).toBe('absent')
  })

  it('abstains when unconfigured — an unconfigured bot-check must not deny anyone', async () => {
    const impl = vendor({ success: true })
    const v = createChallengeVerifier({ ...CFG, secret: null }, { fetchImpl: impl })
    expect((await v.verify(req('tok'))).outcome).toBe('absent')
    expect(impl).not.toHaveBeenCalled()
    expect(v.state).toBe('not-configured')
  })

  it('accepts a vendor-verified token at the HUMAN tier, with a digest subject', async () => {
    const v = createChallengeVerifier(CFG, { fetchImpl: vendor({ success: true }) })
    const out = await v.verify(req('tok-abc'))
    expect(out.outcome).toBe('accepted')
    expect(out.tierIfAccepted).toBe(TIERS.HUMAN)
    expect(out.subject).toMatch(/^chal:[0-9a-f]{64}$/)
    expect(out.subject).not.toContain('tok-abc') // the raw token never becomes a metering key
  })

  it('rejects what the vendor rejects, carrying only the bounded error codes', async () => {
    const v = createChallengeVerifier(CFG, {
      fetchImpl: vendor({ success: false, 'error-codes': ['invalid-input-response'] }),
    })
    const out = await v.verify(req('tok-bad'))
    expect(out.outcome).toBe('rejected')
    expect(out.detail).toBe('invalid-input-response')
    expect(JSON.stringify(out)).not.toContain('tok-bad')
  })

  it('reports UNVERIFIABLE when the vendor is unreachable — an outage is not evidence', async () => {
    const v = createChallengeVerifier(CFG, { fetchImpl: vendor(() => { throw new Error('down') }) })
    expect((await v.verify(req('tok'))).outcome).toBe('unverifiable')
  })

  it('reports UNVERIFIABLE on a vendor 5xx rather than guessing either way', async () => {
    const v = createChallengeVerifier(CFG, {
      fetchImpl: vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })),
    })
    expect((await v.verify(req('tok'))).outcome).toBe('unverifiable')
  })
})

describe('challenge verifier — one challenge per visitor per lifetime (SC-003)', () => {
  it('asks the vendor ONCE and honours the verdict for the TTL', async () => {
    // The vendor would call the second verify a duplicate; the cache is what makes a single
    // challenge serve the whole session instead of one request.
    let t = 1_000_000
    const impl = vendor({ success: true })
    const v = createChallengeVerifier(CFG, { fetchImpl: impl, now: () => t })
    expect((await v.verify(req('tok'))).outcome).toBe('accepted')
    t += 5 * 60_000
    expect((await v.verify(req('tok'))).outcome).toBe('accepted')
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('expires the verdict at the TTL and asks again', async () => {
    let t = 1_000_000
    const impl = vendor({ success: true })
    const v = createChallengeVerifier(CFG, { fetchImpl: impl, now: () => t })
    await v.verify(req('tok'))
    t += CFG.ttlSec * 1000 + 1
    await v.verify(req('tok'))
    expect(impl).toHaveBeenCalledTimes(2)
  })

  it('single-flights parallel verifies of one fresh token — no self-inflicted duplicates', async () => {
    // A page firing several requests at once presents the same token in parallel. Verified
    // independently, exactly one would win and the rest get branded duplicates by the vendor's
    // single-use rule — a racy rejection of honest traffic.
    let resolveVendor
    const impl = vi.fn(() => new Promise((r) => { resolveVendor = r }))
    const v = createChallengeVerifier(CFG, { fetchImpl: impl })
    const a = v.verify(req('tok'))
    const b = v.verify(req('tok'))
    const c = v.verify(req('tok'))
    resolveVendor({ ok: true, status: 200, json: async () => ({ success: true }) })
    const outs = await Promise.all([a, b, c])
    expect(impl).toHaveBeenCalledTimes(1)
    for (const out of outs) expect(out.outcome).toBe('accepted')
  })
})

describe('challenge verifier — nothing secret leaks (FR-037)', () => {
  it('sends the secret only to the vendor and never surfaces it in any outcome', async () => {
    const impl = vendor({ success: false, 'error-codes': ['bad'] })
    const v = createChallengeVerifier(CFG, { fetchImpl: impl })
    const out = await v.verify(req('tok'))
    expect(JSON.stringify(out)).not.toContain('s3cret')
    // …and the vendor call itself did carry it, form-encoded, as the API requires.
    const [, init] = impl.mock.calls[0]
    expect(init.body).toContain('secret=s3cret')
  })
})

describe('the boot gate on published test secrets (T014)', () => {
  const PROD_ENV = { NODE_ENV: 'production', ORIGIN_AUTH_SECRET: 'x' }

  it('refuses to BOOT in production with the always-pass test secret', () => {
    expect(() =>
      loadConfig({ ...process.env, ...PROD_ENV, CHALLENGE_SECRET: TURNSTILE_TEST_SECRETS[0] })
    ).toThrow(/test secret/i)
  })

  it('refuses every published test secret, not only the always-pass one', () => {
    for (const secret of TURNSTILE_TEST_SECRETS) {
      expect(() => loadConfig({ ...process.env, ...PROD_ENV, CHALLENGE_SECRET: secret })).toThrow()
    }
  })

  it('allows the test secrets outside production — they are the right tool in development', () => {
    const config = testConfig({ CHALLENGE_SECRET: TURNSTILE_TEST_SECRETS[0] })
    expect(config.identity.challenge.secret).toBe(TURNSTILE_TEST_SECRETS[0])
  })

  it('allows a real secret in production', () => {
    const config = loadConfig({ ...process.env, ...PROD_ENV, CHALLENGE_SECRET: '0xreal-secret-value' })
    expect(config.identity.challenge.secret).toBe('0xreal-secret-value')
  })
})
