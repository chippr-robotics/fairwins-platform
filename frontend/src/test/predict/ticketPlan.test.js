/**
 * ticketPlan (spec 114 slice 5) — the figures the ticket and review show, and the last-moment re-check.
 * Book: asks 0.94×200, 0.95×1200, 0.96×12.5; bids 0.93×300, 0.92×5120; tick 0.01; minimum 5 shares.
 */
import { describe, it, expect } from 'vitest'
import { planForTicket, checkStillSignable, parseTyped, centsToPrice, onTickGrid, beyondLimit } from '../../lib/predict/ticketPlan'
import { unknown } from '../../lib/markets/priceReading'
import { liquid, bookReading } from './ticketFixtures'

describe('parseTyped / centsToPrice / onTickGrid', () => {
  it('canonicalises what a member types and says when it is nothing or nonsense', () => {
    expect(parseTyped('')).toEqual({ ok: false, empty: true })
    expect(parseTyped('  ')).toEqual({ ok: false, empty: true })
    expect(parseTyped('25')).toEqual({ ok: true, value: '25' })
    expect(parseTyped('025.50')).toEqual({ ok: true, value: '25.5' })
    expect(parseTyped('.5')).toEqual({ ok: true, value: '0.5' })
    expect(parseTyped('5.')).toEqual({ ok: true, value: '5' })
    for (const bad of ['abc', '1e3', '-5', '1.2.3', '$5', '0.1234567']) expect(parseTyped(bad)).toEqual({ ok: false, reason: 'invalid-amount' })
  })
  it('cents in, decimal price out — and only prices a tick grid could hold', () => {
    expect(centsToPrice('57')).toBe('0.57')
    expect(centsToPrice('57.5')).toBe('0.575')
    expect(centsToPrice('')).toBeNull()
    expect(centsToPrice('abc')).toBeNull()
    expect(centsToPrice('0')).toBeNull()
    expect(onTickGrid('0.57', '0.01')).toBe(true)
    expect(onTickGrid('0.575', '0.01')).toBe(false)
    expect(onTickGrid('0.575', '0.001')).toBe(true)
    expect(onTickGrid('1', '0.01')).toBe(false)
  })
  it('beyondLimit: above for a buy, below for a sell, and unreadable is beyond', () => {
    expect(beyondLimit('buy', '0.96', '0.95')).toBe(true)
    expect(beyondLimit('buy', '0.95', '0.95')).toBe(false)
    expect(beyondLimit('sell', '0.91', '0.92')).toBe(true)
    expect(beyondLimit('sell', '0.92', '0.92')).toBe(false)
    expect(beyondLimit('buy', undefined, '0.95')).toBe(true)
  })
})

describe('planForTicket — states with no figure', () => {
  it('nothing typed is empty; nonsense is invalid', () => {
    expect(planForTicket({ reading: liquid(), side: 'buy', typed: '' })).toEqual({ status: 'empty' })
    expect(planForTicket({ reading: liquid(), side: 'buy', typed: 'abc' })).toEqual({ status: 'invalid', reason: 'invalid-amount' })
  })

  it.each([
    ['delayed', liquid({ age: 6000 })],
    ['last known', liquid({ age: 31000 })],
    ['unknown', unknown('not-yet-read')],
    ['absent', undefined],
  ])('a %s reading gives ONLY { status: "not-live" } — no average, shares, payout or limit (FR-013)', (_n, reading) => {
    const v = planForTicket({ reading, side: 'buy', typed: '50' })
    expect(v).toEqual({ status: 'not-live' })
  })

  it('also not-live when the member names a price', () => {
    expect(planForTicket({ reading: liquid({ age: 6000 }), side: 'buy', typed: '50', ownPrice: '0.5' })).toEqual({ status: 'not-live' })
  })

  it('refusals carry a reason, and the minimum order as numbers for the sentence', () => {
    const small = planForTicket({ reading: liquid(), side: 'buy', typed: '1' })
    expect(small).toMatchObject({ status: 'refused', reason: 'below-minimum', min: { shares: '5', usd: '4.7' } })
    expect(planForTicket({ reading: bookReading({ bids: [['0.4', '10']] }), side: 'buy', typed: '50' })).toMatchObject({ status: 'refused', reason: 'no-depth' })
    expect(planForTicket({ reading: liquid(), side: 'buy', typed: '0.004' })).toMatchObject({ status: 'refused', reason: 'rounds-to-zero' })
    expect(planForTicket({ reading: liquid(), side: 'buy', typed: '0' })).toMatchObject({ status: 'refused', reason: 'rounds-to-zero' })
  })
})

