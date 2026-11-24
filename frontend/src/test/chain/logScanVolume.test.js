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
  HISTORY_UNAVAILABLE,
  reorgMarginFor,
  scanLogsUntil,
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

  it('tells the MEMBER what to do; the vendor wording stays on `cause`', async () => {
    const getLogs = vi.fn(async () => {
      throw new Error('Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode')
    })
    const c = makeContract({ getLogs, head: () => 50_000, maxLogRange: 10_000 })
    const err = await scanLogs({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 8453 }).catch((e) => e)
    expect(err.message).toBe(HISTORY_UNAVAILABLE)
    expect(err.message).not.toMatch(/allnodes/)
    expect(String(err.cause?.message)).toMatch(/personal token/)
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

describe('a finished scan survives a reload (opt-in)', () => {
  const margin = reorgMarginFor(10)

  it('reads only the new blocks (plus ~10 minutes of margin) and restores the logs it held', async () => {
    let head = 100_000
    const getLogs = vi.fn(async ({ fromBlock, toBlock }) => (fromBlock <= 50_000 && toBlock >= 50_000 ? [log(50_000)] : []))
    const c = makeContract({ getLogs, head: () => head, maxLogRange: 10_000 })
    const args = { contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10, persist: true }
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
    expect(req.fromBlock).toBe(100_000 - margin + 1) // re-reads the margin, never trusts the old head
    expect(req.toBlock).toBe(100_100)
  })

  it('a log inside the reorg margin is dropped on restore and re-read, never duplicated', async () => {
    const getLogs = vi.fn(async ({ fromBlock, toBlock }) => (fromBlock <= 99_990 && toBlock >= 99_990 ? [log(99_990)] : []))
    const c = makeContract({ getLogs, head: () => 100_000, maxLogRange: 10_000 })
    const args = { contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10, persist: true }
    await scanLogs(args)
    __simulateReloadForTests()
    const { logs } = await scanLogs(args)
    expect(logs.map((l) => l.blockNumber)).toEqual([99_990])
  })

  it('is OFF unless asked for — an ordinary caller rescans after a reload', async () => {
    const getLogs = vi.fn(async () => [])
    const c = makeContract({ getLogs, head: () => 100_000, maxLogRange: 10_000 })
    const args = { contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10 }
    await scanLogs(args)
    __simulateReloadForTests()
    getLogs.mockClear()
    await scanLogs(args)
    expect(getLogs).toHaveBeenCalledTimes(10)
  })

  it('a record written through a DIFFERENT endpoint is discarded — a reload still heals a bad watermark', async () => {
    const getLogs = vi.fn(async () => [])
    const a = makeContract({ getLogs, head: () => 100_000, maxLogRange: 10_000, logEndpointKey: '10:default' })
    await scanLogs({ contract: a, filters: [a.filters.A()], fromBlock: 1, chainId: 10, persist: true })
    __simulateReloadForTests()
    getLogs.mockClear()
    const b = makeContract({ getLogs, head: () => 100_000, maxLogRange: 10_000, logEndpointKey: '10:member' })
    await scanLogs({ contract: b, filters: [b.filters.A()], fromBlock: 1, chainId: 10, persist: true })
    expect(getLogs).toHaveBeenCalledTimes(10) // full rescan through the new endpoint
  })
})

describe('refusals that narrowing cannot fix are not narrowed', () => {
  it('a rate limit in the response BODY waits and re-asks the SAME range — no sub-chunk fan-out', async () => {
    vi.useFakeTimers()
    try {
      let refusals = 1
      const getLogs = vi.fn(async () => {
        if (refusals > 0) {
          refusals -= 1
          throw new Error('request limit reached')
        }
        return []
      })
      const c = makeContract({ getLogs, head: () => 10_000, maxLogRange: 10_000 })
      const pending = scanLogs({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 8453 })
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(pending).resolves.toMatchObject({ complete: true })
      expect(spans(getLogs)).toEqual([10_000, 10_000])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a result-size refusal BISECTS instead of fanning out ten ways from a wide chunk', async () => {
    const getLogs = vi.fn(async ({ fromBlock, toBlock }) => {
      if (toBlock - fromBlock + 1 > 1_250_000) throw new Error('query returned more than 10000 results')
      return []
    })
    const c = makeContract({ getLogs, head: () => 5_000_000, maxLogRange: 5_000_000 })
    await scanLogs({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 42161 })
    // 5M → 2×2.5M → 4×1.25M: 1 + 2 refused, 4 served. Ten-way narrowing would have been 1 + 10.
    expect(getLogs).toHaveBeenCalledTimes(7)
  })
})

describe('scanLogsUntil — a count the chain states bounds the scan', () => {
  it('target 0 (a vault that never executed) costs ZERO requests', async () => {
    const getLogs = vi.fn(async () => [])
    const c = makeContract({ getLogs, head: () => 5_000_000, maxLogRange: 10_000 })
    const r = await scanLogsUntil({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10, target: 0 })
    expect(r).toMatchObject({ complete: true, found: 0 })
    expect(getLogs).not.toHaveBeenCalled()
  })

  it('reads newest-first and stops at the count — not 500 chunks back to the deploy block', async () => {
    const getLogs = vi.fn(async ({ fromBlock, toBlock }) => (fromBlock <= 4_995_000 && toBlock >= 4_995_000 ? [log(4_995_000)] : []))
    const c = makeContract({ getLogs, head: () => 5_000_000, maxLogRange: 10_000 })
    const r = await scanLogsUntil({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10, target: 1 })
    expect(r).toMatchObject({ complete: true, found: 1 })
    expect(getLogs.mock.calls.length).toBeLessThanOrEqual(4) // one wave from the head
    expect(Math.min(...getLogs.mock.calls.map(([q]) => q.fromBlock))).toBeGreaterThan(4_900_000)
  })

  it('a later call reads only the NEW blocks when the count grew at the head', async () => {
    let head = 5_000_000
    let events = []
    const getLogs = vi.fn(async ({ fromBlock, toBlock }) => events.filter((b) => b >= fromBlock && b <= toBlock).map(log))
    const c = makeContract({ getLogs, head: () => head, maxLogRange: 10_000 })
    const args = { contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10 }
    events = [4_999_000]
    await scanLogsUntil({ ...args, target: 1 })
    getLogs.mockClear()
    head = 5_000_050
    events = [4_999_000, 5_000_020]
    const r = await scanLogsUntil({ ...args, target: 2 })
    expect(r).toMatchObject({ complete: true, found: 2 })
    expect(getLogs).toHaveBeenCalledTimes(1)
    expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 5_000_001, toBlock: 5_000_050 })
  })

  it('reaching the floor short of the count is complete — the history from there is all read', async () => {
    const getLogs = vi.fn(async () => [])
    const c = makeContract({ getLogs, head: () => 30_000, maxLogRange: 10_000 })
    const r = await scanLogsUntil({ contract: c, filters: [c.filters.A()], fromBlock: 1, chainId: 10, target: 3 })
    expect(r).toMatchObject({ complete: true, found: 0 })
    expect(getLogs).toHaveBeenCalledTimes(3)
  })
})

describe('statedRangeCap — the refusals measured on real public endpoints', () => {
  it.each([
    ['eth_getLogs is limited to a 10,000 range', 10_000], // mainnet.optimism.io
    ['exceed maximum block range: 50000', 50_000], // publicnode recent
    ['ranges over 100 blocks are not supported on free plan', 100], // drpc
    ['block range greater than 2000 max', 2_000], // flashbots
    ['eth_getLogs is limited to 0 - 50 blocks range', 50], // 1rpc
    ['query spans 5000000 blocks (488059169 to 493059168), but only 100000 are allowed for this request', 100_000], // arb1
    ['execution reverted', null],
  ])('%s → %s', (text, cap) => {
    expect(statedRangeCap(text)).toBe(cap)
  })
})
