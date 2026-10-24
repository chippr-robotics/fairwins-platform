/**
 * ContactEditModal (Spec 021) — create or edit a contact and its addresses.
 *
 * Supports multiple addresses per contact (FR-002); each address has a required
 * network (defaulted to the active chain, FR-003) and optional notes. Validates
 * addresses before save (FR-005) and warns on duplicates (edge case).
 */

import { useState, useMemo, useCallback } from 'react'
import { isValidAddress } from '../../lib/addressBook/addressBookStore'
import AddressScreenNotice from '../ui/AddressScreenNotice'
import { extractAddressFromScan } from '../../lib/addressBook/scanAddress'
import QRScanner from '../ui/QRScanner'

function emptyRow(defaultChainId) {
  return { address: '', chainId: defaultChainId, notes: '' }
}

export default function ContactEditModal({
  contact = null,
  defaultChainId,
  networks = [],
  findDuplicate,
  onSave,
  onCancel,
}) {
  const isEdit = Boolean(contact)
  const [nickname, setNickname] = useState(contact?.nickname ?? '')
  const [rows, setRows] = useState(
    contact?.addresses?.length
      ? contact.addresses.map((a) => ({ address: a.address, chainId: a.chainId, notes: a.notes || '' }))
      : [emptyRow(defaultChainId)],
  )
  const [error, setError] = useState('')
  const [scanRow, setScanRow] = useState(null)

  // Fill the scanned row with the address extracted from the QR payload.
  const handleScanSuccess = useCallback((decodedText) => {
    const addr = extractAddressFromScan(decodedText)
    setScanRow((idx) => {
      if (addr && idx != null) {
        setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, address: addr } : r)))
      }
      return null
    })
  }, [])

  const setRow = (i, patch) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const addRow = () => setRows((prev) => [...prev, emptyRow(defaultChainId)])
  const removeRow = (i) => setRows((prev) => prev.filter((_, idx) => idx !== i))

  // Duplicate warnings (advisory, do not block).
  const duplicateWarnings = useMemo(() => {
    if (!findDuplicate) return {}
    const out = {}
    rows.forEach((r, i) => {
      if (isValidAddress(r.address)) {
        const found = findDuplicate(r.address, Number(r.chainId))
        // Ignore a match against the contact being edited.
        if (found && (!contact || found.contact.id !== contact.id)) {
          out[i] = `Already saved under "${found.contact.nickname}"`
        }
      }
    })
    return out
  }, [rows, findDuplicate, contact])

  const handleSave = () => {
    if (nickname.trim() === '') {
      setError('Nickname is required')
      return
    }
    const cleaned = rows.filter((r) => r.address.trim() !== '')
    if (cleaned.length === 0) {
      setError('Add at least one address')
      return
    }
    for (const r of cleaned) {
      if (!isValidAddress(r.address)) {
        setError(`Enter a valid wallet address (${r.address || 'empty'})`)
        return
      }
      if (r.chainId === '' || r.chainId == null) {
        setError('Select a network for each address')
        return
      }
    }
    setError('')
    onSave?.({
      nickname: nickname.trim(),
      addresses: cleaned.map((r) => ({
        address: r.address.trim(),
        chainId: Number(r.chainId),
        notes: r.notes,
      })),
    })
  }

  return (
    <div className="ab-modal-backdrop" role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit contact' : 'Add contact'}>
      <div className="ab-modal">
        <h3 className="ab-modal-title">{isEdit ? 'Edit contact' : 'Add contact'}</h3>

        <div className="ab-field">
          <label htmlFor="ab-nickname">Nickname *</label>
          <input
            id="ab-nickname"
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={60}
            autoComplete="off"
          />
        </div>

        <fieldset className="ab-addresses-fieldset">
          <legend>Addresses</legend>
          {rows.map((row, i) => (
            <div className="ab-address-edit-row" key={i}>
              <div className="ab-field">
                <label htmlFor={`ab-addr-${i}`}>Address *</label>
                <div className="ab-input-with-scan">
                  <input
                    id={`ab-addr-${i}`}
                    type="text"
                    value={row.address}
                    onChange={(e) => setRow(i, { address: e.target.value })}
                    placeholder="0x…"
                    autoComplete="off"
                    spellCheck="false"
                  />
                  <button
                    type="button"
                    className="ab-scan-btn"
                    onClick={() => setScanRow(i)}
                    title="Scan QR code"
                    aria-label={`Scan a QR code for address ${i + 1}`}
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm0 4h2v2h-2v-2z" />
                    </svg>
                  </button>
                </div>
                {duplicateWarnings[i] && (
                  <span className="ab-warn" role="status">
                    {duplicateWarnings[i]}
                  </span>
                )}
                <AddressScreenNotice address={row.address} chainId={Number(row.chainId)} />
              </div>
              <div className="ab-field">
                <label htmlFor={`ab-net-${i}`}>Network *</label>
                <select
                  id={`ab-net-${i}`}
                  value={row.chainId}
                  onChange={(e) => setRow(i, { chainId: e.target.value })}
                >
                  {networks.map((n) => (
                    <option key={n.chainId} value={n.chainId}>
                      {n.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="ab-field">
                <label htmlFor={`ab-notes-${i}`}>Notes</label>
                <input
                  id={`ab-notes-${i}`}
                  type="text"
                  value={row.notes}
                  onChange={(e) => setRow(i, { notes: e.target.value })}
                  maxLength={500}
                  autoComplete="off"
                />
              </div>
              {rows.length > 1 && (
                <button
                  type="button"
                  className="ab-btn ab-btn-xs ab-btn-danger"
                  onClick={() => removeRow(i)}
                  aria-label={`Remove address row ${i + 1}`}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          <button type="button" className="ab-btn ab-btn-sm" onClick={addRow}>
            + Add another address
          </button>
        </fieldset>

        {error && (
          <p className="ab-error" role="alert">
            {error}
          </p>
        )}

        <div className="ab-modal-actions">
          <button type="button" className="ab-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="ab-btn ab-btn-primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>

      <QRScanner
        isOpen={scanRow !== null}
        onClose={() => setScanRow(null)}
        onScanSuccess={handleScanSuccess}
      />
    </div>
  )
}
