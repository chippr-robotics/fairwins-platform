/**
 * Claim-code wordlist (feature 024 — open-challenge wagers).
 *
 * A claim code is four words from the BIP-39 English wordlist (2048 words ⇒ 2048^4 = 2^44 of entropy, the
 * spec's floor, FR-003). The same four words drive discovery, accept authorization, and terms decryption
 * (see deriveFromCode.js). Generation is client-side CSPRNG and the code is never sent to a server — the
 * creator shares it out-of-band.
 *
 * v1 anti-guessing scope is casual/indiscriminate only: the on-chain commitment is public, so a determined
 * offline attacker could brute-force a four-word code. This residual risk is accepted for v1 (FR-003a) and
 * MUST be surfaced honestly in the UI for meaningful stakes.
 */
import { english } from 'viem/accounts'

/*
 * The BIP-39 English list, from viem rather than ethers (spec 110). viem exports it as a plain
 * ARRAY where ethers wrapped it in a `Wordlist` object, so `getWord(i)` becomes an index and
 * `getWordIndex(w)` becomes `indexOf`. The two lists were compared word-for-word before the swap —
 * 2048 entries, identical and in the same order — which is what makes this safe: a claim code is
 * DERIVED from word indices, so a list that differed anywhere would silently change every code
 * generated after the swap and invalidate every code issued before it.
 */
const WORDLIST = {
  getWord: (i) => english[i],
  getWordIndex: (w) => english.indexOf(w),
}
const WORD_COUNT = 4
const LIST_SIZE = 2048

/**
 * Normalize a code to its canonical form so equivalent inputs derive identical keys:
 * NFKC, lowercase, trim, and collapse internal whitespace to single spaces.
 * @param {string} input
 * @returns {string}
 */
export function normalizeCode(input) {
  if (typeof input !== 'string') return ''
  return input
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * @param {string} input
 * @returns {boolean} true iff `input` normalizes to exactly four words, each in the BIP-39 English list.
 */
export function isValidCode(input) {
  const normalized = normalizeCode(input)
  if (!normalized) return false
  const words = normalized.split(' ')
  if (words.length !== WORD_COUNT) return false
  return words.every((w) => WORDLIST.getWordIndex(w) >= 0)
}

/**
 * @param {string} word
 * @returns {boolean} true iff `word` normalizes to a single word in the BIP-39 English list.
 * Used for the per-word validity feedback in the phrase entry inputs.
 */
export function isValidWord(word) {
  if (typeof word !== 'string') return false
  const w = word.normalize('NFKC').toLowerCase().trim()
  if (!w || /\s/.test(w)) return false
  return WORDLIST.getWordIndex(w) >= 0
}

// The full 2048-word list, materialized once for prefix suggestions (BIP-39 is sorted).
let cachedWords = null
function allWords() {
  if (!cachedWords) {
    cachedWords = new Array(LIST_SIZE)
    for (let i = 0; i < LIST_SIZE; i += 1) cachedWords[i] = WORDLIST.getWord(i)
  }
  return cachedWords
}

/**
 * Up to `limit` wordlist words that start with `prefix` (case-insensitive), in list order.
 * An empty/whitespace prefix returns nothing (so we never dump the whole list). Powers the
 * type-ahead completion in the phrase inputs so a word is corrected before all four are entered.
 * @param {string} prefix
 * @param {number} [limit=6]
 * @returns {string[]}
 */
export function suggestWords(prefix, limit = 6) {
  const p = typeof prefix === 'string' ? prefix.normalize('NFKC').toLowerCase().trim() : ''
  if (!p) return []
  const out = []
  for (const w of allWords()) {
    if (w.startsWith(p)) {
      out.push(w)
      if (out.length >= limit) break
    }
  }
  return out
}

/**
 * Generate a fresh four-word claim code using the platform CSPRNG.
 * Uses rejection sampling on 16-bit reads to map uniformly onto the 2048-word list (no modulo bias).
 * @returns {string} e.g. "river amber tiger kite"
 */
export function generateCode() {
  const words = []
  const buf = new Uint16Array(1)
  // Largest multiple of LIST_SIZE that fits in 16 bits; reject reads at/above it to keep the mapping uniform.
  const limit = Math.floor(65536 / LIST_SIZE) * LIST_SIZE
  while (words.length < WORD_COUNT) {
    crypto.getRandomValues(buf)
    if (buf[0] >= limit) continue
    words.push(WORDLIST.getWord(buf[0] % LIST_SIZE))
  }
  return words.join(' ')
}

export const CLAIM_CODE_WORD_COUNT = WORD_COUNT
