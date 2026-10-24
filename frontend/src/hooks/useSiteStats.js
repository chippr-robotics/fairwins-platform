/**
 * useSiteStats — wallet-free hook that powers the landing page stats band.
 *
 * Source priority (graceful degradation):
 *   1. Subgraph aggregation (per-chain endpoint, config/networks.js) — counts
 *      wagers by status, sums staked value, counts unique users.
 *   2. RPC fallback — reads WagerRegistry.nextWagerId() for the total wager
 *      count when the subgraph is unavailable.
 *
 * Metrics are reported exactly as they come back on-chain — there is no
 * baseline floor or padding. When neither source resolves, the band renders
 * zeros and a neutral "Platform activity" label.
 *
 * Results are cached at module scope for STATS_TTL_MS so the band doesn't
 * refetch on every mount/navigation.
 */

import { useEffect, useState } from 'react'
import { formatUnits } from '../lib/evm/units'
import { readContract } from '../lib/chains/readContract'
import { getContractAddressForChain } from '../config/contracts'
import { useWeb3 } from './useWeb3'
import { WAGER_REGISTRY_ABI } from '../abis/WagerRegistry'
import { resolveSubgraphUrl } from '../data/wagers/SubgraphSource'

// Stake token is assumed to be a 6-decimal stable (USDC) for the headline
// USD figure — accurate for the default deployment's stake token.
const STABLE_DECIMALS = 6
const STATS_TTL_MS = 60_000
const QUERY_PAGE = 1000

// v2 WagerRegistry schema (spec 017): 1v1 wagers with creator/opponent + per-side
// stakes; no User entity, so unique accounts are derived from creator/opponent.
const STATS_QUERY = `
  query SiteStats($first: Int!) {
    wagers(first: $first, orderBy: createdAt, orderDirection: desc) {
      status
      creator
      opponent
      creatorStake
      opponentStake
    }
  }
`

const ZERO_ADDR = /^0x0+$/
const STAKED_STATUSES = new Set(['active', 'draw_proposed', 'resolved', 'drawn', 'refunded'])

// Cache stats per connected chain so switching networks doesn't show another
// chain's figures within the TTL window (spec 008).
const cacheByChain = new Map() // chainId -> { value, ts }

function emptyStats() {
  return {
    activeAccounts: 0,
    valueWageredUsd: 0,
    wagersResolved: 0,
    totalWagers: 0,
    activeWagers: 0,
  }
}

/**
 * Aggregate v2 Wager rows into the landing-band stats. Pure + exported for unit
 * testing (spec 017). Unique accounts come from creator/opponent (v2 has no User
 * entity); the pot sums the creator stake plus the opponent stake once escrowed.
 */
export function aggregateWagerStats(wagers) {
  const accounts = new Set()
  let potBase = 0n
  let resolved = 0
  let active = 0
  for (const w of wagers) {
    if (w.status === 'resolved') resolved += 1
    if (w.status === 'active') active += 1
    if (w.creator) accounts.add(String(w.creator).toLowerCase())
    if (w.opponent && !ZERO_ADDR.test(String(w.opponent))) accounts.add(String(w.opponent).toLowerCase())
    try {
      potBase += BigInt(w.creatorStake || 0)
      if (STAKED_STATUSES.has(w.status)) potBase += BigInt(w.opponentStake || 0)
    } catch {
      // skip malformed rows rather than failing the whole aggregation
    }
  }
  return {
    activeAccounts: accounts.size,
    valueWageredUsd: Math.round(Number(formatUnits(potBase, STABLE_DECIMALS))),
    wagersResolved: resolved,
    totalWagers: wagers.length,
    activeWagers: active,
  }
}

async function fetchFromSubgraph(subgraphUrl) {
  const res = await fetch(subgraphUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: STATS_QUERY, variables: { first: QUERY_PAGE } }),
  })
  if (!res.ok) throw new Error(`Subgraph HTTP ${res.status}`)
  const json = await res.json()
  if (json.errors) throw new Error(json.errors[0]?.message || 'Subgraph error')
  return aggregateWagerStats(json.data?.wagers || [])
}

async function fetchFromRpc(chainId) {
  const stats = emptyStats()
  const address = getContractAddressForChain('wagerRegistry', chainId)
  if (!address) return stats
  const nextId = await readContract(chainId, {
    address,
    abi: WAGER_REGISTRY_ABI,
    functionName: 'nextWagerId',
  })
  // ids start at 1, so total created = nextWagerId - 1
  stats.totalWagers = Math.max(0, Number(nextId) - 1)
  return stats
}

async function loadStats(chainId) {
  const cacheKey = chainId ?? 'default'
  const cached = cacheByChain.get(cacheKey)
  if (cached && Date.now() - cached.ts < STATS_TTL_MS) return cached.value

  const subgraphUrl = resolveSubgraphUrl(chainId)
  let live = emptyStats()
  let isLive
  try {
    live = subgraphUrl ? await fetchFromSubgraph(subgraphUrl) : await fetchFromRpc(chainId)
    isLive = true
  } catch {
    try {
      live = await fetchFromRpc(chainId)
      isLive = true
    } catch {
      isLive = false
    }
  }

  // Report metrics exactly as fetched — no baseline floor. Normalise each
  // key to a non-negative number so the formatter never sees undefined/NaN.
  const stats = emptyStats()
  for (const key of Object.keys(stats)) {
    stats[key] = Math.max(0, Number(live[key]) || 0)
  }

  const value = { stats, isLive }
  cacheByChain.set(cacheKey, { value, ts: Date.now() })
  return value
}

export function useSiteStats() {
  // Start from zeros so the band never flashes fabricated figures, then
  // refine with live data once it resolves.
  const [stats, setStats] = useState(emptyStats)
  const [isLive, setIsLive] = useState(false)
  const [loading, setLoading] = useState(true)
  const { chainId } = useWeb3()

  useEffect(() => {
    let cancelled = false
    loadStats(chainId)
      .then((res) => {
        if (cancelled) return
        setStats(res.stats)
        setIsLive(res.isLive)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [chainId])

  return { stats, isLive, loading }
}

export default useSiteStats
