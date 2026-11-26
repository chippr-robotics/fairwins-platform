/**
 * usePriceHistory / usePriceHistories (spec 114, US2) — one request per token+range, cached for the
 * session; an empty history is `ready` with no points; a failure is `error`, never an empty chart.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import { usePriceHistory, usePriceHistories, __resetPriceHistoryCache, HISTORY_TTL_MS } from '../../hooks/usePriceHistory'
import * as client from '../../lib/predict/predictClient'

vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchHistory: vi.fn(),
}))

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })
const body = (points, over = {}) => ({ tokenId: 't', range: '1d', points, confirmedAt: 'x', serverNow: 'x', stale: false, ...over })

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  __resetPriceHistoryCache()
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('usePriceHistory', () => {
  it('loads a token+range, then serves it from the session cache', async () => {
    client.fetchHistory.mockResolvedValue(body([{ t: 1, p: '0.5' }, { t: 2, p: '0.6' }]))
    const { result, unmount } = renderHook(() => usePriceHistory('t1', '1d'))
    expect(result.current.status).toBe('loading')
    await flush()
    expect(client.fetchHistory).toHaveBeenCalledWith(137, 't1', '1d')
    expect(result.current.status).toBe('ready')
    expect(result.current.points).toHaveLength(2)
    unmount()

    const again = renderHook(() => usePriceHistory('t1', '1d'))
    expect(again.result.current.status).toBe('ready') // no loading flash: it is already known
    await flush()
    expect(client.fetchHistory).toHaveBeenCalledTimes(1)
  })

  it('keys the cache by range, and by token', async () => {
    client.fetchHistory.mockResolvedValue(body([{ t: 1, p: '0.5' }]))
    const { rerender } = renderHook(({ id, range }) => usePriceHistory(id, range), { initialProps: { id: 'a', range: '1d' } })
    await flush()
    rerender({ id: 'a', range: '1w' })
    await flush()
    rerender({ id: 'b', range: '1w' })
    await flush()
    rerender({ id: 'a', range: '1d' })
    await flush()
    expect(client.fetchHistory.mock.calls.map((c) => c.slice(1))).toEqual([['a', '1d'], ['a', '1w'], ['b', '1w']])
  })

  it('an empty history is ready with [] — not an error, not loading', async () => {
    client.fetchHistory.mockResolvedValue(body([]))
    const { result } = renderHook(() => usePriceHistory('new-market', '1d'))
    await flush()
    expect(result.current).toMatchObject({ status: 'ready', points: [] })
  })

  it('a failure is error, is not cached, and retry asks again', async () => {
    client.fetchHistory.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(body([{ t: 1, p: '0.4' }]))
    const { result } = renderHook(() => usePriceHistory('t1', '1d'))
    await flush()
    expect(result.current.status).toBe('error')
    expect(result.current.points).toEqual([])
    await act(async () => { result.current.retry() })
    await flush()
    expect(result.current.status).toBe('ready')
    expect(client.fetchHistory).toHaveBeenCalledTimes(2)
  })

  it('treats a body with no points array as a failure, never as empty', async () => {
    client.fetchHistory.mockResolvedValue({ tokenId: 't' })
    const { result } = renderHook(() => usePriceHistory('t1', '1d'))
    await flush()
    expect(result.current.status).toBe('error')
  })

  it('refetches quietly once a cached entry is older than the gateway TTL, showing the old points meanwhile', async () => {
    client.fetchHistory.mockResolvedValueOnce(body([{ t: 1, p: '0.5' }]))
    const first = renderHook(() => usePriceHistory('t1', '1d'))
    await flush()
    first.unmount()
    const spy = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + HISTORY_TTL_MS + 1000)
    client.fetchHistory.mockResolvedValueOnce(body([{ t: 1, p: '0.5' }, { t: 2, p: '0.7' }]))
    const second = renderHook(() => usePriceHistory('t1', '1d'))
    expect(second.result.current.status).toBe('ready')
    expect(second.result.current.points).toHaveLength(1)
    await flush()
    expect(client.fetchHistory).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('is an error, with no request, off Polygon', async () => {
    client.predictAvailable.mockReturnValue(false)
    const { result } = renderHook(() => usePriceHistory('t1', '1d'))
    await flush()
    expect(result.current.status).toBe('error')
    expect(client.fetchHistory).not.toHaveBeenCalled()
  })
})

describe('usePriceHistories', () => {
  it('reads several tokens, each on its own; one failing leaves the others', async () => {
    client.fetchHistory.mockImplementation(async (_c, id) => {
      if (id === 'bad') throw new Error('down')
      return body([{ t: 1, p: '0.5' }])
    })
    const { result } = renderHook(() => usePriceHistories(['a', 'bad', 'a', 'b'], '1d'))
    await flush()
    expect(Object.keys(result.current.byToken)).toEqual(['a', 'bad', 'b'])
    expect(result.current.byToken.a.status).toBe('ready')
    expect(result.current.byToken.bad.status).toBe('error')
    expect(result.current.byToken.b.status).toBe('ready')
    expect(client.fetchHistory).toHaveBeenCalledTimes(3)
  })
})
