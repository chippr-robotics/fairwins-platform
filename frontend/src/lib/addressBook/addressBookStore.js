/**
 * Address Book pure data layer (Spec 021).
 *
 * Framework-agnostic schema + CRUD over a plain AddressBook object, plus thin
 * load/save helpers around utils/userStorage.js (per-wallet localStorage). All
 * operations except load/save are pure and return a NEW book (never mutate).
 *
 * Entry identity is (lowercase(address), chainId): the same address on two
 * networks is two distinct entries (FR-003, FR-007).
 */

import { getAddress, isAddress } from 'viem'
import { getUserPreference, saveUserPreference } from '../../utils/userStorage'
import {
  STORAGE_KEY,
  SCHEMA_VERSION,
  MAX_NICKNAME_LENGTH,
  MAX_NOTES_LENGTH,
} from './constants'

let __idSeq = 0
function uid(prefix = 'c') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`
  }
  return `${prefix}_${Date.now().toString(36)}_${(__idSeq++).toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

/**
 * Validate + checksum an address. Throws on invalid input (FR-005).
 * @param {string} input
 * @returns {string} checksummed address
 */
export function normalizeAddress(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('Address is required')
  }
  const trimmed = input.trim()
  if (!isAddress(trimmed)) {
    throw new Error('Enter a valid wallet address')
  }
  return getAddress(trimmed)
}

/**
 * @param {string} input
 * @returns {boolean}
 */
export function isValidAddress(input) {
  return typeof input === 'string' && isAddress(input.trim())
}

/**
 * Stable identity key for a saved address.
 * @param {string} address
 * @param {number} chainId
 * @returns {string}
 */
export function addressKey(address, chainId) {
  return `${String(address).toLowerCase()}:${Number(chainId)}`
}

/** @returns {AddressBook} */
export function createEmptyBook() {
  return { schemaVersion: SCHEMA_VERSION, contacts: [], updatedAt: Date.now() }
}

function cloneBook(book) {
  return {
    schemaVersion: book.schemaVersion ?? SCHEMA_VERSION,
    contacts: book.contacts.map((c) => ({
      ...c,
      addresses: c.addresses.map((a) => ({ ...a })),
    })),
    updatedAt: book.updatedAt ?? Date.now(),
  }
}

function isPlainBook(value) {
  return Boolean(value) && typeof value === 'object' && Array.isArray(value.contacts)
}

function sanitizeNickname(nickname) {
  const trimmed = String(nickname ?? '').trim()
  if (trimmed === '') throw new Error('Nickname is required')
  return trimmed.slice(0, MAX_NICKNAME_LENGTH)
}

function sanitizeNotes(notes) {
  return String(notes ?? '').slice(0, MAX_NOTES_LENGTH)
}

