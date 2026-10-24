/**
 * EventsSource — WagerSource implementation backed by direct RPC calls.
 *
 * Discovery: scans MemberAdded events indexed by member address, with an
 * incremental block watermark cached in localStorage. Lifted from the legacy
 * `discoverMarketIds` in blockchainService.js, now using cacheStore.
 *
 * Hydration: fetches a bounded page via parallel contract reads
 * (getFriendMarketWithStatus + friendMarkets), then assembles a Wager
 * object with the corrected `endTime = createdAt + tradingPeriodSeconds`.
 * The raw `description` (or IPFS reference) is preserved verbatim so the
 * envelope can be lazy-decrypted by `useLazyMarketDecryption`.
 */

import { zeroAddress } from 'viem'
import { getContractAddress, NETWORK_CONFIG, DEPLOYMENT_BLOCKS } from '../../config/contracts'
import { eventScanHandle } from '../../lib/chains/eventScan'
import { NoRpcEndpointError, readContract } from '../../lib/chains/readContract'
import { scanLogRange } from '../../lib/chain/logScan'
import { isAddress } from '../../lib/evm/address'
import { formatUnits } from '../../lib/evm/units'
import { DEX_ADDRESSES } from '../../constants/dex'
import { FRIEND_GROUP_MARKET_FACTORY_ABI } from '../../abis/FriendGroupMarketFactory'
import { parseEncryptedIpfsReference } from '../../utils/ipfsService'
import { loadIndex, saveIndex, loadCache, upsertCache } from './cacheStore'
import { applyFilters, paginate } from './sortFilter'
import { WagerSortKey, WAGER_DEFAULTS } from '../../constants/wagerDefaults'

const MARKET_TYPES = ['oneVsOne', 'smallGroup', 'eventTracking', 'propBet']
const STATUS_NAMES = [
  'pending_acceptance',
  'active',
  'pending_resolution',
  'challenged',
  'resolved',
  'cancelled',
  'refunded',
  'oracle_timed_out',
]

/**
 * This source reads the BUILD's chain and only that one — it always did, via
 * `NETWORK_CONFIG.rpcUrl`. Spec 110 names the chain rather than hand-building a transport from
 * that URL, which is the same chain by a route that honours the member's own endpoint and
 * failover (spec 069). Widening legacy v1 to multichain is deliberately NOT part of this: no live
 * network configures `friendGroupMarketFactory`, and `RegistrySource` is what replaced it.
 */
const SOURCE_CHAIN_ID = NETWORK_CONFIG.chainId

function factoryAddress() {
  const address = getContractAddress('friendGroupMarketFactory')
  if (!address) throw new Error('FriendGroupMarketFactory address not configured')
  return address
}

/**
 * The read facade the hydration path used to get from `new Contract(...)`. Both views are
 * MULTI-OUTPUT (14 and 22 outputs), which viem returns as a bare array; `readContract` re-attaches
 * the parameter names, so `toWager`'s field reads are unchanged. Their uint8/uint16 members decode
 * as NUMBERS rather than bigints and every one of them already goes through `Number(...)`.
 */
function getFactoryContract() {
  const address = factoryAddress()
  const call = (functionName, args) =>
    readContract(SOURCE_CHAIN_ID, { address, abi: FRIEND_GROUP_MARKET_FACTORY_ABI, functionName, args })
  return {
    getFriendMarketWithStatus: (id) => call('getFriendMarketWithStatus', [BigInt(id)]),
    friendMarkets: (id) => call('friendMarkets', [BigInt(id)]),
  }
}

