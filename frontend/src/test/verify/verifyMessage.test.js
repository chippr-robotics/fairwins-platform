/**
 * Protect ▸ Verify — verification semantics.
 *
 * Organised around the THREE outcomes, because the bug this feature can actually ship is collapsing
 * them into two: an unreachable node reported as a forged signature. Every network-failure path
 * below asserts `unverifiable`, never `invalid`.
 *
 * The split matters as much as the outcomes. `verifyMessage` is OFFLINE and synchronous — checking
 * a signature against a public key is arithmetic — and `verifyOnChain` is the explicit escalation
 * for the one thing arithmetic cannot answer: whether a CONTRACT account, which has no public key,
 * stands behind the bytes. The first suite below asserts the offline function cannot reach a
 * network even when handed one.
 */

import { describe, it, expect, vi } from 'vitest'
import { ethers } from 'ethers'
import {
  verifyMessage,
  verifyOnChain,
  verifySignedMessage,
  checkErc1271,
  recoverPersonalSigner,
  VERIFY_STATUS,
  ERC1271_MAGIC,
} from '../../lib/verify/verifyMessage'
import {
  MESSAGE,
  AWKWARD_MESSAGE,
  SIGNATURE,
  AWKWARD_SIGNATURE,
  SIGNER_ADDRESS,
  SIGNER_KEY,
  OTHER_ADDRESS,
  CONTRACT_ACCOUNT,
  CONTRACT_ACCOUNT_CHAIN_ID,
  ERC1271_SIGNATURE,
  EIP191_DOCUMENT,
  ERC1271_DOCUMENT,
  stubProvider,
} from '../fixtures/signedMessages'

// No test may fall through to a real network route; the ERC-1271 leg always takes an injected
// provider here, and this makes an accidental omission fail loudly rather than hang.
//
// Mocked at the CHAIN SEAM since spec 110 — the module resolves through `getPublicClient(chainId)`
// now, and a guard left on the retired `utils/rpcProvider` would still LOOK like it was protecting
// this suite while protecting nothing at all.
vi.mock('../../lib/chains/publicClient', async (orig) => ({
  ...(await orig()),
  getPublicClient: () => {
    throw new Error('a test reached the real client factory')
  },
}))

describe('verifyMessage is offline', () => {
  it('is synchronous — a function that returns no promise cannot await a network', () => {
    const out = verifyMessage({ message: MESSAGE, signature: SIGNATURE, address: SIGNER_ADDRESS })
    expect(out).not.toBeInstanceOf(Promise)
    expect(out.status).toBe(VERIFY_STATUS.VALID)
  })

  it('ignores a provider even if one is passed — there is no parameter for it', () => {
    const provider = { getCode: vi.fn(), call: vi.fn() }
    verifyMessage({ message: MESSAGE, signature: ERC1271_SIGNATURE, address: CONTRACT_ACCOUNT, chainId: 137, provider })
    expect(provider.getCode).not.toHaveBeenCalled()
    expect(provider.call).not.toHaveBeenCalled()
  })
})

