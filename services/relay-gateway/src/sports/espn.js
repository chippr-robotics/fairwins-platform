/**
 * ESPN site API client (spec 115, source `plays`): the scoreboard (identity + score cross-check +
 * situation) and the per-game summary (plays). Public, keyless, and with no service agreement.
 *
 * Load is a function of games being VIEWED, never of members (FR-015/016):
 *  - there is NO background polling. Every upstream call is made on behalf of a request, so a game
 *    nobody asks about is not polled by construction;
 *  - scoreboard cache >= 10 s per league, summary cache >= 5 s per game, both single-flight:
 *    N concurrent requests inside one window make exactly ONE upstream call;
 *  - a FAILED read is cached for the same window (a failing upstream is not hammered by a viewer
 *    polling every few seconds), and a failure never serves the previous value as if current:
 *    the caller gets `unreadable` and omits the source's data.
 *  - every fetch is deadline-bounded.
 * The fetch is GET-only against fixed paths built from the league table and an id that was
 * validated as digits; nothing a member typed reaches the URL.
 */
import { stripTrailingSlashes } from '../strings.js'

const SCOREBOARD_FLOOR_MS = 10_000
const SUMMARY_FLOOR_MS = 5_000
const MAX_SUMMARIES = 200

export class EspnUpstreamError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'EspnUpstreamError'
    this.cause = cause
  }
}

/**
 * @param {{
 *   baseUrl: string, timeoutMs?: number, scoreboardTtlMs?: number, summaryTtlMs?: number,
 *   fetchImpl?: typeof fetch, now?: () => number,
 *   parseScoreboard: (body: unknown) => object[], parseSummary: (body: unknown) => object,
 * }} opts
 */
export function createEspn({
  baseUrl,
  timeoutMs = 6000,
  scoreboardTtlMs = SCOREBOARD_FLOOR_MS,
  summaryTtlMs = SUMMARY_FLOOR_MS,
  fetchImpl = fetch,
  now = Date.now,
  parseScoreboard,
  parseSummary,
}) {
  const base = stripTrailingSlashes(baseUrl)
  const sbTtl = Math.max(scoreboardTtlMs, SCOREBOARD_FLOOR_MS)
  const sumTtl = Math.max(summaryTtlMs, SUMMARY_FLOOR_MS)
  /** @type {Map<string, {at: number, result: object|null, inflight: Promise<object>|null}>} */
  const sbCache = new Map()
  const sumCache = new Map()
  let upstreamCalls = 0

  async function getJson(url) {
    upstreamCalls += 1
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal })
      if (!res.ok) throw new EspnUpstreamError(`espn returned ${res.status}`)
      return await res.json()
    } catch (e) {
      throw e instanceof EspnUpstreamError ? e : new EspnUpstreamError('espn unreachable', e)
    } finally {
      clearTimeout(timer)
    }
  }

  /** One cache slot, single-flight, failures cached for the same window. Never throws. */
  async function through(map, key, ttl, loader, { force = false } = {}) {
    const slot = map.get(key)
    if (slot?.result && !force && now() - slot.at < ttl) return slot.result
    if (slot?.inflight) return slot.inflight
    const entry = slot ?? { at: 0, result: null, inflight: null }
    entry.inflight = (async () => {
      let result
      try {
        const value = await loader()
        result = { state: 'read', fetchedAt: now(), value }
      } catch (e) {
        // The reason names the condition, never the upstream's body or URL.
        result = { state: 'unreadable', reason: e instanceof EspnUpstreamError && /returned/.test(e.message) ? 'upstream_error' : 'upstream_unreachable', fetchedAt: now() }
      }
      entry.at = now()
      entry.result = result
      entry.inflight = null
      return result
    })()
    map.set(key, entry)
    return entry.inflight
  }

  return {
    /** `{state:'read', fetchedAt, value: event[]}` or `{state:'unreadable', reason}`. */
    scoreboard(espnPath) {
      return through(sbCache, espnPath, sbTtl, async () => parseScoreboard(await getJson(`${base}/${espnPath}/scoreboard`)))
    },
    /** `eventId` must already be digits-only. `force` bypasses the TTL (the one final read of an ended game). */
    summary(espnPath, eventId, opts = {}) {
      const key = `${espnPath}:${eventId}`
      const p = through(sumCache, key, sumTtl, async () => parseSummary(await getJson(`${base}/${espnPath}/summary?event=${eventId}`)), opts)
      while (sumCache.size > MAX_SUMMARIES) sumCache.delete(sumCache.keys().next().value)
      return p
    },
    stats() {
      return { upstreamCalls, scoreboardsCached: sbCache.size, summariesCached: sumCache.size }
    },
  }
}
