/**
 * AppLockPreferencesPanel (spec 041 amendment — FR-025's setting surface).
 *
 * The card is offered ONLY where the lock could actually be opened again:
 *
 *   · no passkey session → HIDDEN. A classic wallet has no re-prompt this app can raise, so an
 *     enabled lock would be a door with no key. Hiding it is the FR-004 posture applied to the
 *     setting rather than to the login button.
 *   · passkey session, authenticator not usable here → SHOWN but DISABLED, carrying the
 *     detector's own reason. A control that is present and silently does nothing is worse than
 *     one that says why it cannot.
 *
 * The preference itself is DEVICE-SCOPED (`fw_global_prefs.app_lock`) and deliberately outside
 * the spec-032 synced backup — see the header of `lib/applock/appLock.js` for why.
 */

import { useCallback, useEffect, useState } from 'react'
import { useWallet } from '../../hooks/useWalletManagement'
import { detectCapability } from '../../lib/passkey/credentials'
import { isAppLockEnabled, setAppLockEnabled, subscribeAppLock } from '../../lib/applock/appLock'
import AccordionSection from './AccordionSection'
import NavIcon from '../nav/NavIcon'
import './AppLockPreferencesPanel.css'

export default function AppLockPreferencesPanel() {
  const { isConnected, loginMethod } = useWallet()
  const [capability, setCapability] = useState(null)
  const [, setRevision] = useState(0)

  // The overlay's own sign-out path can turn nothing off, but the setting is readable from two
  // places; keep this card honest if it ever changes elsewhere.
  useEffect(() => subscribeAppLock(() => setRevision((n) => n + 1)), [])

  const eligible = Boolean(isConnected) && loginMethod === 'passkey'

  useEffect(() => {
    if (!eligible) return undefined
    let alive = true
    detectCapability()
      .then((result) => {
        if (alive) setCapability(result)
      })
      .catch(() => {
        // A detector that threw is not a working authenticator. Say so rather than offering a
        // switch we cannot stand behind.
        if (alive) setCapability({ available: false, reason: 'Passkey support could not be confirmed on this device.' })
      })
    return () => {
      alive = false
    }
  }, [eligible])

  const enabled = isAppLockEnabled()

  const toggle = useCallback(() => {
    setAppLockEnabled(!isAppLockEnabled())
    setRevision((n) => n + 1)
  }, [])

  // No passkey session: there is no ceremony that could lift the lock, so the setting is not
  // offered at all (FR-025's closing sentence).
  if (!eligible) return null

  const available = capability?.available === true
  const reason = capability?.reason

  return (
    <AccordionSection
      id="app-lock"
      // A node rather than a plain string so the switch can be NAMED BY the card it belongs to
      // (`aria-labelledby`) instead of carrying a second, duplicate label of its own.
      title={<span id="app-lock-title">App lock</span>}
      summary={enabled ? 'On — locks this device when idle' : 'Off'}
      icon={<NavIcon name="lock" size={18} />}
      className="app-lock-prefs"
      defaultOpen
      data-testid="app-lock-prefs-panel"
    >
      <div className="app-lock-prefs__row">
        <input
          type="checkbox"
          className="app-lock-prefs__checkbox"
          aria-labelledby="app-lock-title"
          checked={enabled}
          disabled={!available}
          onChange={toggle}
          data-testid="app-lock-toggle"
        />
        <span className="app-lock-prefs__sub">
          Cover the screen after 15 minutes without activity, and straight away when you leave or
          background the tab. Your passkey opens it again.
        </span>
      </div>

      {!available && reason && (
        <p className="app-lock-prefs__note" role="note">
          {reason}
        </p>
      )}

      <p className="app-lock-prefs__note">
        Locking is a cover over the screen, not a sign-out. Your session, your account and your
        place in the app stay exactly as they are while it is on, and signing out stays the only
        thing that clears them. The lock screen always offers sign-out too.
      </p>
    </AccordionSection>
  )
}
