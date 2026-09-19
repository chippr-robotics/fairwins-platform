import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createReportDataSource, resolveEscrow } from '../../data/reports/reportDataSource'
import { WAGER_REGISTRY_ABI } from '../../abis/WagerRegistry'

const USER = '0x1111111111111111111111111111111111111111'

describe('resolveEscrow (contract resolution)', () => {
  for (const chainId of [137, 80002, 63, 1337]) {
    it(`resolves the v2 WagerRegistry on chain ${chainId} with the v2 ABI + events`, () => {
      const e = resolveEscrow(chainId)
      expect(e.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(e.abi).toBe(WAGER_REGISTRY_ABI)
      expect(e.valueEvents).toEqual(
        expect.arrayContaining(['WagerCreated', 'WagerAccepted', 'PayoutClaimed', 'WagerRefunded']),
      )
    })
  }

  it('throws a clear error when no escrow is configured for the chain', () => {
    expect(() => resolveEscrow(999999)).toThrow(/no wager escrow contract is configured/i)
  })
})

describe('createReportDataSource.enumerateWagers (subgraph-based, no genesis scan)', () => {
  afterEach(() => vi.unstubAllEnvs())

  function fakeRepo(pages) {
    let call = 0
    return {
      listMyWagers: vi.fn(async () => pages[Math.min(call++, pages.length - 1)]),
    }
  }

  it('enumerates over RPC (no throw) on a chain without a subgraph (e.g. Mordor)', async () => {
    // Chain 63 (Mordor) has no subgraph, so the repository serves v2 wagers from
    // RegistrySource (source: 'registry'). Reporting must still work.
    const repo = fakeRepo([
      {
        source: 'registry',
        hasMore: false,
        nextCursor: null,
        items: [
          { id: '1', creator: USER, participants: [USER], stakeTokenAddress: '0xtok', stakeAmount: '100', createdAt: 0 },
        ],
      },
    ])
    const ds = createReportDataSource({ chainId: 63, provider: { getBlockNumber: async () => 1 }, repository: repo })
    const wagers = await ds.enumerateWagers({ account: USER })
    expect(wagers.map((w) => w.id)).toEqual(['1'])
  })

  it('enumerates the user\'s wagers from the subgraph repository (never scans logs)', async () => {
    vi.stubEnv('VITE_SUBGRAPH_URL', 'http://subgraph.example')
    const repo = fakeRepo([
      {
        source: 'subgraph',
        hasMore: false,
        nextCursor: null,
        items: [
          { id: '1', creator: USER, participants: [USER], stakeTokenAddress: '0xtok', stakeAmount: '100', createdAt: 1700000000000 },
          { id: '2', creator: '0xother', participants: ['0xother', USER], stakeTokenAddress: '0xtok', stakeAmount: '50', createdAt: 1700001000000 },
        ],
      },
    ])
    const ds = createReportDataSource({ chainId: 80002, provider: { getBlockNumber: async () => 1 }, repository: repo })
    const wagers = await ds.enumerateWagers({ account: USER })
    expect(wagers.map((w) => w.id)).toEqual(['1', '2'])
    expect(repo.listMyWagers).toHaveBeenCalledWith(expect.objectContaining({ userAddress: USER, filter: { includeExpired: true } }))
  })

  it('accepts the subgraph-fallback (RPC) source as valid v2 data', async () => {
    // When the subgraph is unreachable on an indexed chain the repository now
    // falls back to RegistrySource (RPC), tagged 'subgraph-fallback'. That is
    // valid v2 data, so enumeration succeeds rather than erroring.
    const repo = fakeRepo([
      {
        source: 'subgraph-fallback',
        hasMore: false,
        nextCursor: null,
        items: [
          { id: '9', creator: USER, participants: [USER], stakeTokenAddress: '0xtok', stakeAmount: '5', createdAt: 0 },
        ],
      },
    ])
    const ds = createReportDataSource({ chainId: 80002, provider: { getBlockNumber: async () => 1 }, repository: repo })
    const wagers = await ds.enumerateWagers({ account: USER })
    expect(wagers.map((w) => w.id)).toEqual(['9'])
  })

  it('still rejects the retired legacy events source (cannot serve v2 reporting)', async () => {
    const repo = fakeRepo([{ source: 'events', hasMore: false, nextCursor: null, items: [] }])
    const ds = createReportDataSource({ chainId: 80002, provider: { getBlockNumber: async () => 1 }, repository: repo })
    await expect(ds.enumerateWagers({ account: USER })).rejects.toThrow(/temporarily unavailable/i)
  })

  it('returns [] without an account', async () => {
    vi.stubEnv('VITE_SUBGRAPH_URL', 'http://subgraph.example')
    const ds = createReportDataSource({ chainId: 80002, provider: { getBlockNumber: async () => 1 }, repository: fakeRepo([]) })
    expect(await ds.enumerateWagers({ account: null })).toEqual([])
  })
})

describe('createReportDataSource.listTransfers (subgraph WagerTransfer, no log scan)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('returns null on a chain without a subgraph (signals RPC/bounded-scan fallback)', async () => {
    // Chain 63 (Mordor) has no subgraph endpoint, so the indexed transfer query
    // is skipped and the caller falls back to enumerate + bounded scan.
    const ds = createReportDataSource({ chainId: 63, provider: { getBlockNumber: async () => 1 } })
    expect(await ds.listTransfers({ account: USER })).toBeNull()
  })

  it('queries wagerTransfers by party and maps rows to pre-items (no contract call)', async () => {
    vi.stubEnv('VITE_SUBGRAPH_URL', 'http://subgraph.example')
    let sentBody = null
    const fetchMock = vi.fn(async (_url, opts) => {
      sentBody = JSON.parse(opts.body)
      return {
        ok: true,
        json: async () => ({
          data: {
            wagerTransfers: [
              { direction: 'deposit', token: '0xtok', amount: '100', from: USER, to: '0xreg', txHash: '0xaa', blockNumber: '10', timestamp: '1700000000', wager: { id: '1' } },
              { direction: 'payout', token: '0xtok', amount: '200', from: '0xreg', to: USER, txHash: '0xbb', blockNumber: '20', timestamp: '1700000500', wager: { id: '1' } },
            ],
          },
        }),
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    const ds = createReportDataSource({ chainId: 80002, provider: { getBlockNumber: async () => 1 } })
    const items = await ds.listTransfers({ account: USER })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sentBody.query).toMatch(/wagerTransfers/)
    expect(sentBody.variables.party).toBe(USER.toLowerCase())
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      wagerId: '1', direction: 'deposit', tokenAddress: '0xtok', amountRaw: '100',
      fromAddress: USER, toAddress: '0xreg', txHash: '0xaa', blockNumber: 10, timestamp: 1700000000 * 1000,
    })
  })

  it('returns [] without an account', async () => {
    vi.stubEnv('VITE_SUBGRAPH_URL', 'http://subgraph.example')
    const ds = createReportDataSource({ chainId: 80002, provider: { getBlockNumber: async () => 1 } })
    expect(await ds.listTransfers({ account: null })).toEqual([])
  })
})

