/**
 * Envelope Encryption for Friend Market Privacy
 *
 * Simple, sustainable encryption model for friend markets:
 * 1. Creator generates a random Data Encryption Key (DEK)
 * 2. Market metadata encrypted once with DEK
 * 3. DEK encrypted separately for each participant using their public key
 * 4. Participants decrypt the DEK, then decrypt the content
 *
 * Benefits:
 * - O(1) content encryption regardless of group size
 * - Simple key management
 * - Easy to add/remove participants
 * - Appropriate for static content (not ongoing messaging)
 */

import { x25519 } from '@noble/curves/ed25519.js'
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { sha3_256 } from '@noble/hashes/sha3.js'
import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha'
import { randomBytes } from '@noble/ciphers/webcrypto'
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/ciphers/utils'
import { keccak256, stringToBytes, toBytes } from 'viem'
import {
  CURRENT_ENCRYPTION_VERSION,
  getMarketSigningMessage,
  ENVELOPE_INFO,
  XWING_ENVELOPE_INFO,
  XWING_ALGORITHM,
  SUPPORTED_ALGORITHMS,
  buildTermsAAD,
  TERMS_AAD_VERSION
} from './constants.js'

// ==================== X-Wing Hybrid KEM Implementation ====================
// X-Wing combines X25519 + ML-KEM-768 per IETF draft-connolly-cfrg-xwing-kem
// If either algorithm remains secure, the combined scheme is secure

const XWING_LABEL = new TextEncoder().encode('\\./\n\\./\n')  // X-Wing label per spec

/**
 * X-Wing combiner function per IETF spec
 * SharedSecret = SHA3-256(XWING_LABEL || ss_M || ss_X || ct_X || pk_X)
 */
function xwingCombiner(mlkemSharedSecret, x25519SharedSecret, x25519Ciphertext, x25519PublicKey) {
  return sha3_256(concatBytes(
    XWING_LABEL,
    mlkemSharedSecret,
    x25519SharedSecret,
    x25519Ciphertext,
    x25519PublicKey
  ))
}

/**
 * X-Wing key generation from 32-byte seed
 * Returns hybrid public key (1184 ML-KEM + 32 X25519 = 1216 bytes)
 * and secret key (32-byte seed that can regenerate both component keys)
 */
function xwingKeygen(seed) {
  // Derive component seeds using domain separation
  // ML-KEM requires 64-byte seed, so we expand using SHA3-256 twice
  const mlkemSeed1 = sha3_256(concatBytes(new TextEncoder().encode('xwing-mlkem-1'), seed))
  const mlkemSeed2 = sha3_256(concatBytes(new TextEncoder().encode('xwing-mlkem-2'), seed))
  const mlkemSeed = concatBytes(mlkemSeed1, mlkemSeed2) // 64 bytes

  const x25519Seed = sha3_256(concatBytes(new TextEncoder().encode('xwing-x25519'), seed))

  // Generate ML-KEM-768 keypair (deterministic from 64-byte seed)
  const mlkemKeys = ml_kem768.keygen(mlkemSeed)

  // Generate X25519 keypair
  const x25519PrivateKey = x25519Seed.slice(0, 32)
  const x25519PublicKey = x25519.getPublicKey(x25519PrivateKey)

  // Combine public keys: ML-KEM (1184 bytes) || X25519 (32 bytes)
  const publicKey = concatBytes(mlkemKeys.publicKey, x25519PublicKey)

  return {
    publicKey,         // 1216 bytes
    secretKey: seed    // 32 bytes (the original seed)
  }
}

/**
 * X-Wing encapsulation - generate shared secret from recipient's public key
 * @param {Uint8Array} publicKey - X-Wing public key (must be exactly 1216 bytes)
 * @returns {{cipherText: Uint8Array, sharedSecret: Uint8Array}} Ciphertext (1120 bytes) and shared secret (32 bytes)
 */
function xwingEncapsulate(publicKey) {
  // Validate public key length (ML-KEM-768 public key: 1184 bytes + X25519 public key: 32 bytes = 1216 bytes)
  if (!publicKey || publicKey.length !== 1216) {
    throw new Error(`Invalid X-Wing public key: expected 1216 bytes, got ${publicKey?.length ?? 0}`)
  }

  // Split public key into components
  const mlkemPublicKey = publicKey.slice(0, 1184)
  const x25519PublicKey = publicKey.slice(1184, 1216)

  // Generate ephemeral X25519 keypair
  const x25519EphemeralPrivate = randomBytes(32)
  const x25519EphemeralPublic = x25519.getPublicKey(x25519EphemeralPrivate)

  // ML-KEM encapsulation
  const { cipherText: mlkemCiphertext, sharedSecret: mlkemSharedSecret } = ml_kem768.encapsulate(mlkemPublicKey)

  // X25519 key agreement
  const x25519SharedSecret = x25519.getSharedSecret(x25519EphemeralPrivate, x25519PublicKey)

  // Combine shared secrets using X-Wing combiner
  const sharedSecret = xwingCombiner(
    mlkemSharedSecret,
    x25519SharedSecret,
    x25519EphemeralPublic,  // ct_X is the ephemeral public key
    x25519PublicKey
  )

  // Ciphertext: ML-KEM (1088 bytes) || X25519 ephemeral public (32 bytes) = 1120 bytes
  const cipherText = concatBytes(mlkemCiphertext, x25519EphemeralPublic)

  return { cipherText, sharedSecret }
}

/**
 * X-Wing decapsulation - recover shared secret using secret key
 * @param {Uint8Array} cipherText - X-Wing ciphertext (must be exactly 1120 bytes)
 * @param {Uint8Array} secretKey - X-Wing secret key seed (must be exactly 32 bytes)
 * @returns {Uint8Array} Shared secret (32 bytes)
 */
