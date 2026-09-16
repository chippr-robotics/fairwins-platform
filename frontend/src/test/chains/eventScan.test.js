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
})
