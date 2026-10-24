/**
 * Blockchain Service
 * 
 * Handles all direct interactions with smart contracts on the blockchain.
 * Provides a clean interface for fetching data from deployed contracts.
 */

import { encodeFunctionData, keccak256, stringToHex, zeroAddress, zeroHash } from 'viem'
import { getContractAddress, getContractAddressForChain, NETWORK_CONFIG, DEPLOYMENT_BLOCKS, DEPLOYED_CONTRACTS } from '../config/contracts'
import { getNetwork, membershipChainId } from '../config/networks'
import { makeReadProvider } from './rpcProvider'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { eventScanHandle } from '../lib/chains/eventScan'
import { formatUnits, parseUnits } from '../lib/evm/units'
import { isAddress, getAddress } from '../lib/evm/address'
import { ERC20_ABI } from '../abis/ERC20'
import { DEX_ADDRESSES } from '../constants/dex'
import { WAGER_DEFAULTS, deriveWagerType } from '../constants/wagerDefaults'
import { FRIEND_GROUP_MARKET_FACTORY_ABI } from '../abis/FriendGroupMarketFactory'
import { WAGER_REGISTRY_ABI } from '../abis/WagerRegistry'
import { MEMBERSHIP_MANAGER_ABI } from '../abis/MembershipManager'
import {
  parseEncryptedIpfsReference
} from './ipfsService'

// Constants for friend market detection
const FRIEND_MARKET_PROPOSAL_MIN = 1_000_000
const FRIEND_MARKET_PROPOSAL_MAX = 10_000_000_000 // 10 billion

/**
 * Check if a market is a private friend market
 * Uses multiple detection methods for backward compatibility:
 * 1. Encrypted metadata (new method)
 * 2. Market Source attribute in metadata
 * 3. ProposalId range fallback (legacy)
 *
 * @param {Object} market - Market object with metadata
 * @returns {boolean} True if this is a friend/private market
 */
export function isMarketPrivateOrFriend(market) {
  const metadata = market.metadata

  // Method 1: Check for encrypted metadata
  if (metadata?.encrypted === true) {
    return true
  }

  // Method 2: Check Market Source attribute
  const marketSourceAttr = metadata?.attributes?.find(
    attr => attr.trait_type === 'Market Source'
  )
  if (marketSourceAttr?.value === 'friend') {
    return true
  }

  // Method 3: Fallback to proposalId range (legacy markets)
  if (market.proposalId >= FRIEND_MARKET_PROPOSAL_MIN &&
      market.proposalId < FRIEND_MARKET_PROPOSAL_MAX) {
    return true
  }

  return false
}

/**
 * Get a human-readable reason why a market is considered private/friend
 * Useful for debugging
 *
 * @param {Object} market - Market object
 * @returns {string} Description of why market is private
 */
export function getMarketPrivacyReason(market) {
  const metadata = market.metadata

  if (metadata?.encrypted === true) {
    return 'encrypted metadata'
  }

  const marketSourceAttr = metadata?.attributes?.find(
    attr => attr.trait_type === 'Market Source'
  )
  if (marketSourceAttr?.value === 'friend') {
    return 'Market Source: friend'
  }

  if (market.proposalId >= FRIEND_MARKET_PROPOSAL_MIN &&
      market.proposalId < FRIEND_MARKET_PROPOSAL_MAX) {
    return `proposalId in friend range (${market.proposalId})`
  }

  return 'unknown'
}

/**
 * Check if the current user can view a market
 * For encrypted markets, checks if user is in participants list
 *
 * @param {Object} market - Market object with metadata
 * @param {string} userAddress - Current user's address (lowercase)
 * @returns {boolean} True if user can view the market
 */
export function canUserViewMarket(market, userAddress) {
  const metadata = market.metadata

  // Not encrypted - anyone can view
  if (!metadata?.encrypted) {
    return true
  }

  // Encrypted - check if user is a participant
  const normalizedAddress = userAddress?.toLowerCase()
  return metadata.participants?.includes(normalizedAddress) || false
}

/**
 * Get a provider for reading from the blockchain
 * @param {number} [chainId] - Optional chain id. When supplied, returns a
 *   provider pointed at that chain's RPC (from networks.js) so reads target
 *   the user's selected network rather than the build-time default.
 * @returns {ethers.JsonRpcProvider}
 */
export function getProvider(chainId) {
  if (chainId != null) {
    const net = getNetwork(chainId)
    if (net?.rpcUrl) return makeReadProvider(net.rpcUrl, chainId)
  }
  return makeReadProvider(NETWORK_CONFIG.rpcUrl, NETWORK_CONFIG.chainId)
}

/**
 * The chain a read is made on when the caller could not name one.
 *
 * Spec 110: reads go through `readContract(chainId, …)`, which never has an ambient chain — so
 * the `chainId == null` case every caller here already had (a disconnected wallet, a provider
 * that would not report a network) needs the same build-time answer the address resolvers give
 * it. `getContractAddressForChain(name, null)` falls back to the build chain, so resolving the
 * ADDRESS and reading the CHAIN must fall back to the same place or a read would be aimed at a
 * different network than the address came from.
 */
function readChain(chainId) {
  return chainId != null ? Number(chainId) : NETWORK_CONFIG.chainId
}

/** MembershipManager read on a NAMED chain. */
const askMembership = (chainId, address, functionName, args) =>
  readContract(chainId, { address, abi: MEMBERSHIP_MANAGER_ABI, functionName, args })

/** ERC-20 read on a NAMED chain. */
const askToken = (chainId, address, functionName, args) =>
  readContract(chainId, { address, abi: ERC20_ABI, functionName, args })

/**
 * Fetch and resolve market metadata from IPFS
 * Called on-demand when viewing a specific market to avoid rate limiting
 * @param {string} metadataUri - IPFS URI or URL to fetch
 * @returns {Promise<Object|null>} Metadata or null
 */
export async function fetchMarketMetadataFromUri(metadataUri) {
  if (!metadataUri) return null
  try {
    const { resolveUri } = await import('./ipfsService')
    const metadata = await resolveUri(metadataUri)
    return metadata
  } catch (error) {
    console.warn(`Failed to fetch market metadata from ${metadataUri}:`, error.message)
    return null
  }
}

// --- Event-based market index cache ---
const MARKET_INDEX_PREFIX = 'friendMarketIndex_'
const MARKET_CACHE_PREFIX = 'friendMarketCache_'

/**
 * Load cached market index for a user (market IDs + last indexed block)
 */
function loadMarketIndex(userAddress) {
  try {
    const key = MARKET_INDEX_PREFIX + userAddress.toLowerCase()
    const stored = localStorage.getItem(key)
    if (!stored) return { marketIds: [], lastBlock: 0 }
    return JSON.parse(stored)
  } catch {
    return { marketIds: [], lastBlock: 0 }
  }
}

/**
 * Save market index to localStorage
 */
function saveMarketIndex(userAddress, index) {
  try {
    const key = MARKET_INDEX_PREFIX + userAddress.toLowerCase()
    localStorage.setItem(key, JSON.stringify(index))
  } catch (e) {
    console.warn('[MarketIndex] Failed to save index:', e)
  }
}

/**
 * Load cached market details
 */
function loadMarketCache(userAddress) {
  try {
    const key = MARKET_CACHE_PREFIX + userAddress.toLowerCase()
    const stored = localStorage.getItem(key)
    if (!stored) return {}
    return JSON.parse(stored)
  } catch {
    return {}
  }
}

/**
 * Save market details cache
 */
function saveMarketCache(userAddress, cache) {
  try {
    const key = MARKET_CACHE_PREFIX + userAddress.toLowerCase()
    localStorage.setItem(key, JSON.stringify(cache))
  } catch (e) {
    console.warn('[MarketIndex] Failed to save cache:', e)
  }
}

/**
 * Discover market IDs for a user via MemberAdded events (indexed by member address).
 * Uses incremental block scanning with a cached watermark.
 */