function xwingDecapsulate(cipherText, secretKey) {
  // Validate ciphertext length (ML-KEM-768 ciphertext: 1088 bytes + X25519 ephemeral: 32 bytes = 1120 bytes)
  if (!cipherText || cipherText.length !== 1120) {
    throw new Error(`Invalid X-Wing ciphertext: expected 1120 bytes, got ${cipherText?.length ?? 0}`)
  }

  // Validate secret key seed length
  if (!secretKey || secretKey.length !== 32) {
    throw new Error(`Invalid X-Wing secret key: expected 32-byte seed, got ${secretKey?.length ?? 0}`)
  }

  // Regenerate component keys from seed (same derivation as xwingKeygen)
  const mlkemSeed1 = sha3_256(concatBytes(new TextEncoder().encode('xwing-mlkem-1'), secretKey))
  const mlkemSeed2 = sha3_256(concatBytes(new TextEncoder().encode('xwing-mlkem-2'), secretKey))
  const mlkemSeed = concatBytes(mlkemSeed1, mlkemSeed2) // 64 bytes

  const x25519Seed = sha3_256(concatBytes(new TextEncoder().encode('xwing-x25519'), secretKey))

  const mlkemKeys = ml_kem768.keygen(mlkemSeed)
  const x25519PrivateKey = x25519Seed.slice(0, 32)
  const x25519PublicKey = x25519.getPublicKey(x25519PrivateKey)

  // Split ciphertext into components
  const mlkemCiphertext = cipherText.slice(0, 1088)
  const x25519EphemeralPublic = cipherText.slice(1088, 1120)

  // ML-KEM decapsulation
  const mlkemSharedSecret = ml_kem768.decapsulate(mlkemCiphertext, mlkemKeys.secretKey)

  // X25519 key agreement
  const x25519SharedSecret = x25519.getSharedSecret(x25519PrivateKey, x25519EphemeralPublic)

  // Combine shared secrets using X-Wing combiner
  return xwingCombiner(
    mlkemSharedSecret,
    x25519SharedSecret,
    x25519EphemeralPublic,
    x25519PublicKey
  )
}

/**
 * Derive an X25519 key pair from a wallet signature
 * Deterministic: same wallet + same version always produces same keypair
 *
 * @param {Object} signer - Ethers signer
 * @param {number} [version=CURRENT_ENCRYPTION_VERSION] - Signing message version
 * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array, signature: string, version: number}>}
 */
export async function deriveKeyPair(signer, version = CURRENT_ENCRYPTION_VERSION) {
  const message = getMarketSigningMessage(version)
  const signature = await signer.signMessage(message)
  const hash = keccak256(stringToBytes(signature))
  const privateKey = toBytes(hash)
  const publicKey = x25519.getPublicKey(privateKey)

  return {
    publicKey,
    privateKey,
    signature, // Include for sharing with others
    version    // Include version for decryption
  }
}

/**
 * Derive a public key from a signature
 * Allows getting someone's encryption public key from their signature
 *
 * @param {string} signature - Their signature of KEY_DERIVATION_MESSAGE
 * @returns {Uint8Array} - Their X25519 public key
 */
export function publicKeyFromSignature(signature) {
  const hash = keccak256(stringToBytes(signature))
  const privateKey = toBytes(hash)
  return x25519.getPublicKey(privateKey)
}

/**
 * Derive full keypair from a cached signature (no wallet interaction)
 * Use this when you have a cached signature and need both public and private keys
 *
 * @param {string} signature - Cached signature of KEY_DERIVATION_MESSAGE
 * @returns {{publicKey: Uint8Array, privateKey: Uint8Array, signature: string}}
 */
export function deriveKeyPairFromSignature(signature) {
  const hash = keccak256(stringToBytes(signature))
  const privateKey = toBytes(hash)
  const publicKey = x25519.getPublicKey(privateKey)

  return {
    publicKey,
    privateKey,
    signature
  }
}

// ==================== Passkey seed-based derivation ====================
// Passkey accounts have no EOA signature to derive from; instead a per-account
// 32-byte master seed is recovered from the WebAuthn PRF extension (lib/passkey/
// prfKeys.js). These helpers turn that seed into the SAME kind of X25519 / X-Wing
// keypairs the signature path produces, so the on-chain KeyRegistry entry and the
// envelope interop are identical regardless of login method. The seed is expanded
// through HKDF with distinct info labels so the two keypairs are domain-separated
// from each other and can never collide with signature-derived material.
const PASSKEY_X25519_INFO = utf8ToBytes('fairwins-passkey-x25519-v1')
const PASSKEY_XWING_INFO = utf8ToBytes('fairwins-passkey-xwing-v1')
const PASSKEY_DERIVE_SALT = new Uint8Array(32)

/**
 * Derive the X25519 keypair for a passkey account from its master seed.
 * Deterministic: same seed ⇒ same keypair on every device/controller.
 *
 * @param {Uint8Array} seed - 32-byte PRF-derived master seed
 * @returns {{publicKey: Uint8Array, privateKey: Uint8Array}}
 */
export function deriveKeyPairFromSeed(seed) {
  if (!seed || seed.length !== 32) throw new Error('deriveKeyPairFromSeed: seed must be 32 bytes')
  const privateKey = hkdf(sha256, seed, PASSKEY_DERIVE_SALT, PASSKEY_X25519_INFO, 32)
  const publicKey = x25519.getPublicKey(privateKey)
  return { publicKey, privateKey }
}

