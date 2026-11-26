/**
 * PriceReading (spec 114, R5 + R6) — the ONLY way a price reaches a component or the plan arithmetic.
 *
 * Four constructors; only `live` yields `plannable === true`, and `unknown` carries no `price`,
 * `bids` or `asks` property at all, so there is nowhere for `?? 0` to land. State is DERIVED from age
 * (never stored as a claim): <= LIVE_WITHIN_MS live, <= DELAYED_WITHIN_MS delayed, beyond last-known.
 * Prices and sizes stay decimal STRINGS. Readings are frozen.
 */
import { ageMs as stampAge, confirmedAtMs, monotonicNow } from './serverClock'

export const LIVE_WITHIN_MS = 5000
export const DELAYED_WITHIN_MS = 30000

const MAX_MID_SPREAD_MICRO = 100_000n // 0.10
const DECIMAL_RE = /^\d+(\.\d+)?$/

function deepFreezeLevels(levels) {
  if (!Array.isArray(levels)) return undefined
  return Object.freeze(levels.map((l) => Object.freeze([...l])))
}

function build(state, { price, bids, asks, stamp, stale = false, demoted = false, extra } = {}) {
  const base = { ...(extra && typeof extra === 'object' ? extra : {}) }
  // Core fields are written after `extra` so a caller cannot override them.
  base.state = state
  base.price = price
  if (bids !== undefined) base.bids = deepFreezeLevels(bids)
  if (asks !== undefined) base.asks = deepFreezeLevels(asks)
  base.stamp = stamp
  base.stale = Boolean(stale)
  base.demoted = Boolean(demoted)
  base.confirmedAt = confirmedAtMs(stamp)
  base.plannable = state === 'live'
  base.ageMs = (now) => stampAge(stamp, now)
  return Object.freeze(base)
}

export const live = (input) => build('live', input)
export const delayed = (input) => build('delayed', input)
export const lastKnown = (input) => build('last-known', input)

/** No value. Deliberately has no `price`/`bids`/`asks`/`stamp` keys. */
export function unknown(reason = 'unknown') {
  return Object.freeze({
    state: 'unknown',
    reason: String(reason),
    plannable: false,
    ageMs: () => null,
  })
}

function stateFor(age, capped) {
  if (age == null) return 'unknown'
  if (!capped && age <= LIVE_WITHIN_MS) return 'live'
  if (age <= DELAYED_WITHIN_MS) return 'delayed'
  return 'last-known'
}

const CONSTRUCTORS = { live, delayed, 'last-known': lastKnown }

/**
 * Pick the state from the stamp's age. A `stale` input (gateway could not reach the venue) can never be
 * live, and an unknowable age is `unknown`, never fresh.
 */
export function classify({ price, bids, asks, stamp, stale = false, demoted = false, extra } = {}, now = monotonicNow()) {
  if (price == null || price === '') return unknown('no-price')
  const age = stampAge(stamp, now)
  const state = stateFor(age, Boolean(stale) || Boolean(demoted))
  if (state === 'unknown') return unknown('no-timestamp')
  return CONSTRUCTORS[state]({ price, bids, asks, stamp, stale, demoted, extra })
}

/** Re-derive an existing reading's state from its stamp. Returns the SAME object when nothing changed. */
export function reclassify(reading, now = monotonicNow()) {
  if (!reading || reading.state === 'unknown') return reading
  const next = stateFor(stampAge(reading.stamp, now), reading.stale || reading.demoted)
  if (next === reading.state) return reading
  if (next === 'unknown') return unknown('no-timestamp')
  const { state: _s, price, bids, asks, stamp, stale, demoted, ...rest } = reading
  const { plannable: _p, ageMs: _a, confirmedAt: _c, ...extra } = rest
  return CONSTRUCTORS[next]({ price, bids, asks, stamp, stale, demoted, extra })
}

/** A live reading held back to delayed (stream sequence gap) until the next value replaces it. */
export function demote(reading) {
  if (!reading || reading.state !== 'live') return reading
  const { state: _s, price, bids, asks, stamp, stale, ...rest } = reading
  const { plannable: _p, ageMs: _a, confirmedAt: _c, demoted: _d, ...extra } = rest
  return delayed({ price, bids, asks, stamp, stale, demoted: true, extra })
}

/** Short honest age text: "3 s", "48 s", "2 min", "1 h". No fake precision; null/unknown → "—". */
export function describeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs} s`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins} min`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h`
  return `${Math.round(hours / 24)} d`
}

function toMicro(s) {
  if (typeof s !== 'string' || !DECIMAL_RE.test(s)) return null
  const [i, f = ''] = s.split('.')
  if (f.length > 6) return null
  return BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0'))
}

function fromTenthMicro(n) {
  const whole = n / 10_000_000n
  const frac = (n % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : String(whole)
}

/**
 * The headline price: midpoint of best bid/ask while the spread is at most 0.10, else the last trade;
 * null when neither is derivable. Mirrors the gateway's displayPrice in integer micro-units.
 */
export function displayPrice(bestBid, bestAsk, lastTradePrice) {
  const bid = toMicro(bestBid)
  const ask = toMicro(bestAsk)
  if (bid != null && ask != null && ask >= bid && ask - bid <= MAX_MID_SPREAD_MICRO) {
    return fromTenthMicro((bid + ask) * 5n)
  }
  return lastTradePrice ?? null
}
