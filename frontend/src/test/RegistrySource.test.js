/**
 * RegistrySource — direct RPC reads of the v2 WagerRegistry for networks that
 * have no subgraph (e.g. Ethereum Classic Mordor). Verifies the registry's
 * pagination views are used (no eth_getLogs), the v2 struct maps to the shared
 * Wager shape, and the status enum is decoded to the UI's string statuses.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const USER = '0x1111111111111111111111111111111111111111'
const OPP = '0x2222222222222222222222222222222222222222'
const ZERO = '0x0000000000000000000000000000000000000000'

// A fake WagerRegistry contract whose pagination views return canned structs.
const makeStruct = (over = {}) => ({
  creator: USER,
  opponent: OPP,
  arbitrator: ZERO,
  token: '0xtok',
  creatorStake: 100n,
  opponentStake: 150n,
  acceptDeadline: 1700000000n,
  resolveDeadline: 1700100000n,
  resolutionType: 2,
  status: 2, // Active
  paid: false,
  creatorIsYes: true,
  winner: ZERO,
  metadataHash: '0xhash',
  metadataUri: 'ipfs://cid1',
  ...over,
})

const contractMock = {
  getUserWagerCount: vi.fn(async () => 2n),
  getUserWagerIds: vi.fn(async () => [1n, 2n]),
  getUserWagers: vi.fn(async () => [makeStruct(), makeStruct({ status: 3, winner: USER })]),
  getWager: vi.fn(async () => makeStruct()),
}

// The registry reads ride the spec-110 chain seam, so the canned views are served there. Each
// call records the CHAIN it named, which is this file's own subject: a wallet on one network
// must never read another's wagers, and that is now carried by the read rather than by whichever
// provider happened to be built beside it.
const readChainIds = []
vi.mock('../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: (chainId, { functionName, args = [] }) => {
      readChainIds.push(chainId)
      const fn = contractMock[functionName]
      if (!fn) throw new Error('unmocked registry read: ' + functionName)
      return fn(...args)
    },
  }
})

vi.mock('../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => '0x3ccB144d8aa838e8d4D695867cC72e548117830C'),
}))

vi.mock('../data/wagers/cacheStore', () => ({ upsertCache: vi.fn() }))

describe('RegistrySource (RPC reads for un-indexed networks)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_SKIP_BLOCKCHAIN_CALLS', 'false')
    contractMock.getUserWagerCount.mockClear()
    contractMock.getUserWagerIds.mockClear()
    contractMock.getUserWagers.mockClear()
    readChainIds.length = 0
  })
  afterEach(() => vi.unstubAllEnvs())

  it('lists a user\'s wagers via getUserWagerCount/Ids/Wagers (no log scan)', async () => {
    const mod = await import('../data/wagers/RegistrySource')
    const res = await mod.listPage({ userAddress: USER, pageSize: 10, chainId: 63, filter: { includeExpired: true } })

    expect(contractMock.getUserWagerCount).toHaveBeenCalledWith(USER)
    expect(contractMock.getUserWagerIds).toHaveBeenCalled()
    expect(contractMock.getUserWagers).toHaveBeenCalled()
    expect(res.source).toBe('registry')
    expect(res.items).toHaveLength(2)

    const ids = res.items.map((w) => w.id).sort()
    expect(ids).toEqual(['1', '2'])
  })

  it('maps the v2 struct to the shared Wager shape and decodes the status enum', async () => {
    const mod = await import('../data/wagers/RegistrySource')
    const res = await mod.listPage({ userAddress: USER, pageSize: 10, chainId: 63, filter: { includeExpired: true } })
    const byId = Object.fromEntries(res.items.map((w) => [w.id, w]))

    expect(byId['1'].status).toBe('active') // enum 2 → 'active'
    expect(byId['2'].status).toBe('resolved') // enum 3 → 'resolved'
    expect(byId['1'].marketType).toBe('oneVsOne')
    expect(byId['1'].participants).toEqual([USER.toLowerCase(), OPP.toLowerCase()])
    expect(byId['1'].stakeTokenAddress).toBe('0xtok')
    expect(byId['1'].stakeAmount).toBe('100')
    expect(byId['1'].opponentStake).toBe('150')
    expect(byId['1'].ipfsCid).toBe('cid1')
    expect(byId['1'].needsIpfsFetch).toBe(true)
  })

  it('getById reads a single wager via getWager', async () => {
    const mod = await import('../data/wagers/RegistrySource')
    const w = await mod.getById('1', USER, { chainId: 63 })
    expect(contractMock.getWager).toHaveBeenCalledWith('1')
    expect(w.id).toBe('1')
    expect(w.status).toBe('active')
  })

  // The file's stated purpose: a wallet on one network never reads another's wagers. Under the
  // old shape that was a property of the provider built next to the contract; now the read names
  // the chain, so it can be asserted directly.
  it('reads ONLY the chain it was asked for', async () => {
    const mod = await import('../data/wagers/RegistrySource')
    await mod.listPage({ userAddress: USER, pageSize: 10, chainId: 63, filter: { includeExpired: true } })
    expect(readChainIds.length).toBeGreaterThan(0)
    expect([...new Set(readChainIds)]).toEqual([63])

    readChainIds.length = 0
    await mod.getById('1', USER, { chainId: 137 })
    expect([...new Set(readChainIds)]).toEqual([137])
  })

  it('returns empty when blockchain calls are skipped', async () => {
    vi.stubEnv('VITE_SKIP_BLOCKCHAIN_CALLS', 'true')
    const mod = await import('../data/wagers/RegistrySource')
    const res = await mod.listPage({ userAddress: USER, pageSize: 10, chainId: 63, filter: { includeExpired: true } })
    expect(res.items).toEqual([])
    expect(contractMock.getUserWagerCount).not.toHaveBeenCalled()
  })
})
