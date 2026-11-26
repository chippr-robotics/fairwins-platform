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

/** The order itself is gasless on every rail: it is signed, then posted to the venue's book. */
export const NETWORK_FEE_TEXT = 'Network fee: none — you sign, no gas'

export const CUSTODY_TEXT =
  'FairWins never holds your funds or your key. The order goes to Polymarket; the outcome is decided there.'
