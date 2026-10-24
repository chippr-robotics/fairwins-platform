/**
 * Issue #1670 — @noble/ciphers 1.x → 2.x must not strand ciphertext members already hold.
 *
 * The fixture was produced by our own encrypt functions under @noble/ciphers 1.3.0 and is FROZEN.
 * Every entry is decrypted here with the CURRENT code and must yield byte-exact plaintext; if this
 * fails after a dependency change, the change is wrong — never the fixture.
 */
import { describe, it, expect } from 'vitest'
import { NOBLE_CIPHERS_1X_FIXTURE as FX } from '../fixtures/nobleCiphers1xCiphertexts.js'
import {
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
  bytesToUtf8,
  randomBytes
} from '../../utils/crypto/primitives'
import {
  deriveKeyPairFromSeed,
  deriveXWingKeyPairFromSeed,
  encryptEnvelope,
  decryptEnvelope,
  encryptEnvelopeXWing,
  decryptEnvelopeXWing,
  decryptEnvelopeUnified,
  encryptEnvelopeCode,
  decryptEnvelopeCode
} from '../../utils/crypto/envelopeEncryption'
import { encryptBundle, decryptBundle } from '../../lib/backup/backupCrypto'
import { sha256 } from '@noble/hashes/sha2.js'

const seedOf = (b) => new Uint8Array(32).fill(b)
const aadOf = (s) => (s === null ? undefined : utf8ToBytes(s))
const recipientFor = (address) => FX.recipients.find((r) => r.address === address)

describe('@noble/ciphers 1.x ciphertext still decrypts (issue #1670)', () => {
  it('fixture was generated under 1.3.0 and covers every path', () => {
    expect(FX.nobleCiphersVersion).toBe('1.3.0')
    expect(FX.primitives.map((p) => p.name)).toEqual([
      'encrypt/no-aad',
      'encrypt/aad',
      'encryptJson/no-aad',
      'encryptJson/aad:backup',
      'encryptJson/aad:code-vault',
      'encryptJson/aad:address-book-legacy'
    ])
    expect(FX.envelopes.map((e) => e.name)).toEqual([
      'x25519',
      'x25519/terms-aad',
      'x25519/string',
      'x25519/addRecipient',
      'xwing',
      'xwing/terms-aad',
      'xwing/addRecipient'
    ])
    expect(FX.codeEnvelopes).toHaveLength(3)
  })

  it.each(FX.primitives.filter((p) => p.fn === 'decrypt').map((p) => [p.name, p]))(
    'primitives.decrypt: %s',
    (_name, p) => {
      const args = [hexToBytes(p.keyHex), hexToBytes(p.nonce), hexToBytes(p.ciphertext)]
      const pt = p.aad === null ? decrypt(...args) : decrypt(...args, aadOf(p.aad))
      expect(bytesToHex(pt)).toBe(bytesToHex(utf8ToBytes(p.plaintextUtf8)))
      expect(bytesToUtf8(pt)).toBe(p.plaintextUtf8)
    }
  )

  it.each(FX.primitives.filter((p) => p.fn === 'decryptJson').map((p) => [p.name, p]))(
    'primitives.decryptJson: %s',
    (_name, p) => {
      const key = hexToBytes(p.keyHex)
      const out = p.aad === null
        ? decryptJson(key, p.nonce, p.ciphertext)
        : decryptJson(key, p.nonce, p.ciphertext, aadOf(p.aad))
      expect(out).toEqual(p.plaintextJson)
    }
  )

  it('AAD is still enforced on 1.x ciphertext (wrong AAD fails authentication)', () => {
    const p = FX.primitives.find((e) => e.name === 'encryptJson/aad:backup')
    expect(() =>
      decryptJson(hexToBytes(p.keyHex), p.nonce, p.ciphertext, utf8ToBytes('fairwins-data-backup:2'))
    ).toThrow()
    expect(() => decryptJson(hexToBytes(p.keyHex), p.nonce, p.ciphertext)).toThrow()
  })

  it('spec-032 backup bundle (backupCrypto.decryptBundle)', () => {
    const { keyHex, envelope, plaintextJson } = FX.backupBundle
    expect(decryptBundle(hexToBytes(keyHex), envelope)).toEqual(plaintextJson)
  })

  it('recipient keypairs still derive to the same public keys', () => {
    for (const r of FX.recipients) {
      expect(bytesToHex(deriveKeyPairFromSeed(seedOf(r.seedByte)).publicKey)).toBe(r.x25519PublicKey)
      expect(bytesToHex(sha256(deriveXWingKeyPairFromSeed(seedOf(r.seedByte)).publicKey))).toBe(
        r.xwingPublicKeySha256
      )
    }
  })

  it.each(FX.envelopes.map((e) => [e.name, e]))('envelope: %s', (_name, e) => {
    for (const address of e.readers) {
      const seed = seedOf(recipientFor(address).seedByte)
      const expected = 'plaintextString' in e ? e.plaintextString : e.plaintextJson
      if (e.kind === 'x25519') {
        const { privateKey } = deriveKeyPairFromSeed(seed)
        expect(decryptEnvelope(e.envelope, address, privateKey)).toEqual(expected)
        expect(decryptEnvelopeUnified(e.envelope, address, { x25519PrivateKey: privateKey })).toEqual(expected)
      } else {
        const { secretKey } = deriveXWingKeyPairFromSeed(seed)
        expect(decryptEnvelopeXWing(e.envelope, address, secretKey)).toEqual(expected)
        expect(decryptEnvelopeUnified(e.envelope, address, { xwingSecretKey: secretKey })).toEqual(expected)
      }
    }
  })

  it('terms AAD on 1.x envelopes is still enforced (tampered termsVersion fails)', () => {
    const e = FX.envelopes.find((x) => x.name === 'x25519/terms-aad')
    const tampered = { ...e.envelope, termsVersion: { ...e.envelope.termsVersion, hash: '0x' + 'cd'.repeat(32) } }
    const { privateKey } = deriveKeyPairFromSeed(seedOf(recipientFor(e.readers[0]).seedByte))
    expect(() => decryptEnvelope(tampered, e.readers[0], privateKey)).toThrow()
  })

  it.each(FX.codeEnvelopes.map((c) => [c.name, c]))('code envelope (xchacha20poly1305): %s', (_name, c) => {
    const expected = 'plaintextString' in c ? c.plaintextString : c.plaintextJson
    expect(decryptEnvelopeCode(c.envelope, hexToBytes(c.symKeyHex))).toEqual(expected)
  })

  it('code envelope with terms AAD rejects a tampered termsVersion and a wrong key', () => {
    const c = FX.codeEnvelopes.find((x) => x.name === 'code/xchacha/terms-aad')
    const tampered = { ...c.envelope, termsVersion: { ...c.envelope.termsVersion, hash: '0x' + 'cd'.repeat(32) } }
    expect(() => decryptEnvelopeCode(tampered, hexToBytes(c.symKeyHex))).toThrow()
    expect(() => decryptEnvelopeCode(c.envelope, seedOf(0x56))).toThrow()
  })
})