/**
 * Derive the X-Wing (post-quantum) keypair for a passkey account from its master
 * seed. Deterministic: same seed ⇒ same keypair.
 *
 * @param {Uint8Array} seed - 32-byte PRF-derived master seed
 * @returns {{publicKey: Uint8Array, secretKey: Uint8Array}}
 */
export function deriveXWingKeyPairFromSeed(seed) {
  if (!seed || seed.length !== 32) throw new Error('deriveXWingKeyPairFromSeed: seed must be 32 bytes')
  const xwingSeed = hkdf(sha256, seed, PASSKEY_DERIVE_SALT, PASSKEY_XWING_INFO, 32)
  const { publicKey, secretKey } = xwingKeygen(xwingSeed)
  return { publicKey, secretKey }
}

// ==================== X-Wing Post-Quantum Functions ====================

/**
 * Derive an X-Wing key pair from a wallet signature
 * Uses the same deterministic approach as X25519 - same wallet + version = same keypair
 * X-Wing combines X25519 + ML-KEM-768 for post-quantum security
 *
 * @param {Object} signer - Ethers signer
 * @param {number} [version=CURRENT_ENCRYPTION_VERSION] - Signing message version
 * @returns {Promise<{publicKey: Uint8Array, secretKey: Uint8Array, signature: string, version: number, algorithm: string}>}
 */
export async function deriveXWingKeyPair(signer, version = CURRENT_ENCRYPTION_VERSION) {
  const message = getMarketSigningMessage(version)
  const signature = await signer.signMessage(message)
  const hash = keccak256(stringToBytes(signature))
  const seed = toBytes(hash)

  // X-Wing keygen with 32-byte seed produces deterministic keypair
  const { publicKey, secretKey } = xwingKeygen(seed)

  return {
    publicKey,      // 1216 bytes (1184 ML-KEM + 32 X25519)
    secretKey,      // 32 bytes (seed)
    signature,
    version,
    algorithm: 'xwing'
  }
}

/**
 * Derive X-Wing public key from a signature
 * Allows getting someone's encryption public key from their signature
 *
 * @param {string} signature - Their signature of the signing message
 * @returns {Uint8Array} - Their X-Wing public key (1216 bytes)
 */
export function xwingPublicKeyFromSignature(signature) {
  const hash = keccak256(stringToBytes(signature))
  const seed = toBytes(hash)
  const { publicKey } = xwingKeygen(seed)
  return publicKey
}

/**
 * Derive full X-Wing keypair from a cached signature (no wallet interaction)
 *
 * @param {string} signature - Cached signature
 * @returns {{publicKey: Uint8Array, secretKey: Uint8Array, signature: string}}
 */
export function deriveXWingKeyPairFromSignature(signature) {
  const hash = keccak256(stringToBytes(signature))
  const seed = toBytes(hash)
  const { publicKey, secretKey } = xwingKeygen(seed)

  return {
    publicKey,
    secretKey,
    signature
  }
}

/**
 * Encrypt data for multiple recipients using envelope encryption
 *
 * @param {Object|string} data - Data to encrypt
 * @param {Array<{address: string, publicKey: Uint8Array}>} recipients - List of recipients
 * @param {number} [signingVersion=CURRENT_ENCRYPTION_VERSION] - Signing message version used for key derivation
 * @returns {Object} - Encrypted envelope with version info
 */
export function encryptEnvelope(data, recipients, signingVersion = CURRENT_ENCRYPTION_VERSION, termsVersion = null) {
  // 1. Generate random Data Encryption Key (DEK)
  const dek = randomBytes(32)

  // 2. Encrypt the content with DEK.
  //    Spec 007 (FR-056): bind the governing T&C version hash as ChaCha20-Poly1305 AAD so
  //    the `termsVersion` field below is tamper-evident. Omitting termsVersion ⇒ aad
  //    undefined ⇒ byte-identical to legacy (no behavior change for existing callers).
  const plaintext = typeof data === 'string'
    ? utf8ToBytes(data)
    : utf8ToBytes(JSON.stringify(data))

  const aad = termsVersion?.hash ? buildTermsAAD(TERMS_AAD_VERSION, termsVersion.hash) : undefined
  const contentNonce = randomBytes(12)
  const cipher = chacha20poly1305(dek, contentNonce, aad)
  const encryptedContent = cipher.encrypt(plaintext)

  // 3. Encrypt DEK for each recipient using X25519 + HKDF + ChaCha20
  const wrappedKeys = recipients.map(recipient => {
    const ephemeralKeyPair = generateEphemeralKeyPair()

    // ECDH to derive shared secret
    const sharedSecret = x25519.getSharedSecret(
      ephemeralKeyPair.privateKey,
      recipient.publicKey
    )

    // Derive key encryption key from shared secret
    const kek = hkdf(sha256, sharedSecret, new Uint8Array(0), utf8ToBytes(ENVELOPE_INFO), 32)

    // Encrypt DEK with KEK
    const keyNonce = randomBytes(12)
    const keyCipher = chacha20poly1305(kek, keyNonce)
    const wrappedDek = keyCipher.encrypt(dek)

    return {
      address: recipient.address.toLowerCase(),
      ephemeralPublicKey: bytesToHex(ephemeralKeyPair.publicKey),
      nonce: bytesToHex(keyNonce),
      wrappedKey: bytesToHex(wrappedDek)
    }
  })

  return {
    version: '1.0',
    algorithm: 'x25519-chacha20poly1305',
    // Store the signing message version for decryption
    signingVersion: signingVersion,
    // Spec 007 (FR-056): authenticated governing-terms binding (present only when supplied).
    // Authenticated via AAD above; tampering with this field fails decryption.
    ...(termsVersion?.hash ? { termsVersion: { id: termsVersion.id ?? null, hash: termsVersion.hash } } : {}),
    content: {
      nonce: bytesToHex(contentNonce),
      ciphertext: bytesToHex(encryptedContent)
    },
    keys: wrappedKeys
  }
}

