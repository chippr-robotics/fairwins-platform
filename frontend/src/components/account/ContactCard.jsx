/**
 * ContactCard (Spec 021, roster redesign per issue #1023 design 3a) — one
 * address-book contact as a compact expandable row: avatar, nickname, a
 * contact-level screening flag, the primary address with copy, and a network
 * count. "Details" expands to per-network full addresses (each with its own
 * copy action and notes) plus the Edit / Delete actions. A contact containing
 * a restricted address is flagged at the contact level (FR-012).
 */

import { useState } from 'react'
import { addressKey } from '../../lib/addressBook/addressBookStore'
import { NO_SOURCE } from '../../hooks/useEstateScreening'
import { worstVerdict } from '../../lib/screening/verdict'
import RestrictionTag from './RestrictionTag'

function shorten(addr) {
  if (!addr || addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

const noVerdict = () => null

function initialsOf(name) {
  const words = (name || '').trim().split(/\s+/).filter(Boolean)
  const letters = words.slice(0, 2).map((w) => w.charAt(0).toUpperCase())
  return letters.join('') || '?'
}

function IconEdit() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="ab-icon">
      <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Z" />
    </svg>
  )
}

function IconTrash() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="ab-icon">
      <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15ZM6.5 1.75V3h3V1.75a.25.25 0 0 0-.25-.25h-2.5a.25.25 0 0 0-.25.25Z" />
    </svg>
  )
}

function IconCopy() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="ab-icon">
      <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z" />
      <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z" />
    </svg>
  )
}

function IconCheck() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className="ab-icon">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  )
}

export default function ContactCard({
  contact,
  // Estate verdicts (issue #1458): `getVerdict` for the whole address, `getVerdictOn` for one
  // network's lists. Both answer null while the sweep runs, which renders as the loading tag —
  // never as a clean bill.
  getVerdict = noVerdict,
  getVerdictOn = noVerdict,
  networkName = (id) => `Chain ${id}`,
  onEdit,
  onDeleteContact,
  isVault = false,
}) {
  const [copiedKey, setCopiedKey] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const rowVerdicts = contact.addresses.map((a) => getVerdictOn(a.address, a.chainId))
  const flag = worstVerdict(contact.addresses.map((a) => getVerdict(a.address))) || 'loading'
  const primary = contact.addresses[0]
  const netCount = contact.addresses.length
  const detailsId = `ab-details-${contact.id}`

  function handleCopy(addr, key) {
    navigator.clipboard.writeText(addr).then(() => {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1500)
    })
  }

  function copyButton(addr, key) {
    const copied = copiedKey === key
    return (
      <button
        type="button"
        className={`ab-btn ab-btn-xs ab-copy-btn${copied ? ' ab-copy-btn--copied' : ''}`}
        onClick={() => handleCopy(addr, key)}
        aria-label={`Copy address ${addr}`}
      >
        {copied ? <IconCheck /> : <IconCopy />}
        <span className="ab-sr-only">{copied ? 'Copied!' : 'Copy'}</span>
      </button>
    )
  }

  return (
    <div className="ab-contact-card">
      <div className="ab-contact-main">
        <span className="ab-contact-avatar" aria-hidden="true">
          {initialsOf(contact.nickname)}
        </span>
        <div className="ab-contact-name">
          <span className="ab-contact-nickname">{contact.nickname}</span>
          {/* Spec 068 — a multisig vault is an ordinary address-book entry, badged by matching the
              member's own vault references rather than by storing a type on the entry (the book is
              a synced object whose loader rebuilds a fixed field list, so an extra key would be
              dropped). Renaming it here renames it everywhere the vault appears. */}
          {isVault && <span className="ab-contact-tag">Multisig</span>}
        </div>
        {/* Contact-level screening flag: the worst verdict across the contact's addresses
            (FR-012), over every list on every cohort chain — not just the wallet's. */}
        <div className="ab-contact-flag">
          <RestrictionTag status={flag} />
        </div>
        <div className="ab-contact-line">
          {primary && (
            <>
              <code className="ab-address-value" title={primary.address}>
                {shorten(primary.address)}
              </code>
              {copyButton(primary.address, addressKey(primary.address, primary.chainId))}
            </>
          )}
          <span className="ab-contact-netcount">
            {netCount === 1 ? '1 network' : `${netCount} networks`}
          </span>
        </div>
        <button
          type="button"
          className="ab-details-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          // The details region only exists in the DOM while expanded, so only
          // reference it then (a dangling aria-controls id fails axe).
          aria-controls={expanded ? detailsId : undefined}
          aria-label={`${expanded ? 'Close' : 'Show'} details for ${contact.nickname}`}
        >
          {expanded ? 'Close' : 'Details'}
        </button>
      </div>

      {expanded && (
        <div className="ab-contact-details" id={detailsId}>
          <ul className="ab-address-list">
            {contact.addresses.map((a, i) => {
              const key = addressKey(a.address, a.chainId)
              return (
                <li key={key} className="ab-address-row">
                  <div className="ab-address-netlabel">
                    <span>{networkName(a.chainId)}</span>
                    {rowVerdicts[i] === NO_SOURCE ? (
                      <span className="ab-address-nosource">No screening source on this network</span>
                    ) : (
                      <RestrictionTag status={rowVerdicts[i] || 'loading'} />
                    )}
                  </div>
                  <div className="ab-address-main">
                    <code className="ab-address-full" title={a.address}>
                      {a.address}
                    </code>
                    {copyButton(a.address, `${key}:full`)}
                  </div>
                  {a.notes && <p className="ab-address-notes">{a.notes}</p>}
                </li>
              )
            })}
          </ul>
          <div className="ab-contact-actions">
            <button
              type="button"
              className="ab-btn ab-btn-sm"
              onClick={() => onEdit?.(contact)}
              aria-label={`Edit contact ${contact.nickname}`}
            >
              <IconEdit />
              <span>Edit</span>
            </button>
            <button
              type="button"
              className="ab-btn ab-btn-sm ab-btn-danger"
              onClick={() => onDeleteContact?.(contact.id)}
              aria-label={`Delete contact ${contact.nickname}`}
            >
              <IconTrash />
              <span>Delete</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
