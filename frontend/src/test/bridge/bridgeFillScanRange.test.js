/**
 * The destination fill scan's block range (spec 067, FR-009 / FR-053).
 *
 * `readDestinationFill` is the only thing in the app allowed to promote a bridge to `delivered`
 * without the gateway, and its entire output is a fill transaction hash read from the destination
 * chain's SpokePool. It used to ask for that in ONE `eth_getLogs` spanning the whole six-hour
 * lookback — 10,800 blocks on Polygon, Optimism and Base and 86,400 on Arbitrum — against endpoints
 * that cap a single request at 10,000 blocks. Verified live against the real Polygon SpokePool:
 *
 *     lookback 10800 -> HTTP 413 {"code":-32614,"message":"eth_getLogs is limited to a 10,000 range"}
 *     lookback 10001 -> HTTP 413 (same)
 *     lookback 10000 -> OK, 347 logs
 *
 * Only Ethereum's 1,800 blocks fit. The failure was HONEST — a refused range is caught and returns
 * null, which the state machine reads as "no new information", so nobody was ever falsely told a
 * transfer had not arrived — but the fill hash was unreachable on four of the five bridging chains,
 * which is the whole point of the function.
 *
 * These pin three things:
 *   1. the per-chain lookback arithmetic, so a change to `FILL_LOOKBACK_SECONDS` or a block-time
 *      estimate is a deliberate act rather than a silent one;
 *   2. that no single request ever exceeds the cap, on every chain, whatever the arithmetic says;
 *   3. that the honest-degradation contract survives the fix — a scan that cannot be read is still
 *      null (no new information), never a false "not delivered".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encodeEventLog } from '../helpers/encodeEventLog'
import {
  BRIDGE_STATUS_SOURCE,
  FILL_LOOKBACK_SECONDS,
  SPOKE_POOL_ABI,
  deriveBridgeState,
  fillLookbackBlocksFor,
  readOnChainEvidence,
  spokePoolAddress,
} from '../../lib/bridge/bridgeStatus'
import { LOG_SCAN_CHUNK, clearLogScanCache } from '../../lib/chain/logScan'
// Fixture logs are built from the SAME fragments the module parses, via the shared viem helper —
// `Interface.encodeEventLog` has no single viem twin (spec 110). SPOKE_POOL_ABI is the parsed form.
const encodeSpokeLog = (name, values) => encodeEventLog(SPOKE_POOL_ABI, name, values)

import { BRIDGE_STATE } from '../../data/ledger/sources/bridgeLedgerSource'

const ORIGIN = 137
const DEPOSIT_ID = '123456'
const DST_TX = `0x${'22'.repeat(32)}`
const MEMBER = '0x1111111111111111111111111111111111111111'
const TOKEN = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const HEAD = 20_000_000
const NOW = 1_800_000_000_000

/**
 * The cap that broke this, as an endpoint actually enforces it: an inclusive range of more than
 * 10,000 blocks is refused outright. Anything narrower answers normally.
 */
const CAP = 10_000
/** `'latest'` is resolved the way a node resolves it, so the pre-fix behaviour is the real one. */
const asBlock = (v) => (v === 'latest' || v == null ? HEAD : Number(v))
const overCap = (req) => asBlock(req.toBlock) - asBlock(req.fromBlock) + 1 > CAP

/** A real, ABI-encoded `FilledRelay` log, so the scan is exercised through actual decoding. */
function fillLog(blockNumber = HEAD - 5, destinationChainId = 1) {
  const b32 = (addr) => `0x${'00'.repeat(12)}${addr.slice(2)}`
  const encoded = encodeSpokeLog('FilledRelay', [
    b32(TOKEN), b32(TOKEN), 1_000_000n, 996_500n, BigInt(ORIGIN), BigInt(ORIGIN), BigInt(DEPOSIT_ID),
    1_800_003_600, 0, `0x${'00'.repeat(32)}`, b32(MEMBER), b32(MEMBER), b32(MEMBER), `0x${'00'.repeat(32)}`,
    [b32(MEMBER), `0x${'00'.repeat(32)}`, 996_500n, 0],
  ])
  return {
    ...encoded,
    address: spokePoolAddress(destinationChainId),
    blockNumber,
    transactionHash: DST_TX,
    transactionIndex: 0,
    index: 0,
  }
}

/**
 * A destination provider that behaves like QuickNode: it refuses any single request wider than the
 * cap, and otherwise answers with whichever of `logs` fall inside the requested range.
 */
function cappedProvider(logs = []) {
  const getLogs = vi.fn(async (req) => {
    if (overCap(req)) {
      const err = new Error('eth_getLogs is limited to a 10,000 range')
      err.code = -32614
      throw err
    }
    return logs.filter((l) => l.blockNumber >= asBlock(req.fromBlock) && l.blockNumber <= asBlock(req.toBlock))
  })
  return { getBlockNumber: vi.fn(async () => HEAD), getLogs }
}

const originProvider = () => ({ getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, logs: [] }) })

const read = (destinationChainId, destinationProvider) =>
  readOnChainEvidence({
    originChainId: ORIGIN,
    destinationChainId,
    depositId: DEPOSIT_ID,
    srcTxHash: `0x${'11'.repeat(32)}`,
    originProvider: originProvider(),
    destinationProvider,
  })

/** Every bridging chain, with the lookback its block-time estimate produces. */
const CHAINS = [
  { chainId: 1, name: 'Ethereum', blockSeconds: 12, lookback: 1_800 },
  { chainId: 10, name: 'Optimism', blockSeconds: 2, lookback: 10_800 },
  { chainId: 137, name: 'Polygon', blockSeconds: 2, lookback: 10_800 },
  { chainId: 8453, name: 'Base', blockSeconds: 2, lookback: 10_800 },
  { chainId: 42161, name: 'Arbitrum', blockSeconds: 0.25, lookback: 86_400 },
]

