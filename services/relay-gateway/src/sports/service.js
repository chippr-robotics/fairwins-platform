/**
 * The sports read seam (spec 115, FR-014): everything the routes need, behind one object, so a
 * provider with a service agreement can replace the two public sources without touching the routes.
 *
 * Honesty rules held here:
 *  - EACH SOURCE FAILS ALONE AND IS NAMED (`sources.venue`, `sources.plays`, each with its display
 *    `label`); a failed source's data is omitted, never zeroed, never served stale as current.
 *  - WHOSE FIGURES: the play source's where it was read and matched, else the venue's, else null
 *    (`source`). `confirmedAt` is this gateway's clock when THAT source last said the thing.
 *  - An ended game is read once more and then FROZEN: no further upstream call is made for it.
 *
 * WHAT A DEVICE CAN INFLUENCE (an identity claim on the detail route): nothing that outlives the
 * request. A claim is used only while the venue has not named the game, and every map below is keyed
 * by something a device cannot choose:
 *   - `frozen`      — keyed by the PLAY SOURCE's own event id (`league:eventId`, both from ESPN's answer);
 *   - `identified`  — gameId -> event key, written ONLY from a venue frame's identity, never from a claim;
 *   - the espn.js scoreboard/summary caches — keyed by the league table's path and ESPN's event ids.
 * So a wrong claim can change what ITS OWN request gets, never what another request for the same gameId gets.
 */
import { leagueConfig } from './leagues.js'
import { matchEvent } from './match.js'
import { buildRow, emptyRow } from './normalize.js'

const MAX_FROZEN = 500
const MAX_IDENTIFIED = 2000
export const SOURCE_LABELS = Object.freeze({ venue: 'Polymarket', plays: 'ESPN' })

/**
 * @param {{
 *   playsEnabled: boolean, venue: ReturnType<import('./venueFeed.js').createVenueFeed>,
 *   espn: ReturnType<import('./espn.js').createEspn>, now?: () => number,
 * }} deps
 */