describe('verifyMessage — valid', () => {
  it('confirms a wallet signature against the claimed address, with no network at all', async () => {
    const out = await verifyMessage({ message: MESSAGE, signature: SIGNATURE, address: SIGNER_ADDRESS })
    expect(out.status).toBe(VERIFY_STATUS.VALID)
    expect(out.method).toBe('eip191')
    expect(out.signer).toBe(SIGNER_ADDRESS)
  })

  it('is case-insensitive about the claimed address', async () => {
    const out = await verifyMessage({
      message: MESSAGE,
      signature: SIGNATURE,
      address: SIGNER_ADDRESS.toLowerCase(),
    })
    expect(out.status).toBe(VERIFY_STATUS.VALID)
  })

  it('preserves whitespace and Unicode exactly — nothing is normalized', async () => {
    const out = await verifyMessage({
      message: AWKWARD_MESSAGE,
      signature: AWKWARD_SIGNATURE,
      address: SIGNER_ADDRESS,
    })
    expect(out.status).toBe(VERIFY_STATUS.VALID)
    // …and the trimmed variant must NOT verify, which is what makes the above meaningful. Offline
    // that shows up as "unsettled, and here is who actually signed" rather than a verdict: the
    // claimed address could be a contract that accepts the real signer.
    const trimmed = verifyMessage({
      message: AWKWARD_MESSAGE.trim(),
      signature: AWKWARD_SIGNATURE,
      address: SIGNER_ADDRESS,
    })
    expect(trimmed.status).not.toBe(VERIFY_STATUS.VALID)
    expect(trimmed.canCheckOnChain).toBe(true)
  })

  it('names the signer when no address is claimed', async () => {
    const out = await verifyMessage({ message: MESSAGE, signature: SIGNATURE })
    expect(out.status).toBe(VERIFY_STATUS.VALID)
    expect(out.signer).toBe(SIGNER_ADDRESS)
  })

  it('accepts a contract account whose isValidSignature returns the magic value', async () => {
    const out = await verifyOnChain({
      message: MESSAGE,
      signature: ERC1271_SIGNATURE,
      address: CONTRACT_ACCOUNT,
      chainId: CONTRACT_ACCOUNT_CHAIN_ID,
      provider: stubProvider({ answer: 'magic' }),
    })
    expect(out.status).toBe(VERIFY_STATUS.VALID)
    expect(out.method).toBe('erc1271')
  })

  it('accepts an owner signature the account itself vouches for (an owner is not the account)', async () => {
    const out = await verifyOnChain({
      message: MESSAGE,
      signature: SIGNATURE, // recovers to SIGNER_ADDRESS…
      address: CONTRACT_ACCOUNT, // …but the claim is the account it controls
      chainId: CONTRACT_ACCOUNT_CHAIN_ID,
      provider: stubProvider({ answer: 'magic' }),
    })
    expect(out.status).toBe(VERIFY_STATUS.VALID)
    expect(out.method).toBe('erc1271')
  })
})

// A definite negative requires an answer from the account. Offline, a recovery that names somebody
// else is a FACT about the bytes, not a verdict on the claim — the claimed address may be a
// contract whose owner is that somebody. So these live under the escalation.
describe('verifyOnChain — definite negatives', () => {
  it('rejects a signature by somebody else and names who actually signed', async () => {
    const out = await verifyOnChain({
      message: MESSAGE,
      signature: SIGNATURE,
      address: OTHER_ADDRESS,
      chainId: 137,
      provider: stubProvider({ code: '0x' }),
    })
    expect(out.status).toBe(VERIFY_STATUS.INVALID)
    expect(out.signer).toBe(SIGNER_ADDRESS)
    expect(out.reason).toContain(SIGNER_ADDRESS)
  })

  it('rejects a tampered message', async () => {
    const out = await verifyOnChain({
      message: `${MESSAGE} (edited)`,
      signature: SIGNATURE,
      address: SIGNER_ADDRESS,
      chainId: 137,
      provider: stubProvider({ code: '0x' }),
    })
    expect(out.status).toBe(VERIFY_STATUS.INVALID)
  })

  it('rejects when the account contract itself says no', async () => {
    const out = await verifyOnChain({
      message: MESSAGE,
      signature: ERC1271_SIGNATURE,
      address: CONTRACT_ACCOUNT,
      chainId: CONTRACT_ACCOUNT_CHAIN_ID,
      provider: stubProvider({ answer: 'wrong' }),
    })
    expect(out.status).toBe(VERIFY_STATUS.INVALID)
    expect(out.method).toBe('erc1271')
  })

  it('rejects non-ECDSA bytes against an address holding no code on the named chain', async () => {
    const out = await verifyOnChain({
      message: MESSAGE,
      signature: ERC1271_SIGNATURE,
      address: OTHER_ADDRESS,
      chainId: 137,
      provider: stubProvider({ code: '0x' }),
    })
    expect(out.status).toBe(VERIFY_STATUS.INVALID)
    expect(out.reason).toMatch(/holds no contract/i)
  })

  it('rejects a signature that is not hex', async () => {
    const out = await verifyMessage({ message: MESSAGE, signature: 'not-a-signature', address: SIGNER_ADDRESS })
    expect(out.status).toBe(VERIFY_STATUS.INVALID)
    expect(out.reason).toMatch(/valid hex/i)
  })

  // Regression, review on #1163: an odd-length hex string is not a byte sequence, and reached
  // `encodeFunctionData` unguarded — which threw OUT of verifyMessage as a rejected promise, so the
  // member pressed Check and nothing happened at all. It must be a verdict, not a crash. (Note
  // ethers' own `isHexString(value)` would not have caught this: it accepts '0x123'.)
  it('rejects odd-length hex as a verdict rather than throwing', () => {
    const out = verifyMessage({ message: MESSAGE, signature: '0x123', address: CONTRACT_ACCOUNT })
    expect(out.status).toBe(VERIFY_STATUS.INVALID)
    expect(out.reason).toMatch(/even number of digits/i)
  })

  it('rejects an address that is not an address', async () => {
    const out = await verifyMessage({ message: MESSAGE, signature: SIGNATURE, address: '0xnope' })
    expect(out.status).toBe(VERIFY_STATUS.INVALID)
    expect(out.reason).toMatch(/not a valid address/i)
  })
})