/**
 * Decrypt an envelope using our private key
 *
 * @param {Object} envelope - Encrypted envelope
 * @param {string} myAddress - Our address
 * @param {Uint8Array} myPrivateKey - Our X25519 private key
 * @returns {Object|string} - Decrypted data
 */
export function decryptEnvelope(envelope, myAddress, myPrivateKey) {
  const normalizedAddress = myAddress.toLowerCase()

  // Find our wrapped key
  const wrappedKeyEntry = envelope.keys.find(
    k => k.address === normalizedAddress
  )

  if (!wrappedKeyEntry) {
    throw new Error('No key found for this address')
  }

  // Reconstruct the shared secret using ECDH
  const ephemeralPublicKey = hexToBytes(wrappedKeyEntry.ephemeralPublicKey)
  const sharedSecret = x25519.getSharedSecret(myPrivateKey, ephemeralPublicKey)

  // Derive key encryption key
  const kek = hkdf(sha256, sharedSecret, new Uint8Array(0), utf8ToBytes(ENVELOPE_INFO), 32)

  // Decrypt the DEK
  const keyNonce = hexToBytes(wrappedKeyEntry.nonce)
  const wrappedKey = hexToBytes(wrappedKeyEntry.wrappedKey)
  const keyCipher = chacha20poly1305(kek, keyNonce)
  const dek = keyCipher.decrypt(wrappedKey)

  // Decrypt the content. Spec 007 (FR-056): if the envelope carries a governing-terms
  // binding, reconstruct the AAD from the authenticated field so a tampered termsVersion
  // fails authentication. Legacy envelopes (no termsVersion) decrypt with no AAD as before.
  const contentNonce = hexToBytes(envelope.content.nonce)
  const ciphertext = hexToBytes(envelope.content.ciphertext)
  const aad = envelope.termsVersion?.hash ? buildTermsAAD(TERMS_AAD_VERSION, envelope.termsVersion.hash) : undefined
  const contentCipher = chacha20poly1305(dek, contentNonce, aad)
  const plaintext = contentCipher.decrypt(ciphertext)

  // Parse as JSON if possible
  const decoded = new TextDecoder().decode(plaintext)
  try {
    return JSON.parse(decoded)
  } catch {
    return decoded
  }
}

/**
 * Add a new recipient to an existing envelope
 * Requires the DEK, which means an existing recipient must do this
 *
 * @param {Object} envelope - Existing encrypted envelope
 * @param {string} existingRecipientAddress - Address of existing recipient
 * @param {Uint8Array} existingRecipientPrivateKey - Private key to decrypt DEK
 * @param {{address: string, publicKey: Uint8Array}} newRecipient - New recipient to add
 * @returns {Object} - Updated envelope
 */
export function addRecipient(envelope, existingRecipientAddress, existingRecipientPrivateKey, newRecipient) {
  // First, recover the DEK
  const normalizedAddress = existingRecipientAddress.toLowerCase()
  const wrappedKeyEntry = envelope.keys.find(k => k.address === normalizedAddress)

  if (!wrappedKeyEntry) {
    throw new Error('Not a recipient of this envelope')
  }

  // Decrypt DEK
  const ephemeralPublicKey = hexToBytes(wrappedKeyEntry.ephemeralPublicKey)
  const sharedSecret = x25519.getSharedSecret(existingRecipientPrivateKey, ephemeralPublicKey)
  const kek = hkdf(sha256, sharedSecret, new Uint8Array(0), utf8ToBytes(ENVELOPE_INFO), 32)
  const keyNonce = hexToBytes(wrappedKeyEntry.nonce)
  const wrappedKey = hexToBytes(wrappedKeyEntry.wrappedKey)
  const keyCipher = chacha20poly1305(kek, keyNonce)
  const dek = keyCipher.decrypt(wrappedKey)

  // Encrypt DEK for new recipient
  const ephemeralKeyPair = generateEphemeralKeyPair()
  const newSharedSecret = x25519.getSharedSecret(ephemeralKeyPair.privateKey, newRecipient.publicKey)
  const newKek = hkdf(sha256, newSharedSecret, new Uint8Array(0), utf8ToBytes(ENVELOPE_INFO), 32)
  const newKeyNonce = randomBytes(12)
  const newKeyCipher = chacha20poly1305(newKek, newKeyNonce)
  const newWrappedDek = newKeyCipher.encrypt(dek)

  // Add to envelope
  const newWrappedKey = {
    address: newRecipient.address.toLowerCase(),
    ephemeralPublicKey: bytesToHex(ephemeralKeyPair.publicKey),
    nonce: bytesToHex(newKeyNonce),
    wrappedKey: bytesToHex(newWrappedDek)
  }

  return {
    ...envelope,
    keys: [...envelope.keys, newWrappedKey]
  }
}

/**
 * Remove a recipient from an envelope
 * Note: This doesn't re-encrypt - they may still have the DEK cached
 * For true revocation, create a new envelope with new DEK
 *
 * @param {Object} envelope - Encrypted envelope
 * @param {string} addressToRemove - Address to remove
 * @returns {Object} - Updated envelope
 */
export function removeRecipient(envelope, addressToRemove) {
  const normalized = addressToRemove.toLowerCase()
  return {
    ...envelope,
    keys: envelope.keys.filter(k => k.address !== normalized)
  }
}