async function discoverMarketIds(handle, userAddress) {
  const index = loadMarketIndex(userAddress)
  const currentBlock = await handle.provider.getBlockNumber()

  // If we have a cached index and it's recent, just return it
  if (index.lastBlock >= currentBlock) {
    console.log(`[MarketIndex] Index up to date at block ${index.lastBlock}, ${index.marketIds.length} markets`)
    return index.marketIds
  }

  // Scan from last indexed block + 1, or contract deployment block on first run
  const deployBlock = DEPLOYMENT_BLOCKS.friendGroupMarketFactory || 0
  const fromBlock = index.lastBlock > 0 ? index.lastBlock + 1 : deployBlock
  console.log(`[MarketIndex] Scanning MemberAdded events from block ${fromBlock} to ${currentBlock}`)

  // Query MemberAdded events where member = userAddress (indexed topic). The handle's `filters`
  // proxy builds the same topic array ethers' filter factory did (trailing "any" slots trimmed);
  // `queryFilter` is the one piece of the ethers Contract surface it does not carry, so the two
  // lines it stood for are written out here.
  const memberAddedTopics = handle.filters.MemberAdded(null, userAddress).getTopicFilter()
  const queryFilter = async (fromBlock, toBlock) => {
    const logs = await handle.provider.getLogs({
      address: handle.target,
      topics: memberAddedTopics,
      fromBlock,
      toBlock,
    })
    return logs.map((log) => handle.interface.parseLog(log))
  }

  // Scan in chunks to avoid RPC limits (10k blocks per query)
  const CHUNK_SIZE = 10000
  const newMarketIds = new Set(index.marketIds.map(id => id.toString()))
  let scanFrom = fromBlock

  while (scanFrom <= currentBlock) {
    const scanTo = Math.min(scanFrom + CHUNK_SIZE - 1, currentBlock)
    try {
      const events = await queryFilter(scanFrom, scanTo)
      for (const event of events) {
        const marketId = event.args.friendMarketId.toString()
        newMarketIds.add(marketId)
      }
    } catch (err) {
      console.warn(`[MarketIndex] Error scanning blocks ${scanFrom}-${scanTo}:`, err.message)
      // On error, try smaller chunks
      if (CHUNK_SIZE > 1000) {
        const smallChunk = 1000
        for (let s = scanFrom; s <= scanTo; s += smallChunk) {
          const e = Math.min(s + smallChunk - 1, scanTo)
          try {
            const events = await queryFilter(s, e)
            for (const event of events) {
              newMarketIds.add(event.args.friendMarketId.toString())
            }
          } catch {
            console.warn(`[MarketIndex] Skipping blocks ${s}-${e}`)
          }
        }
      }
    }
    scanFrom = scanTo + 1
  }

  const allIds = Array.from(newMarketIds)
  saveMarketIndex(userAddress, { marketIds: allIds, lastBlock: currentBlock })
  console.log(`[MarketIndex] Index updated: ${allIds.length} markets (scanned ${fromBlock}-${currentBlock})`)
  return allIds
}

/**
 * Process raw market data into the standard market object format
 */
function processMarketResult(marketId, marketResult, acceptanceStatus, acceptances) {
  const marketTypes = ['oneVsOne', 'smallGroup', 'eventTracking', 'propBet']
  const statusNames = ['pending_acceptance', 'active', 'pending_resolution', 'challenged', 'resolved', 'cancelled', 'refunded', 'oracle_timed_out']

  const stakeToken = marketResult.stakeToken
  const isStable = stakeToken && stakeToken.toLowerCase() === DEX_ADDRESSES?.STABLECOIN?.toLowerCase()
  const tokenDecimals = isStable ? 6 : 18
  const stakeAmountFormatted = formatUnits(marketResult.stakePerParticipant, tokenDecimals)

  const arbitrator = marketResult.arbitrator
  const hasArbitrator = arbitrator && arbitrator !== zeroAddress

  // Safely parse timestamps. `getFriendMarketWithStatus` does not return
  // `tradingEndTime` — it returns `acceptanceDeadline`. Use that for
  // pending-acceptance wagers; otherwise fall back to a 30-day default
  // (the paginated path in data/wagers/EventsSource.js computes the
  // accurate value from createdAt + tradingPeriodSeconds).
  const acceptanceDeadlineMs = Number(marketResult.acceptanceDeadline) * 1000

  const now = new Date()
  const defaultEndDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  let endDateStr
  if (acceptanceDeadlineMs > 0 && Number(marketResult.status) === 0) {
    endDateStr = new Date(acceptanceDeadlineMs).toISOString()
  } else {
    endDateStr = defaultEndDate.toISOString()
  }

  // Check for encrypted metadata
  let description = marketResult.description
  let metadata = null
  let isEncryptedMarket = false
  let ipfsCid = null
  let needsIpfsFetch = false

  const ipfsRef = parseEncryptedIpfsReference(description)
  if (ipfsRef.isIpfs && ipfsRef.cid) {
    ipfsCid = ipfsRef.cid
    isEncryptedMarket = true
    needsIpfsFetch = true
    description = 'Encrypted Market'
  } else {
    try {
      const parsed = JSON.parse(description)
      const isV1Envelope = parsed?.version === '1.0' &&
          parsed?.algorithm === 'x25519-chacha20poly1305' &&
          parsed?.content?.ciphertext &&
          Array.isArray(parsed?.keys)
      const isV2Envelope = parsed?.version === '2.0' &&
          parsed?.algorithm === 'xwing-chacha20poly1305' &&
          parsed?.content?.ciphertext &&
          Array.isArray(parsed?.keys)

      if (isV1Envelope || isV2Envelope) {
        metadata = parsed
        isEncryptedMarket = true
        description = 'Encrypted Market'
      }
    } catch {
      // Not JSON, keep as plain description
    }
  }

  const members = marketResult.members || []

  return {
    id: marketId.toString(),
    description,
    metadata,
    isEncrypted: isEncryptedMarket,
    ipfsCid,
    needsIpfsFetch,
    creator: marketResult.creator,
    participants: members,
    arbitrator: hasArbitrator ? arbitrator : null,
    type: marketTypes[Number(marketResult.marketType)] || 'oneVsOne',
    status: statusNames[Number(marketResult.status)] || 'pending_acceptance',
    acceptanceDeadline: acceptanceDeadlineMs > 0 ? acceptanceDeadlineMs : now.getTime() + WAGER_DEFAULTS.ACCEPTANCE_DEADLINE_HOURS * 60 * 60 * 1000,
    minAcceptanceThreshold: Number(marketResult.minThreshold) || WAGER_DEFAULTS.MIN_ACCEPTANCE_THRESHOLD,
    stakeAmount: stakeAmountFormatted,
    stakeTokenAddress: stakeToken,
    stakeTokenSymbol: isStable ? 'USDC' : 'POL',
    acceptances,
    acceptedCount: Number(acceptanceStatus.accepted),
    endDate: endDateStr,
    createdAt: now.toISOString()
  }
}

/**
 * Fetch friend markets for a user from the blockchain.
 *
 * Uses event-based discovery (MemberAdded events) with incremental block scanning
 * instead of the old getUserMarkets() approach. This preserves privacy (no public
 * mapping of user -> markets) and optimizes lookups via cached block watermarks.
 *
 * @param {string} userAddress - User's wallet address
 * @returns {Promise<Array>} Array of friend market objects
 */
// Index-aligned with IWagerRegistry.sol `enum Status { None, Open, Active,
// Resolved, Cancelled, Refunded, Draw }`. Exported for regression testing
// (spec 012 T002 — Draw previously fell through to 'unknown').
export const WAGER_STATUS_NAMES = ['none', 'pending', 'active', 'resolved', 'cancelled', 'refunded', 'draw']

