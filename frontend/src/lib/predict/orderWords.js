/**
 * The words for an order's progress (spec 114 slice 6) — pure, so the honesty of every sentence can be tested
 * without rendering. "Matched" is the venue's word and "settled" is the chain's; nothing here says an order
 * was filled, bought or settled unless the state says the venue or the chain did.
 */
import { formatShareCount } from './format'

const shares = (v) => (v == null ? null : `${formatShareCount(v)} shares`)

/** What the order IS, from the public facts recorded when it was signed. */
export function describeOrder(r) {
  if (r.label) return r.label
  const buy = r.side !== 'SELL'
  const amount = r.sizeUnit === 'shares' ? `${r.size} shares` : `${r.size} USDC`
  return `${buy ? 'Buy' : 'Sell'} ${amount}`
}

/** The one sentence for where an order stands. Pure: the state, its figures and its reason. */
export function stateSentence(r) {
  const filled = shares(r.filledSize)
  switch (r.state) {
    case 'signed':
      return 'Signed on this device. Waiting for Polymarket to take it.'
    case 'sent':
      return 'Sent to Polymarket, which took it. It is not yet reported as matched or waiting on the book.'
    case 'resting':
      return `Waiting on Polymarket's order book at your price of ${r.limitPrice}. It fills only if the market reaches that price.`
    case 'partial':
      return `Partly matched${filled ? `: ${filled} so far` : ''}. The rest is still waiting on the book at ${r.limitPrice}.`
    case 'matched':
      return `Matched by Polymarket${filled ? `: ${filled}` : ''}. Settlement happens on the blockchain, and this app does not show that step, so your position updates once it completes.`
    case 'settled':
      return 'Settled on chain.'
    case 'cancelled':
      return `Cancelled${filled ? `. ${filled} had matched before it ended and still settle` : ''}.`
    case 'expired':
      return `Expired${filled ? `. ${filled} had matched before it ended and still settle` : ''}.`
    case 'rejected':
      return `Polymarket refused this order. ${r.reason ?? ''}`.trim()
    case 'not-delivered':
      return r.reason ?? 'Polymarket has no record of this order and no fill from it, so nothing was bought or sold.'
    case 'failed':
      return `Matched, but its settlement failed. ${r.reason ?? ''}`.trim()
    case 'unconfirmed':
      return r.idKnown
        ? 'Not confirmed yet. Polymarket did not say whether it received this order, so it may have been placed. Do not send it again: this app is checking Polymarket for it. If it cannot find it, check your positions and open orders on Polymarket before doing anything.'
        : 'Not confirmed yet. Polymarket did not say whether it received this order, so it may have been placed, and this app could not work out how to look it up. Do not send it again. Check your positions and open orders on Polymarket.'
    default:
      return ''
  }
}