function buildSavedAddress({ address, chainId, notes }) {
  if (chainId === undefined || chainId === null || Number.isNaN(Number(chainId))) {
    throw new Error('Network is required')
  }
  return {
    address: normalizeAddress(address),
    chainId: Number(chainId),
    notes: sanitizeNotes(notes),
    addedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Persistence (the only impure functions)
// ---------------------------------------------------------------------------

/**
 * Load the book for an owner; returns a valid empty book on miss/parse failure.
 * @param {string} ownerAddress
 * @returns {AddressBook}
 */
export function loadAddressBook(ownerAddress) {
  if (!ownerAddress) return createEmptyBook()
  const raw = getUserPreference(ownerAddress, STORAGE_KEY, null, true)
  if (!isPlainBook(raw)) return createEmptyBook()
  // Defensive: drop malformed contacts/addresses rather than throwing to the UI.
  const contacts = raw.contacts
    .filter((c) => c && typeof c.nickname === 'string' && Array.isArray(c.addresses))
    .map((c) => ({
      id: c.id || uid(),
      nickname: c.nickname,
      addresses: c.addresses
        .filter((a) => a && isValidAddress(a.address) && a.chainId != null)
        .map((a) => ({
          address: getAddress(String(a.address)),
          chainId: Number(a.chainId),
          notes: typeof a.notes === 'string' ? a.notes : '',
          addedAt: a.addedAt || Date.now(),
        })),
      createdAt: c.createdAt || Date.now(),
      updatedAt: c.updatedAt || Date.now(),
    }))
  return { schemaVersion: SCHEMA_VERSION, contacts, updatedAt: raw.updatedAt || Date.now() }
}

/**
 * Persist the book for an owner (localStorage via userStorage).
 * @param {string} ownerAddress
 * @param {AddressBook} book
 */
/** Event fired after any write, so views holding derived copies can re-read. */
export const ADDRESS_BOOK_CHANGED = 'fairwins:address-book-changed'

export function saveAddressBook(ownerAddress, book) {
  if (!ownerAddress) throw new Error('Wallet address is required')
  saveUserPreference(ownerAddress, STORAGE_KEY, { ...book, updatedAt: Date.now() }, true)
  // Spec 068 — the book is no longer read only by the address-book screen: a vault's NAME lives
  // here, so the vault list and account switcher derive from it too. Announcing writes at the one
  // place they happen means renaming a vault updates it everywhere, rather than everywhere except
  // wherever the member happens to be looking. Cheap, and it cannot be forgotten by a new caller
  // the way a per-component refresh call would be.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent(ADDRESS_BOOK_CHANGED, { detail: { ownerAddress } }))
  }
}

// ---------------------------------------------------------------------------
// Pure operations
// ---------------------------------------------------------------------------

/**
 * Add a contact. Throws on invalid nickname/address (FR-005).
 * @returns {{ book: AddressBook, contact: Contact }}
 */
export function addContact(book, { nickname, addresses = [] }) {
  const next = cloneBook(book)
  const now = Date.now()
  const contact = {
    id: uid(),
    nickname: sanitizeNickname(nickname),
    addresses: addresses.map(buildSavedAddress),
    createdAt: now,
    updatedAt: now,
  }
  next.contacts.push(contact)
  next.updatedAt = now
  return { book: next, contact }
}

export function updateContact(book, contactId, { nickname }) {
  const next = cloneBook(book)
  const contact = next.contacts.find((c) => c.id === contactId)
  if (!contact) return next
  if (nickname !== undefined) contact.nickname = sanitizeNickname(nickname)
  contact.updatedAt = Date.now()
  next.updatedAt = contact.updatedAt
  return next
}

export function deleteContact(book, contactId) {
  const next = cloneBook(book)
  next.contacts = next.contacts.filter((c) => c.id !== contactId)
  next.updatedAt = Date.now()
  return next
}

export function addAddress(book, contactId, { address, chainId, notes }) {
  const next = cloneBook(book)
  const contact = next.contacts.find((c) => c.id === contactId)
  if (!contact) return next
  contact.addresses.push(buildSavedAddress({ address, chainId, notes }))
  contact.updatedAt = Date.now()
  next.updatedAt = contact.updatedAt
  return next
}

export function updateAddress(book, contactId, key, { notes, chainId }) {
  const next = cloneBook(book)
  const contact = next.contacts.find((c) => c.id === contactId)
  if (!contact) return next
  const addr = contact.addresses.find((a) => addressKey(a.address, a.chainId) === key)
  if (!addr) return next
  if (notes !== undefined) addr.notes = sanitizeNotes(notes)
  if (chainId !== undefined) {
    if (Number.isNaN(Number(chainId))) throw new Error('Network is required')
    addr.chainId = Number(chainId)
  }
  contact.updatedAt = Date.now()
  next.updatedAt = contact.updatedAt
  return next
}

export function removeAddress(book, contactId, key) {
  const next = cloneBook(book)
  const contact = next.contacts.find((c) => c.id === contactId)
  if (!contact) return next
  contact.addresses = contact.addresses.filter(
    (a) => addressKey(a.address, a.chainId) !== key,
  )
  contact.updatedAt = Date.now()
  next.updatedAt = contact.updatedAt
  return next
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Find where an (address, chainId) is already saved (duplicate detection,
 * regardless of capitalisation) (FR-007).
 * @returns {{ contact: Contact, savedAddress: SavedAddress } | null}
 */
export function findByAddress(book, address, chainId) {
  if (!isValidAddress(address)) return null
  const key = addressKey(address, chainId)
  for (const contact of book.contacts) {
    const savedAddress = contact.addresses.find(
      (a) => addressKey(a.address, a.chainId) === key,
    )
    if (savedAddress) return { contact, savedAddress }
  }
  return null
}

/**
 * Flat, searchable index for the picker.
 * @returns {Array<{ contactId, nickname, address, chainId, notes }>}
 */
export function listEntries(book) {
  const out = []
  for (const contact of book.contacts) {
    for (const a of contact.addresses) {
      out.push({
        contactId: contact.id,
        nickname: contact.nickname,
        address: a.address,
        chainId: a.chainId,
        notes: a.notes,
      })
    }
  }
  return out
}

/**
 * Case-insensitive substring match over nickname + address.
 */
export function searchEntries(book, query) {
  const entries = listEntries(book)
  const q = String(query ?? '').trim().toLowerCase()
  if (q === '') return entries
  return entries.filter(
    (e) => e.nickname.toLowerCase().includes(q) || e.address.toLowerCase().includes(q),
  )
}

// ---------------------------------------------------------------------------
// Merge (import) — additive, keyed on (address, chainId) (FR-022, clarified Q2)
// ---------------------------------------------------------------------------

/**
 * Additive merge. Adds addresses not already present; keeps existing ones (no
 * duplicates); never deletes existing data. Differing nickname/notes for an
 * already-present address are returned as conflicts for the caller to resolve.
 *
 * @returns {{ book: AddressBook, conflicts: Array<{ addressKey, contactId, existing, incoming }> }}
 */
export function mergeBook(current, incoming) {
  let next = cloneBook(current)
  const conflicts = []

  // Index existing entries by address key.
  const existingIndex = new Map()
  for (const contact of next.contacts) {
    for (const a of contact.addresses) {
      existingIndex.set(addressKey(a.address, a.chainId), { contact, savedAddress: a })
    }
  }

  for (const inContact of incoming.contacts || []) {
    for (const inAddr of inContact.addresses || []) {
      if (!isValidAddress(inAddr.address) || inAddr.chainId == null) continue
      const key = addressKey(inAddr.address, inAddr.chainId)
      const found = existingIndex.get(key)
      if (!found) {
        // Attach to a contact with the same nickname if one exists, else create.
        let target = next.contacts.find((c) => c.nickname === inContact.nickname)
        if (!target) {
          const res = addContact(next, { nickname: inContact.nickname, addresses: [] })
          next = res.book
          target = next.contacts.find((c) => c.id === res.contact.id)
        }
        target.addresses.push(
          buildSavedAddress({
            address: inAddr.address,
            chainId: inAddr.chainId,
            notes: inAddr.notes,
          }),
        )
        existingIndex.set(key, { contact: target, savedAddress: target.addresses.at(-1) })
      } else {
        const existingNickname = found.contact.nickname
        const existingNotes = found.savedAddress.notes || ''
        const incomingNotes = inAddr.notes || ''
        if (existingNickname !== inContact.nickname || existingNotes !== incomingNotes) {
          conflicts.push({
            addressKey: key,
            contactId: found.contact.id,
            existing: { nickname: existingNickname, notes: existingNotes },
            incoming: { nickname: inContact.nickname, notes: incomingNotes },
          })
        }
      }
    }
  }

  next.updatedAt = Date.now()
  return { book: next, conflicts }
}

/**
 * Apply per-conflict resolutions produced by mergeBook.
 * @param {AddressBook} book
 * @param {Array<{ addressKey, contactId, existing, incoming }>} conflicts
 * @param {Record<string, 'keep' | 'incoming'>} resolutions keyed by addressKey
 */
export function applyConflictResolutions(book, conflicts, resolutions) {
  let next = cloneBook(book)
  for (const conflict of conflicts) {
    if (resolutions[conflict.addressKey] !== 'incoming') continue
    const contact = next.contacts.find((c) => c.id === conflict.contactId)
    if (!contact) continue
    const addr = contact.addresses.find(
      (a) => addressKey(a.address, a.chainId) === conflict.addressKey,
    )
    if (addr) addr.notes = sanitizeNotes(conflict.incoming.notes)
    contact.nickname = sanitizeNickname(conflict.incoming.nickname)
  }
  next.updatedAt = Date.now()
  return next
}

/**
 * @typedef {Object} SavedAddress
 * @property {string} address
 * @property {number} chainId
 * @property {string} notes
 * @property {number} addedAt
 *
 * @typedef {Object} Contact
 * @property {string} id
 * @property {string} nickname
 * @property {SavedAddress[]} addresses
 * @property {number} createdAt
 * @property {number} updatedAt
 *
 * @typedef {Object} AddressBook
 * @property {number} schemaVersion
 * @property {Contact[]} contacts
 * @property {number} updatedAt
 */
