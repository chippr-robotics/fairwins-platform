/**
 * Reporting classification for the unified activity ledger
 * (spec 067 T107 — FR-035/FR-036/FR-039a; spec 051 contracts/ledger-entry.md).
 *
 * The report is the surface where a member's activity is read as money, so the
 * three judgements below have to be made once, here, rather than re-derived by
 * each renderer:
 *
 *   1. WHAT A BRIDGE IS. A bridge is ONE logical movement that happens to touch
 *      two networks and two transactions (FR-035). It is captured as a single
 *      ledger entry on the ORIGIN chain carrying the destination chain and both
 *      hashes; the destination side is never a second entry. `collapseLogical`
 *      guarantees that at the reporting boundary — independent of whichever
 *      store or source produced the entries — because the naive two-legged
 *      treatment of a cross-chain move either double-counts the value (two
 *      rows, one real movement) or nets it to zero by luck (an "out" on one
 *      chain cancelling an "in" on the other, which only works when both
 *      networks are in the same report, and this report is per-network).
 *
 *   2. WHAT A BRIDGE COSTS. Moving your own assets between networks is neither
 *      income nor a disposal (FR-036). The principal is therefore reported as
 *      value MOVED, kept out of the income/disposal split entirely, and the ONLY
 *      cost attributed to it is the platform fee actually charged.
 *
 *   3. WHICH "POOL" IS WHICH. `LEDGER_CLASS.POOL` is a *wager* pool (spec 034);
 *      `LEDGER_CLASS.LIQUIDITY` is an Earn → Supply position (spec 067). Both
 *      can appear in one report, so the bare word "Pool" is never a sufficient
 *      label (FR-039/FR-039a).
 *
 * A fee that was never reported is `unknown`, never `0`. "You were charged
 * nothing" and "we do not know what you were charged" are different claims and
 * a report may only make the one the data supports.
 */
import { formatUnits } from '../../lib/evm/units'
import { getNetwork } from '../../config/networks'
import { LEDGER_CLASS, LEDGER_DIRECTION, LEDGER_STATUS } from '../ledger/constants'

/**
 * Human label per activity class, for every surface a member or an auditor
 * reads. `pool` spells out "Wager Pool" because a report can legitimately hold
 * both a wager pool and a liquidity pool (FR-039a).
 */
export const CLASS_LABELS = Object.freeze({
  [LEDGER_CLASS.WAGER]: 'Wager',
  [LEDGER_CLASS.TRANSFER]: 'Transfer',
  [LEDGER_CLASS.EARN]: 'Earn',
  [LEDGER_CLASS.STAKING]: 'Staking',
  [LEDGER_CLASS.POOL]: 'Wager Pool',
  [LEDGER_CLASS.MEMBERSHIP]: 'Membership',
  [LEDGER_CLASS.BRIDGE]: 'Bridge',
  [LEDGER_CLASS.LIQUIDITY]: 'Liquidity',
  // Spec 073 — mini-app audit entries. These are ATTRIBUTION, not valuation:
  // every one carries direction `none`, so the class can appear in a report
  // with a count and no value without ever being netted into income or
  // disposal. A transaction a mini-app submitted is reported by the on-chain
  // entry it folds into, under that entry's own class — never here, and never
  // twice.
  [LEDGER_CLASS.MINIAPP]: 'Mini-App',
})

/** Display label for a class (falls back to the raw key for a future class). */
export function classLabel(cls) {
  return CLASS_LABELS[cls] || cls || 'Activity'
}

/** How a line item's platform fee should be read. */
export const PLATFORM_FEE_STATUS = Object.freeze({
  /** A fee was charged and its amount is known. */
  CHARGED: 'charged',
  /** No fee could be charged on this action, or the rate was zero. */
  NONE: 'none',
  /** A chargeable action did not report what it was charged. */
  UNKNOWN: 'unknown',
  /** This activity has no platform-fee concept at all. */
  NOT_APPLICABLE: 'n/a',
})

/**
 * The note the report carries whenever it contains a cross-chain movement.
 * Stated on the report so nobody has to infer the treatment from the numbers.
 */
export const SELF_TRANSFER_NOTE =
  'Moving your own assets between networks is not income and not a disposal. Each bridge is ' +
  'listed once, naming both networks and both transactions; its value is reported separately ' +
  'from income and disposals, and the only cost attributed to it is the platform fee actually ' +
  'charged.'