// Exported for regression testing (chain-aware stake-token decimals/symbol — a USDC wager on a non-default
// chain must not render as "0.000000000001 tokens").
export function toWagerShape(id, w, chainId) {
  const tokenAddr = w.token
  // Resolve the stake token against the CONNECTED chain's config — not the build-time DEPLOYED_CONTRACTS
  // (default chain 137). Otherwise a USDC wager on e.g. Mordor (63) fails the address match → defaults to
  // 18 decimals + 'tokens', rendering "0.000000000001 tokens" instead of the real USDC amount.
  const resolveToken = (name) =>
    chainId != null ? getContractAddressForChain(name, chainId) : (DEPLOYED_CONTRACTS?.[name] || '')
  const tl = tokenAddr ? tokenAddr.toLowerCase() : ''
  const paymentToken = (resolveToken('paymentToken') || '').toLowerCase()
  const wmatic = (resolveToken('wmatic') || '').toLowerCase()
  const isUSDC = !!tl && tl === paymentToken
  const isWrapped = !!tl && tl === wmatic
  const decimals = isUSDC ? 6 : 18
  // USDC → "USDC"; the wrapped-native stake token's symbol differs by chain (WETC on ETC/Mordor 61/63,
  // else WPOL); anything else falls back to "tokens".
  const isEtcChain = chainId != null && (Number(chainId) === 63 || Number(chainId) === 61)
  const stakeTokenSymbol = isUSDC ? 'USDC' : (isWrapped ? (isEtcChain ? 'WETC' : 'WPOL') : 'tokens')

  const metadataUri = w.metadataUri || ''
  const ipfsRef = parseEncryptedIpfsReference(metadataUri)
  const isEncrypted = ipfsRef.isIpfs
  const ipfsCid = ipfsRef.cid || null

  let description
  if (isEncrypted) {
    description = 'Encrypted Wager'
  } else if (metadataUri) {
    description = metadataUri
  } else {
    description = `Wager #${id}`
  }

  // v2 WagerRegistry has no marketType field — an Offer is encoded as
  // asymmetric stakes (creatorStake !== opponentStake). Derive the subtype and
  // the offered odds from the raw on-chain stakes so the table badge and the
  // acceptance modal reflect Offer terms instead of collapsing to even-money
  // 1v1. Derivation uses raw wei (ratio is decimals-independent).
  const { type: wagerType, oddsMultiplier } = deriveWagerType(w.creatorStake, w.opponentStake)

  return {
    id: String(id),
    creator: w.creator,
    opponent: w.opponent,
    arbitrator: (w.arbitrator && w.arbitrator !== zeroAddress) ? w.arbitrator : null,
    participants: [w.creator, w.opponent].filter(a => a && a !== zeroAddress),
    type: wagerType,
    oddsMultiplier,
    opponentOddsMultiplier: oddsMultiplier,
    creatorStake: formatUnits(w.creatorStake, decimals),
    opponentStake: formatUnits(w.opponentStake, decimals),
    stakeAmount: formatUnits(w.opponentStake, decimals),
    stakeToken: tokenAddr,
    stakeTokenAddress: tokenAddr,
    stakeTokenSymbol,
    resolutionType: Number(w.resolutionType),
    status: WAGER_STATUS_NAMES[Number(w.status)] || 'unknown',
    winner: (w.winner && w.winner !== zeroAddress) ? w.winner : null,
    paid: w.paid,
    acceptanceDeadline: Number(w.acceptDeadline) * 1000,
    endDate: new Date(Number(w.resolveDeadline) * 1000).toISOString(),
    // Explicit ms timestamps for the resolve-window gate (Bug #1):
    //   resolveDeadlineTime = on-chain resolveDeadline (resolution closes / refund opens)
    //   tradingEndTime      = resolveDeadline - 48h = the user's chosen end time `E`
    //                         (resolution opens). Resolution is only allowed in
    //                         [tradingEndTime, resolveDeadlineTime].
    resolveDeadlineTime: Number(w.resolveDeadline) * 1000,
    tradingEndTime: Number(w.resolveDeadline) * 1000 -
      (WAGER_DEFAULTS.RESOLUTION_WINDOW_SECONDS || 48 * 3600) * 1000,
    polymarketConditionId: w.polymarketConditionId,
    creatorIsYes: w.creatorIsYes,
    metadataHash: w.metadataHash,
    ipfsCid,
    isEncrypted,
    needsIpfsFetch: isEncrypted,
    description,
  }
}

async function fetchWagersForUserV2(userAddress, registryAddress, chainId) {
  const readChainId = readChain(chainId)
  const ask = (functionName, args) =>
    readContract(readChainId, { address: registryAddress, abi: WAGER_REGISTRY_ABI, functionName, args })

  // O(N_user) read via the contract's per-user EnumerableSet.UintSet index.
  // Avoids `eth_getLogs` — public RPCs (e.g. Polygon Amoy) reject `toBlock: 'latest'`
  // on the full deploy-to-tip range.
  const count = Number(await ask('getUserWagerCount', [userAddress]))
  if (count === 0) return []

  const PAGE = 100
  const wagers = []
  for (let offset = 0; offset < count; offset += PAGE) {
    const limit = Math.min(PAGE, count - offset)
    const [ids, structs] = await Promise.all([
      ask('getUserWagerIds', [userAddress, BigInt(offset), BigInt(limit)]),
      ask('getUserWagers', [userAddress, BigInt(offset), BigInt(limit)]),
    ])
    for (let i = 0; i < ids.length; i++) {
      wagers.push(toWagerShape(String(ids[i]), structs[i], chainId))
    }
  }
  return wagers
}

export async function fetchFriendMarketsForUser(userAddress, chainId) {
  // Skip blockchain calls in test environment
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') {
    return []
  }

  try {
    if (!userAddress || !isAddress(userAddress)) {
      return []
    }
    // Checksum ONCE, right after the check that let it through. `isAddress` accepts an
    // ALL-UPPERCASE address — ethers did, so this app does — and viem's encoder REFUSES one
    // (divergence 16), so a member whose address arrived uppercased would have passed validation
    // and then failed inside the read, with My Wagers reporting an error instead of their wagers.
    // The validator and the encoder move together.
    const member = getAddress(userAddress)

    // Read from the wallet's connected chain so a user on testnet isn't shown
    // mainnet wagers (or vice versa). Falls back to the build-time chain when no
    // chainId is supplied (disconnected/legacy callers).
    const resolve = (name) =>
      chainId != null ? getContractAddressForChain(name, chainId) : getContractAddress(name)
    // v2 path: WagerRegistry event scan
    const registryAddress = resolve('wagerRegistry')
    if (registryAddress) {
      return await fetchWagersForUserV2(member, registryAddress, chainId)
    }

    const friendFactoryAddress = resolve('friendGroupMarketFactory')

    if (!friendFactoryAddress) {
      console.warn('FriendGroupMarketFactory address not configured')
      return []
    }

    const legacyChainId = readChain(chainId)
    const handle = eventScanHandle(legacyChainId, {
      address: friendFactoryAddress,
      abi: FRIEND_GROUP_MARKET_FACTORY_ABI,
    })
    if (!handle) {
      console.warn(`[fetchFriendMarketsForUser] no RPC route for chain ${legacyChainId}`)
      return []
    }
    const askFactory = (functionName, args) =>
      readContract(legacyChainId, {
        address: friendFactoryAddress,
        abi: FRIEND_GROUP_MARKET_FACTORY_ABI,
        functionName,
        args,
      })

    // Step 1: Discover market IDs via events (incremental, cached)
    const marketIds = await discoverMarketIds(handle, member)
    console.log(`[fetchFriendMarketsForUser] Found ${marketIds.length} markets for ${userAddress}`)

    if (marketIds.length === 0) {
      return []
    }

    // Step 2: Load cached market details and determine which need refreshing
    const detailCache = loadMarketCache(userAddress)
    const terminalStatuses = new Set(['resolved', 'cancelled', 'refunded'])
    const idsToFetch = [] // Markets that need fresh data from chain
    const cachedMarkets = [] // Markets we can serve from cache

    for (const id of marketIds) {
      const cached = detailCache[id]
      if (cached && terminalStatuses.has(cached.status)) {
        // Terminal state markets don't change - serve from cache
        cachedMarkets.push(cached)
      } else {
        idsToFetch.push(id)
      }
    }

    console.log(`[fetchFriendMarketsForUser] ${cachedMarkets.length} cached (terminal), ${idsToFetch.length} need refresh`)

    // Step 3: Fetch fresh data for non-terminal markets in parallel
    const freshMarkets = await Promise.all(
      idsToFetch.map(async (marketId) => {
        try {
          // The id is a decimal STRING (it comes back through localStorage), and a decimal string
          // encodes identically in both libraries — but the EMPTY one does not: ethers refused it
          // and viem encodes it as 0 (divergence 15), which would read market #0 and cache the
          // answer under a corrupted key. `BigInt()` refuses exactly what ethers refused, inside
          // the same try, so a bad id still falls back to the cached market.
          const id = BigInt(marketId)
          const [marketResult, acceptedCount] = await Promise.all([
            askFactory('getFriendMarketWithStatus', [id]),
            askFactory('acceptedParticipantCount', [id]),
          ])
          const acceptanceStatus = { accepted: acceptedCount }

          // Determine token decimals for formatting
          const stakeToken = marketResult.stakeToken
          const isStable = stakeToken && stakeToken.toLowerCase() === DEX_ADDRESSES?.STABLECOIN?.toLowerCase()
          const tokenDecimals = isStable ? 6 : 18

          // Fetch acceptances for participants in parallel
          const members = marketResult.members || []
          const acceptances = {}

          const acceptanceResults = await Promise.all(
            members.map(async (member) => {
              try {
                const record = await askFactory('getParticipantAcceptance', [id, member])
                return {
                  address: member.toLowerCase(),
                  hasAccepted: record.hasAccepted,
                  stakedAmount: formatUnits(record.stakedAmount, tokenDecimals),
                  isArbitrator: record.isArbitrator
                }
              } catch {
                return null
              }
            })
          )

          for (const result of acceptanceResults) {
            if (result) {
              acceptances[result.address] = {
                hasAccepted: result.hasAccepted,
                stakedAmount: result.stakedAmount,
                isArbitrator: result.isArbitrator
              }
            }
          }

          return processMarketResult(marketId, marketResult, acceptanceStatus, acceptances)
        } catch (err) {
          console.error(`Error fetching market ${marketId}:`, err)
          // Fall back to cached version if available
          return detailCache[marketId] || null
        }
      })
    )

    // Step 4: Merge results and update cache
    const allMarkets = [...cachedMarkets, ...freshMarkets.filter(m => m !== null)]

    // Update the detail cache with fresh data
    const updatedCache = { ...detailCache }
    for (const market of allMarkets) {
      updatedCache[market.id] = market
    }
    saveMarketCache(userAddress, updatedCache)

    return allMarkets
  } catch (error) {
    console.error('Error fetching friend markets from blockchain:', error)
    throw error
  }
}

