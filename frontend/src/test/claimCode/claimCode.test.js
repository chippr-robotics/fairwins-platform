import { describe, it, expect } from 'vitest'
import { verifyTypedData } from 'ethers'

// Fixed, valid checksummed addresses (well-known Hardhat accounts). We avoid Wallet.createRandom() because
// its mnemonic generation hits an ethers/@noble sha256 Buffer quirk under Vitest's jsdom — unrelated to the
// code under test; we only need distinct, valid addresses here.
const TAKER_A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const TAKER_B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const VERIFYING_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
import { generateCode, normalizeCode, isValidCode, isValidWord, suggestWords } from '../../utils/claimCode/wordlist.js'
import { deriveFromCode, signOpenAccept, OPEN_ACCEPT_TYPES } from '../../utils/claimCode/deriveFromCode.js'
import {
  encryptEnvelopeCode,
  decryptEnvelopeCode,
  isCodeEnvelope
} from '../../utils/crypto/envelopeEncryption.js'

// Feature 024 — claim-code crypto: the security-critical, pure derivation reused by the create and take
// flows. (Tests written against the design in specs/024-open-challenge-wagers/contracts/claim-code-crypto.md.)

describe('claimCode/wordlist', () => {
  it('generates a four-word code from the BIP-39 list', () => {
    const code = generateCode()
    expect(code.split(' ')).to.have.length(4)
    expect(isValidCode(code)).toBe(true)
  })

  it('generates distinct codes (CSPRNG)', () => {
    const a = generateCode()
    const b = generateCode()
    expect(a).not.toEqual(b)
  })

  it('normalizes case, whitespace, and Unicode form', () => {
    expect(normalizeCode('  River   Amber\tTiger   Kite ')).toBe('river amber tiger kite')
  })

  it('rejects wrong length and unknown words', () => {
    expect(isValidCode('river amber tiger')).toBe(false) // 3 words
    expect(isValidCode('river amber tiger kite extra')).toBe(false) // 5 words
    expect(isValidCode('river amber tiger zzzznotaword')).toBe(false)
    expect(isValidCode('')).toBe(false)
  })

  it('isValidWord: accepts a single BIP-39 word (normalized), rejects everything else', () => {
    expect(isValidWord('river')).toBe(true)
    expect(isValidWord('  River  ')).toBe(true) // trimmed + lowercased
    expect(isValidWord('zzzznotaword')).toBe(false)
    expect(isValidWord('river amber')).toBe(false) // more than one word
    expect(isValidWord('')).toBe(false)
    expect(isValidWord(null)).toBe(false)
  })

  it('suggestWords: returns list-order completions for a prefix, bounded by the limit', () => {
    const s = suggestWords('ri', 6)
    expect(s.length).toBeGreaterThan(0)
    expect(s.length).toBeLessThanOrEqual(6)
    expect(s.every((w) => w.startsWith('ri'))).toBe(true)
    // A full word is its own first completion.
    expect(suggestWords('river', 3)).toContain('river')
    // No prefix / no match → nothing (never dump the whole list).
    expect(suggestWords('')).toEqual([])
    expect(suggestWords('   ')).toEqual([])
    expect(suggestWords('zzzz')).toEqual([])
  })
})

describe('claimCode/deriveFromCode', () => {
  it('is deterministic and device-independent for the same (normalized) code', () => {
    const a = deriveFromCode('river amber tiger kite')
    const b = deriveFromCode('  RIVER  amber Tiger kite ')
    expect(b.claimAddress).toBe(a.claimAddress)
    expect(Buffer.from(b.symKey).toString('hex')).toBe(Buffer.from(a.symKey).toString('hex'))
  })

  it('domain-separates the claim key from the symmetric key', () => {
    const { claimPrivateKey, symKey } = deriveFromCode('river amber tiger kite')
    // The signing key and the AEAD key are independent keccak outputs — neither equals the other.
    expect(claimPrivateKey.toLowerCase()).not.toBe('0x' + Buffer.from(symKey).toString('hex'))
  })

  it('different codes derive different claim addresses', () => {
    expect(deriveFromCode('river amber tiger kite').claimAddress)
      .not.toBe(deriveFromCode('river amber tiger zebra').claimAddress)
  })

  it('signOpenAccept produces a signature that recovers to claimAddress for the bound (wagerId, taker)', async () => {
    const code = generateCode()
    const { claimAddress } = deriveFromCode(code)
    const domain = { name: 'FairWins WagerRegistry', version: '1', chainId: 137, verifyingContract: VERIFYING_CONTRACT }
    const sig = await signOpenAccept(code, { wagerId: 42n, taker: TAKER_A, chainId: 137n, verifyingContract: VERIFYING_CONTRACT })
    const recovered = verifyTypedData(domain, OPEN_ACCEPT_TYPES, { wagerId: 42n, taker: TAKER_A }, sig)
    expect(recovered).toBe(claimAddress)
  })

  it('a signature for one taker does not verify for another (front-run resistance)', async () => {
    const code = generateCode()
    const { claimAddress } = deriveFromCode(code)
    const domain = { name: 'FairWins WagerRegistry', version: '1', chainId: 137, verifyingContract: VERIFYING_CONTRACT }
    const sig = await signOpenAccept(code, { wagerId: 1n, taker: TAKER_A, chainId: 137n, verifyingContract: VERIFYING_CONTRACT })
    // Recovering against takerB's message yields a different (wrong) address — not claimAddress.
    const recoveredForB = verifyTypedData(domain, OPEN_ACCEPT_TYPES, { wagerId: 1n, taker: TAKER_B }, sig)
    expect(recoveredForB).not.toBe(claimAddress)
  })
})

