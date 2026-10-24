/**
 * On-chain data source adapter for the wager tax/activity report
 * (spec 016-wager-tax-report; contracts/report-builder.md; research.md D1/D2).
 *
 * Strategy (chosen for scalability on public RPCs):
 *   - ENUMERATION via the subgraph (WagerRepository). Scanning the chain for a
 *     user's wagers from the deployment block is not viable on a public RPC
 *     (the node rejects wide `eth_getLogs` ranges → request floods / rate
 *     limits). The subgraph is the indexed, scalable path. When it is not
 *     configured we fail with a clear, actionable error rather than brute-force
 *     scanning from genesis.
 *   - PER-WAGER details (txHash + gas fee — which the subgraph cannot supply)
 *     are read from chain logs, but bounded to a TIGHT block window around each
 *     wager's `createdAt` (from the subgraph) with adaptive, shrink-on-limit
 *     chunking and a request budget. No genesis scans.
 *
 * Contract generations (resolved from synced config, never hardcoded):
 *   - v2 WagerRegistry: WagerCreated / WagerAccepted / PayoutClaimed /
 *     WagerRefunded / WagerCancelled / WagerDrawn
 *   - v1 FriendGroupMarketFactory (legacy): MarketCreatedPending /
 *     ParticipantAccepted / WinningsClaimed / StakeRefunded
 */

import { getContractAddressForChain, NETWORK_CONFIG, DEPLOYMENT_BLOCKS } from '../../config/contracts'
import { WAGER_REGISTRY_ABI } from '../../abis/WagerRegistry'
import { FRIEND_GROUP_MARKET_FACTORY_ABI } from '../../abis/FriendGroupMarketFactory'
import { getDefaultWagerRepository } from '../wagers/WagerRepository'
import { getSubgraphUrl, hasSubgraph } from '../../config/networks'
import { getPublicClient } from '../../lib/chains/publicClient'
import { eventScanHandle } from '../../lib/chains/eventScan'

const INITIAL_CHUNK = 5000
const MIN_CHUNK = 200
// Per-getWagerEvents request budget — bounds work for any single wager.
const SCAN_BUDGET = 60
// Approx block time (seconds) per chain, for timestamp → block estimation.
const BLOCK_TIME_SEC = { 137: 2, 80002: 2, 63: 13, 1337: 1 }
// Margin (seconds) before a wager's createdAt to start its event window.
const PRE_WINDOW_SEC = 3600

const V2 = {
  abi: WAGER_REGISTRY_ABI,
  valueEvents: ['WagerCreated', 'WagerAccepted', 'PayoutClaimed', 'WagerRefunded', 'WagerCancelled', 'WagerDrawn'],
}
const V1 = {
  abi: FRIEND_GROUP_MARKET_FACTORY_ABI,
  valueEvents: ['MarketCreatedPending', 'ParticipantAccepted', 'WinningsClaimed', 'StakeRefunded'],
}

// Whether the given chain is indexed by a subgraph. Resolved per-chain so a
// network without an indexer (e.g. Mordor) transparently uses the RPC-backed
// repository path instead.
function subgraphConfigured(chainId) {
  return hasSubgraph(chainId)
}

// GraphQL: a party's value movements, time-ordered, straight from the index
// (spec 017). Carries txHash + timestamp + from/to, so the report needs NO
// eth_getLogs scan — only one receipt per transfer for the gas fee.
const WAGER_TRANSFERS_QUERY = `
  query ReportTransfers($party: Bytes!, $first: Int!, $skip: Int!) {
    wagerTransfers(
      where: { party: $party }
      orderBy: timestamp
      orderDirection: asc
      first: $first
      skip: $skip
    ) {
      direction
      token
      amount
      from
      to
      txHash
      blockNumber
      timestamp
      wager { id }
    }
  }
`

