/**
 * Caller-identity resolution (spec 106, T005).
 *
 * THE LOAD-BEARING TEST OF THE FEATURE is `an acceptance settles it`: a member holding a valid grant
 * must not be downgraded, or handed a 503, because an unrelated challenge service was unreachable.
 * Their credential was checked and it was good; another verifier's outage is not evidence about
 * them. Getting that precedence backwards produces a gateway that refuses paying members whenever a
 * bot-check provider has a bad afternoon, and it would look like a correct fail-closed design while
 * doing it.
 *
 * The second group keeps `rejected` and `unverifiable` apart. They are the two falsy outcomes a
 * boolean would have merged, and merging them is how "our RPC was slow" becomes "your signature is
 * forged" (FR-009).
 */
import { describe, it, expect } from 'vitest'
import { createResolver, subjectFor, satisfies, ANONYMOUS_IDENTITY } from '../../src/identity/resolve.js'
import { createAttestationVerifier } from '../../src/identity/verifiers/attestation.js'
import { TIERS } from '../../src/identity/tiers.js'

const REQ = { ip: '203.0.113.7' }

/** A verifier that answers however the test says, without any I/O. */
const stub = (kind, outcome, tierIfAccepted = TIERS.ANONYMOUS, subject = null, detail = null) => ({
  kind,
  verify: async () => ({ kind, outcome, tierIfAccepted, subject, detail }),
})

describe('resolve — precedence', () => {
  it('an ACCEPTANCE settles it, even when another verifier is unverifiable', async () => {
    // The single most important behaviour here. A valid grant + an unreachable challenge service
    // must be `verified` at `address`, NOT `unverifiable`, and must not be downgraded to anonymous.
    const resolve = createResolver([
      stub('challenge', 'unverifiable'),
      stub('grant', 'accepted', TIERS.ADDRESS, '0xabc'),
    ])
    const id = await resolve(REQ)
    expect(id.verificationState).toBe('verified')
    expect(id.tier).toBe(TIERS.ADDRESS)
    expect(id.subject).toBe('0xabc')
  })

  it('takes the HIGHEST accepted tier when several verifiers accept', async () => {
    const resolve = createResolver([
      stub('challenge', 'accepted', TIERS.HUMAN, 'tok-digest'),
      stub('grant', 'accepted', TIERS.MEMBER, '0xdef'),
    ])
    const id = await resolve(REQ)
    expect(id.tier).toBe(TIERS.MEMBER)
  })

  it('takes the subject belonging to the WINNING tier, not merely the first seen', async () => {
    // If a lower-tier subject leaked through, it would become the metering key for a higher-tier
    // caller — quietly metering a member against a challenge-token digest.
    const resolve = createResolver([
      stub('challenge', 'accepted', TIERS.HUMAN, 'tok-digest'),
      stub('grant', 'accepted', TIERS.MEMBER, '0xdef'),
    ])
    expect((await resolve(REQ)).subject).toBe('0xdef')
  })

  it('reports unverifiable ONLY when nothing was accepted', async () => {
    const resolve = createResolver([stub('challenge', 'unverifiable', TIERS.HUMAN, null, 'timeout')])
    const id = await resolve(REQ)
    expect(id.verificationState).toBe('unverifiable')
    expect(id.tier).toBe(TIERS.ANONYMOUS)
    expect(id.reason).toContain('challenge')
  })

  it('keeps a REJECTED credential distinct from an unverifiable one', async () => {
    // Both leave the caller at anonymous, but only one is a statement about the credential. The
    // route layer turns `unverifiable` into a retryable 503 and `rejected` into a denial, so the
    // distinction has to survive resolution.
    const resolve = createResolver([stub('grant', 'rejected', TIERS.ADDRESS, null, 'bad signature')])
    const id = await resolve(REQ)
    expect(id.verificationState).toBe('verified') // we DID verify — the answer was "no"
    expect(id.tier).toBe(TIERS.ANONYMOUS)
    expect(id.reason).toContain('bad signature')
  })

  it('treats a caller presenting nothing as a first-class anonymous outcome, not an error', async () => {
    const resolve = createResolver([stub('challenge', 'absent'), stub('grant', 'absent')])
    const id = await resolve(REQ)
    expect(id.verificationState).toBe('verified')
    expect(id.tier).toBe(TIERS.ANONYMOUS)
    expect(id.reason).toBeNull()
  })

  it('resolves anonymous when no verifiers are registered at all', async () => {
    const id = await createResolver([])(REQ)
    expect(id).toMatchObject({ tier: TIERS.ANONYMOUS, verificationState: 'verified' })
  })
})

