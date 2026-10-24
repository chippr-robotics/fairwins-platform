/**
 * Legal document versioning (Spec 007 — FR-018/FR-020/FR-026/FR-059).
 *
 * The version identifier of a legal document IS the SHA-256 hash of its canonicalized
 * content. The canonicalization below is FROZEN and documented so the hash is
 * independently reproducible by a third party (auditor/court) decades later:
 *
 *   1. Unicode NFC normalization
 *   2. Newlines normalized to LF (CRLF and lone CR -> LF)
 *   3. Trim leading/trailing whitespace
 *   4. UTF-8 encode
 *   5. SHA-256, lowercase hex
 *
 * This same canonicalization is reused to compute the `termsVersion.hash` bound into a
 * wager's encrypted metadata (see utils/crypto/envelopeEncryption.js, FR-056).
 *
 * NOTE: changing any step changes every hash — never modify it; introduce a new,
 * explicitly-versioned canonicalization if ever required.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/ciphers/utils.js'

// Versioned document sources (Vite ?raw). Each VERSION is pinned to IPFS per-version (not
// per-event) and recorded on-chain by hash at consent (Spec 007, FR-017–FR-030).
import termsRaw from '../legal/terms.md?raw'
import riskRaw from '../legal/risk-disclosure.md?raw'
import privacyRaw from '../legal/privacy-policy.md?raw'

/** The frozen canonicalization algorithm identifier (for documentation/audit). */
export const CANONICALIZATION_VERSION = 'nfc-lf-utf8-trim-v1'

/**
 * Canonicalize legal-document text to the frozen byte form that gets hashed.
 * @param {string} text - the raw published document text
 * @returns {string} canonical text (still a JS string; encode to bytes to hash)
 */
export function canonicalizeDocText(text) {
  if (typeof text !== 'string') {
    throw new TypeError('canonicalizeDocText expects a string')
  }
  return text
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
}

/**
 * Compute the SHA-256 version hash (lowercase hex) of a legal document's content.
 * @param {string} text - the raw published document text
 * @returns {string} 64-char lowercase hex digest
 */
export function hashDocVersion(text) {
  const canonical = canonicalizeDocText(text)
  return bytesToHex(sha256(utf8ToBytes(canonical)))
}

/**
 * Verify that a piece of served document content matches a claimed version hash.
 * @param {string} text - served document text
 * @param {string} expectedHashHex - the claimed version hash (case-insensitive)
 * @returns {boolean}
 */
export function verifyDocVersion(text, expectedHashHex) {
  if (typeof expectedHashHex !== 'string') return false
  return hashDocVersion(text) === expectedHashHex.toLowerCase()
}

/**
 * ==========================================================================
 * Version manifest (Spec 007 — FR-017/FR-025/FR-028/FR-030)
 * ==========================================================================
 * The registry holds, per document type, the CURRENT content plus any historical
 * versions (retrievable by hash). For v1 only the current version exists; historical
 * versions are appended here when the content changes so prior versions stay retrievable.
 *
 * `material` is the operator-set re-consent flag (FR-030) — DISTINCT from the content
 * hash: re-consent is driven by this flag, not by hash inequality, so an immaterial edit
 * does not force re-consent.
 */
export const DOC_TYPES = /** @type {const} */ (['terms', 'risk', 'privacy'])

const REGISTRY = {
  terms: { label: 'Terms & Conditions', route: '/terms', current: termsRaw, material: true, historical: [] },
  risk: { label: 'Risk Disclosure', route: '/risk', current: riskRaw, material: true, historical: [] },
  privacy: { label: 'Privacy Policy', route: '/privacy', current: privacyRaw, material: true, historical: [] },
  // historical: array of { content, material } previously published; retained for retrieval.
}

function makeVersion(docType, content, material) {
  const hash = hashDocVersion(content)
  return { docType, id: `${docType}@${hash.slice(0, 16)}`, hash, content, material }
}

/**
 * The currently-published version of a document.
 * @param {'terms'|'risk'|'privacy'} docType
 * @returns {{docType, label, route, id, hash, content, material}|null}
 */
export function getCurrentDocument(docType) {
  const d = REGISTRY[docType]
  if (!d) return null
  return { label: d.label, route: d.route, ...makeVersion(docType, d.current, d.material) }
}

/**
 * Retrieve a specific version (current or historical) of a document by its hash.
 * @returns {{docType, id, hash, content, material}|null}
 */
export function getDocumentByHash(docType, hash) {
  const d = REGISTRY[docType]
  if (!d || typeof hash !== 'string') return null
  const want = hash.toLowerCase()
  for (const content of [d.current, ...d.historical.map((h) => h.content)]) {
    if (hashDocVersion(content) === want) {
      const material = content === d.current ? d.material : d.historical.find((h) => h.content === content)?.material
      return makeVersion(docType, content, Boolean(material))
    }
  }
  return null
}

/**
 * All retained versions of a document (current first), newest-known ordering.
 * @returns {Array<{docType,id,hash,material}>}
 */
export function listVersions(docType) {
  const d = REGISTRY[docType]
  if (!d) return []
  const cur = makeVersion(docType, d.current, d.material)
  const hist = d.historical.map((h) => makeVersion(docType, h.content, h.material))
  return [cur, ...hist].map(({ content: _content, ...meta }) => meta) // omit content from the list
}

/**
 * Whether a returning user must re-consent: only when the in-force version is flagged
 * MATERIAL and the user's previously-acknowledged hash differs from the current hash
 * (FR-030). An immaterial change never forces re-consent.
 * @param {'terms'|'risk'|'privacy'} docType
 * @param {string} acknowledgedHash - the hash the user previously acknowledged (or '')
 * @returns {boolean}
 */
export function requiresReconsent(docType, acknowledgedHash) {
  const cur = getCurrentDocument(docType)
  if (!cur) return false
  if ((acknowledgedHash || '').toLowerCase() === cur.hash) return false
  return Boolean(cur.material)
}