// ==================== X-Wing Envelope Encryption ====================

/**
 * Encrypt data for multiple recipients using X-Wing hybrid KEM (post-quantum)
 *
 * @param {Object|string} data - Data to encrypt
 * @param {Array<{address: string, publicKey: Uint8Array}>} recipients - Recipients with X-Wing public keys
 * @param {number} [signingVersion=CURRENT_ENCRYPTION_VERSION] - Signing message version
 * @returns {Object} - X-Wing encrypted envelope (v2.0)
 */
export function encryptEnvelopeXWing(data, recipients, signingVersion = CURRENT_ENCRYPTION_VERSION, termsVersion = null) {
  // 1. Generate random Data Encryption Key (DEK)
  const dek = randomBytes(32)

  // 2. Encrypt the content with DEK (same as v1.0). Spec 007 (FR-056): governing-terms
  //    AAD binding when termsVersion is supplied; omitted ⇒ identical to legacy.
  const plaintext = typeof data === 'string'
    ? utf8ToBytes(data)
    : utf8ToBytes(JSON.stringify(data))

  const aad = termsVersion?.hash ? buildTermsAAD(TERMS_AAD_VERSION, termsVersion.hash) : undefined
  const contentNonce = randomBytes(12)
  const cipher = chacha20poly1305(dek, contentNonce, aad)
  const encryptedContent = cipher.encrypt(plaintext)

  // 3. Wrap DEK for each recipient using X-Wing KEM
  const wrappedKeys = recipients.map(recipient => {
    // X-Wing encapsulate generates shared secret and ciphertext
    const { cipherText, sharedSecret } = xwingEncapsulate(recipient.publicKey)

    // Derive Key Encryption Key (KEK) from X-Wing shared secret
    const kek = hkdf(sha256, sharedSecret, new Uint8Array(0), utf8ToBytes(XWING_ENVELOPE_INFO), 32)

    // Encrypt DEK with KEK
    const keyNonce = randomBytes(12)
    const keyCipher = chacha20poly1305(kek, keyNonce)
    const wrappedDek = keyCipher.encrypt(dek)

    return {
      address: recipient.address.toLowerCase(),
      // X-Wing ciphertext contains both ML-KEM and X25519 components (1120 bytes)
      xwingCiphertext: bytesToHex(cipherText),
      nonce: bytesToHex(keyNonce),
      wrappedKey: bytesToHex(wrappedDek)
    }
  })

  return {
    version: '2.0',
    algorithm: XWING_ALGORITHM,
    signingVersion: signingVersion,
    ...(termsVersion?.hash ? { termsVersion: { id: termsVersion.id ?? null, hash: termsVersion.hash } } : {}),
    content: {
      nonce: bytesToHex(contentNonce),
      ciphertext: bytesToHex(encryptedContent)
    },
    keys: wrappedKeys
  }
}

/**
 * Decrypt an X-Wing envelope using our secret key
 *
 * @param {Object} envelope - X-Wing encrypted envelope
 * @param {string} myAddress - Our address
 * @param {Uint8Array} mySecretKey - Our X-Wing secret key (32-byte seed)
 * @returns {Object|string} - Decrypted data
 */
export function decryptEnvelopeXWing(envelope, myAddress, mySecretKey) {
  const normalizedAddress = myAddress.toLowerCase()

  // Find our wrapped key
  const wrappedKeyEntry = envelope.keys.find(
    k => k.address === normalizedAddress
  )

  if (!wrappedKeyEntry) {
    throw new Error('No key found for this address')
  }

  // Recover shared secret using X-Wing decapsulate
  const xwingCiphertext = hexToBytes(wrappedKeyEntry.xwingCiphertext)
  const sharedSecret = xwingDecapsulate(xwingCiphertext, mySecretKey)

  // Derive Key Encryption Key
  const kek = hkdf(sha256, sharedSecret, new Uint8Array(0), utf8ToBytes(XWING_ENVELOPE_INFO), 32)

  // Decrypt the DEK
  const keyNonce = hexToBytes(wrappedKeyEntry.nonce)
  const wrappedKey = hexToBytes(wrappedKeyEntry.wrappedKey)
  const keyCipher = chacha20poly1305(kek, keyNonce)
  const dek = keyCipher.decrypt(wrappedKey)

  // Decrypt the content. Spec 007 (FR-056): if the envelope carries a governing-terms
  // binding, reconstruct the AAD from the authenticated field so a tampered termsVersion
  // fails authentication. Legacy envelopes (no termsVersion) decrypt with no AAD as before.
  const contentNonce = hexToBytes(envelope.content.nonce)
  const ciphertext = hexToBytes(envelope.content.ciphertext)
  const aad = envelope.termsVersion?.hash ? buildTermsAAD(TERMS_AAD_VERSION, envelope.termsVersion.hash) : undefined
  const contentCipher = chacha20poly1305(dek, contentNonce, aad)
  const plaintext = contentCipher.decrypt(ciphertext)

  // Parse as JSON if possible
  const decoded = new TextDecoder().decode(plaintext)
  try {
    return JSON.parse(decoded)
  } catch {
    return decoded
  }
}

/**
 * Add a new recipient to an existing X-Wing envelope
 *
 * @param {Object} envelope - Existing X-Wing encrypted envelope
 * @param {string} existingRecipientAddress - Address of existing recipient
 * @param {Uint8Array} existingRecipientSecretKey - Secret key to decrypt DEK
 * @param {{address: string, publicKey: Uint8Array}} newRecipient - New recipient to add
 * @returns {Object} - Updated envelope
 */
