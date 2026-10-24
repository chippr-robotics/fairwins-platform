import { describe, it, expect, vi, beforeEach } from 'vitest'

// Focused unit test for resolveMembershipIntentParams (specs 035 + 036): the read-only helper that
// resolves the exact EIP-712 intent params (esp. the USDC `price` the contract pulls) for a gasless
// membership payment. We stub the contract resolver and the MembershipManager reads so no real
// chain call happens.
//
// Spec 110: the `vi.mock('ethers')` that stood here installed `function FakeContract() { return
// mmMock }` — it took NO arguments at all, so every read below was satisfied no matter which
// address, which ABI or which chain it was aimed at. The reads go through the chain seam now and
// each one is recorded with all three, which is what lets the first test assert that the price a
// member is about to authorise was read from the MembershipManager on the SIGNER'S chain.
const { resolverMock, mmMock, reads } = vi.hoisted(() => ({
  resolverMock: vi.fn(),
  mmMock: {},
  reads: [],
}))

vi.mock('../config/contracts', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getContractAddressForChain: resolverMock }
})

vi.mock('../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      reads.push({ chainId, address, functionName, args })
      const stub = mmMock[functionName]
      if (!stub) throw new Error(`unexpected read: ${functionName}`)
      return stub(...args)
    },
  }
})

import { resolveMembershipIntentParams, getRoleHash } from '../utils/blockchainService'

const MM_ADDR = '0x00c3ef4e02Ef00Ad6eE955dF5022A22F6ea73dae'
const ROLE = 'WAGER_PARTICIPANT'
// The bytes32 no-terms sentinel, frozen as a literal: it is a fact about the contract's argument,
// not about whichever library happens to spell it.
const ZERO_HASH = '0x' + '00'.repeat(32)

const makeSigner = (chainId = 137, address = '0x0000000000000000000000000000000000000001') => ({
  getAddress: async () => address,
  provider: { getNetwork: async () => ({ chainId: BigInt(chainId) }) },
})

describe('resolveMembershipIntentParams', () => {
  beforeEach(() => {
    reads.length = 0
    resolverMock.mockReset()
    resolverMock.mockReturnValue(MM_ADDR)
    // priceUSDC scales with the tier so upgrade deltas are checkable: tier N → N * 10 USDC (6 decimals).
    mmMock.getTierConfig = vi.fn(async (_role, tier) => ({ priceUSDC: BigInt(Number(tier)) * 10_000_000n }))
    mmMock.getMembership = vi.fn(async () => ({ tier: 1 }))
  })

  it('resolves purchase price from the target tier config', async () => {
    const res = await resolveMembershipIntentParams(makeSigner(), ROLE, 2, 'purchase', null)
    expect(res.roleHash).toBe(getRoleHash(ROLE))
    expect(res.validTier).toBe(2)
    expect(res.price).toBe(20_000_000n) // getTierConfig(role, 2).priceUSDC
    expect(res.acceptedTermsHash).toBe(ZERO_HASH)
    expect(mmMock.getTierConfig).toHaveBeenCalledWith(getRoleHash(ROLE), 2)
    // The price a member is about to authorise came from the MembershipManager, on the chain the
    // signer reports — neither of which the argument-less Contract fake could tell apart.
    expect(reads).toEqual([
      { chainId: 137, address: MM_ADDR, functionName: 'getTierConfig', args: [getRoleHash(ROLE), 2] },
    ])
  })

  it('resolves extend price from the passed (current) tier config', async () => {
    const res = await resolveMembershipIntentParams(makeSigner(), ROLE, 3, 'extend', null)
    expect(res.price).toBe(30_000_000n)
    expect(res.validTier).toBe(3)
    expect(mmMock.getMembership).not.toHaveBeenCalled() // extend never reads current membership
  })

  it('resolves upgrade price as the tier delta (new - current)', async () => {
    mmMock.getMembership = vi.fn(async () => ({ tier: 1 })) // current Bronze
    const res = await resolveMembershipIntentParams(makeSigner(), ROLE, 4, 'upgrade', null)
    // getTierConfig(role, 4) - getTierConfig(role, 1) = 40 - 10 USDC
    expect(res.price).toBe(30_000_000n)
    expect(mmMock.getMembership).toHaveBeenCalled()
  })

  it('clamps out-of-range tiers to Bronze (1) and reads the config for the clamped tier', async () => {
    const res = await resolveMembershipIntentParams(makeSigner(), ROLE, 9, 'purchase', null)
    expect(res.validTier).toBe(1)
    expect(res.price).toBe(10_000_000n)
    expect(mmMock.getTierConfig).toHaveBeenCalledWith(getRoleHash(ROLE), 1)
  })

  it('normalizes a bare 64-hex terms hash to a 0x-prefixed bytes32', async () => {
    const bare = 'ab'.repeat(32)
    const res = await resolveMembershipIntentParams(makeSigner(), ROLE, 1, 'purchase', bare)
    expect(res.acceptedTermsHash).toBe('0x' + bare)
  })

  it('passes through an already 0x-prefixed terms hash unchanged', async () => {
    const withPrefix = '0x' + 'cd'.repeat(32)
    const res = await resolveMembershipIntentParams(makeSigner(), ROLE, 1, 'purchase', withPrefix)
    expect(res.acceptedTermsHash).toBe(withPrefix)
  })

  it('uses ZeroHash for a malformed / empty terms hash', async () => {
    const res = await resolveMembershipIntentParams(makeSigner(), ROLE, 1, 'purchase', 'not-a-hash')
    expect(res.acceptedTermsHash).toBe(ZERO_HASH)
  })

  it('throws on a missing signer', async () => {
    await expect(resolveMembershipIntentParams(null, ROLE, 1, 'purchase', null)).rejects.toThrow(/wallet not connected/i)
  })

  it('throws on an unknown role', async () => {
    await expect(resolveMembershipIntentParams(makeSigner(), 'NOPE', 1, 'purchase', null)).rejects.toThrow(/unknown role/i)
  })

  it('throws when no MembershipManager is configured on the chain', async () => {
    resolverMock.mockReturnValue(undefined)
    await expect(resolveMembershipIntentParams(makeSigner(), ROLE, 1, 'purchase', null)).rejects.toThrow(/no membership contract/i)
  })
})
