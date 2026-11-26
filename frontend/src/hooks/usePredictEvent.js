/**
 * usePredictEvent (spec 114, US2) — one event with ALL its markets, by slug, from the relay-gateway
 * `/events/:slug` route. It is what lets an event page open cold from its address, with no list loaded.
 *
 * States: `loading | ready | not-found | degraded`.
 *  - `not-found` only for the gateway's own `not_found` (the venue does not know the slug);
 *  - everything else — a gateway without the route, an outage, an unsupported chain — is `degraded`
 *    (never a crash, never an endless spinner), and `retry` asks again;
 *  - it refreshes every 15 s while the document is visible (paused when hidden, refreshed on return); a
 *    background refresh never flashes `loading`, and a failed one keeps what is on screen — the age, which
 *    is derived from the gateway's server clock `stamp`, simply keeps growing;
 *  - race-safe by epoch: a slower answer for a previous slug is dropped.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { predictAvailable, fetchEvent } from '../lib/predict/predictClient'
import { stamp as makeStamp } from '../lib/markets/serverClock'

export const EVENT_REFRESH_MS = 15_000

const STATUSES = new Set(['open', 'closed', 'resolved'])

/** The gateway body is the event itself plus the envelope. A status the venue did not give is never invented. */
function toEvent(body) {
  if (!body || typeof body !== 'object' || typeof body.slug !== 'string' || !Array.isArray(body.markets)) {
    throw new Error('malformed event')
  }
  const { confirmedAt, serverNow, stale, ...event } = body
  return {
    event: { ...event, status: STATUSES.has(event.status) ? event.status : 'unknown' },
    stamp: makeStamp({ confirmedAt, serverNow }),
    stale: Boolean(stale),
  }
}

const LOADING = Object.freeze({ key: '', phase: 'loading', data: null })

export function usePredictEvent(slug) {
  const chainId = useWalletChainId()
  const supported = predictAvailable(chainId)
  // The state belongs to the (chain, slug) it was read for: anything else is `loading`, so a new slug never
  // shows the previous one's event and no effect has to reset state.
  const key = `${chainId}:${slug}`
  const [state, setState] = useState(LOADING)
  const epochRef = useRef(0)
  const refreshingRef = useRef(false)

  const fetchFirst = useCallback(async () => {
    const epoch = ++epochRef.current
    refreshingRef.current = false
    try {
      const data = toEvent(await fetchEvent(chainId, slug))
      if (epoch !== epochRef.current) return
      setState({ key, phase: 'ready', data })
    } catch (err) {
      if (epoch !== epochRef.current) return
      setState({ key, phase: err?.status === 404 && err?.code === 'not_found' ? 'not-found' : 'degraded', data: null })
    }
  }, [chainId, slug, key])

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return
    const epoch = epochRef.current
    refreshingRef.current = true
    try {
      const data = toEvent(await fetchEvent(chainId, slug))
      if (epoch !== epochRef.current) return
      setState((prev) => (prev.key === key && prev.phase === 'ready' ? { key, phase: 'ready', data } : prev))
    } catch {
      /* keep the last answer; its age keeps growing and the chip says so */
    } finally {
      refreshingRef.current = false
    }
  }, [chainId, slug, key])

  useEffect(() => {
    if (slug && supported) fetchFirst()
  }, [slug, supported, fetchFirst])

  useEffect(() => {
    if (!slug || !supported || typeof document === 'undefined') return undefined
    const tick = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    const id = setInterval(tick, EVENT_REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [slug, supported, refresh])

  const retry = useCallback(() => {
    setState(LOADING)
    fetchFirst()
  }, [fetchFirst])

  return useMemo(() => {
    // Off Polygon the tab is hidden anyway (FR-018); if it is reached, say it cannot load rather than spin.
    const current = !supported ? { key, phase: 'degraded', data: null } : state.key === key ? state : LOADING
    return {
      status: current.phase,
      event: current.data?.event ?? null,
      stamp: current.data?.stamp ?? null,
      stale: current.data?.stale ?? false,
      retry,
    }
  }, [state, key, supported, retry])
}

export default usePredictEvent
