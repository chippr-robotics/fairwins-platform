/**
 * The plain sentences the order ticket and its review share (spec 114 slice 5, FR-017/FR-020/FR-028), as pure
 * functions so the two surfaces can never disagree and each statement can be tested without a component.
 * A refusal is always a sentence a member can act on — never a reason code.
 */
import { formatUsd, formatShareCount, formatPriceCents, decimalToMicro } from './format'

/** The statements shared by the ticket and the review, so they can never disagree. */
export function nearCertainty(view, quote, ceiling) {
  if (view?.side !== 'buy' || view.status !== 'ok') return null
  const avg = decimalToMicro(view.averagePrice)
  if (avg == null || avg < 900_000n) return null
  const atRisk = ceiling?.totalCostUnits ?? quote?.totalCostUnits ?? null
  const payoutUnits = decimalToMicro(view.payoutIfRight)
  if (atRisk == null || payoutUnits == null) return null
  const gain = payoutUnits - atRisk
  if (gain > 0n) return `You put ${formatUsd(atRisk, 'up')} at risk to gain ${formatUsd(gain, 'down')}.`
  return `You put ${formatUsd(atRisk, 'up')} at risk and, even if you are right, receive ${formatUsd(payoutUnits, 'down')} — less than you put in.`
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
      return `The smallest order here is ${formatShareCount(min.shares)} shares${min.usd ? ` (about ${formatUsd(min.usd, 'up')})` : ''}.`
    }
    case 'no-depth':
      return side === 'buy' ? 'Nothing is on offer on this side right now.' : 'Nobody is bidding on this side right now.'
    case 'rounds-to-zero':
      return side === 'buy' ? 'Amounts are signed in whole cents, so that rounds to nothing. Enter at least $0.01.' : 'Shares are signed in hundredths, so that rounds to nothing. Enter at least 0.01 shares.'
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