export function createSportsService({ playsEnabled, venue, espn, now = Date.now }) {
  /** @type {Map<string, {league: string, event: object, at: number, detail: object|null}>} */
  const frozen = new Map()
  /** @type {Map<number, string>} gameId -> frozen key; ONLY ever set from a venue-named identity */
  const identified = new Map()

  const eventKey = (league, eventId) => `${league}:${eventId}`
  const bound = (map, max) => {
    while (map.size > max) map.delete(map.keys().next().value)
  }
  function freeze(key, entry) {
    frozen.delete(key)
    frozen.set(key, entry)
    bound(frozen, MAX_FROZEN)
  }

  async function scoreboards(leagues) {
    const out = new Map()
    await Promise.all([...leagues].map(async (league) => out.set(league, await espn.scoreboard(leagueConfig(league).espnPath))))
    return out
  }

  /**
   * Who is this game? The venue's own frame, when it has spoken (`from: 'venue'`); else the request's
   * claim for THIS request only (`from: 'claim'`); else nobody.
   */
  function identityOf(v, claim) {
    if (v) return { from: 'venue', league: v.frame.league, homeCode: v.frame.homeTeam, awayCode: v.frame.awayTeam, startMs: null }
    if (claim) return { from: 'claim', league: claim.league, homeCode: claim.home, awayCode: claim.away, startMs: claim.startMs ?? null }
    return null
  }

  async function collect(ids, claims = new Map()) {
    venue.touch()
    const venueState = venue.state()
    const venueByGame = new Map(ids.map((id) => [id, venue.read(id)]))
    const identity = new Map(ids.map((id) => [id, identityOf(venueByGame.get(id), claims.get(id))]))

    // A game the VENUE once named, whose event was frozen, needs no scoreboard at all. `identified` can only
    // have been written from a venue frame, so reading it here is safe whatever this request claims.
    const frozenFor = (id) => {
      const k = identified.get(id)
      return k ? frozen.get(k) : null
    }

    const needed = new Set()
    if (playsEnabled) {
      for (const id of ids) {
        const idn = identity.get(id)
        if (idn && leagueConfig(idn.league) && !frozenFor(id)) needed.add(idn.league)
      }
    }
    const boards = needed.size > 0 ? await scoreboards(needed) : new Map()

    let playsSource
    if (!playsEnabled) playsSource = { state: 'off' }
    else if (needed.size === 0 && !ids.some((id) => frozenFor(id))) playsSource = { state: 'not-needed' }
    else {
      const bad = [...boards.values()].find((b) => b.state !== 'read')
      playsSource = bad ? { state: 'unreadable', reason: bad.reason } : { state: 'read' }
    }

    const matches = new Map()
    const rows = ids.map((id) => {
      const v = venueByGame.get(id)
      const idn = identity.get(id)
      let play = null
      const fz = frozenFor(id)
      if (playsEnabled && fz) {
        play = { event: fz.event, at: fz.at, league: fz.league }
        matches.set(id, { state: 'matched', event: fz.event, at: fz.at, league: fz.league })
      } else if (playsEnabled && idn) {
        if (!leagueConfig(idn.league)) matches.set(id, { state: 'not-covered' })
        else {
          const board = boards.get(idn.league)
          if (board?.state !== 'read') matches.set(id, { state: 'unreadable', reason: board?.reason ?? 'upstream_unreachable' })
          else {
            const m = matchEvent({ league: idn.league, homeCode: idn.homeCode, awayCode: idn.awayCode, startMs: idn.startMs }, board.value)
            if (m.state === 'matched') {
              const key = eventKey(idn.league, m.event.id)
              const known = frozen.get(key)
              // A game frozen under its event key (possibly by another request) is served as it was frozen.
              const event = known?.event ?? m.event
              const at = known?.at ?? board.fetchedAt
              play = { event, at, league: idn.league }
              matches.set(id, { state: 'matched', event, at, league: idn.league, key })
              if (event.state === 'ended' && !known) freeze(key, { league: idn.league, event, at, detail: null })
              if (idn.from === 'venue' && event.state === 'ended') {
                identified.delete(id)
                identified.set(id, key)
                bound(identified, MAX_IDENTIFIED)
              }
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
      sources: {
        venue: { ...venueState, label: SOURCE_LABELS.venue },
        plays: { ...playsSource, label: SOURCE_LABELS.plays },
      },
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

    /** @param {{league: string, home: string, away: string, startMs?: number|null}|null} claim request-scoped identity */
    async game(id, claim = null) {
      const c = await collect([id], claim ? new Map([[id, claim]]) : new Map())
      const row = c.rows[0] ?? emptyRow(id)
      const m = c.matches.get(id)
      let detail
      if (!playsEnabled) detail = { state: 'off' }
      else if (!m) detail = { state: 'not-matched', reason: 'no_identity' }
      else if (m.state === 'not-covered') detail = { state: 'not-covered' }
      else if (m.state === 'not-matched') detail = { state: 'not-matched', reason: m.reason }
      else if (m.state === 'unreadable') detail = { state: 'unreadable', reason: m.reason }
      else {
        const key = eventKey(m.league, m.event.id)
        const fz = frozen.get(key)
        if (fz?.detail) detail = fz.detail
        else {
          const cfg = leagueConfig(m.league)
          const ended = m.event.state === 'ended'
          // The one final read of an ended game bypasses the TTL: whatever is cached was taken while it was live.
          const sum = await espn.summary(cfg.espnPath, m.event.id, { force: ended })
          if (sum.state !== 'read') detail = { state: 'unreadable', reason: sum.reason }
          else {
            detail = {
              state: 'read',
              confirmedAt: Math.min(m.at, sum.fetchedAt),
              situation: ended ? null : m.event.situation,
              plays: sum.value.plays,
            }
            if (ended) freeze(key, { league: m.league, event: m.event, at: m.at, detail })
          }
        }
      }
      // The plays source failed (here: its summary), so none of its figures are shown: the row falls back to the venue (contract).
      const finalRow = detail.state === 'unreadable' && row.source === 'plays' ? buildRow(id, c.venueByGame.get(id), null) : row
      return { serverNow: c.serverNow, sources: c.sources, games: [{ ...finalRow, detail }] }
    },

    status() {
      return { frozen: frozen.size, identified: identified.size }
    },
  }
}
