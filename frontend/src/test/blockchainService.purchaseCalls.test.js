import { describe, it, expect, vi, beforeEach } from 'vitest'

// Unit test for buildMembershipPurchaseCalls (spec 041, FR-016): the read-only helper that shapes the
// [approve, purchase] batch a passkey session submits through WalletContext.sendCalls — ONE ceremony,
// no separate on-chain approval. We stub the contract resolver and the MembershipManager / ERC20 reads
// so no real chain call happens.
//
// Spec 110: the reads go through the chain seam, so the seam is what is faked — and the fake is
// keyed by (chain, address), which the `new ethers.Contract(address, abi, …)` fake it replaces could
// only half do (it dispatched on the address and ignored the chain and the ABI entirely).
//
// ethers stays imported, UNMOCKED, as the calldata oracle: every `decodeFunctionData` below reads
// bytes this module encoded with viem. That is a live cross-library byte check over exactly the code
// this migration replaced, and it only means anything if the decoder is the real one.
const { resolverMock, stubs, reads } = vi.hoisted(() => ({
  resolverMock: vi.fn(),
  stubs: {},
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
      const stub = stubs[String(address).toLowerCase()]?.[functionName]
      if (!stub) throw new Error(`unexpected read: ${functionName} at ${address}`)
      return stub(...args)
    },
  }
})

import { buildMembershipPurchaseCalls, checkApprovalNeededForAddress, getRoleHash } from '../utils/blockchainService'
import { ethers } from 'ethers'

const MM_ADDR = '0x00c3ef4e02Ef00Ad6eE955dF5022A22F6ea73dae'
const TOKEN_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const ACCOUNT = '0x0000000000000000000000000000000000000001'
const ROLE = 'WAGER_PARTICIPANT'

const makeProvider = (chainId = 137) => ({
  getNetwork: async () => ({ chainId: BigInt(chainId) }),
  getCode: async () => '0x60fe', // non-empty → contract deployed
})

const realIface = new ethers.Interface([
  'function approve(address,uint256)',
  'function purchaseTier(bytes32,uint8)',
  'function purchaseTierWithTerms(bytes32,uint8,bytes32)',
  'function upgradeTier(bytes32,uint8)',
  'function extendMembership(bytes32)',
])

beforeEach(() => {
  reads.length = 0
  resolverMock.mockReset()
  resolverMock.mockReturnValue(MM_ADDR)
  stubs[MM_ADDR.toLowerCase()] = {
    paymentToken: vi.fn(async () => TOKEN_ADDR),
    getTierConfig: vi.fn(async (_role, tier) => ({ priceUSDC: BigInt(Number(tier)) * 10_000_000n })),
    getMembership: vi.fn(async () => ({ tier: 1 })),
  }
  stubs[TOKEN_ADDR.toLowerCase()] = {
    balanceOf: vi.fn(async () => 1_000_000_000n), // plenty
  }
})

