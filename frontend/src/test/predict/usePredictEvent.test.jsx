/**
 * usePredictEvent (spec 114, US2) — loads one event by slug, refreshes every 15 s while visible, is
 * race-safe, and maps a missing event and an outage to different states without ever throwing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { usePredictEvent } from '../../hooks/usePredictEvent'
import * as client from '../../lib/predict/predictClient'
import { detailBody, mkRows, envelope } from '../fixtures/predictEvents'

vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchEvent: vi.fn(),
}))

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const advance = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}
const apiError = (status, code) => Object.assign(new Error(code), { status, code })

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

describe('usePredictEvent', () => {
  it('loads the event and exposes the envelope as a stamp, never as part of the event', async () => {
    client.fetchEvent.mockResolvedValue(detailBody({}, { stale: true }))
    const { result } = renderHook(() => usePredictEvent('fed-decision-in-december'))
    expect(result.current.status).toBe('loading')
    await flush()
    expect(client.fetchEvent).toHaveBeenCalledWith(137, 'fed-decision-in-december')
    expect(result.current.status).toBe('ready')
    expect(result.current.event.title).toBe('Fed Decision in December?')
    expect(result.current.event.markets).toHaveLength(3)
    expect(result.current.event).not.toHaveProperty('confirmedAt')
    expect(result.current.stale).toBe(true)
    expect(result.current.stamp).toMatchObject({ confirmedAtMs: Date.parse(envelope().confirmedAt) })
  })

  it('never invents a status the venue did not give', async () => {
    client.fetchEvent.mockResolvedValue(detailBody({ status: undefined }))
    const { result } = renderHook(() => usePredictEvent('x'))
    await flush()
    expect(result.current.event.status).toBe('unknown')
  })

  it('is not-found only for the gateway\'s own not_found; a missing route or outage is degraded', async () => {
    client.fetchEvent.mockRejectedValueOnce(apiError(404, 'not_found'))
    const { result } = renderHook(() => usePredictEvent('gone'))
    await flush()
    expect(result.current.status).toBe('not-found')

    client.fetchEvent.mockRejectedValueOnce(apiError(404, 'http_404'))
    const { result: r2 } = renderHook(() => usePredictEvent('x'))
    await flush()
    expect(r2.current.status).toBe('degraded')

    client.fetchEvent.mockRejectedValueOnce(apiError(503, 'upstream_unavailable'))
    const { result: r3 } = renderHook(() => usePredictEvent('x'))
    await flush()
    expect(r3.current.status).toBe('degraded')

    client.fetchEvent.mockResolvedValueOnce({ nonsense: true })
    const { result: r4 } = renderHook(() => usePredictEvent('x'))
    await flush()
    expect(r4.current.status).toBe('degraded')
  })

  it('is degraded, and does not fetch, off Polygon', async () => {
    client.predictAvailable.mockReturnValue(false)
    const { result } = renderHook(() => usePredictEvent('x'))
    await flush()
    expect(result.current.status).toBe('degraded')
    expect(client.fetchEvent).not.toHaveBeenCalled()
  })

  it('retry asks again and recovers', async () => {
    client.fetchEvent.mockRejectedValueOnce(apiError(503, 'upstream_unavailable')).mockResolvedValueOnce(detailBody())
    const { result } = renderHook(() => usePredictEvent('x'))
    await flush()
    expect(result.current.status).toBe('degraded')
    await act(async () => { result.current.retry() })
    await flush()
    expect(result.current.status).toBe('ready')
  })

  it('refreshes every 15 s without flashing loading, keeping the old answer when one fails', async () => {
    client.fetchEvent.mockResolvedValueOnce(detailBody({ title: 'First' }))
    const { result } = renderHook(() => usePredictEvent('x'))
    await flush()
    const stampBefore = result.current.stamp
    client.fetchEvent.mockResolvedValueOnce(detailBody({ title: 'Second' }))
    await advance(15_000)
    expect(result.current.status).toBe('ready')
    expect(result.current.event.title).toBe('Second')
    expect(result.current.stamp).not.toBe(stampBefore)

    client.fetchEvent.mockRejectedValueOnce(new Error('down'))
    await advance(15_000)
    expect(result.current.status).toBe('ready')
    expect(result.current.event.title).toBe('Second')
  })

  it('pauses while hidden and refreshes on return', async () => {
    client.fetchEvent.mockResolvedValue(detailBody())
    renderHook(() => usePredictEvent('x'))
    await flush()
    client.fetchEvent.mockClear()
    setVisibility('hidden')
    await advance(60_000)
    expect(client.fetchEvent).not.toHaveBeenCalled()
    setVisibility('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await flush()
    expect(client.fetchEvent).toHaveBeenCalledTimes(1)
  })

  it('drops a slower answer for a previous slug', async () => {
    let resolveOld
    client.fetchEvent
      .mockImplementationOnce(() => new Promise((r) => { resolveOld = r }))
      .mockResolvedValueOnce(detailBody({ slug: 'new-one', title: 'New one', markets: mkRows(1) }))
    const { result, rerender } = renderHook(({ slug }) => usePredictEvent(slug), { initialProps: { slug: 'old-one' } })
    rerender({ slug: 'new-one' })
    await flush()
    expect(result.current.event.title).toBe('New one')
    await act(async () => resolveOld(detailBody({ title: 'Old one' })))
    expect(result.current.event.title).toBe('New one')
  })
})