describe('verifyMessage — unverifiable is not invalid', () => {
  it('offers the on-chain route rather than guessing, when the bytes are not ECDSA', () => {
    const out = verifyMessage({ message: MESSAGE, signature: ERC1271_SIGNATURE, address: CONTRACT_ACCOUNT })
    expect(out.status).toBe(VERIFY_STATUS.UNVERIFIABLE)
    expect(out.canCheckOnChain).toBe(true)
    expect(out.reason).toMatch(/not a wallet signature/i)
  })

  it('reports unverifiable when the node cannot be reached', async () => {
    const out = await verifyOnChain({
      message: MESSAGE,
      signature: ERC1271_SIGNATURE,
      address: CONTRACT_ACCOUNT,
      chainId: CONTRACT_ACCOUNT_CHAIN_ID,
      provider: stubProvider({ failCode: true }),
    })
    expect(out.status).toBe(VERIFY_STATUS.UNVERIFIABLE)
    expect(out.reason).toMatch(/could not be reached/i)
  })

  it('reports unverifiable when isValidSignature reverts — a broken account is not a forgery', async () => {
    const out = await verifyOnChain({
      message: MESSAGE,
      signature: ERC1271_SIGNATURE,
      address: CONTRACT_ACCOUNT,
      chainId: CONTRACT_ACCOUNT_CHAIN_ID,
      provider: stubProvider({ failCall: true }),
    })
    expect(out.status).toBe(VERIFY_STATUS.UNVERIFIABLE)
  })

  it('a mismatching recovery with an unreachable node stays unverifiable, and still names the recovered signer', async () => {
    const out = await verifyOnChain({
      message: MESSAGE,
      signature: SIGNATURE,
      address: CONTRACT_ACCOUNT,
      chainId: CONTRACT_ACCOUNT_CHAIN_ID,
      provider: stubProvider({ failCode: true }),
    })
    expect(out.status).toBe(VERIFY_STATUS.UNVERIFIABLE)
    expect(out.signer).toBe(SIGNER_ADDRESS)
    expect(out.reason).toContain(SIGNER_ADDRESS)
  })

  // Offline, an owner key recovering instead of the account it controls is NOT evidence of forgery.
  // The fact is reported; the verdict is not.
  it('states who signed without promoting a mismatch to a negative', () => {
    const out = verifyMessage({ message: MESSAGE, signature: SIGNATURE, address: CONTRACT_ACCOUNT })
    expect(out.status).toBe(VERIFY_STATUS.UNVERIFIABLE)
    expect(out.signer).toBe(SIGNER_ADDRESS)
    expect(out.canCheckOnChain).toBe(true)
    expect(out.reason).toMatch(/That is certain/i)
  })

  it('cannot name a signer for contract-account bytes when no address is claimed', async () => {
    const out = await verifyMessage({ message: MESSAGE, signature: ERC1271_SIGNATURE })
    expect(out.status).toBe(VERIFY_STATUS.UNVERIFIABLE)
    expect(out.signer).toBeNull()
  })
})

