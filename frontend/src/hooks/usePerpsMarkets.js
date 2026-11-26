/**
 * usePerpsMarkets (spec 082) — merged perp pairs across venues with search/filter/sort.
 *
 * Status model is the hard three-state convention (useEarnVaults): 'loading' | 'ready' |
 * 'unavailable' — never stale numbers presented as live, never an empty list masquerading as an
 * outage. Per-venue health rides alongside as `sources` (FR-004): a degraded venue is disclosed
 * while the others keep rendering.
 *
 * Race-safe: a request id guards stale responses (the usePredictEvents idiom). Deps are
 * injectable for tests.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchPerpPairs, PerpsUnavailable } from '../lib/perps/perpsClient'
import { perpsAvailable } from '../config/perps'

const REFRESH_MS = 30_000

const SORTS = {
  oi: (a, b) => (b.openInterestUsd ?? -1) - (a.openInterestUsd ?? -1),
  volume: (a, b) => (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1),
  funding: (a, b) => Math.abs(b.fundingRate ?? 0) - Math.abs(a.fundingRate ?? 0),
  symbol: (a, b) => a.symbol.localeCompare(b.symbol),
}

export function usePerpsMarkets({ deps } = {}) {
  const io = { fetchPairs: fetchPerpPairs, available: perpsAvailable, ...deps }
  const supported = io.available()

  const [status, setStatus] = useState(supported ? 'loading' : 'unavailable')
  const [pairs, setPairs] = useState([])
  const [sources, setSources] = useState({})
  const [asOf, setAsOf] = useState(null)
  const [search, setSearch] = useState('')
  const [venueFilter, setVenueFilter] = useState('all')
  const [sortKey, setSortKey] = useState('oi')
  const reqIdRef = useRef(0)
  const ioRef = useRef(io)
  useEffect(() => {
    ioRef.current = io
  })

  const load = useCallback(async () => {
    if (!ioRef.current.available()) {
      setStatus('unavailable')
      return
    }
    const reqId = (reqIdRef.current += 1)
    try {
      const body = await ioRef.current.fetchPairs()
      if (reqIdRef.current !== reqId) return // stale response — a newer request owns the state
      setPairs(Array.isArray(body?.pairs) ? body.pairs : [])
      setSources(body?.sources ?? {})
      setAsOf(body?.asOf ?? null)
      setStatus('ready')
    } catch (e) {
      if (reqIdRef.current !== reqId) return
      // Total outage (or unconfigured gateway): the whole surface pauses honestly.
      setPairs([])
      setSources({})
      setStatus(e instanceof PerpsUnavailable ? 'unavailable' : 'unavailable')
    }
  }, [])

  useEffect(() => {
    if (!supported) {
      setStatus('unavailable')
      return undefined
    }
    setStatus('loading')
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => clearInterval(timer)
  }, [supported, load])

  const visible = useMemo(() => {
    const q = search.trim().toUpperCase()
    let list = pairs
    if (venueFilter !== 'all') list = list.filter((p) => p.venue === venueFilter)
    if (q) list = list.filter((p) => p.symbol.toUpperCase().includes(q) || p.base?.toUpperCase().includes(q))
    return [...list].sort(SORTS[sortKey] ?? SORTS.oi)
  }, [pairs, search, venueFilter, sortKey])

  const degradedVenues = useMemo(
    () =>
      Object.entries(sources)
        .filter(([, s]) => s?.status === 'degraded')
        .map(([venue]) => venue),
    [sources],
  )

  return {
    status, // 'loading' | 'ready' | 'unavailable'
    supported,
    pairs: visible,
    /**
     * The venue feed BEFORE the member's search/filter/sort (spec 083).
     *
     * `pairs` above is a view of the table and is the wrong thing to price a position from: it
     * shrinks when a member types in the search box, so a close built off it would stop being
     * priceable because of a UI control that has nothing to do with the position. Anything asking
     * "what does the venue say this pair costs right now" reads this instead.
     */
    allPairs: pairs,
    totalCount: pairs.length,
    sources,
    degradedVenues,
    asOf,
    search,
    setSearch,
    venueFilter,
    setVenueFilter,
    sortKey,
    setSortKey,
    refresh: load,
  }
}
