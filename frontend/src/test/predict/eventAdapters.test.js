import { describe, it, expect } from 'vitest'
import { marketFromRow, eventFromMarket, defaultRow } from '../../lib/predict/eventAdapters'
import { FED, RAIN, mkRow } from '../fixtures/predictEvents'

describe('marketFromRow', () => {
  it('names a row of a multi-market event by the event title plus the row label', () => {
    const m = marketFromRow(FED, FED.markets[0])
    expect(m.question).toBe('Fed Decision in December? — 25 bps increase')
    expect(m.conditionId).toBe('0xf1')
    expect(m.category).toBe('Economy')
  })

  it('uses the event title alone for a single-market event', () => {
    expect(marketFromRow(RAIN, RAIN.markets[0]).question).toBe('Will it rain in London tomorrow?')
  })

  it('passes outcome prices through as the gateway strings and keeps token ids strings', () => {
    const m = marketFromRow(FED, FED.markets[0])
    expect(m.outcomes).toEqual([
      { name: 'Yes', tokenId: '111', price: '0.935' },
      { name: 'No', tokenId: '222', price: '0.065' },
    ])
  })

  it('keeps a null price null (the sheet renders "no price", never 0)', () => {
    const row = mkRow({ outcomes: [{ name: 'Yes', tokenId: '1', price: null }] })
    expect(marketFromRow(RAIN, row).outcomes[0].price).toBeNull()
  })

  it('carries the per-market volume strings, null when unstated, null when the gateway predates the field', () => {
    const stated = marketFromRow(FED, mkRow({ volume: '9348387.921928', volume24h: '0' }))
    expect(stated.volume).toBe('9348387.921928')
    expect(stated.volume24h).toBe('0') // a stated zero stays zero
    const unstated = marketFromRow(FED, mkRow({ volume: null, volume24h: null }))
    expect(unstated.volume).toBeNull()
    expect(unstated.volume24h).toBeNull()
    const older = mkRow()
    delete older.volume
    delete older.volume24h
    expect(marketFromRow(FED, older).volume).toBeNull()
  })

  it('carries tradability and the venue link', () => {
    const m = marketFromRow(FED, mkRow({ tradable: false }))
    expect(m.tradable).toBe(false)
    expect(m.polymarketUrl).toBe('https://polymarket.com/event/fed-decision-in-december')
  })

  it('takes negRisk from the MARKET row, never from the event', () => {
    // negRisk selects which exchange contract the order is signed for.
    expect(marketFromRow({ ...FED, mutuallyExclusive: true }, mkRow({ negRisk: false })).negRisk).toBe(false)
    expect(marketFromRow({ ...RAIN, mutuallyExclusive: false }, mkRow({ negRisk: true })).negRisk).toBe(true)
  })

  it('a row that does not state negRisk cannot be traded from here', () => {
    const row = mkRow()
    delete row.negRisk
    const m = marketFromRow(FED, row)
    expect(m.tradable).toBe(false)
    expect(m.negRisk).toBe(false)
  })

  it('returns null without an event or row', () => {
    expect(marketFromRow(null, FED.markets[0])).toBeNull()
    expect(marketFromRow(FED, null)).toBeNull()
  })
})

describe('defaultRow', () => {
  it('prefers the first tradable row', () => {
    const ev = { markets: [mkRow({ conditionId: 'a', tradable: false }), mkRow({ conditionId: 'b' })] }
    expect(defaultRow(ev).conditionId).toBe('b')
  })
  it('falls back to the first row, then to null', () => {
    expect(defaultRow({ markets: [mkRow({ conditionId: 'a', tradable: false })] }).conditionId).toBe('a')
    expect(defaultRow({ markets: [] })).toBeNull()
  })
})

describe('eventFromMarket (gateway without the event route)', () => {
  const MARKET = {
    conditionId: '0xabc',
    question: 'Will it rain?',
    slug: 'will-it-rain',
    category: null,
    outcomes: [
      { name: 'Yes', tokenId: '1', price: '0.6' },
      { name: 'No', tokenId: '2', price: '0.4' },
    ],
    volume: { amount: '1234.5', currency: 'USDC' },
    endDate: '2026-12-01T00:00:00Z',
    negRisk: true,
    tradable: true,
  }

  it('wraps one market as a one-market event that round-trips through marketFromRow', () => {
    const ev = eventFromMarket(MARKET)
    expect(ev.marketCount).toBe(1)
    expect(ev.title).toBe('Will it rain?')
    expect(ev.volume).toBe('1234.5')
    expect(ev.markets[0].displayPrice).toBe('0.6')
    const back = marketFromRow(ev, ev.markets[0])
    expect(back.conditionId).toBe('0xabc')
    expect(back.negRisk).toBe(true)
    expect(back.tradable).toBe(true)
    expect(back.question).toBe('Will it rain?')
  })

  it('invents nothing the older route does not carry', () => {
    const ev = eventFromMarket({ ...MARKET, volume: null, outcomes: [{ name: 'Yes', tokenId: '1', price: null }] })
    expect(ev.volume).toBeNull()
    expect(ev.volume24h).toBeNull()
    expect(ev.markets[0].displayPrice).toBeNull()
    expect(ev.markets[0].bestBid).toBeNull()
    expect(eventFromMarket(null)).toBeNull()
  })
})
