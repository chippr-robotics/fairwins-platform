/**
 * GameReading (spec 115) — the ONLY way a game's score, clock or status reaches a component.
 *
 * Mirrors lib/markets/priceReading.js: four states, DERIVED from the age of the last confirmation on the
 * SERVER's clock (never stored as a claim, never the device's). Only a reading inside LIVE_MS is `live`.
 * `unknown` carries NO figures at all — it has no `score`, `period` or `clock` key, so there is nowhere for
 * `?? 0` to land. Nothing here is a number the gateway did not give: a score is kept only when BOTH sides are
 * integers, otherwise it is null (and the venue's own `scoreText`, when there is one, is kept as text, never
 * parsed). Readings are frozen.
 */
import { stamp as makeStamp, ageMs as stampAge, confirmedAtMs, monotonicNow } from '../markets/serverClock'

/**
 * Provisional bounds. Gateway research R1 (the venue feed's per-league cadence measured through a full game)
 * sets the FINAL numbers; these are placeholders chosen to be tighter than the venue's observed silences.
 */
export const LIVE_MS = 20_000
export const DELAYED_MS = 90_000

const KNOWN_STATUS = new Set(['scheduled', 'in-progress', 'ended'])

const isInt = (n) => Number.isInteger(n)
const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

/** Two integers, or null. Anything else (a set count, a string, one side missing) is NOT a score. */
export function readScore(score) {
  if (!score || typeof score !== 'object') return null
  return isInt(score.home) && isInt(score.away) ? Object.freeze({ home: score.home, away: score.away }) : null
}

/** A status this surface knows, or `other` with the venue's own words; never a guess. */
export function readStatus(status) {
  if (KNOWN_STATUS.has(status)) return { status, statusText: null }
  const t = text(status)
  return t ? { status: 'other', statusText: t } : { status: null, statusText: null }
}

function stateFor(age) {
  if (age == null) return 'unknown'
  if (age <= LIVE_MS) return 'live'
  if (age <= DELAYED_MS) return 'delayed'
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

/**
 * One gateway game row + the envelope's `serverNow` (server ms) → a reading. `receivedAt` is the monotonic
 * time the answer arrived. A row with no `confirmedAt`, or an envelope with no `serverNow`, is `unknown`:
 * an age that cannot be measured is never fresh.
 */
export function fromRow(row, serverNow, receivedAt = monotonicNow()) {
  if (!row || typeof row !== 'object') return unknown('no-row')
  const stamp = makeStamp({ confirmedAt: iso(row.confirmedAt), serverNow: iso(serverNow) }, receivedAt)
  const age = stampAge(stamp, receivedAt)
  if (age == null) return unknown('no-timestamp')
  const { status, statusText } = readStatus(row.status)
  const figures = {
    gameId: row.gameId ?? null,
    league: text(row.league),
    status,
    statusText,
    score: readScore(row.score),
    scoreText: text(row.scoreText),
    period: text(row.period),
    clock: text(row.clock),
    possession: row.possession === 'home' || row.possession === 'away' ? row.possession : null,
    confirmedBy: text(row.confirmedBy),
    agree: typeof row.agree === 'boolean' ? row.agree : null,
  }
  return build(stateFor(age), figures, stamp)
}

/** Re-derive the state from the stamp as time passes. Returns the SAME object when nothing changed. */
export function reclassify(reading, now = monotonicNow()) {
  if (!reading || reading.state === 'unknown') return reading
  const next = stateFor(stampAge(reading.stamp, now))
  if (next === reading.state) return reading
  if (next === 'unknown') return unknown('no-timestamp')
  const { state: _s, stamp, isLive: _l, confirmedAt: _c, ageMs: _a, ...figures } = reading
  return build(next, figures, stamp)
}

/** Age of a separately-confirmed detail block (plays), same clock rules. null when unknowable. */
export function detailAgeMs(confirmedAt, serverNow, receivedAt, now = monotonicNow()) {
  return stampAge(makeStamp({ confirmedAt: iso(confirmedAt), serverNow: iso(serverNow) }, receivedAt), now)
}
