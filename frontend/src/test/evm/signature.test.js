/**
 * `lib/evm/signature.js#splitSignature` — the one place the repo takes a signature apart.
 *
 * ethers is used here ON PURPOSE as the oracle: this is a live cross-library check over the exact
 * function that was replaced (`ethers.Signature.from`), so rewriting these assertions in viem would
 * delete the check while looking like a modernisation. This file is under src/test/**, outside the
 * import ratchet.
 *
 * The two properties that matter are the two ways viem's `parseSignature` is wrong for this job,
 * and neither is caught by a test that only checks a good 65-byte signature round-trips:
 *   · the 64-byte EIP-2098 COMPACT form must split, because viem refuses it outright; and
 *   · `v` must be a NUMBER, because viem returns a bigint and this value is serialized into an
 *     EIP-3009 authorization handed to a relayer, where `JSON.stringify` throws on a bigint.
 */
import { describe, it, expect } from 'vitest'
import { Signature, Wallet } from 'ethers'
import { splitSignature } from '../../lib/evm/signature'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const wallet = new Wallet(KEY)

// A spread of real signatures — the parity bit and the leading bytes of r/s vary across messages,
// which is what exercises the padding and the top-bit packing.
const signatures = await Promise.all(
  Array.from({ length: 24 }, (_, i) => wallet.signMessage(`fairwins signature parity case ${i}`)),
)

describe('splitSignature', () => {
  it('agrees with ethers on r, s and v for the 65-byte form', () => {
    for (const hex of signatures) {
      const e = Signature.from(hex)
      expect(splitSignature(hex)).toMatchObject({ r: e.r, s: e.s, v: e.v })
    }
  })

  it('agrees with ethers on the 64-byte EIP-2098 COMPACT form, which viem refuses outright', () => {
    for (const hex of signatures) {
      const compact = Signature.from(hex).compactSerialized
      expect(compact).toHaveLength(130) // 0x + 64 bytes
      const e = Signature.from(compact)
      expect(splitSignature(compact)).toMatchObject({ r: e.r, s: e.s, v: e.v })
    }
  })

  it('returns v as a NUMBER, not a bigint — the value is serialized onto the wire', () => {
    const parts = splitSignature(signatures[0])
    expect(typeof parts.v).toBe('number')
    expect([27, 28]).toContain(parts.v)
    // The failure this guards: an authorization object carrying a bigint v cannot be sent.
    expect(() => JSON.stringify(parts)).not.toThrow()
  })

  it('reports yParity as 0/1 for @noble/curves, alongside the 27/28 v for the wire', () => {
    for (const hex of signatures) {
      const parts = splitSignature(hex)
      expect([0, 1]).toContain(parts.yParity)
      expect(parts.v).toBe(27 + parts.yParity)
    }
  })

  it('returns null rather than throwing or guessing for anything that is not a signature', () => {
    // A 900-byte WebAuthn envelope reaching here is expected, not exceptional (spec 084).
    for (const bad of ['', '0x', '0xzz', '0x' + 'ab'.repeat(10), '0x' + 'ab'.repeat(200), 'nothex', null, undefined, 42, {}]) {
      expect(splitSignature(bad)).toBeNull()
    }
  })

  it('rejects a 65-byte blob whose recovery byte is neither 27, 28, 0 nor 1', () => {
    const hex = signatures[0].slice(0, -2) + '07'
    expect(splitSignature(hex)).toBeNull()
  })
})
