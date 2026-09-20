import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { getDefaultWagerRepository } from '../data/wagers/WagerRepository'
import { WagerSortKey } from '../constants/wagerDefaults'

const DEFAULT_PAGE_SIZE = 25

/**
 * Paginated, filtered, sorted view of the user's wagers.
 *
 * Uses the WagerRepository (subgraph or events source under the hood) and
 * keeps decryption out of the data path — the visible page returns raw
 * `metadataCipher` envelopes that the modal feeds into
 * `useLazyMarketDecryption`.
 *
 * Filter and sort are controlled by the caller — pass them in and the
 * hook reloads the first page when they change.
 *
 * @param {Object} opts
 * @param {string} opts.account - user's wallet address
 * @param {('participating'|'created'|'history')} opts.tab
 * @param {string} [opts.sort] - WagerSortKey value (controlled)
 * @param {Object} [opts.filter] - filter overrides (controlled)
 * @param {number} [opts.pageSize]
 * @param {Object} [opts.repository] - injectable repository (for tests)
 */
export function useMyWagers({
  account,
  tab,
  sort = WagerSortKey.CREATED,
  filter = {},
  pageSize = DEFAULT_PAGE_SIZE,
  repository,
  // Active chain — defaults to the wallet's connected chain so the data source
  // (subgraph vs. RPC) is selected per network. Pass explicitly to override.
  chainId,
  // Back-compat for callers that used the older naming
  initialSort,
  initialFilter,
} = {}) {
  const wagmiChainId = useWalletChainId()
  const activeChainId = chainId ?? wagmiChainId
  const repo = useMemo(
    () => repository || getDefaultWagerRepository(activeChainId),
    [repository, activeChainId]
  )
  const effectiveSort = sort ?? initialSort ?? WagerSortKey.CREATED
  const effectiveFilter = useMemo(
    () => filter ?? initialFilter ?? {},
    [filter, initialFilter]
  )

  const [items, setItems] = useState([])
  const [cursor, setCursor] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [totalKnown, setTotalKnown] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)

  const requestIdRef = useRef(0)

  // Stringify the dynamic filter so the dependency check is stable across
  // identity-changing object props.
  const filterKey = useMemo(
    () => JSON.stringify({ tab, ...effectiveFilter }),
    [tab, effectiveFilter]
  )

  const loadFirstPage = useCallback(async () => {
    if (!account) {
      setItems([])
      setCursor(null)
      setHasMore(false)
      setTotalKnown(0)
      return
    }
    const reqId = ++requestIdRef.current
    setIsLoading(true)
    setError(null)
    try {
      const page = await repo.listMyWagers({
        userAddress: account,
        cursor: null,
        pageSize,
        sortKey: effectiveSort,
        filter: { tab, ...effectiveFilter },
      })
      if (reqId !== requestIdRef.current) return
      setItems(page.items)
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
      setTotalKnown(page.totalKnown)
    } catch (err) {
      if (reqId !== requestIdRef.current) return
      console.error('[useMyWagers] load failed:', err)
      setError(err?.message || 'Failed to load wagers')
    } finally {
      if (reqId === requestIdRef.current) setIsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, repo, pageSize, effectiveSort, filterKey])

  const loadMore = useCallback(async () => {
    if (!account || !hasMore || !cursor) return
    setIsLoading(true)
    setError(null)
    try {
      const page = await repo.listMyWagers({
        userAddress: account,
        cursor,
        pageSize,
        sortKey: effectiveSort,
        filter: { tab, ...effectiveFilter },
      })
      setItems(prev => [...prev, ...page.items])
      setCursor(page.nextCursor)
      setHasMore(page.hasMore)
    } catch (err) {
      console.error('[useMyWagers] loadMore failed:', err)
      setError(err?.message || 'Failed to load more wagers')
    } finally {
      setIsLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, repo, pageSize, effectiveSort, cursor, hasMore, filterKey])

  useEffect(() => {
    loadFirstPage()
  }, [loadFirstPage])

  const refresh = useCallback(() => {
    return loadFirstPage()
  }, [loadFirstPage])

  return {
    items,
    sort: effectiveSort,
    filter: effectiveFilter,
    loadMore,
    refresh,
    isLoading,
    error,
    hasMore,
    totalKnown,
  }
}
