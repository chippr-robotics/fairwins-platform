/**
 * Vendor item → NewsItem normalizer for the /v1/news/* read proxy (spec 109).
 *
 * Field provenance is documented per field (the spec-082 normalizer rule: a mis-attributed or
 * mis-shaped field is a fabricated fact, so every mapping names its source). Input shape was
 * captured from the LIVE Alphaday `/items/news/?tags=<slug>` payload on 2026-09-06 (research R3);
 * do not "fix" a mapping without re-verifying against the live API.
 *
 * Deliberate drops (data-model.md):
 *   image, source.icon  — third-party image origins; items render as TEXT only (FR-005)
 *   author              — frequently the literal string "None" upstream; attribution is the source
 *   hash, is_bookmarked, is_liked, likes — vendor-account concepts FairWins does not have
 *   sentiment_score     — a precision the UI must not imply; the coarse label is forwarded as data
 */

/** An item must be linkable over https and honestly ageable, or it is dropped entirely. */
function usableUrl(url) {
  if (typeof url !== 'string') return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

function usableDate(iso) {
  if (typeof iso !== 'string' || iso === '') return false
  return Number.isFinite(Date.parse(iso))
}

/**
 * Normalize one vendor news item. Returns null for an item that cannot be rendered honestly
 * (non-https url, or a missing/unparsable publication date — an undated item cannot carry the
 * mandatory age display, FR-001).
 *
 * @param {any} raw one entry of the vendor's `results` array
 * @returns {null | {id: string, title: string, url: string, source: {name: string, slug: string}, publishedAt: string, sentiment: number | null}}
 */
export function normalizeNewsItem(raw) {
  if (raw == null || typeof raw !== 'object') return null
  if (typeof raw.title !== 'string' || raw.title.trim() === '') return null
  if (!usableUrl(raw.url)) return null
  if (!usableDate(raw.published_at)) return null
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {}
  // sentiment: vendor serves -1 | 0 | 1 | null (research R3). Anything else forwards as null —
  // an uninterpretable label is absent, never coerced.
  const sentiment = raw.sentiment === -1 || raw.sentiment === 0 || raw.sentiment === 1 ? raw.sentiment : null
  return {
    id: String(raw.id ?? ''), // vendor `id`; opaque, used for keys/dedupe only
    title: raw.title, // vendor `title`; rendered as plain text, never markup (FR-005)
    url: raw.url, // vendor `url`; the ONLY interaction — external link-out with attribution
    source: {
      name: typeof source.name === 'string' ? source.name : '', // vendor `source.name` — the attribution line
      slug: typeof source.slug === 'string' ? source.slug : '', // vendor `source.slug` — stable id for the source
    },
    publishedAt: raw.published_at, // vendor `published_at` (ISO-8601 Z) — drives the mandatory age display
    sentiment,
  }
}

/**
 * Normalize a vendor news response to the item list. Items that cannot be rendered honestly are
 * dropped rather than patched — a `read` answer with fewer items is honest; an item with an
 * invented date or a non-https link is not.
 *
 * @param {any} payload the vendor's `/items/news/` response body
 * @returns {Array<NonNullable<ReturnType<typeof normalizeNewsItem>>>}
 */
export function normalizeNewsResponse(payload) {
  const results = payload && Array.isArray(payload.results) ? payload.results : []
  return results.map(normalizeNewsItem).filter((item) => item !== null)
}

/** Tag slugs are the vendor's asset key: lowercase kebab, bounded (contract, FR-004 transport). */
export const SLUG_RE = /^[a-z0-9-]{1,64}$/
