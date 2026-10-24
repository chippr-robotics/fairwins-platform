/**
 * The passkey signer's two byte-producing pieces (spec 041 T030, converted in spec 110 T028):
 * the WebAuthn signature envelope and the EIP-712 digest.
 *
 * These bytes are verified ON CHAIN by `SignerIntentBase.erc1271` and by the gateway's ERC-1271
 * fallback, neither of which runs in this tier — so if the encoding drifted, the frontend suite
 * would stay green and the failure would surface as a rejected signature in production.
 *
 * ethers is the oracle here ON PURPOSE: a live cross-library check over the exact encoder
 * (`AbiCoder.defaultAbiCoder`) and hasher (`TypedDataEncoder.hash`) that were replaced. Rewriting
 * these in viem would assert that viem agrees with itself. This file is under src/test/**, outside
 * the import ratchet.
 */
import { describe, it, expect } from 'vitest'
import { AbiCoder, TypedDataEncoder } from 'ethers'
import { encodeWebAuthnSignature } from '../../lib/passkey/intentSigner'
import { hashTypedDataLike, primaryTypeOf } from '../../lib/evm/typedData'
import { INTENT_TYPES, RECEIVE_WITH_AUTHORIZATION_TYPES } from '@fairwins/intent-types'

const abi = AbiCoder.defaultAbiCoder()
const WEBAUTHN_AUTH_TUPLE =
  'tuple(bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)'
const SIGNATURE_WRAPPER_TUPLE = 'tuple(uint256 ownerIndex, bytes signatureData)'

const bytes = (hex) => Uint8Array.from(hex.match(/.{2}/g), (b) => parseInt(b, 16))

/** A minimal DER ECDSA signature with the given r and s, both 32 bytes. */
function der(r, s) {
  const int = (v) => {
    const body = v.toString(16).padStart(64, '0')
    const lead = parseInt(body.slice(0, 2), 16) >= 0x80 ? '00' : ''
    const h = lead + body
    return '02' + (h.length / 2).toString(16).padStart(2, '0') + h
  }
  const payload = int(r) + int(s)
  return bytes('30' + (payload.length / 2).toString(16).padStart(2, '0') + payload)
}

describe('encodeWebAuthnSignature — envelope bytes', () => {
  const cases = [
    {
      name: 'minimal',
      clientDataJSON: '{"type":"webauthn.get","challenge":"AA"}',
      authenticatorData: '00'.repeat(37),
      r: 1n,
      s: 2n,
      ownerIndex: 0,
    },
    {
      name: 'realistic',
      clientDataJSON:
        '{"type":"webauthn.get","challenge":"dGVzdA","origin":"https://fairwins.app","crossOrigin":false}',
      authenticatorData: 'ab'.repeat(37),
      r: 0xdeadbeefcafen,
      s: 0x1234n,
      ownerIndex: 3,
    },
    {
      name: 'unicode client data and a long authenticator blob',
      clientDataJSON: '{"type":"webauthn.get","challenge":"AA","origin":"https://é漢.app"}',
      authenticatorData: 'ff'.repeat(300),
      r: 2n ** 240n + 7n,
      s: 5n,
      ownerIndex: 1,
    },
  ]

  for (const c of cases) {
    it(`matches the ethers AbiCoder — ${c.name}`, () => {
      const assertion = {
        signature: der(c.r, c.s),
        authenticatorData: bytes(c.authenticatorData),
        clientDataJSON: new TextEncoder().encode(c.clientDataJSON),
      }
      const got = encodeWebAuthnSignature({ assertion, ownerIndex: c.ownerIndex })

      const auth = {
        authenticatorData: '0x' + c.authenticatorData,
        clientDataJSON: c.clientDataJSON,
        challengeIndex: c.clientDataJSON.indexOf('"challenge"'),
        typeIndex: c.clientDataJSON.indexOf('"type"'),
        r: c.r,
        s: c.s,
      }
      const expected = abi.encode(
        [SIGNATURE_WRAPPER_TUPLE],
        [{ ownerIndex: c.ownerIndex, signatureData: abi.encode([WEBAUTHN_AUTH_TUPLE], [auth]) }],
      )
      expect(got).toBe(expected)
    })
  }
})