export function addRecipientXWing(envelope, existingRecipientAddress, existingRecipientSecretKey, newRecipient) {
  // First, recover the DEK
  const normalizedAddress = existingRecipientAddress.toLowerCase()
  const wrappedKeyEntry = envelope.keys.find(k => k.address === normalizedAddress)

  if (!wrappedKeyEntry) {
    throw new Error('Not a recipient of this envelope')
  }

  // Decrypt DEK using X-Wing
  const xwingCiphertext = hexToBytes(wrappedKeyEntry.xwingCiphertext)
  const sharedSecret = xwingDecapsulate(xwingCiphertext, existingRecipientSecretKey)
  const kek = hkdf(sha256, sharedSecret, new Uint8Array(0), utf8ToBytes(XWING_ENVELOPE_INFO), 32)
  const keyNonce = hexToBytes(wrappedKeyEntry.nonce)
  const wrappedKey = hexToBytes(wrappedKeyEntry.wrappedKey)
  const keyCipher = chacha20poly1305(kek, keyNonce)
  const dek = keyCipher.decrypt(wrappedKey)

  // Encrypt DEK for new recipient using X-Wing
  const { cipherText: newCiphertext, sharedSecret: newSharedSecret } = xwingEncapsulate(newRecipient.publicKey)
  const newKek = hkdf(sha256, newSharedSecret, new Uint8Array(0), utf8ToBytes(XWING_ENVELOPE_INFO), 32)
  const newKeyNonce = randomBytes(12)
  const newKeyCipher = chacha20poly1305(newKek, newKeyNonce)
  const newWrappedDek = newKeyCipher.encrypt(dek)

  // Add to envelope
  const newWrappedKey = {
    address: newRecipient.address.toLowerCase(),
    xwingCiphertext: bytesToHex(newCiphertext),
    nonce: bytesToHex(newKeyNonce),
    wrappedKey: bytesToHex(newWrappedDek)
  }

  return {
    ...envelope,
    keys: [...envelope.keys, newWrappedKey]
  }
}

/**
 * Unified decrypt function - auto-detects envelope version and uses appropriate decryption
 *
 * @param {Object} envelope - Encrypted envelope (any version)
 * @param {string} myAddress - Our address
 * @param {Object} keys - Object containing both key types: { x25519PrivateKey?, xwingSecretKey? }
 * @returns {Object|string} - Decrypted data
 */
export function decryptEnvelopeUnified(envelope, myAddress, keys) {
  if (isXWingEnvelope(envelope)) {
    if (!keys.xwingSecretKey) {
      throw new Error('X-Wing secret key required for v2.0 envelope')
    }
    return decryptEnvelopeXWing(envelope, myAddress, keys.xwingSecretKey)
  } else {
    if (!keys.x25519PrivateKey) {
      throw new Error('X25519 private key required for v1.0 envelope')
    }
    return decryptEnvelope(envelope, myAddress, keys.x25519PrivateKey)
  }
}

/**
 * Check if an address can decrypt an envelope
 *
 * @param {Object} envelope - Encrypted envelope
 * @param {string} address - Address to check
 * @returns {boolean}
 */
export function canDecrypt(envelope, address) {
  if (!envelope?.keys) return false
  const normalized = address?.toLowerCase()
  return envelope.keys.some(k => k.address === normalized)
}

/**
 * Get list of recipients who can decrypt
 *
 * @param {Object} envelope - Encrypted envelope
 * @returns {string[]} - Array of addresses
 */
export function getRecipients(envelope) {
  if (!envelope?.keys) return []
  return envelope.keys.map(k => k.address)
}

/**
 * Check if data is an encrypted envelope (any supported version)
 *
 * @param {Object} data
 * @returns {boolean}
 */
export function isEncryptedEnvelope(data) {
  if (!data?.version || !data?.algorithm || !data?.content?.ciphertext || !Array.isArray(data?.keys)) {
    return false
  }
  return SUPPORTED_ALGORITHMS.includes(data.algorithm)
}

/**
 * Check if data is an X-Wing (post-quantum) envelope
 *
 * @param {Object} data
 * @returns {boolean}
 */
export function isXWingEnvelope(data) {
  return data?.algorithm === XWING_ALGORITHM
}

/**
 * Check if data is a v1.0 X25519 envelope
 *
 * @param {Object} data
 * @returns {boolean}
 */
export function isX25519Envelope(data) {
  return data?.algorithm === 'x25519-chacha20poly1305'
}

// ==================== Code-keyed Envelope (feature 024 — open challenges) ====================
// The terms of an open challenge are sealed directly under a symmetric key derived from the four-word claim
// code (see utils/claimCode/deriveFromCode.js) — NOT to a registered recipient key, because the taker is
// unknown at creation (FR-017/FR-018). Anyone holding the code derives `symKey` and can read; nobody else
// can. Tamper-evident via XChaCha20-Poly1305 (FR-019); the on-chain metadataHash binds the bundle as usual.

const CODE_ENVELOPE_ALGORITHM = 'code-xchacha20poly1305'

/**
 * Seal open-challenge terms under a code-derived symmetric key. No recipients list.
 * @param {Object|string} data - terms (object is JSON-stringified)
 * @param {Uint8Array} symKey - 32-byte key from deriveFromCode(code).symKey
 * @param {{id?: string|null, hash: string}|null} termsVersion - optional governing-terms binding (AAD)
 * @returns {Object} code-keyed envelope
 */