// Role name to on-chain role hash mapping.
// The protocol has a single paid role (WAGER_PARTICIPANT) plus four admin
// roles enforced via OpenZeppelin AccessControl. DEFAULT_ADMIN_ROLE is the
// zero hash by OpenZeppelin convention.
const ROLE_NAME_TO_HASH = {
  // Paid user role
  'WAGER_PARTICIPANT': keccak256(stringToHex('WAGER_PARTICIPANT_ROLE')),
  'Wager Participant': keccak256(stringToHex('WAGER_PARTICIPANT_ROLE')),
  // Admin roles
  'ADMIN': '0x0000000000000000000000000000000000000000000000000000000000000000', // DEFAULT_ADMIN_ROLE
  'GUARDIAN': keccak256(stringToHex('GUARDIAN_ROLE')),
  'ACCOUNT_MODERATOR': keccak256(stringToHex('ACCOUNT_MODERATOR_ROLE')),
  'ROLE_MANAGER': keccak256(stringToHex('ROLE_MANAGER_ROLE')),
  'SANCTIONS_ADMIN': keccak256(stringToHex('SANCTIONS_ADMIN_ROLE')),
  'FEE_ADMIN': keccak256(stringToHex('FEE_ADMIN_ROLE')),
  // STAKING_ADMIN_ROLE on the StakingRouter (spec 066). `ROLES.STAKING_ADMIN` has been
  // declared in RoleContext and read by `useAdminAccess` since that spec landed, but the
  // name was never added here — so `getRoleHash` returned undefined and every lookup took
  // the `absent()` branch. That is not merely the "Unknown role: STAKING_ADMIN" console
  // warning it presents as: an operator who genuinely holds the role was told they did not,
  // and the staking controls stayed hidden from the only people entitled to use them. A
  // missing entry must never read as a denied one.
  'STAKING_ADMIN': keccak256(stringToHex('STAKING_ADMIN_ROLE')),
  'LIQUIDITY_ADMIN': keccak256(stringToHex('LIQUIDITY_ADMIN_ROLE')),
}

// Membership tier enum values - matches TieredRoleManager contract
const MembershipTier = {
  NONE: 0,
  BRONZE: 1,
  SILVER: 2,
  GOLD: 3,
  PLATINUM: 4
}

// Export tier names for UI display
export const TIER_NAMES = {
  1: 'Bronze',
  2: 'Silver',
  3: 'Gold',
  4: 'Platinum'
}

// TierRegistry ABI for checking user tiers
const TIER_REGISTRY_ABI = [
  {
    "inputs": [
      { "internalType": "address", "name": "user", "type": "address" },
      { "internalType": "bytes32", "name": "role", "type": "bytes32" }
    ],
    "name": "getUserTier",
    "outputs": [{ "internalType": "enum TierRegistry.MembershipTier", "name": "", "type": "uint8" }],
    "stateMutability": "view",
    "type": "function"
  }
]


/**
 * Get user's current membership tier for a role from blockchain.
 *
 * ── READS THE MEMBERSHIP REFERENCE CHAIN, NOT THE WALLET'S (spec 071 FR-003) ─────────────────
 * Membership lives in exactly one place per environment cohort, so the `chainId` argument is
 * ignored for the MembershipManager path — see the matching note in `hasRoleOnChain`. It is
 * still honoured by the legacy TierRegistry fallback below, which predates the reference chain.
 *
 * ── AND `unknown` IS NOT `None` (FR-004) ────────────────────────────────────────────────────
 * A failed read used to return `{ tier: 0, tierName: 'None' }` — byte-identical to a genuine
 * "you have no membership". A member whose RPC blipped was therefore told they owned nothing.
 * The result now carries `readable`, and callers MUST NOT render `!readable` as "no membership".
 *
 * @param {string} userAddress - User's wallet address
 * @param {string} roleName - Role name or constant
 * @param {number} [chainId] - Only used by the legacy TierRegistry fallback
 * @returns {Promise<{tier: number, tierName: string, readable: boolean, reason: string|null}>}
 *          `readable: false` ⇒ tier is UNKNOWN, not zero.
 */
export async function getUserTierOnChain(userAddress, roleName, chainId) {
  const known = (tier, tierName) => ({ tier, tierName, readable: true, reason: null })
  const unknownTier = (reason) => ({ tier: 0, tierName: 'Unknown', readable: false, reason })

  // Skip blockchain calls in test environment
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') {
    return known(0, 'None')
  }

  // Legacy fallback only (see doc-comment); the v2 path below is reference-chain bound.
  const resolveAddress = (name) =>
    chainId != null ? getContractAddressForChain(name, chainId) : getContractAddress(name)

  // v2 path: MembershipManager.getActiveTier, always on the reference chain.
  const refChain = membershipChainId()
  const mmAddress = getContractAddressForChain('membershipManager', refChain)
  if (mmAddress) {
    try {
      const roleHash = getRoleHash(roleName)
      if (!roleHash) return known(0, 'None')
      const tier = Number(
        await askMembership(refChain, mmAddress, 'getActiveTier', [getAddress(userAddress), roleHash]),
      )
      const tierName = tier === 0 ? 'None' : (TIER_NAMES[tier] || 'Unknown')
      return known(tier, tierName)
    } catch (e) {
      // THE load-bearing line of FR-004: this used to return `None`, which is what a member with
      // no membership at all looks like. A reference chain that would not answer is not evidence
      // the member owns nothing.
      console.warn('[getUserTierOnChain v2] failed:', e.message)
      return unknownTier(e?.message || 'membership read failed')
    }
  }

  try {
    const tierRegistryAddress = resolveAddress('tierRegistry')
    if (!tierRegistryAddress) {
      console.warn('TierRegistry not deployed - cannot check user tier')
      return known(0, 'None')
    }

    const roleHash = getRoleHash(roleName)
    if (!roleHash) {
      console.warn(`Unknown role: ${roleName}`)
      return known(0, 'None')
    }

    const tier = await readContract(readChain(chainId), {
      address: tierRegistryAddress,
      abi: TIER_REGISTRY_ABI,
      functionName: 'getUserTier',
      args: [getAddress(userAddress), roleHash],
    })
    const tierNum = Number(tier)
    const tierName = tierNum === 0 ? 'None' : (TIER_NAMES[tierNum] || 'Unknown')

    return known(tierNum, tierName)
  } catch (error) {
    console.error('Error getting user tier:', error)
    return unknownTier(error?.message || 'tier read failed')
  }
}

/**
 * Get the role hash for a given role name
 * @param {string} roleName - Human readable role name or constant
 * @returns {string|null} Role hash or null if not found
 */
export function getRoleHash(roleName) {
  return ROLE_NAME_TO_HASH[roleName] || null
}

/**
 * Check if user has a role on-chain
 * Checks both the TierRegistry (modular RBAC) and RoleManager (legacy)
 * @param {string} userAddress - User's wallet address
 * @param {string} roleName - Role name or constant
 * @returns {Promise<boolean>} True if user has the role on-chain
 */
