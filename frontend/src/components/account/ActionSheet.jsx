/**
 * Shared informative bottom sheet for account-security actions (specs 041/045).
 *
 * High-stakes, infrequent account actions (recover an account, add a passkey,
 * link a controller wallet) each open one of these so the member is fully
 * informed before they act. Centered card on desktop, sheet rising from the
 * bottom on mobile, with the mobile bottom-nav clearance from #938 (backdrop
 * z-index 1500 + safe-area padding) so the actions never hide behind the fixed
 * icon nav. Traps focus, locks background scroll, and closes on Escape +
 * backdrop — unless `closeDisabled` (e.g. a ceremony/transaction is in flight,
 * which must never be dismissed out from under). Renders nothing when closed.
 */

import { useEffect, useRef } from 'react'
import PropTypes from 'prop-types'
import './ActionSheet.css'

/** Open sheets, oldest first — module-level because sheets are independent components. */
const OPEN_SHEETS = []

export default function ActionSheet({ open, onClose, title, children, closeDisabled = false, className = '', tier = 'sheet' }) {
  const dialogRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const closeDisabledRef = useRef(closeDisabled)
  useEffect(() => {
    onCloseRef.current = onClose
  })
  useEffect(() => {
    closeDisabledRef.current = closeDisabled
  })

  useEffect(() => {
    if (!open) return undefined
    // Sheets can stack (a signing ceremony opens over the sheet that asked for it). Only the TOP
    // sheet answers Escape and traps Tab; otherwise one Escape closes both, and the lower sheet
    // drags focus out of the dialog the member is actually using.
    const token = {}
    OPEN_SHEETS.push(token)
    const onKey = (e) => {
      if (OPEN_SHEETS[OPEN_SHEETS.length - 1] !== token) return
      if (e.key === 'Escape') {
        if (!closeDisabledRef.current) onCloseRef.current?.()
        return
      }
      if (e.key !== 'Tab') return
      const dialog = dialogRef.current
      if (!dialog) return
      const focusables = dialog.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const outside = !dialog.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || outside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || outside)) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    return () => {
      const at = OPEN_SHEETS.indexOf(token)
      if (at !== -1) OPEN_SHEETS.splice(at, 1)
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open])

  if (!open) return null

  const handleBackdrop = () => {
    if (!closeDisabled) onClose?.()
  }

  return (
    <div
      className={`action-sheet__backdrop${tier === 'ceremony' ? ' action-sheet__backdrop--ceremony' : ''}`}
      role="presentation"
      onClick={handleBackdrop}
    >
      <div
        className={`action-sheet ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="action-sheet__handle" aria-hidden="true" />
        <div className="action-sheet__header">
          <h3>{title}</h3>
          <button
            type="button"
            className="action-sheet__close"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="action-sheet__body">{children}</div>
      </div>
    </div>
  )
}

ActionSheet.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  title: PropTypes.string.isRequired,
  children: PropTypes.node,
  closeDisabled: PropTypes.bool,
  /** Extra class on the sheet, for callers whose content needs a scoped tweak (e.g. a long form
      that wants its header pinned). Additive only — the shell's own behaviour is unchanged. */
  className: PropTypes.string,
  /** 'ceremony' lifts the sheet above every other sheet. For the deferred-signing dialogs only
      (spec 088): they open FROM another sheet (Verify's "Sign a message", a confirm step) and are
      mounted earlier in the DOM, so at the same tier they rendered UNDER the sheet that asked for
      them — the member saw "Waiting for your signature…" and no way to give it (spec 111 SIG-03). */
  tier: PropTypes.oneOf(['sheet', 'ceremony']),
}
