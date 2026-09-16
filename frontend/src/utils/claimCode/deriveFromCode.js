/**
 * Claim-code key derivation (feature 024 — open-challenge wagers).
 *
 * The same four-word code deterministically derives, on any device with no server state:
 *   - a secp256k1 claim keypair — `claimAddress` is the on-chain commitment (`claimAuthority`) and the
 *     discovery key; the private key signs the EIP-712 acceptance.
 *   - a symmetric key — seals/opens the code-keyed terms envelope (see crypto/envelopeEncryption.js).
 *
 * v1 derivation is FAST (entropy-only, FR-003a): two domain-separated keccak passes. The `v1` domain tags
 * keep it swappable for a future memory-hard KDF without breaking already-created wagers. The signing key
 * and the encryption key are independent keccak outputs with distinct domain tags, so neither leaks the
 * other.
 */
import { hexToBytes, keccak256, stringToBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CONTRACT_DOMAINS, OPEN_ACCEPT_TYPES, domainFor } from '@fairwins/intent-types'
import { primaryTypeOf } from '../../lib/evm/typedData'
import { normalizeCode } from './wordlist.js'

const CLAIM_DOMAIN = 'FairWins/claim/v1'
const TERMS_DOMAIN = 'FairWins/terms/v1'

/*
 * EIP-712 — MUST match the registry's OPEN_ACCEPT_TYPEHASH and EIP712 domain exactly. Both now come
 * from @fairwins/intent-types instead of being retyped here: the struct is checked against
 * WagerRegistryCore's OPEN_ACCEPT_TYPEHASH and the domain against WagerRegistry's own
 * `__EIP712_init(...)` by test/intent/TypehashParity.test.js. The values are unchanged — this
 * signature is the claim-code proof leg of acceptOpenWager and an altered domain would silently
 * stop every open-challenge accept from verifying.
 *
 * Re-exported below (unchanged names) because the open-challenge tests and callers import them here.
 */
const EIP712_DOMAIN_NAME = CONTRACT_DOMAINS.wagerRegistry.name
const EIP712_DOMAIN_VERSION = CONTRACT_DOMAINS.wagerRegistry.version

/**
 * Derive the claim keypair and symmetric key from a four-word code.
 * @param {string} code
 * @returns {{ claimPrivateKey: string, claimAddress: string, symKey: Uint8Array }}
 *   claimPrivateKey: 0x-hex secp256k1 private key; claimAddress: the on-chain claimAuthority + discovery key;
 *   symKey: 32-byte AEAD key for the code-keyed envelope.
 */
export function deriveFromCode(code) {
  const normalized = normalizeCode(code)
  if (!normalized) throw new Error('deriveFromCode: empty code')

  // secp256k1 private key: keccak("FairWins/claim/v1" || normalized). The keccak output is a valid scalar
  // (1..n-1) with overwhelming probability (~1 - 2^-128); the refusal below is what covers the rest.
  //
  // Spec 110 T028 — `privateKeyToAccount` replaces `computeAddress(new SigningKey(pk).publicKey)`,
  // and it refuses EXACTLY what SigningKey refused: zero, n, n+1, all-ones, short hex and non-hex
  // all throw in both libraries. That is not assumed — the whole derivation was byte-compared
  // against ethers before the swap (private key, address and symmetric key identical over eight
  // codes including empty, 200-char, unicode and mixed-case), because `claimAddress` IS the
  // on-chain `claimAuthority`: a single changed byte orphans every open challenge ever created.
  const claimPrivateKey = keccak256(stringToBytes(CLAIM_DOMAIN + normalized))
  const claimAddress = privateKeyToAccount(claimPrivateKey).address

  // Symmetric key: independent domain-separated keccak output.
  const symKey = hexToBytes(keccak256(stringToBytes(TERMS_DOMAIN + normalized)))

  return { claimPrivateKey, claimAddress, symKey }
}

/**
 * Sign an open-challenge acceptance with the code-derived key. The signature is bound to `taker` (= the
 * wallet that will send acceptOpenWager), so a mempool observer who copies it cannot reuse it for their own
 * address — they would need the code to re-sign (front-running defense, FR-011/SC-006).
 *
 * @param {string} code
 * @param {{ wagerId: bigint|number|string, taker: string, chainId: bigint|number, verifyingContract: string }} params
 * @returns {Promise<string>} 0x-hex signature for acceptOpenWager(wagerId, signature)
 */
export async function signOpenAccept(code, { wagerId, taker, chainId, verifyingContract }) {
  const { claimPrivateKey } = deriveFromCode(code)
  const domain = domainFor('wagerRegistry', chainId, verifyingContract)
  // viem needs the primary type ethers inferred; `primaryTypeOf` is that inference, not a guess at
  // the first key (which for a nested table can be a SUB-type — see lib/evm/typedData.js).
  const primaryType = primaryTypeOf(OPEN_ACCEPT_TYPES)
  if (!primaryType) throw new Error('signOpenAccept: the acceptance struct has no single primary type.')
  return privateKeyToAccount(claimPrivateKey).signTypedData({
    domain,
    types: OPEN_ACCEPT_TYPES,
    primaryType,
    message: { wagerId, taker },
  })
}

export { OPEN_ACCEPT_TYPES, EIP712_DOMAIN_NAME, EIP712_DOMAIN_VERSION }