describe('planForTicket — a marketable order (fill-and-kill at a limit)', () => {
  it('buy $50: shares, average, payout and the limit one tick beyond the deepest level touched', () => {
    const v = planForTicket({ reading: liquid(), side: 'buy', typed: '50' })
    expect(v).toMatchObject({ status: 'ok', kind: 'marketable', side: 'buy', payAtMost: '50', limitPrice: '0.95', shares: '53.191489', partial: null, unfilled: '0' })
    expect(v.signed).toMatchObject({ kind: 'marketable', side: 'BUY', amount: '50', limitPrice: '0.95', tickSize: '0.01', makerAmount: '50' })
    expect(v.payoutIfRight).toBe('53.191489')
    expect(v.depthShare).toBeCloseTo(0.0377, 3)
  })

  it('the limit reaches the deepest level an amount needs (it must still cross what it was planned against)', () => {
    const v = planForTicket({ reading: liquid(), side: 'buy', typed: '199.4' })
    expect(v.plan.worstPrice).toBe('0.95')
    expect(v.limitPrice).toBe('0.96')
    expect(v.feePlan.cost).toBe('199.4')
  })

  it('beyond the visible depth: says how much CAN be filled, and signs only that (the ceiling shown is the ceiling signed)', () => {
    const v = planForTicket({ reading: liquid(), side: 'buy', typed: '2000' })
    expect(v.status).toBe('ok')
    expect(v.partial).toEqual({ fillable: '1340', unfilled: '660' })
    expect(v.signed.amount).toBe('1340')
    expect(v.payAtMost).toBe('1340')
    expect(v.unfilled).toBe('0') // the re-plan of what is actually signed has nothing left over
    expect(v.rounded).toBe(true)
    expect(v.limitPrice).toBe('0.97')
  })

  it('a typed amount the SDK would round is planned from the ROUNDED amount, and says so', () => {
    const v = planForTicket({ reading: liquid(), side: 'buy', typed: '12.345' })
    expect(v).toMatchObject({ status: 'ok', payAtMost: '12.34', rounded: true })
    expect(v.signed.amount).toBe('12.34')
  })

  it('sell 100 shares: proceeds, limit one tick BELOW the worst bid, no payout, no pay-at-most', () => {
    const v = planForTicket({ reading: liquid(), side: 'sell', typed: '100' })
    expect(v).toMatchObject({ status: 'ok', kind: 'marketable', side: 'sell', limitPrice: '0.92', proceeds: '93', payAtMost: null, payoutIfRight: null, sellShares: '100' })
    expect(v.signed).toMatchObject({ side: 'SELL', amount: '100', limitPrice: '0.92' })
  })

  it('selling more than is bid: only the bid shares are signed', () => {
    const v = planForTicket({ reading: bookReading({ bids: [['0.93', '40']] }), side: 'sell', typed: '100' })
    expect(v.partial).toEqual({ fillable: '40', unfilled: '60' })
    expect(v.signed.amount).toBe('40')
  })

  it('uses the reading\'s own tick over the listing\'s (the fresher fact)', () => {
    const r = bookReading({ tickSize: '0.001', asks: [['0.940', '500']] })
    const v = planForTicket({ reading: r, side: 'buy', typed: '50', tickSize: '0.01' })
    expect(v.signed.tickSize).toBe('0.001') // the reading's own tick wins over the listing's...
    expect(v.limitPrice).toBe('0.941')
    const noTick = bookReading({ asks: [['0.94', '500']] })
    const w = planForTicket({ reading: { ...noTick, tickSize: undefined }, side: 'buy', typed: '50', tickSize: '0.01' })
    expect(w.signed.tickSize).toBe('0.01') // ...and the listing's is the fallback when the reading carries none
  })
})

