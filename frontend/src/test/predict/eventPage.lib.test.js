/**
 * lib/predict/eventPage (spec 114 slice 4) — the pure rules behind the event page: the ten-key cap, ranking,
 * trust comparison, the https-only link rule and how a history becomes a drawable series with gaps.
 */
import { describe, it, expect } from 'vitest'
import {
  MAX_SUBSCRIBED_KEYS,
  primaryOutcome,
  counterOutcome,
  rankRows,
  subscriptionKeys,
  leastTrusting,
  stateWords,
  safeHttpsUrl,
  buildSeriesData,
  readingKey,
} from '../../lib/predict/eventPage'
import { live, delayed, lastKnown, unknown } from '../../lib/markets/priceReading'
import { stamp } from '../../lib/markets/serverClock'
import { mkRow, mkRows } from '../fixtures/predictEvents'

const at = (confirmedAt, serverNow = '2026-11-26T02:10:00.000Z') => stamp({ confirmedAt, serverNow })

describe('primary / counter outcome', () => {
  it('prefers the outcome named Yes, else the first', () => {
    expect(primaryOutcome(mkRow({ outcomes: [{ name: 'No', tokenId: '2' }, { name: 'Yes', tokenId: '1' }] })).tokenId).toBe('1')
    expect(primaryOutcome({ outcomes: [{ name: 'Lakers', tokenId: 'a' }, { name: 'Celtics', tokenId: 'b' }] }).name).toBe('Lakers')
    expect(counterOutcome({ outcomes: [{ name: 'Lakers', tokenId: 'a' }, { name: 'Celtics', tokenId: 'b' }] }).name).toBe('Celtics')
    expect(primaryOutcome({ outcomes: [] })).toBeNull()
  })
})

describe('rankRows', () => {
  it('orders by headline price, most likely first, with an unpriced row last (never first as 0)', () => {
    const rows = [
      mkRow({ conditionId: 'a', displayPrice: '0.10' }),
      mkRow({ conditionId: 'b', displayPrice: null }),
      mkRow({ conditionId: 'c', displayPrice: '0.90' }),
      mkRow({ conditionId: 'd', displayPrice: '0.10' }),
    ]
    expect(rankRows(rows).map((r) => r.conditionId)).toEqual(['c', 'a', 'd', 'b'])
  })
})

describe('subscriptionKeys — never more than ten', () => {
  it('is the Yes tokens of the first eight rows plus the selected row\'s counter token (nine)', () => {
    const rows = rankRows(mkRows(14))
    const keys = subscriptionKeys(rows, rows[0])
    expect(keys).toHaveLength(9)
    expect(keys.slice(0, 8)).toEqual(rows.slice(0, 8).map((r) => readingKey(primaryOutcome(r).tokenId)))
    expect(keys[8]).toBe(readingKey(counterOutcome(rows[0]).tokenId))
  })

  it('takes the ninth and tenth slots for a selected row further down — and stops at ten', () => {
    const rows = rankRows(mkRows(40))
    const keys = subscriptionKeys(rows, rows[30])
    expect(keys).toHaveLength(10)
    expect(keys).toContain(readingKey(primaryOutcome(rows[30]).tokenId))
    expect(keys).toContain(readingKey(counterOutcome(rows[30]).tokenId))
    for (let i = 0; i < rows.length; i++) expect(subscriptionKeys(rows, rows[i]).length).toBeLessThanOrEqual(MAX_SUBSCRIBED_KEYS)
  })

  it('handles a one-row event and an empty one', () => {
    const rows = rankRows(mkRows(1))
    expect(subscriptionKeys(rows, rows[0])).toHaveLength(2)
    expect(subscriptionKeys([], null)).toEqual([])
  })
})

