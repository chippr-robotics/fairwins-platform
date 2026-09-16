/**
 * Message verification (Protect ▸ Verify) — does this address really stand behind this message?
 *
 * Verification returns one of THREE states, never two. The tempting binary (valid / invalid)
 * is dishonest here, because the ERC-1271 leg is a network read: an RPC timeout is not a
 * forged signature, and rendering one as the other would tell a member their counterparty
 * lied when in fact we could not look. So:
 *
 *   'valid'         we checked and the claim holds
 *   'invalid'       we checked and the claim does NOT hold — a definite negative
 *   'unverifiable'  we could not settle it (and we say what IS known)
 *
 * A negative is only reported when it is established: offline, that means malformed input; on
 * chain, it means the account itself declined or holds no code. A recovery that names somebody
 * else is NOT a negative on its own — the claimed address may be a contract whose owner is that
 * somebody, and an owner's signature is an ordinary 65-byte ECDSA signature.
 *
 * **`verifyMessage` is OFFLINE. It is synchronous and it cannot perform I/O.** Checking a
 * signature against a public key is pure arithmetic — recover the key from the signature, derive
 * the address, compare — and that is the whole of what most callers need. No provider is built, no
 * chain is named, nothing leaves the machine.
 *
 * The on-chain leg lives in `verifyOnChain`, and it exists for one reason: **a contract account
 * has no public key.** A passkey account (spec 041) or a Safe is a contract at an address; there
 * is no private key whose signature recovers to it, and what it produces is not a 65-byte ECDSA
 * signature but an envelope its own code interprets. Nothing about those bytes is self-validating,
 * so the only way to learn whether that account stands behind them is to ask it —
 * `isValidSignature(hashMessage(m), sig)` — on the one chain it lives on, where its owner set can
 * also change over time. That is not verifying a public key over the network; it is asking an
 * account that hasn't got one.
 *
 * So the two are deliberately separate functions rather than one with a flag: the offline answer
 * is complete on its own, and reaching for a network is a decision the caller makes explicitly
 * when the offline answer cannot settle the specific claim being made.
 */

import { bytesToHex, encodeFunctionData, hashMessage } from 'viem'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { getPublicClient } from '../chains/publicClient'
import { normalizeAbi } from '../chains/readContract'
import { getAddress } from '../evm/address'
// Spec 110 T028 — the split moved to `lib/evm/signature.js` so `lib/pools/gasless.js` uses the
// same one. Neither of viem's answers is right for it (the compact form is refused, and `v` comes
// back a bigint), so there must be exactly one place that gets it right.
import { splitSignature } from '../evm/signature'
import { SIGN_SCHEMES } from './signedMessage'

/** bytes4(keccak256("isValidSignature(bytes32,bytes)")) — the ONLY accepted success value. */
export const ERC1271_MAGIC = '0x1626ba7e'

const ERC1271_ABI = normalizeAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
])

export const VERIFY_STATUS = Object.freeze({
  VALID: 'valid',
  INVALID: 'invalid',
  UNVERIFIABLE: 'unverifiable',
})

/**
 * Valid `bytes`: 0x-prefixed hex of EVEN length.
 *
 * The even-length half is load-bearing, not pedantry. An odd-length string like `0x123` is not a
 * byte sequence, and handing one to `encodeFunctionData` throws `invalid BytesLike value` — which
 * would escape `checkErc1271` as a rejected promise and leave the member pressing Check with
 * nothing happening at all. Caught in review on #1163.
 *
 * Note that ethers' own `isHexString(value)` does NOT cover this: without an explicit length
 * argument it accepts `0x123` too. The length check has to be written out.
 */
const isHexBytes = (value) =>
  typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) && value.length % 2 === 0

const sameAddress = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase())

const TOP_BIT = 1n << 255n