describe('checkErc1271', () => {
  it('asks the account with the EIP-191 digest of the message', async () => {
    const call = vi.fn().mockResolvedValue(`${ERC1271_MAGIC}${'0'.repeat(56)}`)
    const provider = { getCode: async () => '0x6000', call }
    const out = await checkErc1271({
      message: MESSAGE,
      signature: ERC1271_SIGNATURE,
      address: CONTRACT_ACCOUNT,
      chainId: 137,
      provider,
    })
    expect(out).toEqual({ answered: true, valid: true })
    const iface = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
    const decoded = iface.decodeFunctionData('isValidSignature', call.mock.calls[0][0].data)
    expect(decoded[0]).toBe(ethers.hashMessage(MESSAGE))
  })

  // checkErc1271 is exported, so it can be reached without verifyMessage's input check in front of
  // it. It must answer, never throw.
  it('answers instead of throwing when the signature cannot be encoded', async () => {
    const out = await checkErc1271({
      message: MESSAGE,
      signature: '0x123',
      address: CONTRACT_ACCOUNT,
      chainId: 137,
      provider: stubProvider({ answer: 'magic' }),
    })
    expect(out).toMatchObject({ answered: true, valid: false, reason: 'malformed-signature' })
  })

  it('treats an empty return as a definite no, not an outage', async () => {
    const out = await checkErc1271({
      message: MESSAGE,
      signature: ERC1271_SIGNATURE,
      address: CONTRACT_ACCOUNT,
      chainId: 137,
      provider: stubProvider({ answer: 'empty' }),
    })
    expect(out).toMatchObject({ answered: true, valid: false })
  })
})

describe('recoverPersonalSigner', () => {
  it('returns null instead of throwing on bytes that are not a signature', () => {
    expect(recoverPersonalSigner(MESSAGE, ERC1271_SIGNATURE)).toBeNull()
  })

  /*
   * Spec 110 T020. The recovery runs on `@noble/curves` rather than viem for ONE reason: viem's
   * `verifyMessage`/`recoverAddress` are async, and spec 084 requires this path to be synchronous
   * because the type is what stops a network call being added to signature arithmetic later. A
   * conversion that "worked" but returned a promise would pass every value assertion in this file
   * and quietly remove that guarantee, so it is asserted directly.
   */
  it('is SYNCHRONOUS — the type is what keeps the offline guarantee (spec 084)', () => {
    const out = recoverPersonalSigner(MESSAGE, SIGNATURE)
    expect(out).not.toBeInstanceOf(Promise)
    expect(typeof out).toBe('string')
    expect(recoverPersonalSigner(MESSAGE, ERC1271_SIGNATURE)).not.toBeInstanceOf(Promise)
  })

  /*
   * EIP-2098: 64 bytes, with yParity packed into the top bit of `s`. ethers accepted this form and
   * so must we — this surface verifies signatures OTHER people produced, so refusing an encoding
   * turns a good proof into "unverifiable". viem's own `parseSignature` rejects it, which is why
   * the split is written out in the module rather than delegated.
   */
  it('accepts the 64-byte EIP-2098 compact form, as ethers did', () => {
    const wallet = new ethers.Wallet(SIGNER_KEY)
    const compact = wallet.signingKey.sign(ethers.hashMessage(MESSAGE)).compactSerialized
    expect(compact).toHaveLength(2 + 128) // 64 bytes, not 65
    expect(recoverPersonalSigner(MESSAGE, compact)).toBe(SIGNER_ADDRESS)
  })
})

describe('verifySignedMessage', () => {
  it('verifies a wallet signature straight from a parsed document, offline', () => {
    const out = verifySignedMessage(EIP191_DOCUMENT)
    expect(out.status).toBe(VERIFY_STATUS.VALID)
    expect(out.method).toBe('eip191')
  })

  // A contract-account record cannot be settled offline — and the document's own chain does NOT
  // make it so. The caller escalates deliberately.
  it('leaves a contract-account document unsettled, and says the account can be asked', () => {
    const out = verifySignedMessage(ERC1271_DOCUMENT)
    expect(out.status).toBe(VERIFY_STATUS.UNVERIFIABLE)
    expect(out.canCheckOnChain).toBe(true)
  })

  it('settles it once the caller asks the account, using the chain the document named', async () => {
    const out = await verifyOnChain({
      message: ERC1271_DOCUMENT.message,
      signature: ERC1271_DOCUMENT.signature,
      address: ERC1271_DOCUMENT.address,
      chainId: ERC1271_DOCUMENT.chainId,
      provider: stubProvider({ answer: 'magic' }),
    })
    expect(out.status).toBe(VERIFY_STATUS.VALID)
    expect(out.method).toBe('erc1271')
  })
})
