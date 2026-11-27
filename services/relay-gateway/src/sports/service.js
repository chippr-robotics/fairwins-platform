/**
 * The sports read seam (spec 115, FR-014): everything the routes need, behind one object, so a
 * provider with a service agreement can replace the two public sources without touching the routes.
 *
 * Honesty rules held here:
 *  - EACH SOURCE FAILS ALONE AND IS NAMED (`sources.venue`, `sources.plays`); a failed source's
 *    data is omitted, never zeroed, never served stale as current.
 *  - `confirmedAt` is this gateway's clock when a source last SAID the thing: the newest frame for
 *    that game (venue) / the last successful read (plays). The socket being open confirms nothing.
 *  - An ended game is read once more and then FROZEN: no further upstream call is made for it.
 *  - A game the venue has said nothing about returns the all-null row. It is not dropped and it is
 *    not an error.
 */
import { leagueConfig } from './leagues.js'
import { matchEvent } from './match.js'
import { buildRow, emptyRow } from './normalize.js'

const MAX_FROZEN = 500

/**
 * @param {{
 *   playsEnabled: boolean, venue: ReturnType<import('./venueFeed.js').createVenueFeed>,
 *   espn: ReturnType<import('./espn.js').createEspn>, now?: () => number,
 * }} deps
 */
export function createSportsService({ playsEnabled, venue, espn, now = Date.now }) {
  /** @type {Map<number, {league: string, eventId: string, event: object, at: number, detail: object|null}>} */
  const frozen = new Map()

  function freeze(gameId, entry) {
    frozen.delete(gameId)
    frozen.set(gameId, entry)
    while (frozen.size > MAX_FROZEN) frozen.delete(frozen.keys().next().value)
  }

  /** Per-league scoreboard reads for the games that need one. One call per league per cache window. */
  async function scoreboards(leagues) {
    const out = new Map()
    await Promise.all(
      [...leagues].map(async (league) => {
        out.set(league, await espn.scoreboard(leagueConfig(league).espnPath))
      })
    )
    return out
  }

  async function collect(ids) {
    venue.touch()
    const venueState = venue.state()
    const venueByGame = new Map(ids.map((id) => [id, venue.read(id)]))

    // Which leagues need an ESPN scoreboard: covered leagues of games we have a frame for and have not frozen.
    const needed = new Set()
    if (playsEnabled) {
      for (const id of ids) {
        const v = venueByGame.get(id)
        const cfg = leagueConfig(v?.frame.league)
        if (cfg && !frozen.has(id)) needed.add(v.frame.league)
      }
    }
    const boards = needed.size > 0 ? await scoreboards(needed) : new Map()

    let playsSource
    if (!playsEnabled) playsSource = { state: 'off' }
    else if (needed.size === 0 && ![...ids].some((id) => frozen.has(id))) playsSource = { state: 'not-needed' }
    else {
      const bad = [...boards.values()].find((b) => b.state !== 'read')
      playsSource = bad ? { state: 'unreadable', reason: bad.reason } : { state: 'read' }
    }

    const matches = new Map()
    const rows = ids.map((id) => {
      const v = venueByGame.get(id)
      let play = null
      const fz = frozen.get(id)
      if (playsEnabled && fz) {
        play = { event: fz.event, at: fz.at, league: fz.league }
        matches.set(id, { state: 'matched', event: fz.event, at: fz.at, league: fz.league, frozen: true })
      } else if (playsEnabled && v) {
        const cfg = leagueConfig(v.frame.league)
        if (!cfg) matches.set(id, { state: 'not-covered' })
        else {
          const board = boards.get(v.frame.league)
          if (board?.state !== 'read') matches.set(id, { state: 'unreadable', reason: board?.reason ?? 'upstream_unreachable' })
          else {
            const m = matchEvent({ league: v.frame.league, homeCode: v.frame.homeTeam, awayCode: v.frame.awayTeam }, board.value)
            if (m.state === 'matched') {
              play = { event: m.event, at: board.fetchedAt, league: v.frame.league }
              matches.set(id, { ...m, at: board.fetchedAt, league: v.frame.league })
              if (m.event.state === 'ended') freeze(id, { league: v.frame.league, eventId: m.event.id, event: m.event, at: board.fetchedAt, detail: null })
            } else matches.set(id, m)
          }
        }
      } else if (playsEnabled) {
        matches.set(id, { state: 'not-matched', reason: 'no_identity' })
      }
      return buildRow(id, v, play)
    })

    return {
      serverNow: now(),
      sources: { venue: venueState, plays: playsSource },
      rows,
      matches,
      venueByGame,
    }
  }

  return {
    async games(ids) {
      const c = await collect(ids)
      return { serverNow: c.serverNow, sources: c.sources, games: c.rows }
    },

    async game(id) {
      const c = await collect([id])
      const row = c.rows[0] ?? emptyRow(id)
      const m = c.matches.get(id)
      let detail
      if (!playsEnabled) detail = { state: 'off' }
      else if (!m) detail = { state: 'not-matched', reason: 'no_identity' }
      else if (m.state === 'not-covered') detail = { state: 'not-covered' }
      else if (m.state === 'not-matched') detail = { state: 'not-matched', reason: m.reason }
      else if (m.state === 'unreadable') detail = { state: 'unreadable', reason: m.reason }
      else {
        const fz = frozen.get(id)
        if (fz?.detail) detail = fz.detail
        else {
          const cfg = leagueConfig(m.league)
          const ended = m.event.state === 'ended'
          // The one final read of an ended game bypasses the TTL: whatever is cached was taken while it was live.
          const sum = await espn.summary(cfg.espnPath, m.event.id, { force: ended })
          if (sum.state !== 'read') detail = { state: 'unreadable', reason: sum.reason }
          else {
            const v = c.venueByGame.get(id)
            const e = m.event
            const playScore = e.home.score != null && e.away.score != null ? { home: e.home.score, away: e.away.score } : null
            detail = {
              state: 'read',
              confirmedAt: Math.min(m.at, sum.fetchedAt),
              situation: ended ? null : e.situation,
              plays: sum.value.plays,
              behindVenue: Boolean(v?.frame.score && playScore && (v.frame.score.home !== playScore.home || v.frame.score.away !== playScore.away)),
            }
            if (ended) freeze(id, { league: m.league, eventId: e.id, event: e, at: m.at, detail })
          }
        }
      }
      return { serverNow: c.serverNow, sources: c.sources, games: [{ ...row, detail }] }
    },

    status() {
      return { frozen: frozen.size }
    },
  }
}
