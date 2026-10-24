// Spec 110 Phase 1 (#1592) — eventScanHandle must satisfy logScan's duck contract exactly:
// target/runner.provider/filters.X(...).getTopicFilter()/interface.parseLog, with ethers-shaped
// log normalization (number blockNumber, `index`), driven END TO END through the real scanLogs.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { encodeEventTopics, encodeAbiParameters, parseAbi } from 'viem'

const client = vi.hoisted(() => ({ current: null }))

vi.mock('../../lib/chains/publicClient', async (orig) => {
  const actual = await orig()
  return { ...actual, getPublicClient: () => client.current }
})

const { eventScanHandle } = await import('../../lib/chains/eventScan')
const { scanLogs, clearLogScanCache } = await import('../../lib/chain/logScan')

const ABI = parseAbi([
  'event RulesConfigured(address indexed safe, uint256 count)',
  'event CooldownSet(address indexed safe, uint256 secs)',
])
const GUARD = '0x00000000000000000000000000000000000000aa'
const SAFE = '0x1111111111111111111111111111111111111111'

function rawLog(eventName, blockNumber, value) {
  return {
    address: GUARD,
    topics: encodeEventTopics({ abi: ABI, eventName, args: [SAFE] }),
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash: '0x' + 'b'.repeat(64),
    transactionHash: '0x' + 'c'.repeat(64),
    transactionIndex: '0x0',
    logIndex: `0x${blockNumber.toString(16)}`,
  }
}

beforeEach(() => {
  clearLogScanCache()
  client.current = null
})

describe('eventScanHandle × scanLogs', () => {
  it('scans grouped filters through the seam and decodes named args', async () => {
    const requests = []
    client.current = {
      async getBlockNumber() {
        return 120n
      },
      async request({ method, params }) {
        expect(method).toBe('eth_getLogs')
        requests.push(params[0])
        return [rawLog('RulesConfigured', 100, 3n), rawLog('CooldownSet', 110, 60n)]
      },
    }
    const guard = eventScanHandle(137, { address: GUARD, abi: ABI })
    const { logs, complete } = await scanLogs({
      contract: guard,
      filters: [guard.filters.RulesConfigured(SAFE), guard.filters.CooldownSet(SAFE)],
      fromBlock: 100,
      chainId: 137,
    })
    expect(complete).toBe(true)
    expect(logs).toHaveLength(2)
    expect(logs[0]).toMatchObject({ eventName: 'RulesConfigured', blockNumber: 100, index: 100 })
    expect(logs[0].args.safe.toLowerCase()).toBe(SAFE)
    expect(logs[0].args.count).toBe(3n)
    expect(logs[1]).toMatchObject({ eventName: 'CooldownSet', blockNumber: 110 })
    // Grouped: ONE request per chunk carrying a topic0 OR-set, hex-quantity block bounds.
    expect(requests).toHaveLength(1)
    expect(Array.isArray(requests[0].topics[0])).toBe(true)
    expect(requests[0].topics[0]).toHaveLength(2)
    expect(requests[0].fromBlock).toBe('0x64')
  })

  it('returns null for a routeless chain, matching the provider factories', () => {
    expect(eventScanHandle(424242, { address: GUARD, abi: ABI })).toBeNull()
  })

  /*
   * The scan head must never come from viem's block-number cache.
   *
   * viem caches `eth_blockNumber` for `cacheTime` — 4000ms by default and shared across every
   * caller of the client — where ethers cached it for 250ms. `scanLogs` records "I have scanned
   * up to HEAD", so a head from before the caller's own transaction makes the scan complete over
   * a range that excludes it. The surface then reads as "nothing here" and, since these surfaces
   * read on mount and do not poll, stays that way until the member presses Refresh.
   *
   * This was not hypothetical: it emptied the Protect vault queue for a member who proposed a
   * governance change and opened the Queue within four seconds, and it is invisible to every
   * assertion about the RETURNED value — only the request carries it.
   */
  it('asks for an UNCACHED head — a stale one silently completes a scan over the wrong range', async () => {
    const seen = []
    client.current = {
      async getBlockNumber(opts) {
        seen.push(opts)
        return 120n
      },
      async request() {
        return []
      },
    }
    const guard = eventScanHandle(137, { address: GUARD, abi: ABI })
    await guard.runner.provider.getBlockNumber()
    expect(seen).toEqual([{ cacheTime: 0 }])
  })
})

/*
 * Spec 110. viem pads a topic filter to one slot per INDEXED parameter; ethers stopped at the last
 * argument the caller named. `Transfer(null, to)` on a three-indexed event therefore went out as
 * `[sig, null, to, null]` instead of `[sig, null, to]`.
 *
 * Both mean the same thing to a conforming `eth_getLogs`, so this is not a correctness difference —
 * it is a difference in the bytes on the wire, and the failure it would cause is the quiet kind: a
 * provider that rejects the longer form turns a scan into an EMPTY RESULT, which on every feed in
 * this app renders identically to "nothing happened". Checked against ethers, because the claim is
 * that the request is the one this app has always sent.
 */
describe('eventScanHandle topic filters', () => {
  it('sends the topics ethers sent — no trailing "any" padding', async () => {
    const { Interface } = await import('ethers')
    const ERC721 = parseAbi([
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    ])
    client.current = { async getBlockNumber() { return 1n }, async request() { return [] } }
    const handle = eventScanHandle(137, { address: GUARD, abi: ERC721 })
    const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'])

    // The shape the voucher scan uses: "incoming to me, from anyone".
    expect(handle.filters.Transfer(null, SAFE).getTopicFilter()).toEqual(
      iface.encodeFilterTopics('Transfer', [null, SAFE]),
    )
    // No arguments at all, and a fully-specified filter, both unchanged.
    expect(handle.filters.Transfer().getTopicFilter()).toEqual(
      iface.encodeFilterTopics('Transfer', []),
    )
    expect(handle.filters.Transfer(SAFE, GUARD, 7n).getTopicFilter()).toEqual(
      iface.encodeFilterTopics('Transfer', [SAFE, GUARD, 7n]),
    )
  })
})
