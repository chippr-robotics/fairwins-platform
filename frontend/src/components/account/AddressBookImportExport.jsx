/**
 * AddressBookImportExport (Spec 021, US5; amended for issue #1550) — plain-text
 * export/import controls and the merge-conflict resolution flow.
 *
 * Export needs NO wallet and NO signature. The signer read below is used for one
 * thing only: unlocking a pre-#1550 encrypted backup, where a signer exists. It
 * never gates a button, because a passkey session has no ethers signer and the
 * old gate refused those members with "Wallet not connected" while their account
 * was plainly signed in.
 *
 * The book and its mutators arrive as PROPS from AddressBookPanel, deliberately.
 * `useAddressBook()` holds the book in its own `useState`, so calling it here as
 * well produced a SECOND, independent copy: a contact added in the panel never
 * reached this component (it exported a book frozen at mount), and an import
 * here never reached the panel's grid. One subtree, one book.
 */

import { useState, useRef, useCallback } from 'react'
import { useWallet } from '../../hooks/useWalletManagement'
import { exportAddressBook, importAddressBook } from '../../lib/addressBook/addressBookFile'

/** Arrow leaving the page into a tray — "take a copy out". */
function IconExport() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="ab-icon">
      <path d="M8 1.25a.75.75 0 0 1 .75.75v5.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 0 1 1.06-1.06l1.72 1.72V2a.75.75 0 0 1 .75-.75Z" />
      <path d="M2.75 9.5a.75.75 0 0 1 .75.75v2.25h9V10.25a.75.75 0 0 1 1.5 0v2.5A1.25 1.25 0 0 1 12.75 14h-9.5A1.25 1.25 0 0 1 2 12.75v-2.5a.75.75 0 0 1 .75-.75Z" />
    </svg>
  )
}

/** Arrow rising out of a tray — "bring a copy in". */
function IconImport() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="ab-icon">
      <path d="M8 1.25a.75.75 0 0 1 .53.22l3 3a.75.75 0 0 1-1.06 1.06L8.75 3.81V9a.75.75 0 0 1-1.5 0V3.81L5.53 5.53a.75.75 0 0 1-1.06-1.06l3-3A.75.75 0 0 1 8 1.25Z" />
      <path d="M2.75 9.5a.75.75 0 0 1 .75.75v2.25h9V10.25a.75.75 0 0 1 1.5 0v2.5A1.25 1.25 0 0 1 12.75 14h-9.5A1.25 1.25 0 0 1 2 12.75v-2.5a.75.75 0 0 1 .75-.75Z" />
    </svg>
  )
}

function downloadFile(filename, text) {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export default function AddressBookImportExport({ book, importBook, resolveConflicts }) {
  // Legacy-envelope unlock ONLY. Absent on a passkey session, and that is fine:
  // nothing on the export path and nothing on the plain-text import path reads it.
  const { signer } = useWallet()
  const contacts = book?.contacts
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null) // { type: 'error'|'success', text }
  const [conflicts, setConflicts] = useState([])
  const [resolutions, setResolutions] = useState({})

  const handleExport = useCallback(() => {
    setMessage(null)
    // An empty book exports an empty file, which reads as "the export is broken".
    // Say what is actually true instead.
    if (!contacts || contacts.length === 0) {
      setMessage({ type: 'error', text: 'There are no contacts to export yet.' })
      return
    }
    setBusy(true)
    try {
      // Synchronous: no wallet, no signature, no network (#1550).
      downloadFile(`fairwins-address-book-${Date.now()}.json`, exportAddressBook(book))
      setMessage({
        type: 'success',
        text: 'Exported as plain text — anyone who opens the file can read it.',
      })
    } catch (err) {
      setMessage({ type: 'error', text: err.message || 'Export failed' })
    } finally {
      setBusy(false)
    }
  }, [book, contacts])

  const handleImportFile = useCallback(
    async (event) => {
      const file = event.target.files?.[0]
      if (file) {
        event.target.value = '' // allow re-importing the same file
        setMessage(null)
        setBusy(true)
        try {
          const text = await file.text()
          // `signer` is passed for legacy encrypted envelopes only; a plain-text
          // file never touches it.
          const incoming = await importAddressBook(text, { signer })
          const { conflicts: found } = importBook(incoming)
          if (found.length > 0) {
            setConflicts(found)
            setResolutions({})
            setMessage({ type: 'success', text: 'Imported. Resolve the conflicts below.' })
          } else {
            setMessage({ type: 'success', text: 'Address book imported.' })
          }
        } catch (err) {
          // Existing book is left unchanged (FR-021).
          setMessage({ type: 'error', text: err.message || 'Import failed' })
        } finally {
          setBusy(false)
        }
      }
    },
    [signer, importBook],
  )

  const applyResolutions = useCallback(() => {
    resolveConflicts(conflicts, resolutions)
    setConflicts([])
    setResolutions({})
    setMessage({ type: 'success', text: 'Conflicts resolved.' })
  }, [conflicts, resolutions, resolveConflicts])

  return (
    <div className="ab-import-export">
      <div className="ab-import-export-actions">
        {/*
          aria-label on both buttons because `.ab-btn-label` is display:none below
          640px — at phone width these are icon-only, and an icon is aria-hidden.
          Same pattern as the "Add contact" button in AddressBookPanel.
        */}
        <button
          type="button"
          className="ab-btn ab-btn-sm"
          onClick={handleExport}
          disabled={busy}
          aria-label="Export address book"
        >
          <IconExport />
          <span className="ab-btn-label">Export</span>
        </button>
        <button
          type="button"
          className="ab-btn ab-btn-sm"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          aria-label="Import address book"
        >
          <IconImport />
          <span className="ab-btn-label">Import</span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        onChange={handleImportFile}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
        data-testid="ab-import-input"
      />

      {/* The privacy fact stated where the button is, not only in the docs. */}
      <p className="ab-plaintext-note">
        Exports are plain text, so they are easy to read and share — and anyone who opens the
        file can see these names, addresses and notes.
      </p>

      {message && (
        <span
          className={message.type === 'error' ? 'ab-error' : 'ab-warn'}
          role={message.type === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </span>
      )}

      {conflicts.length > 0 && (
        <div className="ab-conflict-list" role="group" aria-label="Resolve import conflicts">
          {conflicts.map((c) => (
            <div className="ab-conflict" key={c.addressKey}>
              <strong>{c.addressKey}</strong>
              <div className="ab-conflict-choices">
                <label>
                  <input
                    type="radio"
                    name={`conflict-${c.addressKey}`}
                    checked={(resolutions[c.addressKey] ?? 'keep') === 'keep'}
                    onChange={() =>
                      setResolutions((r) => ({ ...r, [c.addressKey]: 'keep' }))
                    }
                  />
                  Keep “{c.existing.nickname}”
                </label>
                <label>
                  <input
                    type="radio"
                    name={`conflict-${c.addressKey}`}
                    checked={resolutions[c.addressKey] === 'incoming'}
                    onChange={() =>
                      setResolutions((r) => ({ ...r, [c.addressKey]: 'incoming' }))
                    }
                  />
                  Use “{c.incoming.nickname}”
                </label>
              </div>
            </div>
          ))}
          <button type="button" className="ab-btn ab-btn-sm ab-btn-primary" onClick={applyResolutions}>
            Apply
          </button>
        </div>
      )}
    </div>
  )
}
