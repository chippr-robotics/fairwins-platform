/**
 * Spec 104 — the resolver's contract.
 *
 * The refusing cases are the feature. A suite that asserts only "the owners include the key, so
 * we resolved" has not tested this module: what it exists to guarantee is a NEGATIVE — that an
 * address the chain did not confirm never reaches a session — and every regression this feature
 * prevents lives in one of the three non-`resolved` outcomes.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../config/networks', () => ({
  getCurrentChainId: vi.fn(() => 80002),
  getNetwork: vi.fn(() => ({
    chainId: 80002,
    rpcUrl: 'https://rpc.example',
    capabilities: { passkeyAccounts: true },
    passkey: { bundlerUrls: ['https://bundler.example'], sponsorPaymasterUrl: null },
  })),
  NETWORKS: { 80002: { chainId: 80002, rpcUrl: 'https://rpc.example' } },
}))
vi.mock('../../../config/contracts', () => ({
  getContractAddressForChain: vi.fn((key) => ({
    accountFactory: '0xFAC7000000000000000000000000000000000001',
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  })[key]),
}))

import {
  OUTCOMES,
  resolveAccounts,
  NONCE_SCAN_LIMIT,
  verifyAccountForKey,
  isResolved,
  ownerBytesForPublicKey,
} from '../accountLookup'
import { computeAccountAddress, publicKeyToOwnerBytes } from '../smartAccount'

const KEY = { x: '0x' + 'a'.repeat(64), y: '0x' + 'b'.repeat(64) }
const OTHER_KEY = { x: '0x' + 'c'.repeat(64), y: '0x' + 'd'.repeat(64) }
const OWNER = publicKeyToOwnerBytes(KEY)
const OTHER_OWNER = publicKeyToOwnerBytes(OTHER_KEY)
const ACCOUNT = '0x00000000000000000000000000000000000A11CE'
const CHAIN = 80002

/** A chain that answers with a fixed controller list. */
const chainWith = (controllers, { deployed = true } = {}) =>
  vi.fn().mockResolvedValue({ deployed, controllers })

