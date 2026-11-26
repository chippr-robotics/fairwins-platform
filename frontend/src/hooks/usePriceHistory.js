/**
 * usePriceHistory / usePriceHistories (spec 114, US2) — the venue's published price history for one or
 * several outcome tokens over a range, through the gateway's `/prices-history`.
 *
 * Each token+range is cached in this module for the session (a range switch back and forth, or a
 * remount, costs no request). A cached entry older than the gateway's own 60 s TTL is shown at once and
 * refetched quietly. Only a successful answer is cached; a failure is `error` (never an empty chart),
 * and an honestly empty history is `ready` with `points: []`.
 *
 * Per token: `{ status: 'loading' | 'ready' | 'error', points: [{ t (s), p }], stale }`.
 */
import { useCallback, useEffect, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { predictAvailable, fetchHistory } from '../lib/predict/predictClient'
import { monotonicNow } from '../lib/markets/serverClock'

export const HISTORY_TTL_MS = 60_000

const cache = new Map() // `${chainId}:${tokenId}:${range}` → { points, stale, at }
const keyOf = (chainId, tokenId, range) => `${chainId}:${tokenId}:${range}`

export function __resetPriceHistoryCache() {
  cache.clear()
}

const LOADING = Object.freeze({ status: 'loading', points: [], stale: false })
const FAILED = Object.freeze({ status: 'error', points: [], stale: false })

const entryFrom = (cached) => ({ status: 'ready', points: cached.points, stale: cached.stale })

export function usePriceHistories(tokenIds, range) {
  const chainId = useWalletChainId()
  const supported = predictAvailable(chainId)
  const ids = [...new Set((Array.isArray(tokenIds) ? tokenIds : []).filter((t) => t != null && t !== '').map(String))]
  const sig = JSON.stringify([chainId, range, ids])
  const [net, setNet] = useState({ sig: '', byToken: {} }) // what the network has said for `sig`
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!supported || ids.length === 0) return undefined
    let cancelled = false
    const toFetch = ids.filter((id) => {
      const hit = cache.get(keyOf(chainId, id, range))
      return !hit || monotonicNow() - hit.at > HISTORY_TTL_MS
    })
    toFetch.forEach((id) => {
      fetchHistory(chainId, id, range)
        .then((body) => {
          if (!Array.isArray(body?.points)) throw new Error('malformed history')
          const points = body.points.filter((p) => p && Number.isFinite(Number(p.t)))
          cache.set(keyOf(chainId, id, range), { points, stale: Boolean(body.stale), at: monotonicNow() })
          if (!cancelled) setNet((prev) => ({ sig, byToken: { ...(prev.sig === sig ? prev.byToken : {}), [id]: 'ok' } }))
        })
        .catch(() => {
          if (!cancelled) setNet((prev) => ({ sig, byToken: { ...(prev.sig === sig ? prev.byToken : {}), [id]: 'failed' } }))
        })
    })
    return () => {
      cancelled = true
    }
    // `ids` is represented by `sig`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, attempt, supported])

  // Only successes are cached, so asking again is just re-running the effect.
  const retry = useCallback(() => {
    setNet({ sig: '', byToken: {} })
    setAttempt((n) => n + 1)
  }, [])

  const byToken = {}
  for (const id of ids) {
    const hit = cache.get(keyOf(chainId, id, range))
    if (hit) byToken[id] = entryFrom(hit)
    else if (!supported) byToken[id] = FAILED
    else byToken[id] = net.sig === sig && net.byToken[id] === 'failed' ? FAILED : LOADING
  }
  return { byToken, retry }
}

export function usePriceHistory(tokenId, range) {
  const { byToken, retry } = usePriceHistories(tokenId == null ? [] : [tokenId], range)
  return { ...(byToken[String(tokenId)] ?? LOADING), retry }
}

export default usePriceHistory