export async function hasRoleOnChain(userAddress, roleName, chainId, { detailed = false } = {}) {
  // `detailed` callers get to tell "not held" apart from "could not ask" (spec 071 FR-011).
  // Everyone else keeps the plain boolean this has always returned, so no existing caller
  // changes behaviour. An estate-wide sweep NEEDS the distinction: counting an unreachable
  // chain as "role not held" is how an operator gets locked out of the console by an RPC blip.
  //
  // THREE outcomes, not two (spec 071's read / not-deployed / unreadable). `absent` is the third:
  // there is no contract on this chain that could hold this role, so the answer is a DEPLOYMENT
  // fact settled from the address book without touching the network. Collapsing it into `held`
  // told the sweep that a chain had answered when nothing had been asked of it — see
  // `classifyEstateProbes`, which is what that mattered to.
  const held = (value) => (detailed ? { held: value, readable: true, deployed: true, reason: null } : value)
  const absent = () => (detailed ? { held: false, readable: true, deployed: false, reason: null } : false)
  const unread = (reason) =>
    (detailed ? { held: false, readable: false, deployed: true, reason } : false)

  // Skip blockchain calls in test environment
  if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') {
    return held(false)
  }

  const roleHash = getRoleHash(roleName)
  if (!roleHash) {
    console.warn(`Unknown role: ${roleName}`)
    return absent()
  }

  // Resolve addresses against the selected chain when one is given so a
  // membership on testnet is not read as active on mainnet (where the
  // MembershipManager isn't deployed) and vice versa.
  const resolveAddress = (name) =>
    chainId != null ? getContractAddressForChain(name, chainId) : getContractAddress(name)

  // ── MEMBERSHIP ALWAYS READS THE REFERENCE CHAIN (spec 071 FR-003) ─────────────────────────
  // Paid memberships (WAGER_PARTICIPANT) live in MembershipManager, gated by a (Tier, expiry)
  // pair. Membership exists in exactly ONE place per environment cohort — Polygon on mainnet,
  // Amoy on testnet — so reading it wherever the wallet happens to point reported every member
  // on Ethereum / Optimism / Base / Arbitrum / ETC as having no membership. They have one; the
  // lookup was aimed at chains it was never kept on.
  //
  // The caller's `chainId` is deliberately IGNORED here, and honoured in the admin-role branch
  // below, because admin roles genuinely ARE per-chain. Splitting at this seam means the rule is
  // enforced once rather than remembered at six call sites.
  if (roleName === 'WAGER_PARTICIPANT' || roleName === 'Wager Participant') {
    const refChain = membershipChainId()
    const mmAddress = getContractAddressForChain('membershipManager', refChain)
    if (!mmAddress) return absent()
    try {
      return held(
        Boolean(
          await askMembership(refChain, mmAddress, 'hasActiveRole', [getAddress(userAddress), roleHash]),
        ),
      )
    } catch (e) {
      console.warn('[hasRoleOnChain] membership read failed:', e.message)
      return unread(e?.message || 'membership read failed')
    }
  }

  // Admin roles use OpenZeppelin AccessControl.hasRole. ADMIN /
  // ACCOUNT_MODERATOR / GUARDIAN live on WagerRegistry; ROLE_MANAGER lives
  // on MembershipManager; SANCTIONS_ADMIN lives on SanctionsGuard.
  // DEFAULT_ADMIN_ROLE (ADMIN) is set on both core contracts — we check
  // WagerRegistry first because it's the canonical operator surface.
  const accessControlAbi = [
    'function hasRole(bytes32 role, address account) view returns (bool)'
  ]
  const candidates = []
  if (roleName === 'ROLE_MANAGER') {
    const addr = resolveAddress('membershipManager')
    if (addr) candidates.push(addr)
  } else if (roleName === 'SANCTIONS_ADMIN') {
    const addr = resolveAddress('sanctionsGuard')
    if (addr) candidates.push(addr)
  } else if (roleName === 'FEE_ADMIN') {
    // FEE_ADMIN lives on the FeeRouter (spec 060); no router deployed => nobody holds it here.
    const addr = resolveAddress('feeRouter')
    if (addr) candidates.push(addr)
  } else if (roleName === 'LIQUIDITY_ADMIN') {
    // LIQUIDITY_ADMIN_ROLE (spec 067) is defined independently on BOTH the
    // BridgeRouter and the LiquidityRouter, so it is resolved as "holds it on
    // at least one deployed router": undeployed routers are skipped rather
    // than treated as a denial (the loop below is an OR), and if neither is
    // deployed on this network nobody holds it here. The admin tabs then
    // re-check per-router before offering a write, so an operator who holds
    // the role on one router cannot be shown a control the other would revert.
    const bridge = resolveAddress('bridgeRouter')
    if (bridge) candidates.push(bridge)
    const liquidity = resolveAddress('liquidityRouter')
    if (liquidity) candidates.push(liquidity)
  } else {
    const wager = resolveAddress('wagerRegistry')
    if (wager) candidates.push(wager)
    if (roleName === 'ADMIN') {
      const mm = resolveAddress('membershipManager')
      if (mm) candidates.push(mm)
    }
    if (roleName === 'ADMIN' || roleName === 'GUARDIAN') {
      // The spec-067 routers define DEFAULT_ADMIN_ROLE and GUARDIAN_ROLE on THEMSELVES, and they
      // are deployed on networks that have no WagerRegistry at all — Ethereum, Optimism, Base and
      // Arbitrum carry the two routers and nothing else. Resolving these two roles only against the
      // WagerRegistry therefore returned false for EVERY account on four of the five spec-067
      // networks, including the account that actually holds the routers' killswitch, which hid the
      // Bridge/Supply tabs and their emergency pause from the one operator who could use them.
      //
      // As with LIQUIDITY_ADMIN above, this is an OR across deployed contracts and is a COARSE
      // entry signal only — "you are an admin/guardian of something here". It is not authority to
      // act on a particular router: the Bridge and Supply tabs read `hasRole` on the specific
      // router for the specific network in scope before offering any control (see
      // `readRouterAuthority`), because holding GUARDIAN on the WagerRegistry is not holding it on
      // the BridgeRouter.
      const bridge = resolveAddress('bridgeRouter')
      if (bridge) candidates.push(bridge)
      const liquidity = resolveAddress('liquidityRouter')
      if (liquidity) candidates.push(liquidity)
    }
  }
  // No candidate contract on this chain is a DEFINITE "no role here" — there is nothing to hold
  // a role on. But it is settled from the address book, not from the chain, so it reports
  // `deployed: false`: a sweep must not count it as the chain having answered. A candidate that
  // would not answer is a different thing again, tracked below.
  if (candidates.length === 0) return absent()
  let anyFailed = null
  for (const addr of candidates) {
    try {
      const yes = await readContract(readChain(chainId), {
        address: addr,
        abi: accessControlAbi,
        functionName: 'hasRole',
        args: [roleHash, getAddress(userAddress)],
      })
      if (yes) return held(true)
    } catch (e) {
      console.debug(`[hasRoleOnChain] AccessControl read failed on ${addr}:`, e.message)
      anyFailed = e?.message || 'AccessControl read failed'
    }
  }
  // A definite "no" only when every candidate actually answered. If one refused, the honest
  // answer is "could not tell" — a caller sweeping the estate must not record that as a denial.
  if (anyFailed) return unread(anyFailed)
  return held(false)
}

// PaymentProcessor ABI for role purchases (modular RBAC system)
const PAYMENT_PROCESSOR_ABI = [
  {
    "inputs": [
      { "internalType": "bytes32", "name": "role", "type": "bytes32" },
      { "internalType": "uint8", "name": "tier", "type": "uint8" },
      { "internalType": "address", "name": "paymentToken", "type": "address" },
      { "internalType": "uint256", "name": "amount", "type": "uint256" }
    ],
    "name": "purchaseTierWithToken",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "paymentManager",
    "outputs": [{ "internalType": "address", "name": "", "type": "address" }],
    "stateMutability": "view",
    "type": "function"
  }
]

/**
 * Purchase, upgrade, or extend a membership using the active chain's stablecoin.
 *
 * @param {ethers.Signer} signer - Connected wallet signer
 * @param {string} roleName - Name of the role being purchased
 * @param {number} priceUSD - Price in USD (converted to stablecoin units, 6 decimals)
 * @param {number} tier - Membership tier (1=Bronze, 2=Silver, 3=Gold, 4=Platinum), defaults to Bronze
 * @param {string} action - 'purchase' (default), 'upgrade', or 'extend'
 * @returns {Promise<Object>} Transaction receipt with roleGranted status
 */
