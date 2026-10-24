/**
 * Address Book export/import file (Spec 021 US5; amended for issue #1550).
 *
 * The export is PLAIN JSON. No encryption, no signature, no wallet.
 *
 * Two reasons. First, the old design derived a symmetric key from an ethers
 * `signer.signMessage(...)`, and `WalletContext` nulls the ethers signer for a
 * passkey session — so BOTH buttons threw 'Wallet not connected' at a member who
 * was plainly signed in, with their book on screen. Second, a readable file is
 * the point besides: a member is meant to be able to open the export, read it,
 * and hand it to somebody else.
 *
 * THE FILE IS NOT SECRET. It carries nicknames, addresses and notes in the
 * clear. Every surface that produces one MUST say so before the download, and
 * the file says so about itself in its own `note` field so the fact survives
 * leaving the app.
 *
 * This is scoped to the manual export file ONLY. The address book is also a
 * spec-032 synced object (`lib/backup/syncedObjects.js`), and THAT channel stays
 * encrypted — do not "consistently" de-encrypt it.
 *
 * Files written before this change are ChaCha20-Poly1305 envelopes keyed on a
 * wallet signature. They still open, but only where a signer exists. Where one
 * does not, the refusal names THAT as the reason: it must never say "wrong
 * wallet", which is a different fact and on a passkey session was never true.
 */

import { keccak256, stringToBytes, toBytes } from 'viem'
import { decryptJson, utf8ToBytes } from '../../utils/crypto/primitives'
import { NETWORKS } from '../../config/networks'
import {
  ADDRESS_BOOK_BACKUP_MESSAGE_V1,
  EXPORT_FORMAT,
  EXPORT_VERSION,
  LEGACY_ENCRYPTED_FORMAT,
  LEGACY_ENCRYPTED_VERSION,
  SCHEMA_VERSION,
} from './constants'

/** Stated inside the file, so it stays true after the file leaves the app. */
export const PLAINTEXT_FILE_NOTE =
  'Plain text: anyone who opens this file can read these names, addresses and notes.'

/**
 * Human-readable network label for a chain id, or undefined when this build does
 * not know the chain.
 *
 * STRICT lookup on purpose — `config/networks.js#getNetwork()` falls back to the
 * current/primary network for an unknown id, which would stamp a shared file
 * with a confident, wrong network name. An omitted label is honest; a guessed
 * one is not. Informational only: the importer reads `chainId` and ignores this.
 */
function networkLabel(chainId) {
  return NETWORKS[chainId]?.name
}

/** Strip local-only fields (id, timestamps); they are regenerated on import. */
function toExportContacts(contacts) {
  return (contacts || []).map((c) => ({
    nickname: c.nickname,
    addresses: (c.addresses || []).map((a) => {
      const network = networkLabel(a.chainId)
      return {
        address: a.address,
        chainId: a.chainId,
        // Informational, for whoever opens the file. Never read back on import.
        ...(network ? { network } : {}),
        notes: a.notes || '',
      }
    }),
  }))
}

/** Read a book back off an export payload, ignoring every informational field. */
function toImportContacts(contacts) {
  return (contacts || []).map((c) => ({
    nickname: c.nickname,
    addresses: (c.addresses || []).map((a) => ({
      address: a.address,
      chainId: a.chainId,
      notes: a.notes || '',
    })),
  }))
}

/**
 * Serialize a book to the plain-text export file (FR-019, as amended).
 *
 * SYNCHRONOUS on purpose. There is no wallet, no network and no ceremony left on
 * this path, and a synchronous signature is what makes "this can never prompt for
 * a signature" true by type rather than by convention (the spec-084
 * `verifyMessage` device).
 *
 * @param {object} book
 * @returns {string} pretty-printed JSON, ready to download
 */
