/**
 * BIP-39 word suggestions for the recovery word-list input (spec 062).
 *
 * As a member types their recovery phrase, we (a) suggest completions for the
 * word currently being typed and (b) flag already-typed words that aren't valid
 * BIP-39 words, so typos surface immediately instead of only at final
 * validation. English list only (recovery targets English phrases; the ZK-pool
 * multi-language registry is a separate concern). Sourced from ethers'
 * bundled wordlist — no extra 2048-word asset shipped.
 */
import { english } from 'viem/accounts'

let cachedWords = null
let cachedSet = null

/**
 * The 2048 English BIP-39 words (cached).
 *
 * From viem rather than ethers since spec 110 — it exports the list as a plain array, so the
 * index-by-index walk (and the guard against a list that stopped answering partway) is gone with
 * the object wrapper that needed it. The two lists were compared word-for-word before the swap.
 */
export function bip39Words() {
  if (cachedWords) return cachedWords
  const out = Array.isArray(english) ? [...english] : []
  cachedWords = out
  cachedSet = new Set(out)
  return cachedWords
}

function wordSet() {
  if (!cachedSet) bip39Words()
  return cachedSet
}

/** True iff `word` is a valid BIP-39 English word. */
export function isBip39Word(word) {
  return wordSet().has(String(word || '').trim().toLowerCase())
}

/**
 * Suggest completions for a partial word. Returns up to `limit` words that start
 * with `prefix` (case-insensitive), excluding an exact full match (nothing to
 * suggest once the word is complete and unique).
 */
export function suggestWords(prefix, limit = 6) {
  const p = String(prefix || '').trim().toLowerCase()
  if (!p) return []
  const out = []
  for (const w of bip39Words()) {
    if (w.startsWith(p) && w !== p) {
      out.push(w)
      if (out.length >= limit) break
    }
  }
  return out
}

/** The word currently being typed = the last whitespace-delimited token. */
export function currentWord(text) {
  const t = String(text || '')
  if (!t || /\s$/.test(t)) return '' // trailing space ⇒ starting a new word
  const parts = t.split(/\s+/)
  return parts[parts.length - 1] || ''
}

/**
 * Replace the word currently being typed with `word` (adding a trailing space so
 * the member can continue). If the text ends in whitespace, append instead.
 */
export function applySuggestion(text, word) {
  const t = String(text || '')
  if (!t || /\s$/.test(t)) return `${t}${word} `
  const idx = t.search(/\S+$/)
  return `${t.slice(0, idx)}${word} `
}

/**
 * The already-completed words that aren't valid BIP-39 words (typo detection).
 * The final token is excluded while it's still being typed (no trailing space),
 * so we don't flag a half-typed word as invalid.
 */
export function unknownWordsIn(text) {
  const t = String(text || '')
  if (!t.trim()) return []
  const tokens = t.trim().split(/\s+/)
  const stillTyping = !/\s$/.test(t)
  const complete = stillTyping ? tokens.slice(0, -1) : tokens
  const seen = new Set()
  return complete
    .map((w) => w.toLowerCase())
    .filter((w) => w && !isBip39Word(w) && !seen.has(w) && seen.add(w))
}
