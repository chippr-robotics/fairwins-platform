// Spec 043 (US2) — hub client integrity + payload fallback. The security property is that a proposal read
// from the hub is only trusted if its recomputed hash matches the emitted one; a tampered preimage is rejected.

import { describe, it, expect, vi } from 'vitest'
// ethers is kept here ON PURPOSE as a live cross-library check over the exact encoder and the exact
// hex formatter this module was converted off (spec 110 T028). Converting these assertions to viem
// would make them tautological — viem agreeing with itself — so they would delete the check while
// looking like a modernisation. This file is under src/test/**, outside the import ratchet.
import { Interface, toBeHex as ethersToBeHex } from 'ethers'
import {
  cancelProposal,
  cancelProposalCall,
  emitProposal,
  emitProposalCall,
  reconstructProposal,
  verifyProposal,
  encodePayloadLink,
  parsePayloadLink,
} from '../../lib/custody/proposalHub'
import { SAFE_PROPOSAL_HUB_ABI } from '../../abis/SafeProposalHub'
import { buildSafeTx, computeSafeTxHash } from '../../lib/custody/vaultTransaction'

const SAFE = '0x1111111111111111111111111111111111111111'
const PROPOSER = '0x2222222222222222222222222222222222222222'
const TO = '0x3333333333333333333333333333333333333333'
const CHAIN = 63

function proposedArgs(overridesHash) {
  const safeTx = buildSafeTx({ to: TO, value: 1000n, nonce: 5 })
  const safeTxHash = overridesHash ?? computeSafeTxHash(SAFE, CHAIN, safeTx)
  return {
    safe: SAFE,
    proposer: PROPOSER,
    safeTxHash,
    to: safeTx.to,
    value: safeTx.value,
    data: safeTx.data,
    operation: safeTx.operation,
    nonce: safeTx.nonce,
  }
}

describe('reconstructProposal + verifyProposal', () => {
  it('verifies a proposal whose emitted hash matches its parameters', () => {
    const p = reconstructProposal(proposedArgs())
    expect(verifyProposal(p, CHAIN)).toBe(true)
  })

  it('rejects a proposal whose emitted hash does not match (tampered preimage)', () => {
    const bad = reconstructProposal(proposedArgs('0x' + 'de'.repeat(32)))
    expect(verifyProposal(bad, CHAIN)).toBe(false)
  })

  it('rejects a correct hash checked against the wrong chain', () => {
    const p = reconstructProposal(proposedArgs())
    expect(verifyProposal(p, 137)).toBe(false) // hash is chain-scoped
  })
})

describe('payload link fallback', () => {
  it('round-trips a SafeTx and preserves the verifiable hash', () => {
    const safeTx = buildSafeTx({ to: TO, value: 4200n, data: '0xabcd', nonce: 7 })
    const link = encodePayloadLink(SAFE, safeTx, CHAIN)
    expect(typeof link).toBe('string')
    const parsed = parsePayloadLink(link)
    expect(parsed.safe).toBe(SAFE)
    expect(parsed.chainId).toBe(CHAIN)
    // The reconstructed tx must produce the same hash the proposer would have signed.
    expect(computeSafeTxHash(parsed.safe, parsed.chainId, parsed.safeTx)).toBe(
      computeSafeTxHash(SAFE, CHAIN, safeTx),
    )
  })

  it('round-trips across data lengths that exercise base64 padding', () => {
    // Vary calldata length so the encoded payload lands on each of the 4 base64 padding remainders.
    for (let n = 0; n < 6; n += 1) {
      const safeTx = buildSafeTx({ to: TO, value: BigInt(n), data: '0x' + 'ab'.repeat(n), nonce: n })
      const parsed = parsePayloadLink(encodePayloadLink(SAFE, safeTx, CHAIN))
      expect(computeSafeTxHash(parsed.safe, parsed.chainId, parsed.safeTx)).toBe(
        computeSafeTxHash(SAFE, CHAIN, safeTx),
      )
    }
  })

  it('rejects an unrecognized payload', () => {
    const bad = Buffer.from(JSON.stringify({ schema: 'nope' }), 'utf8').toString('base64')
    expect(() => parsePayloadLink(bad)).toThrow(/Unrecognized/)
  })
})

