/**
 * usePredictEvents (spec 114) — query-driven reload, race safety, the 15 s first-page refresh (paused
 * while hidden), debounced search, direction between refreshes, and the list's stamp/stale.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { usePredictEvents } from '../../hooks/usePredictEvents'
import * as client from '../../lib/predict/predictClient'
import { FED, RAIN, mkEvent, mkRow, envelope } from '../fixtures/predictEvents'

vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchEvents: vi.fn(),
  fetchMarkets: vi.fn(),
}))

const page = (events, over = {}) => ({ events, next: null, ...envelope(), ...over })
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

describe('usePredictEvents', () => {
  it('loads a first page, exposing the envelope stamp and stale', async () => {
    client.fetchEvents.mockResolvedValue(page([FED, RAIN], { stale: true }))
    const { result } = renderHook(() => usePredictEvents({ category: 'economy', sort: 'volume24h' }))
    expect(result.current.status).toBe('loading')
    await flush()
    expect(result.current.status).toBe('ready')
    expect(result.current.events.map((e) => e.slug)).toEqual([FED.slug, RAIN.slug])
    expect(result.current.stale).toBe(true)
    expect(result.current.stamp).toMatchObject({ confirmedAtMs: Date.parse(envelope().confirmedAt) })
    expect(client.fetchEvents).toHaveBeenCalledWith(137, { chainId: 137, category: 'economy', sort: 'volume24h', q: '' })
  })

  it('is unsupported (and does not fetch) off Polygon', async () => {
    client.predictAvailable.mockReturnValue(false)
    const { result } = renderHook(() => usePredictEvents())
    await flush()
    expect(result.current.status).toBe('unsupported')
    expect(client.fetchEvents).not.toHaveBeenCalled()
  })

  it('reports empty and degraded', async () => {
    client.fetchEvents.mockResolvedValueOnce(page([]))
    const { result } = renderHook(() => usePredictEvents())
    await flush()
    expect(result.current.status).toBe('empty')

    client.fetchEvents.mockRejectedValueOnce(new Error('down'))
    const { result: r2 } = renderHook(() => usePredictEvents({ category: 'crypto' }))
    await flush()
    expect(r2.current.status).toBe('degraded')
  })

  it('re-queries on category change and ignores a slower earlier answer', async () => {
    let resolveOld
    client.fetchEvents
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r }))
      .mockResolvedValueOnce(page([RAIN]))
    const { result, rerender } = renderHook((p) => usePredictEvents(p), { initialProps: { category: '' } })
    rerender({ category: 'world' })
    await flush()
    expect(result.current.events.map((e) => e.slug)).toEqual([RAIN.slug])
    await act(async () => resolveOld(page([FED])))
    expect(result.current.events.map((e) => e.slug)).toEqual([RAIN.slug])
  })

  it('debounces q by 300 ms, and sends neither category nor sort while searching', async () => {
    client.fetchEvents.mockResolvedValue(page([RAIN]))
    const { rerender } = renderHook((p) => usePredictEvents(p), { initialProps: { category: 'crypto', sort: 'newest', q: '' } })
    await flush()
    client.fetchEvents.mockClear()
    rerender({ category: 'crypto', sort: 'newest', q: 'rai' })
    await advance(200)
    rerender({ category: 'crypto', sort: 'newest', q: 'rain' })
    await advance(200)
    expect(client.fetchEvents).not.toHaveBeenCalled()
    await advance(150)
    expect(client.fetchEvents).toHaveBeenCalledTimes(1)
    expect(client.fetchEvents).toHaveBeenCalledWith(137, { chainId: 137, category: '', sort: '', q: 'rain' })
  })

  it('pages: loadMore appends and de-duplicates by slug', async () => {
    client.fetchEvents
      .mockResolvedValueOnce(page([FED], { next: '20' }))
      .mockResolvedValueOnce(page([FED, RAIN]))
    const { result } = renderHook(() => usePredictEvents())
    await flush()
    expect(result.current.hasMore).toBe(true)
    await act(async () => { result.current.loadMore() })
    await flush()
    expect(client.fetchEvents).toHaveBeenLastCalledWith(137, expect.objectContaining({ next: '20' }))
    expect(result.current.events.map((e) => e.slug)).toEqual([FED.slug, RAIN.slug])
    expect(result.current.hasMore).toBe(false)
  })

  it('refreshes page one every 15 s without flashing loading or dropping later pages', async () => {
    client.fetchEvents
      .mockResolvedValueOnce(page([FED], { next: '20' }))
      .mockResolvedValueOnce(page([RAIN]))
      .mockResolvedValue(page([FED], { next: '20' }))
    const { result } = renderHook(() => usePredictEvents())
    await flush()
    await act(async () => { result.current.loadMore() })
    await flush()
    expect(result.current.events).toHaveLength(2)

    const seen = []
    client.fetchEvents.mockClear()
    await advance(15_000)
    seen.push(result.current.status)
    expect(client.fetchEvents).toHaveBeenCalledTimes(1)
    expect(client.fetchEvents.mock.calls[0][1].next).toBeUndefined()
    expect(seen).toEqual(['ready'])
    // Page two survived the page-one refresh.
    expect(result.current.events.map((e) => e.slug)).toEqual([FED.slug, RAIN.slug])
  })

  it('pauses the refresh while hidden and refreshes on return', async () => {
    client.fetchEvents.mockResolvedValue(page([FED]))
    renderHook(() => usePredictEvents())
    await flush()
    client.fetchEvents.mockClear()
    setVisibility('hidden')
    await advance(45_000)
    expect(client.fetchEvents).not.toHaveBeenCalled()
    setVisibility('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(client.fetchEvents).toHaveBeenCalledTimes(1)
  })

  it('keeps the list and its old stamp when a background refresh fails', async () => {
    client.fetchEvents.mockResolvedValueOnce(page([FED]))
    const { result } = renderHook(() => usePredictEvents())
    await flush()
    const before = result.current.stamp
    client.fetchEvents.mockRejectedValueOnce(new Error('down'))
    await advance(15_000)
    expect(result.current.status).toBe('ready')
    expect(result.current.stamp).toBe(before)
  })

  it('reports direction between refreshes, and null for unchanged or unknown prices', async () => {
    const withPrice = (displayPrice) => mkEvent({ slug: 'x', markets: [mkRow({ conditionId: '0xa', displayPrice })] })
    client.fetchEvents
      .mockResolvedValueOnce(page([withPrice('0.50')]))
      .mockResolvedValueOnce(page([withPrice('0.55')]))
      .mockResolvedValueOnce(page([withPrice('0.40')]))
      .mockResolvedValueOnce(page([withPrice('0.40')]))
      .mockResolvedValueOnce(page([withPrice(null)]))
    const { result } = renderHook(() => usePredictEvents())
    await flush()
    expect(result.current.directions['0xa']).toBeNull()
    await advance(15_000)
    expect(result.current.directions['0xa']).toBe('up')
    await advance(15_000)
    expect(result.current.directions['0xa']).toBe('down')
    await advance(15_000)
    expect(result.current.directions['0xa']).toBeNull()
    await advance(15_000)
    expect(result.current.directions['0xa']).toBeNull()
  })

  describe('a gateway that has no event route yet', () => {
    const notFound = (code = 'http_404') => Object.assign(new Error('not found'), { status: 404, code })
    const LEGACY = {
      markets: [
        {
          conditionId: '0xold',
          question: 'An older market?',
          slug: 'an-older-market',
          outcomes: [{ name: 'Yes', tokenId: '1', price: '0.4' }, { name: 'No', tokenId: '2', price: '0.6' }],
          volume: null,
          endDate: null,
          negRisk: true,
          tradable: true,
        },
      ],
      next: null,
      fetchedAt: '2026-11-26T02:10:00.000Z',
      stale: false,
    }

    it('falls back to the older market list, says so, and stops asking for events', async () => {
      client.fetchEvents.mockRejectedValue(notFound())
      client.fetchMarkets.mockResolvedValue(LEGACY)
      const { result } = renderHook(() => usePredictEvents({ category: 'economy', q: '' }))
      await flush()
      expect(result.current.status).toBe('ready')
      expect(result.current.legacy).toBe(true)
      expect(result.current.events).toHaveLength(1)
      expect(result.current.events[0].markets[0]).toMatchObject({ conditionId: '0xold', negRisk: true, tradable: true })
      expect(result.current.events[0].volume).toBeNull()
      expect(client.fetchMarkets).toHaveBeenCalledWith(137, { q: '', next: undefined })

      client.fetchEvents.mockClear()
      client.fetchMarkets.mockClear()
      await advance(15_000)
      expect(client.fetchEvents).not.toHaveBeenCalled()
      expect(client.fetchMarkets).toHaveBeenCalledTimes(1)
    })

    it('does not fall back for a chain the gateway does not serve, or for an outage', async () => {
      client.fetchEvents.mockRejectedValueOnce(notFound('unsupported_chain'))
      const { result } = renderHook(() => usePredictEvents())
      await flush()
      expect(result.current.status).toBe('degraded')
      expect(result.current.legacy).toBe(false)

      client.fetchEvents.mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503, code: 'upstream_unavailable' }))
      const { result: r2 } = renderHook(() => usePredictEvents({ category: 'crypto' }))
      await flush()
      expect(r2.current.status).toBe('degraded')
      expect(client.fetchMarkets).not.toHaveBeenCalled()
    })

    it('is degraded, not empty, when the older route fails too', async () => {
      client.fetchEvents.mockRejectedValue(notFound())
      client.fetchMarkets.mockRejectedValue(new Error('down'))
      const { result } = renderHook(() => usePredictEvents())
      await flush()
      expect(result.current.status).toBe('degraded')
    })
  })
})