/** Statuses a client record can no longer move on from. */
const TERMINAL_STATUSES = new Set([LEDGER_STATUS.SETTLED, LEDGER_STATUS.CANCELLED, LEDGER_STATUS.FAILED])

/** A bridge is a self-transfer between the member's own addresses (FR-036). */
export function isSelfTransfer(entry) {
  return entry?.class === LEDGER_CLASS.BRIDGE
}

/**
 * Value that belongs to neither the income nor the disposal side of the report.
 * Keyed on the entry's own value direction rather than on its class, because
 * `none` means exactly this whoever wrote it.
 */
export function isNeutralDirection(direction) {
  return direction === LEDGER_DIRECTION.NONE
}

function toAmount(raw, decimals) {
  if (raw == null || raw === '') return null
  try {
    const dp = Number.isFinite(Number(decimals)) ? Number(decimals) : 18
    return Number(formatUnits(BigInt(raw), dp))
  } catch {
    return null
  }
}

/**
 * The entry's own USD-per-token basis, derived from the value the ledger already
 * put on the entry. Never an independent price lookup: the fee is valued on the
 * same basis as the principal it was taken from, or not at all.
 */
function unitUsdOf(entry) {
  const amount = Number(entry?.amount)
  const usd = entry?.valueUsd
  if (usd == null || !Number.isFinite(Number(usd))) return null
  if (!Number.isFinite(amount) || amount <= 0) return null
  return Number(usd) / amount
}

function feeLeg({ raw, symbol, decimals, unitUsd }) {
  const amount = toAmount(raw, decimals)
  // A zero fee is known to be worth nothing even with no price basis at all.
  const usd = amount === 0 ? 0 : unitUsd != null && amount != null ? amount * unitUsd : null
  return { raw: raw == null ? null : String(raw), amount, symbol: symbol || null, usd }
}

/**
 * The FairWins platform fee attributed to one ledger entry (FR-036).
 *
 * Reads `refs.feeAmountRaw` / `refs.fee1AmountRaw` — the amounts ACTUALLY
 * charged, as recorded at action time from the receipt. Nothing here multiplies
 * a rate by an amount: for liquidity the fee is taken on the capital the pool
 * actually consumed, so a rate × entered-amount figure would over-state what the
 * member paid, and for a fee-free path (bridge liquidity, every withdrawal and
 * earnings claim) there is no rate to multiply at all.
 *
 * @param {object} entry - normalized LedgerEntry
 * @returns {{status: string, legs: Array, usd: number|null, bps: number|null}}
 *   `usd` is null when any charged leg could not be valued — never a partial sum
 *   presented as a total.
 */
export function platformFeeOf(entry) {
  const refs = entry?.refs || {}
  const hasLeg0 = Object.prototype.hasOwnProperty.call(refs, 'feeAmountRaw')
  const hasLeg1 = Object.prototype.hasOwnProperty.call(refs, 'fee1AmountRaw')
  if (!hasLeg0 && !hasLeg1) {
    return { status: PLATFORM_FEE_STATUS.NOT_APPLICABLE, legs: [], usd: null, bps: null }
  }

  const unitUsd = unitUsdOf(entry)
  const legs = []
  if (hasLeg0) {
    legs.push(
      feeLeg({
        raw: refs.feeAmountRaw,
        symbol: entry.tokenSymbol,
        decimals: entry.tokenDecimals,
        unitUsd,
      }),
    )
  }
  if (hasLeg1 && refs.fee1AmountRaw != null) {
    // The pair's second leg is denominated in the other token; the entry carries
    // no USD basis for it, so a non-zero leg-1 fee is reported in tokens and
    // left out of the USD total rather than valued at the wrong price.
    legs.push(
      feeLeg({
        raw: refs.fee1AmountRaw,
        symbol: refs.token1Symbol,
        decimals: refs.token1Decimals,
        unitUsd: null,
      }),
    )
  }

  const bps = refs.feeBps != null && Number.isFinite(Number(refs.feeBps)) ? Number(refs.feeBps) : null
  // A chargeable action that reported no fee is unknown, not free.
  const unknown = legs.some((l) => l.raw == null)
  if (unknown) return { status: PLATFORM_FEE_STATUS.UNKNOWN, legs, usd: null, bps }

  const charged = legs.some((l) => l.amount == null || l.amount > 0)
  if (!charged) return { status: PLATFORM_FEE_STATUS.NONE, legs, usd: 0, bps }

  const usd = legs.every((l) => l.usd != null) ? legs.reduce((s, l) => s + l.usd, 0) : null
  return { status: PLATFORM_FEE_STATUS.CHARGED, legs, usd, bps }
}

