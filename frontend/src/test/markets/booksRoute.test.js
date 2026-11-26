/**
 * A gateway with no books route (spec 114, FR-029): the seam says so, once, so the order surface can fall back
 * to the fixed-price confirm. Only a 404 counts — an outage is not an absent route — and any books answer clears it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../lib/predict/predictClient', () => ({ fetchBooks: vi.fn() }))

import { fetchBooks } from '../../lib/predict/predictClient'
import { subscribe, __resetForTests } from '../../lib/markets/feed'
import { booksRouteMissing, subscribeBooksRoute, setBooksRouteMissing, __resetRouteSupportForTests } from '../../lib/markets/routeSupport'

const NOW = '2026-11-26T02:10:00.000Z'
const ok = (ids) => ({
  books: ids.map((tokenId) => ({ tokenId, bids: [['0.93', '1']], asks: [['0.94', '1']], tickSize: '0.01', minOrderSize: '5', lastTradePrice: '0.93', venueTime: NOW, venueHash: 'h' })),
  unreadable: [],
  confirmedAt: NOW,
  serverNow: NOW,
  stale: false,
})
const http = (status) => Object.assign(new Error(`http ${status}`), { status })

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  __resetRouteSupportForTests()
})
afterEach(() => {
  __resetForTests()
  vi.useRealTimers()
})
const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

describe('books route support', () => {
  it('a 404 from the books route is recorded, and listeners are told once', async () => {
    const listener = vi.fn()
    subscribeBooksRoute(listener)
    fetchBooks.mockRejectedValue(http(404))
    subscribe(['polymarket:1'], vi.fn())
    await flush(1)
    expect(booksRouteMissing()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it.each([503, 500, 429])('a %s is an outage, NOT an absent route: the member stays on the live ticket', async (status) => {
    fetchBooks.mockRejectedValue(http(status))
    subscribe(['polymarket:1'], vi.fn())
    await flush(1)
    expect(booksRouteMissing()).toBe(false)
  })

  it('a network failure with no status is not an absent route either', async () => {
    fetchBooks.mockRejectedValue(new Error('network down'))
    subscribe(['polymarket:1'], vi.fn())
    await flush(1)
    expect(booksRouteMissing()).toBe(false)
  })

  it('an answer from the books route clears it (the gateway was rolled out)', async () => {
    setBooksRouteMissing(true)
    fetchBooks.mockImplementation(async (_c, ids) => ok(ids))
    subscribe(['polymarket:1'], vi.fn())
    await flush(1)
    expect(booksRouteMissing()).toBe(false)
  })
})
