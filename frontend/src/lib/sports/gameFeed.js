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
 * the app (SC-006).
 */
import { predictGatewayUrl } from '../predict/predictClient'

export const POLL_MS = 5_000
export const PRE_START_POLL_MS = 30_000
const FETCH_TIMEOUT_MS = 8_000

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

const OFF_CODES = new Set(['sports_unconfigured', 'sports_paused', 'killswitch_active'])

export async function fetchGame(gameId, { identity = {}, fetchImpl } = {}) {
  const base = predictGatewayUrl()
  if (!base || gameId == null || gameId === '') return { kind: 'absent' }
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) return { kind: 'failed' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const qs = new URLSearchParams(identity).toString()
    const res = await doFetch(`${base}/v1/sports/games/${encodeURIComponent(String(gameId))}${qs ? `?${qs}` : ''}`, { signal: controller.signal })
    if (res.status === 404) return { kind: 'absent' }
    if (res.status === 503) {
      let code = null
      try {
        code = (await res.json())?.error?.code ?? null
      } catch {
        /* a 503 with no body is an outage, not the module speaking */
      }
      // Only the module's own words mean "off". A bare 503 is a gateway/proxy outage: keep trying.
      return OFF_CODES.has(code) ? { kind: 'absent' } : { kind: 'failed' }
    }
    if (!res.ok) return { kind: 'failed' }
    const body = await res.json()
    const row = pickRow(body, gameId)
    if (!row || !Number.isFinite(body.serverNow ?? NaN)) return { kind: 'failed' }
    return { kind: 'ok', row, serverNow: body.serverNow, sources: body.sources ?? null, detail: row.detail ?? body.detail ?? null }
  } catch {
    return { kind: 'failed' }
  } finally {
    clearTimeout(timer)
  }
}
