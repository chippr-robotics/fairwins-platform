/**
 * Spec 086 (FR-008) / spec 102 (US4) — the customize BODY: preview, picture, shade, pattern,
 * error and reset for one account's card. Extracted from AccountCustomizeSheet so the same
 * surface can be mounted without the sheet chrome (the vault sheet's Style view hosts it
 * inline). Changes apply immediately (the store is reactive) — nothing is staged.
 *
 * Everything happens on-device: the picture is downscaled locally and stored as a small data URL
 * (never uploaded), and tints/patterns are token ids the CSS interprets per theme. The profile is
 * keyed by ADDRESS, so a vault on several networks has exactly one look (spec 102 FR-009).
 *
 * `onBusyChange` tells the host when an image is being prepared, so a sheet can refuse to close
 * out from under it; `trailingActions` lets the host add its own buttons (e.g. "Done") beside
 * Reset without re-implementing the row.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import PropTypes from 'prop-types'
import AccountAvatar from './AccountAvatar'
import {
  CARD_TINTS,
  CARD_PATTERNS,
  getAccountProfile,
  getAccountProfilesRevision,
  subscribeAccountProfiles,
  setAccountProfile,
  clearAccountProfile,
} from '../../lib/account/accountProfilesStore'
import { processProfileImage } from '../../lib/account/profileImage'
import './AccountCustomizeSheet.css'

const TINT_LABEL = {
  none: 'Default',
  mint: 'Mint',
  sky: 'Sky',
  violet: 'Violet',
  amber: 'Amber',
  rose: 'Rose',
  slate: 'Slate',
}

const PATTERN_LABEL = {
  none: 'Plain',
  waves: 'Waves',
  dots: 'Dots',
  grid: 'Grid',
  rings: 'Rings',
}

export default function AccountCustomizeBody({ account, onBusyChange, trailingActions = null }) {
  useSyncExternalStore(subscribeAccountProfiles, getAccountProfilesRevision)
  const profile = account?.address ? getAccountProfile(account.address) : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)

  const address = account?.address
  const tint = profile?.tint ?? 'none'
  const pattern = profile?.pattern ?? 'none'

  // Report busy transitions to the host (after commit — the host may gate its close on it).
  const onBusyChangeRef = useRef(onBusyChange)
  useEffect(() => {
    onBusyChangeRef.current = onBusyChange
  })
  useEffect(() => {
    onBusyChangeRef.current?.(busy)
  }, [busy])

  const pickImage = useCallback(
    async (event) => {
      const file = event.target.files?.[0]
      event.target.value = '' // same file can be picked again after an error
      if (!file || !address) return
      setError(null)
      setBusy(true)
      try {
        const image = await processProfileImage(file)
        setAccountProfile(address, { image })
      } catch (e) {
        // A failed read never clears an existing picture (FR-011) — we only report.
        setError(e.message)
      } finally {
        setBusy(false)
      }
    },
    [address],
  )

  return (
    <div className="acs-body" data-testid="account-customize">
      <div className="acs-preview" data-tint={tint} data-pattern={pattern}>
        <AccountAvatar address={address} size={56} />
        <div className="acs-preview__text">
          <span className="acs-preview__label">{account?.label}</span>
          <span className="acs-preview__hint">Shown everywhere this account appears — on this device only.</span>
        </div>
      </div>

      <div className="acs-row">
        <span className="acs-row__title" id="acs-picture-title">Picture</span>
        <div className="acs-row__controls" role="group" aria-labelledby="acs-picture-title">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="acs-pick-image">
            {busy ? 'Preparing…' : profile?.image ? 'Replace picture' : 'Choose picture'}
          </button>
          {profile?.image && (
            <button type="button" onClick={() => setAccountProfile(address, { image: null })} disabled={busy}>
              Remove
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={pickImage}
            className="acs-file"
            aria-label="Choose a profile picture"
            tabIndex={-1}
          />
        </div>
      </div>

      <div className="acs-row">
        <span className="acs-row__title" id="acs-tint-title">Shade</span>
        <div className="acs-swatches" role="radiogroup" aria-labelledby="acs-tint-title">
          {CARD_TINTS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={tint === id}
              className="acs-swatch"
              data-tint={id}
              title={TINT_LABEL[id]}
              aria-label={`${TINT_LABEL[id]} shade`}
              onClick={() => setAccountProfile(address, { tint: id })}
              disabled={busy}
            />
          ))}
        </div>
      </div>

      <div className="acs-row">
        <span className="acs-row__title" id="acs-pattern-title">Pattern</span>
        <div className="acs-swatches" role="radiogroup" aria-labelledby="acs-pattern-title">
          {CARD_PATTERNS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={pattern === id}
              className="acs-swatch acs-swatch--pattern"
              data-pattern={id}
              title={PATTERN_LABEL[id]}
              aria-label={`${PATTERN_LABEL[id]} pattern`}
              onClick={() => setAccountProfile(address, { pattern: id })}
              disabled={busy}
            />
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="acs-error">
          {error}
        </p>
      )}

      <div className="acs-actions">
        <button
          type="button"
          onClick={() => {
            clearAccountProfile(address)
            setError(null)
          }}
          disabled={busy || !profile}
          data-testid="acs-reset"
        >
          Reset card
        </button>
        {trailingActions}
      </div>
    </div>
  )
}

AccountCustomizeBody.propTypes = {
  /** { address, label, kind? } — the account whose card is being customized. */
  account: PropTypes.object,
  /** Called with true while a picture is being prepared, false when done. */
  onBusyChange: PropTypes.func,
  /** Extra controls rendered after "Reset card" (the sheet's "Done"). */
  trailingActions: PropTypes.node,
}
