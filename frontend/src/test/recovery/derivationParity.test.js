/**
 * Derivation parity: the one thing in this migration a member cannot survive being wrong about.
 *
 * `lib/recovery/legacyKeys.js` used to derive a recovered account's address with
 * `ethers.HDNodeWallet.fromPhrase` / `new ethers.Wallet`; it now uses viem's `mnemonicToAccount` /
 * `privateKeyToAccount`. If those disagree by one derivation path, a member who pastes their seed
 * is shown an address that is not theirs, told the import worked, and finds an empty account —
 * while their funds sit untouched somewhere they were never shown. Nothing errors. It is the same
 * failure shape as divergence h (an invalid phrase deriving a plausible address), reached by a
 * different door, and it is why `addressFromSecret` is checked against the library it replaced
 * rather than against a table of expected values.
 *
 * ethers is the ORACLE here and is imported unmocked. A fixture list would only prove that viem
 * agrees with whatever produced the fixtures.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { ethers } from 'ethers'
import { generateMnemonic } from '@scure/bip39'
import { wordlist as english } from '@scure/bip39/wordlists/english.js'
import { registerEthersCrypto } from './registerEthersCrypto'
import { addressFromSecret } from '../../lib/recovery/legacyKeys'
import { localAccount } from '../../lib/chains/localKeySigner'

beforeAll(() => registerEthersCrypto())

const randomKey = () => `0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')}`

describe('derivation parity — viem must land where ethers landed', () => {
  it('agrees with ethers on the published Hardhat vector, key and phrase alike', () => {
    const PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const MNEMONIC = 'test test test test test test test test test test test junk'
    const expected = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
    expect(new ethers.Wallet(PK).address).toBe(expected)
    expect(ethers.HDNodeWallet.fromPhrase(MNEMONIC).address).toBe(expected)
    expect(addressFromSecret({ kind: 'privateKey', secret: PK })).toBe(expected)
    expect(addressFromSecret({ kind: 'mnemonic', secret: MNEMONIC })).toBe(expected)
  })

  it('agrees with ethers on generated private keys', () => {
    for (let i = 0; i < 100; i += 1) {
      const key = randomKey()
      expect(addressFromSecret({ kind: 'privateKey', secret: key })).toBe(new ethers.Wallet(key).address)
    }
  })

  it('agrees with ethers on generated 12- and 24-word phrases, at the DEFAULT account path', () => {
    // m/44'/60'/0'/0/0 for both libraries. A mismatch here is a member pointed at the wrong
    // account; there is no in-app signal that would tell them, which is why it is asserted over
    // generated input rather than one example.
    for (const strength of [128, 256]) {
      for (let i = 0; i < 20; i += 1) {
        const phrase = generateMnemonic(english, strength)
        const theirs = ethers.HDNodeWallet.fromPhrase(phrase)
        expect(addressFromSecret({ kind: 'mnemonic', secret: phrase })).toBe(theirs.address)
      }
    }
  })

  it('agrees on the PRIVATE KEY a phrase yields, not only on the address', () => {
    // The address is what a member sees; the key is what signs. Equal addresses with unequal keys
    // would be a far stranger failure, so the stronger equality is the one asserted.
    for (let i = 0; i < 10; i += 1) {
      const phrase = generateMnemonic(english, 128)
      const theirs = ethers.HDNodeWallet.fromPhrase(phrase)
      const ours = localAccount({ kind: 'mnemonic', secret: phrase })
      expect(ours.getHdKey().privateKey).toBeTruthy()
      expect(`0x${Buffer.from(ours.getHdKey().privateKey).toString('hex')}`).toBe(theirs.privateKey)
    }
  })

  it('signs a message identically to the ethers wallet it replaces', async () => {
    const key = randomKey()
    const message = 'move my funds to the new account'
    const theirs = await new ethers.Wallet(key).signMessage(message)
    const ours = await localAccount({ kind: 'privateKey', secret: key }).signMessage({ message })
    expect(ours).toBe(theirs)
  })

  it('has a full wordlist to generate from — the generator is not silently degenerate', () => {
    // Without this, a wordlist that imported as an empty array would make every phrase above the
    // same phrase, and the parity above would hold for a reason that proves nothing.
    expect(english).toHaveLength(2048)
    expect(new Set([generateMnemonic(english, 128), generateMnemonic(english, 128)]).size).toBe(2)
  })
})
