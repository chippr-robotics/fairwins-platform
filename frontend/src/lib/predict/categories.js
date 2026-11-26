/**
 * Predict categories (spec 114) — the bounded ids the gateway accepts for `category`
 * (`services/relay-gateway/src/polymarket/categories.js`) with the words a member reads.
 * An id this table does not know renders as nothing rather than as a guessed label.
 */
export const PREDICT_CATEGORIES = Object.freeze([
  { id: 'politics', label: 'Politics' },
  { id: 'sports', label: 'Sports' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'economy', label: 'Economy' },
  { id: 'tech', label: 'Tech' },
  { id: 'culture', label: 'Culture' },
  { id: 'science', label: 'Science' },
  { id: 'world', label: 'World' },
])

export const PREDICT_SORTS = Object.freeze([
  { id: 'volume24h', label: 'Most traded' },
  { id: 'newest', label: 'Newest' },
  { id: 'closing', label: 'Closing soonest' },
])

export const DEFAULT_SORT = 'volume24h'

const BY_ID = new Map(PREDICT_CATEGORIES.map((c) => [c.id, c.label]))

export const isCategoryId = (id) => BY_ID.has(id)
export const isSortId = (id) => PREDICT_SORTS.some((s) => s.id === id)
export const categoryLabel = (id) => (typeof id === 'string' ? BY_ID.get(id) ?? null : null)
