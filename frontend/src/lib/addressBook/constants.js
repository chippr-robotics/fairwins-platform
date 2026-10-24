/**
 * Address Book constants (Spec 021).
 *
 * Client-side, per-wallet contact storage. These constants are shared by the
 * pure store, the encrypted export/import module, and the UI.
 */

// Per-wallet localStorage key suffix used with utils/userStorage.js
// (resolves to `fw_user_<address>_addressBook`).
export const STORAGE_KEY = 'addressBook'

// On-disk schema version for forward migration.
export const SCHEMA_VERSION = 1

// Plain-text export file identifiers (issue #1550). The file IS the payload now
// — what used to be the inner `type` of the encrypted ciphertext is the file's
// own `format`, which is why one validator accepts a new file and a decrypted
// legacy payload alike.
export const EXPORT_FORMAT = 'fairwins-address-book'
export const EXPORT_VERSION = 2

// Pre-#1550 encrypted envelopes. Nothing WRITES this format any more; it is kept
// so files a member already has on disk still open where a wallet signer exists.
export const LEGACY_ENCRYPTED_FORMAT = 'fairwins-address-book-backup'
export const LEGACY_ENCRYPTED_VERSION = 1

// Domain-separated signing message for the LEGACY backup key — READ-ONLY from
// here on. Intentionally DISTINCT from the wager-encryption signing messages in
// utils/crypto/constants.js so the backup key can never coincide with a member's
// wager-encryption private key; do not reuse it for anything else.
export const ADDRESS_BOOK_BACKUP_MESSAGE_V1 = 'FairWins Address Book Backup v1'

// How long a screening result stays fresh in-session before a re-screen (ms).
export const SCREENING_TTL_MS = 60_000

// Field limits.
export const MAX_NICKNAME_LENGTH = 60
export const MAX_NOTES_LENGTH = 500
