/**
 * Builder-fee math (spec 057) — shared by the CLOB order builder and the confirm UI so the fee the
 * member SEES equals the fee that is charged (FR-011/FR-012).
 *
 * KEY: Polymarket's builder fee is ADDITIVE — it stacks on top of the platform taker fee and is a
 * REAL cost to the taker (unlike OpenSea's no-cost referral). It is therefore always surfaced as its
 * own visible line. Makers pay no builder fee (bps resolve to 0 upstream).
 */
import { formatUnits } from '../evm/units'
/** USDC has 6 decimals. */
export const USDC_DECIMALS = 6

/** Fee amount in base units for a notional and a bps rate (floor division, no float drift). */
export function feeUnits(notionalUnits, bps) {
  const rate = BigInt(Math.max(0, Math.round(Number(bps) || 0)))
  return (BigInt(notionalUnits) * rate) / 10_000n
}

/** bps → a human percentage string, e.g. 50 → "0.5%". */
export function bpsToPct(bps) {
  const n = Number(bps) || 0
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`
}

/** A {label, amount, currency, estimated?} fee line, or null when the fee is zero (nothing to show). */
export function feeLine(label, units, { estimated = false } = {}) {
  if (BigInt(units) <= 0n) return null
  return { label, amount: formatUnits(units, USDC_DECIMALS), currency: 'USDC', estimated }
}
