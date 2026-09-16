/**
 * Shared display formatters for the Earn section (spec 050). Null-safe:
 * missing protocol data renders as "—", never a fabricated zero
 * (constitution III).
 */
import { formatUnits } from '../evm/units'
/**
 * Normalize a base-unit (wei-scale) amount from ANY source into a canonical
 * integer string, or null when it cannot be represented.
 *
 * Why this exists: JSON has a single number type, so an API quoting wei-scale
 * values delivers them as doubles — the Polygon staking API returns
 * `totalStaked: 1.2105466892436343e+26`. `String()` on that keeps the
 * exponent, and `BigInt('1.2105466892436343e+26')` throws a SyntaxError, which
 * took down the whole panel from a render path (issue #977). Anything that
 * feeds an external numeric field into BigInt must come through here first.
 *
 * Precision past 2^53 is already gone by the time the value reaches us — the
 * source sent a double. We expand the digits it actually printed and zero-fill
 * the rest rather than materializing the double's exact binary value, so no
 * digit appears that the API never sent. That is plenty for the compact
 * display these amounts feed; what matters is that callers are never handed a
 * string BigInt() will reject.
 */
export function toBaseUnitString(value) {
  if (value == null) return null
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return expandToInteger(value)
  // String(1.21e26) === '1.21e+26' — the same decimal text path handles it.
  if (typeof value === 'number') return Number.isFinite(value) ? expandToInteger(String(value)) : null
  return null
}

// uint256 tops out at 78 digits; anything wider is not a token amount, and
// refusing it keeps a bogus exponent from asking for a gigabyte of zeros.
const MAX_BASE_UNIT_DIGITS = 80
const DECIMAL_RE = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/

/** Decimal or exponential text → truncated integer string; unusable → null. */
function expandToInteger(text) {
  const match = DECIMAL_RE.exec(String(text).trim())
  if (!match) return null
  const [, sign, whole, fraction = '', exponent] = match
  const digits = whole + fraction
  // Where the decimal point lands once the exponent is applied.
  const pointIndex = whole.length + (exponent ? Number(exponent) : 0)
  if (pointIndex > MAX_BASE_UNIT_DIGITS) return null
  let integerDigits
  if (pointIndex <= 0) integerDigits = '0' // |value| < 1 ⇒ zero whole base units
  else if (pointIndex >= digits.length) integerDigits = digits.padEnd(pointIndex, '0')
  else integerDigits = digits.slice(0, pointIndex) // fractional base units truncate
  return BigInt(`${sign === '-' ? '-' : ''}${integerDigits}`).toString()
}

/**
 * Base-unit amount → compact "1.2M POL" / "450K POL" / "12.34 POL".
 *
 * Total by construction: an unusable amount (missing, malformed, or a decimals
 * value that makes no sense) renders "—" rather than throwing. This runs
 * during render, where a throw takes the surrounding panel down.
 */
export function formatTokenAmount(raw, decimals, symbol) {
  const base = toBaseUnitString(raw)
  if (base == null) return '—'
  let value
  try {
    value = Number(formatUnits(BigInt(base), decimals))
  } catch {
    return '—'
  }
  if (!Number.isFinite(value)) return '—'
  const unit = symbol ? ` ${symbol}` : ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M${unit}`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K${unit}`
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit}`
}

/** Net APY fraction (0.043) → "4.30%"; null → "—". */
export function formatApy(netApy) {
  if (netApy == null) return '—'
  return `${(netApy * 100).toFixed(2)}%`
}

/** Total deposits in USD → compact "$1.2M" / "$450K"; null → "—". */
export function formatTvl(totalAssetsUsd) {
  if (totalAssetsUsd == null) return '—'
  if (totalAssetsUsd >= 1_000_000) return `$${(totalAssetsUsd / 1_000_000).toFixed(1)}M`
  if (totalAssetsUsd >= 1_000) return `$${(totalAssetsUsd / 1_000).toFixed(0)}K`
  return `$${totalAssetsUsd.toFixed(0)}`
}
