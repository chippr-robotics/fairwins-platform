import { describe, it, expect } from 'vitest'
import {
  LIVE_WITHIN_MS,
  DELAYED_WITHIN_MS,
  live,
  delayed,
  lastKnown,
  unknown,
  classify,
  reclassify,
  demote,
  describeAge,
  displayPrice,
} from '../../lib/markets/priceReading'
import { stamp } from '../../lib/markets/serverClock'

// A stamp whose age at monotonic `now` is exactly `now` (confirmedAt === serverNow, received at 0).
const S = stamp({ confirmedAt: '2026-11-26T02:10:00.000Z', serverNow: '2026-11-26T02:10:00.000Z' }, 0)
const BOOK = { price: '0.935', bids: [['0.93', '10']], asks: [['0.94', '10']], stamp: S }

describe('constants', () => {
  it('are the spec bounds', () => {
    expect(LIVE_WITHIN_MS).toBe(5000)
    expect(DELAYED_WITHIN_MS).toBe(30000)
  })
})

describe('classify boundaries', () => {
  it.each([
    [0, 'live'],
    [5000, 'live'],
    [5001, 'delayed'],
    [30000, 'delayed'],
    [30001, 'last-known'],
  ])('age %i -> %s', (age, state) => {
    expect(classify(BOOK, age).state).toBe(state)
  })

  it('only live is plannable', () => {
    expect(classify(BOOK, 100).plannable).toBe(true)
    expect(classify(BOOK, 6000).plannable).toBe(false)
    expect(classify(BOOK, 60000).plannable).toBe(false)
    expect(unknown('x').plannable).toBe(false)
    expect(delayed(BOOK).plannable).toBe(false)
    expect(lastKnown(BOOK).plannable).toBe(false)
    expect(live(BOOK).plannable).toBe(true)
  })

  it('a stale input can never be live', () => {
    expect(classify({ ...BOOK, stale: true }, 0).state).toBe('delayed')
    expect(classify({ ...BOOK, stale: true }, 31000).state).toBe('last-known')
    expect(classify({ ...BOOK, stale: true }, 0).plannable).toBe(false)
  })

  it('an unknowable age is unknown, never fresh', () => {
    expect(classify({ ...BOOK, stamp: stamp({}, 0) }, 0).state).toBe('unknown')
    expect(classify({ ...BOOK, stamp: undefined }, 0).state).toBe('unknown')
  })

  it('no price is unknown', () => {
    expect(classify({ ...BOOK, price: null }, 0).state).toBe('unknown')
  })
})

describe('unknown', () => {
  it('carries no price, bids, asks or stamp key at all', () => {
    const u = unknown('unreadable')
    for (const k of ['price', 'bids', 'asks', 'stamp']) expect(Object.hasOwn(u, k)).toBe(false)
    expect(u.reason).toBe('unreadable')
    expect(u.ageMs()).toBeNull()
  })
})

describe('frozen', () => {
  it('readings and their book levels cannot be mutated', () => {
    const r = classify(BOOK, 0)
    expect(Object.isFrozen(r)).toBe(true)
    expect(Object.isFrozen(r.bids)).toBe(true)
    expect(Object.isFrozen(r.bids[0])).toBe(true)
    expect(Object.isFrozen(unknown('x'))).toBe(true)
    expect(() => {
      'use strict'
      r.plannable = false
    }).toThrow()
  })

  it('keeps prices and sizes as strings, and extra cannot override core fields', () => {
    const r = classify({ ...BOOK, extra: { tickSize: '0.01', state: 'live', plannable: true } }, 9000)
    expect(typeof r.price).toBe('string')
    expect(typeof r.bids[0][1]).toBe('string')
    expect(r.tickSize).toBe('0.01')
    expect(r.state).toBe('delayed')
    expect(r.plannable).toBe(false)
  })
})

describe('reclassify / demote', () => {
  it('ages a reading with no new data and returns the same object when unchanged', () => {
    const r = classify(BOOK, 0)
    expect(reclassify(r, 4000)).toBe(r)
    const d = reclassify(r, 6000)
    expect(d.state).toBe('delayed')
    expect(d.price).toBe('0.935')
    expect(reclassify(d, 31000).state).toBe('last-known')
    expect(reclassify(d, 7000)).toBe(d)
  })

  it('keeps extra fields across a reclassify', () => {
    const r = classify({ ...BOOK, extra: { tickSize: '0.01' } }, 0)
    expect(reclassify(r, 6000).tickSize).toBe('0.01')
  })

  it('leaves unknown alone', () => {
    const u = unknown('x')
    expect(reclassify(u, 1)).toBe(u)
  })

  it('demote holds a live reading at delayed even though its age is fresh', () => {
    const r = classify(BOOK, 0)
    const d = demote(r)
    expect(d.state).toBe('delayed')
    expect(d.plannable).toBe(false)
    expect(reclassify(d, 100).state).toBe('delayed')
    expect(demote(d)).toBe(d)
  })
})

describe('describeAge', () => {
  it.each([
    [3000, '3 s'],
    [48000, '48 s'],
    [120000, '2 min'],
    [3600000, '1 h'],
    [null, '—'],
    [NaN, '—'],
  ])('%s -> %s', (ms, text) => expect(describeAge(ms)).toBe(text))
})

describe('displayPrice', () => {
  it('is the integer midpoint while the spread is <= 0.10, else the last trade', () => {
    expect(displayPrice('0.93', '0.94', '0.5')).toBe('0.935')
    expect(displayPrice('0.10', '0.20', '0.5')).toBe('0.15')
    expect(displayPrice('0.10', '0.21', '0.5')).toBe('0.5')
    expect(displayPrice(undefined, '0.94', '0.5')).toBe('0.5')
    expect(displayPrice(undefined, undefined, null)).toBeNull()
  })
})