beforeEach(() => clearLogScanCache())

// ---------------------------------------------------------------------------------------------
describe('the lookback window each bridging chain asks for', () => {
  it.each(CHAINS)('$name ($chainId): $lookback blocks ≈ 6h at ~$blockSeconds s/block', ({ chainId, blockSeconds, lookback }) => {
    expect(fillLookbackBlocksFor(chainId)).toBe(lookback)
    // …and the arithmetic really is "six hours of blocks", not a number someone typed.
    expect(lookback).toBe(Math.ceil(FILL_LOOKBACK_SECONDS / blockSeconds))
  })

  it('an unknown chain falls back to the conservative 12s estimate rather than to nothing', () => {
    expect(fillLookbackBlocksFor(999_999)).toBe(1_800)
  })

  it('four of the five bridging chains want MORE than one request can carry — which is the bug', () => {
    const overCapChains = CHAINS.filter((c) => c.lookback > LOG_SCAN_CHUNK).map((c) => c.chainId)
    expect(overCapChains).toEqual([10, 137, 8453, 42161])
  })
})

// ---------------------------------------------------------------------------------------------
describe('no single eth_getLogs ever exceeds the block cap', () => {
  it.each(CHAINS)('$name ($chainId) splits its $lookback-block window into capped requests', async ({ chainId, lookback }) => {
    const dest = cappedProvider()
    await read(chainId, dest)

    expect(dest.getLogs).toHaveBeenCalled()
    for (const [req] of dest.getLogs.mock.calls) {
      expect(typeof req.toBlock).toBe('number') // 'latest' is an open end, and an open end cannot be chunked
      expect(req.toBlock - req.fromBlock + 1).toBeLessThanOrEqual(LOG_SCAN_CHUNK)
    }

    // Contiguous and complete: the whole window is covered exactly once, with no hole in the middle
    // (a skipped range is indistinguishable from "no fill happened there").
    const ranges = dest.getLogs.mock.calls.map(([r]) => [r.fromBlock, r.toBlock]).sort((a, b) => a[0] - b[0])
    expect(ranges[0][0]).toBe(HEAD - lookback)
    expect(ranges[ranges.length - 1][1]).toBe(HEAD)
    for (let i = 1; i < ranges.length; i += 1) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1)
  })

  it('the widest window in the estate stays within a sane request budget', async () => {
    const dest = cappedProvider()
    await read(42161, dest)
    // 86,400 blocks at 10,000 a chunk. If this ever climbs, it is a deliberate cost decision.
    expect(dest.getLogs).toHaveBeenCalledTimes(9)
  })
})

// ---------------------------------------------------------------------------------------------
describe('the fill is actually found on the chains the single request could not reach', () => {
  // Ethereum is the control: its 1,800-block window always fitted, so this row passed before the
  // sweep was chunked and must keep passing after. The other four are the bug.
  it.each(CHAINS)('$name ($chainId) reads the fill hash back off a cap-enforcing endpoint', async ({ chainId }) => {
    const e = await read(chainId, cappedProvider([fillLog()]))
    expect(e.dstTxHash).toBe(DST_TX)
    expect(deriveBridgeState({ current: BRIDGE_STATE.IN_FLIGHT, evidence: e, now: NOW }).state).toBe(BRIDGE_STATE.DELIVERED)
  })

  it('finds a fill sitting at the very start of the window, not just near the head', async () => {
    const dest = cappedProvider([fillLog(HEAD - fillLookbackBlocksFor(137))])
    const e = await read(137, dest)
    expect(e.dstTxHash).toBe(DST_TX)
  })
})

// ---------------------------------------------------------------------------------------------
describe('honest degradation survives the chunking (FR-009)', () => {
  it('an endpoint that refuses every range still answers null — never a false non-delivery', async () => {
    const dest = {
      getBlockNumber: vi.fn(async () => HEAD),
      getLogs: vi.fn().mockRejectedValue(new Error('rate limited')),
    }
    const e = await read(137, dest)
    expect(e.dstTxHash).toBeNull()
    expect(e.source).toBe(BRIDGE_STATUS_SOURCE.CHAIN)
    // "No information" leaves the transfer exactly where it was.
    expect(deriveBridgeState({ current: BRIDGE_STATE.IN_FLIGHT, evidence: e, now: NOW }).changed).toBe(false)
  })

  it('a chunk that fails part-way through the sweep is a non-answer, not a "not delivered"', async () => {
    const good = cappedProvider([fillLog()])
    let calls = 0
    const dest = {
      getBlockNumber: good.getBlockNumber,
      getLogs: vi.fn(async (req) => {
        calls += 1
        if (calls > 1) throw new Error('upstream hiccup')
        return good.getLogs(req)
      }),
    }
    const e = await read(42161, dest)
    expect(e.dstTxHash).toBeNull()
    expect(deriveBridgeState({ current: BRIDGE_STATE.IN_FLIGHT, evidence: e, now: NOW }).changed).toBe(false)
  })

  it('a head that cannot be read is a non-answer too, and costs no log request', async () => {
    const dest = { getBlockNumber: vi.fn().mockRejectedValue(new Error('offline')), getLogs: vi.fn() }
    const e = await read(137, dest)
    expect(e.dstTxHash).toBeNull()
    expect(dest.getLogs).not.toHaveBeenCalled()
  })
})