export async function purchaseRoleWithStablecoin(signer, roleName, priceUSD, tier = MembershipTier.BRONZE, action = 'purchase', termsHash = null, onProgress = null) {
  if (!signer) {
    throw new Error('Wallet not connected')
  }

  // Spec 022: best-effort progress emission so the purchase modal can surface the
  // approve/pay sub-steps. MUST NOT change control flow or on-chain calls — a
  // throwing callback is swallowed.
  const emit = (step, phase, extra = {}) => {
    if (typeof onProgress !== 'function') return
    try { onProgress({ step, phase, ...extra }) } catch (e) { /* non-fatal */ void e }
  }

  // Resolve the MembershipManager for the wallet's CURRENT chain, not the
  // build-time chain. The network gate (isCorrectNetwork) accepts any supported
  // chain (Polygon 137, Amoy 80002, local 1337), so a wallet on e.g. Amoy must
  // use the Amoy deployment. Resolving the build-bound address instead would
  // point at a contract that doesn't exist on the connected chain and surface a
  // misleading "no purchase contract found" error.
  let walletChainId = null
  try {
    walletChainId = Number((await signer.provider.getNetwork()).chainId)
  } catch {
    // Provider without a network; getContractAddressForChain(null) falls back to
    // the build-time chain.
  }
  const mmAddress = getContractAddressForChain('membershipManager', walletChainId)
  if (mmAddress) {
    const provider = signer.provider
    const code = await provider.getCode(mmAddress)
    if (!code || code === '0x') {
      throw new Error(
        `No membership contract is deployed at ${mmAddress} on the connected network (chain ${walletChainId ?? 'unknown'}). ` +
          `Please switch your wallet to Polygon and try again.`
      )
    } else {
      const roleHash = getRoleHash(roleName)
      if (!roleHash) throw new Error(`Unknown role: ${roleName}`)
      const validTier = [1, 2, 3, 4].includes(tier) ? tier : MembershipTier.BRONZE
      const tierName = TIER_NAMES[validTier] || 'Bronze'

      // Spec 110: the pre-flight reads name the chain the purchase will settle on, so the member's
      // own endpoint (spec 069) serves them and an unreadable chain fails loudly instead of being
      // answered by whatever network the injected wallet's provider happened to be bound to.
      const chain = readChain(walletChainId)
      const paymentTokenAddr = await askMembership(chain, mmAddress, 'paymentToken', [])
      if (!paymentTokenAddr || paymentTokenAddr === zeroAddress) {
        throw new Error('MembershipManager has no payment token configured. Contact the DAO administrator.')
      }
      const userAddress = getAddress(await signer.getAddress())

      // Determine the price the contract will charge
      let price
      if (action === 'upgrade') {
        const membership = await askMembership(chain, mmAddress, 'getMembership', [userAddress, roleHash])
        const currentCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, membership.tier])
        const newCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, validTier])
        price = newCfg.priceUSDC - currentCfg.priceUSDC
      } else {
        const tierCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, validTier])
        price = tierCfg.priceUSDC
      }

      const balance = await askToken(chain, paymentTokenAddr, 'balanceOf', [userAddress])
      if (balance < price) {
        throw new Error(
          `Insufficient USDC balance. Have ${formatUnits(balance, 6)}, need ${formatUnits(price, 6)}.`
        )
      }

      const allowance = await askToken(chain, paymentTokenAddr, 'allowance', [userAddress, mmAddress])
      if (allowance < price) {
        emit('approve', 'start')
        const approveTx = await signer.sendTransaction({
          to: paymentTokenAddr,
          data: encodeFunctionData({
            abi: normalizeAbi(ERC20_ABI),
            functionName: 'approve',
            args: [getAddress(mmAddress), price],
          }),
        })
        emit('approve', 'sent', { txHash: approveTx.hash })
        await approveTx.wait()
        emit('approve', 'confirmed', { txHash: approveTx.hash })
      } else {
        emit('approve', 'skipped')
      }

      // Spec 007 (FR-039): when an accepted T&C version hash is supplied, use the
      // *WithTerms overloads so the accepted version is recorded on-chain at purchase.
      // legalDocs hashes are bare 64-hex (no 0x); normalize to a bytes32 0x-string.
      const normTerms = typeof termsHash === 'string'
        ? (termsHash.startsWith('0x') ? termsHash : '0x' + termsHash)
        : null
      const hasTerms = normTerms !== null && /^0x[0-9a-fA-F]{64}$/.test(normTerms)
      let payMethod
      let payArgs
      if (action === 'upgrade') {
        payMethod = hasTerms ? 'upgradeTierWithTerms' : 'upgradeTier'
        payArgs = hasTerms ? [roleHash, validTier, normTerms] : [roleHash, validTier]
      } else if (action === 'extend') {
        payMethod = 'extendMembership'
        payArgs = [roleHash]
      } else {
        payMethod = hasTerms ? 'purchaseTierWithTerms' : 'purchaseTier'
        payArgs = hasTerms ? [roleHash, validTier, normTerms] : [roleHash, validTier]
      }
      emit('pay', 'start')
      const tx = await signer.sendTransaction({
        to: mmAddress,
        data: encodeFunctionData({
          abi: normalizeAbi(MEMBERSHIP_MANAGER_ABI),
          functionName: payMethod,
          args: payArgs,
        }),
      })
      emit('pay', 'sent', { txHash: tx.hash })
      const receipt = await tx.wait()
      emit('pay', 'confirmed', { txHash: receipt.hash })
      return {
        hash: receipt.hash,
        blockNumber: receipt.blockNumber,
        status: receipt.status === 1 ? 'success' : 'failed',
        gasUsed: receipt.gasUsed.toString(),
        roleName,
        tier: validTier,
        tierName,
        amount: parseFloat(formatUnits(price, 6)),
        roleGrantedOnChain: receipt.status === 1,
        roleGrantTxHash: receipt.hash,
      }
    }
  }

  try {
    const stableAddress = DEX_ADDRESSES.STABLECOIN
    const paymentProcessorAddress = getContractAddress('paymentProcessor')

    if (!paymentProcessorAddress) {
      throw new Error(
        `Membership purchases aren't available on the connected network (chain ${walletChainId ?? 'unknown'}). ` +
          `Please switch your wallet to Polygon and try again.`
      )
    }

    const legacyChain = readChain(walletChainId)

    // Convert price to stablecoin units (USDC has 6 decimals).
    const amountWei = parseUnits(String(priceUSD), 6)

    // Check stablecoin balance
    const userAddress = getAddress(await signer.getAddress())
    const balanceRaw = await askToken(legacyChain, stableAddress, 'balanceOf', [userAddress])
    const balance = BigInt(balanceRaw.toString())
    const amount = BigInt(amountWei.toString())

    // Debug logging for balance issues
    console.log('Stablecoin Balance Check:', {
      userAddress,
      balanceWei: balance.toString(),
      balanceFormatted: formatUnits(balance, 6),
      requiredWei: amount.toString(),
      requiredFormatted: priceUSD
    })

    if (balance < amount) {
      const balanceFormatted = formatUnits(balance, 6)
      throw new Error(`Insufficient stablecoin balance. You have ${parseFloat(balanceFormatted).toFixed(2)} but need ${priceUSD}.`)
    }

    // Get role hash
    const roleHash = getRoleHash(roleName)
    if (!roleHash) {
      throw new Error(`Unknown role: ${roleName}`)
    }

    // Check if payment manager is configured on PaymentProcessor
    let paymentManagerAddress
    try {
      paymentManagerAddress = await readContract(legacyChain, {
        address: paymentProcessorAddress,
        abi: PAYMENT_PROCESSOR_ABI,
        functionName: 'paymentManager',
        args: [],
      })
    } catch {
      paymentManagerAddress = zeroAddress
    }

    if (paymentManagerAddress === zeroAddress) {
      throw new Error('MembershipPaymentManager not configured on this network.')
    }

    // Check and approve the stablecoin for the PaymentProcessor
    const allowanceRaw = await askToken(legacyChain, stableAddress, 'allowance', [
      userAddress,
      getAddress(paymentProcessorAddress),
    ])
    const allowance = BigInt(allowanceRaw.toString())

    if (allowance < amount) {
      emit('approve', 'start')
      console.log('Approving the stablecoin for PaymentProcessor...', {
        spender: paymentProcessorAddress,
        amount: amountWei.toString(),
        amountFormatted: formatUnits(amountWei, 6) + ' stable'
      })
      try {
        const approveData = encodeFunctionData({
          abi: normalizeAbi(ERC20_ABI),
          functionName: 'approve',
          args: [getAddress(paymentProcessorAddress), amountWei],
        })

        // First try to estimate gas to see if the transaction would succeed
        let gasEstimate
        try {
          gasEstimate = await signer.estimateGas({ to: stableAddress, data: approveData })
          console.log('Gas estimate for approve:', gasEstimate.toString())
        } catch (estimateError) {
          console.warn('Gas estimation failed, using default:', estimateError.message)
          gasEstimate = 60000n // Standard approve gas
        }

        // Add 20% buffer to gas estimate
        const gasLimit = (gasEstimate * 120n) / 100n

        const approveTx = await signer.sendTransaction({
          to: stableAddress,
          data: approveData,
          gasLimit,
        })
        emit('approve', 'sent', { txHash: approveTx.hash })
        console.log('Approve transaction sent:', approveTx.hash)
        await approveTx.wait()
        emit('approve', 'confirmed', { txHash: approveTx.hash })
        console.log('Stablecoin approved successfully')
      } catch (approveError) {
        console.error('Approve failed:', approveError)
        if (approveError.code === 'ACTION_REJECTED' || approveError.code === 4001) {
          throw new Error('Transaction rejected by user', { cause: approveError })
        }
        // Check for wallet authorization errors (code 4100)
        if (approveError.code === 4100 || approveError.message?.includes('4100') || approveError.message?.includes('not been authorized')) {
          throw new Error('Wallet authorization lost. Please reconnect your wallet and try again.', { cause: approveError })
        }
        // Try to provide more helpful error message
        throw new Error(`Failed to approve the stablecoin. Please ensure you have enough native token for gas and try again. Details: ${approveError.message || 'Unknown error'}`, { cause: approveError })
      }
    } else {
      emit('approve', 'skipped')
      console.log('Stablecoin already approved for PaymentProcessor, allowance:', formatUnits(allowance, 6))
    }

    // Validate tier value
    const validTier = [1, 2, 3, 4].includes(tier) ? tier : MembershipTier.BRONZE
    const tierName = TIER_NAMES[validTier] || 'Bronze'

    // Call purchaseTierWithToken on PaymentProcessor
    // This handles both payment and role granting in a single atomic transaction
    console.log('Purchasing role via PaymentProcessor...', {
      roleHash,
      tier: validTier,
      tierName,
      paymentToken: stableAddress,
      amount: amountWei.toString()
    })

    emit('pay', 'start')
    const purchaseTx = await signer.sendTransaction({
      to: paymentProcessorAddress,
      data: encodeFunctionData({
        abi: normalizeAbi(PAYMENT_PROCESSOR_ABI),
        functionName: 'purchaseTierWithToken',
        args: [roleHash, validTier, getAddress(stableAddress), amountWei],
      }),
    })
    emit('pay', 'sent', { txHash: purchaseTx.hash })
    const receipt = await purchaseTx.wait()
    emit('pay', 'confirmed', { txHash: receipt.hash })

    console.log('Role purchased successfully:', receipt)

    return {
      hash: receipt.hash,
      blockNumber: receipt.blockNumber,
      status: receipt.status === 1 ? 'success' : 'failed',
      gasUsed: receipt.gasUsed.toString(),
      roleName: roleName,
      tier: validTier,
      tierName: tierName,
      amount: priceUSD,
      roleGrantedOnChain: receipt.status === 1,
      roleGrantTxHash: receipt.hash
    }
  } catch (error) {
    console.error('Error purchasing role:', error)

    if (error.code === 'ACTION_REJECTED' || error.code === 4001) {
      throw new Error('Transaction rejected by user', { cause: error })
    } else if (error.code === 4100 || error.message?.includes('4100') || error.message?.includes('not been authorized')) {
      throw new Error('Wallet authorization lost. Please reconnect your wallet and try again.', { cause: error })
    } else if (error.message?.includes('Insufficient stablecoin balance')) {
      throw error
    } else {
      throw new Error(error.message || 'Transaction failed', { cause: error })
    }
  }
}