/**
 * Spec 110 T028 — off ethers, and the two things that could have changed silently.
 *
 * (1) The broadcasts used to carry a SECOND, hand-maintained copy of the propose/cancel argument
 *     list, separate from the pure `…Call` twins. They now send the twins' own bytes, so there is
 *     one encoder and one argument order; these assertions pin those bytes against the ethers
 *     Interface that produced them before.
 * (2) `encodePayloadLink` is a WIRE FORMAT handed to another person's device, and viem's `toHex`
 *     is not ethers' `toBeHex`: ethers pads to whole bytes, viem emits minimal nibbles. Everything
 *     round-trips through BigInt either way, so nothing would have broken — but a link is a string
 *     other code may compare or key on, so it is held byte-exact and that is what is checked.
 */
describe('proposalHub — the ethers→viem swap changed no bytes', () => {
  const iface = new Interface(SAFE_PROPOSAL_HUB_ABI)
  const HUB = '0x4444444444444444444444444444444444444444'

  it('emits the calldata the ethers Interface produced, across the value/data/nonce extremes', () => {
    for (const [value, data, operation, nonce] of [
      [0n, '0x', 0, 0n],
      [10n ** 21n, '0x' + 'cd'.repeat(500), 1, 4095n],
      [1n, '0x00', 0, 1n],
    ]) {
      const safeTx = buildSafeTx({ to: TO, value, data, operation, nonce })
      const safeTxHash = computeSafeTxHash(SAFE, CHAIN, safeTx)
      const call = emitProposalCall({ hubAddress: HUB, safe: SAFE, safeTx, safeTxHash })
      expect(call.data).toBe(
        iface.encodeFunctionData('propose', [
          SAFE, safeTx.to, safeTx.value, safeTx.data, safeTx.operation, safeTx.nonce, safeTxHash,
        ]),
      )
      expect(cancelProposalCall({ hubAddress: HUB, safe: SAFE, safeTxHash }).data).toBe(
        iface.encodeFunctionData('cancel', [SAFE, safeTxHash]),
      )
    }
  })

  it('broadcasts exactly those bytes — the signer sees the twin, not a second argument list', async () => {
    const safeTx = buildSafeTx({ to: TO, value: 7n, nonce: 3n })
    const safeTxHash = computeSafeTxHash(SAFE, CHAIN, safeTx)
    const signer = { sendTransaction: vi.fn(async () => ({ hash: '0xtx' })) }

    await emitProposal({ hubAddress: HUB, safe: SAFE, safeTx, safeTxHash, signer })
    expect(signer.sendTransaction).toHaveBeenCalledWith({
      to: emitProposalCall({ hubAddress: HUB, safe: SAFE, safeTx, safeTxHash }).target,
      data: emitProposalCall({ hubAddress: HUB, safe: SAFE, safeTx, safeTxHash }).data,
    })

    await cancelProposal({ hubAddress: HUB, safe: SAFE, safeTxHash, signer })
    expect(signer.sendTransaction).toHaveBeenLastCalledWith({
      to: cancelProposalCall({ hubAddress: HUB, safe: SAFE, safeTxHash }).target,
      data: cancelProposalCall({ hubAddress: HUB, safe: SAFE, safeTxHash }).data,
    })
  })

  it('serializes the payload link byte-for-byte as before, padding to whole bytes like ethers did', () => {
    // 0n, 15n and 256n are the cases where viem's toHex diverges (0x0 / 0xf / 0x100).
    for (const [value, nonce] of [[0n, 0n], [15n, 15n], [256n, 256n], [10n ** 21n, 4095n]]) {
      const safeTx = buildSafeTx({ to: TO, value, nonce })
      const link = encodePayloadLink(SAFE, safeTx, CHAIN)
      const tx = JSON.parse(atob(link.replace(/-/g, '+').replace(/_/g, '/'))).tx
      expect(tx.value).toBe(ethersToBeHex(value))
      expect(tx.nonce).toBe(ethersToBeHex(safeTx.nonce))
      // …and it still round-trips, which is the property the format actually exists for.
      expect(parsePayloadLink(link).safeTx.value).toBe(value)
    }
  })
})

