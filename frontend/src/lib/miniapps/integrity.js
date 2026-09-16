/**
 * Mini-app package integrity (spec 073, research R3 · FR-011).
 *
 * This module is the only place in the host that decides whether bytes fetched
 * from a gateway are the bytes a curator approved. Everything the platform
 * promises about supply-chain safety reduces to the two comparisons below:
 *
 *   1. `keccak256(manifest.json bytes) === registry.approved.manifestHash`
 *   2. `sha256(file bytes) === manifest.files[path].sha256`  (for every executed file)
 *
 * Three deliberate properties, each of which is a hole if reversed:
 *
 * - **Bytes, never objects.** Every verify function takes the raw bytes as they
 *   came off the wire. Accepting a parsed manifest and re-serializing it before
 *   hashing would compare *our* JSON encoding against the chain's, so a package
 *   whose bytes differ from the approved ones (whitespace, key order, a trailing
 *   field our parser dropped) would verify anyway. Passing a `string` is refused
 *   for the same reason — a decode/encode round trip is not the identity.
 * - **Normalize before compare.** Digests arrive from three encodings (Solidity
 *   `bytes32` via ethers, lowercase hex in the manifest, whatever a hand-edited
 *   record contains). Both sides are put through the same normalizer, so a
 *   mismatch is a real mismatch and `0X…`/`0x…`/uppercase can neither pass nor
 *   fail spuriously.
 * - **An unusable expected value is a refusal, not a pass.** If the digest we
 *   are supposed to compare against is malformed, verification fails closed.
 *   "No expected value ⇒ accept" is how integrity checks quietly stop existing.
 *
 * Pure module: no IO, no React, no network. The gateway is untrusted by
 * construction — CID validity is a cheap pre-check elsewhere, never the
 * integrity boundary.
 */

import { keccak256 } from 'viem'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/** 64 hex characters — a SHA-256 or keccak-256 digest body, with no `0x` prefix. */
const DIGEST_BODY = /^[0-9a-fA-F]{64}$/

/** The all-zero `bytes32`, i.e. "the registry never recorded a hash here". */
export const ZERO_MANIFEST_HASH = `0x${'0'.repeat(64)}`

/**
 * A fetched package did not match what the chain (or its own manifest) says it
 * should be. Always terminal: the bytes are discarded, nothing is imported, and
 * the host audits the event (`miniapp_integrity_failed`, FR-019).
 *
 * `userMessage` is the professional, member-facing sentence; `message` carries
 * the digests for the log. Neither ever contains package bytes.
 */
export class IntegrityError extends Error {
  /**
   * @param {string} reason - stable machine code (see the throw sites below)
   * @param {string} message - developer/log detail
   * @param {{path?: string, expected?: string|null, actual?: string|null, userMessage?: string}} [detail]
   */
  constructor(reason, message, detail = {}) {
    super(message)
    this.name = 'IntegrityError'
    this.reason = reason
    this.path = detail.path ?? null
    this.expected = detail.expected ?? null
    this.actual = detail.actual ?? null
    this.userMessage =
      detail.userMessage ??
      'This app package does not match the version approved on-chain, so it was not run. ' +
        'Nothing from it was executed. Please report this to the platform team.'
  }
}

/**
 * Coerce a byte container to `Uint8Array`, refusing anything that is not
 * already bytes.
 *
 * A `string` is rejected on purpose: the caller would have had to decode the
 * response, and re-encoding it here is a different byte sequence than the one
 * the gateway served whenever the encoding is not exactly UTF-8. The only way
 * to be sure we hash what was fetched is to insist on the fetched bytes.
 *
 * Throws `TypeError` rather than `IntegrityError` — reaching this is a host
 * programming error, and it must never be reported (or audited) as though a
 * package had been tampered with.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} value
 * @param {string} label - what the bytes are, for the error message
 * @returns {Uint8Array}
 */
export function toPackageBytes(value, label = 'package bytes') {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError(
    `miniapp integrity: ${label} must be raw bytes (Uint8Array/ArrayBuffer), got ${
      value === null ? 'null' : typeof value
    } — verification never re-serializes a parsed value`
  )
}

