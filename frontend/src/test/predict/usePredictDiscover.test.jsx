/**
 * usePredictDiscover (spec 114, FR-002a–c) — loads /discover, refreshes every 60 s while visible, is
 * race-safe, and degrades to `absent` (never to an error the list would feel) on a missing route or any
 * failure. A half the gateway could not read stays null, distinct from an honestly empty one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { usePredictDiscover } from '../../hooks/usePredictDiscover'
import * as client from '../../lib/predict/predictClient'
import { envelope } from '../fixtures/predictEvents'

vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchDiscover: vi.fn(),
}))

const TOPICS = [
  { slug: 'basketball', label: 'Basketball', events: 11, volume24h: '10546858.02' },
  { slug: 'NFL-playoffs', label: 'NFL', events: 3, volume24h: '8402870.58' },
]
const body = (over = {}) => ({ live: { count: 14, events: [] }, topics: TOPICS, ...envelope(), ...over })
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
  setVisibility('visible')
})
afterEach(() => {
  vi.useRealTimers()
  setVisibility('visible')
})

describe('usePredictDiscover', () => {
  it('loads, then exposes live, topics, the stamp and stale', async () => {
    client.fetchDiscover.mockResolvedValue(body({ stale: true }))
    const { result } = renderHook(() => usePredictDiscover())
    expect(result.current.status).toBe('loading')
    await flush()
    expect(client.fetchDiscover).toHaveBeenCalledWith(137)
    expect(result.current.status).toBe('ready')
    expect(result.current.live).toEqual({ count: 14, more: false })
    expect(result.current.topics.map((t) => t.slug)).toEqual(['basketball', 'NFL-playoffs'])
    expect(result.current.stale).toBe(true)
    expect(result.current.stamp).toMatchObject({ confirmedAtMs: Date.parse(envelope().confirmedAt) })
  })

  it('carries `more` so the count can say 50+', async () => {
    client.fetchDiscover.mockResolvedValue(body({ live: { count: 50, more: true, events: [] } }))
    const { result } = renderHook(() => usePredictDiscover())
    await flush()
    expect(result.current.live).toEqual({ count: 50, more: true })
  })

  it('keeps an unreadable half null, and an empty half empty — they are different facts', async () => {
    client.fetchDiscover.mockResolvedValueOnce(body({ live: null }))
    const { result } = renderHook(() => usePredictDiscover())
    await flush()
    expect(result.current.status).toBe('ready')
    expect(result.current.live).toBeNull()
    expect(result.current.topics).toHaveLength(2)

    client.fetchDiscover.mockResolvedValueOnce(body({ topics: null, live: { count: 0, events: [] } }))
    const { result: r2 } = renderHook(() => usePredictDiscover())
    await flush()
    expect(r2.current.topics).toBeNull()
    expect(r2.current.live).toEqual({ count: 0, more: false })

    client.fetchDiscover.mockResolvedValueOnce(body({ topics: [] }))
    const { result: r3 } = renderHook(() => usePredictDiscover())
    await flush()
    expect(r3.current.topics).toEqual([])
  })

  it('is absent when both halves are unreadable', async () => {
    client.fetchDiscover.mockResolvedValue(body({ live: null, topics: null }))
    const { result } = renderHook(() => usePredictDiscover())
    await flush()
    expect(result.current.status).toBe('absent')
    expect(result.current.live).toBeNull()
    expect(result.current.topics).toBeNull()
  })

  it('is absent (not an error) for a missing route, an outage and an unsupported chain', async () => {
    client.fetchDiscover.mockRejectedValueOnce(Object.assign(new Error('nf'), { status: 404, code: 'http_404' }))
    const { result } = renderHook(() => usePredictDiscover())
    await flush()
    expect(result.current.status).toBe('absent')

    client.fetchDiscover.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503, code: 'upstream_unavailable' }))
    const { result: r2 } = renderHook(() => usePredictDiscover())
    await flush()
    expect(r2.current.status).toBe('absent')

    client.predictAvailable.mockReturnValue(false)
    client.fetchDiscover.mockClear()
    const { result: r3 } = renderHook(() => usePredictDiscover())
    await flush()
    expect(r3.current.status).toBe('absent')
    expect(client.fetchDiscover).not.toHaveBeenCalled()
  })

  it('refreshes every 60 s without flashing loading, and pauses while hidden', async () => {
    client.fetchDiscover.mockResolvedValue(body())
    const { result } = renderHook(() => usePredictDiscover())
    await flush()
    client.fetchDiscover.mockClear()
    const seen = []
    await advance(59_000)
    expect(client.fetchDiscover).not.toHaveBeenCalled()
    await advance(1_000)
    seen.push(result.current.status)
    expect(client.fetchDiscover).toHaveBeenCalledTimes(1)
    expect(seen).toEqual(['ready'])

    client.fetchDiscover.mockClear()
    setVisibility('hidden')
    await advance(180_000)
    expect(client.fetchDiscover).not.toHaveBeenCalled()
    setVisibility('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(client.fetchDiscover).toHaveBeenCalledTimes(1)
  })

  it('a failed refresh makes the row absent until the next one succeeds', async () => {
    client.fetchDiscover.mockResolvedValueOnce(body())
    const { result } = renderHook(() => usePredictDiscover())
    await flush()
    client.fetchDiscover.mockRejectedValueOnce(new Error('down'))
    await advance(60_000)
    expect(result.current.status).toBe('absent')
    client.fetchDiscover.mockResolvedValueOnce(body({ live: { count: 2, events: [] } }))
    await advance(60_000)
    expect(result.current.status).toBe('ready')
    expect(result.current.live.count).toBe(2)
  })

  it('ignores a slower earlier answer after the chain changes', async () => {
    let resolveOld
    client.fetchDiscover
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r }))
      .mockResolvedValueOnce(body({ live: { count: 3, events: [] } }))
    const { result, rerender } = renderHook(() => usePredictDiscover())
    setWalletChain(80002)
    client.predictAvailable.mockReturnValue(true)
    rerender()
    await flush()
    expect(result.current.live.count).toBe(3)
    await act(async () => resolveOld(body({ live: { count: 99, events: [] } })))
    expect(result.current.live.count).toBe(3)
  })
})
