/**
 * clobOrder cost math (spec 057) — the honest cost breakdown the confirm UI shows before signing. Verifies
 * the ADDITIVE builder fee is included in the total for takers (FR-011/FR-012) and makers carry no fee. The
 * order struct/signing is owned by @polymarket/clob-client (validated live), not here.
 */
import { describe, it, expect } from 'vitest'
import { computeCost, computeCostForPlan } from '../../lib/predict/clobOrder'
import { planOrder } from '../../lib/predict/orderPlan'
import { liquid } from './ticketFixtures'

// Live platform fee 100 bps + FairWins 50 bps taker / 0 maker.
const FEE = { feeRateBps: 100, builderTakerFeeBps: 50, builderMakerFeeBps: 0 }

describe('computeCost', () => {
  it('includes the exact builder fee in a taker BUY total (shown == charged)', () => {
    // 100 shares @ 0.50 = 50 USDC notional. Builder 0.5% = 0.25. Polymarket's own fee is separate.
    const c = computeCost({ price: '0.5', size: '100', side: 'BUY', isMaker: false }, FEE)
    expect(c.notionalUnits).toBe(50_000000n)
    expect(c.builderFeeUnits).toBe(250000n) // 0.25 USDC
    expect(c.totalCostUnits).toBe(50_250000n) // 50.25 USDC (notional + our builder fee)
    expect(c.platformFeeRateBps).toBe(100) // carried on the order, not fabricated as a dollar line
    // The builder fee is its own labelled line; we never fabricate a platform-fee dollar amount.
    const labels = c.feeLines.map((l) => l.label)
    expect(labels).toEqual(['FairWins builder fee'])
    expect(c.feeLines[0].amount).toBe('0.25')
  })

  it('charges a taker SELL the builder fee against net proceeds', () => {
    const c = computeCost({ price: '0.5', size: '100', side: 'SELL', isMaker: false }, FEE)
    expect(c.netProceedsUnits).toBe(49_750000n) // 50 - 0.25
  })

  it('charges makers NO builder fee (and no platform rate on the order)', () => {
    const c = computeCost({ price: '0.5', size: '100', side: 'BUY', isMaker: true }, FEE)
    expect(c.builderFeeUnits).toBe(0n)
    expect(c.platformFeeRateBps).toBe(0)
    expect(c.totalCostUnits).toBe(50_000000n)
    expect(c.feeLines).toHaveLength(0) // no fee lines to show
  })
})

describe('computeCostForPlan (spec 114) — fees from the PLANNED notional', () => {
  it('charges the builder fee on the plan\'s own cost, not on average price × shares', () => {
    // 200 @ 0.94 = 188, then 12 @ 0.95 = 11.4 -> a plan that costs exactly 199.40 for 212 shares.
    const plan = planOrder({ reading: liquid(), side: 'buy', amount: '199.4' })
    expect(plan.ok).toBe(true)
    const c = computeCostForPlan(plan, 'buy', FEE)
    expect(c.notionalUnits).toBe(199_400000n)
    expect(c.builderFeeUnits).toBe(997000n) // 0.5% of 199.40
    expect(c.totalCostUnits).toBe(200_397000n)
    expect(c.feeLines.map((l) => l.label)).toEqual(['FairWins builder fee']) // its OWN line
    // The reason this exists: average × shares is a rounded figure and can differ from the notional.
    const viaAverage = computeCost({ price: plan.averagePrice, size: plan.shares, side: 'buy' }, FEE)
    expect(viaAverage.notionalUnits).not.toBe(199_400000n)
  })

  it('a sell nets the fee off the proceeds', () => {
    const plan = planOrder({ reading: liquid(), side: 'sell', amount: '100' })
    const c = computeCostForPlan(plan, 'sell', FEE)
    expect(c.notionalUnits).toBe(93_000000n)
    expect(c.netProceedsUnits).toBe(92_535000n)
  })

  it('zero fee ⇒ no fee line (byte-identical to a fee-free trade)', () => {
    const plan = planOrder({ reading: liquid(), side: 'buy', amount: '50' })
    const c = computeCostForPlan(plan, 'buy', { feeRateBps: 0, builderTakerFeeBps: 0, builderMakerFeeBps: 0 })
    expect(c.feeLines).toEqual([])
    expect(c.totalCostUnits).toBe(c.notionalUnits)
  })

  it('a refused plan has nothing to charge a fee on', () => {
    expect(computeCostForPlan({ ok: false, reason: 'no-depth' }, 'buy', FEE)).toBeNull()
    expect(computeCostForPlan(undefined, 'buy', FEE)).toBeNull()
  })

  it('an unconfirmed fee schedule yields bps 0 here — the HOOK is what blocks signing (see usePredictPlanTrade)', () => {
    const plan = planOrder({ reading: liquid(), side: 'buy', amount: '50' })
    expect(computeCostForPlan(plan, 'buy', null).builderFeeUnits).toBe(0n)
  })
})
