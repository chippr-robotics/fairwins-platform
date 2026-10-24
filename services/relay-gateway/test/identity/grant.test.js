/**
 * Grant verifier (spec 106, T021 + T023).
 *
 * Two groups here, and both exist because of a specific way this could go wrong.
 *
 * REFACTOR SAFETY. `verifyGrantCredential` was extracted out of `authenticate`, which the member
 * API and the MCP server both depend on. The extraction must be behaviour-preserving, and the
 * member-API suite (101 tests) is the primary evidence for that. These tests add the other
 * direction: the extracted function on its own must produce the same verdicts, so a future change
 * cannot quietly loosen the shared core while the member-API tests still pass because they exercise
 * it through a stricter caller.
 *
 * THE REGRESSION THIS RUNG EXISTS TO PREVENT. `authenticate` refuses without an ACTIVE PAID
 * membership. If spec 106 had gated order signing, Bitcoin broadcast and marketplace writes on that
 * verifier as-is, a member with a wallet but no paid tier would have stopped being able to trade —
 * silently, and framed as a security improvement. `an account with no paid membership is ACCEPTED`
 * is the test that keeps that from coming back.
 */
import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { createGrantVerifier } from '../../src/identity/verifiers/grant.js'
import { verifyGrantCredential } from '../../src/memberApi/auth.js'
import { TIERS } from '../../src/identity/tiers.js'
import { testConfig, wallet, TEST_NOW } from '../helpers.js'
import { memberApiProvider, memberToken, ALL_SCOPES_V1 } from '../memberApiHelpers.js'

const noRevocations = { isRevoked: () => false }
const req = (authorization) => ({ get: (h) => (h.toLowerCase() === 'authorization' ? authorization : null) })

const CFG = testConfig({ MEMBER_API_ENABLED: 'true' })
const DEFAULTS = {
  revocations: noRevocations,
  clockSkewSec: CFG.memberApi.clockSkewSec,
  maxTtlDays: CFG.memberApi.maxTtlDays,
  now: () => TEST_NOW,
}

/** Membership stub with an explicit three-state answer. */
const membershipStub = (state, active = true) => ({
  read: async () => (state === 'throw' ? Promise.reject(new Error('rpc down')) : { state, active }),
})

describe('grant verifier — absence is not rejection', () => {
  it('abstains when no Authorization header is present', async () => {
    const v = createGrantVerifier({ ...DEFAULTS, referenceProvider: memberApiProvider() })
    expect((await v.verify(req(null))).outcome).toBe('absent')
  })

  it('abstains for a bearer token that is not ours, rather than rejecting it', async () => {
    // Another scheme's credential is somebody else's business. Rejecting it would refuse a caller
    // who was never claiming to be one of ours.
    const v = createGrantVerifier({ ...DEFAULTS, referenceProvider: memberApiProvider() })
    expect((await v.verify(req('Bearer github_pat_xxx'))).outcome).toBe('absent')
  })
})

describe('grant verifier — proof of control', () => {
  it('accepts a valid grant at the ADDRESS tier when membership is not consulted', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const v = createGrantVerifier({ ...DEFAULTS, referenceProvider: memberApiProvider(), membership: null })
    const out = await v.verify(req(`Bearer ${token}`))
    expect(out.outcome).toBe('accepted')
    expect(out.tierIfAccepted).toBe(TIERS.ADDRESS)
    expect(out.subject.toLowerCase()).toBe(wallet.address.toLowerCase())
  })

  it('upgrades to MEMBER when an active paid tier is readable', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const v = createGrantVerifier({
      ...DEFAULTS,
      referenceProvider: memberApiProvider(),
      membership: membershipStub('read', true),
    })
    expect((await v.verify(req(`Bearer ${token}`))).tierIfAccepted).toBe(TIERS.MEMBER)
  })

  it('ACCEPTS an account with NO paid membership, at the address tier', async () => {
    // The regression this rung exists to prevent. Gating trading on the member API's verifier
    // as-is would have stopped unpaid members from trading, framed as a security improvement.
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const v = createGrantVerifier({
      ...DEFAULTS,
      referenceProvider: memberApiProvider(),
      membership: membershipStub('read', false),
    })
    const out = await v.verify(req(`Bearer ${token}`))
    expect(out.outcome).toBe('accepted')
    expect(out.tierIfAccepted).toBe(TIERS.ADDRESS)
  })
})

describe('grant verifier — an unreadable membership never un-proves a signature', () => {
  it('stays ACCEPTED at address when the membership read is unreadable', async () => {
    // By this point the signature has been checked and passed. We know who is calling, and that
    // does not become uncertain because a second, independent read timed out. Reporting
    // `unverifiable` would hand a 503 to a caller we successfully verified, on routes that only
    // ever needed proof of control.
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const v = createGrantVerifier({
      ...DEFAULTS,
      referenceProvider: memberApiProvider(),
      membership: membershipStub('unreadable'),
    })
    const out = await v.verify(req(`Bearer ${token}`))
    expect(out.outcome).toBe('accepted')
    expect(out.tierIfAccepted).toBe(TIERS.ADDRESS)
  })

  it('stays ACCEPTED at address when the membership read throws outright', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const v = createGrantVerifier({
      ...DEFAULTS,
      referenceProvider: memberApiProvider(),
      membership: membershipStub('throw'),
    })
    expect((await v.verify(req(`Bearer ${token}`))).outcome).toBe('accepted')
  })
})

