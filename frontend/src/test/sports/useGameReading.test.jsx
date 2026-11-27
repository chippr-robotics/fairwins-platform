/**
 * useGameReading (spec 115) — cadence, visibility, the one read after "ended", terminal `absent`, and a failed
 * read after a good one that keeps the answer and lets it age (never zeros).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../../lib/sports/gameFeed', async () => ({
  ...(await vi.importActual('../../lib/sports/gameFeed')),
  fetchGame: vi.fn(),
}))
import { fetchGame } from '../../lib/sports/gameFeed'
import { useGameReading } from '../../hooks/useGameReading'
import { row, detail, SERVER_NOW } from '../fixtures/sportsGames'

const ok = (r, extra = {}) => ({ kind: 'ok', row: r, serverNow: SERVER_NOW, sources: { venue: { state: 'read' }, plays: { state: 'read' } }, detail: null, ...extra })
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  act(() => { document.dispatchEvent(new Event('visibilitychange')) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
})
afterEach(() => vi.useRealTimers())

describe('useGameReading', () => {
  it('is loading until the first answer, then ready with a classified reading', async () => {
    fetchGame.mockResolvedValue(ok(row()))
    const { result } = renderHook(() => useGameReading(19618))
    expect(result.current.phase).toBe('loading')
    expect(result.current.reading).toBeNull()
    await advance(0)
    expect(result.current.phase).toBe('ready')
    expect(result.current.reading.state).toBe('live')
    expect(result.current.reading.score).toEqual({ home: 28, away: 10 })
    expect(fetchGame).toHaveBeenCalledWith(19618)
  })

  it('polls every 5 s while the game is in progress', async () => {
    fetchGame.mockResolvedValue(ok(row()))
    renderHook(() => useGameReading(19618))
    await advance(0)
    await advance(0) // cadence settles from the 30 s unknown-status pace to the 5 s in-play pace
    const settled = fetchGame.mock.calls.length
    await advance(5000)
    expect(fetchGame.mock.calls.length).toBe(settled + 1)
    await advance(10_000)
    expect(fetchGame.mock.calls.length).toBe(settled + 3)
  })

  it('asks far less often before the start (30 s)', async () => {
    fetchGame.mockResolvedValue(ok(row({ status: 'scheduled', score: null, clock: null, period: null })))
    renderHook(() => useGameReading(19618))
    await advance(0)
    const settled = fetchGame.mock.calls.length
    await advance(29_000)
    expect(fetchGame.mock.calls.length).toBe(settled)
    await advance(1500)
    expect(fetchGame.mock.calls.length).toBe(settled + 1)
  })

  it('asks nothing while the tab is hidden, and asks at once on return', async () => {
    fetchGame.mockResolvedValue(ok(row()))
    renderHook(() => useGameReading(19618))
    await advance(0)
    await advance(0)
    setVisibility('hidden')
    const before = fetchGame.mock.calls.length
    await advance(60_000)
    expect(fetchGame.mock.calls.length).toBe(before)
    setVisibility('visible')
    await advance(0)
    expect(fetchGame.mock.calls.length).toBe(before + 1)
  })

  it('reads ONE more time after "ended" and then never again', async () => {
    fetchGame.mockResolvedValue(ok(row({ status: 'ended', clock: null })))
    const { result } = renderHook(() => useGameReading(19618))
    await advance(0)
    await advance(6000)
    const after = fetchGame.mock.calls.length
    expect(after).toBe(2)
    await advance(120_000)
    expect(fetchGame.mock.calls.length).toBe(after)
    expect(result.current.reading.status).toBe('ended')
  })

  it('absent (module off / paused / 404) is terminal: nothing to render and no second request', async () => {
    fetchGame.mockResolvedValue({ kind: 'absent' })
    const { result } = renderHook(() => useGameReading(19618))
    await advance(0)
    expect(result.current.phase).toBe('absent')
    expect(result.current.reading).toBeNull()
    await advance(300_000)
    expect(fetchGame).toHaveBeenCalledTimes(1)
  })

  it('a failure after a good read keeps the last reading and lets it age to last-known, never zeros', async () => {
    fetchGame.mockResolvedValueOnce(ok(row()))
    fetchGame.mockResolvedValue({ kind: 'failed' })
    const { result } = renderHook(() => useGameReading(19618))
    await advance(0)
    expect(result.current.reading.state).toBe('live')
    await advance(30_000)
    expect(result.current.phase).toBe('ready')
    expect(result.current.reading.state).toBe('delayed')
    expect(result.current.reading.score).toEqual({ home: 28, away: 10 })
    await advance(100_000)
    expect(result.current.reading.state).toBe('last-known')
    expect(result.current.reading.score).toEqual({ home: 28, away: 10 })
  })

  it('a failure before any read is not a state: still loading, keeps trying', async () => {
    fetchGame.mockResolvedValue({ kind: 'failed' })
    const { result } = renderHook(() => useGameReading(19618))
    await advance(0)
    expect(result.current.phase).toBe('loading')
    expect(result.current.reading).toBeNull()
    await advance(35_000)
    expect(fetchGame.mock.calls.length).toBeGreaterThan(1)
  })

  it('passes the detail and sources through', async () => {
    fetchGame.mockResolvedValue(ok(row(), { detail: detail(), sources: { venue: { state: 'read' }, plays: { state: 'unreadable' } } }))
    const { result } = renderHook(() => useGameReading(19618))
    await advance(0)
    expect(result.current.detail.state).toBe('read')
    expect(result.current.sources.plays.state).toBe('unreadable')
  })

  it('a new game id starts from loading, never showing the previous game', async () => {
    fetchGame.mockResolvedValueOnce(ok(row()))
    fetchGame.mockImplementation(() => new Promise(() => {}))
    const { result, rerender } = renderHook(({ id }) => useGameReading(id), { initialProps: { id: 19618 } })
    await advance(0)
    expect(result.current.phase).toBe('ready')
    rerender({ id: 5 })
    expect(result.current.phase).toBe('loading')
    expect(result.current.reading).toBeNull()
  })
})