describe('leastTrusting — unknown < last-known < delayed < live', () => {
  const S = at('2026-11-26T02:10:00.000Z')
  const L = live({ price: '0.5', stamp: S })
  const D = delayed({ price: '0.5', stamp: S })
  const K = lastKnown({ price: '0.5', stamp: S })
  const U = unknown('x')
  it('picks the least trusting state', () => {
    expect(leastTrusting([L, L, D, L]).state).toBe('delayed')
    expect(leastTrusting([L, D, K, L]).state).toBe('last-known')
    expect(leastTrusting([L, U, K]).state).toBe('unknown')
    expect(leastTrusting([L, L]).state).toBe('live')
    expect(leastTrusting([])).toBeNull()
  })
  it('among equals takes the oldest, so the chip shows the worst age', () => {
    const old = delayed({ price: '0.5', stamp: at('2026-11-26T02:09:40.000Z') })
    const young = delayed({ price: '0.5', stamp: at('2026-11-26T02:09:55.000Z') })
    expect(leastTrusting([young, old])).toBe(old)
    expect(leastTrusting([old, young])).toBe(old)
  })
})

describe('stateWords', () => {
  it('says nothing for live and words with an age otherwise', () => {
    const S = at('2026-11-26T02:09:50.000Z')
    expect(stateWords(live({ price: '0.5', stamp: S }))).toBeNull()
    expect(stateWords(delayed({ price: '0.5', stamp: S }))).toMatch(/^Delayed · \d+ s$/)
    expect(stateWords(lastKnown({ price: '0.5', stamp: S }))).toMatch(/^Last known · /)
    expect(stateWords(unknown('x'))).toBe('Unavailable')
  })
})

describe('safeHttpsUrl', () => {
  it('accepts https URLs only', () => {
    expect(safeHttpsUrl('https://www.federalreserve.gov/monetarypolicy.htm')).toBe('https://www.federalreserve.gov/monetarypolicy.htm')
    expect(safeHttpsUrl('  https://example.com/a  ')).toBe('https://example.com/a')
  })
  it.each([
    ['http://example.com'],
    ['javascript:alert(1)'],
    ['data:text/html,<b>x</b>'],
    ['//example.com'],
    ['example.com'],
    ['Associated Press'],
    ['https://user:pw@example.com/'],
    ['https://exa mple.com'],
    ['https://'],
    [''],
    [null],
    [undefined],
    [42],
  ])('rejects %p', (input) => {
    expect(safeHttpsUrl(input)).toBeNull()
  })
})

describe('buildSeriesData', () => {
  const step = 300
  it('is empty for no points and never invents one', () => {
    expect(buildSeriesData([], step)).toEqual([])
    expect(buildSeriesData(null, step)).toEqual([])
  })
  it('converts seconds to ms and strings to numbers', () => {
    expect(buildSeriesData([{ t: 1000, p: '0.5' }, { t: 1300, p: '0.6' }], step)).toEqual([
      { t: 1_000_000, p: 0.5 },
      { t: 1_300_000, p: 0.6 },
    ])
  })
  it('puts a null point where more than five sampling steps are missing — a gap, never a join', () => {
    const data = buildSeriesData([{ t: 1000, p: '0.5' }, { t: 1300, p: '0.5' }, { t: 1300 + step * 5 + 1, p: '0.7' }], step)
    expect(data.map((d) => d.p)).toEqual([0.5, 0.5, null, 0.7])
    // Exactly five steps is still contiguous.
    const edge = buildSeriesData([{ t: 1000, p: '0.5' }, { t: 1000 + step * 5, p: '0.7' }], step)
    expect(edge.map((d) => d.p)).toEqual([0.5, 0.7])
  })
  it('treats an unparsable price as a gap, not a zero', () => {
    const data = buildSeriesData([{ t: 1000, p: 'x' }, { t: 1300, p: null }, { t: 1600, p: '' }], step)
    expect(data.map((d) => d.p)).toEqual([null, null, null])
  })
  it('appends the live tail after the history and breaks the line if it is far from it', () => {
    const near = buildSeriesData([{ t: 1000, p: '0.5' }], step, { t: 1100, p: '0.55' })
    expect(near.at(-1)).toEqual({ t: 1_100_000, p: 0.55 })
    expect(near.map((d) => d.p)).toEqual([0.5, 0.55])
    const far = buildSeriesData([{ t: 1000, p: '0.5' }], step, { t: 1000 + step * 6, p: '0.55' })
    expect(far.map((d) => d.p)).toEqual([0.5, null, 0.55])
    expect(buildSeriesData([{ t: 1000, p: '0.5' }], step, { t: 1100, p: null })).toHaveLength(1)
  })
})
