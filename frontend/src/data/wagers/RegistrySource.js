/**
 * RegistrySource — WagerSource implementation backed by direct RPC reads of
 * the v2 `WagerRegistry`.
 *
 * This is the data path for networks that have NO subgraph (e.g. Ethereum
 * Classic Mordor, local Hardhat). It replaces the legacy `EventsSource`, which
 * read the deprecated `FriendGroupMarketFactory` and is not deployed on those
 * networks.
 *
 * It uses the registry's purpose-built pagination views — `getUserWagerCount`,
 * `getUserWagerIds`, `getUserWagers`, `getWager` — so there is no `eth_getLogs`
 * block-range scanning. Public RPCs that reject wide `eth_getLogs` windows
 * (Amoy, Mordor) are handled the same way `blockchainService.fetchWagersForUserV2`
 * already does for the Quick Start dashboard.
 *
 * The mapped shape mirrors `SubgraphSource.toWager` so the UI is agnostic to
 * which source produced a page. The chain id is threaded through every call so
 * a wallet on testnet never reads mainnet wagers (or vice versa).
 */

import { zeroAddress } from 'viem'
import { getContractAddressForChain } from '../../config/contracts'
import { getCurrentChainId } from '../../config/networks'
import { readContract } from '../../lib/chains/readContract'
import { WAGER_REGISTRY_ABI } from '../../abis/WagerRegistry'
import { upsertCache } from './cacheStore'
import { applyFilters, paginate } from './sortFilter'
import { WagerSortKey } from '../../constants/wagerDefaults'

// IWagerRegistry.Status enum order (contracts/interfaces/IWagerRegistry.sol):
//   None, Open, Active, Resolved, Cancelled, Refunded, Draw
// Mapped to the lowercase string statuses the subgraph emits and the UI's
// sort/filter helpers understand. `None` should not occur for a real wager;
// it is treated as `open` defensively.
const STATUS_BY_ENUM = [
  'open', // None
  'open', // Open
  'active', // Active
  'resolved', // Resolved
  'cancelled', // Cancelled
  'refunded', // Refunded
  'drawn', // Draw
]

// Cap the number of wagers pulled per user in a single read so a pathological
// account can't stall the UI. Pagination/sort happens client-side over this
// bounded set, exactly like the events-backed source did.
const MAX_USER_WAGERS = 500
const PAGE = 100

function resolveChainId(chainId) {
  return chainId != null ? chainId : getCurrentChainId()
}

/**
 * A reader bound to ONE chain's registry (spec 110). The chain is the argument it always
 * should have been: this file's own header is about a testnet wallet never reading mainnet
 * wagers, and that is now a property of the call rather than of a provider built alongside it.
 */
function getRegistry(chainId) {
  const address = getContractAddressForChain('wagerRegistry', chainId)
  if (!address) {
    throw new Error(`wagerRegistry not deployed on chain ${chainId}`)
  }
  const call = (functionName) => (...args) =>
    readContract(chainId, { address, abi: WAGER_REGISTRY_ABI, functionName, args })
  return {
    getUserWagerCount: call('getUserWagerCount'),
    getUserWagerIds: call('getUserWagerIds'),
    getUserWagers: call('getUserWagers'),
    getWager: call('getWager'),
  }
}

