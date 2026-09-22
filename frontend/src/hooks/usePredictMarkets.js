/**
 * usePredictMarkets (spec 057) — browse/search Polymarket markets on the ACTIVE network via the
 * relay-gateway proxy. Mirrors useCollectibles: hand-rolled state machine, race-safe request ids,
 * full reset on chain/search change. Soft-fail: off Polygon or with no gateway configured the hook
 * reports {supported:false} and performs NO fetches (FR-018). Browsing needs no connected wallet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { predictAvailable, fetchMarkets } from '../lib/predict/predictClient'

export function usePredictMarkets({ q = '', category = '' } = {}) {
  const chainId = useWalletChainId()
  const supported = predictAvailable(chainId)

  const [pages, setPages] = useState([]) // [{markets, next, fetchedAt, stale}]
  const [phase, setPhase] = useState('idle') // idle | loading | ready | degraded
  const [loadingMore, setLoadingMore] = useState(false)
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!supported) return
    const reqId = ++reqIdRef.current
    setPhase('loading')
    try {
      const page = await fetchMarkets(chainId, { q, category })
      if (reqId !== reqIdRef.current) return
      setPages([page])
      setPhase('ready')
    } catch {
      if (reqId !== reqIdRef.current) return
      setPages([])
      setPhase('degraded')
    }
  }, [supported, chainId, q, category])

  const loadMore = useCallback(async () => {
    const next = pages[pages.length - 1]?.next
    if (!next || loadingMore) return
    const reqId = reqIdRef.current
    setLoadingMore(true)
    try {
      const page = await fetchMarkets(chainId, { q, category, next })
      if (reqId !== reqIdRef.current) return
      setPages((prev) => [...prev, page])
    } catch {
      /* keep what we have; retry stays available */
    } finally {
      if (reqId === reqIdRef.current) setLoadingMore(false)
    }
  }, [pages, loadingMore, chainId, q, category])

  useEffect(() => {
    reqIdRef.current++
    setPages([])
    setPhase('idle')
    setLoadingMore(false)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, supported, q, category])

  return useMemo(() => {
    const markets = pages.flatMap((p) => p.markets)
    let status = 'ready'
    if (!supported) status = 'unsupported'
    else if (phase === 'idle' || phase === 'loading') status = 'loading'
    else if (phase === 'degraded') status = 'degraded'
    else if (markets.length === 0) status = 'empty'

    return {
      supported,
      status,
      chainId,
      markets,
      hasMore: Boolean(pages[pages.length - 1]?.next),
      loadMore,
      loadingMore,
      stale: pages.some((p) => p.stale),
      fetchedAt: pages[0]?.fetchedAt ?? null,
      refresh: load,
    }
  }, [supported, chainId, pages, phase, loadMore, loadingMore, load])
}

export default usePredictMarkets