export function encryptEnvelopeCode(data, symKey, termsVersion = null) {
  if (!(symKey instanceof Uint8Array) || symKey.length !== 32) {
    throw new Error('encryptEnvelopeCode: symKey must be a 32-byte Uint8Array')
  }
  const plaintext = typeof data === 'string' ? utf8ToBytes(data) : utf8ToBytes(JSON.stringify(data))
  const aad = termsVersion?.hash ? buildTermsAAD(TERMS_AAD_VERSION, termsVersion.hash) : undefined
  const nonce = randomBytes(24) // XChaCha20 — 24-byte nonce, safe under random generation
  const cipher = xchacha20poly1305(symKey, nonce, aad)
  const ciphertext = cipher.encrypt(plaintext)

  return {
    version: 'code-1.0',
    algorithm: CODE_ENVELOPE_ALGORITHM,
    mode: 'code',
    ...(termsVersion?.hash ? { termsVersion: { id: termsVersion.id ?? null, hash: termsVersion.hash } } : {}),
    content: {
      nonce: bytesToHex(nonce),
      ciphertext: bytesToHex(ciphertext)
    }
  }
}

/**
 * Open a code-keyed envelope with the code-derived symmetric key. Throws on a wrong key or tampered bytes.
 * @param {Object} envelope
 * @param {Uint8Array} symKey
 * @returns {Object|string} decrypted terms (parsed as JSON when possible)
 */
