/**
 * Venue game <-> ESPN event (spec 115, research R2). Short of EXACTLY ONE match the answer is
 * `not-matched` — never the nearest, never the first. A wrong match would put another game's plays
 * beside a member's market, which is worse than showing none.
 *
 * Identity is league + both team codes (through the league's alias table) with the home/away sides
 * agreeing, and — when the caller knows the start time — kickoff within +-30 minutes. The venue
 * frame carries no start time, so today the time test only runs when one is supplied.
 */
import { leagueConfig } from './leagues.js'

export const START_WINDOW_MS = 30 * 60 * 1000

export function espnCode(league, venueCode) {
  const cfg = leagueConfig(league)
  if (typeof venueCode !== 'string' || venueCode.trim() === '') return null
  const up = venueCode.trim().toUpperCase()
  return cfg?.aliases && Object.hasOwn(cfg.aliases, up) ? cfg.aliases[up] : up
}

/**
 * @param {{league: string, homeCode: string|null, awayCode: string|null, startMs?: number|null}} game
 * @param {{id: string, startMs: number|null, home: {code: string|null}, away: {code: string|null}}[]} events
 * @returns {{state: 'matched', event: object} | {state: 'not-matched', reason: string}}
 */
export function matchEvent(game, events) {
  const home = espnCode(game.league, game.homeCode)
  const away = espnCode(game.league, game.awayCode)
  if (!home || !away) return { state: 'not-matched', reason: 'no_team_codes' }
  const hits = events.filter((e) => {
    if (e?.home?.code !== home || e?.away?.code !== away) return false
    if (game.startMs != null && e.startMs != null && Math.abs(e.startMs - game.startMs) > START_WINDOW_MS) return false
    return true
  })
  if (hits.length === 1) return { state: 'matched', event: hits[0] }
  return { state: 'not-matched', reason: hits.length === 0 ? 'no_candidate' : 'ambiguous' }
}