export function exportAddressBook(book) {
  return JSON.stringify(
    {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      schemaVersion: book?.schemaVersion ?? SCHEMA_VERSION,
      exportedAt: Date.now(),
      note: PLAINTEXT_FILE_NOTE,
      contacts: toExportContacts(book?.contacts),
    },
    null,
    2,
  )
}

// ---------------------------------------------------------------------------
// Legacy (pre-#1550) encrypted envelopes — read-only
// ---------------------------------------------------------------------------

// AAD binds the envelope metadata so a tampered header fails authentication.
function legacyAad() {
  return utf8ToBytes(`${LEGACY_ENCRYPTED_FORMAT}:${LEGACY_ENCRYPTED_VERSION}`)
}

async function openLegacyEnvelope(envelope, signer) {
  if (envelope.version !== LEGACY_ENCRYPTED_VERSION) {
    throw new Error(`Unsupported backup version (${envelope.version})`)
  }
  if (!envelope.nonce || !envelope.ciphertext) {
    throw new Error('Backup file is incomplete or corrupted')
  }
  if (!signer || typeof signer.signMessage !== 'function') {
    // The real reason, named, plus the ways out. NOT "wrong wallet": nothing has
    // been tried yet, and this session may have no wallet key at all (#1550).
    throw new Error(
      'This is an older encrypted backup. Only the browser wallet that created it can unlock ' +
        'it, and this session has no wallet key to sign with. Open the file in a session ' +
        'connected to that wallet, or export a fresh plain-text file from a device that still ' +
        'has the book.',
    )
  }
  const signature = await signer.signMessage(ADDRESS_BOOK_BACKUP_MESSAGE_V1)
  const key = toBytes(keccak256(stringToBytes(signature)))
  try {
    return decryptJson(key, envelope.nonce, envelope.ciphertext, legacyAad())
  } catch {
    // AEAD authentication failed. HERE a different wallet genuinely is one of the
    // two possible causes, because a signature was actually tried.
    throw new Error(
      'Could not decrypt this backup — it may belong to a different wallet or be corrupted',
    )
  }
}

/**
 * Read an export file back into a book-shaped object (FR-020, as amended).
 * Throws on an unreadable/incompatible file; the caller leaves the existing book
 * untouched (FR-021).
 *
 * ASYNC because the legacy branch may still sign. The plain-text branch does no
 * I/O at all — the asymmetry with the synchronous `exportAddressBook` is the
 * point, not an oversight.
 *
 * @param {string|object} fileJson
 * @param {{ signer?: object }} [opts] signer is used ONLY to open a legacy envelope
 * @returns {Promise<{ schemaVersion: number, contacts: Array }>}
 */
export async function importAddressBook(fileJson, { signer } = {}) {
  let doc
  try {
    doc = typeof fileJson === 'string' ? JSON.parse(fileJson) : fileJson
  } catch {
    throw new Error('This file is not a valid address book export')
  }
  if (!doc || typeof doc !== 'object') {
    throw new Error('This file is not a valid address book export')
  }

  let payload = doc
  if (doc.format === LEGACY_ENCRYPTED_FORMAT) {
    payload = await openLegacyEnvelope(doc, signer)
  } else if (doc.format === EXPORT_FORMAT || doc.type === EXPORT_FORMAT) {
    // `type` is accepted because the legacy INNER payload used that key for the
    // same value, so a hand-decrypted payload opens without a second validator.
    if (doc.format === EXPORT_FORMAT && Number(doc.version) > EXPORT_VERSION) {
      throw new Error(
        `This file was written by a newer version of FairWins (format ${doc.version}). ` +
          'Update the app to open it.',
      )
    }
  } else {
    throw new Error('Unrecognised address book file')
  }

  if (!payload || !Array.isArray(payload.contacts)) {
    throw new Error('File contents are not a valid address book')
  }

  return {
    schemaVersion: payload.schemaVersion ?? SCHEMA_VERSION,
    contacts: toImportContacts(payload.contacts),
  }
}