/**
 * Specs 035 + 036: resolve the exact EIP-712 intent parameters for a membership
 * payment action (purchase / upgrade / extend) so a gasless relay can authorize
 * the precise USDC amount the contract will pull. Read-only — issues no wallet
 * prompt and moves no funds. The returned `price` is the exact `receiveWithAuthorization`
 * value; it MUST match what MembershipManager charges (any mismatch is rejected).
 *
 * Mirrors the price/terms resolution in {@link purchaseRoleWithStablecoin}:
 *   - purchase & extend: price = getTierConfig(role, validTier).priceUSDC
 *   - upgrade:           price = getTierConfig(role, newTier).priceUSDC
 *                                - getTierConfig(role, currentTier).priceUSDC
 *   - terms:             normalize to a 0x-prefixed bytes32, or ZeroHash when none
 *
 * @param {ethers.Signer} signer - Connected wallet signer (its provider is read for the chain + tiers)
 * @param {string} roleName - Name of the role being purchased/upgraded/extended
 * @param {number} tier - Target membership tier (1=Bronze..4=Platinum), clamped to [1,4]
 * @param {string} [action='purchase'] - 'purchase' (default), 'upgrade', or 'extend'
 * @param {string|null} [termsHash=null] - accepted T&C version hash (bare 64-hex or 0x-prefixed)
 * @returns {Promise<{roleHash: string, validTier: number, price: bigint, acceptedTermsHash: string}>}
 */
export async function resolveMembershipIntentParams(signer, roleName, tier = MembershipTier.BRONZE, action = 'purchase', termsHash = null) {
  if (!signer) throw new Error('Wallet not connected')
  const roleHash = getRoleHash(roleName)
  if (!roleHash) throw new Error(`Unknown role: ${roleName}`)
  const validTier = [1, 2, 3, 4].includes(tier) ? tier : MembershipTier.BRONZE

  // Resolve the MembershipManager for the wallet's CURRENT chain (matches purchaseRoleWithStablecoin).
  let walletChainId = null
  try {
    walletChainId = Number((await signer.provider.getNetwork()).chainId)
  } catch { /* provider without a network; fall back to build-time chain */ }
  const mmAddress = getContractAddressForChain('membershipManager', walletChainId)
  if (!mmAddress) {
    throw new Error(`No membership contract is configured on the connected network (chain ${walletChainId ?? 'unknown'}).`)
  }

  const chain = readChain(walletChainId)
  const userAddress = getAddress(await signer.getAddress())

  // Determine the price the contract will charge (exact — this becomes the EIP-3009 value).
  let price
  if (action === 'upgrade') {
    const membership = await askMembership(chain, mmAddress, 'getMembership', [userAddress, roleHash])
    const currentCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, membership.tier])
    const newCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, validTier])
    price = newCfg.priceUSDC - currentCfg.priceUSDC
  } else {
    const tierCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, validTier])
    price = tierCfg.priceUSDC
  }

  // Normalize the accepted-terms hash exactly as purchaseRoleWithStablecoin does (bare 64-hex → 0x…).
  const normTerms = typeof termsHash === 'string'
    ? (termsHash.startsWith('0x') ? termsHash : '0x' + termsHash)
    : null
  const hasTerms = normTerms !== null && /^0x[0-9a-fA-F]{64}$/.test(normTerms)
  const acceptedTermsHash = hasTerms ? normTerms : zeroHash

  return { roleHash, validTier, price, acceptedTermsHash }
}

/**
 * Passkey smart accounts (spec 041, FR-016): build the [approve, purchase] call
 * batch a passkey session submits through {@link WalletContext.sendCalls} — ONE
 * WebAuthn ceremony authorizes the whole batch via the ERC-4337 bundler (gasless
 * where a paymaster serves the chain), so there is no separate on-chain approval
 * and no browser-wallet prompt.
 *
 * Read-only: `provider` is a plain RPC provider (no signer). Price + terms + method
 * selection mirror {@link purchaseRoleWithStablecoin} exactly, so the batched
 * `approve(price)` matches the amount the contract pulls and the purchase method
 * matches the self-submit path byte-for-byte.
 *
 * @param {ethers.Provider} provider - RPC read provider for the connected chain
 * @param {string} account - the passkey smart-account address (the member)
 * @param {string} roleName - role being purchased/upgraded/extended
 * @param {number} tier - target tier (1=Bronze..4=Platinum), clamped to [1,4]
 * @param {string} [action='purchase'] - 'purchase' (default), 'upgrade', or 'extend'
 * @param {string|null} [termsHash=null] - accepted T&C version hash (bare 64-hex or 0x-prefixed)
 * @returns {Promise<{calls: Array<{target: string, data: string, value: bigint}>, price: bigint,
 *   membershipManager: string, paymentToken: string, roleHash: string, validTier: number}>}
 */
