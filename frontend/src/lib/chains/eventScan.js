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
    async getBlockNumber() {
      return Number(await client.getBlockNumber())
    },
  }

  const filters = new Proxy(
    {},
    {
      get(_t, eventName) {
        return (...args) => ({
          getTopicFilter: () =>
            encodeEventTopics({
              abi: normalizedAbi,
              eventName,
              // Trailing undefineds mean "any", exactly as ethers' filter factories did.
              args: args.length > 0 ? args : undefined,
            }),
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