function detectEncryption(description) {
  let metadata = null
  let isEncrypted = false
  let ipfsCid = null

  const ipfsRef = parseEncryptedIpfsReference(description)
  if (ipfsRef.isIpfs && ipfsRef.cid) {
    return {
      ipfsCid: ipfsRef.cid,
      isEncrypted: true,
      metadataCipher: null,
      displayDescription: 'Encrypted Market',
    }
  }

  try {
    const parsed = JSON.parse(description)
    const isV1 =
      parsed?.version === '1.0' &&
      parsed?.algorithm === 'x25519-chacha20poly1305' &&
      parsed?.content?.ciphertext &&
      Array.isArray(parsed?.keys)
    const isV2 =
      parsed?.version === '2.0' &&
      parsed?.algorithm === 'xwing-chacha20poly1305' &&
      parsed?.content?.ciphertext &&
      Array.isArray(parsed?.keys)
    if (isV1 || isV2) {
      metadata = parsed
      isEncrypted = true
    }
  } catch {
    // plain text description — leave as-is
  }

  return {
    ipfsCid,
    isEncrypted,
    metadataCipher: metadata,
    displayDescription: isEncrypted ? 'Encrypted Market' : description,
  }
}

function toWager(marketId, withStatus, full) {
  const stakeToken = withStatus.stakeToken
  const isStable =
    stakeToken && stakeToken.toLowerCase() === DEX_ADDRESSES?.STABLECOIN?.toLowerCase()
  const tokenDecimals = isStable ? 6 : 18

  const createdAtMs = Number(full?.createdAt || 0) * 1000
  const tradingPeriodSeconds = Number(full?.tradingPeriodSeconds || 0)
  const acceptanceDeadlineMs = Number(withStatus.acceptanceDeadline) * 1000

  let endTime
  if (createdAtMs > 0 && tradingPeriodSeconds > 0) {
    endTime = createdAtMs + tradingPeriodSeconds * 1000
  } else if (acceptanceDeadlineMs > 0) {
    endTime = acceptanceDeadlineMs
  } else {
    endTime = 0
  }

  const description = withStatus.description || ''
  const enc = detectEncryption(description)

  const members = (withStatus.members || []).map(m => m.toLowerCase())
  const arbitrator = withStatus.arbitrator
  const hasArbitrator = arbitrator && arbitrator !== zeroAddress

  return {
    id: String(marketId),
    marketType: MARKET_TYPES[Number(withStatus.marketType)] || 'oneVsOne',
    status: STATUS_NAMES[Number(withStatus.status)] || 'pending_acceptance',
    resolutionType: Number(withStatus.resolutionType ?? 0),
    creator: withStatus.creator,
    participants: members,
    arbitrator: hasArbitrator ? arbitrator : null,
    stakeAmount: formatUnits(withStatus.stakePerParticipant || 0, tokenDecimals),
    stakeTokenAddress: stakeToken,
    stakeTokenSymbol: isStable ? 'USDC' : 'POL',
    tradingPeriodSeconds,
    createdAt: createdAtMs,
    acceptanceDeadline: acceptanceDeadlineMs,
    endTime,
    endDate: endTime > 0 ? new Date(endTime).toISOString() : null,
    // Canonical timing pair (mirrors blockchainService.toWagerShape) so the
    // detail/list views show a consistent end across data sources. `endTime`
    // here is the resolution-open time E (createdAt + tradingPeriodSeconds);
    // resolution closes 48h later.
    tradingEndTime: endTime > 0 ? endTime : undefined,
    resolveDeadlineTime: endTime > 0
      ? endTime + (WAGER_DEFAULTS.RESOLUTION_WINDOW_SECONDS || 48 * 3600) * 1000
      : undefined,
    acceptedCount: Number(withStatus.acceptedCount || 0),
    minAcceptanceThreshold: Number(withStatus.minThreshold || 0),
    ipfsCid: enc.ipfsCid,
    isEncrypted: enc.isEncrypted,
    metadataCipher: enc.metadataCipher,
    description: enc.displayDescription,
    needsIpfsFetch: Boolean(enc.ipfsCid),
    needsRehydration: false,
  }
}

