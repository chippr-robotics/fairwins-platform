/**
 * Game feed seam (spec 115) — the one place the app asks the gateway about a game.
 *
 * `GET /v1/sports/games/:gameId`. The device talks to the gateway and nothing else (FR-015). The answer is
 * sorted into exactly three outcomes, because the page treats them differently:
 *
 *   ok      a game answer (the row + envelope), to be read through gameReading.js
 *   absent  the module is off (503 sports_unconfigured / sports_paused / killswitch_active), the gateway predates it (404), or no
 *           gateway is configured at all — the page draws NOTHING and does not ask again (FR-013)
 *   failed  a transport failure, a timeout, a 5xx that is not the module's own, or an answer that is not a
 *           game — keep what is on screen and let it age; never replace it with zeros
 *
 * No request is made when no gateway is configured, so with the module off no request for game data leaves
 * the app (SC-006). The shared in-flight / remembered-absence machinery lives in sportsRead.js.
 */
import { createSportsReader } from './sportsRead'

export const POLL_MS = 5_000
export const PRE_START_POLL_MS = 30_000

/** The cadence for the next read, or null to stop. Ended is final; before the start is slow. */
export function cadenceMs(status) {
  if (status === 'ended') return null
  if (status === 'scheduled' || status == null) return PRE_START_POLL_MS
  return POLL_MS
}

/** The envelope is `{ serverNow, sources, games: [row] }` and nothing else (contract pinned). ONE row for the id. */
export function pickRow(body, gameId) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.games)) return null
  return body.games.find((g) => g && String(g.gameId) === String(gameId)) ?? null
}

/**
 * The game's identity from the event listing, for the play source to match before the venue's feed has named
 * the game: { league, home, away (team codes) [, start] }. All three of league/home/away or none; `start` is
 * optional beside them and never sent alone. A `teams`-only listing sends NONE.
 */
export function identityOf(game) {
  if (!game || typeof game !== 'object') return {}
  const code = (t) => (typeof t?.code === 'string' && /^[A-Z0-9]{2,5}$/.test(t.code) ? t.code : null)
  const league = typeof game.league === 'string' && game.league !== '' ? game.league : null
  const home = code(game.home)
  const away = code(game.away)
  // The gateway answers 400 to a PARTIAL claim: league, home and away go together or not at all, and
  // `start` rides only alongside them, never alone.
  if (!league || !home || !away) return {}
  const start = typeof game.startTime === 'string' && Number.isFinite(Date.parse(game.startTime)) ? game.startTime : null
  return start ? { league, home, away, start } : { league, home, away }
}

// Each feed has its OWN reader, so what one remembers never stops the other asking.
const reader = createSportsReader({ rememberCodes: ['sports_unconfigured'] })

export const __resetGameFeedForTests = () => reader.reset()

export function fetchGame(gameId, { identity = {}, fetchImpl } = {}) {
  if (gameId == null || gameId === '') return Promise.resolve({ kind: 'absent' })
  const qs = new URLSearchParams(identity).toString()
  return reader.read(`/v1/sports/games/${encodeURIComponent(String(gameId))}${qs ? `?${qs}` : ''}`, {
    fetchImpl,
    parse: (body) => {
      const row = pickRow(body, gameId)
      if (!row || !Number.isFinite(body.serverNow ?? NaN)) return null
      return { row, serverNow: body.serverNow, sources: body.sources ?? null, detail: row.detail ?? body.detail ?? null }
    },
  })
}
