/**
 * Display formatting for Predict event cards (spec 114). Every function returns '—' or null for an
 * unknown input — an unknown is never rendered as zero (FR-012).
 */

export function formatPercent(displayPrice) {
  if (displayPrice == null || displayPrice === '') return '—'
  const pct = Number(displayPrice) * 100
  if (!Number.isFinite(pct)) return '—'
  if (pct < 1) return '<1%'
  if (pct >= 99.5 && pct < 100) return '>99%'
  return Math.round(pct) + '%'
}

export function formatCents(price) {
  if (price == null || price === '') return '—'
  const cents = Number(price) * 100
  if (!Number.isFinite(cents)) return '—'
  if (cents < 0.5) return '<1¢'
  return Math.round(cents) + '¢'
}

export function formatVolume(volume) {
  if (volume == null || volume === '') return null
  const n = Number(volume)
  if (!Number.isFinite(n) || n < 0) return null
  const compact = (v, suffix) => '$' + String(Math.round(v * 10) / 10) + suffix
  if (n >= 1e9) return compact(n / 1e9, 'B')
  if (n >= 1e6) return compact(n / 1e6, 'M')
  if (n >= 1e3) return compact(n / 1e3, 'K')
  return '$' + String(Math.round(n))
}

export function formatClosing(endDate) {
  if (!endDate) return null
  const d = new Date(endDate)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Closing date for an event page, with the year: "Dec 10, 2026". Null for an unknown date. */
export function formatClosingDate(endDate) {
  if (!endDate) return null
  const d = new Date(endDate)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * A price level in cents with at most one decimal ("94¢", "93.5¢", "0.1¢") — a book can sit on a finer
 * tick than a whole cent, and rounding it would show a level that is not on offer. Unknown → "—".
 */
export function formatLevelCents(price) {
  if (price == null || price === '') return '—'
  const cents = Number(price) * 100
  if (!Number.isFinite(cents)) return '—'
  return String(Math.round(cents * 10) / 10) + '¢'
}

/** A share count, compact: "12", "5.1K", "1.2M". Unknown → "—"; never "0" for something unreadable. */
export function formatShares(size) {
  if (size == null || size === '') return '—'
  const n = Number(size)
  if (!Number.isFinite(n) || n < 0) return '—'
  const compact = (v, suffix) => String(Math.round(v * 10) / 10) + suffix
  if (n >= 1e6) return compact(n / 1e6, 'M')
  if (n >= 1e3) return compact(n / 1e3, 'K')
  return String(Math.round(n * 10) / 10)
}

/** "In play · 91-101 · Q4" — the venue's own words, each part only when the venue gave it. Null when not in play. */
export function formatInPlay(live) {
  if (!live || typeof live !== 'object') return null
  return ['In play', live.score, live.period].filter((part) => typeof part === 'string' && part.trim() !== '').join(' · ')
}

/* ── Order-ticket money (spec 114 slice 5) ───────────────────────────────────────────────────────────
 * Exact BigInt formatting from decimal strings / micro-units, and every figure rounds AGAINST the member:
 * what they pay, risk or are charged rounds UP to the cent, what they receive rounds DOWN, so the page is
 * never kinder than what executes. An unreadable value is "—", never $0.00. */

const MICRO_UNITS = 1_000_000n
const DECIMAL = /^\d+(\.\d+)?$/

function toMicroUnits(value) {
  if (typeof value === 'bigint') return value
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  const [whole, frac = ''] = value.split('.')
  return BigInt(whole) * MICRO_UNITS + BigInt(frac.slice(0, 6).padEnd(6, '0'))
}

const withCommas = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** "$50.25". `rounding`: 'up' (costs, fees, losses) or 'down' (proceeds, payouts). */
export function formatUsd(value, rounding = 'up') {
  const micro = toMicroUnits(value)
  if (micro == null) return '—'
  const step = 10_000n // one cent
  let cents = micro / step
  if (rounding === 'up' && micro % step !== 0n) cents += 1n
  const whole = cents / 100n
  const frac = String(cents % 100n).padStart(2, '0')
  return '$' + withCommas(String(whole)) + '.' + frac
}

/** A share count rounded DOWN to 0.01 with trailing zeros trimmed: "55.32", "12". Unknown → "—". */
export function formatShareCount(value) {
  const micro = toMicroUnits(value)
  if (micro == null) return '—'
  const hundredths = micro / 10_000n
  const whole = hundredths / 100n
  const frac = String(hundredths % 100n).padStart(2, '0').replace(/0+$/, '')
  return frac ? withCommas(String(whole)) + '.' + frac : withCommas(String(whole))
}

/** An exact dollar figure for amounts that are signed to the hundredth of a cent: "$49.9947", "$50.00". */
export function formatUsdExact(value) {
  const micro = toMicroUnits(value)
  if (micro == null) return '—'
  const whole = micro / MICRO_UNITS
  const frac = String(micro % MICRO_UNITS).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')
  return '$' + withCommas(String(whole)) + '.' + frac
}

/**
 * A price (0–1) in cents to at most two decimals, rounded against the member: "93.81¢", "57¢".
 * `rounding`: 'up' for what a buyer pays, 'down' for what a seller receives, 'nearest' for an informational
 * average (a plan that fills entirely at 94¢ must read "94¢", not "94.01¢"). Unknown → "—".
 */
export function formatPriceCents(value, rounding = 'up') {
  const micro = toMicroUnits(value)
  if (micro == null) return '—'
  let hundredths = micro / 100n // hundredths of a cent
  if (rounding === 'up' && micro % 100n !== 0n) hundredths += 1n
  if (rounding === 'nearest' && micro % 100n >= 50n) hundredths += 1n
  const whole = hundredths / 100n
  const frac = String(hundredths % 100n).padStart(2, '0').replace(/0+$/, '')
  return (frac ? whole + '.' + frac : String(whole)) + '¢'
}

/** A decimal string (or bigint) → micro-units (6 dp), or null when it is not a plain decimal. */
export const decimalToMicro = toMicroUnits