describe('grant verifier — unknown is not forged', () => {
  it('reports UNVERIFIABLE, not rejected, when the reference chain is unreachable', async () => {
    // A contract account (a passkey member) has no public key, so the ERC-1271 leg is a network
    // read. If it cannot be made, "invalid" would tell a member their own key is forged because
    // our RPC was slow.
    // The grant must NAME an account that ECDSA will not recover to, or the signature verifies
    // outright and the contract-account leg — the one that needs the chain — is never reached.
    const token = await memberToken({
      scopes: ALL_SCOPES_V1,
      signer: ethers.Wallet.createRandom(),
      account: wallet.address,
    })
    const v = createGrantVerifier({ ...DEFAULTS, referenceProvider: null })
    const out = await v.verify(req(`Bearer ${token}`))
    expect(out.outcome).toBe('unverifiable')
  })

  it('rejects a grant signed by somebody else', async () => {
    const other = ethers.Wallet.createRandom()
    const token = await memberToken({ scopes: ALL_SCOPES_V1, signer: other, account: wallet.address })
    const v = createGrantVerifier({ ...DEFAULTS, referenceProvider: memberApiProvider() })
    const out = await v.verify(req(`Bearer ${token}`))
    expect(out.outcome).toBe('rejected')
  })

  it('rejects an expired grant', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1, expiresAt: TEST_NOW - 10, issuedAt: TEST_NOW - 100 })
    const v = createGrantVerifier({ ...DEFAULTS, referenceProvider: memberApiProvider() })
    expect((await v.verify(req(`Bearer ${token}`))).outcome).toBe('rejected')
  })

  it('rejects a revoked grant', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const v = createGrantVerifier({
      ...DEFAULTS,
      referenceProvider: memberApiProvider(),
      revocations: { isRevoked: () => true },
    })
    expect((await v.verify(req(`Bearer ${token}`))).outcome).toBe('rejected')
  })

  it('never leaks a credential or an upstream message into `detail`', async () => {
    const other = ethers.Wallet.createRandom()
    const token = await memberToken({ scopes: ALL_SCOPES_V1, signer: other, account: wallet.address })
    const v = createGrantVerifier({ ...DEFAULTS, referenceProvider: memberApiProvider() })
    const out = await v.verify(req(`Bearer ${token}`))
    expect(out.detail).toBe('invalid_signature') // a code, never a body
    expect(JSON.stringify(out)).not.toContain(token)
  })
})

describe('verifyGrantCredential — the extracted core keeps its verdicts', () => {
  const base = {
    referenceProvider: memberApiProvider(),
    revocations: noRevocations,
    clockSkewSec: CFG.memberApi.clockSkewSec,
    maxTtlDays: CFG.memberApi.maxTtlDays,
    nowSec: TEST_NOW,
  }

  it('returns the parsed grant for a valid token', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const { grant } = await verifyGrantCredential({ ...base, authorization: `Bearer ${token}` })
    expect(grant.account.toLowerCase()).toBe(wallet.address.toLowerCase())
  })

  it('throws 401 token_expired rather than a generic failure', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1, expiresAt: TEST_NOW - 1, issuedAt: TEST_NOW - 100 })
    await expect(verifyGrantCredential({ ...base, authorization: `Bearer ${token}` }))
      .rejects.toMatchObject({ status: 401, code: 'token_expired' })
  })

  it('throws 503 auth_unverifiable — the status that keeps unknown from becoming forged', async () => {
    const token = await memberToken({
      scopes: ALL_SCOPES_V1,
      signer: ethers.Wallet.createRandom(),
      account: wallet.address,
    })
    await expect(
      verifyGrantCredential({ ...base, referenceProvider: null, authorization: `Bearer ${token}` })
    ).rejects.toMatchObject({ status: 503, code: 'auth_unverifiable' })
  })

  it('enforces the TTL cap', async () => {
    const tooLong = TEST_NOW + (CFG.memberApi.maxTtlDays + 5) * 86400
    const token = await memberToken({ scopes: ALL_SCOPES_V1, issuedAt: TEST_NOW, expiresAt: tooLong })
    await expect(verifyGrantCredential({ ...base, authorization: `Bearer ${token}` }))
      .rejects.toMatchObject({ status: 401, code: 'token_ttl_exceeded' })
  })

  it('does NOT read membership — that is the entire reason it was extracted', async () => {
    // If this ever starts touching membership, the address tier collapses back into the member
    // tier and trading silently requires a purchase again.
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    let touched = false
    const membership = { read: async () => { touched = true; return { state: 'read', active: false } } }
    await verifyGrantCredential({ ...base, authorization: `Bearer ${token}`, membership })
    expect(touched).toBe(false)
  })
})