describe('buildMembershipPurchaseCalls (passkey batch)', () => {
  it('builds [approve(price), purchaseTier] for a fresh purchase with the exact tier price', async () => {
    const { calls, price, membershipManager, paymentToken } = await buildMembershipPurchaseCalls(
      makeProvider(), ACCOUNT, ROLE, 2, 'purchase', null,
    )
    expect(price).toBe(20_000_000n)
    expect(membershipManager).toBe(MM_ADDR)
    expect(paymentToken).toBe(TOKEN_ADDR)
    expect(calls).toHaveLength(2)

    // Every read named the chain the provider reported, and the price came from the MANAGER while
    // the balance came from the TOKEN — the reads the batch's `approve` amount rests on.
    expect(reads).toEqual([
      { chainId: 137, address: MM_ADDR, functionName: 'paymentToken', args: [] },
      { chainId: 137, address: MM_ADDR, functionName: 'getTierConfig', args: [getRoleHash(ROLE), 2] },
      { chainId: 137, address: TOKEN_ADDR, functionName: 'balanceOf', args: [ACCOUNT] },
    ])

    // Leg 1: approve the membership manager for EXACTLY the price.
    expect(calls[0].target).toBe(TOKEN_ADDR)
    const approve = realIface.decodeFunctionData('approve', calls[0].data)
    expect(approve[0]).toBe(MM_ADDR)
    expect(approve[1]).toBe(20_000_000n)

    // Leg 2: purchaseTier(role, tier) on the membership manager (no terms → plain overload).
    expect(calls[1].target).toBe(MM_ADDR)
    const purchase = realIface.decodeFunctionData('purchaseTier', calls[1].data)
    expect(purchase[0]).toBe(getRoleHash(ROLE))
    expect(Number(purchase[1])).toBe(2)
  })

  it('uses the *WithTerms overload when an accepted terms hash is supplied', async () => {
    const bare = 'ab'.repeat(32)
    const { calls } = await buildMembershipPurchaseCalls(makeProvider(), ACCOUNT, ROLE, 1, 'purchase', bare)
    const decoded = realIface.decodeFunctionData('purchaseTierWithTerms', calls[1].data)
    expect(decoded[2]).toBe('0x' + bare)
  })

  it('encodes extendMembership(role) for the extend action', async () => {
    const { calls } = await buildMembershipPurchaseCalls(makeProvider(), ACCOUNT, ROLE, 2, 'extend', null)
    const decoded = realIface.decodeFunctionData('extendMembership', calls[1].data)
    expect(decoded[0]).toBe(getRoleHash(ROLE))
  })

  it('approves the upgrade delta (new tier price − current tier price)', async () => {
    const { calls, price } = await buildMembershipPurchaseCalls(makeProvider(), ACCOUNT, ROLE, 4, 'upgrade', null)
    // getTierConfig(role, 4) − getTierConfig(role, 1) = 40 − 10 USDC
    expect(price).toBe(30_000_000n)
    const approve = realIface.decodeFunctionData('approve', calls[0].data)
    expect(approve[1]).toBe(30_000_000n)
    const decoded = realIface.decodeFunctionData('upgradeTier', calls[1].data)
    expect(Number(decoded[1])).toBe(4)
  })

  it('throws with an actionable message when the balance is short of the price', async () => {
    stubs[TOKEN_ADDR.toLowerCase()].balanceOf = vi.fn(async () => 1n)
    await expect(
      buildMembershipPurchaseCalls(makeProvider(), ACCOUNT, ROLE, 2, 'purchase', null),
    ).rejects.toThrow(/insufficient usdc balance/i)
  })

  it('throws when no MembershipManager is configured on the chain', async () => {
    resolverMock.mockReturnValue(undefined)
    await expect(
      buildMembershipPurchaseCalls(makeProvider(), ACCOUNT, ROLE, 1, 'purchase', null),
    ).rejects.toThrow(/no membership contract/i)
  })

  it('throws on a missing provider or account', async () => {
    await expect(buildMembershipPurchaseCalls(null, ACCOUNT, ROLE, 1)).rejects.toThrow(/read provider/i)
    await expect(buildMembershipPurchaseCalls(makeProvider(), null, ROLE, 1)).rejects.toThrow(/account/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Spec 098 (FR-002/FR-015) — checkApprovalNeededForAddress: the address-based allowance
// pre-flight. Unlike checkApprovalNeeded it takes the ACTING address (no signer), so the read
// can never silently answer for the connected wallet.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('checkApprovalNeededForAddress (acting-account pre-flight)', () => {
  const allowanceCalls = []

  beforeEach(() => {
    allowanceCalls.length = 0
    stubs[TOKEN_ADDR.toLowerCase()].allowance = vi.fn(async (owner, spender) => {
      allowanceCalls.push([owner, spender])
      return 0n
    })
  })

  it('reads the allowance for the GIVEN address and reports approval needed when short', async () => {
    const needed = await checkApprovalNeededForAddress(ACCOUNT, ROLE, 20, 2, 'purchase', {
      provider: makeProvider(),
    })
    expect(needed).toBe(true)
    expect(allowanceCalls).toHaveLength(1)
    expect(allowanceCalls[0][0]).toBe(ACCOUNT)
    expect(allowanceCalls[0][1]).toBe(MM_ADDR)
  })

  it('reports NO approval needed when the allowance already covers the tier price (FR-015)', async () => {
    stubs[TOKEN_ADDR.toLowerCase()].allowance = vi.fn(async () => 1_000_000_000n)
    const needed = await checkApprovalNeededForAddress(ACCOUNT, ROLE, 20, 2, 'purchase', {
      provider: makeProvider(),
    })
    expect(needed).toBe(false)
  })

  it('prices an upgrade as the delta, using the ADDRESS to read the current membership', async () => {
    const membershipAsked = []
    stubs[MM_ADDR.toLowerCase()].getMembership = vi.fn(async (user) => {
      membershipAsked.push(user)
      return { tier: 1 }
    })
    // delta = 40 − 10 = 30 USDC; allowance 35 covers it.
    stubs[TOKEN_ADDR.toLowerCase()].allowance = vi.fn(async () => 35_000_000n)
    const needed = await checkApprovalNeededForAddress(ACCOUNT, ROLE, 30, 4, 'upgrade', {
      provider: makeProvider(),
    })
    expect(needed).toBe(false)
    expect(membershipAsked).toEqual([ACCOUNT])
  })

  it('is conservative: no address, unresolved contract, or a failing read all report approval needed', async () => {
    expect(await checkApprovalNeededForAddress(null, ROLE, 20, 2, 'purchase', { provider: makeProvider() })).toBe(true)

    resolverMock.mockReturnValue(undefined)
    expect(await checkApprovalNeededForAddress(ACCOUNT, ROLE, 20, 2, 'purchase', { provider: makeProvider() })).toBe(true)

    resolverMock.mockReturnValue(MM_ADDR)
    stubs[TOKEN_ADDR.toLowerCase()].allowance = vi.fn(async () => { throw new Error('rpc down') })
    expect(await checkApprovalNeededForAddress(ACCOUNT, ROLE, 20, 2, 'purchase', { provider: makeProvider() })).toBe(true)
  })
})
