/**
 * usePredictDiscover (spec 114, FR-002a–c) — what is active at the venue now, for the quick filters under
 * search: how many events are in play, and the topics carrying the most trading over the last day.
 *
 * The row is OPTIONAL, so this hook can never degrade the list:
 *  - a gateway without `/discover` (404), an unsupported chain or ANY failure resolves to `absent`;
 *  - a half the gateway could not read arrives as `null` and stays `null` — distinct from an honestly
 *    empty list (`topics: []`, `live.count: 0`) — and both halves null/empty is also `absent`;
 *  - it refreshes every 60 s while the document is visible (paused when hidden, refreshed on return),
 *    never flashes `loading` on a refresh, and is race-safe by epoch.
 * The server-clock `stamp` + `stale` are exposed so the panel can refuse to show filters from a reading
 * older than the last-known bound (FR-002b); this hook does not decide that.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { predictAvailable, fetchDiscover } from '../lib/predict/predictClient'
import { stamp as makeStamp } from '../lib/markets/serverClock'

export const DISCOVER_REFRESH_MS = 60_000

const ABSENT = { status: 'absent', live: null, topics: null, stamp: null, stale: false }

function liveOf(raw) {
  if (raw == null || typeof raw !== 'object') return null
  const count = Number(raw.count)
  if (!Number.isFinite(count) || count < 0) return null
  return { count: Math.floor(count), more: raw.more === true }
}

function topicsOf(raw) {
  if (!Array.isArray(raw)) return null
  const seen = new Set()
  const out = []
  for (const t of raw) {
    if (!t || typeof t.slug !== 'string' || t.slug === '' || seen.has(t.slug)) continue
    seen.add(t.slug)
    out.push({
      slug: t.slug,
      label: typeof t.label === 'string' && t.label !== '' ? t.label : t.slug,
      events: Number.isFinite(Number(t.events)) ? Number(t.events) : null,
    })
  }
  return out
}

function toState(body) {
  const live = liveOf(body?.live)
  const topics = topicsOf(body?.topics)
  // Nothing usable in either half: there is no row to draw.
  if (live == null && topics == null) return ABSENT
  return {
    status: 'ready',
    live,
    topics,
    stamp: makeStamp({ confirmedAt: body?.confirmedAt, serverNow: body?.serverNow }),
    stale: Boolean(body?.stale),
  }
}

const LOADING = Object.freeze({ ...ABSENT, status: 'loading', key: '' })

export function usePredictDiscover() {
  const chainId = useWalletChainId()
  const supported = predictAvailable(chainId)
  // The state belongs to the chain it was read for; any other chain's is `loading` until its own answer lands.
  const key = String(chainId)
  const [state, setState] = useState(LOADING)
  const epochRef = useRef(0)

  const load = useCallback(async () => {
    const epoch = ++epochRef.current
    try {
      const next = toState(await fetchDiscover(chainId))
      if (epoch !== epochRef.current) return
      setState({ ...next, key })
    } catch {
      // 404 (route missing), 503, quota, transport: the row is optional, so it is simply absent.
      if (epoch !== epochRef.current) return
      setState({ ...ABSENT, key })
    }
  }, [chainId, key])

  useEffect(() => {
    if (supported) load()
  }, [supported, load])

  useEffect(() => {
    if (!supported || typeof document === 'undefined') return undefined
    const tick = () => {
      if (document.visibilityState === 'visible') load()
    }
    const id = setInterval(tick, DISCOVER_REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [supported, load])

  return useMemo(() => {
    if (!supported) return ABSENT
    return state.key === key ? state : LOADING
  }, [supported, state, key])
}

export default usePredictDiscover
