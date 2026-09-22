/**
 * 4-word group gateway for ZK-Wager Pools (spec 034).
 *
 * A pool is identified by four BIP-39 word indices (each 0..2047 ⇒ 2^44 space). The index tuple is the
 * canonical, language-independent identity (FR-003); this module converts between the tuple and a
 * human-readable phrase in any supported language, and resolves a phrase to a pool address via the
 * factory's `poolByPhrase` (FR-004). The same pool resolves regardless of the member's language
 * (SC-008), because the tuple — not the words — identifies the pool.
 */
import { zeroAddress } from 'viem'
import { getWordlist, DEFAULT_BIP39_LANG } from './bip39Lists'

export const POOL_WORD_COUNT = 4
const LIST_SIZE = 2048

/** @param {number[]} indices */
function assertIndices(indices) {
  if (
    !Array.isArray(indices) ||
    indices.length !== POOL_WORD_COUNT ||
    indices.some((i) => !Number.isInteger(i) || i < 0 || i >= LIST_SIZE)
  ) {
    throw new Error('gateway: indices must be four integers in [0, 2048)')
  }
}

function normalize(input) {
  return String(input).normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')
}

// Cache, keyed by the Wordlist object: normalized word -> index. Built once per language so parsing
// matches rendering regardless of a language's internal accent normalization (e.g. Spanish).
const _reverseCache = new Map()
function reverseMap(lang) {
  const wl = getWordlist(lang)
  let map = _reverseCache.get(wl)
  if (map) return map
  map = new Map()
  for (let i = 0; i < LIST_SIZE; i++) map.set(normalize(wl.getWord(i)), i)
  _reverseCache.set(wl, map)
  return map
}

/**
 * Render an index tuple to a phrase in `lang`.
 * @param {number[]} indices
 * @param {string} [lang]
 * @returns {string} e.g. "river amber tiger kite"
 */
export function indicesToPhrase(indices, lang = DEFAULT_BIP39_LANG) {
  assertIndices(indices)
  const wl = getWordlist(lang)
  return indices.map((i) => wl.getWord(i)).join(' ')
}

/**
 * Parse a phrase in `lang` back to its index tuple. Returns null for the wrong word count or any
 * word not in the language's wordlist (so the UI can show a clear "not found", not a crash).
 * @param {string} phrase
 * @param {string} [lang]
 * @returns {number[]|null}
 */
export function phraseToIndices(phrase, lang = DEFAULT_BIP39_LANG) {
  if (typeof phrase !== 'string') return null
  const words = normalize(phrase).split(' ').filter(Boolean)
  if (words.length !== POOL_WORD_COUNT) return null
  const map = reverseMap(lang)
  const indices = []
  for (const w of words) {
    const idx = map.get(w)
    if (idx === undefined) return null
    indices.push(idx)
  }
  return indices
}

/**
 * Resolve an index tuple to a pool address via the factory contract. Returns null when no pool maps to
 * the phrase (unknown/stale phrase).
 * @param {import('ethers').Contract} factory a WagerPoolFactory contract instance (read runner)
 * @param {number[]} indices
 * @returns {Promise<string|null>}
 */
export async function resolvePool(factory, indices) {
  assertIndices(indices)
  const addr = await factory.poolByPhrase(indices)
  return addr && addr !== zeroAddress ? addr : null
}
