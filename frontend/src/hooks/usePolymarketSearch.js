import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { getNetwork, getCurrentChainId } from '../config/networks'
import logger from '../utils/logger'

const DEFAULT_SEARCH_LIMIT = 10
const DEFAULT_BROWSE_LIMIT = 12
const DEFAULT_GAMMA_BASE = 'https://gamma-api.polymarket.com'

// Verified Polymarket Gamma tag ids for the user-facing category chips.
// (See specs/013-polymarket-search-filter/research.md, Decision 3.)
const CATEGORY_TAG_IDS = {
  politics: '2',
  sports: '1',
  crypto: '21',
  'pop-culture': '596',
  business: '107',
  tech: '1401',
}

// Memoised slug -> numeric tag id, seeded with the verified ids above. Unseeded
// slugs are resolved once via /tags/slug/{slug} and cached.
const tagIdCache = new Map(Object.entries(CATEGORY_TAG_IDS))

function apiBaseFor(chainId) {
  const network = getNetwork(chainId)
  return network?.polymarket?.gammaApiUrl || DEFAULT_GAMMA_BASE
}

function trimBase(base) {
  return base.replace(/\/$/, '')
}

/**
 * Resolve a category slug to its numeric Gamma tag id. Returns the seeded id
 * synchronously when known; otherwise fetches `/tags/slug/{slug}` once and
 * caches it. Returns null when the slug cannot be resolved (so it applies no
 * filter rather than silently widening results).
 */