export async function syncIndex(userAddress) {
  if (!userAddress || !isAddress(userAddress)) {
    return { marketIds: [], lastBlock: 0 }
  }
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') {
    return { marketIds: [], lastBlock: 0 }
  }

  const scan = eventScanHandle(SOURCE_CHAIN_ID, {
    address: factoryAddress(),
    abi: FRIEND_GROUP_MARKET_FACTORY_ABI,
  })
  if (!scan) throw new NoRpcEndpointError(SOURCE_CHAIN_ID)
  const cached = loadIndex(userAddress)
  const currentBlock = await scan.runner.provider.getBlockNumber()

  if (cached.lastBlock >= currentBlock) return cached

  const deployBlock = DEPLOYMENT_BLOCKS.friendGroupMarketFactory || 0
  const fromBlock = cached.lastBlock > 0 ? cached.lastBlock + 1 : deployBlock
  const ids = new Set(cached.marketIds.map(String))

  /*
   * This used to hand-roll the chunking that `lib/chain/logScan` owns — 10k windows with a 1k
   * retry — and differed from it in one consequential way: a sub-chunk that still failed was
   * SKIPPED, and the watermark was then saved at `currentBlock` anyway. A range that failed twice
   * therefore became a permanent hole in the member's wager list, indistinguishable from having no
   * wagers in those blocks, with only a `console.warn` to show for it. `scanLogRange` keeps the
   * same window sizes and the same narrowing retry, and THROWS when a sub-chunk cannot be read —
   * so the watermark below is never saved over an unread range and the next call retries it.
   */
  const logs = await scanLogRange({
    provider: scan.runner.provider,
    address: factoryAddress(),
    topics: await scan.filters.MemberAdded(null, userAddress).getTopicFilter(),
    fromBlock,
    toBlock: currentBlock,
  })
  for (const log of logs) {
    const { args } = scan.interface.parseLog({ topics: [...log.topics], data: log.data })
    ids.add(String(args.friendMarketId))
  }

  const next = { marketIds: Array.from(ids), lastBlock: currentBlock }
  saveIndex(userAddress, next)
  return next
}

async function hydrate(contract, ids) {
  if (!ids.length) return []
  const results = await Promise.all(
    ids.map(async id => {
      try {
        const [withStatus, full] = await Promise.all([
          contract.getFriendMarketWithStatus(id),
          contract.friendMarkets(id),
        ])
        return toWager(id, withStatus, full)
      } catch (err) {
        console.warn(`[EventsSource] hydrate ${id} failed:`, err?.message)
        return null
      }
    })
  )
  return results.filter(Boolean)
}

export async function listPage({
  userAddress,
  cursor,
  pageSize = 25,
  sortKey = WagerSortKey.CREATED,
  filter,
}) {
  if (!userAddress) {
    return { items: [], nextCursor: null, hasMore: false, totalKnown: 0, source: 'events' }
  }
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') {
    return { items: [], nextCursor: null, hasMore: false, totalKnown: 0, source: 'events' }
  }

  const contract = getFactoryContract()

  await syncIndex(userAddress)
  const index = loadIndex(userAddress)
  const cache = loadCache(userAddress)

  const knownIds = index.marketIds
  const missing = knownIds.filter(id => !cache[id] || cache[id].needsRehydration)
  if (missing.length) {
    const fresh = await hydrate(contract, missing.slice(0, Math.max(pageSize * 4, 50)))
    if (fresh.length) upsertCache(userAddress, fresh)
  }

  const updatedCache = loadCache(userAddress)
  const allWagers = knownIds.map(id => updatedCache[id]).filter(Boolean)

  const filtered = applyFilters(allWagers, {
    ownerAddress: userAddress,
    ...filter,
  })
  const page = paginate(filtered, { cursor, pageSize, sortKey })
  return { ...page, source: 'events' }
}

export async function getById(id, userAddress) {
  if (!id || !userAddress) return null
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') return null
  const contract = getFactoryContract()
  const wagers = await hydrate(contract, [String(id)])
  const wager = wagers[0] || null
  if (wager) upsertCache(userAddress, [wager])
  return wager
}

export async function fetchAllCompat(userAddress) {
  if (!userAddress || !isAddress(userAddress)) return []
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') return []

  const contract = getFactoryContract()
  await syncIndex(userAddress)
  const index = loadIndex(userAddress)
  const cache = loadCache(userAddress)
  const missing = index.marketIds.filter(id => !cache[id] || cache[id].needsRehydration)
  const fresh = await hydrate(contract, missing)
  if (fresh.length) upsertCache(userAddress, fresh)
  const updatedCache = loadCache(userAddress)
  return index.marketIds.map(id => updatedCache[id]).filter(Boolean)
}
