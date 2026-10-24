/**
 * The ONE client seam for token news (spec 109) — every news surface consumes the FeedReading
 * this returns and invents nothing (data-model.md).
 *
 * Reading states (only `read` carries items — the spec-089 reading.js device):
 *   { state: 'read', items, fetchedAt, stale }      vendor answered; items MAY be [] (honest-empty)
 *   { state: 'not-covered' }                        no curated mapping — resolved locally with
 *                                                   ZERO network cost (contract §frontend seam)
 *   { state: 'unreadable', reason }                 the read failed → sentence + retry
 *   { state: 'not-configured' }                     module/gateway off, or the gateway image
 *                                                   predates the module (404) → surface is absent
 */
import { newsSlugFor } from '../../config/newsAssets'

/** Gateway base URL — the perps convention: unset means news is not configured for this build. */
export function newsGatewayUrl() {
  return (import.meta.env.VITE_RELAYER_URL || '').trim().replace(/\/$/, '')
}

/**
 * Fetch recent news for one platform asset through the gateway. NEVER calls the vendor directly —
 * it has no CORS (research R2), and identity is resolved here from the curated mapping before any
 * network is touched.
 *
 * @param {{chainId: number|string, address?: string|null, limit?: number, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<object>} a FeedReading
 */
export async function fetchTokenNews({ chainId, address = null, limit = 8, fetchImpl = fetch } = {}) {
  const slug = newsSlugFor({ chainId, address })
  if (slug == null) return { state: 'not-covered' }

  const base = newsGatewayUrl()
  if (base === '') return { state: 'not-configured' }

  const asset = address == null || address === 'native' ? 'native' : String(address).toLowerCase()
  const url = `${base}/v1/news/${chainId}/${asset}?slug=${encodeURIComponent(slug)}&limit=${limit}`
  let res
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' } })
  } catch {
    return { state: 'unreadable', reason: 'gateway_unreachable' }
  }
  if (res.status === 503) {
    // news_unconfigured / killswitch — the SPA hides the surface rather than showing a failure
    // the member cannot act on. Other gateway envelopes (429, 400) read as unreadable + retry.
    let code = ''
    try {
      code = (await res.json())?.error?.code ?? ''
    } catch {
      /* body shape is advisory here */
    }
    return code === 'news_unconfigured' || code === 'news_killed' || code === 'killswitch_active'
      ? { state: 'not-configured' }
      : { state: 'unreadable', reason: 'gateway_error' }
  }
  if (res.status === 404) {
    /*
     * The route does not exist on this gateway, which means the IMAGE predates the news module —
     * not that a read failed. The module mounts unconditionally (routes.js), so on any image that
     * carries it `/v1/news/*` answers 503 when switched off and never 404s; a 404 is therefore
     * unambiguous, and the honest reading is absence.
     *
     * This matters because the SPA and the gateway deploy INDEPENDENTLY. The news card ships with
     * the frontend, while the module only arrives when the gateway image is rebuilt and re-pinned
     * (infra/vm/gateway/docker-compose.yml). Without this branch, any window where the SPA is
     * ahead puts "The news feed could not be read right now." plus a Retry on every asset sheet
     * and every trade pair — an error the member cannot act on, for a surface that is simply not
     * there yet. Absence renders nothing, which is what the spec asks for.
     */
    return { state: 'not-configured' }
  }
  if (!res.ok) return { state: 'unreadable', reason: 'gateway_error' }

  let body
  try {
    body = await res.json()
  } catch {
    return { state: 'unreadable', reason: 'bad_response' }
  }
  // Pass the gateway's reading through without invention: `read` keeps its items (possibly []),
  // `unreadable` keeps its reason. An unknown state is unreadable, never fabricated content.
  if (body?.state === 'read' && Array.isArray(body.items)) {
    return { state: 'read', items: body.items, fetchedAt: body.fetchedAt ?? null, stale: Boolean(body.stale) }
  }
  if (body?.state === 'unreadable') return { state: 'unreadable', reason: body.reason ?? 'upstream_error' }
  return { state: 'unreadable', reason: 'bad_response' }
}
