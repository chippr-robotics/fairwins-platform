/**
 * Cryptographic Primitives for Double Ratchet Protocol
 *
 * Provides low-level crypto operations using audited @noble libraries.
 * All operations use modern, secure algorithms:
 * - X25519 for key exchange (Curve25519 ECDH)
 * - Ed25519 for signatures
 * - ChaCha20-Poly1305 for authenticated encryption
 * - HKDF-SHA256 for key derivation
 */

import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8, randomBytes } from '@noble/ciphers/utils.js'

// Re-export utilities
export { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8, randomBytes }

/**
 * Generate a random X25519 key pair
 * @returns {{publicKey: Uint8Array, privateKey: Uint8Array}}
 */
export function generateKeyPair() {
  const privateKey = randomBytes(32)
  const publicKey = x25519.getPublicKey(privateKey)
  return { publicKey, privateKey }
}

/**
 * Compute X25519 shared secret (ECDH)
 * @param {Uint8Array} privateKey - Our private key
 * @param {Uint8Array} publicKey - Their public key
 * @returns {Uint8Array} - 32-byte shared secret
 */
export function computeSharedSecret(privateKey, publicKey) {
  return x25519.getSharedSecret(privateKey, publicKey)
}

/**
 * HKDF key derivation
 * @param {Uint8Array} inputKeyMaterial - Input key material
 * @param {Uint8Array|string} salt - Salt (can be empty for some uses)
 * @param {Uint8Array|string} info - Context info
 * @param {number} length - Output length in bytes
 * @returns {Uint8Array}
 */
export function deriveKey(inputKeyMaterial, salt, info, length = 32) {
  const saltBytes = typeof salt === 'string' ? utf8ToBytes(salt) : salt
  const infoBytes = typeof info === 'string' ? utf8ToBytes(info) : info
  return hkdf(sha256, inputKeyMaterial, saltBytes, infoBytes, length)
}

/**
 * HMAC-SHA256
 * @param {Uint8Array} key - HMAC key
 * @param {Uint8Array} message - Message to authenticate
 * @returns {Uint8Array} - 32-byte MAC
 */
export function hmacSha256(key, message) {
  return hmac(sha256, key, message)
}

/**
 * SHA256 hash
 * @param {Uint8Array|string} data - Data to hash
 * @returns {Uint8Array} - 32-byte hash
 */
export function hash(data) {
  const bytes = typeof data === 'string' ? utf8ToBytes(data) : data
  return sha256(bytes)
}

/**
 * Encrypt with ChaCha20-Poly1305 (AEAD)
 * @param {Uint8Array} key - 32-byte encryption key
 * @param {Uint8Array} plaintext - Data to encrypt
 * @param {Uint8Array} associatedData - Additional authenticated data (optional)
 * @returns {{nonce: Uint8Array, ciphertext: Uint8Array}}
 */
export function encrypt(key, plaintext, associatedData = new Uint8Array(0)) {
  const nonce = randomBytes(12) // 96-bit nonce for ChaCha20-Poly1305
  const cipher = chacha20poly1305(key, nonce, associatedData)
  const ciphertext = cipher.encrypt(plaintext)
  return { nonce, ciphertext }
}

/**
 * Decrypt with ChaCha20-Poly1305 (AEAD)
 * @param {Uint8Array} key - 32-byte encryption key
 * @param {Uint8Array} nonce - 12-byte nonce
 * @param {Uint8Array} ciphertext - Encrypted data with auth tag
 * @param {Uint8Array} associatedData - Additional authenticated data (optional)
 * @returns {Uint8Array} - Decrypted plaintext
 * @throws {Error} - If authentication fails
 */
export function decrypt(key, nonce, ciphertext, associatedData = new Uint8Array(0)) {
  const cipher = chacha20poly1305(key, nonce, associatedData)
  return cipher.decrypt(ciphertext)
}

/**
 * Encrypt a JSON object
 * @param {Uint8Array} key - Encryption key
 * @param {Object} data - Object to encrypt
 * @param {Uint8Array} associatedData - AAD (optional)
 * @returns {{nonce: string, ciphertext: string}} - Hex-encoded
 */
export function encryptJson(key, data, associatedData = new Uint8Array(0)) {
  const plaintext = utf8ToBytes(JSON.stringify(data))
  const { nonce, ciphertext } = encrypt(key, plaintext, associatedData)
  return {
    nonce: bytesToHex(nonce),
    ciphertext: bytesToHex(ciphertext)
  }
}

/**
 * Decrypt a JSON object
 * @param {Uint8Array} key - Encryption key
 * @param {string} nonceHex - Hex-encoded nonce
 * @param {string} ciphertextHex - Hex-encoded ciphertext
 * @param {Uint8Array} associatedData - AAD (optional)
 * @returns {Object} - Decrypted object
 */
export function decryptJson(key, nonceHex, ciphertextHex, associatedData = new Uint8Array(0)) {
  const nonce = hexToBytes(nonceHex)
  const ciphertext = hexToBytes(ciphertextHex)
  const plaintext = decrypt(key, nonce, ciphertext, associatedData)
  return JSON.parse(bytesToUtf8(plaintext))
}

/**
 * Constant-time comparison of two byte arrays
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i]
  }
  return result === 0
}

/**
 * Concatenate multiple Uint8Arrays
 * @param  {...Uint8Array} arrays
 * @returns {Uint8Array}
 */
export function concat(...arrays) {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

/**
 * Convert a number to a 4-byte big-endian array
 * @param {number} n
 * @returns {Uint8Array}
 */
export function numberToBytes(n) {
  const bytes = new Uint8Array(4)
  bytes[0] = (n >> 24) & 0xff
  bytes[1] = (n >> 16) & 0xff
  bytes[2] = (n >> 8) & 0xff
  bytes[3] = n & 0xff
  return bytes
}

/**
 * Convert 4 big-endian bytes to a number
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function bytesToNumber(bytes) {
  return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
}
