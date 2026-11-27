/**
 * FightReading (spec 115 slice 3) — the only way a fight's round, clock, figures or result reach a component.
 *
 * The same four trust states as the game reading, on the server's clock, by WHOSE words they are
 * (`TRUST_BOUNDS`, mirrored from the gateway's one constant): the `card` source can be live (≤ 30 s, delayed
 * ≤ 120 s); `figures` (the UFC's own statistics) and `venue` (the venue's feed) are NEVER live — their bound
 * pairs have `liveMs: null`, and the only function that turns an age into a state (`deriveState`, shared with
 * the game reading) cannot return `live` for them. A row with no source is `unknown` and carries no figures.
 *
 * Nothing here is derived (FR-018): a figure is an integer the source reported or null — never 0 for absent,
 * and a reported 0 stays 0 — and no total, accuracy, lead or score is computed. Readings are frozen.
 */
import { stamp as makeStamp, ageMs as stampAge, confirmedAtMs, monotonicNow } from '../markets/serverClock'
import { deriveState, readStatus } from './gameReading'

/** Mirrors the gateway's `sports/bounds.js#TRUST_BOUNDS` for the fight sources (provisional until a live card). */
export const FIGHT_TRUST_BOUNDS = Object.freeze({
  card: Object.freeze({ liveMs: 30_000, delayedMs: 120_000 }),
  figures: Object.freeze({ liveMs: null, delayedMs: 120_000 }),
  venue: Object.freeze({ liveMs: null, delayedMs: 75_000 }),
})

/** The figure keys the gateway sends — exactly these (`FIGURE_NAMES` in the gateway's ufc.js). */
export const FIGURE_KEYS = Object.freeze([
  'knockdowns',
  'sigStrikesLanded',
  'sigStrikesAttempted',
  'totalStrikesLanded',
  'totalStrikesAttempted',
  'headStrikesLanded',
  'headStrikesAttempted',
  'bodyStrikesLanded',
  'bodyStrikesAttempted',
  'legStrikesLanded',
  'legStrikesAttempted',
  'takedownsLanded',
  'takedownsAttempted',
  'reversals',
  'submissionsAttempted',
  'controlSeconds',
])

const SOURCES = new Set(['card', 'figures', 'venue'])
const OUTCOMES = new Set(['win', 'draw', 'no-contest', 'cancelled'])

/** The game statuses plus `cancelled` (only ever the venue's word). Anything else is carried as the source's own text. */
const fightStatus = (s) => (s === 'cancelled' ? { status: 'cancelled', statusText: null } : readStatus(s))

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null)
const nonNegInt = (v) => (Number.isInteger(v) && v >= 0 ? v : null)
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const num = (v) => (Number.isFinite(v) ? v : null)

/** Exactly the known keys, each a non-negative integer or null. Nothing else crosses. */
export function readFigures(f) {
  const out = {}
  for (const k of FIGURE_KEYS) out[k] = nonNegInt(f?.[k])
  return Object.freeze(out)
}

const pair = (arr) => (Array.isArray(arr) && arr.length === 2 ? Object.freeze([readFigures(arr[0]), readFigures(arr[1])]) : null)

function readRounds(rounds) {
  if (!Array.isArray(rounds)) return null
  const out = rounds
    .map((r) => ({ round: nonNegInt(r?.round), figures: pair(r?.figures) }))
    .filter((r) => r.round != null && r.round > 0 && r.figures)
    .sort((a, b) => a.round - b.round)
    .map((r) => Object.freeze(r))
  return out.length ? Object.freeze(out) : null
}

function readJudges(judges) {
  if (!Array.isArray(judges)) return Object.freeze([])
  return Object.freeze(
    judges
      .map((j) => ({
        name: text(j?.name),
        scores: Array.isArray(j?.scores) && j.scores.length === 2 && j.scores.every((n) => Number.isInteger(n)) ? Object.freeze([...j.scores]) : null,
      }))
      .filter((j) => j.scores)
      .map((j) => Object.freeze(j)),
  )
}

/** The result as the source gave it; `winner` is an index only when the outcome is a win. */
export function readResult(r) {
  if (!r || typeof r !== 'object') return null
  const outcome = OUTCOMES.has(r.outcome) ? r.outcome : null
  return Object.freeze({
    source: SOURCES.has(r.source) ? r.source : null,
    outcome,
    winner: outcome === 'win' && (r.winner === 0 || r.winner === 1) ? r.winner : null,
    method: text(r.method),
    endingRound: nonNegInt(r.endingRound),
    endingTime: text(r.endingTime),
    judges: readJudges(r.judges),
  })
}

/** What the venue's feed last said while another source led (the disagreement line is built from it). */
function readVenue(v) {
  if (!v || typeof v !== 'object') return null
  const { status } = fightStatus(v.status)
  return Object.freeze({ status, statusText: text(v.status), scoreText: text(v.scoreText), clock: text(v.clock), changedAt: num(v.changedAt) })
}

const names = (f) => Object.freeze([{ name: text(f?.[0]?.name) }, { name: text(f?.[1]?.name) }].map((x) => Object.freeze(x)))

/** No value. Deliberately has no figure keys and no stamp. */
export function unknownFight(reason = 'unknown') {
  return Object.freeze({ state: 'unknown', reason: String(reason), isLive: false, ageMs: () => null })
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

function figuresOf(source, fight) {
  const status = fightStatus(fight.status)
  return {
    gameId: fight.gameId ?? null,
    source,
    status: status.status,
    statusText: status.statusText,
    scheduledRounds: nonNegInt(fight.scheduledRounds),
    weightClass: text(fight.weightClass),
    round: nonNegInt(fight.round),
    clock: text(fight.clock),
    changedAt: source === 'venue' ? num(fight.changedAt) : null,
    fighters: names(fight.fighters),
    result: readResult(fight.result),
    // The venue block exists only while another source leads.
    venue: source !== 'venue' ? readVenue(fight.venue) : null,
    rounds: readRounds(fight.rounds),
    overall: pair(fight.overall),
  }
}

/** `fight` + the envelope's `serverNow` (server ms) → a reading. No source / no confirmation ⇒ `unknown`. */
export function fromFight(fight, serverNow, receivedAt = monotonicNow()) {
  if (!fight || typeof fight !== 'object') return unknownFight('no-fight')
  const source = fight.source
  if (!SOURCES.has(source)) return unknownFight('no-source')
  const stamp = makeStamp({ confirmedAt: iso(fight.confirmedAt), serverNow: iso(serverNow) }, receivedAt)
  const state = deriveState(FIGHT_TRUST_BOUNDS[source], stampAge(stamp, receivedAt))
  if (state === 'unknown') return unknownFight('no-timestamp')
  return build(state, figuresOf(source, fight), stamp)
}

/** Re-derive the state as time passes; the SAME object when nothing changed. */
export function reclassifyFight(reading, now = monotonicNow()) {
  if (!reading || reading.state === 'unknown') return reading
  const next = deriveState(FIGHT_TRUST_BOUNDS[reading.source], stampAge(reading.stamp, now))
  if (next === reading.state) return reading
  if (next === 'unknown') return unknownFight('no-timestamp')
  const { state: _s, stamp, isLive: _l, confirmedAt: _c, ageMs: _a, ...figures } = reading
  return build(next, figures, stamp)
}