/** Token-denominated rendering of a platform fee, e.g. `0.5 USDC + 0.0002 WETH`. */
export function formatPlatformFee(fee) {
  if (!fee || fee.status === PLATFORM_FEE_STATUS.NOT_APPLICABLE) return ''
  if (fee.status === PLATFORM_FEE_STATUS.UNKNOWN) return 'unknown'
  if (fee.status === PLATFORM_FEE_STATUS.NONE) return 'none'
  return (
    fee.legs
      .filter((l) => l.amount == null || l.amount > 0)
      .map((l) => `${l.amount ?? 'unknown'} ${l.symbol || ''}`.trim())
      .join(' + ') || 'none'
  )
}

/** Network display name that never renames an unknown chain into a known one. */
function networkNameOf(chainId, resolveNetwork) {
  if (!chainId) return null
  const net = resolveNetwork(Number(chainId))
  // `getNetwork` falls back to the active network for an unrecognized id — a
  // destination the app does not know must not be labelled as one it does.
  if (net && Number(net.chainId) === Number(chainId)) return net.name
  return `Chain ${chainId}`
}

/**
 * The cross-chain facts of a bridge entry — both networks and both transactions
 * (FR-035) — or null for anything that is not a bridge.
 *
 * @param {object} entry
 * @param {function} [resolveNetwork] - injectable chain → network lookup
 */
export function crossChainOf(entry, resolveNetwork = getNetwork) {
  if (!isSelfTransfer(entry)) return null
  const refs = entry.refs || {}
  const originChainId = Number(refs.originChainId ?? entry.chainId) || null
  const destinationChainId = Number(refs.destinationChainId ?? entry.destinationChainId) || null
  return {
    originChainId,
    originNetworkName: networkNameOf(originChainId, resolveNetwork),
    destinationChainId,
    destinationNetworkName: networkNameOf(destinationChainId, resolveNetwork),
    srcTxHash: refs.srcTxHash ?? entry.txHash ?? null,
    dstTxHash: refs.dstTxHash ?? entry.dstTxHash ?? null,
    recipient: refs.recipient ?? null,
    settlementProtocol: refs.settlementProtocol ?? null,
    state: refs.bridgeState ?? entry.bridgeState ?? null,
  }
}

/** Later records win: terminal outcomes over pending, then most recently written. */
function recordRank(entry) {
  const recency = Number(entry?.recordedAt || entry?.timestamp || 0)
  return (TERMINAL_STATUSES.has(entry?.status) ? Number.MAX_SAFE_INTEGER / 2 : 0) + recency
}

/**
 * Reduce an entry set to its logical entries before anything is totaled.
 *
 * Two collapses, both of them FR-035 obligations rather than tidying:
 *   - a record named by another record's `refs.supersedes` is a superseded
 *     status snapshot, not a second movement;
 *   - two surviving records for the SAME bridge (`refs.bridgeId`) are one
 *     bridge. Only the furthest-progressed one is reported.
 *
 * Idempotent: an entry set that already holds one record per bridge passes
 * through untouched, so this stays correct whether or not the store upstream
 * resolved the chain itself.
 *
 * @param {Array} entries
 * @returns {Array}
 */
export function collapseLogical(entries = []) {
  const superseded = new Set()
  for (const e of entries) {
    if (e?.refs?.supersedes) superseded.add(e.refs.supersedes)
  }
  const out = []
  const bridgeIndex = new Map() // bridgeId → index in `out`
  for (const e of entries) {
    if (!e || superseded.has(e.entryId)) continue
    const bridgeId = isSelfTransfer(e) ? e.refs?.bridgeId || null : null
    if (!bridgeId) {
      out.push(e)
      continue
    }
    const at = bridgeIndex.get(bridgeId)
    if (at == null) {
      bridgeIndex.set(bridgeId, out.push(e) - 1)
    } else if (recordRank(e) > recordRank(out[at])) {
      out[at] = e
    }
  }
  return out
}
