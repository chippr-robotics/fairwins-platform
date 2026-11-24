/**
 * lib/chain/logScan — REQUEST VOLUME. The 429 storm (Protect queue on Optimism/Base/Arbitrum) was
 * invisible to every assertion about returned logs: the answers were right, there were just
 * thousands of requests behind them, or a refusal retried ten ways before failing. So these assert
 * on the REQUESTS — how many, and how wide.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  scanLogs,
  scanLogRange,
  clearLogScanCache,
  __simulateReloadForTests,
  statedRangeCap,
  LogHistoryUnavailableError,
  REORG_MARGIN,
} from '../../lib/chain/logScan'

const ADDR = '0x1111111111111111111111111111111111111111'
const T0 = '0x' + 'aa'.repeat(32)

function makeContract({ getLogs, head, maxLogRange, logEndpointKey = 'test:logs' }) {
  return {
    target: ADDR,
    runner: { provider: { getLogs, getBlockNumber: async () => head(), maxLogRange, logEndpointKey } },
    interface: { parseLog: ({ topics }) => ({ name: 'A', args: { topic0: topics[0] } }) },
    filters: { A: () => ({ getTopicFilter: async () => [T0] }) },
  }
}
const log = (blockNumber) => ({
  address: ADDR, topics: [T0], data: '0x', blockNumber, blockHash: '0x', transactionHash: '0x' + blockNumber, transactionIndex: 0, index: 0,
})
const spans = (getLogs) => getLogs.mock.calls.map(([r]) => r.toBlock - r.fromBlock + 1)

beforeEach(() => clearLogScanCache())

describe('width follows the endpoint', () => {
  it('a wide endpoint reads 4M blocks of history in ONE request, not 400', async () => {
    const getLogs = vi.fn(async () => [])
    const c = makeContract({ getLogs, head: () => 4_000_000, maxLogRange: 5_000_000 })
    const { complete } = await scanLogs({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 42161 })
    expect(complete).toBe(true)
    expect(getLogs).toHaveBeenCalledTimes(1)
  })

  it('a STATED cap shrinks the width once and is remembered — not refused chunk after chunk', async () => {
    const getLogs = vi.fn(async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock + 1 > 10_000) throw new Error('eth_getLogs is limited to a 10,000 range')
      return []
    })
    const c = makeContract({ getLogs, head: () => 200_000, maxLogRange: 100_000 })
    await scanLogs({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10 })
    const refused = spans(getLogs).filter((w) => w > 10_000).length
    // The first wave (≤ 4 concurrent 100k chunks) may each be refused once; after that every
    // request fits. 200k blocks at 10k = 20 good requests.
    expect(refused).toBeLessThanOrEqual(2)
    expect(spans(getLogs).filter((w) => w <= 10_000)).toHaveLength(20)
  })
})

describe('an endpoint that cannot serve history fails FAST', () => {
  it('"archive requests require a personal token" is not retried in narrower chunks', async () => {
    const getLogs = vi.fn(async () => {
      throw new Error('Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode')
    })
    const c = makeContract({ getLogs, head: () => 5_000_000, maxLogRange: 10_000 })
    await expect(scanLogs({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 42161 })).rejects.toBeInstanceOf(LogHistoryUnavailableError)
    // One wave at most — the old path made 10 sub-requests per refused chunk, then failed anyway.
    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('a 100-block cap (drpc free plan) is refused outright — a scan at that width IS the storm', async () => {
    const getLogs = vi.fn(async () => {
      throw new Error('ranges over 100 blocks are not supported on free plan')
    })
    const c = makeContract({ getLogs, head: () => 5_000_000, maxLogRange: 10_000 })
    await expect(scanLogs({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 8453 })).rejects.toBeInstanceOf(LogHistoryUnavailableError)
    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('the sliding-window scanner shares the same rule', async () => {
    const getLogs = vi.fn(async () => {
      throw new Error('Archive requests require a personal token.')
    })
    await expect(
      scanLogRange({ provider: { getLogs, maxLogRange: 10_000 }, address: ADDR, topics: [T0], fromBlock: 1, toBlock: 100_000 }),
    ).rejects.toBeInstanceOf(LogHistoryUnavailableError)
    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(4)
  })
})

describe('one scan per key at a time', () => {
  it('three surfaces asking at once cost ONE backfill', async () => {
    const getLogs = vi.fn(async () => [])
    const c = makeContract({ getLogs, head: () => 100_000, maxLogRange: 10_000 })
    const args = { contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10 }
    const results = await Promise.all([scanLogs(args), scanLogs(args), scanLogs(args)])
    expect(results.every((r) => r.complete)).toBe(true)
    expect(getLogs).toHaveBeenCalledTimes(10) // 100k / 10k, once — not 30
  })
})

describe('a finished scan survives a reload', () => {
  it('reads only the new blocks (plus the reorg margin) and restores the logs it held', async () => {
    let head = 100_000
    const getLogs = vi.fn(async ({ fromBlock, toBlock }) => (fromBlock <= 50_000 && toBlock >= 50_000 ? [log(50_000)] : []))
    const c = makeContract({ getLogs, head: () => head, maxLogRange: 10_000 })
    const args = { contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10 }
    await scanLogs(args)
    expect(getLogs).toHaveBeenCalledTimes(10)

    __simulateReloadForTests()
    getLogs.mockClear()
    head = 100_100
    const { logs, complete } = await scanLogs(args)
    expect(complete).toBe(true)
    expect(logs.map((l) => l.blockNumber)).toEqual([50_000])
    expect(getLogs).toHaveBeenCalledTimes(1)
    const [req] = getLogs.mock.calls[0]
    expect(req.fromBlock).toBe(100_000 - REORG_MARGIN + 1) // re-reads the margin, never trusts the old head
    expect(req.toBlock).toBe(100_100)
  })

  it('a log inside the reorg margin is dropped on restore and re-read, never duplicated', async () => {
    const getLogs = vi.fn(async ({ fromBlock, toBlock }) => (fromBlock <= 99_990 && toBlock >= 99_990 ? [log(99_990)] : []))
    const c = makeContract({ getLogs, head: () => 100_000, maxLogRange: 10_000 })
    const args = { contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10 }
    await scanLogs(args)
    __simulateReloadForTests()
    const { logs } = await scanLogs(args)
    expect(logs.map((l) => l.blockNumber)).toEqual([99_990])
  })
})

describe('statedRangeCap — the refusals measured on real public endpoints', () => {
  it.each([
    ['eth_getLogs is limited to a 10,000 range', 10_000], // mainnet.optimism.io
    ['exceed maximum block range: 50000', 50_000], // publicnode recent
    ['ranges over 100 blocks are not supported on free plan', 100], // drpc
    ['block range greater than 2000 max', 2_000], // flashbots
    ['eth_getLogs is limited to 0 - 50 blocks range', 50], // 1rpc
    ['execution reverted', null],
  ])('%s → %s', (text, cap) => {
    expect(statedRangeCap(text)).toBe(cap)
  })
})