/**
 * Recover the EIP-191 signer, or null when the bytes are not a recoverable ECDSA signature.
 * Never throws: a 900-byte WebAuthn envelope reaching here is expected, not exceptional.
 *
 * ON `@noble/curves` RATHER THAN viem, AND THAT IS THE WHOLE POINT (spec 110 T020). viem's
 * `verifyMessage` and `recoverAddress` are ASYNC; ethers' were synchronous. Swapping to them would
 * make this function — and `verifyMessage` above it — return a promise, which is exactly what the
 * spec-084 rule forbids: "verifyMessage is OFFLINE and SYNCHRONOUS … never make it async: the type
 * is what enforces it." The type is the guard that stops a network call being added to signature
 * arithmetic later, and an async signature removes it without anything failing. noble does the
 * recovery synchronously, so the guarantee stays a fact about the code rather than a comment.
 *
 * Checked against `ethers.verifyMessage` over 18 curated cases and a 300-case fuzz across both
 * signature encodings before the swap: identical answer every time, including the negatives.
 */
export function recoverPersonalSigner(message, signature) {
  try {
    const parts = splitSignature(signature)
    if (!parts) return null
    const sig = new secp256k1.Signature(BigInt(parts.r), BigInt(parts.s), parts.yParity)
    const digest = hashMessage(message, 'bytes')
    const publicKey = sig.recoverPublicKey(digest).toBytes(false).slice(1) // drop the 0x04 tag
    // `bytesToHex`, not `Buffer` — this runs in the browser, where Buffer does not exist.
    return getAddress(`0x${bytesToHex(keccak_256(publicKey)).slice(-40)}`)
  } catch {
    return null
  }
}

/**
 * Ask a contract account whether it stands behind the signature.
 *
 * Returns `{ answered: true, valid }` when the contract gave a verdict, or
 * `{ answered: false, reason }` when the chain could not be reached / has no route / the
 * address holds no code. Callers MUST NOT collapse `answered: false` into `valid: false` —
 * that is the whole point of the third state.
 */
export async function checkErc1271({ message, signature, address, chainId, provider }) {
  if (chainId == null) {
    return { answered: false, reason: 'no-chain' }
  }
  let node = provider
  if (!node) {
    try {
      node = getPublicClient(Number(chainId))
    } catch {
      node = null
    }
  }
  if (!node) return { answered: false, reason: 'no-provider' }

  // Encoding is inside the guarded region because this function is exported and can be called
  // without going through verifyMessage's input check. A malformed signature is a verdict input,
  // never a crash.
  //
  // THE SHAPE CHECK IS EXPLICIT, AND IT HAS TO BE (spec 110). ethers' encoder REFUSED a malformed
  // `bytes` value — `0x123`, `0xZZ`, even `nothex` — and that refusal was what produced the
  // `malformed-signature` answer. viem's `encodeFunctionData` accepts all three and encodes
  // something, so without this guard the garbage would be put to the contract and whatever it
  // answered would be reported as a verdict on the member's signature. That is the one divergence
  // in this migration that fails toward a CONFIDENT WRONG ANSWER rather than toward reporting
  // less, which is why it is checked here instead of relied on from the library.
  let data
  try {
    if (!isHexBytes(signature)) throw new Error('signature is not a byte string')
    data = encodeFunctionData({
      abi: ERC1271_ABI,
      functionName: 'isValidSignature',
      args: [hashMessage(message), signature],
    })
  } catch {
    return { answered: true, valid: false, reason: 'malformed-signature' }
  }

  /*
   * Deliberately raw `getCode` + `call` rather than `readContract`: each of the four outcomes
   * below is a DIFFERENT answer to the member, and `readContract` collapses three of them into one
   * thrown error. `no-code` is a real negative, `no-answer` is a broken account, and `call-failed`
   * is not a verdict at all. viem also differs from ethers twice here and both are load-bearing —
   * `getCode` resolves to `undefined` where ethers gave `'0x'`, and `call` resolves to
   * `{ data }` rather than a bare hex string — so the shapes are normalized at this seam and the
   * state machine below is byte-for-byte the one it replaces.
   */
  let code
  try {
    code = node.getCode
      ? await node.getCode({ address })
      : await node.getBytecode({ address })
  } catch {
    return { answered: false, reason: 'unreachable' }
  }
  // No code: the address is a plain account on this chain, so ERC-1271 does not apply. That IS
  // an answer — a definite "this account cannot have signed it that way" — and lets the caller
  // report a real negative instead of hiding behind "couldn't check".
  if (!code || code === '0x') return { answered: true, valid: false, reason: 'no-code' }

  let returned
  try {
    const answer = await node.call({ to: address, data })
    returned = typeof answer === 'string' ? answer : answer?.data
  } catch {
    // A revert and a dead node are indistinguishable at this seam in the general case, and a
    // dead node must never read as a forged signature — so this stays unverifiable rather than
    // invalid. (A reverting `isValidSignature` is itself a broken account, worth surfacing.)
    return { answered: false, reason: 'call-failed' }
  }
  if (!returned || returned === '0x' || returned.length < 10) {
    return { answered: true, valid: false, reason: 'no-answer' }
  }
  return { answered: true, valid: returned.slice(0, 10).toLowerCase() === ERC1271_MAGIC }
}

