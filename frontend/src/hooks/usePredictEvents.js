/**
 * usePredictEvents (spec 114, US1) — browse/search Polymarket EVENTS on the active network via the
 * relay-gateway `/events` route. Same discipline as the spec-057 `usePredictMarkets` it replaces:
 * race-safe request ids, a full reset on any query change, no fetch off Polygon (FR-018).
 *
 * Additions:
 *  - the FIRST page refreshes every 15 s while the document is visible (paused when hidden, refreshed
 *    on return). A background refresh never flashes `loading`, never drops later pages, and a failed
 *    one keeps what is on screen — its age simply keeps growing, which the trust chip says;
 *  - `q` is debounced 300 ms; while a search is set the gateway ignores category, sort, topic and live, so
 *    the hook does not send them (and does not re-query when they change). In `legacy` mode (a gateway
 *    with no event route) topic and live are never sent — the older market list has neither;
 *  - the list's server-clock `stamp` + `stale` are exposed so the panel can state the list's trust;
 *  - `directions` maps conditionId → 'up' | 'down' | null: the move since the previous refresh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { predictAvailable, fetchEvents, fetchMarkets } from '../lib/predict/predictClient'
import { eventFromMarket } from '../lib/predict/eventAdapters'
import { stamp as makeStamp } from '../lib/markets/serverClock'

export const REFRESH_MS = 15_000
export const SEARCH_DEBOUNCE_MS = 300

function directionOf(prev, next) {
  if (prev == null || next == null) return null
  const a = Number(prev)
  const b = Number(next)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null
  return b > a ? 'up' : 'down'
}

const toPage = (body) => ({
  events: Array.isArray(body?.events) ? body.events : [],
  next: body?.next || null,
  stale: Boolean(body?.stale),
  stamp: makeStamp({ confirmedAt: body?.confirmedAt, serverNow: body?.serverNow }),
})

// The older `/markets` body: `{ markets, next, fetchedAt, stale }`. It has no `serverNow`, so the
// age starts at receipt. That understates it by at most the gateway's cache window, and the list
// is capped below live anyway.
const toLegacyPage = (body) => ({
  events: (Array.isArray(body?.markets) ? body.markets : []).map(eventFromMarket).filter(Boolean),
  next: body?.next || null,
  stale: Boolean(body?.stale),
  stamp: makeStamp({ confirmedAt: body?.fetchedAt, serverNow: body?.fetchedAt }),
})

// A gateway without the spec-114 route answers 404 to `/events`. (The spec-114 gateway answers
// 404 only for a chain it does not serve, which carries its own code.)
const isMissingRoute = (err) => err?.status === 404 && err?.code !== 'unsupported_chain'

export function usePredictEvents({ category = '', sort = '', q = '', topic = '', live = false } = {}) {
  const chainId = useWalletChainId()
  const supported = predictAvailable(chainId)

  const [debouncedQ, setDebouncedQ] = useState(q.trim())
  useEffect(() => {
    const next = q.trim()
    if (next === debouncedQ) return undefined
    const id = setTimeout(() => setDebouncedQ(next), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [q, debouncedQ])

  const searching = debouncedQ !== ''
  const effCategory = searching ? '' : category
  const effSort = searching ? '' : sort
  // Quick filters (FR-002a) are navigation like category: a search wins over all of them, and the
  // gateway answers 400 when more than one of category/topic/live is sent, so the caller sends one.
  const effTopic = searching ? '' : topic
  const effLive = searching ? false : live === true

  const [pages, setPages] = useState([]) // [{ events, next, stale, stamp }]
  const [phase, setPhase] = useState('idle') // idle | loading | ready | degraded
  const [loadingMore, setLoadingMore] = useState(false)
  const [directions, setDirections] = useState({})
  const epochRef = useRef(0)
  const refreshingRef = useRef(false)
  const priceRef = useRef(new Map()) // conditionId → last displayPrice
  const paramsRef = useRef({})
  const legacyRef = useRef(false)
  const [legacy, setLegacy] = useState(false)

  // One place decides which route answers. Once a gateway has shown it lacks `/events` it is not
  // asked again for the life of this hook.
  const fetchPage = useCallback(async (params) => {
    if (!legacyRef.current) {
      try {
        return toPage(await fetchEvents(params.chainId, params))
      } catch (err) {
        if (!isMissingRoute(err)) throw err
        legacyRef.current = true
        setLegacy(true)
      }
    }
    return toLegacyPage(await fetchMarkets(params.chainId, { q: params.q, next: params.next }))
  }, [])
  // Kept current in an effect (declared BEFORE the reset effect below, so `load` sees it).
  useEffect(() => {
    paramsRef.current = { chainId, category: effCategory, sort: effSort, q: debouncedQ, topic: effTopic, live: effLive }
  })

  const observe = useCallback((events, { reset = false } = {}) => {
    const prices = reset ? new Map() : priceRef.current
    const moved = {}
    for (const ev of events) {
      for (const row of ev.markets || []) {
        const price = row.displayPrice ?? null
        moved[row.conditionId] = directionOf(prices.get(row.conditionId), price)
        prices.set(row.conditionId, price)
      }
    }
    priceRef.current = prices
    return moved
  }, [])

  const load = useCallback(async () => {
    if (!supported) return
    const epoch = ++epochRef.current
    setPhase('loading')
    try {
      const page = await fetchPage(paramsRef.current)
      if (epoch !== epochRef.current) return
      setDirections(observe(page.events, { reset: true }))
      setPages([page])
      setPhase('ready')
    } catch {
      if (epoch !== epochRef.current) return
      setPages([])
      setPhase('degraded')
    }
  }, [supported, observe, fetchPage])

  const loadMore = useCallback(async () => {
    const next = pages[pages.length - 1]?.next
    if (!next || loadingMore) return
    const epoch = epochRef.current
    setLoadingMore(true)
    try {
      const page = await fetchPage({ ...paramsRef.current, next })
      if (epoch !== epochRef.current) return
      setPages((prev) => [...prev, page])
      setDirections((d) => ({ ...d, ...observe(page.events) }))
    } catch {
      /* keep what we have; "Load more" stays available */
    } finally {
      if (epoch === epochRef.current) setLoadingMore(false)
    }
  }, [pages, loadingMore, observe, fetchPage])

  // Background refresh of page one only. Never touches `phase`, never clears later pages.
  const refreshFirst = useCallback(async () => {
    if (!supported || refreshingRef.current) return
    const epoch = epochRef.current
    refreshingRef.current = true
    try {
      const page = await fetchPage(paramsRef.current)
      if (epoch !== epochRef.current) return
      setDirections((d) => ({ ...d, ...observe(page.events) }))
      setPages((prev) => (prev.length === 0 ? prev : [page, ...prev.slice(1)]))
    } catch {
      /* the list keeps its last answer; its age keeps growing and the chip says so */
    } finally {
      refreshingRef.current = false
    }
  }, [supported, observe, fetchPage])

  // Full reset + first load on any query change.
  useEffect(() => {
    epochRef.current++
    refreshingRef.current = false
    setPages([])
    setPhase('idle')
    setLoadingMore(false)
    setDirections({})
    priceRef.current = new Map()
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, supported, effCategory, effSort, debouncedQ, effTopic, effLive])

  // 15 s refresh while visible; refresh on return to visible.
  useEffect(() => {
    if (!supported || typeof document === 'undefined') return undefined
    const tick = () => {
      if (document.visibilityState === 'visible') refreshFirst()
    }
    const id = setInterval(tick, REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [supported, refreshFirst])

  return useMemo(() => {
    const seen = new Set()
    const events = []
    for (const p of pages) {
      for (const ev of p.events) {
        if (seen.has(ev.slug)) continue
        seen.add(ev.slug)
        events.push(ev)
      }
    }
    let status = 'ready'
    if (!supported) status = 'unsupported'
    else if (phase === 'idle' || phase === 'loading') status = 'loading'
    else if (phase === 'degraded') status = 'degraded'
    else if (events.length === 0) status = 'empty'

    return {
      supported,
      status,
      chainId,
      events,
      hasMore: Boolean(pages[pages.length - 1]?.next),
      loadMore,
      loadingMore,
      stale: pages[0]?.stale ?? false,
      stamp: pages[0]?.stamp ?? null,
      directions,
      searching,
      // True when the gateway has no event route and the older market list is being shown:
      // categories and sort do not exist there, so the panel hides them rather than offer
      // controls that do nothing.
      legacy,
      retry: load,
    }
  }, [supported, chainId, pages, phase, loadMore, loadingMore, directions, searching, legacy, load])
}

export default usePredictEvents
