/**
 * useCollectibles (spec 055) — the connected wallet's OpenSea-backed collectibles on the
 * ACTIVE network, via the relay-gateway's read-only proxy.
 *
 * Follows the usePortfolio conventions: hand-rolled state machine (data-model.md), race-safe
 * request ids, and a full synchronous reset on account/chain switch so one network's items can
 * never render while another is active (FR-010). Soft-fail: on unsupported chains or with no
 * gateway configured the hook reports {supported:false} and performs NO fetches (FR-007).
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { WalletContext } from '../contexts/WalletContext.js'
import {
  collectiblesAvailable,
  fetchAccountCollectibles,
  fetchCollectionStats,
} from '../lib/collectibles/gatewayClient'
import { collectionSlugsForValuation } from '../lib/collectibles/valuation'

export function useCollectibles() {
  // Tolerant context read (not useWallet, which throws outside a WalletProvider):
  // this hook runs inside Portfolio for the estimate row and must soft-fail to
  // "disconnected" wherever no wallet context exists, never take the page down.
  const wallet = useContext(WalletContext) || {}
  const { address, isConnected } = wallet
  const chainId = useWalletChainId()
  const supported = collectiblesAvailable(chainId)

  const [pages, setPages] = useState([]) // [{items, next, fetchedAt, stale}]
  const [phase, setPhase] = useState('idle') // idle | loading | ready | degraded
  const [loadingMore, setLoadingMore] = useState(false)
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!supported || !isConnected || !address) return
    const reqId = ++reqIdRef.current
    setPhase('loading')
    try {
      const page = await fetchAccountCollectibles(chainId, address)
      if (reqId !== reqIdRef.current) return
      setPages([page])
      setPhase('ready')
    } catch {
      if (reqId !== reqIdRef.current) return
      setPages([])
      setPhase('degraded')
    }
  }, [supported, isConnected, address, chainId])

  const loadMore = useCallback(async () => {
    const next = pages[pages.length - 1]?.next
    if (!next || loadingMore) return
    const reqId = reqIdRef.current
    setLoadingMore(true)
    try {
      const page = await fetchAccountCollectibles(chainId, address, next)
      if (reqId !== reqIdRef.current) return
      setPages((prev) => [...prev, page])
    } catch {
      // Keep what we have; the caller's "load more" affordance stays available to retry.
    } finally {
      if (reqId === reqIdRef.current) setLoadingMore(false)
    }
  }, [pages, loadingMore, chainId, address])

  // Full reset BEFORE refetch on account/chain switch — stale cross-network
  // items must never survive into the next render (FR-010).
  useEffect(() => {
    reqIdRef.current++
    setPages([])
    setPhase('idle')
    setLoadingMore(false)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, chainId, supported])

  return useMemo(() => {
    const items = pages.flatMap((p) => p.items)
    let status = 'ready'
    if (!supported) status = 'unsupported'
    else if (!isConnected || !address) status = 'disconnected'
    else if (phase === 'idle' || phase === 'loading') status = 'loading'
    else if (phase === 'degraded') status = 'degraded'
    else if (items.length === 0) status = 'empty'

    return {
      supported,
      status,
      chainId,
      address,
      items,
      hasMore: Boolean(pages[pages.length - 1]?.next),
      loadMore,
      loadingMore,
      stale: pages.some((p) => p.stale),
      fetchedAt: pages[0]?.fetchedAt ?? null,
      refresh: load,
    }
  }, [supported, isConnected, address, chainId, pages, phase, loadMore, loadingMore, load])
}

/**
 * useCollectiblesValuation (US3) — items plus per-collection floor stats for the Portfolio
 * estimate line. Bounded scan (valuation.js); the CALLER converts floors to USD with its own
 * verifiable price map via computeCollectiblesValuation, keeping estimate math beside the
 * portfolio's honest-pricing rules.
 */
export function useCollectiblesValuation() {
  const collectibles = useCollectibles()
  const { supported, status, items, hasMore } = collectibles
  const [statsBySlug, setStatsBySlug] = useState(() => new Map())
  const reqIdRef = useRef(0)

  const { slugs, truncatedCollections } = useMemo(() => collectionSlugsForValuation(items), [items])
  const slugsKey = slugs.join(',')

  useEffect(() => {
    const reqId = ++reqIdRef.current
    setStatsBySlug(new Map())
    if (!supported || status !== 'ready' || slugs.length === 0) return
    Promise.allSettled(slugs.map((slug) => fetchCollectionStats(slug))).then((settled) => {
      if (reqId !== reqIdRef.current) return
      const map = new Map()
      settled.forEach((res, i) => {
        // A failed floor leg just leaves that collection unpriced (honest, non-fatal).
        if (res.status === 'fulfilled') map.set(slugs[i], res.value)
      })
      setStatsBySlug(map)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supported, status, slugsKey])

  return useMemo(
    () => ({ ...collectibles, statsBySlug, bounds: { hasMoreItems: hasMore, truncatedCollections } }),
    [collectibles, statsBySlug, hasMore, truncatedCollections]
  )
}

export default useCollectibles