const UNVERIFIABLE_REASON = {
  'no-chain':
    'This signature can only be checked on-chain, but the document does not say which network the account is on.',
  'no-provider': 'No network route is configured for that chain, so the account could not be asked.',
  unreachable: 'That network could not be reached, so the account could not be asked. Try again.',
  'call-failed':
    'That network could not answer for the account, so the signature could not be checked. Try again.',
}

/**
 * Verify a claim — "`address` signed `message`, and here is the signature" — **entirely offline**.
 *
 * Synchronous by design: a function that cannot return a promise cannot await a network, so the
 * offline guarantee is enforced by the signature rather than promised in a comment.
 *
 * @param {object} args
 * @param {string} args.message    exact signed text — never normalized
 * @param {string} args.signature  0x-hex signature bytes
 * @param {string} [args.address]  the claimed signer; omit to just ask "who signed this?"
 * @returns {{status: string, method: string|null, signer: string|null, reason: string|null,
 *            canCheckOnChain?: boolean}}
 *   `method` is how the verdict was reached ('eip191' | 'erc1271' | null).
 *   `signer` is the recovered address when ECDSA recovery worked — reported as FACT, including
 *   alongside outcomes that do not settle the claim, because "produced by 0xother" is the useful
 *   half of the answer.
 *   `canCheckOnChain` marks the one outcome that a network could still settle: pass the same
 *   inputs plus a chain to `verifyOnChain`.
 */
export function verifyMessage({ message, signature, address = null }) {
  if (typeof message !== 'string') {
    return { status: VERIFY_STATUS.INVALID, method: null, signer: null, reason: 'There is no message to check.' }
  }
  if (!isHexBytes(signature) || signature.length < 4) {
    return {
      status: VERIFY_STATUS.INVALID,
      method: null,
      signer: null,
      reason: 'The signature is not valid hex — it should start with 0x and have an even number of digits.',
    }
  }

  let claimed = null
  if (address) {
    try {
      claimed = getAddress(address)
    } catch {
      return {
        status: VERIFY_STATUS.INVALID,
        method: null,
        signer: null,
        reason: 'The address to check is not a valid address.',
      }
    }
  }

  const recovered = recoverPersonalSigner(message, signature)

  // No claimed address: this is the "who signed this?" question, not a verdict on anyone.
  if (!claimed) {
    if (recovered) {
      return { status: VERIFY_STATUS.VALID, method: SIGN_SCHEMES.EIP191, signer: recovered, reason: null }
    }
    return {
      status: VERIFY_STATUS.UNVERIFIABLE,
      method: null,
      signer: null,
      reason:
        'These bytes are not a recoverable wallet signature, so no signer can be named offline. Enter the address that is claimed to have signed, and that account can be asked directly.',
    }
  }

  if (recovered && sameAddress(recovered, claimed)) {
    return { status: VERIFY_STATUS.VALID, method: SIGN_SCHEMES.EIP191, signer: recovered, reason: null }
  }

  // The claim is not settled offline, and this is the ONE case where that is true. Two shapes
  // reach here and they look identical from outside:
  //
  //   · the bytes recovered to somebody else — but the claimed address may be a CONTRACT whose
  //     owner is that somebody, and an owner's signature is an ordinary 65-byte ECDSA signature;
  //   · the bytes are not recoverable at all — which is what a contract account's envelope is.
  //
  // Neither can be turned into a negative here without asking the account itself. What we DO know
  // offline is stated as fact and returned as `signer`; `canCheckOnChain` says the caller can
  // settle it by naming a network. Promoting either shape to `invalid` on the strength of a
  // recovery mismatch is the confidently-wrong accusation this whole surface exists to avoid.
  return {
    status: VERIFY_STATUS.UNVERIFIABLE,
    method: null,
    signer: recovered,
    canCheckOnChain: true,
    reason: recovered
      ? `These bytes were produced by ${recovered} — that is certain, and it was established without a network. What is not certain is whether the address you entered is a smart contract account that accepts signatures from it; only that account can answer.`
      : 'These bytes are not a wallet signature, so no address can be recovered from them offline. If the address you entered is a smart contract account, it can be asked directly.',
  }
}