export async function buildMembershipPurchaseCalls(provider, account, roleName, tier = MembershipTier.BRONZE, action = 'purchase', termsHash = null) {
  if (!provider) throw new Error('No read provider available')
  if (!account) throw new Error('No account address available')
  const roleHash = getRoleHash(roleName)
  if (!roleHash) throw new Error(`Unknown role: ${roleName}`)
  const validTier = [1, 2, 3, 4].includes(tier) ? tier : MembershipTier.BRONZE

  let walletChainId = null
  try {
    walletChainId = Number((await provider.getNetwork()).chainId)
  } catch { /* provider without a network; fall back to build-time chain */ }
  const mmAddress = getContractAddressForChain('membershipManager', walletChainId)
  if (!mmAddress) {
    throw new Error(`No membership contract is configured on the connected network (chain ${walletChainId ?? 'unknown'}).`)
  }
  const code = await provider.getCode(mmAddress)
  if (!code || code === '0x') {
    throw new Error(
      `No membership contract is deployed at ${mmAddress} on the connected network (chain ${walletChainId ?? 'unknown'}). ` +
        `Please switch to Polygon and try again.`
    )
  }

  const chain = readChain(walletChainId)
  const member = getAddress(account)
  const paymentTokenAddr = await askMembership(chain, mmAddress, 'paymentToken', [])
  if (!paymentTokenAddr || paymentTokenAddr === zeroAddress) {
    throw new Error('MembershipManager has no payment token configured. Contact the DAO administrator.')
  }

  // Exact price the contract will charge (this becomes the batched approve amount).
  let price
  if (action === 'upgrade') {
    const membership = await askMembership(chain, mmAddress, 'getMembership', [member, roleHash])
    const currentCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, membership.tier])
    const newCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, validTier])
    price = newCfg.priceUSDC - currentCfg.priceUSDC
  } else {
    const tierCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, validTier])
    price = tierCfg.priceUSDC
  }

  const balance = await askToken(chain, paymentTokenAddr, 'balanceOf', [member])
  if (balance < price) {
    throw new Error(
      `Insufficient USDC balance. Have ${formatUnits(balance, 6)}, need ${formatUnits(price, 6)}.`
    )
  }

  // Spec 007 (FR-039): record the accepted T&C version on-chain via the *WithTerms overloads.
  const normTerms = typeof termsHash === 'string'
    ? (termsHash.startsWith('0x') ? termsHash : '0x' + termsHash)
    : null
  const hasTerms = normTerms !== null && /^0x[0-9a-fA-F]{64}$/.test(normTerms)

  const encodeMembership = (functionName, args) =>
    encodeFunctionData({ abi: normalizeAbi(MEMBERSHIP_MANAGER_ABI), functionName, args })

  let purchaseData
  if (action === 'upgrade') {
    purchaseData = hasTerms
      ? encodeMembership('upgradeTierWithTerms', [roleHash, validTier, normTerms])
      : encodeMembership('upgradeTier', [roleHash, validTier])
  } else if (action === 'extend') {
    purchaseData = encodeMembership('extendMembership', [roleHash])
  } else {
    purchaseData = hasTerms
      ? encodeMembership('purchaseTierWithTerms', [roleHash, validTier, normTerms])
      : encodeMembership('purchaseTier', [roleHash, validTier])
  }
  const approveData = encodeFunctionData({
    abi: normalizeAbi(ERC20_ABI),
    functionName: 'approve',
    args: [getAddress(mmAddress), price],
  })

  return {
    calls: [
      { target: paymentTokenAddr, data: approveData, value: 0n },
      { target: mmAddress, data: purchaseData, value: 0n },
    ],
    price,
    membershipManager: mmAddress,
    paymentToken: paymentTokenAddr,
    roleHash,
    validTier,
  }
}

/**
 * Spec 022: read-only pre-flight to decide whether the membership purchase will
 * require a separate ERC-20 approval prompt. Lets the progress indicator build the
 * exact step list up front and OMIT the approval step entirely when the member
 * already has sufficient allowance (FR-009). No wallet prompt is issued.
 *
 * Mirrors the contract/price resolution used by `purchaseRoleWithStablecoin`.
 * On any error it conservatively returns `true` (assume approval needed) so the
 * indicator never hides a prompt that does appear.
 *
 * @returns {Promise<boolean>} true if an approval transaction will be requested
 */
export async function checkApprovalNeeded(signer, roleName, priceUSD, tier = MembershipTier.BRONZE, action = 'purchase') {
  if (!signer) return true
  try {
    let walletChainId = null
    try {
      walletChainId = Number((await signer.provider.getNetwork()).chainId)
    } catch { /* fall back to build-time chain */ }

    const mmAddress = getContractAddressForChain('membershipManager', walletChainId)
    if (mmAddress) {
      const code = await signer.provider.getCode(mmAddress)
      if (!code || code === '0x') return true
      const roleHash = getRoleHash(roleName)
      if (!roleHash) return true
      const validTier = [1, 2, 3, 4].includes(tier) ? tier : MembershipTier.BRONZE
      const chain = readChain(walletChainId)
      const paymentTokenAddr = await askMembership(chain, mmAddress, 'paymentToken', [])
      if (!paymentTokenAddr || paymentTokenAddr === zeroAddress) return true
      const userAddress = getAddress(await signer.getAddress())

      let price
      if (action === 'upgrade') {
        const membership = await askMembership(chain, mmAddress, 'getMembership', [userAddress, roleHash])
        const currentCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, membership.tier])
        const newCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, validTier])
        price = newCfg.priceUSDC - currentCfg.priceUSDC
      } else {
        const tierCfg = await askMembership(chain, mmAddress, 'getTierConfig', [roleHash, validTier])
        price = tierCfg.priceUSDC
      }
      const allowance = await askToken(chain, paymentTokenAddr, 'allowance', [userAddress, mmAddress])
      return allowance < price
    }

    // Legacy PaymentProcessor path
    const paymentProcessorAddress = getContractAddress('paymentProcessor')
    if (!paymentProcessorAddress) return true
    const userAddress = getAddress(await signer.getAddress())
    const amountWei = parseUnits(String(priceUSD), 6)
    const allowance = await askToken(readChain(walletChainId), DEX_ADDRESSES.STABLECOIN, 'allowance', [
      userAddress,
      getAddress(paymentProcessorAddress),
    ])
    return BigInt(allowance.toString()) < BigInt(amountWei.toString())
  } catch (e) {
    console.warn('[checkApprovalNeeded] pre-flight failed, assuming approval needed:', e?.message)
    return true
  }
}

/**
 * Spec 098 (FR-002/FR-015) — the ADDRESS-based twin of {@link checkApprovalNeeded}.
 *
 * A purchase made while operating as another account is credited to — and paid by — the ACTING
 * account, so its allowance is what decides whether an approve step exists. `checkApprovalNeeded`
 * cannot answer that: it derives the owner from `signer.getAddress()`, which is the CONNECTED
 * wallet, and would happily report "no approval needed" because the operator happens to have an
 * allowance the acting account does not. Taking the address explicitly makes that mistake
 * unrepresentable.
 *
 * Read-only, no signer, no wallet prompt. Conservative on every failure (returns `true`), for the
 * same reason as its sibling: hiding a prompt that does appear is worse than showing one that
 * doesn't.
 *
 * @param {string} address - the account whose allowance is read (the future member)
 * @param {string} roleName
 * @param {number} priceUSD - display price; only used by the legacy PaymentProcessor fallback
 * @param {number} [tier=1]
 * @param {string} [action='purchase'] - 'purchase' | 'upgrade' | 'extend'
 * @param {{provider?: ethers.Provider, chainId?: number}} [opts] - read provider (defaults to the
 *   membership reference chain's, spec 071 — purchases settle nowhere else)
 * @returns {Promise<boolean>} true if an approval transaction will be required
 */
export async function checkApprovalNeededForAddress(
  address, roleName, priceUSD, tier = MembershipTier.BRONZE, action = 'purchase', opts = {},
) {
  if (!address) return true
  try {
    const chainId = opts.chainId ?? membershipChainId()

    // Spec 110: the reads below name their chain, so `opts.provider` no longer carries them — but
    // a caller that passes one is NAMING A CHAIN with it, and that has always been what decided
    // where this pre-flight looked. So it is still asked, and only for that. With no provider the
    // requested chain stands; a chain with no RPC route makes the reads throw, which the catch
    // below turns into the same conservative `true` the missing-provider gate used to return.
    let readChainId = chainId
    if (opts.provider) {
      try {
        readChainId = Number((await opts.provider.getNetwork()).chainId)
      } catch { /* provider without a network; keep the requested chain */ }
    }

    const mmAddress = getContractAddressForChain('membershipManager', readChainId)
    if (!mmAddress) return true
    const roleHash = getRoleHash(roleName)
    if (!roleHash) return true
    const validTier = [1, 2, 3, 4].includes(tier) ? tier : MembershipTier.BRONZE

    const member = getAddress(address)
    const paymentTokenAddr = await askMembership(readChainId, mmAddress, 'paymentToken', [])
    if (!paymentTokenAddr || paymentTokenAddr === zeroAddress) return true

    // The exact amount the contract will pull — an upgrade charges only the delta, so quoting the
    // full tier price here would show an approve step the purchase never needs.
    let price
    if (action === 'upgrade') {
      const membership = await askMembership(readChainId, mmAddress, 'getMembership', [member, roleHash])
      const currentCfg = await askMembership(readChainId, mmAddress, 'getTierConfig', [roleHash, membership.tier])
      const newCfg = await askMembership(readChainId, mmAddress, 'getTierConfig', [roleHash, validTier])
      price = newCfg.priceUSDC - currentCfg.priceUSDC
    } else {
      const tierCfg = await askMembership(readChainId, mmAddress, 'getTierConfig', [roleHash, validTier])
      price = tierCfg.priceUSDC
    }

    const allowance = await askToken(readChainId, paymentTokenAddr, 'allowance', [member, mmAddress])
    return BigInt(allowance) < BigInt(price)
  } catch (e) {
    console.warn('[checkApprovalNeededForAddress] pre-flight failed, assuming approval needed:', e?.message)
    return true
  }
}
