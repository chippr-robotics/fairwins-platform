import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../lib/predict/predictClient', () => ({ fetchBooks: vi.fn() }))

import { fetchBooks } from '../../lib/predict/predictClient'
import { subscribe, __resetForTests, POLL_MS, BACKOFF_MS } from '../../lib/markets/feed'

const NOW = '2026-11-26T02:10:00.000Z'
const book = (tokenId, bid = '0.93', ask = '0.94') => ({
  tokenId,
  bids: [[bid, '100']],
  asks: [[ask, '100']],
  tickSize: '0.01',
  minOrderSize: '5',
  lastTradePrice: bid,
  venueTime: NOW,
  venueHash: 'h',
})
const respond = (ids, unreadable = []) => ({
  books: ids.filter((i) => !unreadable.includes(i)).map((i) => book(i)),
  unreadable,
  confirmedAt: NOW,
  serverNow: NOW,
  stale: false,
})

function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fetchBooks.mockImplementation(async (_chain, ids) => respond(ids))
  setVisibility('visible')
})
afterEach(() => {
  __resetForTests()
  vi.useRealTimers()
})

const flush = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

describe('feed — sharing and batching', () => {
  it('two subscribers to the same key share ONE request', async () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribe(['polymarket:111'], a)
    subscribe(['polymarket:111'], b)
    await flush(1)
    expect(fetchBooks).toHaveBeenCalledTimes(1)
    expect(fetchBooks.mock.calls[0][1]).toEqual(['111'])
    expect(a).toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    expect(a.mock.calls[0][0].get('polymarket:111').state).toBe('live')
  })

  it('uses the predict-capable chain from config, in batches of at most ten', async () => {
    const keys = Array.from({ length: 11 }, (_, i) => `polymarket:${i + 1}`)
    subscribe(keys, vi.fn())
    await flush(1)
    expect(fetchBooks).toHaveBeenCalledTimes(2)
    expect(fetchBooks.mock.calls[0][0]).toBe(137)
    expect(fetchBooks.mock.calls[0][1]).toHaveLength(10)
    expect(fetchBooks.mock.calls[1][1]).toHaveLength(1)
  })

  it('a key nobody holds stops being requested; the last unsubscribe stops polling', async () => {
    const un1 = subscribe(['polymarket:1', 'polymarket:2'], vi.fn())
    const un2 = subscribe(['polymarket:1'], vi.fn())
    await flush(1)
    un1()
    await flush(POLL_MS)
    expect(fetchBooks.mock.calls.at(-1)[1]).toEqual(['1'])
    un2()
    const n = fetchBooks.mock.calls.length
    await flush(POLL_MS * 10)
    expect(fetchBooks).toHaveBeenCalledTimes(n)
  })
})

describe('feed — honesty', () => {
  it('ages live -> delayed -> last-known with no new response', async () => {
    const seen = []
    subscribe(['polymarket:1'], (m) => seen.push(m.get('polymarket:1').state))
    await flush(1)
    expect(seen).toEqual(['live'])
    fetchBooks.mockRejectedValue(new Error('down')) // nothing new will arrive
    await flush(6000)
    expect(seen).toContain('delayed')
    await flush(31000)
    expect(seen.at(-1)).toBe('last-known')
    expect(seen.filter((s, i) => i > 0 && s === seen[i - 1])).toEqual([]) // only on change
  })

  it('an unreadable token is unknown, never an empty book; absent is unknown too', async () => {
    fetchBooks.mockResolvedValue({ ...respond(['1', '2', '3'], ['2']), books: [book('1')] })
    const cb = vi.fn()
    subscribe(['polymarket:1', 'polymarket:2', 'polymarket:3'], cb)
    await flush(1)
    const m = cb.mock.calls[0][0]
    expect(m.get('polymarket:1').state).toBe('live')
    expect(m.get('polymarket:2')).toMatchObject({ state: 'unknown', reason: 'unreadable' })
    expect(m.get('polymarket:3')).toMatchObject({ state: 'unknown', reason: 'missing' })
    expect(Object.hasOwn(m.get('polymarket:2'), 'bids')).toBe(false)
  })

  it('price is the integer midpoint while the spread is tight, else the last trade', async () => {
    fetchBooks.mockResolvedValue({
      ...respond([]),
      books: [book('1'), { ...book('2', '0.10', '0.50'), lastTradePrice: '0.3' }],
    })
    const cb = vi.fn()
    subscribe(['polymarket:1', 'polymarket:2'], cb)
    await flush(1)
    const m = cb.mock.calls[0][0]
    expect(m.get('polymarket:1').price).toBe('0.935')
    expect(m.get('polymarket:2').price).toBe('0.3')
  })

  it('a stale gateway answer can never be live', async () => {
    fetchBooks.mockResolvedValue({ ...respond(['1']), stale: true })
    const cb = vi.fn()
    subscribe(['polymarket:1'], cb)
    await flush(1)
    expect(cb.mock.calls[0][0].get('polymarket:1').state).toBe('delayed')
  })

  it('a non-polymarket key is unknown and never requested', async () => {
    const cb = vi.fn()
    subscribe(['other:1'], cb)
    await flush(POLL_MS * 2)
    expect(fetchBooks).not.toHaveBeenCalled()
    expect(cb.mock.calls[0][0].get('other:1').state).toBe('unknown')
  })
})

describe('feed — cadence', () => {
  it('polls every 2 s, backs off to 10 s on error, recovers on success', async () => {
    subscribe(['polymarket:1'], vi.fn())
    await flush(1)
    expect(fetchBooks).toHaveBeenCalledTimes(1)
    await flush(POLL_MS)
    expect(fetchBooks).toHaveBeenCalledTimes(2)

    fetchBooks.mockRejectedValue(new Error('boom'))
    await flush(POLL_MS) // call 3 fails
    expect(fetchBooks).toHaveBeenCalledTimes(3)
    await flush(BACKOFF_MS - 2) // call 3 ran 1 ms before this point
    expect(fetchBooks).toHaveBeenCalledTimes(3)
    fetchBooks.mockImplementation(async (_c, ids) => respond(ids))
    await flush(2) // call 4 at +10 s, succeeds
    expect(fetchBooks).toHaveBeenCalledTimes(4)
    await flush(POLL_MS)
    expect(fetchBooks).toHaveBeenCalledTimes(5) // back to 2 s
  })

  it('does not poll while hidden and polls immediately when visible again', async () => {
    subscribe(['polymarket:1'], vi.fn())
    await flush(1)
    expect(fetchBooks).toHaveBeenCalledTimes(1)
    setVisibility('hidden')
    await flush(POLL_MS * 10)
    expect(fetchBooks).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    await flush(1)
    expect(fetchBooks).toHaveBeenCalledTimes(2)
  })
})

describe('feed — isolation', () => {
  it('a throwing subscriber does not break another, and nothing throws out', async () => {
    const good = vi.fn()
    subscribe(['polymarket:1'], () => {
      throw new Error('subscriber bug')
    })
    subscribe(['polymarket:1'], good)
    await flush(1)
    expect(good).toHaveBeenCalled()
  })

  it('delivers already-known readings to a late subscriber', async () => {
    subscribe(['polymarket:1'], vi.fn())
    await flush(1)
    const late = vi.fn()
    subscribe(['polymarket:1'], late)
    expect(late).toHaveBeenCalledTimes(1)
    expect(late.mock.calls[0][0].get('polymarket:1').state).toBe('live')
  })
})
