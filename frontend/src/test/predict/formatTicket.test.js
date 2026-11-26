import { restingFeeText } from '../../lib/predict/disclosures'
import { describe, it, expect } from 'vitest'
import { formatUsd, formatUsdExact, formatShareCount, formatPriceCents } from '../../lib/predict/format'
import { nearCertainty, depthStatement, refusalSentence, venueFeeNote } from '../../lib/predict/ticketStatements'

describe('ticket money formatting rounds AGAINST the member and never invents a zero', () => {
  it('costs round up, proceeds round down', () => {
    expect(formatUsd('50.000001', 'up')).toBe('$50.01')
    expect(formatUsd('50.009999', 'down')).toBe('$50.00')
    expect(formatUsd('0.249999', 'up')).toBe('$0.25')
    expect(formatUsd(250000n, 'up')).toBe('$0.25')
    expect(formatUsd('1340', 'down')).toBe('$1,340.00')
    expect(formatUsd('1234567.891', 'down')).toBe('$1,234,567.89')
  })
  it('an unreadable value is a dash, never $0.00', () => {
    for (const bad of [null, undefined, '', 'abc', NaN]) {
      expect(formatUsd(bad)).toBe('—')
      expect(formatShareCount(bad)).toBe('—')
      expect(formatPriceCents(bad)).toBe('—')
      expect(formatUsdExact(bad)).toBe('—')
    }
  })
  it('exact dollars keep the hundredths of a cent a resting order is signed in', () => {
    expect(formatUsdExact('49.9947')).toBe('$49.9947')
    expect(formatUsdExact('50')).toBe('$50.00')
  })
  it('shares floor to hundredths and trim zeros', () => {
    expect(formatShareCount('53.191489')).toBe('53.19')
    expect(formatShareCount('12')).toBe('12')
    expect(formatShareCount('12.5')).toBe('12.5')
    expect(formatShareCount('0.009')).toBe('0')
  })
  it('prices in cents: exact, rounded up, down, or to the nearest hundredth of a cent', () => {
    expect(formatPriceCents('0.95')).toBe('95¢')
    expect(formatPriceCents('0.9381')).toBe('93.81¢')
    expect(formatPriceCents('0.940001', 'up')).toBe('94.01¢')
    expect(formatPriceCents('0.940001', 'nearest')).toBe('94¢')
    expect(formatPriceCents('0.935999', 'down')).toBe('93.59¢')
  })
})