describe('createReportDataSource.getWagerEvents (bounded window, adaptive chunking)', () => {
  beforeEach(() => vi.stubEnv('VITE_SKIP_BLOCKCHAIN_CALLS', 'false'))
  afterEach(() => vi.unstubAllEnvs())

  function fakeContract(onQuery) {
    return {
      filters: new Proxy({}, { get: (_t, name) => (...args) => ({ name: String(name), args }) }),
      queryFilter: onQuery,
    }
  }

  it('does not scan from genesis — starts near the wager createdAt and stays within budget', async () => {
    vi.stubEnv('VITE_SUBGRAPH_URL', 'http://subgraph.example')
    const calls = []
    // latest block ~ 1,000,000; createdAt recent → window should be small.
    const provider = {
      getBlockNumber: async () => 1_000_000,
      getBlock: async () => ({ timestamp: 2_000_000 }),
    }
    const contract = fakeContract(async (filter, from, to) => {
      calls.push([from, to])
      return []
    })
    const repo = {
      listMyWagers: async () => ({
        source: 'subgraph', hasMore: false, nextCursor: null,
        // createdAt ~ now (latestSec 2,000,000) → window starts just below latest block
        items: [{ id: '5', creator: '0x1111111111111111111111111111111111111111', participants: [], stakeTokenAddress: '0xtok', stakeAmount: '1', createdAt: 1_999_000_000 }],
      }),
    }
    const ds = createReportDataSource({ chainId: 80002, provider, contract, repository: repo })
    await ds.enumerateWagers({ account: '0x1111111111111111111111111111111111111111' })
    await ds.getWagerEvents('5')

    expect(calls.length).toBeGreaterThan(0)
    const minFrom = Math.min(...calls.map((c) => c[0]))
    // Must NOT start at genesis.
    expect(minFrom).toBeGreaterThan(0)
    // Bounded request count (budget).
    expect(calls.length).toBeLessThanOrEqual(60)
  })

  it('shrinks the chunk when the RPC rejects the block range', async () => {
    vi.stubEnv('VITE_SUBGRAPH_URL', 'http://subgraph.example')
    const sizes = []
    let firstBig = true
    const provider = { getBlockNumber: async () => 10_000, getBlock: async () => ({ timestamp: 1000 }) }
    const contract = fakeContract(async (filter, from, to) => {
      sizes.push(to - from + 1)
      if (firstBig && to - from + 1 > 1000) {
        firstBig = false
        const e = new Error('block range exceeds configured limit')
        throw e
      }
      return []
    })
    const repo = {
      listMyWagers: async () => ({ source: 'subgraph', hasMore: false, nextCursor: null,
        items: [{ id: '9', creator: '0x1', participants: [], stakeTokenAddress: '0xt', stakeAmount: '1', createdAt: 0 }] }),
    }
    const ds = createReportDataSource({ chainId: 80002, provider, contract, repository: repo })
    await ds.enumerateWagers({ account: '0xabc' })
    await ds.getWagerEvents('9')
    // After the rejection, a smaller chunk size must have been attempted.
    expect(Math.min(...sizes)).toBeLessThan(5000)
  })
})