/**
 * Normalize a SHA-256 digest to its canonical comparison form: 64 lowercase hex
 * characters, no prefix. Returns `null` for anything that is not a well-formed
 * digest, so callers must decide explicitly what an unusable value means (they
 * all decide "refuse").
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeDigestHex(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const body = /^0x/i.test(trimmed) ? trimmed.slice(2) : trimmed
  return DIGEST_BODY.test(body) ? body.toLowerCase() : null
}

/**
 * Normalize a `bytes32` (the registry's `manifestHash`) to `0x` + 64 lowercase
 * hex. Returns `null` when the value is not a well-formed 32-byte hash.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeBytes32Hex(value) {
  const body = normalizeDigestHex(value)
  return body === null ? null : `0x${body}`
}

/** True when a normalized `bytes32` carries no hash at all (never approved). */
export function isZeroHash(value) {
  return normalizeBytes32Hex(value) === ZERO_MANIFEST_HASH
}

/**
 * SHA-256 of raw bytes, as 64 lowercase hex characters — the manifest's
 * `files[path].sha256` encoding.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  return bytesToHex(sha256(toPackageBytes(bytes, 'file bytes')))
}

/**
 * keccak-256 of raw bytes, as `0x` + 64 lowercase hex — the encoding the
 * registry's `bytes32 manifestHash` reads back as through ethers.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes
 * @returns {string}
 */
export function keccak256Hex(bytes) {
  return keccak256(toPackageBytes(bytes, 'manifest bytes')).toLowerCase()
}

/**
 * Verify the manifest bytes against the registry's approved `manifestHash`.
 *
 * This is the FIRST check on the launch path and it runs against bytes that
 * have not been parsed, let alone trusted: everything downstream (the entry
 * point, the per-file digests, the declared permissions) is only as trustworthy
 * as this comparison. Parsing before hashing would mean deciding what to
 * execute using a document nobody had authenticated yet.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} manifestBytes - exactly the bytes fetched
 * @param {string} expectedManifestHash - `approved.manifestHash` from the registry
 * @returns {string} the verified hash, normalized
 * @throws {IntegrityError} on a malformed expected hash or any mismatch
 */
export function verifyManifestBytes(manifestBytes, expectedManifestHash) {
  const expected = normalizeBytes32Hex(expectedManifestHash)
  if (expected === null || expected === ZERO_MANIFEST_HASH) {
    // Fail closed: with no usable on-chain hash there is nothing to verify
    // against, and "unverifiable" must never be treated as "verified".
    throw new IntegrityError(
      'invalid_expected_manifest_hash',
      `miniapp integrity: registry manifestHash is not a usable bytes32 (${String(expectedManifestHash)})`,
      { expected: null, actual: null }
    )
  }

  const actual = keccak256Hex(manifestBytes)
  if (actual !== expected) {
    throw new IntegrityError(
      'manifest_hash_mismatch',
      `miniapp integrity: manifest keccak256 ${actual} does not match the approved ${expected}`,
      { path: 'manifest.json', expected, actual }
    )
  }
  return actual
}

/**
 * Verify one fetched package file against the digest its (already
 * hash-verified) manifest declares for that path.
 *
 * @param {string} path - package-relative path, used for the message only
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} bytes - exactly the bytes fetched
 * @param {string} expectedSha256 - `manifest.files[path].sha256`
 * @returns {string} the verified digest, normalized
 * @throws {IntegrityError} on a malformed expected digest or any mismatch
 */
export function verifyFileBytes(path, bytes, expectedSha256) {
  const expected = normalizeDigestHex(expectedSha256)
  if (expected === null) {
    throw new IntegrityError(
      'invalid_expected_file_digest',
      `miniapp integrity: manifest digest for "${path}" is not a sha-256 hex digest (${String(expectedSha256)})`,
      { path }
    )
  }

  const actual = sha256Hex(bytes)
  if (actual !== expected) {
    throw new IntegrityError(
      'file_hash_mismatch',
      `miniapp integrity: sha256 of "${path}" is ${actual}, manifest declares ${expected}`,
      { path, expected, actual }
    )
  }
  return actual
}

/**
 * Whether two digests are the same value, ignoring encoding differences only —
 * never ignoring a malformed side. Exposed so callers that need a boolean (a
 * reviewer's pre-approval verification, a cache freshness check) use the same
 * normalization the verifiers do instead of comparing raw strings, where
 * `0xAB…` and `ab…` would look different and a stale cache entry would look
 * fresh.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function digestsMatch(a, b) {
  const left = normalizeDigestHex(a)
  const right = normalizeDigestHex(b)
  return left !== null && right !== null && left === right
}