describe('ticketStatements', () => {
  const ok = (over) => ({ status: 'ok', side: 'buy', averagePrice: '0.94', payoutIfRight: '53.191489', ...over })
  it('near certainty: dollars at risk beside dollars to gain', () => {
    // The venue's own rate was READ as zero: the figures stand unqualified.
    expect(nearCertainty(ok(), { totalCostUnits: 50_250000n }, null, { feeRateBps: 0 })).toBe('You put $50.25 USDC at risk to gain $2.94 USDC.')
  })
  it('the gain is "before Polymarket’s fee" unless that rate was read as zero — an unread rate is not a zero', () => {
    const said = 'You put $50.25 USDC at risk to gain $2.94 USDC. Polymarket’s own fee is not in these figures and makes the gain smaller.'
    expect(nearCertainty(ok(), { totalCostUnits: 50_250000n }, null, { feeRateBps: 100 })).toBe(said)
    expect(nearCertainty(ok(), { totalCostUnits: 50_250000n }, null, { feeRateBps: null })).toBe(said)
    expect(nearCertainty(ok(), { totalCostUnits: 50_250000n })).toBe(said)
    expect(venueFeeNote({ feeRateBps: 0 })).toBe('')
    expect(venueFeeNote({ feeRateBps: null })).toBe(' (before Polymarket’s fee)')
    expect(venueFeeNote(undefined)).toBe(' (before Polymarket’s fee)')
  })
  it('exactly 90¢ counts; 89.9¢ does not; a sell never does', () => {
    expect(nearCertainty(ok({ averagePrice: '0.9', payoutIfRight: '55.55' }), { totalCostUnits: 50_000000n })).toMatch(/at risk to gain/)
    expect(nearCertainty(ok({ averagePrice: '0.899' }), { totalCostUnits: 50_000000n })).toBeNull()
    expect(nearCertainty(ok({ side: 'sell' }), { totalCostUnits: 50_000000n })).toBeNull()
  })
  it('when even being right returns less than was put in, it says so instead of a gain', () => {
    expect(nearCertainty(ok({ averagePrice: '0.995', payoutIfRight: '50.25' }), { totalCostUnits: 50_500000n })).toBe(
      'You put $50.50 USDC at risk and, even if you are right, receive $50.25 USDC — less than you put in.',
    )
  })
  it('depth share only from 10%', () => {
    expect(depthStatement({ kind: 'marketable', side: 'buy', depthShare: 0.0999 })).toBeNull()
    expect(depthStatement({ kind: 'marketable', side: 'buy', depthShare: 0.34 })).toBe('This takes about 34% of what is on offer at these prices.')
    expect(depthStatement({ kind: 'marketable', side: 'sell', depthShare: 0.5 })).toBe('This takes about 50% of what is bid at these prices.')
    expect(depthStatement({ kind: 'resting', side: 'buy', depthShare: 0 })).toBeNull()
  })
  it('every refusal reason has a sentence, none is a code', () => {
    for (const reason of ['below-minimum', 'no-depth', 'rounds-to-zero', 'invalid-limit', 'invalid-tick', 'something-new']) {
      const text = refusalSentence({ reason, min: { shares: '5', usd: '4.7' } }, { side: 'buy', tick: '0.01', ownPrice: true })
      expect(text).toMatch(/\s/)
      expect(text).not.toContain(reason)
    }
  })
})

describe('restingFeeText — which builder rate a named-price order pays, said in words', () => {
  it('rests: the maker rate (none here), and the taker rate named as what applies if it fills at once', () => {
    const buy = restingFeeText({ makerBps: 0, takerBps: 50, crosses: false, buy: true })
    expect(buy).toMatch(/^An order that rests and fills later pays no FairWins builder fee\./)
    expect(buy).toMatch(/fills at once instead and FairWins’ 0\.50% builder fee applies — the most you can lose above allows for that\./)
    expect(buy).not.toMatch(/included above/) // there is no fee line above a maker order: never claim one
    expect(restingFeeText({ makerBps: 0, takerBps: 50, crosses: false, buy: false })).toMatch(/you then receive that much less/)
  })
  it('a non-zero maker rate is its own statement and IS included above', () => {
    expect(restingFeeText({ makerBps: 10, takerBps: 50 })).toMatch(/pays FairWins’ 0\.10% builder fee \(the maker rate\), included above\./)
  })
  it('crosses the book: it fills at once, at the taker rate, shown as a line', () => {
    expect(restingFeeText({ makerBps: 0, takerBps: 50, crosses: true })).toMatch(/fills at once and FairWins’ 0\.50% builder fee applies, included above\./)
  })
  it('no builder fee at all: says so, never "0%"', () => {
    expect(restingFeeText({ makerBps: 0, takerBps: 0, crosses: true })).toMatch(/FairWins charges no builder fee on it\./)
    expect(restingFeeText({ makerBps: 0, takerBps: 0 })).not.toMatch(/0%|0\.00%/)
  })
  it('always names the venue\'s own fees, and never calls anything free', () => {
    for (const args of [{ crosses: true, takerBps: 50 }, { takerBps: 50 }, {}]) {
      expect(restingFeeText(args)).toMatch(/Polymarket sets its own fees for each market/)
      expect(restingFeeText(args)).not.toMatch(/\bfree\b/i)
    }
  })
})