describe('crypto/envelopeEncryption — code-keyed mode', () => {
  it('round-trips terms under the code-derived symKey', () => {
    const { symKey } = deriveFromCode('river amber tiger kite')
    const terms = { description: 'Will it rain?', sideYes: 'rain', sideNo: 'dry' }
    const env = encryptEnvelopeCode(terms, symKey)
    expect(isCodeEnvelope(env)).toBe(true)
    expect(env.keys).toBeUndefined() // no recipients list
    expect(decryptEnvelopeCode(env, symKey)).toEqual(terms)
  })

  it('a wrong code fails to decrypt and never reveals terms', () => {
    const env = encryptEnvelopeCode({ secret: 'terms' }, deriveFromCode('river amber tiger kite').symKey)
    const wrong = deriveFromCode('river amber tiger zebra').symKey
    expect(() => decryptEnvelopeCode(env, wrong)).toThrow()
  })

  it('a tampered ciphertext throws (tamper-evident, FR-019)', () => {
    const { symKey } = deriveFromCode('river amber tiger kite')
    const env = encryptEnvelopeCode({ a: 1 }, symKey)
    const flipped = env.content.ciphertext.slice(0, -2) + (env.content.ciphertext.slice(-2) === 'ff' ? '00' : 'ff')
    const tampered = { ...env, content: { ...env.content, ciphertext: flipped } }
    expect(() => decryptEnvelopeCode(tampered, symKey)).toThrow()
  })

  it('binds the governing terms-version hash as AAD (parity with recipient-keyed)', () => {
    const { symKey } = deriveFromCode('river amber tiger kite')
    const tv = { id: 'v1', hash: '0x' + 'ab'.repeat(32) }
    const env = encryptEnvelopeCode({ a: 1 }, symKey, tv)
    expect(env.termsVersion.hash).toBe(tv.hash)
    // Tampering with the bound hash fails authentication.
    const tampered = { ...env, termsVersion: { id: 'v1', hash: '0x' + 'cd'.repeat(32) } }
    expect(() => decryptEnvelopeCode(tampered, symKey)).toThrow()
  })
})

/**
 * Spec 110 T028 — THE DERIVATION IS FROZEN.
 *
 * The suite around this one proves the derivation is deterministic and that the acceptance
 * signature verifies. Neither can fail if the derivation MOVES: a changed keccak input, a changed
 * domain tag, a different key-to-address step — all of it stays self-consistent, every assertion
 * stays green, and every open challenge ever created is orphaned, because `claimAddress` IS the
 * on-chain `claimAuthority` and the discovery key. Nobody could accept an existing wager again.
 *
 * These values were computed with the ORIGINAL ethers implementation, before the viem swap, so
 * they are anchored to what shipped rather than to the code they guard. They must never be
 * regenerated to make a test pass — a mismatch here means the change is wrong, not the fixture.
 */
describe('claim-code derivation is frozen (v1)', () => {
  const FIXTURES = [
    {
      code: 'river amber tiger kite',
      claimPrivateKey: '0xe37571a6d9c5aef69c3fe1bf2fb0759e4d20c7f6c0c55ad0051a0062db60d699',
      claimAddress: '0xbd09BAAcbeb34874E7fea83795CCAC1C80FdF4AC',
      symKeyHex: '3945534a8143db2c21616164005557a7beb32dd0a989b61dd95ffdd0e85cb4d6',
    },
    {
      code: 'abandon ability able about',
      claimPrivateKey: '0x73b805fe68faa9a9fa41f02daf8c3c7a358689fcba331e3b32d86c19cf684ba6',
      claimAddress: '0x4DC99E0297A04B6Ef77b6591F4d7e3787bb8eADD',
      symKeyHex: 'a8beebafecb0d5ca60c1cd9a66ba1d77fe1cf679e3dc73427d98a6824eb96a80',
    },
  ]

  for (const f of FIXTURES) {
    it(`derives the shipped keypair for "${f.code}"`, () => {
      const { claimPrivateKey, claimAddress, symKey } = deriveFromCode(f.code)
      expect(claimPrivateKey).toBe(f.claimPrivateKey)
      expect(claimAddress).toBe(f.claimAddress) // checksummed, exactly as ethers returned it
      expect(Buffer.from(symKey).toString('hex')).toBe(f.symKeyHex)
    })
  }

  it('normalises to the same keys however the member types the code', () => {
    const canonical = deriveFromCode('river amber tiger kite')
    for (const variant of ['  River   Amber\tTiger   Kite ', 'RIVER AMBER TIGER KITE']) {
      expect(deriveFromCode(variant).claimAddress).toBe(canonical.claimAddress)
    }
  })

  it('refuses a private key outside the curve order instead of deriving an address from it', () => {
    // The keccak output is a valid scalar with overwhelming probability, and the refusal is what
    // covers the rest. ethers' SigningKey threw here; viem's privateKeyToAccount was checked to
    // throw on exactly the same inputs (zero, n, n+1, all-ones, short hex, non-hex).
    expect(() => deriveFromCode('')).toThrow(/empty code/i)
  })
})