describe('resolve — a broken verifier must not become a denial machine', () => {
  it('records a THROWING verifier as unverifiable, never as rejected', async () => {
    const resolve = createResolver([
      { kind: 'challenge', verify: async () => { throw new Error('boom') } },
    ])
    const id = await resolve(REQ)
    expect(id.verificationState).toBe('unverifiable')
    expect(id.evidence[0].outcome).toBe('unverifiable')
  })

  it('does not leak the thrown error message, which may carry upstream credential material', async () => {
    const secret = 'Bearer sk_live_do_not_log_me'
    const resolve = createResolver([
      { kind: 'challenge', verify: async () => { throw new Error(secret) } },
    ])
    const id = await resolve(REQ)
    expect(JSON.stringify(id)).not.toContain('sk_live')
  })

  it('lets a good verifier still win when another one throws', async () => {
    const resolve = createResolver([
      { kind: 'challenge', verify: async () => { throw new Error('boom') } },
      stub('grant', 'accepted', TIERS.ADDRESS, '0xabc'),
    ])
    expect((await resolve(REQ)).tier).toBe(TIERS.ADDRESS)
  })

  it('treats an unrecognised outcome as unverifiable rather than guessing', async () => {
    const resolve = createResolver([{ kind: 'weird', verify: async () => ({ outcome: 'maybe' }) }])
    expect((await resolve(REQ)).verificationState).toBe('unverifiable')
  })
})

describe('the attestation seam', () => {
  it('always abstains, so it can be registered without affecting any verdict', async () => {
    const withSeam = createResolver([
      createAttestationVerifier(),
      stub('grant', 'accepted', TIERS.ADDRESS, '0xabc'),
    ])
    const without = createResolver([stub('grant', 'accepted', TIERS.ADDRESS, '0xabc')])
    const a = await withSeam(REQ)
    const b = await without(REQ)
    expect(a.tier).toBe(b.tier)
    expect(a.verificationState).toBe(b.verificationState)
  })

  it('abstains rather than rejecting, so it never denies a caller who has no attestation', async () => {
    const id = await createResolver([createAttestationVerifier()])(REQ)
    expect(id.evidence[0].outcome).toBe('absent')
    expect(id.verificationState).toBe('verified')
  })

  it('declares itself not-built, which is a different fact from disabled', async () => {
    expect(createAttestationVerifier().state).toBe('not-built')
  })

  it('never lets a web caller reach the app tier', async () => {
    const resolve = createResolver([
      createAttestationVerifier(),
      stub('challenge', 'accepted', TIERS.HUMAN, 'tok'),
      stub('grant', 'accepted', TIERS.MEMBER, '0xabc'),
    ])
    expect((await resolve(REQ)).tier).not.toBe(TIERS.APP)
  })
})

describe('subjectFor — FR-011 metering key', () => {
  it('keys on the proven subject once anything has been proven', async () => {
    const id = await createResolver([stub('grant', 'accepted', TIERS.MEMBER, '0xabc')])(REQ)
    expect(subjectFor(id, REQ)).toBe('member:0xabc')
  })

  it('falls back to the network address ONLY at anonymous', () => {
    expect(subjectFor(ANONYMOUS_IDENTITY, REQ)).toBe('anonymous:ip:203.0.113.7')
  })

  it('namespaces by tier, so tiers cannot collide in one window', () => {
    // FR-012: exhausting the anonymous allowance must never deny an authenticated member.
    const a = subjectFor({ tier: TIERS.HUMAN, subject: '0xabc' }, REQ)
    const b = subjectFor({ tier: TIERS.MEMBER, subject: '0xabc' }, REQ)
    expect(a).not.toBe(b)
  })

  it('never returns a bare caller-supplied value', () => {
    // The defect being repaired: quotas keyed on an address written into the request path, which is
    // a name the caller chooses and can change per request.
    const key = subjectFor({ tier: TIERS.ADDRESS, subject: '0xabc' }, REQ)
    expect(key.startsWith(`${TIERS.ADDRESS}:`)).toBe(true)
  })
})

describe('satisfies', () => {
  it('admits an equal or higher tier and refuses a lower one', () => {
    expect(satisfies({ tier: TIERS.MEMBER }, TIERS.ADDRESS)).toBe(true)
    expect(satisfies({ tier: TIERS.ADDRESS }, TIERS.ADDRESS)).toBe(true)
    expect(satisfies({ tier: TIERS.HUMAN }, TIERS.ADDRESS)).toBe(false)
  })

  it('admits everyone to an anonymous minimum — reads never refuse for want of a tier', () => {
    expect(satisfies(ANONYMOUS_IDENTITY, TIERS.ANONYMOUS)).toBe(true)
  })
})
