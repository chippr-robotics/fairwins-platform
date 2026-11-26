/**
 * The sentences a member reads before signing a Predict order (spec 057 FR-003/FR-010–FR-012), kept in ONE
 * place so the fixed-price confirm (`TradeConfirm`) and the amount-first ticket (`OrderTicket`) say the same
 * thing in the same words — a second copy is how two surfaces come to disagree about a fee.
 */
import { bpsToPct } from './builderFee'

/** The builder-fee + venue-fee disclosure. The builder fee IS a cost; the venue's own taker fee is separate. */
export function feeDisclosureText(builderBps) {
  return `FairWins charges a ${bpsToPct(builderBps)} builder fee on this trade, included above. Polymarket also charges its own taker fee, set by the market and applied at execution.`
}

/** The one-time setup note; true for each signer rail. */
export function firstTradeText(signerKind) {
  return signerKind === 'passkey'
    ? 'First trade only: you’ll confirm one transaction letting Polymarket’s exchange settle your trades (network fee applies unless sponsored), then sign once (no gas) to enable trading on this device.'
    : 'First trade only: you’ll sign once (no gas) to enable trading on this device, then confirm the order.'
}

export const WRONG_NETWORK_TEXT = "You'll be asked to switch your wallet to Polygon before signing."

/**
 * The fee sentence for an order at a price the member NAMED (it rests on the book). Which builder rate applies
 * depends on how it fills, and the sentence says which — a resting order charged "0.50%, included above" with
 * no fee line above it is two statements that cannot both be true.
 *  - it crosses the book now ⇒ it fills at once as a taker: the taker rate, shown as a line;
 *  - it rests ⇒ it fills later as a maker: the maker rate (often none). If the book moves before it arrives it
 *    fills at once instead, at the taker rate; a buy's "most you can lose" already allows for that.
 */
export function restingFeeText({ makerBps = 0, takerBps = 0, crosses = false, buy = true } = {}) {
  const venue = 'Polymarket sets its own fees for each market and applies them when the order fills.'
  const taker = Number(takerBps) || 0
  const maker = Number(makerBps) || 0
  if (crosses) {
    return taker > 0
      ? `That price is available now, so this order fills at once and FairWins’ ${bpsToPct(taker)} builder fee applies, included above. ${venue}`
      : `That price is available now, so this order fills at once. FairWins charges no builder fee on it. ${venue}`
  }
  const resting = maker > 0
    ? `An order that rests and fills later pays FairWins’ ${bpsToPct(maker)} builder fee (the maker rate), included above.`
    : 'An order that rests and fills later pays no FairWins builder fee.'
  if (taker <= maker) return `${resting} ${venue}`
  const allowance = buy ? 'the most you can lose above allows for that' : 'you then receive that much less'
  return `${resting} If the price becomes available before the order arrives, it fills at once instead and FairWins’ ${bpsToPct(taker)} builder fee applies — ${allowance}. ${venue}`
}

/**
 * Only the ORDER is free of a network fee: it is signed, then posted to the venue's book. The one-time setup
 * a passkey account does before its first trade is a transaction and is described by `firstTradeText`, so this
 * sentence is about the order and nothing wider.
 */
export const NETWORK_FEE_TEXT = 'Signing this order costs no network fee.'

export const CUSTODY_TEXT =
  'FairWins never holds your funds or your key. The order goes to Polymarket; the outcome is decided there.'
