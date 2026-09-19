/**
 * Passkey intent signer (spec 041, T030) — lets a passkey smart account sign
 * spec-035 intents ON THE EXISTING RAILS: it is a drop-in `signer` adapter for
 * `lib/relay/intentClient.signIntent` (getAddress + signTypedData), producing
 * the account's ERC-1271 signature envelope instead of an ECDSA signature.
 *
 * EIP-712 types come from `lib/relay/intentTypes.js` — NEVER redefined here
 * (three-way byte-identical rule). The envelope matches the vendored wallet:
 *   digest = TypedDataEncoder.hash(domain, types, message)
 *   challenge = account.replaySafeHash(digest)      (account-bound, anti-replay)
 *   WebAuthn assertion over challenge → WebAuthnAuth struct
 *   signature = abi.encode(SignatureWrapper{ownerIndex, abi.encode(auth)})
 *
 * Verified end-to-end by the on-chain suites (test/intent/
 * SignerIntentBase.erc1271.test.js) and the gateway ERC-1271 fallback (T014).
 *
 * Scope note (research §11): only `signer-attributed` intent actions are
 * passkey-capable today — the EIP-3009 payment leg is ECDSA-only until the
 * ERC-7598 bytes leg lands in the twins; stake-moving passkey actions ride
 * `executeBatch` UserOps instead (sendBatch.js).
 */

import { encodeAbiParameters, hashMessage, parseAbiParameters } from 'viem'
import { hashTypedDataLike } from '../evm/typedData'
import { INTENT_ACTIONS } from '../relay/intentTypes'
import { getAssertion } from './credentials'
import { ACCOUNT_ABI, defaultPublicClient } from './smartAccount'

// ethers spells a struct `tuple(address x, …)`; abitype wants the bare parenthesized form. Same
// rewrite `lib/chains/readContract.js#normalizeAbi` does, so the tuple strings below stay readable
// as the Solidity they mirror. Encoding verified byte-identical to `AbiCoder.defaultAbiCoder()`
// over empty, unicode, 300-byte and max-uint256 cases before the swap.
const params = (signature) => parseAbiParameters(signature.replace(/\btuple\(/g, '('))

// secp256r1 group order for low-s normalization (WebAuthnSol rejects high-s).
const P256_N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551')

const WEBAUTHN_AUTH_TUPLE =
  'tuple(bytes authenticatorData, string clientDataJSON, uint256 challengeIndex, uint256 typeIndex, uint256 r, uint256 s)'
const SIGNATURE_WRAPPER_TUPLE = 'tuple(uint256 ownerIndex, bytes signatureData)'

/** True when a spec-035 action can be signed by a passkey account (row 1 routing input). */
export function isIntentCapableForPasskey(action) {
  return INTENT_ACTIONS[action]?.intentClass === 'signer-attributed'
}

/** Parse a DER-encoded ECDSA signature into normalized (r, s) bigints. */
export function derToRS(der) {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der)
  if (bytes[0] !== 0x30) throw new Error('invalid DER signature')
  let offset = 2
  const readInt = () => {
    if (bytes[offset] !== 0x02) throw new Error('invalid DER integer')
    const len = bytes[offset + 1]
    let start = offset + 2
    let end = start + len
    while (bytes[start] === 0x00 && end - start > 32) start++ // strip padding
    offset = end
    return BigInt('0x' + Array.from(bytes.slice(start, end), (b) => b.toString(16).padStart(2, '0')).join(''))
  }
  const r = readInt()
  let s = readInt()
  if (s > P256_N / 2n) s = P256_N - s // malleability guard
  return { r, s }
}

/** Encode a WebAuthn assertion as the vendored wallet's signature blob. */
export function encodeWebAuthnSignature({ assertion, ownerIndex = 0 }) {
  const { r, s } = derToRS(assertion.signature)
  const clientDataJSON = new TextDecoder().decode(assertion.clientDataJSON)
  const auth = {
    authenticatorData:
      '0x' + Array.from(assertion.authenticatorData, (b) => b.toString(16).padStart(2, '0')).join(''),
    clientDataJSON,
    challengeIndex: clientDataJSON.indexOf('"challenge"'),
    typeIndex: clientDataJSON.indexOf('"type"'),
    r,
    s,
  }
  return encodeAbiParameters(params(SIGNATURE_WRAPPER_TUPLE), [
    { ownerIndex: BigInt(ownerIndex), signatureData: encodeAbiParameters(params(WEBAUTHN_AUTH_TUPLE), [auth]) },
  ])
}

const hexToBytes = (hex) => Uint8Array.from(hex.slice(2).match(/.{2}/g), (b) => parseInt(b, 16))

/**
 * Build the drop-in signer adapter for `signIntent`.
 *
 * @param {object} opts
 *   chainId, address   the passkey account
 *   credentialId       pins the ceremony to the session credential
 *   ownerIndex         this credential's owner index on the account (default 0)
 *   deps               injectable getAssertion / publicClient for tests
 */
export function passkeyIntentSigner({ chainId, address, credentialId, ownerIndex = 0, deps = {} }) {
  /**
   * The one ceremony, shared by every digest shape this adapter signs (EIP-712 today,
   * EIP-191 personal messages since the Verify surface). Keeping it single means a
   * change to the envelope — owner index, wrapper encoding, challenge derivation —
   * can never apply to one caller and miss the other.
   */
  async function signDigest(digest) {
    // Account-bound challenge: the deployed account's replaySafeHash. The
    // account exists for every signer-attributed action (those act on prior
    // on-chain state), so a plain read is the honest path here.
    const client = deps.publicClient ?? defaultPublicClient(chainId)
    const replaySafe = await client.readContract({
      address,
      abi: ACCOUNT_ABI,
      functionName: 'replaySafeHash',
      args: [digest],
    })

    // ONE ceremony per intent (FR-008); the platform prompt shows the rpId.
    const assertion = await (deps.getAssertion ?? getAssertion)({
      challenge: hexToBytes(replaySafe),
      credentialId,
      deps,
    })
    return encodeWebAuthnSignature({ assertion, ownerIndex })
  }

  return {
    async getAddress() {
      return address
    },

    /** ethers-Signer-compatible signTypedData — returns the ERC-1271 envelope bytes. */
    async signTypedData(domain, types, message) {
      // `hashTypedDataLike` infers the primary type the way ethers did. viem's `hashTypedData`
      // demands one, and `Object.keys(types)[0]` would be a guess that can hash against a SUB-type
      // — a valid signature over the wrong structure, which nothing downstream could detect.
      return signDigest(hashTypedDataLike(domain, types, message))
    },

    /**
     * ethers-Signer-compatible signMessage (EIP-191 digest, ERC-1271 envelope).
     *
     * The bytes are NOT an ECDSA signature and never recover to an address: a verifier
     * must ask the account itself (`isValidSignature`) on `chainId`. That is why the
     * Verify surface records the chain alongside the signature — see
     * `lib/verify/verifyMessage.js`.
     */
    async signMessage(message) {
      // ethers' `hashMessage` took a string OR raw bytes; viem's refuses a bare Uint8Array and
      // wants `{ raw }`. This adapter advertises ethers-signer compatibility, so both are accepted
      // here rather than leaving a caller that passes bytes to fail at the library boundary.
      return signDigest(hashMessage(typeof message === 'string' ? message : { raw: message }))
    },
  }
}
