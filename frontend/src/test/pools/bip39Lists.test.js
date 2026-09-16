/**
 * The pool wordlist registry (spec 034 SC-008), after the swap off ethers (spec 110 T028).
 *
 * A pool's four-word phrase is stored on chain as INDICES, so a wordlist that differed from the one
 * that minted it would rename every pool ever created — in one language only, which is the kind of
 * bug nobody reproduces from a report. That is why this compares against ethers word for word
 * rather than spot-checking: ethers is the oracle for the exact lists that were replaced.
 *
 * The ethers allowlist carried this file as a permanent DECISION on the premise that only English
 * was available without it. That premise was wrong — `@scure/bip39` is already a direct dependency
 * and ships all ten — and it was the SECOND wrong reason on the same entry. These assertions are
 * what make the claim checkable instead of a sentence somebody has to trust.
 */
import { describe, it, expect } from 'vitest'
import { wordlists as ethersWordlists } from 'ethers'
import {
  DEFAULT_BIP39_LANG,
  SUPPORTED_BIP39_LANGS,
  getWordlist,
  isLangAvailable,
} from '../../lib/pools/bip39Lists'

describe('bip39Lists', () => {
  it('offers every language it advertises', () => {
    expect(SUPPORTED_BIP39_LANGS).toHaveLength(10)
    for (const lang of SUPPORTED_BIP39_LANGS) expect(isLangAvailable(lang), lang).toBe(true)
  })

  it('matches ethers word for word, in every language and at every index', () => {
    for (const lang of SUPPORTED_BIP39_LANGS) {
      const theirs = ethersWordlists[lang]
      expect(theirs, `ethers has no wordlist for ${lang}`).toBeTruthy()
      const ours = getWordlist(lang)
      for (let i = 0; i < 2048; i += 1) {
        if (ours.getWord(i) !== theirs.getWord(i)) {
          // Fail with the position, not just "arrays differ" — a single wrong index is the whole bug.
          expect.fail(`${lang}[${i}]: ours=${ours.getWord(i)} ethers=${theirs.getWord(i)}`)
        }
      }
    }
  })

  it('falls back to English for a language it does not have, rather than returning nothing', () => {
    const en = getWordlist('en')
    for (const missing of ['xx', '', null, undefined, 'de']) {
      expect(isLangAvailable(missing)).toBe(false)
      expect(getWordlist(missing).getWord(0)).toBe(en.getWord(0))
    }
    expect(getWordlist().lang).toBe(DEFAULT_BIP39_LANG)
  })

  it('returns a STABLE object per language — it is read inside React renders', () => {
    expect(getWordlist('ja')).toBe(getWordlist('ja'))
    expect(getWordlist('ja')).not.toBe(getWordlist('ko'))
  })
})
