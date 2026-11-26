import { describe, it, expect } from 'vitest'
import { planOrder, planNotional } from '../../lib/predict/orderPlan'
import { classify, unknown } from '../../lib/markets/priceReading'
import { stamp } from '../../lib/markets/serverClock'

const S = stamp({ confirmedAt: '2026-11-26T02:10:00.000Z', serverNow: '2026-11-26T02:10:00.000Z' }, 0)
const book = ({ asks = [], bids = [], age = 0 } = {}) => classify({ price: '0.5', asks, bids, stamp: S }, age)
const base = { tickSize: '0.01', minOrderSize: '5' }

describe('planOrder — guards', () => {
  it('refuses a delayed or last-known reading with a full book (checked first)', () => {
    const asks = [['0.50', '1000']]
    for (const age of [6000, 31000]) {
      expect(planOrder({ ...base, reading: book({ asks, age }), side: 'buy', amount: '10' })).toEqual({
        ok: false,
        reason: 'price-not-live',
      })
    }
  })

  it('refuses an unknown reading, even with an invalid amount', () => {
    expect(planOrder({ ...base, reading: unknown('unreadable'), side: 'buy', amount: 'abc' }).reason).toBe('price-not-live')
    expect(planOrder({ ...base, reading: undefined, side: 'buy', amount: '10' }).reason).toBe('price-not-live')
  })

  it('refuses a delayed reading even when the member names a limit price', () => {
    const r = planOrder({ ...base, reading: book({ age: 6000 }), side: 'buy', amount: '10', limitPrice: '0.45' })
    expect(r.reason).toBe('price-not-live')
  })

  it.each(['', '0', '0.0', 'abc', '-5', '1e3', null, undefined, 5])('invalid amount %s', (amount) => {
    const r = planOrder({ ...base, reading: book({ asks: [['0.5', '100']] }), side: 'buy', amount })
    expect(r).toEqual({ ok: false, reason: 'invalid-amount' })
  })

  it('no depth on the far side', () => {
    expect(planOrder({ ...base, reading: book({ bids: [['0.4', '9']] }), side: 'buy', amount: '10' }).reason).toBe('no-depth')
    expect(planOrder({ ...base, reading: book({ asks: [['0.4', '9']] }), side: 'sell', amount: '10' }).reason).toBe('no-depth')
    expect(planOrder({ ...base, reading: book(), side: 'buy', amount: '10' }).reason).toBe('no-depth')
  })

  it('below minimum', () => {
    const r = planOrder({ ...base, reading: book({ asks: [['0.50', '100']] }), side: 'buy', amount: '1' })
    expect(r).toEqual({ ok: false, reason: 'below-minimum' })
  })

  it('refuses a missing tick rather than guessing one', () => {
    const r = planOrder({ reading: book({ asks: [['0.5', '100']] }), side: 'buy', amount: '10' })
    expect(r.reason).toBe('invalid-tick')
  })
})

describe('planOrder — buy', () => {
  it('single level, exact', () => {
    const r = planOrder({ ...base, reading: book({ asks: [['0.94', '100']] }), side: 'buy', amount: '47' })
    expect(r).toEqual({
      ok: true,
      kind: 'marketable',
      shares: '50.0',
      averagePrice: '0.94',
      worstPrice: '0.94',
      limitPrice: '0.95',
      cost: '47.0',
      unfilled: '0.0',
      depthShare: 0.5,
      payoutIfRight: '50.0',
    })
  })

  it('walks several levels with hand-computed micro-unit results', () => {
    const asks = [['0.50', '10'], ['0.60', '10'], ['0.70', '10']]
    const r = planOrder({ ...base, reading: book({ asks }), side: 'buy', amount: '12' })
    // 10 @0.50 (5.0) + 10 @0.60 (6.0) leaves 1.0 -> floor(1e6*1e6/7e5)=1428571 micro-shares @0.70
    expect(r.shares).toBe('21.428571')
    expect(r.cost).toBe('12.0')
    expect(r.worstPrice).toBe('0.7')
    expect(r.limitPrice).toBe('0.71')
    // 12e12 / 21428571 = 560000.0112 -> rounded UP against the member
    expect(r.averagePrice).toBe('0.560001')
    expect(r.depthShare).toBe(0.7142)
    expect(r.unfilled).toBe('0.0')
  })

  it('beyond visible depth fills what is there and reports the rest unfilled', () => {
    const r = planOrder({ ...base, reading: book({ asks: [['0.50', '10']] }), side: 'buy', amount: '10' })
    expect(r.ok).toBe(true)
    expect(r.shares).toBe('10.0')
    expect(r.cost).toBe('5.0')
    expect(r.unfilled).toBe('5.0')
    expect(r.depthShare).toBe(1)
  })

  it('limit on the grid for tick 0.01, snapping an off-grid worst UP', () => {
    const r = planOrder({ ...base, reading: book({ asks: [['0.945', '100']] }), side: 'buy', amount: '10' })
    expect(r.worstPrice).toBe('0.945')
    expect(r.limitPrice).toBe('0.96')
  })

  it('limit on the grid for tick 0.001', () => {
    const r = planOrder({ reading: book({ asks: [['0.123', '100']] }), side: 'buy', amount: '12.3', tickSize: '0.001', minOrderSize: '5' })
    expect(r.shares).toBe('100.0')
    expect(r.limitPrice).toBe('0.124')
    const wide = planOrder({ reading: book({ asks: [['0.123', '100']] }), side: 'buy', amount: '12.3', tickSize: '0.001', minOrderSize: '5', toleranceTicks: 5 })
    expect(wide.limitPrice).toBe('0.128')
  })

  it('never exceeds the highest price on the market\'s own grid (one tick below 1)', () => {
    expect(planOrder({ ...base, reading: book({ asks: [['0.99', '100']] }), side: 'buy', amount: '10' }).limitPrice).toBe('0.99')
    const fine = planOrder({ reading: book({ asks: [['0.989', '100']] }), side: 'buy', amount: '10', tickSize: '0.001', minOrderSize: '5', toleranceTicks: 20 })
    expect(fine.limitPrice).toBe('0.999')
  })

  it('a limit can always reach the level it was planned against, even above 0.99', () => {
    // 0.995 is a real ask on a 0.001-tick market; a cap at 0.99 would leave the order unable to fill.
    const r = planOrder({ reading: book({ asks: [['0.995', '100']] }), side: 'buy', amount: '10', tickSize: '0.001', minOrderSize: '5' })
    expect(r.worstPrice).toBe('0.995')
    expect(r.limitPrice).toBe('0.996')
  })

  it('rounding dust left inside a level is not reported as unfilled', () => {
    // 10 USDC at 0.333333 buys 30.00003 shares for 9.999999…; the few micro-units left over cannot
    // buy another micro-share. Depth did not run out, so nothing is unfilled.
    const r = planOrder({ ...base, reading: book({ asks: [['0.333333', '1000']] }), side: 'buy', amount: '10' })
    expect(r.ok).toBe(true)
    expect(r.unfilled).toBe('0.0')
  })

  it('zero tolerance puts the limit at the worst level', () => {
    const r = planOrder({ ...base, toleranceTicks: 0, reading: book({ asks: [['0.94', '100']] }), side: 'buy', amount: '47' })
    expect(r.limitPrice).toBe('0.94')
  })
})

