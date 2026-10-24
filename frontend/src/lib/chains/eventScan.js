/**
 * Event-scan handle — the viem twin of `new Contract(address, abi, provider)` for the ONE
 * consumer shape that matters here: `lib/chain/logScan.js` (spec 110 Phase 1, #1592).
 *
 * logScan is deliberately duck-typed (it imports nothing from ethers): it needs a `target`,
 * a `runner.provider` with `getLogs`/`getBlockNumber`, filters exposing `getTopicFilter()`,
 * and an `interface.parseLog`. This module satisfies exactly that contract from the chain
 * seam, so converting a scanning caller is a one-line swap —
 *
 *   new Contract(address, ABI, provider)   →   eventScanHandle(chainId, { address, abi: ABI })
 *
 * — and logScan's chunking/caching/retry policy is untouched.
 *
 * Normalization notes (the shape callers were written against):
 * - viem logs carry bigint `blockNumber` and name the in-block position `logIndex`; ethers v6
 *   used number blocks and `index`. Both are normalized here, once, so cursor arithmetic in
 *   logScan (`Number` ranges) and callers' `log.index` reads keep working.
 * - `parseLog` decodes with the handle's ABI; `args` are viem's NAMED object (callers using
 *   positional `args[0]` access are converted per-site — grep before swapping a caller).
 */
import { decodeEventLog, encodeEventTopics } from 'viem'
import { getPublicClient } from './publicClient'
import { normalizeAbi } from './readContract'

function normalizeLog(log) {
  return {
    ...log,
    blockNumber: log.blockNumber == null ? log.blockNumber : Number(log.blockNumber),
    index: log.logIndex ?? log.index,
  }
}

/**
 * @param {number} chainId
 * @param {{ address: string, abi: Array }} target
 * @returns {object|null} a logScan-compatible handle, or null when the chain has no endpoint
 *   (the same "null means no route" contract the provider factories keep).
 */
export function eventScanHandle(chainId, { address, abi }) {
  const client = getPublicClient(chainId)
  if (!client) return null
  const normalizedAbi = normalizeAbi(abi)

  const provider = {
    async getLogs({ address: a, topics, fromBlock, toBlock }) {
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address: a,
            topics,
            fromBlock: `0x${Number(fromBlock).toString(16)}`,
            toBlock: `0x${Number(toBlock).toString(16)}`,
          },
        ],
      })
      return logs.map((log) =>
        normalizeLog({
          ...log,
          blockNumber: log.blockNumber == null ? null : Number(BigInt(log.blockNumber)),
          logIndex: log.logIndex == null ? null : Number(BigInt(log.logIndex)),
          transactionIndex:
            log.transactionIndex == null ? null : Number(BigInt(log.transactionIndex)),
        }),
      )
    },
    /**
     * THE SCAN HEAD IS NEVER SERVED FROM CACHE (`cacheTime: 0`).
     *
     * viem caches `eth_blockNumber` for `cacheTime` — 4000ms by default, and shared by every
     * caller of this client. ethers cached it for 250ms. That 16× difference is not a performance
     * detail here: `scanLogs` records "I have scanned up to HEAD" and a caller that mounts right
     * after a write (propose a vault transaction, then open the Queue) gets a head from before
     * its own transaction, scans to it, finds nothing, and marks the range complete. The surface
     * reads as "nothing pending" and — because these surfaces read on mount and do not poll —
     * stays that way until the member presses Refresh. A stale head is a silent under-report, the
     * one failure mode the whole honest-state rule exists to prevent, so it is refused here rather
     * than in each scanning caller.
     */
    async getBlockNumber() {
      return Number(await client.getBlockNumber({ cacheTime: 0 }))
    },
  }

  const filters = new Proxy(
    {},
    {
      get(_t, eventName) {
        return (...args) => ({
          getTopicFilter: () => {
            const topics = encodeEventTopics({
              abi: normalizedAbi,
              eventName,
              // Trailing undefineds mean "any", exactly as ethers' filter factories did.
              args: args.length > 0 ? args : undefined,
            })
            // viem pads the array to one slot per INDEXED parameter, so `Transfer(null, to)` on a
            // three-indexed event comes out `[sig, null, to, null]` where ethers sent `[sig, null,
            // to]`. A trailing null means "any" either way, so this is not a correctness
            // difference — but it is a difference in the bytes on the wire to an `eth_getLogs`,
            // and a provider that rejects the longer form would fail a scan into an EMPTY FEED,
            // which reads exactly like "nothing happened". Trimmed so the request is the one this
            // app has always sent.
            while (topics.length > 1 && topics[topics.length - 1] == null) topics.pop()
            return topics
          },
        })
      },
    },
  )

  return {
    target: address,
    runner: { provider },
    provider,
    filters,
    interface: {
      parseLog({ topics, data }) {
        const { eventName, args } = decodeEventLog({ abi: normalizedAbi, topics, data })
        return { name: eventName, args }
      },
    },
  }
}
