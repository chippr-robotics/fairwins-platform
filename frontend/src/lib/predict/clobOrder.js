/**
 * Predict trade cost math (spec 057). The ORDER itself (EIP-712 struct, amount rounding, salt, signature,
 * submission) is built and signed by the official @polymarket/clob-client (see clobSession.js) — hand-rolling
 * it produced the wrong struct (the CTF Exchange Order is 12 fields, domain version "1", and attribution is
 * NOT a signed field). This module keeps ONLY the honest cost breakdown the confirm UI shows before signing:
 * the notional and — crucially — FairWins' ADDITIVE builder fee as its own labelled line (FR-011/FR-012).
 *
 * Polymarket's OWN taker fee is charged by their engine at execution (a curve over price/size); we do NOT
 * fabricate a dollar estimate for it — it's disclosed honestly as a separate note in the confirm UI. Makers
 * pay no builder fee.
 */
import { parseUnits } from '../evm/units'
import { USDC_DECIMALS, feeUnits, feeLine } from './builderFee'

const ZERO_BYTES32 = '0x' + '0'.repeat(64)

/**
 * Notional (USDC base units) for a price∈[0,1] and a share size, plus the FairWins builder fee — the one
 * fee we control and can state exactly. Floor division in bigint — no float drift.
 *
 * @returns {{ notionalUnits: bigint, builderFeeUnits: bigint, platformFeeRateBps: number,
 *   totalCostUnits: bigint, netProceedsUnits: bigint, feeLines: Array, currency: 'USDC', side: string }}
 */
export function computeCost({ price, size, side, isMaker = false }, feeBreakdown) {
  const priceUnits = parseUnits(String(price), USDC_DECIMALS)
  const sizeUnits = parseUnits(String(size), USDC_DECIMALS)
  // notional = price × size, both 6-dec → divide out one scale factor.
  const notionalUnits = (priceUnits * sizeUnits) / 10n ** BigInt(USDC_DECIMALS)

  // Makers pay no builder fee (Polymarket keeps makers whole).
  const builderBps = isMaker ? Number(feeBreakdown?.builderMakerFeeBps ?? 0) : Number(feeBreakdown?.builderTakerFeeBps ?? 0)
  const builderFeeUnits = feeUnits(notionalUnits, builderBps)

  // Our guaranteed side of the math: notional ± our builder fee. Polymarket's fee is additional and
  // charged at execution (disclosed, not fabricated).
  const totalCostUnits = notionalUnits + builderFeeUnits
  const netProceedsUnits = notionalUnits - builderFeeUnits

  const feeLines = [
    // FairWins' builder fee — always its own honest line when it applies (never hidden, FR-012).
    feeLine('FairWins builder fee', builderFeeUnits),
  ].filter(Boolean)

  return {
    notionalUnits,
    builderFeeUnits,
    platformFeeRateBps: isMaker ? 0 : Number(feeBreakdown?.feeRateBps ?? 0),
    totalCostUnits,
    netProceedsUnits: netProceedsUnits < 0n ? 0n : netProceedsUnits,
    feeLines,
    currency: 'USDC',
    side,
  }
}

export { ZERO_BYTES32 }
