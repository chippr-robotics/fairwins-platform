/**
 * `lib/evm/mnemonic.js#isValidMnemonic` — the guard that stops a recovery from succeeding on a
 * phrase the member mistyped (spec 110, divergence h).
 *
 * ── WHY EVERY PHRASE HERE IS A FROZEN LITERAL ───────────────────────────────────────────────
 * The first version of this file GENERATED a phrase per run and derived the invalid cases from it
 * by mutation — including "bad checksum" by replacing the last word. That is a flaky test, and it
 * flaked: `Frontend Unit Tests` failed on a DOCS-ONLY commit, reporting `isValidMnemonic` had
 * returned true for a phrase labelled invalid.
 *
 * It was not wrong about that. The last word of a BIP-39 phrase carries the 4 CHECKSUM bits, so a
 * substitute word checksums correctly about 1 time in 16 — measured at 6.6% over 2,000 trials.
 * Roughly one CI run in fifteen would fail, on a different phrase each time, on whatever commit
 * happened to be unlucky. A randomly-generated fixture is not a stronger test than a fixed one;
 * it is the same test plus a coin flip, and here the coin decided whether the suite was honest.
 *
 * So the phrases are literals, each one verified before it was pasted: every VALID phrase
 * validates at its stated length, every INVALID one fails, and the three "derives anyway" cases
 * were confirmed to still derive a different address. **Never regenerate these to make a test
 * pass** — a mismatch means the code changed, which on this path means every member's recovered
 * account moves.
 *
 * ── WHY ETHERS IS NOT THE ORACLE ────────────────────────────────────────────────────────────
 * Under vitest's jsdom environment ethers' BIP-39 path is broken: its `sha256` receives a Node
 * `Buffer` from another realm, `instanceof Uint8Array` is false, and `getBytes` rejects it.
 * `HDNodeWallet.fromPhrase` throws — and worse, `Mnemonic.isValidMnemonic` CATCHES that internally
 * and returns `false` for a perfectly valid phrase. An assertion against it here would compare
 * against a function that answers wrongly. Cross-library parity was measured in a plain-Node probe
 * instead, where ethers works: `validateMnemonic` agreed with `Mnemonic.isValidMnemonic` on valid
 * phrases at all five legal lengths and on six ways a phrase goes wrong, in both directions, and
 * `mnemonicToAccount` agreed with `HDNodeWallet.fromPhrase` on every valid phrase.
 *
 * ── WHAT THE GUARD IS ACTUALLY FOR ──────────────────────────────────────────────────────────
 * Not that `mnemonicToAccount` throws a different error — it does not throw at all. It returns a
 * real, plausible, DIFFERENT address for a bad checksum, for a word that is not in the wordlist,
 * and for a single mistyped character. So the failure this prevents is not a crash: it is a member
 * being shown an address, told their import worked, and finding an empty account while their real
 * funds sit somewhere they were never shown, with nothing reporting an error.
 */
import { describe, it, expect } from 'vitest'
import { generateMnemonic, validateMnemonic } from '@scure/bip39'
import { wordlist as english } from '@scure/bip39/wordlists/english.js'
import { mnemonicToAccount } from 'viem/accounts'
import { isValidMnemonic } from '../../lib/evm/mnemonic'

/** One frozen valid phrase per legal length (12, 15, 18, 21, 24 words). */
const VALID = [
  'audit journey sense bulk valley maple destroy tiger audit journey sense cable',
  'borrow speak make crouch payment artist half drive borrow speak make crouch payment artist harbor',
  'clinic flock skull film razor night protect grace clinic flock skull film razor night protect grace clinic flee',
  'destroy tiger audit journey sense bulk valley maple destroy tiger audit journey sense bulk valley maple destroy tiger audit journey sister',
  'essence heavy fashion once state pluck cry predict essence heavy fashion once state pluck cry predict essence heavy fashion once state pluck cry sample',
]

/** The address the 12-word phrase derives. Frozen: a change here moves a member's money. */
const VALID_0_ADDRESS = '0xb8C2598E3a2F68866F86A57a520a96ACd233fAfE'

/**
 * Six ways a phrase goes wrong — frozen, not mutated at runtime.
 *
 * The first is the one that used to be generated. `abandon` in the final position is a substitute
 * that was CHECKED to fail the checksum for this specific phrase; most substitutes do, but one in
 * sixteen does not, which is exactly the bug this file was written around.
 */
