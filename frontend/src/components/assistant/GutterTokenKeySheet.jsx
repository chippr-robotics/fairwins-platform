/**
 * GutterTokenKeySheet (spec 104) — paste, test and save a GutterToken key.
 *
 * An `ActionSheet` (the spec-045 informative idiom): what the key authorises is stated BEFORE the
 * paste field, because a member who pastes first and reads second has already made the decision.
 *
 * "Test and save" is one button, and its two failure modes are deliberately different (the
 * spec-069 rule for saving an RPC endpoint, applied to a key):
 *   · GutterToken REFUSES the key (401 / `key_invalid`) → the save is refused too. Saving a key the
 *     service has just said is not valid would make the Assistant tab claim a rail exists.
 *   · GutterToken cannot be REACHED → the key is SAVED and the failure is shown. A timeout is a
 *     fact about the network, not about the key, and refusing the save would strand a member on a
 *     flaky connection with a key that may be perfectly good.
 *
 * After a save this component never renders more than the redacted form. The paste field is
 * cleared, and the confirmation names the key by its last characters only.
 */

import { useCallback, useEffect, useId, useState } from 'react'
import PropTypes from 'prop-types'
import ActionSheet from '../account/ActionSheet'
import { useWallet } from '../../hooks/useWalletManagement'
import {
  redactGutterTokenKey,
  saveGutterTokenKey,
  testGutterTokenKey,
  validateGutterTokenKeyFormat,
} from '../../lib/assistant/guttertokenKeyStore'
import {
  REFERRAL_DISCLOSURE,
  describeTestOutcome,
  gutterTokenSignupUrl,
  keySheetLead,
} from './providerCopy'
import './GutterTokenKeySheet.css'

export default function GutterTokenKeySheet({ open, onClose, account, onSaved }) {
  // How the member signs in decides how they can create a GutterToken account at all — a passkey
  // account has no key GutterToken's wallet sign-in could use, and their page detects an injected
  // wallet only. See `keySheetLead`.
  const { loginMethod } = useWallet()
  const inputId = useId()
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  // { tone: 'refused' | 'saved-unchecked' | 'saved', text, hint } — the sentence under the form.
  const [status, setStatus] = useState(null)

  // A fresh opening is a fresh form: nothing typed for a previous account or attempt survives.
  useEffect(() => {
    if (!open) return
    setValue('')
    setShow(false)
    setBusy(false)
    setStatus(null)
  }, [open])

  const format = value.trim() === '' ? { ok: false } : validateGutterTokenKeyFormat(value.trim())
  const formatError = value.trim() !== '' && !format.ok ? format.error || 'That does not look like a GutterToken key.' : null

  const testAndSave = useCallback(
    async (e) => {
      e?.preventDefault?.()
      const key = value.trim()
      if (!account || busy || !key) return
      const check = validateGutterTokenKeyFormat(key)
      if (!check.ok) return
      setBusy(true)
      setStatus(null)
      let result
      try {
        result = await testGutterTokenKey(key)
      } catch (err) {
        result = { ok: false, state: err?.state || 'unreachable', message: err?.message }
      }
      const outcome = describeTestOutcome(result)
      const hint = redactGutterTokenKey(key)

      if (!result?.ok && (result?.state === 'key_invalid' || result?.state === 'unauthorized')) {
        // Refused by the service ⇒ refused here. The pasted value stays so the member can fix it.
        setStatus({ tone: 'refused', text: `${outcome.text} Nothing was saved.` })
        setBusy(false)
        return
      }

      saveGutterTokenKey(account, key)
      // The secret leaves component state the moment it is stored.
      setValue('')
      setShow(false)
      setBusy(false)

      if (result?.ok || result?.state === 'out_of_credit') {
        onSaved?.({ ...outcome, hint })
        onClose?.()
        return
      }
      // Saved, but unconfirmed: keep the sheet open so the failure is READ, not hidden by a close.
      const text = `Key ${hint} saved, but GutterToken could not be reached to check it. Test it from the Assistant tab when you are back online.`
      setStatus({ tone: 'saved-unchecked', text, hint })
      onSaved?.({ tone: 'unknown', text, hint })
    },
    [account, busy, onClose, onSaved, value]
  )

  const saved = status?.tone === 'saved-unchecked'

  return (
    <ActionSheet open={open} onClose={onClose} title="Add a GutterToken key" className="guttertoken-key-sheet" closeDisabled={busy}>
      <div data-testid="guttertoken-key-sheet">
        <p className="action-sheet__text" data-testid="guttertoken-key-lead">
          {keySheetLead(loginMethod)}
        </p>
        <p className="action-sheet__text">
          The assistant will then answer on <strong>your prepaid credits</strong>, from this device,
          with FairWins out of the path.
        </p>
        <ul className="action-sheet__list">
          <li>It can spend your GutterToken balance — from this device, for this account, only when you ask something.</li>
          <li>It is stored on this device only and never backed up or synced.</li>
          <li>Remove it from the Assistant tab, or revoke it at GutterToken, at any time.</li>
        </ul>

        {!saved && (
          <form className="guttertoken-key-sheet__form" onSubmit={testAndSave}>
            <label htmlFor={inputId} className="guttertoken-key-sheet__label">
              GutterToken key
            </label>
            <div className="guttertoken-key-sheet__field">
              <input
                id={inputId}
                type={show ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                disabled={busy}
                aria-invalid={formatError ? 'true' : undefined}
                aria-describedby={formatError ? `${inputId}-error` : undefined}
                data-testid="guttertoken-key-input"
              />
              <button
                type="button"
                className="btn guttertoken-key-sheet__show"
                onClick={() => setShow((v) => !v)}
                aria-pressed={show}
                disabled={busy}
                data-testid="guttertoken-key-show"
              >
                {show ? 'Hide' : 'Show'}
              </button>
            </div>
            {formatError && (
              <p className="guttertoken-key-sheet__error" id={`${inputId}-error`} role="alert" data-testid="guttertoken-key-format-error">
                {formatError}
              </p>
            )}

            <div className="action-sheet__actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || value.trim() === '' || Boolean(formatError)}
                data-testid="guttertoken-key-save"
              >
                {busy ? 'Checking with GutterToken…' : 'Test and save'}
              </button>
            </div>
          </form>
        )}

        {status && (
          <p
            className={`action-sheet__notice ${status.tone === 'refused' ? 'action-sheet__notice--error' : 'action-sheet__notice--info'}`}
            role={status.tone === 'refused' ? 'alert' : 'status'}
            data-testid="guttertoken-key-status"
          >
            {status.text}
          </p>
        )}

        {saved && (
          <div className="action-sheet__actions">
            <button type="button" className="btn btn-primary" onClick={onClose} data-testid="guttertoken-key-done">
              Done
            </button>
          </div>
        )}

        <p className="guttertoken-key-sheet__get">
          <a
            href={gutterTokenSignupUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className="guttertoken-key-sheet__link"
            data-testid="guttertoken-key-sheet-signup"
          >
            Get a key ↗
          </a>{' '}
          <span className="guttertoken-key-sheet__disclosure">{REFERRAL_DISCLOSURE}</span>
        </p>
      </div>
    </ActionSheet>
  )
}

GutterTokenKeySheet.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  /** The account the key is stored for — wallet-scoped, like the preferences. */
  account: PropTypes.string,
  /** Called with `{ tone, text, hint }` after a save (checked or not). */
  onSaved: PropTypes.func,
}
