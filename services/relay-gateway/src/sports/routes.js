/**
 * Live game read proxy routes — /v1/sports/* (spec 115).
 *
 * Contract: specs/115-predict-live-game-views/contracts/gateway-sports-api.md.
 * Pipeline per request (the news convention): liveness -> param validation -> quota -> read.
 * READ-ONLY by design: no write route exists here, nothing is signed, and no value path consults
 * it (advisory-only, FR-010). Module off => 503 sports_unconfigured; module killswitch => 503
 * sports_paused; the app treats both, and a 404 from an older gateway, as "no game view" (FR-013).
 */
import express from 'express'
import { GatewayError } from '../errors.js'
import { callerQuotaKey } from '../identity/quotaKey.js'

const MAX_IDS = 10
const ID_RE = /^[1-9]\d{0,11}$/
const LEAGUE_RE = /^[a-z0-9][a-z0-9 .&-]{0,31}$/
const CODE_RE = /^[A-Z0-9]{2,5}$/
const START_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/

/**
 * The optional identity claim on the detail route (`league`, `home`, `away`, `start`). Shape-validated and
 * request-scoped: it is handed to the service for THIS call only and is never stored. A well-formed league
 * the gateway has no play source for is not a 400 — it is `not-covered`, like a game the venue named.
 * Returns null when no claim field is present; throws when the claim is partial or malformed.
 */
export function parseClaim(query) {
  const { league, home, away, start } = query
  if (league === undefined && home === undefined && away === undefined && start === undefined) return null
  const bad = () => new GatewayError(400, 'invalid_params', 'league, home and away must be given together: league [a-z0-9 .&-], team codes [A-Z0-9]{2,5}, start an ISO time')
  if (![league, home, away].every((v) => typeof v === 'string')) throw bad()
  if (!LEAGUE_RE.test(league) || !CODE_RE.test(home) || !CODE_RE.test(away)) throw bad()
  let startMs = null
  if (start !== undefined) {
    if (typeof start !== 'string' || !START_RE.test(start) || !Number.isFinite(Date.parse(start))) throw bad()
    startMs = Date.parse(start)
  }
  return { league, home, away, startMs }
}

/**
 * @param {object} config loadConfig() output (reads config.sports)
 * @param {{service: {games: Function, game: Function}, quotas: {hit: Function}, killSwitch: {isActive: Function}}} deps
 */
export function createSportsRouter(config, { service, quotas, killSwitch }) {
  const sports = config.sports
  const router = express.Router()

  function requireLive() {
    if (sports.killSwitch) throw new GatewayError(503, 'sports_paused', 'live game views are temporarily paused; try again later')
    if (killSwitch.isActive()) throw new GatewayError(503, 'killswitch_active', 'the gateway is temporarily disabled; try again later')
    if (!sports.enabled) throw new GatewayError(503, 'sports_unconfigured', 'live game views are not configured on this gateway')
  }

  function guard(req) {
    const q = quotas.hit(callerQuotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} sports read quota exceeded`, { retryAfterSec: q.retryAfterSec })
    }
  }

  function handleError(res, err) {
    if (err instanceof GatewayError) {
      if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
      return res.status(err.status).json(err.toBody())
    }
    // The service is total over source failures (they become `unreadable`), so this is a bug, not an outage of a source.
    return res.status(503).json({ error: { code: 'upstream_unavailable', reason: 'live game views are temporarily unavailable; try again later' } })
  }

  router.get('/v1/sports/games', async (req, res) => {
    try {
      requireLive()
      const raw = typeof req.query.ids === 'string' ? req.query.ids : ''
      const parts = raw.split(',')
      if (raw === '' || parts.length > MAX_IDS || !parts.every((p) => ID_RE.test(p))) {
        throw new GatewayError(400, 'invalid_params', `ids must be 1-${MAX_IDS} comma-separated positive integers`)
      }
      const ids = [...new Set(parts.map(Number))]
      guard(req)
      res.json(await service.games(ids))
    } catch (err) {
      handleError(res, err)
    }
  })

  router.get('/v1/sports/games/:gameId', async (req, res) => {
    try {
      requireLive()
      if (!ID_RE.test(req.params.gameId)) throw new GatewayError(400, 'invalid_params', 'gameId must be a positive integer')
      const claim = parseClaim(req.query)
      guard(req)
      res.json(await service.game(Number(req.params.gameId), claim))
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}

/** /status contribution (the newsStatus convention). Config state only, no member data. */
export function sportsStatus(config, { killSwitch, venue, service }) {
  const s = config.sports
  return {
    enabled: s.enabled,
    killed: Boolean(s.killSwitch) || killSwitch.isActive(),
    playsEnabled: s.enabled ? s.playsEnabled : false,
    scoreboardTtlMs: s.scoreboardTtlMs,
    summaryTtlMs: s.summaryTtlMs,
    idleCloseMs: s.idleCloseMs,
    // Live state of the one upstream socket (counts and times only — no game content).
    venue: s.enabled ? venue.status() : null,
    frozenGames: s.enabled ? service.status().frozen : null,
  }
}
