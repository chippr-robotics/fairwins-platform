/**
 * Alphaday HTTP client for the /v1/news/* read proxy (spec 109).
 *
 * Mirrors src/perps/client.js: a thin fetch adapter with a bounded timeout, an injectable
 * fetchImpl for tests, and retries on 5xx/429 for READS only — the module has no write anywhere,
 * so every request is idempotent and safe to retry.
 *
 * KEYLESS BY DESIGN: the vendor's API is public and unauthenticated (research R1 — verified by
 * live probe 2026-09-06). No credential exists in this module, and none may be added without
 * spec-097 registry work; the absence is load-bearing.
 */
import { stripTrailingSlashes } from '../strings.js'

/** Vendor unreachable / persistent 5xx / upstream 429 — the feed degrades, never invents. */
export class NewsUpstreamError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'NewsUpstreamError'
    this.cause = cause
  }
}

/**
 * @param {{baseUrl: string, timeoutMs?: number, retries?: number, fetchImpl?: typeof fetch}} opts
 */
export function createNewsClient({ baseUrl, timeoutMs = 8000, retries = 1, fetchImpl = fetch }) {
  const base = stripTrailingSlashes(baseUrl)

  async function get(path, query = {}) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''))
    const url = `${base}${path}${qs.size > 0 ? `?${qs}` : ''}`
    let lastErr
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        })
        if (res.ok) return await res.json()
        // The vendor's 4xx and 5xx alike degrade to `unreadable` at the route: the slug is
        // shape-validated before it leaves the gateway, so a non-ok answer is an upstream
        // condition, not a member error. Only 5xx/429 are worth a retry; a definitive 4xx is not.
        lastErr = new NewsUpstreamError(`news vendor returned ${res.status}`)
        if (!(res.status >= 500 || res.status === 429)) break
      } catch (e) {
        lastErr = new NewsUpstreamError('news vendor unreachable', e)
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastErr
  }

  return {
    /**
     * Fetch recent items for one tag slug. The slug is REQUIRED — the untagged firehose is not a
     * member surface (research R3) and this client deliberately has no way to request it.
     *
     * @param {string} slug validated tag slug
     * @param {number} limit 1–20
     */
    async newsForSlug(slug, limit) {
      return get('/items/news/', { tags: slug, limit: String(limit) })
    },
  }
}