describe('verifyAccountForKey', () => {
  it('resolves when the account currently lists the key, carrying the slot the CHAIN reported', async () => {
    // Index 3, not 0 — an account that gained controllers does not put this key first, and a
    // hardcoded 0 breaks every signature it makes (spec 045 FR-009).
    const readControllers = chainWith([
      { index: 0n, ownerBytes: OTHER_OWNER, kind: 'passkey' },
      { index: 3n, ownerBytes: OWNER, kind: 'passkey' },
    ])
    const out = await verifyAccountForKey({
      ownerBytes: OWNER, address: ACCOUNT, chainId: CHAIN, deps: { readControllers },
    })
    expect(out.outcome).toBe(OUTCOMES.RESOLVED)
    expect(out.accounts).toEqual([{ address: ACCOUNT, ownerIndex: 3, chainId: CHAIN }])
    expect(isResolved(out)).toBe(true)
  })

  it('compares owner bytes case-insensitively — a checksum difference is not a different key', async () => {
    const readControllers = chainWith([{ index: 0n, ownerBytes: OWNER.toUpperCase().replace('0X', '0x'), kind: 'passkey' }])
    const out = await verifyAccountForKey({
      ownerBytes: OWNER.toLowerCase(), address: ACCOUNT, chainId: CHAIN, deps: { readControllers },
    })
    expect(out.outcome).toBe(OUTCOMES.RESOLVED)
  })

  it('refuses a DEPLOYED account whose owners do not include the key, and says which refusal it is', async () => {
    const readControllers = chainWith([{ index: 0n, ownerBytes: OTHER_OWNER, kind: 'passkey' }])
    const out = await verifyAccountForKey({
      ownerBytes: OWNER, address: ACCOUNT, chainId: CHAIN, deps: { readControllers },
    })
    expect(out.outcome).toBe(OUTCOMES.NOT_CONTROLLER)
    expect(out.address).toBe(ACCOUNT)
    expect(out.reason).toMatch(/not one of its owners/i)
  })

  it('refuses an address with NO CODE with a different reason — a typo and a rotated-off key need different next steps', async () => {
    const readControllers = chainWith([], { deployed: false })
    const out = await verifyAccountForKey({
      ownerBytes: OWNER, address: ACCOUNT, chainId: CHAIN, deps: { readControllers },
    })
    expect(out.outcome).toBe(OUTCOMES.NOT_CONTROLLER)
    expect(out.reason).toMatch(/no account is deployed/i)
    expect(out.reason).not.toMatch(/not one of its owners/i)
  })

  it('a key that was ROTATED OFF does not resolve — verification is against the current set, not history', async () => {
    // The slot it used to occupy now reads as removed; the account is healthy and has another owner.
    const readControllers = chainWith([{ index: 1n, ownerBytes: OTHER_OWNER, kind: 'passkey' }])
    const out = await verifyAccountForKey({
      ownerBytes: OWNER, address: ACCOUNT, chainId: CHAIN, deps: { readControllers },
    })
    expect(out.outcome).not.toBe(OUTCOMES.RESOLVED)
  })

  it('an unreadable chain is UNVERIFIED and carries NO address — it is not evidence of absence', async () => {
    const readControllers = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const out = await verifyAccountForKey({
      ownerBytes: OWNER, address: ACCOUNT, chainId: CHAIN, deps: { readControllers },
    })
    expect(out.outcome).toBe(OUTCOMES.UNVERIFIED)
    expect(out).not.toHaveProperty('address')
    expect(out).not.toHaveProperty('accounts')
    expect(out.reason).toMatch(/does not mean you have no account/i)
  })

  it('reads STRICTLY, so a failed getCode reaches unverified instead of posing as "not deployed"', async () => {
    // The conflation this feature prevents, one layer below where the resolver could see it:
    // readControllers' default swallows a failed getCode and answers `deployed: false`, which is
    // indistinguishable here from a genuinely empty address. Passing `strict` is what keeps an
    // unreachable chain reportable as unreachable, so this asserts the flag is actually sent.
    const readControllers = vi.fn(async ({ strict }) => {
      if (strict) throw new Error('HTTP 503')
      return { deployed: false, controllers: [] } // what the non-strict default would have said
    })
    const out = await verifyAccountForKey({
      ownerBytes: OWNER, address: ACCOUNT, chainId: CHAIN, deps: { readControllers },
    })
    expect(readControllers).toHaveBeenCalledWith(expect.objectContaining({ strict: true }))
    expect(out.outcome).toBe(OUTCOMES.UNVERIFIED)
    expect(out.outcome).not.toBe(OUTCOMES.NOT_CONTROLLER)
  })

  it('a chain that never answers expires into UNVERIFIED rather than hanging', async () => {
    // The direct lesson of v1.16.1: an unbounded wait on an external system is how a sign-in
    // becomes a lockout. A never-settling promise, not a rejecting one — a platform that never
    // answered may never answer an abort either.
    const readControllers = vi.fn(() => new Promise(() => {}))
    const out = await verifyAccountForKey({
      ownerBytes: OWNER, address: ACCOUNT, chainId: CHAIN, deadlineMs: 10, deps: { readControllers },
    })
    expect(out.outcome).toBe(OUTCOMES.UNVERIFIED)
    expect(out.reason).toMatch(/did not answer in time/i)
  })
})

