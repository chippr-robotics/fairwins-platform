/**
 * Token-news read proxy routes — /v1/news/* (spec 109).
 *
 * Contract: specs/109-token-news/contracts/gateway-news-api.md.
 * Pipeline per request: killswitch -> enabled check -> param validation -> quota -> single-flight
 * cached fetch. READ-ONLY by design: there is no write route in this module, so a total news
 * outage leaves every value path intact (news is advisory-only, FR-006).
 *
 * The core honesty rule is the THREE-STATE FeedReading plus a DISTINCT honest-empty:
 * `read` with `items: []` means the vendor answered and sparse coverage is what exists;
 * `unreadable` means the read failed. The two must never look alike downstream, so this module
 * answers both as 200 bodies distinguished by `state` (one parse at the seam), while module-off
 * stays the estate's 503 `news_unconfigured` envelope.
 *
 * ASSET IDENTITY IS NOT DECIDED HERE. The curated (chainId,address)->slug mapping lives beside
 * the frontend asset registry (frontend/src/config/newsAssets.js, research R4) and arrives as an
 * explicit, shape-validated `slug` — the gateway proxies by slug and never guesses identity. A
 * garbage slug fails closed upstream to zero results (verified, research R3), so the wrong-news
 * hazard has no path through this module.
 */
import express from 'express'
import { GatewayError } from '../errors.js'
import { callerQuotaKey } from '../identity/quotaKey.js'
import { normalizeNewsResponse, SLUG_RE } from './normalize.js'

/** A cached value older than 10x TTL is treated as gone, not served — stale-as-live is dishonest. */
const STALE_FACTOR = 10

const LIMIT_MIN = 1
const LIMIT_MAX = 20
const LIMIT_DEFAULT = 8

/** chainId path segment: an EVM numeric id, or a spec-061 Bitcoin STRING id — never conflated. */
const CHAIN_SEGMENT_RE = /^(\d{1,10}|bitcoin|bitcoin-testnet)$/
/** asset path segment: lowercase token address or the literal `native`. */
const ASSET_SEGMENT_RE = /^(native|0x[0-9a-f]{40})$/

/**
 * @param {object} config loadConfig() output (reads config.news)
 * @param {{client: {newsForSlug: Function}, cache: {fetchThrough: Function}, quotas: {hit: Function}, killSwitch: {isActive: Function}, now?: () => number}} deps
 */
export function createNewsRouter(config, { client, cache, quotas, killSwitch, now = Date.now }) {
  const news = config.news
  const router = express.Router()

  function requireLive() {
    // Module killswitch first (the bitcoin/bridge/perps convention), then the global one.
    if (news.killSwitch) {
      throw new GatewayError(503, 'news_killed', 'token news is temporarily disabled; try again later')
    }
    if (killSwitch.isActive()) {
      throw new GatewayError(503, 'killswitch_active', 'the gateway is temporarily disabled; try again later')
    }
    if (!news.enabled) {
      throw new GatewayError(503, 'news_unconfigured', 'token news is not configured on this gateway')
    }
  }

  /**
   * Quota ONLY — liveness is checked separately, at the top of the handler.
   * Folding requireLive() in here and calling guard() after validation inverted the documented
   * pipeline: a killed or unconfigured module answered 400 invalid_params for a malformed
   * request, telling the caller their parameters were wrong when the truth was that the module
   * was not serving at all. Same split as bridge/routes.js.
   */
  function guard(req) {
    const q = quotas.hit(callerQuotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} news read quota exceeded`, {
        retryAfterSec: q.retryAfterSec,
      })
    }
  }

  function handleError(res, err) {
    if (err instanceof GatewayError) {
      if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
      return res.status(err.status).json(err.toBody())
    }
    return res
      .status(503)
      .json({ error: { code: 'upstream_unavailable', reason: 'token news is temporarily unavailable; try again later' } })
  }

  // ---- GET /v1/news/:chainId/:asset?slug=<tag>&limit=<n> --------------------------------------
  // chainId/asset ride for quota labelling and future server-side mapping; the SLUG is the
  // authoritative vendor key in this release (contract §path/query). The cache key is the slug:
  // news for an asset is the same for every member, so vendor load is O(distinct assets), never
  // O(members) — N concurrent viewers inside one TTL window produce exactly 1 upstream request
  // (SC-005; single-flight via cache.fetchThrough).
  router.get('/v1/news/:chainId/:asset', async (req, res) => {
    try {
      // Liveness before anything else: a killed or unconfigured module owes the caller a 503
      // saying so, never a 400 about parameters it was never going to read.
      requireLive()
      const { chainId, asset } = req.params
      if (!CHAIN_SEGMENT_RE.test(chainId)) {
        throw new GatewayError(400, 'invalid_params', 'chainId must be a numeric EVM id or a bitcoin network id')
      }
      if (!ASSET_SEGMENT_RE.test(asset)) {
        throw new GatewayError(400, 'invalid_params', 'asset must be a lowercase 0x token address or "native"')
      }
      const slug = typeof req.query.slug === 'string' ? req.query.slug : ''
      if (!SLUG_RE.test(slug)) {
        // Never proxied: a malformed slug is a caller error, and the firehose (no tag) is not a
        // member surface — the parameter is REQUIRED.
        throw new GatewayError(400, 'invalid_params', 'slug is required: 1-64 chars of [a-z0-9-]')
      }
      const rawLimit = req.query.limit === undefined ? LIMIT_DEFAULT : Number(req.query.limit)
      if (!Number.isInteger(rawLimit) || rawLimit < LIMIT_MIN || rawLimit > LIMIT_MAX) {
        throw new GatewayError(400, 'invalid_params', `limit must be an integer ${LIMIT_MIN}-${LIMIT_MAX}`)
      }
      guard(req)

      // limit is part of the key so a limit=20 answer is never truncated into a limit=8 window's
      // cache slot (and vice versa); distinct limits for one slug stay rare in practice.
      const key = `news:${slug}:${rawLimit}`
      let result
      try {
        result = await cache.fetchThrough(key, news.cacheTtlMs, () => client.newsForSlug(slug, rawLimit))
      } catch {
        // Nothing cached and the vendor did not answer: the honest answer is unreadable, as a
        // 200 body so the seam has one parse (contract §responses).
        return res.json({ state: 'unreadable', reason: 'upstream_unreachable' })
      }
      // Bounded staleness: a served-stale value past STALE_FACTOR x TTL counts as an outage —
      // stale-as-live would be dishonest, and ages on items do not excuse a stale LIST.
      if (result.stale && now() - result.fetchedAt > news.cacheTtlMs * STALE_FACTOR) {
        return res.json({ state: 'unreadable', reason: 'upstream_error' })
      }
      return res.json({
        state: 'read',
        fetchedAt: new Date(result.fetchedAt).toISOString(),
        stale: Boolean(result.stale),
        // `items: []` is a VALID, honest answer — sparse long-tail coverage is content, not
        // failure (research R3: a fail-closed slug and a quiet asset both answer []).
        items: normalizeNewsResponse(result.value),
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}

/** /status contribution (the perpsStatus convention). Config state only, no member data. */
export function newsStatus(config, { killSwitch }) {
  const news = config.news
  return {
    enabled: news.enabled,
    killed: Boolean(news.killSwitch) || killSwitch.isActive(),
    cacheTtlMs: news.cacheTtlMs,
  }
}
