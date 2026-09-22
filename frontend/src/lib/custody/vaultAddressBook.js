// Spec 068 — vaults live in the address book, so renaming and managing one happens in the same
// place as every other address a member keeps.
//
// The link is BY ADDRESS, not by a new field. `loadAddressBook` rebuilds each contact from a fixed
// field list, so any extra key (a `kind: 'vault'` marker, say) would be silently dropped on the next
// load — and the book is a spec-032 synced object, so a schema change also has to survive the merge
// on every device. Matching (address, chainId) against the member's own vault references needs
// neither, and there is exactly one name for a vault either way.
//
// Division of responsibility:
//   vaultReferences  — WHICH vaults are mine, on which chain, and my role. Custody's own record.
//   address book     — what the vault is CALLED. One rename path, shared with every other address.

import { getAddress } from 'viem'
import {
  addContact,
  findByAddress,
  loadAddressBook,
  saveAddressBook,
  updateContact,
} from '../addressBook/addressBookStore'

const shorten = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

/** Default name for a vault that has no address-book entry yet. */
export function defaultVaultNickname(vault) {
  return vault?.label?.trim() || `Vault ${shorten(vault?.address)}`
}

/**
 * Ensure the member's address book has an entry for this vault, and return the contact.
 *
 * Idempotent, and deliberately non-destructive: if an entry already exists for this
 * (address, chainId) — whatever the member has renamed it to — it is returned untouched. Adding a
 * vault must never rewrite a name the member chose.
 */
export function ensureVaultContact(ownerAddress, vault) {
  if (!ownerAddress || !vault?.address || vault.chainId == null) return null
  const book = loadAddressBook(ownerAddress)
  const existing = findByAddress(book, vault.address, vault.chainId)
  if (existing) return existing.contact ?? existing

  const { book: next, contact } = addContact(book, {
    nickname: defaultVaultNickname(vault),
    addresses: [{ address: getAddress(vault.address), chainId: Number(vault.chainId), notes: '' }],
  })
  saveAddressBook(ownerAddress, next)
  return contact
}

/**
 * The name to show for a vault: the address book wins, because that is where the member renames it.
 * Falls back to the custody reference's own label, then to a shortened address — so a vault always
 * has a name even before the book knows about it.
 */
export function vaultDisplayName(book, vault) {
  if (!vault?.address) return ''
  const hit = book ? findByAddress(book, vault.address, vault.chainId) : null
  const nickname = hit?.contact?.nickname ?? hit?.nickname
  return nickname || vault.label || shorten(vault.address)
}

/** Rename a vault by renaming its address-book entry — the single rename path. */
export function renameVault(ownerAddress, vault, nickname) {
  if (!ownerAddress || !vault?.address) return null
  const contact = ensureVaultContact(ownerAddress, vault)
  if (!contact) return null
  const book = loadAddressBook(ownerAddress)
  const next = updateContact(book, contact.id, { nickname })
  saveAddressBook(ownerAddress, next)
  return next
}

/**
 * Is this address-book entry one of the member's vaults? Used to badge it in the address book
 * without storing anything extra on the entry.
 * @param {Array<{address:string, chainId:number}>} vaultRefs
 */
export function isVaultAddress(vaultRefs, address, chainId) {
  if (!address || !Array.isArray(vaultRefs)) return false
  let target
  try {
    target = getAddress(address)
  } catch {
    return false
  }
  return vaultRefs.some((r) => {
    try {
      return getAddress(r.address) === target && (chainId == null || Number(r.chainId) === Number(chainId))
    } catch {
      return false
    }
  })
}