/**
 * The explicit escalation: ask a contract account whether it stands behind the signature.
 *
 * Separate from `verifyMessage` and never called by it. Reaching a network is a decision, not a
 * fallback — the caller has already been told what is knowable offline and is choosing to ask the
 * one party that can settle the rest.
 *
 * @param {object} args  message, signature, address, chainId, and an optional provider seam
 */
export async function verifyOnChain({ message, signature, address, chainId, provider = null }) {
  let claimed
  try {
    claimed = getAddress(address)
  } catch {
    return {
      status: VERIFY_STATUS.INVALID,
      method: null,
      signer: null,
      reason: 'The address to check is not a valid address.',
    }
  }
  const recovered = recoverPersonalSigner(message, signature)
  const onChain = await checkErc1271({ message, signature, address: claimed, chainId, provider })

  if (!onChain.answered) {
    // Could not ask. Still not a negative — an unreachable node says nothing about a signature.
    // The offline fact is repeated rather than dropped: this result REPLACES the offline one on
    // screen, and losing "produced by 0xB" to a network error would leave the member with less
    // than they had before they asked.
    const base = UNVERIFIABLE_REASON[onChain.reason] ?? 'The signature could not be checked.'
    return {
      status: VERIFY_STATUS.UNVERIFIABLE,
      method: null,
      signer: recovered,
      canCheckOnChain: true,
      reason: recovered
        ? `${base} What is still certain is that these bytes were produced by ${recovered}.`
        : base,
    }
  }
  if (onChain.valid) {
    return { status: VERIFY_STATUS.VALID, method: SIGN_SCHEMES.ERC1271, signer: recovered, reason: null }
  }

  // The account answered, so a definite negative is now available — which is exactly what the
  // member came here for when the offline result left the claim open.
  const plainAccount = onChain.reason === 'no-code'
  let reason
  if (plainAccount && recovered) {
    reason = `That address holds no contract on this network, so it is a plain account — and these bytes were produced by ${recovered}, not by it.`
  } else if (plainAccount) {
    reason =
      'These bytes are not a wallet signature, and that address holds no contract on this network — so nothing there could have signed this message.'
  } else {
    reason = 'That account was asked directly, and it does not accept this signature for this message.'
  }
  return {
    status: VERIFY_STATUS.INVALID,
    method: plainAccount ? SIGN_SCHEMES.EIP191 : SIGN_SCHEMES.ERC1271,
    signer: recovered,
    reason,
  }
}

/** Verify straight from a parsed document (`parseSignedMessage().doc`) — offline, like its base. */
export function verifySignedMessage(doc) {
  return verifyMessage({ message: doc.message, signature: doc.signature, address: doc.address })
}
