/**
 * The plain sentences the order ticket and its review share (spec 114 slice 5, FR-017/FR-020/FR-028), as pure
 * functions so the two surfaces can never disagree and each statement can be tested without a component.
 * A refusal is always a sentence a member can act on — never a reason code.
 */
import { formatUsd, formatShareCount, formatPriceCents, decimalToMicro } from './format'

/** Every money figure names its currency (spec 057 FR-011): a "$" alone does not say USDC. */
export const usdc = (formatted) => `${formatted} USDC`

/**
 * Polymarket's own fee is set by the market and taken by the venue at execution; FairWins can state its RATE
 * but not what it will come to, so it is in no figure here. Only a rate the gateway READ as zero lets a figure
 * stand unqualified — an unread rate (`null`) is not a zero.
 */
export const venueFeeKnownZero = (fee) => fee?.feeRateBps === 0
export const venueFeeNote = (fee) => (venueFeeKnownZero(fee) ? '' : ' (before Polymarket’s fee)')

/** The statements shared by the ticket and the review, so they can never disagree. */
export function nearCertainty(view, quote, ceiling, fee) {
  if (view?.side !== 'buy' || view.status !== 'ok') return null
  const avg = decimalToMicro(view.averagePrice)
  if (avg == null || avg < 900_000n) return null
  const atRisk = ceiling?.totalCostUnits ?? quote?.totalCostUnits ?? null
  const payoutUnits = decimalToMicro(view.payoutIfRight)
  if (atRisk == null || payoutUnits == null) return null
  const gain = payoutUnits - atRisk
  const venue = venueFeeKnownZero(fee) ? '' : ' Polymarket’s own fee is not in these figures and makes the gain smaller.'
  if (gain > 0n) return `You put ${usdc(formatUsd(atRisk, 'up'))} at risk to gain ${usdc(formatUsd(gain, 'down'))}.${venue}`
  return `You put ${usdc(formatUsd(atRisk, 'up'))} at risk and, even if you are right, receive ${usdc(formatUsd(payoutUnits, 'down'))} — less than you put in.`
}

export const depthStatement = (view) =>
  view?.kind === 'marketable' && view.depthShare >= 0.1
    ? `This takes about ${Math.round(view.depthShare * 100)}% of what is ${view.side === 'buy' ? 'on offer' : 'bid'} at these prices.`
    : null

export const tickCents = (tick) => formatPriceCents(tick, 'up')

/** A refusal as a sentence a member can act on — never a reason code. */
export function refusalSentence(view, { side, tick, ownPrice }) {
  switch (view.reason) {
    case 'below-minimum': {
      const min = view.min
      if (!min) return 'That is below the smallest order this market takes.'
      return `The smallest order here is ${formatShareCount(min.shares)} shares${min.usd ? ` (about ${usdc(formatUsd(min.usd, 'up'))})` : ''}.`
    }
    case 'no-depth':
      return side === 'buy' ? 'Nothing is on offer on this side right now.' : 'Nobody is bidding on this side right now.'
    case 'rounds-to-zero':
      return side === 'buy' ? 'Amounts are signed in whole cents, so that rounds to nothing. Enter at least $0.01 USDC.' : 'Shares are signed in hundredths, so that rounds to nothing. Enter at least 0.01 shares.'
    case 'invalid-limit':
      return ownPrice
        ? `Prices on this market move in steps of ${tickCents(tick)}. Enter a price on those steps, above 0 and below 100¢.`
        : 'No price can be set for that order on this market right now.'
    case 'invalid-tick':
      return 'This market’s price step is not known yet, so no figures can be shown.'
    default:
      return 'Figures cannot be shown for that amount.'
  }
}