/*
 * Spec 069 — the report reads the chain it is a report ABOUT.
 *
 * `getProvider` used to be `makeReadProvider(NETWORK_CONFIG.rpcUrl, opts.chainId)`: the URL came
 * from the build's default network, the chain id from the caller. Whenever those disagreed the
 * report asked one chain's node about another chain's transaction hashes, got nothing back, and
 * reported the gas fees as absent rather than as unread — a fabricated fact, and the exact shape
 * spec 069 forbids (never hand a provider a URL that can contradict the chain it is for).
 */
describe('the report reads the chain it was asked for (spec 069)', () => {
  afterEach(() => { vi.resetModules(); vi.doUnmock('../../lib/chains/publicClient') })

  async function withClientSpy(impl) {
    vi.resetModules()
    const getPublicClient = vi.fn(impl)
    vi.doMock('../../lib/chains/publicClient', async (importOriginal) => ({
      ...(await importOriginal()),
      getPublicClient,
    }))
    const mod = await import('../../data/reports/reportDataSource')
    return { create: mod.createReportDataSource, getPublicClient }
  }

  it('resolves the read route from the report chain, not the build default', async () => {
    const { create, getPublicClient } = await withClientSpy(() => ({ getBlockNumber: async () => 1n }))
    create({ chainId: 63, repository: { listMyWagers: async () => ({ items: [], hasMore: false }) } })
    // Mordor, on a build whose default network is not Mordor.
    expect(getPublicClient).toHaveBeenCalledWith(63)
  })

  it('refuses when the chain has no endpoint, rather than falling through to the default network', async () => {
    // A null client falling through to some default network would be the same wrong-chain read
    // by a quieter route. It has to be a refusal.
    const { create } = await withClientSpy(() => null)
    expect(() => create({ chainId: 63, repository: { listMyWagers: async () => ({ items: [] }) } }))
      .toThrow(/no rpc endpoint is configured for network 63/i)
  })

  it('still honours an explicitly injected provider (the testing seam)', async () => {
    const { create, getPublicClient } = await withClientSpy(() => ({ getBlockNumber: async () => 1n }))
    const injected = { getBlockNumber: async () => 42 }
    create({ chainId: 63, provider: injected, repository: { listMyWagers: async () => ({ items: [] }) } })
    expect(getPublicClient).not.toHaveBeenCalled()
  })
})