export function decryptEnvelopeCode(envelope, symKey) {
  if (!isCodeEnvelope(envelope)) throw new Error('decryptEnvelopeCode: not a code-keyed envelope')
  if (!(symKey instanceof Uint8Array) || symKey.length !== 32) {
    throw new Error('decryptEnvelopeCode: symKey must be a 32-byte Uint8Array')
  }
  const nonce = hexToBytes(envelope.content.nonce)
  const aad = envelope.termsVersion?.hash ? buildTermsAAD(TERMS_AAD_VERSION, envelope.termsVersion.hash) : undefined
  const cipher = xchacha20poly1305(symKey, nonce, aad)
  const plaintext = cipher.decrypt(hexToBytes(envelope.content.ciphertext)) // throws on tamper / wrong key
  const text = new TextDecoder().decode(plaintext)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * @param {Object} data
 * @returns {boolean} true iff `data` is a code-keyed envelope (mode === 'code').
 */
export function isCodeEnvelope(data) {
  return data?.mode === 'code' && data?.algorithm === CODE_ENVELOPE_ALGORITHM && !!data?.content?.ciphertext
}

// ==================== Helper Functions ====================

/**
 * Generate an ephemeral X25519 key pair
 */
function generateEphemeralKeyPair() {
  const privateKey = randomBytes(32)
  const publicKey = x25519.getPublicKey(privateKey)
  return { privateKey, publicKey }
}

// ==================== High-Level API ====================

/**
 * Encrypt market metadata for a friend market
 *
 * @param {Object} metadata - Market metadata (name, description, etc.)
 * @param {Array<{address: string, signature: string}>} participants - Participants with signatures
 * @param {number} [signingVersion=CURRENT_ENCRYPTION_VERSION] - Signing message version
 * @returns {Object} - Encrypted envelope ready for IPFS
 */
export function encryptMarketMetadata(metadata, participants, signingVersion = CURRENT_ENCRYPTION_VERSION, termsVersion = null) {
  // Convert signatures to public keys
  const recipients = participants.map(p => ({
    address: p.address,
    publicKey: publicKeyFromSignature(p.signature)
  }))

  return encryptEnvelope(metadata, recipients, signingVersion, termsVersion)
}

/**
 * Decrypt market metadata
 *
 * Uses the signing version stored in the envelope to derive the correct keys.
 * For backwards compatibility, assumes version 1 if not specified.
 *
 * @param {Object} envelope - Encrypted envelope from IPFS
 * @param {string} myAddress - Our address
 * @param {Object|Uint8Array} signerOrPrivateKey - Ethers signer OR cached private key
 * @returns {Promise<Object>} - Decrypted metadata
 */
export async function decryptMarketMetadata(envelope, myAddress, signerOrPrivateKey) {
  // Get the signing version from envelope (default to 1 for backwards compatibility)
  const signingVersion = envelope.signingVersion || 1

  // If it's already a Uint8Array (cached private key), use it directly
  // Note: cached private keys are version-specific, caller must ensure correct version
  let privateKey
  if (signerOrPrivateKey instanceof Uint8Array) {
    privateKey = signerOrPrivateKey
  } else {
    // It's a signer - derive the key with the correct version (requires wallet popup)
    const result = await deriveKeyPair(signerOrPrivateKey, signingVersion)
    privateKey = result.privateKey
  }
  return decryptEnvelope(envelope, myAddress, privateKey)
}

/**
 * Get the signing version required to decrypt an envelope
 * Useful for UI to inform users which signing message will be shown
 *
 * @param {Object} envelope - Encrypted envelope
 * @returns {number} - Signing version (defaults to 1 for legacy envelopes)
 */
export function getEnvelopeSigningVersion(envelope) {
  return envelope?.signingVersion || 1
}

/**
 * Create encrypted friend market metadata with creator as first recipient
 *
 * @param {Object} metadata - Market metadata
 * @param {Object} signer - Creator's signer
 * @param {string} creatorAddress - Creator's address
 * @returns {Promise<{envelope: Object, creatorSignature: string, signingVersion: number}>}
 */
export async function createEncryptedMarket(metadata, signer, creatorAddress, termsVersion = null) {
  // Use current version for new markets
  const { signature, version } = await deriveKeyPair(signer, CURRENT_ENCRYPTION_VERSION)

  // Start with just creator as recipient
  const envelope = encryptMarketMetadata(metadata, [
    { address: creatorAddress, signature }
  ], version, termsVersion)

  return {
    envelope,
    creatorSignature: signature,
    signingVersion: version
  }
}

/**
 * Add a participant to an encrypted market
 *
 * IMPORTANT: The new participant must have signed with the SAME version
 * as the original market. Use getEnvelopeSigningVersion() to determine
 * which signing message to present to the new participant.
 *
 * @param {Object} envelope - Existing envelope
 * @param {string} existingAddress - An existing recipient's address
 * @param {Object|Uint8Array} existingSignerOrPrivateKey - Existing recipient's signer OR cached private key
 * @param {string} newAddress - New participant's address
 * @param {string} newSignature - New participant's key derivation signature (must be same version as envelope)
 * @returns {Promise<Object>} - Updated envelope
 */
export async function addParticipantToMarket(envelope, existingAddress, existingSignerOrPrivateKey, newAddress, newSignature) {
  // Get the signing version from the envelope
  const signingVersion = envelope.signingVersion || 1

  // If it's already a Uint8Array (cached private key), use it directly
  let privateKey
  if (existingSignerOrPrivateKey instanceof Uint8Array) {
    privateKey = existingSignerOrPrivateKey
  } else {
    // It's a signer - derive the key with the envelope's version (requires wallet popup)
    const result = await deriveKeyPair(existingSignerOrPrivateKey, signingVersion)
    privateKey = result.privateKey
  }

  const newPublicKey = publicKeyFromSignature(newSignature)

  return addRecipient(envelope, existingAddress, privateKey, {
    address: newAddress,
    publicKey: newPublicKey
  })
}

// ==================== X-Wing High-Level API ====================

/**
 * Encrypt market metadata using X-Wing (post-quantum)
 *
 * @param {Object} metadata - Market metadata (name, description, etc.)
 * @param {Array<{address: string, signature: string}>} participants - Participants with signatures
 * @param {number} [signingVersion=CURRENT_ENCRYPTION_VERSION] - Signing message version
 * @returns {Object} - X-Wing encrypted envelope
 */
export function encryptMarketMetadataXWing(metadata, participants, signingVersion = CURRENT_ENCRYPTION_VERSION, termsVersion = null) {
  // Convert signatures to X-Wing public keys
  const recipients = participants.map(p => ({
    address: p.address,
    publicKey: xwingPublicKeyFromSignature(p.signature)
  }))

  return encryptEnvelopeXWing(metadata, recipients, signingVersion, termsVersion)
}

/**
 * Create encrypted friend market using X-Wing (post-quantum)
 *
 * @param {Object} metadata - Market metadata
 * @param {Object} signer - Creator's signer
 * @param {string} creatorAddress - Creator's address
 * @returns {Promise<{envelope: Object, creatorSignature: string, signingVersion: number}>}
 */
export async function createEncryptedMarketXWing(metadata, signer, creatorAddress, termsVersion = null) {
  // Use current version for new markets
  const { signature, version } = await deriveXWingKeyPair(signer, CURRENT_ENCRYPTION_VERSION)

  // Start with just creator as recipient
  const envelope = encryptMarketMetadataXWing(metadata, [
    { address: creatorAddress, signature }
  ], version, termsVersion)

  return {
    envelope,
    creatorSignature: signature,
    signingVersion: version
  }
}

/**
 * Add a participant to an X-Wing encrypted market
 *
 * @param {Object} envelope - Existing X-Wing envelope
 * @param {string} existingAddress - An existing recipient's address
 * @param {Object|Uint8Array} existingSignerOrSecretKey - Existing recipient's signer OR cached secret key
 * @param {string} newAddress - New participant's address
 * @param {string} newSignature - New participant's signature
 * @returns {Promise<Object>} - Updated envelope
 */
export async function addParticipantToMarketXWing(envelope, existingAddress, existingSignerOrSecretKey, newAddress, newSignature) {
  const signingVersion = envelope.signingVersion || CURRENT_ENCRYPTION_VERSION

  // If it's already a Uint8Array (cached secret key), use it directly
  let secretKey
  if (existingSignerOrSecretKey instanceof Uint8Array) {
    secretKey = existingSignerOrSecretKey
  } else {
    const result = await deriveXWingKeyPair(existingSignerOrSecretKey, signingVersion)
    secretKey = result.secretKey
  }

  const newPublicKey = xwingPublicKeyFromSignature(newSignature)

  return addRecipientXWing(envelope, existingAddress, secretKey, {
    address: newAddress,
    publicKey: newPublicKey
  })
}

/**
 * Unified add participant - auto-detects envelope type
 *
 * @param {Object} envelope - Encrypted envelope (any version)
 * @param {string} existingAddress - Existing recipient's address
 * @param {Object} keys - { x25519PrivateKey?, xwingSecretKey? }
 * @param {string} newAddress - New participant's address
 * @param {string} newSignature - New participant's signature
 * @returns {Object} - Updated envelope
 */
export function addParticipantUnified(envelope, existingAddress, keys, newAddress, newSignature) {
  if (isXWingEnvelope(envelope)) {
    if (!keys.xwingSecretKey) {
      throw new Error('X-Wing secret key required for v2.0 envelope')
    }
    const newPublicKey = xwingPublicKeyFromSignature(newSignature)
    return addRecipientXWing(envelope, existingAddress, keys.xwingSecretKey, {
      address: newAddress,
      publicKey: newPublicKey
    })
  } else {
    if (!keys.x25519PrivateKey) {
      throw new Error('X25519 private key required for v1.0 envelope')
    }
    const newPublicKey = publicKeyFromSignature(newSignature)
    return addRecipient(envelope, existingAddress, keys.x25519PrivateKey, {
      address: newAddress,
      publicKey: newPublicKey
    })
  }
}
