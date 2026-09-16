/**
 * `lib/evm/mnemonic.js#isValidMnemonic` — the guard that stops a recovery from succeeding on a
 * phrase the member mistyped (spec 110, divergence h).
 *
 * ETHERS IS DELIBERATELY NOT THE ORACLE HERE, and the reason is worth knowing before anyone tries
 * to "restore" the comparison. Under vitest's jsdom environment ethers' BIP-39 path is broken:
 * its `sha256` receives a Node `Buffer` from another realm, `instanceof Uint8Array` is false, and
 * `getBytes` rejects it. `HDNodeWallet.fromPhrase` throws outright — and worse,
 * `Mnemonic.isValidMnemonic` CATCHES that internally and returns `false` for a perfectly valid
 * phrase. An assertion against it here would be comparing against a function that answers wrongly.
 *
 * So the cross-library parity was measured in a plain-Node probe instead, where ethers works:
 * `validateMnemonic` agreed with `Mnemonic.isValidMnemonic` on valid phrases at all five legal
 * lengths and on six ways a phrase goes wrong, in both directions, and `mnemonicToAccount` agreed
 * with `HDNodeWallet.fromPhrase` on every valid phrase. What remains here is everything that CAN
 * be checked in this environment — which, note, is more than the ethers version could be: the
 * shipped `ethers.Mnemonic.isValidMnemonic` gate was not testable in this suite at all.
 *
 * The assertions that carry the weight are the ones about what viem does WITHOUT this guard. It is
 * not that `mnemonicToAccount` throws a different error — it does not throw at all. It returns a
 * real, plausible, DIFFERENT address for a bad checksum, for a word that is not in the wordlist,
 * and for a single mistyped character. So the failure mode this prevents is not a crash: it is a
 * member being shown an address, told their import worked, and finding an empty account while
 * their real funds sit somewhere they were never shown, with nothing reporting an error.
 */
import { describe, it, expect } from 'vitest'
import { generateMnemonic } from '@scure/bip39'
import { wordlist as english } from '@scure/bip39/wordlists/english.js'
import { mnemonicToAccount } from 'viem/accounts'
import { isValidMnemonic } from '../../lib/evm/mnemonic'

// One valid phrase per legal length (12, 15, 18, 21, 24 words).
const VALID = [128, 160, 192, 224, 256].map((strength) => generateMnemonic(english, strength))

describe('isValidMnemonic', () => {
  it('accepts valid phrases at every legal length', () => {
    expect(VALID).toHaveLength(5)
    for (const phrase of VALID) expect(isValidMnemonic(phrase)).toBe(true)
  })

  const words = VALID[0].split(' ')
  const invalid = [
    ['bad checksum (last word swapped)', [...words.slice(0, -1), words[0]].join(' ')],
    ['a word that is not in the wordlist', [...words.slice(0, -1), 'zzzznotaword'].join(' ')],
    ['one mistyped character', [...words.slice(0, -1), `${words.at(-1)}x`].join(' ')],
    ['wrong word count', words.slice(0, 11).join(' ')],
    ['all the same word', Array(12).fill('abandon').join(' ')],
    ['empty', ''],
  ]

  it('refuses every way a phrase goes wrong', () => {
    for (const [label, phrase] of invalid) expect(isValidMnemonic(phrase), label).toBe(false)
  })

  it('answers rather than throwing for input that is not a phrase at all', () => {
    for (const bad of [null, undefined, 42, {}, [], '   ']) {
      expect(isValidMnemonic(bad)).toBe(false)
    }
  })

  it('IS THE ONLY THING standing between a typo and a wrong account', () => {
    // Without the guard, viem does not refuse — it derives. Each bad phrase below produces a real
    // address, and every one of them differs from the address the CORRECT phrase gives.
    const right = mnemonicToAccount(VALID[0]).address
    const derivedAnyway = []
    for (const [label, phrase] of invalid.slice(0, 3)) {
      let address = null
      try {
        address = mnemonicToAccount(phrase).address
      } catch {
        /* refused — would be the safe outcome, and is not what happens */
      }
      expect(isValidMnemonic(phrase), label).toBe(false)
      if (address) derivedAnyway.push([label, address])
    }
    expect(derivedAnyway.length, 'viem is expected to derive from all three — if it now refuses, this guard is belt-and-braces rather than load-bearing, and the comment in lib/evm/mnemonic.js should be corrected').toBe(3)
    for (const [, address] of derivedAnyway) expect(address).not.toBe(right)
  })

  it('derives a stable account for a valid phrase at every legal length', () => {
    // The half that must not change. Parity with `HDNodeWallet.fromPhrase` was measured in the
    // plain-Node probe (see the header) — it cannot be asserted here, because ethers' derivation
    // throws under jsdom. What IS checkable is that every legal length derives, and derives the
    // same address twice.
    for (const phrase of VALID) {
      const address = mnemonicToAccount(phrase).address
      expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(mnemonicToAccount(phrase).address).toBe(address)
    }
  })
})
