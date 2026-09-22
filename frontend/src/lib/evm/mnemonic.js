/**
 * BIP-39 phrase validation (spec 110, T022 groundwork).
 *
 * THE REFUSAL THIS RESTORES IS THE POINT. `lib/recovery/legacyKeys.js` gates derivation on
 * `ethers.Mnemonic.isValidMnemonic` before handing the phrase to `HDNodeWallet.fromPhrase`, and
 * that gate is load-bearing in a way the ethers version hid: **viem's `mnemonicToAccount` derives a
 * real, plausible address from an invalid phrase** (divergence h). Measured — with a bad checksum,
 * with a word that is not in the wordlist, and with a single mistyped character, ethers REFUSED and
 * viem returned a different valid-looking address each time. Only a wrong word COUNT is refused by
 * both.
 *
 * So a member recovering an account who mistypes one word of their seed would, without this, be
 * shown an address, told the import succeeded, and find an empty account — while their real funds
 * sit untouched somewhere they were not shown, and nothing anywhere reports an error. That is the
 * worst failure shape this migration has found: not a crash, not a zero, a confident wrong answer
 * on a recovery path.
 *
 * `@scure/bip39` is already a DIRECT dependency (2.4.0, exact), so this costs no lockfile change
 * and no spec-075 rolldown hazard. Its `validateMnemonic` was checked against
 * `ethers.Mnemonic.isValidMnemonic` on valid phrases at all five legal lengths and on six ways a
 * phrase goes wrong — identical every time, in both directions.
 */
import { validateMnemonic } from '@scure/bip39'
import { wordlist as english } from '@scure/bip39/wordlists/english.js'

/**
 * Is this a valid BIP-39 English phrase — right length, known words, correct checksum?
 *
 * Never throws: a malformed input is an answer (`false`), not an exception, exactly as ethers'
 * `isValidMnemonic` behaved for every shape tested.
 *
 * @param {unknown} phrase
 * @returns {boolean}
 */
export function isValidMnemonic(phrase) {
  if (typeof phrase !== 'string' || !phrase.trim()) return false
  try {
    return validateMnemonic(phrase, english)
  } catch {
    return false
  }
}
