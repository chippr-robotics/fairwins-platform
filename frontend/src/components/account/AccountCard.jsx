/**
 * Spec 086 (FR-004) — THE account card. One component renders the account tile everywhere a card
 * of the member's own accounts appears (the portfolio carousel today; any future card surface
 * must use this rather than drawing its own). Every kind — personal, multisig, recovered,
 * hardware — gets the same layout; the kind is a tag, not a different card.
 *
 * The card is a soft glass layer (AccountCard.css) and renders the member's cosmetics from the
 * device-local profile store: tint + pattern as data attributes the CSS interprets, the picture
 * through AccountAvatar. Cosmetics are presentation only — nothing here reads them for logic.
 *
 * The card itself is the listbox OPTION (a single button, no nested interactive elements); the
 * customize affordance lives with the card's host surface, not inside the option.
 */

import { useMemo, useSyncExternalStore } from 'react'
import PropTypes from 'prop-types'
import AccountAvatar from './AccountAvatar'
import NavIcon from '../nav/NavIcon'
import { shortAccountAddr } from '../../hooks/useAccountSwitcher'
import {
  getAccountProfile,
  getAccountProfilesRevision,
  subscribeAccountProfiles,
} from '../../lib/account/accountProfilesStore'
import { ACCOUNT_KIND_LABEL } from '../../lib/account/accountKinds'
import './AccountCard.css'

export default function AccountCard({ account, active = false, network = null, balance = null, onSelect, idleLabel = 'Tap to use' }) {
  const revision = useSyncExternalStore(subscribeAccountProfiles, getAccountProfilesRevision)
  const profile = useMemo(
    () => getAccountProfile(account.address),
    // The store lives outside React, so the revision IS the dependency that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account.address, revision],
  )

  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      className={`account-card account-card--${account.kind} ${active ? 'is-active' : ''}`}
      data-tint={profile?.tint ?? 'none'}
      data-pattern={profile?.pattern ?? 'none'}
      onClick={onSelect}
    >
      <span className="account-card-top">
        <AccountAvatar address={account.address} size={36} />
        <span className="account-card-kind">{ACCOUNT_KIND_LABEL[account.kind] || account.kind}</span>
      </span>
      <span className="account-card-label">{account.label || shortAccountAddr(account.address)}</span>
      {balance}
      <span className="account-card-bottom">
        <span className="account-card-address">{shortAccountAddr(account.address)}</span>
        {network && <span className="account-card-network">{network}</span>}
      </span>
      <span className={`account-card-state ${active ? 'is-active' : ''}`}>
        {active ? (
          <>
            <NavIcon name="check" size={12} /> Active
          </>
        ) : (
          idleLabel
        )}
      </span>
    </button>
  )
}

AccountCard.propTypes = {
  /** { kind, address, label } from useAccountSwitcher. */
  account: PropTypes.object.isRequired,
  active: PropTypes.bool,
  /** Chain name line (vault cards). */
  network: PropTypes.string,
  /** Pre-rendered balance node for the active card, or null. */
  balance: PropTypes.node,
  onSelect: PropTypes.func,
  /** What tapping a non-active card does — 'Tap to use' switches accounts (carousel); a host that
   *  opens something else (spec 102: the vault sheet) says so instead. */
  idleLabel: PropTypes.string,
}