async function postSubgraph(url, query, variables) {
  if (!url) throw new Error('No subgraph endpoint configured for this chain')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Subgraph HTTP ${res.status}`)
  const json = await res.json()
  if (json.errors) throw new Error(`Subgraph: ${json.errors[0]?.message || 'unknown error'}`)
  return json.data
}

/** Map a subgraph WagerTransfer row to the report's pre-item shape (deriveTransfers output). */
function transferToPreItem(row) {
  return {
    wagerId: String(row.wager?.id ?? ''),
    direction: row.direction,
    tokenAddress: row.token,
    amountRaw: String(row.amount),
    fromAddress: row.from,
    toAddress: row.to,
    txHash: row.txHash,
    blockNumber: Number(row.blockNumber),
    // Per-transfer timestamp comes straight from the index now (was a getBlock call).
    timestamp: Number(row.timestamp) * 1000,
  }
}

/**
 * Read provider for the chain the report is being built FOR.
 *
 * This used to be `makeReadProvider(NETWORK_CONFIG.rpcUrl, opts.chainId)` — the URL came from the
 * build's default network while the chain id came from the caller. Whenever those disagreed the
 * report read one chain's transaction hashes against another chain's node: a Mordor report asked
 * Polygon about Mordor tx hashes, got nothing back, and reported the gas fees as absent rather than
 * as unread. Passing a URL and a chain id that can contradict each other is exactly what spec 069
 * forbids — the chain seam (`getPublicClient(chainId)`, spec 110) cannot be called that way.
 *
 * The seam returns null for a chain with no endpoint at all. That is surfaced as a refusal here
 * rather than passed on: a null provider falling through to some default network would be the
 * same wrong-chain read by another route.
 *
 * The returned object keeps the ethers-provider read shape the rest of this module (and its
 * injectable test seam, `opts.provider`) was written against: numeric block numbers,
 * `getBlock(n) → { timestamp }`, and `getTransactionReceipt(hash) → null` when unmined.
 */
function getProvider(opts = {}) {
  if (opts.provider) return opts.provider
  const chainId = opts.chainId ?? NETWORK_CONFIG.chainId
  const client = getPublicClient(chainId)
  if (!client) {
    throw new Error(`No RPC endpoint is configured for network ${chainId}, so this report cannot read the chain.`)
  }
  return {
    async getBlockNumber() {
      // Never cached: this head bounds a log scan, and a report that silently stops short of the
      // chain's tip under-reports rather than failing. See the note in `lib/chains/eventScan.js`.
      return Number(await client.getBlockNumber({ cacheTime: 0 }))
    },
    async getBlock(blockNumber) {
      const block = await client.getBlock({ blockNumber: BigInt(blockNumber) })
      return block ? { timestamp: Number(block.timestamp) } : null
    },
    async getTransactionReceipt(txHash) {
      try {
        const r = await client.getTransactionReceipt({ hash: txHash })
        return r
          ? {
              from: r.from,
              gasUsed: r.gasUsed,
              // viem names the paid price effectiveGasPrice; keep both spellings readable.
              gasPrice: r.effectiveGasPrice ?? r.gasPrice,
              effectiveGasPrice: r.effectiveGasPrice ?? r.gasPrice,
              blockNumber: Number(r.blockNumber),
            }
          : null
      } catch (err) {
        // ethers answered null for an unknown hash; viem throws a typed not-found error.
        if (err?.name === 'TransactionReceiptNotFoundError') return null
        throw err
      }
    },
  }
}

/** Resolve the escrow contract (prefer v2 WagerRegistry, fall back to v1 factory). */
export function resolveEscrow(chainId) {
  const registry = getContractAddressForChain('wagerRegistry', chainId)
  if (registry) return { address: registry, ...V2, deployBlock: DEPLOYMENT_BLOCKS.wagerRegistry || 0 }
  const factory = getContractAddressForChain('friendGroupMarketFactory', chainId)
  if (factory) return { address: factory, ...V1, deployBlock: DEPLOYMENT_BLOCKS.friendGroupMarketFactory || 0 }
  throw new Error('No wager escrow contract is configured for this network.')
}

/**
 * The default escrow scan handle: `filters` + `queryFilter` over the spec-110 chain seam,
 * shaped like the ethers Contract the scanner was written against. Indexed wager-id filter
 * args are normalized to bigint (viem encodes topics strictly; ethers coerced strings).
 */
function seamScanContract(chainId, escrow) {
  const handle = eventScanHandle(chainId, { address: escrow.address, abi: escrow.abi })
  if (!handle) {
    throw new Error(`No RPC endpoint is configured for network ${chainId}, so this report cannot read the chain.`)
  }
  return {
    filters: new Proxy(
      {},
      {
        get(_t, eventName) {
          return (...args) => handle.filters[eventName](...args.map((a) => (typeof a === 'string' && /^\d+$/.test(a) ? BigInt(a) : a)))
        },
      },
    ),
    async queryFilter(filter, fromBlock, toBlock) {
      const logs = await handle.provider.getLogs({
        address: escrow.address,
        topics: filter.getTopicFilter(),
        fromBlock,
        toBlock,
      })
      return logs.map((log) => {
        const parsed = handle.interface.parseLog(log)
        return { ...log, eventName: parsed.name, args: parsed.args }
      })
    },
  }
}

/** Normalize an ethers-shaped EventLog into the report's { name, args, txHash, block } shape. */
export function normalizeEvent(ev) {
  const a = ev.args || {}
  const id = a.wagerId ?? a.friendMarketId
  const big = (v) => (v != null ? v.toString() : undefined)
  return {
    name: ev.fragment?.name || ev.eventName,
    transactionHash: ev.transactionHash,
    blockNumber: ev.blockNumber,
    args: {
      wagerId: id != null ? String(id) : undefined,
      creator: a.creator,
      opponent: a.opponent,
      participant: a.participant,
      winner: a.winner,
      by: a.by,
      creatorStake: big(a.creatorStake),
      opponentStake: big(a.opponentStake),
      stakePerParticipant: big(a.stakePerParticipant),
      stakedAmount: big(a.stakedAmount),
      amount: big(a.amount),
      token: a.token ?? a.stakeToken,
    },
  }
}

/** Estimate a block number for a unix-second timestamp, clamped to [deployBlock, latest]. */
function estimateBlock(targetSec, ctx) {
  const delta = Math.max(0, Math.floor((ctx.latestSec - targetSec) / ctx.blockTimeSec))
  return Math.min(ctx.latestBlock, Math.max(ctx.deployBlock || 0, ctx.latestBlock - delta))
}

/**
 * queryFilter across a bounded block window with adaptive chunking: shrink the
 * chunk on "range exceeds limit" style errors, grow it back on success, and
 * stop with a clear error if the per-call request budget is exhausted.
 */
async function scanAdaptive(contract, filter, fromBlock, toBlock, label, budget) {
  const out = []
  let from = fromBlock
  let chunk = INITIAL_CHUNK
  while (from <= toBlock) {
    if (budget.used >= budget.max) {
      throw new Error(
        'This report period is too large to read from the network without the indexing subgraph. ' +
        'Try a shorter period, or configure VITE_SUBGRAPH_URL for full coverage.',
      )
    }
    const to = Math.min(from + chunk - 1, toBlock)
    budget.used += 1
    try {
      const logs = await contract.queryFilter(filter, from, to)
      out.push(...logs)
      from = to + 1
      if (chunk < INITIAL_CHUNK) chunk = Math.min(INITIAL_CHUNK, chunk * 2)
    } catch (err) {
      const msg = err?.message || ''
      if (/range|limit|exceed|too many|big/i.test(msg) && chunk > MIN_CHUNK) {
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 4))
        continue
      }
      console.warn(`[reportDataSource] ${label} scan ${from}-${to} failed:`, msg)
      from = to + 1
    }
  }
  return out
}

/**
 * Build the on-chain report data source for the active network.
 *
 * @param {object} [opts]
 * @param {number} [opts.chainId] - active chain id
 * @param {object} [opts.provider] - read-provider override (testing); defaults to the chain seam for `chainId`
 * @param {object} [opts.contract] - escrow contract override (testing)
 * @param {object} [opts.repository] - WagerRepository override (testing)
 * @returns {object} dataSource
 */
export function createReportDataSource(opts = {}) {
  const provider = getProvider(opts)
  const chainId = opts.chainId
  const repository = opts.repository || getDefaultWagerRepository(chainId)
  const subgraphUrl = getSubgraphUrl(chainId)
  // wagerId → createdAt (unix seconds), captured during enumeration for windowing.
  const createdAtById = new Map()

  let escrow = null
  let contract = null
  let chainCtx = null
  const ensureContract = () => {
    if (!contract) {
      escrow = resolveEscrow(chainId)
      contract = opts.contract || seamScanContract(chainId, escrow)
    }
    return contract
  }
  const ensureChainCtx = async () => {
    if (!chainCtx) {
      const latestBlock = await provider.getBlockNumber()
      const block = await provider.getBlock(latestBlock)
      chainCtx = {
        latestBlock,
        latestSec: Number(block?.timestamp ?? Math.floor(Date.now() / 1000)),
        blockTimeSec: BLOCK_TIME_SEC[Number(chainId)] || 2,
        deployBlock: escrow.deployBlock || 0,
      }
    }
    return chainCtx
  }

  return {
    /**
     * Primary report path (spec 017): all of the user's transfers — with txHash,
     * from/to, amount, token, direction, and timestamp — in one indexed query,
     * time-ordered. Returns null when no subgraph is configured so the caller can
     * fall back to the bounded enumerate + scan path (#703). NO log scans here.
     */
    async listTransfers({ account }) {
      if (!account) return []
      if (!subgraphConfigured(chainId)) return null
      const party = String(account).toLowerCase()
      const all = []
      const pageSize = 1000
      for (let skip = 0; skip < 100_000; skip += pageSize) {
        const data = await postSubgraph(subgraphUrl, WAGER_TRANSFERS_QUERY, { party, first: pageSize, skip })
        const rows = data?.wagerTransfers || []
        all.push(...rows.map(transferToPreItem))
        if (rows.length < pageSize) break
      }
      return all
    },

    async enumerateWagers({ account }) {
      if (!account) return []
      // No subgraph throw here: the repository enumerates v2 wagers over RPC
      // (RegistrySource) on networks without an indexer, so reporting still
      // works — just with on-chain event windowing instead of indexed rows.
      const all = []
      let cursor = null
      for (let page = 0; page < 200; page++) {
        const res = await repository.listMyWagers({
          userAddress: account,
          cursor,
          pageSize: 100,
          filter: { includeExpired: true },
        })
        // Only the retired EventsSource (legacy FriendGroupMarketFactory) cannot
        // serve v2 reporting. The 'registry' source and the 'subgraph-fallback'
        // (which now resolves to RegistrySource over RPC) are both valid.
        if (res.source === 'events') {
          throw new Error('Wager reporting is temporarily unavailable for this network.')
        }
        all.push(...(res.items || []))
        if (!res.hasMore || !res.nextCursor) break
        cursor = res.nextCursor
      }
      for (const w of all) {
        createdAtById.set(String(w.id), Math.floor((Number(w.createdAt) || 0) / 1000))
      }
      return all.map((w) => ({
        id: String(w.id),
        creator: w.creator,
        participants: w.participants || [],
        stakeTokenAddress: w.stakeTokenAddress,
        stakeAmount: w.stakeAmount,
      }))
    },

    async getWagerEvents(wagerId) {
      if (import.meta.env?.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') return []
      const c = ensureContract()
      const ctx = await ensureChainCtx()
      const createdSec = createdAtById.get(String(wagerId)) || 0
      // Tight window: from shortly before the wager was created to the chain head.
      const fromBlock = createdSec > 0 ? estimateBlock(createdSec - PRE_WINDOW_SEC, ctx) : ctx.deployBlock
      const toBlock = ctx.latestBlock
      const budget = { used: 0, max: SCAN_BUDGET }
      const out = []
      for (const name of escrow.valueEvents) {
        const filter = c.filters[name](wagerId)
        const logs = await scanAdaptive(c, filter, fromBlock, toBlock, name, budget)
        for (const ev of logs) out.push(normalizeEvent(ev))
      }
      return out.sort((a, b) => a.blockNumber - b.blockNumber)
    },

    async getBlock(blockNumber) {
      const block = await provider.getBlock(Number(blockNumber))
      return block ? { timestamp: Number(block.timestamp) } : null
    },

    async getTransactionReceipt(txHash) {
      const r = await provider.getTransactionReceipt(txHash)
      if (!r) return null
      return {
        from: r.from,
        gasUsed: r.gasUsed,
        effectiveGasPrice: r.gasPrice ?? r.effectiveGasPrice,
        blockNumber: r.blockNumber,
      }
    },
  }
}
