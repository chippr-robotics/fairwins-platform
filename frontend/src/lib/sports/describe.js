/**
 * Words for a game (spec 115) — pure, so the same sentence is what the field's text line, the tests and a
 * screen reader all get. Nothing here invents a fact: a missing part is left out, never filled with a guess.
 */

const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** A team's display text: its name, else its code, else null. */
export function teamLabel(team) {
  return nonEmpty(team?.name) ?? nonEmpty(team?.code) ?? null
}

/**
 * The two sides of a listing. `homeAway` ONLY when the venue stated which is which; `teams` (in the venue's
 * order) when it did not — and then nothing downstream may say "home" or "away".
 */
export function sidesOf(game) {
  if (!game || typeof game !== 'object') return { kind: 'none' }
  const hasHA = (game.home && typeof game.home === 'object') || (game.away && typeof game.away === 'object')
  if (hasHA) return { kind: 'homeAway', home: game.home ?? null, away: game.away ?? null }
  if (Array.isArray(game.teams) && game.teams.length > 0) {
    return { kind: 'teams', teams: [game.teams[0] ?? null, game.teams[1] ?? null] }
  }
  return { kind: 'none' }
}

/** "Thu 4:30 PM" in the member's locale; null when the start is unknown or not a date. */
export function formatStart(startTime) {
  if (typeof startTime !== 'string') return null
  const ms = Date.parse(startTime)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

const ORDINAL = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th' }

/** "4th & 18", "1st & Goal"-free: only what the numbers say. null when either number is absent. */
export function downAndDistance(situation) {
  const { down, distance } = situation || {}
  if (!Number.isInteger(down) || !Number.isInteger(distance) || !ORDINAL[down]) return null
  return `${ORDINAL[down]} & ${distance}`
}

/** A yard on the home-goal-line axis, in words: "DAL 37", "midfield", "the home 37". */
export function yardWords(yard, { homeName, awayName }) {
  if (!Number.isFinite(yard) || yard < 0 || yard > 100) return null
  if (yard === 50) return 'midfield'
  const fromHome = yard < 50
  const n = Math.round(fromHome ? yard : 100 - yard)
  const side = fromHome ? homeName ?? 'the home side' : awayName ?? 'the away side'
  return `${side} ${n}`
}

/**
 * The situation as one sentence of facts, same content as the drawing. `names` = { home, away } display
 * strings (either may be null). Absent facts are skipped, never zero.
 */
export function situationSentence(situation, names) {
  if (!situation) return null
  const parts = []
  const dd = nonEmpty(situation.downDistanceText) ?? [downAndDistance(situation), nonEmpty(situation.yardLineText)].filter(Boolean).join(' at ')
  if (dd) parts.push(dd)
  const hasBall = situation.possession === 'home' || situation.possession === 'away'
  if (hasBall) {
    const own = names[situation.possession]
    const other = names[situation.possession === 'home' ? 'away' : 'home']
    const who = own ?? (situation.possession === 'home' ? 'The home team' : 'The away team')
    parts.push(`${who} ${own ? 'have' : 'has'} the ball, driving toward ${other ? `the ${other}` : 'the opposite'} end zone`)
  }
  const gain = yardWords(situation.lineToGain, { homeName: names.home, awayName: names.away })
  if (gain) parts.push(`line to gain: ${gain}`)
  if (situation.redZone === true) parts.push('in the red zone')
  if (parts.length === 0) return null
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('. ') + '.'
}

/** Neutral wording when the envelope names no source: never a hardcoded vendor. */
export const playsName = (sources) => sources?.plays?.label || 'the play-by-play source'
export const venueFeedName = (sources) => (sources?.venue?.label ? `${sources.venue.label}'s game feed` : "the venue's feed")

