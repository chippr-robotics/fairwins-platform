/**
 * toleranceChoices (spec 114, T032a) — one tick (the default), 1¢, 2¢; never wider, never finer than the tick,
 * never a limit outside (0, 1).
 */
import { describe, it, expect } from 'vitest'
import { toleranceChoices, ticksFor, effectiveId, DEFAULT_TOLERANCE, TOLERANCE_IDS } from '../../lib/predict/tolerance'

const ids = (c) => c.map((x) => x.id)

describe('toleranceChoices', () => {
  it('always starts with the tightest, one tick, and never offers more than three choices', () => {
    expect(DEFAULT_TOLERANCE).toBe('tick')
    expect(TOLERANCE_IDS).toEqual(['tick', '1c', '2c'])
    for (const tickSize of ['0.1', '0.01', '0.001', '0.0001', undefined, 'x']) {
      const c = toleranceChoices({ tickSize, side: 'buy' })
      expect(c[0]).toEqual({ id: 'tick', ticks: 1, cents: null })
      expect(c.length).toBeLessThanOrEqual(3)
    }
  })
  it('converts cents to ticks from the tick it is given', () => {
    expect(toleranceChoices({ tickSize: '0.001', side: 'buy' })).toEqual([
      { id: 'tick', ticks: 1, cents: null }, { id: '1c', ticks: 10, cents: 1 }, { id: '2c', ticks: 20, cents: 2 },
    ])
    expect(toleranceChoices({ tickSize: '0.0001', side: 'buy' }).map((c) => c.ticks)).toEqual([1, 100, 200])
  })
  it('1¢ on a 1¢ market IS one tick, so it is not offered twice; a market coarser than the choice offers nothing finer', () => {
    expect(ids(toleranceChoices({ tickSize: '0.01', side: 'buy' }))).toEqual(['tick', '2c'])
    expect(ids(toleranceChoices({ tickSize: '0.02', side: 'buy' }))).toEqual(['tick'])
    expect(ids(toleranceChoices({ tickSize: '0.1', side: 'buy' }))).toEqual(['tick'])
  })
  it('withholds a choice that is not a whole number of ticks', () => {
    expect(ids(toleranceChoices({ tickSize: '0.003', side: 'buy' }))).toEqual(['tick'])
  })
  it('withholds a choice whose limit would leave (0, 1) — a buy toward 1, a sell toward 0', () => {
    expect(ids(toleranceChoices({ tickSize: '0.001', side: 'buy', basis: '0.985' }))).toEqual(['tick', '1c'])
    expect(ids(toleranceChoices({ tickSize: '0.001', side: 'buy', basis: '0.989' }))).toEqual(['tick', '1c']) // 0.989 + 1¢ = 0.999, the last grid point
    expect(ids(toleranceChoices({ tickSize: '0.001', side: 'buy', basis: '0.990' }))).toEqual(['tick']) // 1.000 is outside
    expect(ids(toleranceChoices({ tickSize: '0.001', side: 'sell', basis: '0.015' }))).toEqual(['tick', '1c'])
    expect(ids(toleranceChoices({ tickSize: '0.001', side: 'sell', basis: '0.010' }))).toEqual(['tick'])
  })
  it('ticksFor / effectiveId fall back to the default for a choice that is not on offer', () => {
    const c = toleranceChoices({ tickSize: '0.01', side: 'buy' })
    expect(ticksFor(c, '2c')).toBe(2)
    expect(ticksFor(c, '1c')).toBe(1)
    expect(effectiveId(c, '1c')).toBe('tick')
    expect(effectiveId(c, '2c')).toBe('2c')
  })
})
