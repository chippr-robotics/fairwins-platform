import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useAccount } from 'wagmi'
import { useWalletChainId } from '../hooks/useWalletChainId'
import { cohortChainIds } from '../config/networks'
import {
  readWagersAcrossEstate,
  wagersFrom,
  unreadableNetworks,
  tagWagers,
} from '../lib/wagers/estateWagers'
import { FriendMarketsContext } from './FriendMarketsContext'

const STORAGE_KEY = 'friendMarkets'
const DISMISSED_STORAGE_PREFIX = 'mywagers_dismissed:'

/*
 * THE LIST IS THE ESTATE NOW (spec 110 Phase 4, T040 — issue #1595).
 *
 * It used to be one chain: the wallet's. That is why Claim could not name a chain — a wager on
 * another network was never in the list to be claimed, so there was no target to name. The read
 * spans the build's COHORT (never `listSupportedChainIds()`; constitution III), each chain
 * answering for itself, and every wager carries the chain it was read from.
 *
 * The per-chain cache KEYS are unchanged, deliberately: a member who had wagers cached under
 * `friendMarkets:137` still sees them on first paint, and a chain the app cannot reach right now
 * keeps showing what it last knew instead of silently emptying. What changed is that all of the
 * cohort's caches are loaded, not just the connected chain's.
 */
function storageKey(chainId) {
  return chainId ? `${STORAGE_KEY}:${chainId}` : STORAGE_KEY
}

function loadFromStorage(chainId) {
  try {
    const stored = localStorage.getItem(storageKey(chainId))
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

function saveToStorage(chainId, markets) {
  try {
    localStorage.setItem(storageKey(chainId), JSON.stringify(markets))
  } catch {
    // localStorage may be full or unavailable — non-fatal
  }
}

function dismissedKey(address) {
  return `${DISMISSED_STORAGE_PREFIX}${(address || '').toLowerCase()}`
}

function loadDismissed(address) {
  if (!address) return []
  try {
    const stored = localStorage.getItem(dismissedKey(address))
    return stored ? JSON.parse(stored) : []
  } catch {
    return []
  }
}

function saveDismissed(address, ids) {
  if (!address) return
  try {
    localStorage.setItem(dismissedKey(address), JSON.stringify(ids))
  } catch {
    // non-fatal
  }
}

/** Every cohort chain's cached wagers, for the first paint before any chain has answered. */
function loadEstateFromStorage() {
  return cohortChainIds().flatMap((id) => tagWagers(loadFromStorage(id), id))
}

export function FriendMarketsProvider({ children }) {
  const { address, isConnected } = useAccount()
  // Still read — `addMarket` stamps an optimistically-created wager with the chain it was created
  // on — but it is NO LONGER what decides which chains are read. That is the change.
  const walletChainId = useWalletChainId()
  const [friendMarkets, setFriendMarkets] = useState(loadEstateFromStorage)
  const [loading, setLoading] = useState(false)
  // One three-state reading per chain, kept so a surface can NAME the network it could not read
  // rather than implying the member has no wagers there (spec 071's partial rule).
  const [readings, setReadings] = useState([])
  const [dismissedIdsArr, setDismissedIdsArr] = useState(() => loadDismissed(address))

  /*
   * Read the estate when the wallet connects. NOT on a chain change: the list no longer depends
   * on where the wallet is, which is the point — a member switching networks used to watch their
   * wagers disappear and come back.
   *
   * A chain that answers replaces ITS OWN cache; a chain that does not is left alone, so its
   * cached wagers survive and `readings` carries the reason.
   */
  const runningRef = useRef(0)
  const readEstate = useCallback(async () => {
    if (!address || !isConnected) return
    const run = ++runningRef.current
    setLoading(true)
    const next = await readWagersAcrossEstate(address)
    if (runningRef.current !== run) return // a newer read superseded this one
    setReadings(next)
    for (const reading of next) {
      if (reading.status === 'read') saveToStorage(reading.chainId, reading.value)
    }
    // Chains that answered contribute their fresh wagers; the rest keep whatever was cached, so
    // an unreachable network is a named gap rather than an empty one.
    const answered = new Set(next.filter((r) => r.status === 'read').map((r) => r.chainId))
    setFriendMarkets((prev) => [
      ...prev.filter((m) => !answered.has(Number(m.chainId))),
      ...wagersFrom(next),
    ])
    setLoading(false)
  }, [address, isConnected])

  useEffect(() => {
    if (!address || !isConnected) {
      setFriendMarkets(loadEstateFromStorage())
      setReadings([])
      return
    }
    readEstate()
  }, [address, isConnected, readEstate])

  // Manual refresh — the same estate read.
  const refresh = readEstate

  // Optimistic add after creation (before next blockchain fetch)
  const addMarket = useCallback((market) => {
    // A wager is created on ONE chain: the one it names, else the one the wallet was on.
    const chainId = Number(market?.chainId ?? walletChainId)
    setFriendMarkets(prev => {
      const updated = [...prev, { ...market, chainId }]
      saveToStorage(chainId, updated.filter((m) => Number(m.chainId) === chainId))
      return updated
    })
  }, [walletChainId])

  // Reload the dismissed set when the active account changes so we don't
  // leak one wallet's dismissed list into another.
  useEffect(() => {
    setDismissedIdsArr(loadDismissed(address))
  }, [address])

  const dismissedIds = useMemo(() => new Set(dismissedIdsArr.map(String)), [dismissedIdsArr])

  const dismissMarket = useCallback((marketId) => {
    if (marketId == null) return
    const id = String(marketId)
    setDismissedIdsArr(prev => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      saveDismissed(address, next)
      return next
    })
  }, [address])

  const dismissMarkets = useCallback((marketIds) => {
    const incoming = (marketIds || []).filter(v => v != null).map(String)
    if (incoming.length === 0) return
    setDismissedIdsArr(prev => {
      const merged = Array.from(new Set([...prev, ...incoming]))
      if (merged.length === prev.length) return prev
      saveDismissed(address, merged)
      return merged
    })
  }, [address])

  const restoreMarket = useCallback((marketId) => {
    if (marketId == null) return
    const id = String(marketId)
    setDismissedIdsArr(prev => {
      if (!prev.includes(id)) return prev
      const next = prev.filter(x => x !== id)
      saveDismissed(address, next)
      return next
    })
  }, [address])

  const isDismissed = useCallback(
    (marketId) => dismissedIds.has(String(marketId)),
    [dismissedIds]
  )

  return (
    <FriendMarketsContext.Provider
      value={{
        friendMarkets,
        loading,
        readings,
        // Named, never counted silently: a total drawn from this list is incomplete while any
        // chain is unreadable, and the surface has to be able to say which.
        unreadableNetworks: unreadableNetworks(readings),
        partial: unreadableNetworks(readings).length > 0,
        refresh,
        addMarket,
        setFriendMarkets,
        dismissedIds,
        dismissMarket,
        dismissMarkets,
        restoreMarket,
        isDismissed,
      }}
    >
      {children}
    </FriendMarketsContext.Provider>
  )
}
