// Spec 032 — encryption for the unified data backup. Reuses the audited primitives + the wallet-signature
// key-derivation pattern (keccak256 of a domain-separated signMessage). The domain message is DISTINCT from
// the wager/address-book messages so the backup key can never coincide with another key the wallet derives.
// Header is bound via AEAD AAD.
//
// NOTE: this channel is still encrypted, and stays that way. The MANUAL address-book export file went to
// plain text in issue #1550 (lib/addressBook/addressBookFile.js) because it is meant to be read and shared;
// this bundle is not, and it carries recovery-code envelopes and legacy private-key blobs besides.

import { concat, keccak256, stringToBytes, toBytes } from 'viem'
import { encryptJson, decryptJson, utf8ToBytes } from '../../utils/crypto/primitives'

export const DATA_BACKUP_MESSAGE_V1 = 'FairWins Data Backup v1'
export const BACKUP_FORMAT = 'fairwins-data-backup'
export const BACKUP_VERSION = 1

const AAD = utf8ToBytes(`${BACKUP_FORMAT}:${BACKUP_VERSION}`)

/** Derive the 32-byte symmetric key from a signature string (no wallet prompt). Pure + deterministic. */
export function deriveKeyFromSignature(signature) {
  return toBytes(keccak256(stringToBytes(signature)))
}

/** Derive the backup key by asking the wallet to sign the fixed domain message (one prompt; cache upstream). */
export async function deriveKey(signer) {
  const signature = await signer.signMessage(DATA_BACKUP_MESSAGE_V1)
  return deriveKeyFromSignature(signature)
}

/**
 * Derive the 32-byte backup key from a passkey account's PRF master seed (spec 041) — the login-method-
 * agnostic twin of {@link deriveKey}. The seed is deterministic per account (same seed on every controller
 * with key material), and domain-separating with the fixed backup message keeps this key independent from the
 * X25519/X-Wing keys the same seed derives. Pure + deterministic (no ceremony here; the caller resolves the
 * seed once via one WebAuthn assertion).
 * @param {Uint8Array} seed - 32-byte master seed
 */
export function deriveKeyFromSeed(seed) {
  return toBytes(keccak256(concat([seed, stringToBytes(DATA_BACKUP_MESSAGE_V1)])))
}

/** Encrypt a bundle object into the storable envelope. */
export function encryptBundle(key, bundle) {
  const { nonce, ciphertext } = encryptJson(key, bundle, AAD)
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, alg: 'chacha20poly1305', nonce, ciphertext }
}

/** Decrypt an envelope back to the bundle. Throws on a wrong key / tampered envelope (AEAD auth fails) or a
 *  non-backup/foreign-version envelope — callers treat a throw as "no usable backup" (never overwrite local). */
export function decryptBundle(key, envelope) {
  if (!envelope || envelope.format !== BACKUP_FORMAT || envelope.version !== BACKUP_VERSION) {
    throw new Error('Not a recognized FairWins data backup')
  }
  return decryptJson(key, envelope.nonce, envelope.ciphertext, AAD)
}