const INVALID = [
  [
    'bad checksum (last word swapped)',
    'audit journey sense bulk valley maple destroy tiger audit journey sense abandon',
  ],
  [
    'a word that is not in the wordlist',
    'audit journey sense bulk valley maple destroy tiger audit journey sense zzzznotaword',
  ],
  [
    'one mistyped character',
    'audit journey sense bulk valley maple destroy tiger audit journey sense cablex',
  ],
  ['wrong word count', 'audit journey sense bulk valley maple destroy tiger audit journey sense'],
  ['all the same word', Array(12).fill('abandon').join(' ')],
  ['empty', ''],
]

describe('the fixtures themselves', () => {
  // A frozen invalid phrase that silently became valid would retire the assertions below without
  // failing anything, which is the failure mode frozen fixtures trade for the flaky one.
  it('every VALID phrase really is valid, at the length it claims', () => {
    const lengths = VALID.map((p) => p.split(' ').length)
    expect(lengths).toEqual([12, 15, 18, 21, 24])
    for (const phrase of VALID) expect(validateMnemonic(phrase, english), phrase).toBe(true)
  })

  it('every INVALID phrase really is invalid — checked against the library, not assumed', () => {
    for (const [label, phrase] of INVALID) {
      expect(validateMnemonic(phrase, english), label).toBe(false)
    }
  })

  it('a last-word swap is NOT reliably invalid, which is why these are frozen', () => {
    // The measurement that explains the header, run small. Generating the "bad checksum" case is
    // a coin flip; if this ever finds zero accidental passes in this many trials the arithmetic
    // has changed and the header needs rewriting, not the fixtures.
    let accidentallyValid = 0
    for (let i = 0; i < 400; i += 1) {
      const words = generateMnemonic(english, 128).split(' ')
      if (validateMnemonic([...words.slice(0, -1), words[0]].join(' '), english)) {
        accidentallyValid += 1
      }
    }
    expect(
      accidentallyValid,
      'a substitute last word checksums correctly ~1 time in 16; if this is 0 over 400 trials, re-derive the rate before trusting it',
    ).toBeGreaterThan(0)
  })
})

describe('isValidMnemonic', () => {
  it('accepts valid phrases at every legal length', () => {
    for (const phrase of VALID) expect(isValidMnemonic(phrase), phrase).toBe(true)
  })

  it('refuses every way a phrase goes wrong', () => {
    for (const [label, phrase] of INVALID) expect(isValidMnemonic(phrase), label).toBe(false)
  })

  it('answers rather than throwing for input that is not a phrase at all', () => {
    for (const bad of [null, undefined, 42, {}, [], '   ']) {
      expect(isValidMnemonic(bad)).toBe(false)
    }
  })

  it('IS THE ONLY THING standing between a typo and a wrong account', () => {
    // Without the guard, viem does not refuse — it derives. Each bad phrase below produces a real
    // address, and every one of them differs from the address the CORRECT phrase gives.
    const derivedAnyway = []
    for (const [label, phrase] of INVALID.slice(0, 3)) {
      let address = null
      try {
        address = mnemonicToAccount(phrase).address
      } catch {
        /* refused — would be the safe outcome, and is not what happens */
      }
      expect(isValidMnemonic(phrase), label).toBe(false)
      if (address) derivedAnyway.push([label, address])
    }
    expect(
      derivedAnyway.length,
      'viem is expected to derive from all three — if it now refuses, this guard is belt-and-braces rather than load-bearing, and the comment in lib/evm/mnemonic.js should be corrected',
    ).toBe(3)
    for (const [label, address] of derivedAnyway) {
      expect(address, label).not.toBe(VALID_0_ADDRESS)
    }
  })

  it('derives the frozen account for the frozen phrase', () => {
    // The half that must not change. Parity with `HDNodeWallet.fromPhrase` was measured in the
    // plain-Node probe (see the header) — it cannot be asserted here, because ethers' derivation
    // throws under jsdom. What IS pinned is the ADDRESS: this is a money path, and a suite that
    // only checked "derives the same thing twice" would stay green through a derivation change
    // that orphans every account ever recovered.
    expect(mnemonicToAccount(VALID[0]).address).toBe(VALID_0_ADDRESS)
    for (const phrase of VALID) {
      expect(mnemonicToAccount(phrase).address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
  })
})