describe('resolveAccounts', () => {
  /**
   * A chain that lists OWNER on exactly the addresses named, and answers "nothing deployed" for
   * every other address it is asked about.
   *
   * Written as a lookup rather than an assertion inside the mock on purpose. Asserting
   * `expect(address).toBe(expected)` in here reads strict and is not: leg A asks about several
   * candidates, the throw from the non-matching ones lands in `verifyAccountForKey`'s own catch,
   * and the test goes green having proved far less than it claims (spec 094's assertion-depth
   * hazard, found when leg A landed).
   */
  const chainListing = (owned) =>
    vi.fn(async ({ accountAddress }) =>
      owned.includes(accountAddress)
        ? { deployed: true, controllers: [{ index: 0n, ownerBytes: OWNER, kind: 'passkey' }] }
        : { deployed: false, controllers: [] }
    )

  const at = (nonce) => computeAccountAddress({ ownersBytes: [OWNER], nonce: BigInt(nonce), chainId: CHAIN })

  it('resolves the derived account when the chain confirms the key owns it', async () => {
    const readControllers = chainListing([at(0)])
    const out = await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    expect(out.outcome).toBe(OUTCOMES.RESOLVED)
    expect(out.accounts).toHaveLength(1)
    expect(out.accounts[0].address).toBe(at(0))
  })

  it('finds an account created at a NON-ZERO nonce — the Release 1 blind spot (T-103)', async () => {
    // A member whose first creation attempt reverted and who retried holds an account at nonce 1.
    // Release 1 checked nonce 0 only and told them `none-found`, which is a search limit reported
    // as a fact about their account.
    const readControllers = chainListing([at(3)])
    const out = await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    expect(out.outcome).toBe(OUTCOMES.RESOLVED)
    expect(out.accounts).toHaveLength(1)
    expect(out.accounts[0].address).toBe(at(3))
    expect(out.accounts[0].nonce).toBe(3)
  })

  it('returns EVERY verified account and picks none of them (FR-007)', async () => {
    const readControllers = chainListing([at(0), at(2)])
    const out = await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    expect(out.outcome).toBe(OUTCOMES.RESOLVED)
    expect(out.accounts.map((a) => a.address)).toEqual([at(0), at(2)])
    // Choosing for the member would strand whatever is in the other account, silently.
    expect(out).not.toHaveProperty('chosen')
    expect(out).not.toHaveProperty('preferred')
  })

  it('carries the real owner index the chain reported, never a hardcoded 0 (spec 045 FR-009)', async () => {
    const readControllers = vi.fn(async ({ accountAddress }) =>
      accountAddress === at(0)
        ? { deployed: true, controllers: [
            { index: 0n, ownerBytes: OTHER_OWNER, kind: 'eoa' },
            { index: 4n, ownerBytes: OWNER, kind: 'passkey' },
          ] }
        : { deployed: false, controllers: [] }
    )
    const out = await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    expect(out.accounts[0].ownerIndex).toBe(4)
  })

  it('a search that could not finish is unverified, even when the candidates it DID read were absent', async () => {
    // The rule leg A is most likely to break: seven clean absences plus one unreadable candidate
    // is not an absence. Reporting `none-found` here would tell a member with a perfectly good
    // account that they have none, on the strength of one RPC that did not answer.
    let call = 0
    const readControllers = vi.fn(async () => {
      call += 1
      if (call === 2) throw new Error('ECONNRESET')
      return { deployed: false, controllers: [] }
    })
    const out = await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    expect(out.outcome).toBe(OUTCOMES.UNVERIFIED)
    expect(out.outcome).not.toBe(OUTCOMES.NONE_FOUND)
  })

  it('checks every nonce in the range, and the range is the documented one', async () => {
    const readControllers = chainListing([])
    await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    expect(readControllers).toHaveBeenCalledTimes(NONCE_SCAN_LIMIT)
    const asked = readControllers.mock.calls.map((c) => c[0].accountAddress)
    // Distinct addresses: a salt that ignored the nonce would collapse the search to one candidate
    // while every count above still passed.
    expect(new Set(asked).size).toBe(NONCE_SCAN_LIMIT)
    expect(asked[0]).toBe(at(0))
  })

  it('honours a narrowed nonce range', async () => {
    const readControllers = chainListing([])
    await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, nonceLimit: 3, deps: { readControllers } })
    expect(readControllers).toHaveBeenCalledTimes(3)
  })

  it('an UNDEPLOYED derived address is none-found — the address never leaves the resolver', async () => {
    // THE REGRESSION THIS FEATURE EXISTS FOR. The old code returned this address, which signed a
    // member who had lost their device into a brand-new empty account with nothing said.
    const readControllers = chainWith([], { deployed: false })
    const out = await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    expect(out.outcome).toBe(OUTCOMES.NONE_FOUND)
    expect(out).not.toHaveProperty('address')
    expect(out).not.toHaveProperty('accounts')
    expect(JSON.stringify(out)).not.toContain(
      computeAccountAddress({ ownersBytes: [OWNER], chainId: CHAIN }).slice(2, 12)
    )
  })

  it("none-found says the search cannot see keys added after creation, rather than implying no account exists", async () => {
    const out = await resolveAccounts({
      ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers: chainWith([], { deployed: false }) },
    })
    expect(out.reason).toMatch(/added to an existing account/i)
  })

  it('does not report none-found when the chain could not be read', async () => {
    const readControllers = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const out = await resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    expect(out.outcome).toBe(OUTCOMES.UNVERIFIED)
  })

  it('never throws for a chain condition', async () => {
    const readControllers = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(
      resolveAccounts({ ownerBytes: OWNER, chainId: CHAIN, deps: { readControllers } })
    ).resolves.toBeDefined()
  })
})

describe('isResolved', () => {
  it('is false for every outcome that carries no account, including an empty resolved list', () => {
    expect(isResolved({ outcome: OUTCOMES.RESOLVED, accounts: [] })).toBe(false)
    expect(isResolved({ outcome: OUTCOMES.NONE_FOUND, reason: 'x' })).toBe(false)
    expect(isResolved({ outcome: OUTCOMES.UNVERIFIED, reason: 'x' })).toBe(false)
    expect(isResolved(undefined)).toBe(false)
  })
})

describe('ownerBytesForPublicKey', () => {
  it('lowercases, so a comparison never fails on case alone', () => {
    expect(ownerBytesForPublicKey(KEY)).toBe(publicKeyToOwnerBytes(KEY).toLowerCase())
  })
})
