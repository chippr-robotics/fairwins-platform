/**
 * AddressBookPanel (Spec 021) — the My Account → Address Book tab body.
 *
 * Per-wallet CRUD over saved contacts (FR-001..FR-009), with advisory sanctions
 * tags screened on open (FR-010..FR-012), in-panel search (FR-015), and (added
 * in US5, plain text since issue #1550) file export/import.
 */

import { useState, useMemo, useCallback } from 'react'
import { useWallet } from '../../hooks/useWalletManagement'
import { useAddressBook } from '../../hooks/useAddressBook'
import { useEstateScreeningMany } from '../../hooks/useEstateScreening'
import { VERDICTS } from '../../lib/screening/verdict'
import { getNetwork, getSelectableNetworks, getCurrentChainId } from '../../config/networks'
import { addressKey, listEntries } from '../../lib/addressBook/addressBookStore'
import { isVaultAddress } from '../../lib/custody/vaultAddressBook'
import { loadVaultReferences } from '../../lib/custody/vaultReferences'
function IconPlus() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="ab-icon">
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </svg>
  )
}

function IconSearch() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="ab-search-icon">
      <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
    </svg>
  )
}

import ContactCard from './ContactCard'
import ContactEditModal from './ContactEditModal'
import AddressBookImportExport from './AddressBookImportExport'
import ScreeningInfoButton from '../ui/ScreeningInfoButton'
import './AddressBookPanel.css'

function networkName(chainId) {
  return getNetwork(chainId)?.name || `Chain ${chainId}`
}

export default function AddressBookPanel({ address }) {
  const wallet = useWallet()
  // Spec 068 — the member's own vaults, used only to badge matching entries. Nothing is stored on
  // the entry itself: the book's loader rebuilds a fixed field list, so a type key would be lost.
  const vaultRefs = useMemo(() => (address ? loadVaultReferences(address) : []), [address])
  const activeChainId = wallet?.chainId ?? getCurrentChainId()
  const {
    book,
    contacts,
    addContact,
    updateContact,
    deleteContact,
    addAddress,
    removeAddress,
    findByAddress,
    importBook,
    resolveConflicts,
  } = useAddressBook()
  // Every address in the book, screened against every list on every cohort chain — no wallet
  // required (issue #1458 QA round: the per-chain hook rendered a book full of "Unscreened"
  // whenever the wallet was elsewhere, or absent).
  const bookAddresses = useMemo(() => listEntries(book).map((e) => e.address), [book])
  const { getVerdict, getVerdictOn } = useEstateScreeningMany(bookAddresses)

  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null) // { contact } | { contact: null } | null

  const networks = useMemo(() => getSelectableNetworks(), [])

  // Meta row (design 3a): total saved addresses, and how many contacts carry a
  // non-clear screening state.
  const savedCount = useMemo(
    () => contacts.reduce((n, c) => n + c.addresses.length, 0),
    [contacts],
  )
  const needsReview = useMemo(
    () =>
      contacts.filter((c) =>
        c.addresses.some((a) => {
          const v = getVerdict(a.address)
          return v === VERDICTS.FLAGGED || v === VERDICTS.PARTIAL || v === VERDICTS.UNSCREENED
        }),
      ).length,
    [contacts, getVerdict],
  )

  // Filter contacts by the search query (nickname or any address) (FR-015).
  const filteredContacts = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return contacts
    return contacts.filter(
      (c) =>
        c.nickname.toLowerCase().includes(q) ||
        c.addresses.some((a) => a.address.toLowerCase().includes(q)),
    )
  }, [contacts, query])

  const handleSave = useCallback(
    (draft) => {
      if (editing?.contact) {
        // Edit: update nickname, then reconcile addresses (add new, drop removed).
        const contact = editing.contact
        updateContact(contact.id, { nickname: draft.nickname })
        const existingKeys = new Set(
          contact.addresses.map((a) => addressKey(a.address, a.chainId)),
        )
        const draftKeys = new Set(draft.addresses.map((a) => addressKey(a.address, a.chainId)))
        draft.addresses.forEach((a) => {
          if (!existingKeys.has(addressKey(a.address, a.chainId))) {
            addAddress(contact.id, a)
          }
        })
        contact.addresses.forEach((a) => {
          const key = addressKey(a.address, a.chainId)
          if (!draftKeys.has(key)) removeAddress(contact.id, key)
        })
      } else {
        addContact(draft)
      }
      setEditing(null)
    },
    [editing, addContact, updateContact, addAddress, removeAddress],
  )

  if (!address) {
    return (
      <div className="ab-panel">
        <div className="ab-empty" role="note">
          <h3>Address Book</h3>
          <p>Connect your wallet to manage your saved contacts.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="ab-panel">
      <div className="ab-panel-head">
        <div className="ab-panel-head-titles">
          <h3>Address Book</h3>
          <ScreeningInfoButton />
        </div>
        <div className="ab-panel-head-actions">
          {/*
            The book is passed DOWN rather than re-read via useAddressBook():
            that hook keeps the book in its own useState, so a second call here
            is a second copy — the export would freeze at mount and an import
            would never reach this grid.
          */}
          <AddressBookImportExport
            book={book}
            importBook={importBook}
            resolveConflicts={resolveConflicts}
          />
        </div>
      </div>

      <div className="ab-search">
        <label htmlFor="ab-search" className="ab-sr-only">
          Search
        </label>
        <div className="ab-search-row">
          <div className="ab-search-box">
            <IconSearch />
            <input
              id="ab-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or address"
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            className="ab-btn ab-btn-primary ab-add-btn"
            onClick={() => setEditing({ contact: null })}
            aria-label="Add contact"
          >
            <IconPlus />
            <span className="ab-btn-label">Add contact</span>
          </button>
        </div>
        {contacts.length > 0 && (
          <div className="ab-meta-row">
            <span className="ab-meta-count">
              {savedCount === 1 ? '1 saved address' : `${savedCount} saved addresses`}
            </span>
            {needsReview > 0 && (
              <span className="ab-meta-review">
                {needsReview === 1 ? '1 needs review' : `${needsReview} need review`}
              </span>
            )}
          </div>
        )}
      </div>

      {contacts.length === 0 ? (
        <div className="ab-empty" role="note">
          <p>No saved contacts yet. Add a contact to find friends faster when you wager.</p>
        </div>
      ) : filteredContacts.length === 0 ? (
        <div className="ab-empty" role="note">
          <p>No contacts match “{query}”.</p>
        </div>
      ) : (
        <div className="ab-contact-grid">
          {filteredContacts.map((contact) => (
            <ContactCard
              key={contact.id}
              contact={contact}
              getVerdict={getVerdict}
              getVerdictOn={getVerdictOn}
              networkName={networkName}
              // Spec 068 — badge entries that are the member's own multisig vaults.
              isVault={contact.addresses.some((a) => isVaultAddress(vaultRefs, a.address, a.chainId))}
              onEdit={(c) => setEditing({ contact: c })}
              onDeleteContact={deleteContact}
            />
          ))}
        </div>
      )}

      {editing && (
        <ContactEditModal
          contact={editing.contact}
          defaultChainId={activeChainId}
          networks={networks}
          findDuplicate={findByAddress}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
