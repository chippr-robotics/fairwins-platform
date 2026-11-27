/** useFightReading (spec 115 slice 3): cadence, visibility, one read after ended, terminal absent, ageing. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../lib/sports/fightFeed', async () => ({ ...(await vi.importActual('../../lib/sports/fightFeed')), fetchFight: vi.fn() }))
import { fetchFight } from '../../lib/sports/fightFeed'
import { useFightReading } from '../../hooks/useFightReading'
import { fight, FIGHT_LISTING, SERVER_NOW, SOURCES, DECISION } from '../fixtures/sportsFights'

const ok = (f) => ({ kind: 'ok', fight: f, serverNow: SERVER_NOW, sources: SOURCES })
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
function vis(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})
afterEach(() => vi.useRealTimers())

describe('useFightReading', () => {
  it('loading, then ready with a classified reading; the claim rides along', async () => {
    fetchFight.mockResolvedValue(ok(fight()))
    const { result } = renderHook(() => useFightReading(FIGHT_LISTING))
    expect(result.current.phase).toBe('loading')
    await advance(0)
    expect(result.current.phase).toBe('ready')
    expect(result.current.reading.state).toBe('live')
    expect(result.current.reading.round).toBe(2)
    expect(fetchFight.mock.calls[0][0]).toBe(13140)
    expect(Object.keys(fetchFight.mock.calls[0][1].identity)).toEqual(expect.arrayContaining(['a', 'b']))
  })
  it('polls every 5 s in progress, and nothing while hidden', async () => {
    fetchFight.mockResolvedValue(ok(fight()))
    renderHook(() => useFightReading(FIGHT_LISTING))
    await advance(0); await advance(0)
    const n = fetchFight.mock.calls.length
    await advance(5000)
    expect(fetchFight.mock.calls.length).toBe(n + 1)
    vis('hidden')
    const h = fetchFight.mock.calls.length
    await advance(60_000)
    expect(fetchFight.mock.calls.length).toBe(h)
    vis('visible'); await advance(0)
    expect(fetchFight.mock.calls.length).toBe(h + 1)
  })
  it('is slow (30 s) before the start', async () => {
    fetchFight.mockResolvedValue(ok(fight({ status: 'scheduled', round: null, clock: null })))
    renderHook(() => useFightReading(FIGHT_LISTING))
    await advance(0)
    const n = fetchFight.mock.calls.length
    await advance(29_000)
    expect(fetchFight.mock.calls.length).toBe(n)
    await advance(1500)
    expect(fetchFight.mock.calls.length).toBe(n + 1)
  })
  it('one more read after ended, then never again', async () => {
    fetchFight.mockResolvedValue(ok(fight({ status: 'ended', source: 'figures', result: DECISION })))
    renderHook(() => useFightReading(FIGHT_LISTING))
    await advance(0); await advance(6000)
    const n = fetchFight.mock.calls.length
    expect(n).toBe(2)
    await advance(300_000)
    expect(fetchFight.mock.calls.length).toBe(n)
  })
  it('absent is terminal: nothing to render, no second request', async () => {
    fetchFight.mockResolvedValue({ kind: 'absent' })
    const { result } = renderHook(() => useFightReading(FIGHT_LISTING))
    await advance(0)
    expect(result.current.phase).toBe('absent')
    expect(result.current.reading).toBeNull()
    await advance(300_000)
    expect(fetchFight).toHaveBeenCalledTimes(1)
  })
  it('a failure after a good read keeps the answer and ages it; a failure before any read stays loading', async () => {
    fetchFight.mockResolvedValueOnce(ok(fight()))
    fetchFight.mockResolvedValue({ kind: 'failed' })
    const { result } = renderHook(() => useFightReading(FIGHT_LISTING))
    await advance(0)
    await advance(40_000)
    expect(result.current.reading.state).toBe('delayed')
    expect(result.current.reading.round).toBe(2)
    await advance(100_000)
    expect(result.current.reading.state).toBe('last-known')
    fetchFight.mockReset(); fetchFight.mockResolvedValue({ kind: 'failed' })
    const { result: r2 } = renderHook(() => useFightReading({ ...FIGHT_LISTING, gameId: 5 }))
    await advance(0)
    expect(r2.current.phase).toBe('loading')
  })
  it('a venue-sourced answer is delayed at once, never live', async () => {
    fetchFight.mockResolvedValue(ok(fight({ source: 'venue', round: null, confirmedAt: SERVER_NOW })))
    const { result } = renderHook(() => useFightReading(FIGHT_LISTING))
    await advance(0)
    expect(result.current.reading.state).toBe('delayed')
  })
})
