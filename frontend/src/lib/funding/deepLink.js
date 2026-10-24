/**
 * Funding-pool share links (spec 103, FR-020 / research R9).
 *
 *   /fund/<w1>-<w2>-<w3>-<w4>   the four words, hyphen-joined, in the organizer's phrase language
 *   /fund/0x<address>           canonical fallback (share targets that mangle hyphens, other-language readers)
 *
 * The words are what a member reads aloud or retypes from a photo; the address is what always resolves.
 * The page tries the saved phrase language first, then every supported BIP-39 language, so a link
 * created in Spanish still opens for an English reader (the identity is the index tuple).
 */

export const FUNDING_ROUTE_PREFIX = '/fund/'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Build the shareable URL for a pool. Prefers the words; falls back to the address. */
export function buildFundingPoolUrl({ phrase, address, origin } = {}) {
  const base = origin ?? (typeof window !== 'undefined' && window.location ? window.location.origin : '')
  const words = typeof phrase === 'string' ? phrase.trim().split(/\s+/).filter(Boolean) : []
  const slug = words.length === 4 ? words.map((w) => encodeURIComponent(w)).join('-') : address
  if (!slug) throw new Error('buildFundingPoolUrl: need a four-word phrase or an address')
  return `${base}${FUNDING_ROUTE_PREFIX}${slug}`
}

/**
 * Parse a route param (or a pasted link / phrase) into a pool reference.
 * @returns {{ address: string } | { words: string[] } | null}
 */
export function parseFundingRef(input) {
  if (typeof input !== 'string') return null
  let ref = input.trim()
  if (!ref) return null
  // A pasted full link: take the segment after /fund/.
  const idx = ref.indexOf(FUNDING_ROUTE_PREFIX)
  if (idx >= 0) ref = ref.slice(idx + FUNDING_ROUTE_PREFIX.length).split(/[?#]/)[0]
  try {
    ref = decodeURIComponent(ref)
  } catch {
    /* keep raw */
  }
  if (ADDRESS_RE.test(ref)) return { address: ref }
  const words = ref
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 4) return { words }
  return null
}