describe('fresh round-trip on the current library', () => {
  const key = randomBytes(32)
  const terms = { id: 'tos-rt', hash: '0x' + 'ef'.repeat(32) }
  const data = { hello: 'world', n: 42, s: 'ünïcødé ✓' }

  it('randomBytes returns fresh Uint8Arrays of the requested length', () => {
    const a = randomBytes(24)
    expect(a).toBeInstanceOf(Uint8Array)
    expect(a).toHaveLength(24)
    expect(bytesToHex(a)).not.toBe(bytesToHex(randomBytes(24)))
  })

  it('encrypt/decrypt with and without AAD', () => {
    const pt = utf8ToBytes('round trip ✓')
    const a = encrypt(key, pt)
    expect(bytesToHex(decrypt(key, a.nonce, a.ciphertext))).toBe(bytesToHex(pt))
    const aad = utf8ToBytes('rt-aad')
    const b = encrypt(key, pt, aad)
    expect(bytesToHex(decrypt(key, b.nonce, b.ciphertext, aad))).toBe(bytesToHex(pt))
    expect(() => decrypt(key, b.nonce, b.ciphertext)).toThrow()
  })

  it('encryptJson/decryptJson and the backup bundle', () => {
    const aad = utf8ToBytes('fairwins-oc-code-vault:1')
    const r = encryptJson(key, data, aad)
    expect(decryptJson(key, r.nonce, r.ciphertext, aad)).toEqual(data)
    expect(decryptBundle(key, encryptBundle(key, data))).toEqual(data)
  })

  it('X25519 and X-Wing envelopes, with and without terms AAD', () => {
    const a = deriveKeyPairFromSeed(seedOf(0x61))
    const xa = deriveXWingKeyPairFromSeed(seedOf(0x61))
    const address = '0x' + '6'.repeat(40)
    for (const t of [null, terms]) {
      const env = encryptEnvelope(data, [{ address, publicKey: a.publicKey }], undefined, t)
      expect(decryptEnvelope(env, address, a.privateKey)).toEqual(data)
      const wenv = encryptEnvelopeXWing(data, [{ address, publicKey: xa.publicKey }], undefined, t)
      expect(decryptEnvelopeXWing(wenv, address, xa.secretKey)).toEqual(data)
    }
  })

  it('code envelopes, with and without terms AAD', () => {
    for (const t of [null, terms]) {
      expect(decryptEnvelopeCode(encryptEnvelopeCode(data, key, t), key)).toEqual(data)
    }
  })
})
