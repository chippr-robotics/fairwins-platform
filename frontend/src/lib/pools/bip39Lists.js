/**
 * BIP-39 wordlist registry for ZK-Wager Pools (spec 034).
 *
 * A pool's identity is a language-independent tuple of four BIP-39 word indices (FR-003). The
 * frontend renders/parses that tuple through the member's chosen language's wordlist, so the same
 * pool resolves regardless of language (User Story 2 / SC-008).
 *
 * ── WHY THIS IS NO LONGER STUCK (spec 110 T028) ─────────────────────────────────────────────
 * The ethers allowlist carried this file as a permanent DECISION on the grounds that "ethers
 * bundles TEN wordlists and viem exports only English, so converting would silently drop nine
 * languages". The premise was wrong. `@scure/bip39` — **already a direct dependency at 2.4.0**, so
 * no lockfile change and no spec-075 rolldown hazard — ships all ten, and each one was compared
 * against ethers' word for word before this swap: 2048 entries, same order, IDENTICAL in cz, en,
 * es, fr, it, ja, ko, pt, zh_cn and zh_tw.
 *
 * That comparison is not ceremony. A pool's four-word phrase is stored as INDICES, so a list that
 * differed anywhere would rename every pool ever created — in one language only, which is the kind
 * of bug nobody reproduces.
 *
 * This is the SECOND wrong reason on this entry (the first claimed viem bundles none). Both were
 * discovered by checking rather than trusting, and the rule they keep earning is that a stated
 * blocker on an exemption list is a claim, not a fact.
 *
 * The lists are plain ARRAYS here where ethers wrapped them in a `Wordlist` object, so the
 * registry returns a thin adapter that keeps `getWord(i)` — the only method any caller uses.
 * `getWordIndex` is deliberately NOT provided: ethers applied per-language normalization that a
 * bare `indexOf` does not reproduce for ja/ko, and a missing method fails loudly where a wrong
 * index would be silent. Add it when a caller needs it, with the normalization written out.
 */
import { wordlist as cz } from '@scure/bip39/wordlists/czech.js'
import { wordlist as en } from '@scure/bip39/wordlists/english.js'
import { wordlist as es } from '@scure/bip39/wordlists/spanish.js'
import { wordlist as fr } from '@scure/bip39/wordlists/french.js'
import { wordlist as it } from '@scure/bip39/wordlists/italian.js'
import { wordlist as ja } from '@scure/bip39/wordlists/japanese.js'
import { wordlist as ko } from '@scure/bip39/wordlists/korean.js'
import { wordlist as pt } from '@scure/bip39/wordlists/portuguese.js'
import { wordlist as zh_cn } from '@scure/bip39/wordlists/simplified-chinese.js'
import { wordlist as zh_tw } from '@scure/bip39/wordlists/traditional-chinese.js'

/** Languages offered in the "My Account" selector (US2). Availability is checked at render time. */
export const SUPPORTED_BIP39_LANGS = ['en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'cz', 'zh_cn', 'zh_tw']

export const DEFAULT_BIP39_LANG = 'en'

const WORDS = { cz, en, es, fr, it, ja, ko, pt, zh_cn, zh_tw }

/** Cached adapters — one per language, so `getWordlist` keeps a stable identity across renders. */
const ADAPTERS = new Map()

function adapterFor(lang) {
  if (!ADAPTERS.has(lang)) {
    const words = WORDS[lang]
    ADAPTERS.set(lang, { lang, getWord: (index) => words[index] })
  }
  return ADAPTERS.get(lang)
}

/** True iff a wordlist is bundled for `lang`. */
export function isLangAvailable(lang) {
  return Array.isArray(WORDS[lang]) && WORDS[lang].length === 2048
}

/**
 * Resolve a language code to a wordlist adapter, falling back to English.
 * @param {string} [lang]
 * @returns {{ lang: string, getWord: (index: number) => string }}
 */
export function getWordlist(lang = DEFAULT_BIP39_LANG) {
  return adapterFor(isLangAvailable(lang) ? lang : DEFAULT_BIP39_LANG)
}
