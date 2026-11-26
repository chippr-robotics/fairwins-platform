/**
 * Bounded category table for the Predict event list (spec 114, research R3).
 *
 * Venue tags are open-ended; member-visible navigation and gateway cache keys must not be. Our
 * category id -> the venue's `tag_slug`. An id not in this table is a 400 `invalid_category`,
 * never passed through. Every slug was verified against the live venue on 2026-11-26
 * (`/events?active=true&closed=false&tag_slug=<slug>` returns events that carry that tag).
 *
 * `culture` maps to the venue's `pop-culture` tag: a `culture` slug exists nowhere upstream and
 * answers an empty array, which would render as an honestly-empty but permanently dead category.
 */
const CATEGORY_TAGS = Object.freeze({
  politics: 'politics',
  sports: 'sports',
  crypto: 'crypto',
  economy: 'economy',
  tech: 'tech',
  culture: 'pop-culture',
  science: 'science',
  world: 'world',
})

/** Our ids, in display order. */
export const CATEGORY_IDS = Object.freeze(Object.keys(CATEGORY_TAGS))

export const isCategory = (id) => typeof id === 'string' && Object.hasOwn(CATEGORY_TAGS, id)

/** The venue tag slug for one of our ids, or null for anything else. */
export const tagSlugFor = (id) => (isCategory(id) ? CATEGORY_TAGS[id] : null)

/** True when `slug` is the venue tag behind one of our fixed categories (compared case-insensitively). */
export const isCategoryTagSlug = (slug) =>
  typeof slug === 'string' && Object.values(CATEGORY_TAGS).some((v) => v === slug.toLowerCase())

/**
 * Our id for an event's tags: the first tag slug that maps back to one of our categories, in the
 * event's own tag order; null when none does. Never invents a category.
 */
export function categoryForTags(tags) {
  if (!Array.isArray(tags)) return null
  for (const t of tags) {
    const slug = typeof t === 'string' ? t : t?.slug
    if (typeof slug !== 'string') continue
    const id = CATEGORY_IDS.find((c) => CATEGORY_TAGS[c] === slug)
    if (id) return id
  }
  return null
}