describe('hashTypedDataLike — the digest, and the primary type viem will not infer', () => {
  const DOMAIN = {
    name: 'FairWins WagerRegistry',
    version: '1',
    chainId: 137,
    verifyingContract: '0x2222222222222222222222222222222222222222',
  }

  it('infers the same primary type as ethers for every real intent table', () => {
    const tables = [
      ...Object.entries(INTENT_TYPES).map(([name, fields]) => ({ [name]: fields })),
      RECEIVE_WITH_AUTHORIZATION_TYPES,
    ]
    expect(tables.length).toBeGreaterThan(10) // guard against silently checking nothing
    for (const types of tables) {
      expect(primaryTypeOf(types)).toBe(TypedDataEncoder.from(types).primaryType)
    }
  })

  it('picks the ROOT of a nested table, not whichever key was declared first', () => {
    // The failure this exists for: `Object.keys(types)[0]` here is `Inner`, and hashing against a
    // sub-type yields a valid signature over the wrong structure.
    const types = {
      Inner: [{ name: 'x', type: 'uint256' }],
      Outer: [
        { name: 'actor', type: 'address' },
        { name: 'inner', type: 'Inner' },
      ],
    }
    expect(Object.keys(types)[0]).toBe('Inner')
    expect(primaryTypeOf(types)).toBe('Outer')

    const message = { actor: '0x3333333333333333333333333333333333333333', inner: { x: 3n } }
    expect(hashTypedDataLike(DOMAIN, types, message)).toBe(TypedDataEncoder.hash(DOMAIN, types, message))
  })

  it('handles an array of a sub-type and a two-level table', () => {
    const mail = {
      Person: [{ name: 'wallet', type: 'address' }],
      Mail: [
        { name: 'from', type: 'Person' },
        { name: 'to', type: 'Person[]' },
      ],
    }
    expect(primaryTypeOf(mail)).toBe('Mail')
    expect(primaryTypeOf({
      Leaf: [{ name: 'v', type: 'uint256' }],
      Mid: [{ name: 'leaf', type: 'Leaf' }],
      Top: [{ name: 'mid', type: 'Mid' }],
    })).toBe('Top')
  })

  it('hashes a real intent identically to ethers', () => {
    const types = { CancelOpenIntent: INTENT_TYPES.CancelOpenIntent }
    expect(types.CancelOpenIntent).toBeTruthy()
    const message = {
      wagerId: 5n,
      actor: '0x3333333333333333333333333333333333333333',
      nonce: `0x${'ab'.repeat(32)}`,
      validAfter: 0n,
      validBefore: 1893456000n,
    }
    expect(hashTypedDataLike(DOMAIN, types, message)).toBe(TypedDataEncoder.hash(DOMAIN, types, message))
  })

  it('REFUSES an ambiguous table rather than guessing a root, exactly as ethers refused', () => {
    const ambiguous = { A: [{ name: 'x', type: 'uint256' }], B: [{ name: 'y', type: 'uint256' }] }
    expect(primaryTypeOf(ambiguous)).toBeNull()
    expect(() => hashTypedDataLike(DOMAIN, ambiguous, { x: 1n })).toThrow(/nothing has been signed/i)
    expect(() => TypedDataEncoder.from(ambiguous)).toThrow()
  })

  it('answers for a table that declares EIP712Domain, where ethers threw — the one deliberate difference', () => {
    const types = {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'chainId', type: 'uint256' },
      ],
      Thing: [{ name: 'x', type: 'uint256' }],
    }
    expect(primaryTypeOf(types)).toBe('Thing')
    expect(() => TypedDataEncoder.from(types)).toThrow(/ambiguous|unused/i)
  })
})
