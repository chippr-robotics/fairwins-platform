/**
 * GameReading (spec 115) — the ONLY way a game's score, clock or status reaches a component.
 *
 * Mirrors lib/markets/priceReading.js: four states, DERIVED from the age of the last confirmation on the
 * SERVER's clock (never stored as a claim, never the device's) AND from whose figures they are. The play
 * source leads and can be live; the venue's feed speaks only when something changes, on whole-minute ticks,
 * and was measured minutes BEHIND the game — so a venue reading is NEVER live. That is structural: the one
 * function that chooses a state (`stateFor`) takes the source, a venue source has no live bound, and there is
 * no exported constructor that takes a state, so "a venue reading is live" has nowhere to be written.
 * `unknown` carries NO figures (no `score`, `period`, `clock`, `source` key), and a row with no source is
 * unknown. A score is kept only when BOTH sides are integers; the source's own `scoreText` stays text.
 * Readings are frozen.
 */
import { stamp as makeStamp, ageMs as stampAge, confirmedAtMs, monotonicNow } from '../markets/serverClock'

/** Mirrors the gateway's `sports/bounds.js#TRUST_BOUNDS` (contract: one constant, mirrored here). */
export const TRUST_BOUNDS = Object.freeze({
  plays: Object.freeze({ liveMs: 30_000, delayedMs: 120_000 }),
  venue: Object.freeze({ liveMs: null, delayedMs: 75_000 }), // null = never live
})

const KNOWN_STATUS = new Set(['scheduled', 'in-progress', 'ended'])

const isInt = (n) => Number.isInteger(n)
const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v) => (Number.isFinite(v) ? v : null)
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

/** Two integers, or null. Anything else (a set count, a string, one side missing) is NOT a score. */
export function readScore(score) {
  if (!score || typeof score !== 'object') return null
  return isInt(score.home) && isInt(score.away) ? Object.freeze({ home: score.home, away: score.away }) : null
}

/** A status this surface knows, or `other` with the source's own words; never a guess. */
export function readStatus(status) {
  if (KNOWN_STATUS.has(status)) return { status, statusText: null }
  const t = text(status)
  return t ? { status: 'other', statusText: t } : { status: null, statusText: null }
}

function stateFor(source, age) {
  const bounds = TRUST_BOUNDS[source]
  if (!bounds || age == null) return 'unknown'
  if (bounds.liveMs != null && age <= bounds.liveMs) return 'live'
  if (age <= bounds.delayedMs) return 'delayed'
  return 'last-known'
}

/** No value. Deliberately has no figure keys and no stamp. */
export function unknown(reason = 'unknown') {
  return Object.freeze({
    state: 'unknown',
    reason: String(reason),
    isLive: false,
    ageMs: () => null,
  })
}

function build(state, figures, stamp) {
  return Object.freeze({
    ...figures,
    state,
    stamp,
    isLive: state === 'live',
    confirmedAt: confirmedAtMs(stamp),
    ageMs: (now) => stampAge(stamp, now),
  })
}

/** What the venue's feed last said while the play source led (the disagreement line is built from it). */
function readVenue(v) {
  if (!v || typeof v !== 'object') return null
  const { status, statusText } = readStatus(v.status)
  return Object.freeze({
    status,
    statusText,
    score: readScore(v.score),
    scoreText: text(v.scoreText),
    period: text(v.period),
    clock: text(v.clock),
    changedAt: num(v.changedAt),
  })
}

function figuresOf(source, row) {
  const { status, statusText } = readStatus(row.status)
  return {
    gameId: row.gameId ?? null,
    league: text(row.league),
    source,
    status,
    statusText,
    score: readScore(row.score),
    scoreText: text(row.scoreText),
    period: text(row.period),
    clock: text(row.clock),
    possession: row.possession === 'home' || row.possession === 'away' ? row.possession : null,
    changedAt: source === 'venue' ? num(row.changedAt) : null,
    agree: typeof row.agree === 'boolean' ? row.agree : null,
    venue: source === 'plays' ? readVenue(row.venue) : null,
  }
}

/**
 * One gateway game row + the envelope's `serverNow` (server ms) → a reading. `receivedAt` is the monotonic
 * time the answer arrived. A row with no `source`, no `confirmedAt`, or an envelope with no `serverNow` is
 * `unknown`: an age that cannot be measured is never fresh, and a row nobody spoke for has no figures.
 */
export function fromRow(row, serverNow, receivedAt = monotonicNow()) {
  if (!row || typeof row !== 'object') return unknown('no-row')
  const source = row.source
  if (source !== 'plays' && source !== 'venue') return unknown('no-source')
  const stamp = makeStamp({ confirmedAt: iso(row.confirmedAt), serverNow: iso(serverNow) }, receivedAt)
  const state = stateFor(source, stampAge(stamp, receivedAt))
  if (state === 'unknown') return unknown('no-timestamp')
  return build(state, figuresOf(source, row), stamp)
}

/**
 * The event listing's own words about the game, as a VENUE reading aged from the listing's own confirmation
 * (`stamp` = the events answer's stamp). Never live. When that age cannot be measured, or the listing said
 * nothing, it is `unknown` and the caller shows nothing.
 */
export function fromListed(listed, stamp, now = monotonicNow()) {
  if (!listed || typeof listed !== 'object') return unknown('no-listing')
  const state = stateFor('venue', stampAge(stamp, now))
  if (state === 'unknown') return unknown('no-timestamp')
  return build(
    state,
    figuresOf('venue', { status: listed.status, scoreText: listed.scoreText, period: listed.period, clock: listed.clock, score: null }),
    stamp,
  )
}

/** Re-derive the state from the stamp as time passes. Returns the SAME object when nothing changed. */
export function reclassify(reading, now = monotonicNow()) {
  if (!reading || reading.state === 'unknown') return reading
  const next = stateFor(reading.source, stampAge(reading.stamp, now))
  if (next === reading.state) return reading
  if (next === 'unknown') return unknown('no-timestamp')
  const { state: _s, stamp, isLive: _l, confirmedAt: _c, ageMs: _a, ...figures } = reading
  return build(next, figures, stamp)
}

/** Age of any instant the gateway reported (a detail block, a venue `changedAt`), same clock rules. null when unknowable. */
export function detailAgeMs(confirmedAt, serverNow, receivedAt, now = monotonicNow()) {
  return stampAge(makeStamp({ confirmedAt: iso(confirmedAt), serverNow: iso(serverNow) }, receivedAt), now)
}
