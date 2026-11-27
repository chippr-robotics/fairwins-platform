/**
 * Game feed seam (spec 115) — the one place the app asks the gateway about a game.
 *
 * `GET /v1/sports/games/:gameId`. The device talks to the gateway and nothing else (FR-015). The answer is
 * sorted into exactly three outcomes, because the page treats them differently:
 *
 *   ok      a game answer (the row + envelope), to be read through gameReading.js
 *   absent  the module is off (503 sports_unconfigured / sports_paused), the gateway predates it (404), or no
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

/** The envelope may carry the row under `games` (list shape) or be the row itself; either way, ONE row. */
export function pickRow(body, gameId) {
  if (!body || typeof body !== 'object') return null
  if (Array.isArray(body.games)) {
    return body.games.find((g) => g && String(g.gameId) === String(gameId)) ?? null
  }
  return body.gameId != null && String(body.gameId) === String(gameId) ? body : null
}

export async function fetchGame(gameId, { fetchImpl } = {}) {
  const base = predictGatewayUrl()
  if (!base || gameId == null || gameId === '') return { kind: 'absent' }
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) return { kind: 'failed' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await doFetch(`${base}/v1/sports/games/${encodeURIComponent(String(gameId))}`, { signal: controller.signal })
    if (res.status === 404) return { kind: 'absent' }
    if (res.status === 503) {
      let code = null
      try {
        code = (await res.json())?.error ?? null
      } catch {
        /* a 503 with no body is an outage, not the module speaking */
      }
      // Only the module's own words mean "off". A bare 503 is a gateway/proxy outage: keep trying.
      return code === 'sports_unconfigured' || code === 'sports_paused' ? { kind: 'absent' } : { kind: 'failed' }
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