export async function ensureCategoryTagId(apiBase, slug) {
  if (!slug) return null
  if (tagIdCache.has(slug)) return tagIdCache.get(slug)
  try {
    const res = await fetch(`${trimBase(apiBase)}/tags/slug/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const tag = await res.json()
    const id = tag?.id != null ? String(tag.id) : null
    if (id) tagIdCache.set(slug, id)
    return id
  } catch (err) {
    logger.warn?.('[ensureCategoryTagId] failed:', err)
    return null
  }
}

/** Synchronous lookup of a seeded category tag id (null when unseeded). */
export function resolveCategoryTagId(slug) {
  return tagIdCache.get(slug) || null
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * Normalise a Gamma market object into the shape the picker/linked-market form
 * consumes. `label` is the short per-sub-market title used when an event is
 * expanded (e.g. "Spain"), falling back to the full question.
 */
export function normaliseGammaMarket(m) {
  const names = parseJsonArray(m.outcomes) || []
  const prices = parseJsonArray(m.outcomePrices) || []
  const outcomes = names.map((name, i) => ({
    name,
    price: prices[i] != null ? Number(prices[i]) : null,
  }))

  const question = m.question || m.title || m.name || ''
  return {
    id: m.id ?? m.marketId ?? null,
    slug: m.slug || null,
    question,
    label: m.groupItemTitle || question,
    description: m.description || '',
    conditionId: m.conditionId || m.condition_id || null,
    endDate: m.endDate || m.end_date_iso || null,
    volume: m.volume != null ? Number(m.volume) : null,
    liquidity: m.liquidity != null ? Number(m.liquidity) : null,
    active: m.active !== false,
    closed: m.closed === true,
    image: m.image || m.icon || null,
    outcomes,
  }
}

/**
 * A market's resolution must be in the future to be wagerable. Markets with a
 * missing or unparseable end date are treated as ineligible — we can't confirm
 * they're still open, and the wager form needs a settlement date.
 */
function endsInFuture(endDate) {
  if (!endDate) return false
  const t = Date.parse(endDate)
  return Number.isFinite(t) && t > Date.now()
}

/**
 * A market may back a wager only if it is active, unresolved, has a condition id,
 * and ends in the future (so users can't pick an event that has already passed).
 */
function isEligibleMarket(m) {
  return Boolean(m.conditionId) && m.active === true && m.closed !== true && endsInFuture(m.endDate)
}

/**
 * Group a Gamma event and its nested markets into a NormalizedEvent, keeping
 * only eligible child markets (sorted by volume). Returns null when the event
 * has no eligible markets, so empty events are dropped entirely.
 * (See specs/013-polymarket-search-filter/data-model.md.)
 */
export function normaliseGammaEvent(ev) {
  if (!ev || typeof ev !== 'object') return null
  const children = (Array.isArray(ev.markets) ? ev.markets : [])
    .map(normaliseGammaMarket)
    .filter(isEligibleMarket)
  if (children.length === 0) return null
  children.sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))

  const tags = Array.isArray(ev.tags) ? ev.tags : []
  return {
    id: String(ev.id ?? ev.slug ?? children[0].conditionId),
    title: ev.title || ev.question || children[0].question || '',
    slug: ev.slug || null,
    category: tags[0]?.label || null,
    tagIds: tags.map((t) => (t?.id != null ? String(t.id) : null)).filter(Boolean),
    volume: ev.volume != null ? Number(ev.volume) : null,
    image: ev.image || ev.icon || null,
    markets: children,
  }
}

function eventsFromPayload(data) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.events)) return data.events
  if (Array.isArray(data?.data)) return data.data
  return []
}

/** Stable key for a categories array so effects don't loop on new references. */
function categoriesKeyOf(categories) {
  return Array.isArray(categories) ? categories.slice().sort().join(',') : ''
}

/**
 * Search Polymarket events by free text via the Gamma `/public-search` endpoint,
 * optionally constrained to selected categories. Results are returned grouped by
 * event (each event holds its eligible child markets), relevance-ordered.
 *
 * Usage:
 *   const { results, isLoading, error, runSearch, clear } =
 *     usePolymarketSearch({ limit, categories: ['sports'] })
 */
export function usePolymarketSearch({ limit = DEFAULT_SEARCH_LIMIT, categories = [] } = {}) {
  const wagmiChainId = useWalletChainId()
  const chainId = wagmiChainId || getCurrentChainId()
  const apiBase = apiBaseFor(chainId)
  const catKey = categoriesKeyOf(categories)

  const [results, setResults] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [lastQuery, setLastQuery] = useState('')

  const abortRef = useRef(null)

  // Seeded tag ids for the selected categories (sync; all chips are seeded).
  const selectedTagIds = useMemo(
    () => (catKey ? catKey.split(',').map(resolveCategoryTagId).filter(Boolean) : []),
    [catKey],
  )

  const runSearch = useCallback(async (rawQuery) => {
    const query = String(rawQuery || '').trim()
    setLastQuery(query)

    if (!query) {
      setResults([])
      setError(null)
      return
    }

    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams({ q: query, limit_per_type: String(limit) })
      const url = `${trimBase(apiBase)}/public-search?${params.toString()}`
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`Polymarket Gamma API returned ${res.status}`)

      const data = await res.json()
      let events = eventsFromPayload(data)
        .map(normaliseGammaEvent)
        .filter(Boolean)

      // Constrain to selected categories (OR across categories) when active.
      if (selectedTagIds.length > 0) {
        events = events.filter((ev) => ev.tagIds.some((id) => selectedTagIds.includes(id)))
      }

      setResults(events)
    } catch (err) {
      if (err.name === 'AbortError') return
      logger.warn?.('[usePolymarketSearch] failed:', err)
      setError(err.message || 'Polymarket search failed')
      setResults([])
    } finally {
      setIsLoading(false)
    }
  }, [apiBase, limit, selectedTagIds])

  const clear = useCallback(() => {
    if (abortRef.current) abortRef.current.abort()
    setResults([])
    setError(null)
    setLastQuery('')
    setIsLoading(false)
  }, [])

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort()
  }, [])

  return { results, isLoading, error, lastQuery, runSearch, clear }
}

/**
 * Load top Polymarket events (grouped, with nested markets) ordered by volume,
 * optionally filtered by one or more categories (OR semantics). Used by the
 * dashboard feed and the in-modal browser.
 *
 * Usage:
 *   const { results, isLoading, error, refresh } =
 *     usePolymarketTopMarkets({ categories: ['politics', 'sports'], limit: 12 })
 */
export function usePolymarketTopMarkets({ categories = [], limit = DEFAULT_BROWSE_LIMIT } = {}) {
  const wagmiChainId = useWalletChainId()
  const chainId = wagmiChainId || getCurrentChainId()
  const apiBase = apiBaseFor(chainId)
  const catKey = categoriesKeyOf(categories)

  const [results, setResults] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)

  const abortRef = useRef(null)

  const fetchTop = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)
    setError(null)

    const buildUrl = (tagId) => {
      const params = new URLSearchParams({
        active: 'true',
        closed: 'false',
        order: 'volume',
        ascending: 'false',
        limit: String(limit),
      })
      if (tagId) params.set('tag_id', String(tagId))
      return `${trimBase(apiBase)}/events?${params.toString()}`
    }

    const fetchEvents = async (tagId) => {
      const res = await fetch(buildUrl(tagId), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`Polymarket Gamma API returned ${res.status}`)
      return eventsFromPayload(await res.json())
    }

    try {
      const slugs = catKey ? catKey.split(',') : []
      let raw
      if (slugs.length === 0) {
        raw = await fetchEvents(null)
      } else {
        // One request per selected category (OR); merge + de-dupe by event id.
        const tagIds = (await Promise.all(slugs.map((s) => ensureCategoryTagId(apiBase, s)))).filter(Boolean)
        const batches = await Promise.all(tagIds.map((id) => fetchEvents(id)))
        raw = batches.flat()
      }

      const byId = new Map()
      for (const ev of raw) {
        const norm = normaliseGammaEvent(ev)
        if (norm && !byId.has(norm.id)) byId.set(norm.id, norm)
      }
      const merged = Array.from(byId.values())
      merged.sort((a, b) => (Number(b.volume) || 0) - (Number(a.volume) || 0))
      setResults(merged.slice(0, limit))
    } catch (err) {
      if (err.name === 'AbortError') return
      logger.warn?.('[usePolymarketTopMarkets] failed:', err)
      setError(err.message || 'Polymarket top-markets fetch failed')
      setResults([])
    } finally {
      setIsLoading(false)
    }
  }, [apiBase, limit, catKey])

  useEffect(() => {
    fetchTop()
    return () => {
      if (abortRef.current) abortRef.current.abort()
    }
  }, [fetchTop])

  return { results, isLoading, error, refresh: fetchTop }
}

export default usePolymarketSearch
