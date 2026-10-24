import { formatUnits } from '../evm/units'
/**
 * Display formatting for token amounts (spec 102, FR-018 / plan D7).
 *
 * One rule, stated once: these helpers shape what a member SEES, never what is SENT. Anything
 * that reaches `parseUnits`, a MAX handler or a transaction keeps the full-precision value it
 * came with — callers hold the raw/decimal amount and pass it here only at the point of render.
 * A balance of `2.006441459389172406` is shown as `2.0064`; the wei behind it is untouched.
 *
 * Honesty rules (Constitution III): `null`/`undefined` stay `null` (the caller renders "—" or
 * its own pending mark), and an unparsable value is ALSO `null` — never `'0'`, because "0" is
 * a claim about the member's money that a failed read has no standing to make.
 *
 * | input                       | output                                        |
 * |-----------------------------|-----------------------------------------------|
 * | null / undefined            | null                                          |
 * | 0                           | '0'                                           |
 * | 0 < v < 0.000001            | '< 0.000001'                                  |
 * | 0.000001 ≤ v < 1            | up to 6 fraction digits, trailing zeros trimmed |
 * | v ≥ 1                       | up to 4 fraction digits (or maxFractionDigits), grouped |
 * | unparsable                  | null                                          |
 */

const DUST_FLOOR = 0.000001
const SMALL_FRACTION_DIGITS = 6
const DEFAULT_FRACTION_DIGITS = 4

/**
 * Format a value that is ALREADY a decimal amount — the output of `formatUnits`, or a
 * plain number — for display. Accepts a numeric string or a finite number; anything else is
 * `null`. `maxFractionDigits` applies to values ≥ 1 (the default is 4).
 *
 * @param {string|number|null|undefined} value
 * @param {{ maxFractionDigits?: number }} [opts]
 * @returns {string|null}
 */
export function formatDecimalForDisplay(value, { maxFractionDigits } = {}) {
  if (value == null) return null
  let n
  if (typeof value === 'number') {
    n = value
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return null
    n = Number(trimmed)
  } else {
    return null
  }
  if (!Number.isFinite(n)) return null

  const abs = Math.abs(n)
  if (abs === 0) return '0'
  if (abs < DUST_FLOOR) return '< 0.000001'

  const digits = abs < 1
    ? SMALL_FRACTION_DIGITS
    : Number.isInteger(maxFractionDigits) && maxFractionDigits >= 0
      ? maxFractionDigits
      : DEFAULT_FRACTION_DIGITS
  // `undefined` locale like the rest of the app: the member's own locale decides the separators.
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, useGrouping: true })
}

/**
 * Format a raw base-unit amount (`bigint`, a numeric string of base units, or an integer
 * number) for display, per the table above. Never throws: an unparsable input is `null`.
 *
 * @param {bigint|string|number|null|undefined} raw
 * @param {number} [decimals=18]
 * @param {{ maxFractionDigits?: number }} [opts]
 * @returns {string|null}
 */
export function formatUnitsForDisplay(raw, decimals = 18, opts = {}) {
  if (raw == null) return null
  if (typeof raw !== 'bigint' && typeof raw !== 'string' && typeof raw !== 'number') return null
  let decimal
  try {
    // The units seam validates the input: a non-integer number, a non-numeric string or a bad
    // `decimals` all throw here, and every one of those is "unparsable", not "zero".
    decimal = formatUnits(raw, decimals)
  } catch {
    return null
  }
  return formatDecimalForDisplay(decimal, opts)
}