describe('planForTicket — a price the member names (rests)', () => {
  it('buy $50 at 57¢: whole hundredths of a share, paid at the member\'s own price', () => {
    const v = planForTicket({ reading: liquid(), side: 'buy', typed: '50', ownPrice: '0.57' })
    expect(v).toMatchObject({ status: 'ok', kind: 'resting', limitPrice: '0.57', averagePrice: '0.57', shares: '87.71', payAtMost: '49.9947', crossesBook: false })
    expect(v.signed).toMatchObject({ kind: 'resting', side: 'BUY', size: '87.71', limitPrice: '0.57' })
    expect(v.rounded).toBe(true)
  })

  it('says so when the price is already on offer (it would fill, not rest)', () => {
    expect(planForTicket({ reading: liquid(), side: 'buy', typed: '50', ownPrice: '0.95' }).crossesBook).toBe(true)
    expect(planForTicket({ reading: liquid(), side: 'sell', typed: '20', ownPrice: '0.9' }).crossesBook).toBe(true)
    expect(planForTicket({ reading: liquid(), side: 'sell', typed: '20', ownPrice: '0.99' }).crossesBook).toBe(false)
  })

  it('a price off the tick grid is refused in place — never snapped to something the member did not type', () => {
    expect(planForTicket({ reading: liquid(), side: 'buy', typed: '50', ownPrice: '0.575' })).toMatchObject({ status: 'refused', reason: 'invalid-limit' })
    expect(planForTicket({ reading: liquid(), side: 'buy', typed: '50', ownPrice: 'unusable' })).toMatchObject({ status: 'refused', reason: 'invalid-limit' })
  })
})

describe('checkStillSignable — FR-021, the reviewed limit is never silently replaced', () => {
  const reviewedBuy = () => planForTicket({ reading: liquid(), side: 'buy', typed: '50' })
  const check = (over) => checkStillSignable({ reviewed: reviewedBuy(), reading: liquid(), side: 'buy', typed: '50', ...over })

  it('unchanged book: signable as reviewed', () => {
    expect(check({})).toEqual({ ok: true })
  })
  it('a BETTER book is still signable (the limit is a ceiling, not a price)', () => {
    expect(check({ reading: bookReading({ asks: [['0.90', '1000']] }) })).toEqual({ ok: true })
  })
  it('asks moved beyond the reviewed limit: not signable, and the NEW figures are offered', () => {
    const r = check({ reading: bookReading({ asks: [['0.97', '1000']] }) })
    expect(r).toMatchObject({ ok: false, reason: 'beyond-limit' })
    expect(r.next).toMatchObject({ status: 'ok', limitPrice: '0.98' })
  })
  it('depth shrank so the reviewed amount no longer fills', () => {
    expect(check({ reading: bookReading({ asks: [['0.94', '10']] }) })).toMatchObject({ ok: false, reason: 'depth-shrank' })
  })
  it('no depth at all: the plan is refused and the new state says so', () => {
    const r = check({ reading: bookReading({ bids: [['0.4', '10']] }) })
    expect(r).toMatchObject({ ok: false, reason: 'plan-refused' })
    expect(r.next.status).toBe('refused')
  })
  it('a reading that is not live: not signable, nothing planned', () => {
    expect(check({ reading: liquid({ age: 6000 }) })).toEqual({ ok: false, reason: 'not-live', next: { status: 'not-live' } })
    expect(check({ reading: unknown('x') }).reason).toBe('not-live')
  })
  it('the market\'s price step changed', () => {
    expect(check({ reading: liquid({ tickSize: '0.001' }) })).toMatchObject({ ok: false, reason: 'tick-changed' })
  })
  it('a sell: bids fell below the reviewed limit', () => {
    const reviewed = planForTicket({ reading: liquid(), side: 'sell', typed: '100' })
    expect(checkStillSignable({ reviewed, reading: liquid(), side: 'sell', typed: '100' })).toEqual({ ok: true })
    const r = checkStillSignable({ reviewed, reading: bookReading({ bids: [['0.90', '300']] }), side: 'sell', typed: '100' })
    expect(r).toMatchObject({ ok: false, reason: 'beyond-limit' })
  })
  it('a resting order: unchanged is fine; a book that now crosses the price is a different order', () => {
    const reviewed = planForTicket({ reading: liquid(), side: 'buy', typed: '50', ownPrice: '0.57' })
    expect(checkStillSignable({ reviewed, reading: liquid(), side: 'buy', typed: '50', ownPrice: '0.57' })).toEqual({ ok: true })
    const crossed = checkStillSignable({ reviewed, reading: bookReading({ asks: [['0.57', '1000']] }), side: 'buy', typed: '50', ownPrice: '0.57' })
    expect(crossed).toMatchObject({ ok: false, reason: 'crossing-changed' })
  })
})
