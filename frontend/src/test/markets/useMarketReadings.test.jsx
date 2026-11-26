import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const unsubs = []
const subs = []
vi.mock('../../lib/markets/feed', () => ({
  subscribe: vi.fn((keys, cb) => {
    const un = vi.fn()
    unsubs.push(un)
    subs.push({ keys, cb })
    return un
  }),
}))

import { subscribe } from '../../lib/markets/feed'
import { useMarketReadings } from '../../hooks/useMarketReadings'
import { classify } from '../../lib/markets/priceReading'
import { stamp } from '../../lib/markets/serverClock'

const S = stamp({ confirmedAt: '2026-11-26T02:10:00.000Z', serverNow: '2026-11-26T02:10:00.000Z' })
const reading = classify({ price: '0.5', bids: [], asks: [], stamp: S })

beforeEach(() => {
  vi.clearAllMocks()
  unsubs.length = 0
  subs.length = 0
})

describe('useMarketReadings', () => {
  it('a missing key is unknown(not-yet-read)', () => {
    const { result } = renderHook(() => useMarketReadings(['polymarket:1']))
    expect(result.current.get('polymarket:1')).toMatchObject({ state: 'unknown', reason: 'not-yet-read' })
  })

  it('merges delivered readings and keeps identity when nothing changed', () => {
    const { result, rerender } = renderHook(({ keys }) => useMarketReadings(keys), { initialProps: { keys: ['polymarket:1'] } })
    act(() => subs[0].cb(new Map([['polymarket:1', reading]])))
    expect(result.current.get('polymarket:1')).toBe(reading)
    const before = result.current
    rerender({ keys: ['polymarket:1'] }) // new array, same keys
    expect(result.current).toBe(before)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('resubscribes when keys change and unsubscribes on unmount', () => {
    const { rerender, unmount } = renderHook(({ keys }) => useMarketReadings(keys), { initialProps: { keys: ['polymarket:1'] } })
    rerender({ keys: ['polymarket:1', 'polymarket:2'] })
    expect(unsubs[0]).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(2)
    unmount()
    expect(unsubs[1]).toHaveBeenCalledTimes(1)
  })

  it('does not subscribe for an empty key set', () => {
    renderHook(() => useMarketReadings([]))
    expect(subscribe).not.toHaveBeenCalled()
  })
})
