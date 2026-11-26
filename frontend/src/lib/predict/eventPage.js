/**
 * Event-page helpers (spec 114, slice 4) — the pure part of the page, so each rule can be tested without a
 * component: which tokens the page may subscribe to, how readings compare for trust, how a history becomes
 * a drawable series, and which resolution sources may be links.
 */
import { describeAge } from '../markets/priceReading'

export const POLYMARKET_PREFIX = 'polymarket:'
/** The poller batches ten tokens a request against a 60/min read quota — the page never asks for more. */
export const MAX_SUBSCRIBED_KEYS = 10
/** Yes tokens of the most likely rows. Two slots are left for the selected row's own two tokens. */
export const MAX_ROW_KEYS = 8
export const MAX_CHART_SERIES = 4

export const RANGES = Object.freeze([
  { id: '1h', label: '1H', stepSec: 60 },
  { id: '1d', label: '1D', stepSec: 300 },
  { id: '1w', label: '1W', stepSec: 1800 },
  { id: '1m', label: '1M', stepSec: 10800 },
  { id: 'max', label: 'MAX', stepSec: 43200 },
])
export const DEFAULT_RANGE = '1d'

/** Series styling: a colour token AND a dash pattern, so no series is told apart by colour alone. */
export const SERIES_STYLES = Object.freeze([
  { id: 'a', dash: '' },
  { id: 'b', dash: '7 4' },
  { id: 'c', dash: '2 3' },
  { id: 'd', dash: '10 3 2 3' },
])

export const readingKey = (tokenId) => `${POLYMARKET_PREFIX}${tokenId}`

const isYes = (o) => typeof o?.name === 'string' && o.name.trim().toLowerCase() === 'yes'

/** The outcome whose price is the row's headline probability: "Yes" when it has one, else the first. */
export function primaryOutcome(row) {
  const outcomes = Array.isArray(row?.outcomes) ? row.outcomes : []
  return outcomes.find(isYes) ?? outcomes[0] ?? null
}

/** The other side of a two-outcome row: the first outcome that is not the primary one. */
export function counterOutcome(row) {
  const primary = primaryOutcome(row)
  const outcomes = Array.isArray(row?.outcomes) ? row.outcomes : []
  return outcomes.find((o) => o !== primary) ?? null
}

/**
 * Most likely first, by the venue's headline price; a row with no price goes last (never first as a "0").
 * Stable, so equal rows keep the venue's order.
 */
export function rankRows(rows) {
  const list = Array.isArray(rows) ? rows : []
  const price = (r) => (r?.displayPrice != null && Number.isFinite(Number(r.displayPrice)) ? Number(r.displayPrice) : -1)
  return list
    .map((row, i) => ({ row, i }))
    .sort((a, b) => price(b.row) - price(a.row) || a.i - b.i)
    .map(({ row }) => row)
}

/**
 * The keys the page subscribes to — AT MOST TEN, always: the Yes token of the first eight rows, plus the
 * selected row's two tokens (its primary is usually already among the eight; when the selected row is
 * further down it takes the ninth and tenth). The hard slice is the last line of defence, not the plan.
 */
export function subscriptionKeys(rankedRows, selectedRow) {
  const keys = []
  const add = (outcome) => {
    const id = outcome?.tokenId
    if (id == null || id === '') return
    const key = readingKey(id)
    if (!keys.includes(key)) keys.push(key)
  }
  ;(Array.isArray(rankedRows) ? rankedRows : []).slice(0, MAX_ROW_KEYS).forEach((r) => add(primaryOutcome(r)))
  if (selectedRow) {
    add(primaryOutcome(selectedRow))
    add(counterOutcome(selectedRow))
  }
  return keys.slice(0, MAX_SUBSCRIBED_KEYS)
}

const TRUST_ORDER = { unknown: 0, 'last-known': 1, delayed: 2, live: 3 }

/**
 * The LEAST trusting reading among `readings` (unknown < last-known < delayed < live); among equals, the
 * oldest — so one stale outcome is never hidden behind nine live ones. Null for an empty list.
 */
export function leastTrusting(readings) {
  let worst = null
  for (const r of readings) {
    if (!r) continue
    if (worst == null) {
      worst = r
      continue
    }
    const a = TRUST_ORDER[r.state] ?? 0
    const b = TRUST_ORDER[worst.state] ?? 0
    if (a < b) worst = r
    else if (a === b) {
      const ageR = r.ageMs?.()
      const ageW = worst.ageMs?.()
      if (Number.isFinite(ageR) && (!Number.isFinite(ageW) || ageR > ageW)) worst = r
    }
  }
  return worst
}

/** "Delayed · 12 s" / "Last known · 2 min" for a non-live reading; null when live (the chip says so). */
export function stateWords(reading) {
  if (!reading || reading.state === 'live') return null
  const age = reading.ageMs?.()
  const ageText = Number.isFinite(age) ? ` · ${describeAge(age)}` : ''
  if (reading.state === 'delayed') return `Delayed${ageText}`
  if (reading.state === 'last-known') return `Last known${ageText}`
  return 'Unavailable'
}

/**
 * A resolution source is a link ONLY when it is an `https:` URL (and carries no embedded credentials);
 * anything else — a name, a plain domain, `http:`, `javascript:` — is text. Returns the normalised href or null.
 */
export function safeHttpsUrl(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!/^https:\/\/\S+$/i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null
    return url.href
  } catch {
    return null
  }
}

/**
 * History points → drawable `{ t (ms), p (0..1 | null) }`. A step longer than five sampling intervals is a
 * GAP, marked with a null point so the line breaks there — a chart never joins what it did not observe.
 * An unparsable price is a gap too, never a zero. `tail` is an optional `{ t (s), p }` appended after the
 * history (the caller passes it only for a `live` reading).
 */
export function buildSeriesData(points, stepSec, tail = null) {
  const out = []
  const all = (Array.isArray(points) ? points : []).slice()
  if (tail && Number.isFinite(Number(tail.t)) && tail.p != null) all.push({ t: Number(tail.t), p: tail.p })
  const clean = all
    .map((pt) => ({ t: Number(pt?.t), p: pt?.p == null || pt.p === '' ? null : Number(pt.p) }))
    .filter((pt) => Number.isFinite(pt.t))
    .sort((a, b) => a.t - b.t)
  const gapSec = Math.max(1, stepSec) * 5
  let prev = null
  for (const pt of clean) {
    if (prev && pt.t - prev.t > gapSec) out.push({ t: (prev.t + 1) * 1000, p: null })
    out.push({ t: pt.t * 1000, p: Number.isFinite(pt.p) ? pt.p : null })
    prev = pt
  }
  return out
}
