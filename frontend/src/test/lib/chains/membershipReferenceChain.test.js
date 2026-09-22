/**
 * Spec 071 US1 (T032–T034) — membership resolves on the REFERENCE chain, and an unreadable
 * reference chain is UNKNOWN rather than "no membership".
 *
 * The live defect: membership exists in exactly one place per cohort (Polygon on mainnet), so
 * reading it wherever the wallet pointed reported every member on Ethereum / Optimism / Base /
 * Arbitrum / ETC as unentitled. They have a membership; the lookup was aimed at chains it was
 * never kept on.
 *
 * The second half is subtler and is what T029 fixed: a failed read used to return exactly what a
 * genuine "no membership" returns, so a member whose RPC blipped was told they owned nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const m = vi.hoisted(() => ({ askedOn: [], constructedAt: [], hasActiveRole: null, getActiveTier: null }))

/** A per-chain MembershipManager address that is a REAL, encodable address: `mmFor(137)` ≠ `mmFor(63)`. */
const mmFor = (chainId) => '0x' + Number(chainId).toString(16).padStart(40, '0')

vi.mock('../../../config/contracts', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    // Every cohort chain "has" a MembershipManager at a chain-distinctive address, so the address
    // the code reads against proves which chain the ADDRESS came from — and, since spec 110, the
    // seam records the chain the READ was made on as well, which is the thing that actually
    // decides where the answer comes from. The old fixture spelled these `0xmm${chainId}`, which
    // is not an address at all: it survived only because the `new ethers.Contract(address, …)`
    // fake it fed took the string and never used it for anything.
    getContractAddressForChain: (name, chainId) =>
      name === 'membershipManager' ? mmFor(chainId) : '',
    getContractAddress: () => '',
  }
})

vi.mock('../../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      m.askedOn.push(Number(chainId))
      m.constructedAt.push(String(address))
      if (functionName === 'hasActiveRole') return m.hasActiveRole(...args)
      if (functionName === 'getActiveTier') return m.getActiveTier(...args)
      return undefined
    },
  }
})

import { hasRoleOnChain, getUserTierOnChain } from '../../../utils/blockchainService'
import { membershipChainId, cohortChainIds } from '../../../config/networks'

const USER = '0x0000000000000000000000000000000000000001'
const REF = membershipChainId()
const NOT_REF = cohortChainIds().find((id) => Number(id) !== Number(REF))

beforeEach(() => {
  m.askedOn = []
  m.constructedAt = []
  m.hasActiveRole = () => Promise.resolve(true)
  m.getActiveTier = () => Promise.resolve(3)
  vi.stubEnv('VITE_SKIP_BLOCKCHAIN_CALLS', 'false')
})
afterEach(() => vi.unstubAllEnvs())

describe('membership resolves on the reference chain, whatever the wallet says (FR-003)', () => {
  it('reads the reference chain even when told to read another cohort chain', async () => {
    expect(NOT_REF).toBeDefined()
    const held = await hasRoleOnChain(USER, 'WAGER_PARTICIPANT', NOT_REF)

    expect(held).toBe(true)
    // Both halves, because they are different facts: the address came from the reference chain's
    // entry, and the read was MADE on the reference chain. Before the seam only the first was
    // observable, and a read aimed at the right address on the wrong chain would have passed.
    expect(m.constructedAt).toContain(mmFor(REF))
    expect(m.constructedAt).not.toContain(mmFor(NOT_REF))
    expect(m.askedOn).toEqual([Number(REF)])
  })

  it('gives the same answer from every cohort chain — SC-001', async () => {
    for (const chainId of cohortChainIds()) {
      m.constructedAt = []
      m.askedOn = []
      const held = await hasRoleOnChain(USER, 'WAGER_PARTICIPANT', chainId)
      expect(held).toBe(true)
      expect(m.constructedAt).toEqual([mmFor(REF)])
      expect(m.askedOn).toEqual([Number(REF)])
    }
  })

  it('reads the tier from the reference chain too', async () => {
    const res = await getUserTierOnChain(USER, 'WAGER_PARTICIPANT', NOT_REF)
    expect(res).toMatchObject({ tier: 3, readable: true })
    expect(m.constructedAt).toContain(mmFor(REF))
    expect(m.askedOn).toEqual([Number(REF)])
  })
})

describe('the admin-role branch still honours its explicit chain (research R3)', () => {
  it('reads the chain it was given — admin roles genuinely are per-chain', async () => {
    // Admin roles resolve against the registry/router candidates for the chain passed in, so the
    // reference-chain rule must NOT have leaked into this branch.
    await hasRoleOnChain(USER, 'GUARDIAN', NOT_REF)
    // The membership address is never read for an admin-role lookup, and nothing was asked of the
    // reference chain on its behalf.
    expect(m.constructedAt).not.toContain(mmFor(REF))
    expect(m.askedOn).not.toContain(Number(REF))
  })
})

describe('an unreadable reference chain is UNKNOWN, not "no membership" (FR-004)', () => {
  it('hasRoleOnChain reports readable:false rather than a false denial', async () => {
    m.hasActiveRole = () => Promise.reject(new Error('endpoint down'))

    const detailed = await hasRoleOnChain(USER, 'WAGER_PARTICIPANT', REF, { detailed: true })

    expect(detailed.readable).toBe(false)
    expect(detailed.reason).toMatch(/endpoint down/)
    // held is false, but `readable:false` is what stops a caller reading that as a denial.
    expect(detailed.held).toBe(false)
  })

  it('getUserTierOnChain distinguishes unknown from None', async () => {
    m.getActiveTier = () => Promise.reject(new Error('endpoint down'))

    const unknown = await getUserTierOnChain(USER, 'WAGER_PARTICIPANT', REF)

    expect(unknown.readable).toBe(false)
    expect(unknown.tierName).not.toBe('None') // the whole point: never the "you own nothing" answer
    expect(unknown.reason).toMatch(/endpoint down/)
  })

  it('a genuine "no membership" is still a READ answer, not an unknown', async () => {
    m.hasActiveRole = () => Promise.resolve(false)
    m.getActiveTier = () => Promise.resolve(0)

    const held = await hasRoleOnChain(USER, 'WAGER_PARTICIPANT', REF, { detailed: true })
    const tier = await getUserTierOnChain(USER, 'WAGER_PARTICIPANT', REF)

    expect(held).toMatchObject({ held: false, readable: true })
    expect(tier).toMatchObject({ tier: 0, tierName: 'None', readable: true })
  })

  it('keeps the plain boolean contract for every caller that did not opt in', async () => {
    m.hasActiveRole = () => Promise.resolve(true)
    // No `{ detailed: true }` — existing callers must see exactly what they always saw.
    await expect(hasRoleOnChain(USER, 'WAGER_PARTICIPANT', REF)).resolves.toBe(true)

    m.hasActiveRole = () => Promise.reject(new Error('down'))
    await expect(hasRoleOnChain(USER, 'WAGER_PARTICIPANT', REF)).resolves.toBe(false)
  })
})
