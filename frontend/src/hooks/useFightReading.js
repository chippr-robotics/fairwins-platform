/**
 * useFightReading (spec 115 slice 3) — one poller for a fight on the event page. Same rules as
 * useGameReading: 5 s while visible and in progress, 30 s before the start, nothing while hidden, one more
 * read after "ended" and then none; `absent` (fight route off / paused / 404 / no gateway) is terminal for
 * this page view and the caller renders NOTHING; a failed read after a good one keeps the answer and lets it
 * age on the server clock. State belongs to the gameId it was read for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import useVisiblePolling from './useVisiblePolling'
import { fetchFight, fightCadenceMs, fightIdentityOf, POLL_MS } from '../lib/sports/fightFeed'
import { fromFight, reclassifyFight } from '../lib/sports/fightReading'
import { monotonicNow } from '../lib/markets/serverClock'

const FRESH = Object.freeze({ id: null, phase: 'loading', answer: null })

export function useFightReading(game) {
  const gameId = game?.gameId ?? null
  const identity = useMemo(() => fightIdentityOf(game), [game])
  const identityKey = JSON.stringify(identity)
  const [state, setState] = useState(FRESH)
  const [now, setNow] = useState(() => monotonicNow())
  const idRef = useRef(gameId)

  const current = state.id === gameId ? state : FRESH
  const phase = current.phase
  const answer = current.answer

  const task = useCallback(async () => {
    const id = gameId
    const out = await fetchFight(id, { identity })
    if (idRef.current !== id) return false
    if (out.kind === 'absent') {
      setState({ id, phase: 'absent', answer: null })
      return false
    }
    if (out.kind === 'failed') return false
    const receivedAt = monotonicNow()
    const reading = fromFight(out.fight, out.serverNow, receivedAt)
    setState((prev) => {
      const before = prev.id === id ? prev.answer?.endedReads ?? 0 : 0
      return {
        id,
        phase: 'ready',
        answer: { reading, serverNow: out.serverNow, receivedAt, sources: out.sources, endedReads: reading.status === 'ended' ? before + 1 : 0 },
      }
    })
    return true
  }, [gameId, identityKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    idRef.current = gameId
  }, [gameId])

  const status = answer?.reading?.status ?? null
  const stopped = phase === 'absent' || (answer?.endedReads ?? 0) >= 2
  useVisiblePolling(task, {
    enabled: gameId != null && !stopped,
    baseMs: fightCadenceMs(status) ?? POLL_MS,
    factor: 1,
    resetKey: gameId,
  })

  const ticking = phase !== 'absent' && gameId != null
  useEffect(() => {
    if (!ticking) return undefined
    const id = setInterval(() => setNow(monotonicNow()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  return useMemo(
    () => ({
      phase,
      reading: answer ? reclassifyFight(answer.reading, now) : null,
      sources: answer?.sources ?? null,
      serverNow: answer?.serverNow ?? null,
      receivedAt: answer?.receivedAt ?? null,
      now,
    }),
    [phase, answer, now],
  )
}

export default useFightReading
