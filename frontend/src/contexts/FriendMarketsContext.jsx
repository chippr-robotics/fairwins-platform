import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAccount } from 'wagmi'
import { useWalletChainId } from '../hooks/useWalletChainId'
import { fetchFriendMarketsForUser } from '../utils/blockchainService'
import { FriendMarketsContext } from './FriendMarketsContext'

const STORAGE_KEY = 'friendMarkets'
const DISMISSED_STORAGE_PREFIX = 'mywagers_dismissed:'

// The wager cache is scoped per chain so that wagers fetched on the testnet
// don't leak into the mainnet view (and vice versa) after a network switch.
// Each entry is also tagged with the `chainId` it was read from, which lets
// the UI filter/label wagers defensively even if a legacy (unscoped) cache is
// still present.
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

// Stamp each market with the chain it belongs to and a chain-qualified
// uniqueId so identical market ids on different chains never collide.
function tagMarkets(markets, chainId) {
  return markets.map(m => ({
    ...m,
    chainId,
    uniqueId: `${chainId || 'unknown'}-${m.contractAddress || 'unknown'}-${m.id}`,
  }))
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

export function FriendMarketsProvider({ children }) {
  const { address, isConnected } = useAccount()
  const chainId = useWalletChainId()
  const [friendMarkets, setFriendMarkets] = useState(() => loadFromStorage(chainId))
  const [loading, setLoading] = useState(false)
  const [dismissedIdsArr, setDismissedIdsArr] = useState(() => loadDismissed(address))

  // Fetch friend markets from blockchain when the wallet connects or the
  // active network changes. The chainId dependency is essential: when the
  // user toggles testnet ↔ mainnet we must re-query the chain rather than
  // keep showing wagers that only exist on the previous network.
  useEffect(() => {
    // Immediately swap to the selected network's cached wagers (or nothing)
    // so stale wagers from the previous network don't linger during the fetch.
    setFriendMarkets(loadFromStorage(chainId))

    if (!address || !isConnected) return

    let cancelled = false

    const fetchMarkets = async (attempt = 0) => {
      setLoading(true)
      try {
        const blockchainMarkets = await fetchFriendMarketsForUser(address, chainId)
        if (cancelled) return

        const marketsWithUniqueIds = tagMarkets(blockchainMarkets, chainId)

        setFriendMarkets(marketsWithUniqueIds)
        saveToStorage(chainId, marketsWithUniqueIds)
      } catch (error) {
        console.error('[FriendMarketsContext] Error fetching friend markets:', error)
        if (!cancelled && attempt < 2) {
          const delay = (attempt + 1) * 2000
          setTimeout(() => fetchMarkets(attempt + 1), delay)
          return
        }
        // On final failure, keep existing state (localStorage cache) as fallback
      }
      if (!cancelled) setLoading(false)
    }

    fetchMarkets()
    return () => { cancelled = true }
  }, [address, isConnected, chainId])

  // Manual refresh
  const refresh = useCallback(async () => {
    if (!address || !isConnected) return
    setLoading(true)
    try {
      const blockchainMarkets = await fetchFriendMarketsForUser(address, chainId)
      const marketsWithUniqueIds = tagMarkets(blockchainMarkets, chainId)
      setFriendMarkets(marketsWithUniqueIds)
      saveToStorage(chainId, marketsWithUniqueIds)
    } catch (error) {
      console.error('[FriendMarketsContext] Error refreshing friend markets:', error)
    }
    setLoading(false)
  }, [address, isConnected, chainId])

  // Optimistic add after creation (before next blockchain fetch)
  const addMarket = useCallback((market) => {
    setFriendMarkets(prev => {
      const updated = [...prev, { ...market, chainId }]
      saveToStorage(chainId, updated)
      return updated
    })
  }, [chainId])

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
