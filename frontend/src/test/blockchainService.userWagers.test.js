/**
 * My Wagers reads the registry on the wallet's chain, and pages (spec 110).
 *
 * `fetchFriendMarketsForUser` is what the My Wagers surface and the wager notification source both
 * call, and until now nothing asserted what it asked or where. It used to build an ethers contract
 * from `getProvider(chainId)`; the reads name the chain through the seam now, which is what makes
 * the chain assertable at all — and what makes the member's own endpoint (spec 069) serve them.
 *
 * The paging matters as much as the chain: `getUserWagerIds` and `getUserWagers` are two SEPARATE
 * calls whose results are zipped by index, so a page whose two halves disagree would attach one
 * member's wager id to another's terms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const m = vi.hoisted(() => ({ reads: [], count: 0n }))

vi.mock('../config/contracts', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    getContractAddressForChain: (name, chainId) =>
      name === 'wagerRegistry' ? REGISTRY : name === 'paymentToken' ? USDC_BY_CHAIN[Number(chainId)] ?? '' : '',
    getContractAddress: () => '',
  }
})

vi.mock('../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      m.reads.push({ chainId, address, functionName, args })
      if (functionName === 'getUserWagerCount') return m.count
      const [, offset, limit] = args
      const start = Number(offset)
      const n = Math.min(Number(limit), Number(m.count) - start)
      if (functionName === 'getUserWagerIds') {
        return Array.from({ length: n }, (_, i) => BigInt(start + i))
      }
      if (functionName === 'getUserWagers') {
        return Array.from({ length: n }, (_, i) => wager(start + i))
      }
      throw new Error(`unexpected read: ${functionName}`)
    },
  }
})

import { fetchFriendMarketsForUser } from '../utils/blockchainService'

const REGISTRY = '0x' + 'a7'.repeat(20)
const USER = '0x0000000000000000000000000000000000000001'
const USDC_BY_CHAIN = { 137: '0x' + 'dc'.repeat(20) }
// Frozen EIP-55 pair (taken from ethers offline, so the cross-library fact survives without an
// ethers import here): the same address shouted, and the form the encoder demands.
const SHOUTED = '0x00C3EF4E02EF00AD6EE955DF5022A22F6EA73DAE'
const CHECKSUMMED = '0x00c3ef4e02Ef00Ad6eE955dF5022A22F6ea73dae'

/** One registry struct, as viem decodes a single tuple output: named fields, small ints as numbers. */
const wager = (i) => ({
  creator: USER,
  opponent: '0x' + '22'.repeat(20),
  arbitrator: '0x0000000000000000000000000000000000000000',
  token: USDC_BY_CHAIN[137],
  creatorStake: 1_500000n,
  opponentStake: 1_500000n,
  acceptDeadline: 1_700_000_000n,
  resolveDeadline: 1_700_100_000n,
  resolutionType: 0,
  status: 2,
  paid: false,
  creatorIsYes: true,
  winner: '0x0000000000000000000000000000000000000000',
  metadataHash: '0x' + '00'.repeat(32),
  polymarketConditionId: '0x' + '00'.repeat(32),
  metadataUri: `wager ${i}`,
})

beforeEach(() => {
  m.reads = []
  m.count = 0n
  vi.stubEnv('VITE_SKIP_BLOCKCHAIN_CALLS', 'false')
})
afterEach(() => vi.unstubAllEnvs())

describe('fetchFriendMarketsForUser (v2 registry path)', () => {
  it('asks the registry on the chain it was given, and shapes what comes back', async () => {
    m.count = 2n
    const wagers = await fetchFriendMarketsForUser(USER, 137)

    expect(m.reads.map((r) => [r.chainId, r.address, r.functionName])).toEqual([
      [137, REGISTRY, 'getUserWagerCount'],
      [137, REGISTRY, 'getUserWagerIds'],
      [137, REGISTRY, 'getUserWagers'],
    ])
    expect(wagers).toHaveLength(2)
    // Chain-resolved stake token ⇒ 6 decimals and "USDC", not the 18-decimal fallback that
    // renders a $1.50 wager as "0.0000000000015 tokens".
    expect(wagers[0]).toMatchObject({ id: '0', stakeAmount: '1.5', stakeTokenSymbol: 'USDC', status: 'active' })
    // The zero address is absence, not a participant.
    expect(wagers[0].arbitrator).toBeNull()
    expect(wagers[0].participants).toEqual([USER, '0x' + '22'.repeat(20)])
  })

  it('pages at 100 and keeps ids aligned with their structs', async () => {
    m.count = 150n
    const wagers = await fetchFriendMarketsForUser(USER, 137)

    const pages = m.reads
      .filter((r) => r.functionName === 'getUserWagerIds')
      .map((r) => [Number(r.args[1]), Number(r.args[2])])
    expect(pages).toEqual([[0, 100], [100, 50]])
    expect(wagers).toHaveLength(150)
    // Every id carries ITS OWN struct — the two reads are zipped, so a mis-paged half would show
    // up here as a wager numbered differently from the description it came with.
    expect(wagers.map((w) => w.description)).toEqual(wagers.map((w) => `wager ${w.id}`))
  })

  it('makes no read at all when the member has no wagers', async () => {
    m.count = 0n
    await expect(fetchFriendMarketsForUser(USER, 137)).resolves.toEqual([])
    expect(m.reads.map((r) => r.functionName)).toEqual(['getUserWagerCount'])
  })

  it('checksums an ALL-UPPERCASE address rather than failing the read (divergence 16)', async () => {
    m.count = 1n
    // A LETTERED address, because the point of the fixture is that case survives the round trip:
    // `0x…0001` uppercases to itself and would have asserted nothing. `isAddress` accepts the
    // shouting form — ethers did, so this app does — while viem's encoder refuses it, which is a
    // member seeing an error where their wagers should be.
    const wagers = await fetchFriendMarketsForUser(SHOUTED, 137)

    expect(wagers).toHaveLength(1)
    expect(m.reads[0].args[0]).toBe(CHECKSUMMED)
    expect(m.reads[0].args[0]).not.toBe(SHOUTED)
  })

  it('refuses a non-address without asking the chain anything', async () => {
    await expect(fetchFriendMarketsForUser('not-an-address', 137)).resolves.toEqual([])
    expect(m.reads).toEqual([])
  })
})