function toWager(id, raw) {
  const metadataUri = raw.metadataUri || ''
  const isIpfs = Boolean(metadataUri && String(metadataUri).startsWith('ipfs://'))
  const ipfsCid = isIpfs ? String(metadataUri).slice('ipfs://'.length) : null

  const opponent = raw.opponent && raw.opponent !== zeroAddress ? raw.opponent : null
  const winner = raw.winner && raw.winner !== zeroAddress ? raw.winner : null
  const status = STATUS_BY_ENUM[Number(raw.status)] || 'open'

  // v2 carries explicit accept/resolve deadlines on-chain (the subgraph does
  // not), so RegistrySource can populate timing directly — no rehydration
  // round-trip is needed for the deadlines. Description/decryption still loads
  // lazily from the metadata reference.
  const resolveDeadlineMs = Number(raw.resolveDeadline || 0) * 1000

  return {
    id: String(id),
    // v2 WagerRegistry is always 1v1.
    marketType: 'oneVsOne',
    status,
    resolutionType: Number(raw.resolutionType ?? 0),
    creator: raw.creator,
    opponent,
    participants: [raw.creator, opponent].filter(Boolean).map((p) => String(p).toLowerCase()),
    arbitrator:
      raw.arbitrator && raw.arbitrator !== zeroAddress ? raw.arbitrator : null,
    // Raw integer token units, matching SubgraphSource (formatting happens in
    // the card using the token's decimals).
    stakeAmount: String(raw.creatorStake ?? 0),
    creatorStake: String(raw.creatorStake ?? 0),
    opponentStake: String(raw.opponentStake ?? 0),
    stakeTokenAddress: raw.token,
    stakeTokenSymbol: null,
    // No creation timestamp is stored on-chain; the detail view rehydrates the
    // human-readable created date when needed.
    createdAt: 0,
    acceptDeadline: Number(raw.acceptDeadline || 0) * 1000,
    resolveDeadline: resolveDeadlineMs,
    // endTime drives the list's expiry gate; leave it unset (0) to match
    // SubgraphSource so a past resolve deadline never silently hides a wager.
    // The deadlines above remain available to the detail view.
    endTime: 0,
    resolvedAt: null,
    winner,
    metadataUri: metadataUri || null,
    metadataHash: raw.metadataHash || null,
    ipfsCid,
    needsIpfsFetch: isIpfs,
    description: '',
    isEncrypted: false,
    // Description/metadata is fetched lazily; the deadlines above are already
    // authoritative, so this only drives the description hydration.
    needsRehydration: true,
  }
}

async function fetchAllForUser(contract, userAddress) {
  const total = Number(await contract.getUserWagerCount(userAddress))
  if (!total) return []
  const count = Math.min(total, MAX_USER_WAGERS)

  const wagers = []
  for (let offset = 0; offset < count; offset += PAGE) {
    const limit = Math.min(PAGE, count - offset)
    const [ids, structs] = await Promise.all([
      contract.getUserWagerIds(userAddress, offset, limit),
      contract.getUserWagers(userAddress, offset, limit),
    ])
    for (let i = 0; i < ids.length; i++) {
      wagers.push(toWager(String(ids[i]), structs[i]))
    }
  }
  return wagers
}

export async function syncIndex(_userAddress) {
  // The registry exposes per-user pagination directly, so there is no client
  // watermark to maintain. Return an empty index for interface parity.
  return { marketIds: [], lastBlock: 0 }
}

export async function listPage({
  userAddress,
  cursor,
  pageSize = 25,
  sortKey = WagerSortKey.CREATED,
  filter,
  chainId,
}) {
  if (!userAddress) {
    return { items: [], nextCursor: null, hasMore: false, totalKnown: 0, source: 'registry' }
  }
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') {
    return { items: [], nextCursor: null, hasMore: false, totalKnown: 0, source: 'registry' }
  }

  const cid = resolveChainId(chainId)
  const contract = getRegistry(cid)

  const all = await fetchAllForUser(contract, userAddress)
  if (all.length) upsertCache(userAddress, all)

  const filtered = applyFilters(all, { ownerAddress: userAddress, ...filter })
  const page = paginate(filtered, { cursor, pageSize, sortKey })
  return { ...page, source: 'registry' }
}

export async function getById(id, userAddress, opts = {}) {
  if (!id) return null
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') return null

  const cid = resolveChainId(opts.chainId)
  const contract = getRegistry(cid)

  try {
    const raw = await contract.getWager(id)
    // An unset wager returns a zero-address creator.
    if (!raw?.creator || raw.creator === zeroAddress) return null
    const wager = toWager(String(id), raw)
    if (userAddress) upsertCache(userAddress, [wager])
    return wager
  } catch (err) {
    console.warn(`[RegistrySource] getById ${id} failed:`, err?.message)
    return null
  }
}
