/**
 * useGameReading (spec 115) — one poller for a game on the event page.
 *
 * Phases: `loading` (nothing read yet) | `ready` | `absent`.
 *  - polls every 5 s while the tab is visible and the game is in play; every 30 s before the start; nothing
 *    while hidden (useVisiblePolling); an ended game is read ONE more time and then never again (FR-003);
 *  - `absent` (module off / paused / 404 / no gateway) is terminal for this page view: it does not ask again
 *    and the caller renders nothing (FR-013);
 *  - a transport failure after a good read keeps the last answer and lets it age; the reading is re-derived
 *    once a second from the SERVER's clock, so it walks live → delayed → last-known by itself and is never
 *    replaced by zeros.
 * The state belongs to the gameId it was read for; a new id starts from `loading`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useVisiblePolling from './useVisiblePolling'
import { fetchGame, cadenceMs, identityOf, POLL_MS } from '../lib/sports/gameFeed'
import { fromRow, reclassify } from '../lib/sports/gameReading'
import { monotonicNow } from '../lib/markets/serverClock'

const FRESH = Object.freeze({ id: null, phase: 'loading', answer: null })

export function useGameReading(game) {
  const gameId = game?.gameId ?? null
  const identity = useMemo(() => identityOf(game), [game])
  const identityKey = JSON.stringify(identity)
  const [state, setState] = useState(FRESH)
  const [now, setNow] = useState(() => monotonicNow())
  const idRef = useRef(gameId)

  const current = state.id === gameId ? state : FRESH
  const phase = current.phase
  const answer = current.answer

  const task = useCallback(async () => {
    const id = gameId
    const out = await fetchGame(id, { identity })
    if (idRef.current !== id) return false
    if (out.kind === 'absent') {
      setState({ id, phase: 'absent', answer: null })
      return false
    }
    if (out.kind === 'failed') return false
    const receivedAt = monotonicNow()
    const reading = fromRow(out.row, out.serverNow, receivedAt)
    setState((prev) => {
      const before = prev.id === id ? prev.answer?.endedReads ?? 0 : 0
      return {
        id,
        phase: 'ready',
        answer: {
          reading,
          row: out.row,
          serverNow: out.serverNow,
          receivedAt,
          sources: out.sources,
          detail: out.detail,
          endedReads: reading.status === 'ended' ? before + 1 : 0,
        },
      }
    })
    return true
  }, [gameId, identityKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    idRef.current = gameId
  }, [gameId])

  // The cadence follows the last status read; `ended` twice in a row stops everything.
  const status = answer?.reading?.status ?? null
  const stopped = phase === 'absent' || (answer?.endedReads ?? 0) >= 2
  useVisiblePolling(task, {
    enabled: gameId != null && !stopped,
    // The one read after "ended" is made at the in-play pace; the second ends the polling.
    baseMs: cadenceMs(status) ?? POLL_MS,
    factor: 1,
    resetKey: gameId,
  })

  // Ticks until the module is known to be off: the reading AND the listing's stand-in both age on it.
  const ticking = phase !== 'absent' && gameId != null
  useEffect(() => {
    if (!ticking) return undefined
    const id = setInterval(() => setNow(monotonicNow()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  return useMemo(
    () => ({
      phase,
      reading: answer ? reclassify(answer.reading, now) : null,
      detail: answer?.detail ?? null,
      sources: answer?.sources ?? null,
      serverNow: answer?.serverNow ?? null,
      receivedAt: answer?.receivedAt ?? null,
      now,
    }),
    [phase, answer, now],
  )
}

export default useGameReading