describe('planOrder — sell', () => {
  it('walks bids, rounds against the member, limit below the worst', () => {
    const bids = [['0.60', '10'], ['0.50', '10']]
    const r = planOrder({ ...base, reading: book({ bids }), side: 'sell', amount: '15' })
    expect(r).toEqual({
      ok: true,
      kind: 'marketable',
      shares: '15.0',
      averagePrice: '0.566666', // 8.5 / 15 rounded DOWN
      worstPrice: '0.5',
      limitPrice: '0.49',
      cost: '8.5',
      unfilled: '0.0',
      depthShare: 0.75,
      payoutIfRight: null,
    })
  })

  it('floors the limit at one tick', () => {
    const r = planOrder({ ...base, reading: book({ bids: [['0.01', '100']] }), side: 'sell', amount: '10' })
    expect(r.limitPrice).toBe('0.01')
  })

  it('reports shares with no bid as unfilled', () => {
    const r = planOrder({ ...base, reading: book({ bids: [['0.60', '5']] }), side: 'sell', amount: '8' })
    expect(r.shares).toBe('5.0')
    expect(r.unfilled).toBe('3.0')
  })
})

describe('planOrder — resting (member-named price)', () => {
  it('buys amount / price shares with no book walk, even on an empty book', () => {
    const r = planOrder({ ...base, reading: book(), side: 'buy', amount: '9', limitPrice: '0.45' })
    expect(r).toMatchObject({ ok: true, kind: 'resting', shares: '20.0', cost: '9.0', limitPrice: '0.45', worstPrice: '0.45', depthShare: 0 })
  })

  it('refuses an off-grid or out-of-range price', () => {
    for (const limitPrice of ['0.455', '0', '1', '1.2', 'x']) {
      expect(planOrder({ ...base, reading: book(), side: 'buy', amount: '9', limitPrice }).reason).toBe('invalid-limit')
    }
  })

  it('applies the minimum', () => {
    expect(planOrder({ ...base, reading: book(), side: 'buy', amount: '1', limitPrice: '0.45' }).reason).toBe('below-minimum')
  })
})

describe('planNotional / float artefacts', () => {
  it('returns the cost in micro-units, null for a refusal', () => {
    const r = planOrder({ ...base, reading: book({ asks: [['0.94', '100']] }), side: 'buy', amount: '47' })
    expect(planNotional(r)).toBe(47_000000n)
    expect(planNotional({ ok: false, reason: 'no-depth' })).toBeNull()
    expect(planNotional(undefined)).toBeNull()
  })

  it('no result string carries a floating artefact', () => {
    const asks = [['0.10', '33.3'], ['0.20', '41.7'], ['0.30', '55.1'], ['0.7', '12.345678']]
    const bids = [['0.09', '33.3'], ['0.07', '41.7']]
    const reading = book({ asks, bids })
    const re = /^\d+\.\d{1,6}$/
    for (const side of ['buy', 'sell']) {
      for (const amount of ['0.3', '1.1', '7.7', '10', '33.333333', '99.999999']) {
        const r = planOrder({ ...base, minOrderSize: '0', reading, side, amount })
        if (!r.ok) continue
        for (const k of ['shares', 'averagePrice', 'worstPrice', 'limitPrice', 'cost', 'unfilled']) {
          expect(r[k], `${side} ${amount} ${k}`).toMatch(re)
        }
        expect(r.depthShare).toBeGreaterThanOrEqual(0)
        expect(r.depthShare).toBeLessThanOrEqual(1)
      }
    }
    // the classic: 0.1 + 0.2
    const classic = planOrder({ ...base, minOrderSize: '0', reading: book({ asks: [['0.1', '1'], ['0.2', '1']] }), side: 'buy', amount: '0.3' })
    expect(classic.cost).toBe('0.3')
    expect(JSON.stringify(classic)).not.toMatch(/0\.30000000000000004/)
  })
})
