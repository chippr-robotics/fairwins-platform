/**
 * AppLockOverlay (spec 041 amendment, release 1.14.0 — User Story 7, FR-025…FR-028).
 *
 * A content-obscuring cover over an INTACT session. Four properties are load-bearing, and each
 * one is a thing this component deliberately does NOT do:
 *
 *  1. **It never unmounts the app.** It renders BESIDE the app tree and paints over it. An
 *     FR-008 confirmation modal that was open when the lock fired is still mounted underneath
 *     when the member comes back — so locking neither confirms, submits, nor silently drops it.
 *     Unmounting the tree would "abort" in-flight UI as a side effect of a screensaver, which is
 *     exactly the failure FR-027 names.
 *
 *  2. **It never touches the session.** No storage write, no disconnect, no cache invalidation.
 *     Locking, staying locked for a week, and failing to unlock all leave
 *     `fairwins.passkey.session.v1` byte-identical (FR-026). Correspondingly the copy never says
 *     "session expired" — nothing expired; the screen went dark.
 *
 *  3. **When the setting is off it does not exist.** The armed body is a CHILD component, so a
 *     member who never opted in has no idle timer, no `visibilitychange` handler, and no
 *     `storage` listener installed at all — today's behaviour, byte-for-byte (SC-010).
 *
 *  4. **A failed ceremony changes nothing.** Cancel, timeout, or an authenticator that is not
 *     usable here all leave the app locked with the same button still offered. There is no
 *     failure count, no lockout, and no path from "unlock failed" to "signed out" — sign-out is
 *     a separate, explicit control that the overlay always offers as the escape hatch (FR-027).
 *
 * Cross-tab consistency (FR-028) rides the shared `fairwins.applock.state.v1` key: this component
 * listens for the browser's `storage` event, so another tab's lock darkens this one and another
 * tab's successful ceremony lifts this one — one ceremony, all tabs, never one prompt per window.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useWallet } from '../../hooks/useWalletManagement'
import { getAssertion, AuthenticatorUnavailable, CeremonyCancelled } from '../../lib/passkey/credentials'
import { readSession } from '../../connectors/passkey'
import {
  APP_LOCK_STATE_KEY,
  IDLE_LOCK_MS,
  engageLock,
  isAppLockEnabled,
  readLockState,
  releaseLock,
  subscribeAppLock,
} from '../../lib/applock/appLock'
import { subscribeAppHidden } from '../../lib/native/lifecycle'
import './AppLockOverlay.css'

/**
 * What counts as "the member is still here". Deliberately coarse and passive: a pointer moving
 * across the page is presence, and requiring clicks would lock somebody mid-read.
 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'scroll', 'focus']

/** A fresh 32-byte WebAuthn challenge. Falls back only where no CSPRNG is exposed at all. */
function freshChallenge() {
  const bytes = new Uint8Array(32)
  const cryptoObj = globalThis.crypto
  if (cryptoObj?.getRandomValues) cryptoObj.getRandomValues(bytes)
  return bytes
}

/**
 * The member-facing reason a ceremony did not complete.
 *
 * Every branch keeps two things true: it says what actually happened, and it never suggests the
 * session is gone. "Unlock was cancelled" is a fact about a prompt; "session expired" would be a
 * false statement about an account.
 */
function describeUnlockFailure(err) {
  if (err instanceof AuthenticatorUnavailable) {
    // e.g. "Passkeys are not available: no credential manager in this context". The honest
    // reading (FR-027 / the authenticator-unavailable edge case): retrying will not help here,
    // so point at the escape hatch rather than at the button that just failed.
    return `${err.message}. You are still signed in — you can sign out below, or unlock on a device where your passkey works.`
  }
  if (err instanceof CeremonyCancelled) {
    return 'Unlock was cancelled. You are still signed in — try again when you are ready.'
  }
  return `Unlock did not complete: ${err?.message || 'the passkey prompt failed'}. You are still signed in — try again.`
}

/**
 * The armed half. Mounted ONLY while the setting is on for a passkey session, which is what
 * makes "off means no listeners at all" structurally true rather than a promise.
 */
function ArmedAppLock({ disconnectWallet }) {
  const [locked, setLocked] = useState(() => readLockState())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const unlockRef = useRef(null)

  // One source of truth for "is it dark": the shared key. `subscribeAppLock` carries this tab's
  // own engage/release; the `storage` event carries every other tab's (FR-028).
  useEffect(() => {
    const sync = () => setLocked(readLockState())
    const unsubscribe = subscribeAppLock(sync)
    const onStorage = (event) => {
      // `key === null` is a whole-storage clear, which we must also re-read rather than ignore.
      if (event.key === null || event.key === APP_LOCK_STATE_KEY) sync()
    }
    window.addEventListener('storage', onStorage)
    return () => {
      unsubscribe()
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  // The triggers. They are torn down once locked — activity behind an overlay is not presence,
  // and re-arming an idle timer under a lock would be counting nothing.
  useEffect(() => {
    if (locked) return undefined

    let timer = null
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(engageLock, IDLE_LOCK_MS)
    }
    const onVisibility = () => {
      // Backgrounding is the case the idle timer cannot cover: a phone that goes to the home
      // screen may never run our timer again, so the lock has to be immediate (FR-025b).
      if (document.visibilityState === 'hidden') engageLock()
    }

    for (const type of ACTIVITY_EVENTS) {
      window.addEventListener(type, arm, { passive: true })
    }
    window.addEventListener('pagehide', engageLock)
    document.addEventListener('visibilitychange', onVisibility)
    // Spec 102 (native channels): a backgrounded native WebView does not
    // reliably fire visibilitychange, so the OS lifecycle feeds the same rule
    // through the native seam. Inert on web — the DOM listeners above stay the
    // only source there, so nothing double-fires.
    const unsubscribeNative = subscribeAppHidden(engageLock)
    arm()

    return () => {
      if (timer) clearTimeout(timer)
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, arm)
      window.removeEventListener('pagehide', engageLock)
      document.removeEventListener('visibilitychange', onVisibility)
      unsubscribeNative()
    }
  }, [locked])

  // Focus the way out. Without this the member's focus is still somewhere under the cover, and a
  // keyboard user would tab through account content they cannot see.
  useEffect(() => {
    if (locked) unlockRef.current?.focus()
  }, [locked])

  const unlock = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      // Pinned to the session's OWN credential where we know it, so the platform does not offer a
      // chooser that could unlock this screen with a different account's passkey.
      const credentialId = readSession()?.credentialId
      await getAssertion({ challenge: freshChallenge(), credentialId })
      // The ceremony authorises exactly one thing: lifting the cover. It is not sign-in, and it
      // is not authorisation for anything that moves value — an action taken after this still
      // runs its own fresh FR-008 ceremony.
      releaseLock()
    } catch (err) {
      setError(describeUnlockFailure(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      // The real FR-003 sign-out — the one and only thing that clears the session.
      await disconnectWallet?.()
      // Release afterwards so the next member to sign in on this device is not met by a lock
      // belonging to a session that no longer exists.
      releaseLock()
    } catch (err) {
      setError(`Sign-out did not complete: ${err?.message || 'please try again'}.`)
    } finally {
      setBusy(false)
    }
  }, [disconnectWallet])

  if (!locked) return null

  return (
    <div
      className="app-lock"
      role="dialog"
      aria-modal="true"
      aria-label="FairWins is locked"
      data-testid="app-lock-overlay"
    >
      <div className="app-lock__card">
        <h2 className="app-lock__title">Locked</h2>
        <p className="app-lock__body">
          This device locked itself. You are still signed in — unlock with your passkey to pick up
          exactly where you left off.
        </p>

        {error && (
          <p className="app-lock__error" role="alert">
            {error}
          </p>
        )}

        <button
          type="button"
          ref={unlockRef}
          className="app-lock__unlock"
          onClick={unlock}
          disabled={busy}
        >
          {busy ? 'Waiting for your passkey…' : 'Unlock'}
        </button>

        <button type="button" className="app-lock__signout" onClick={signOut} disabled={busy}>
          Sign out instead
        </button>
      </div>
    </div>
  )
}

export default function AppLockOverlay() {
  const { isConnected, loginMethod, disconnectWallet } = useWallet()
  const [, setRevision] = useState(0)

  // The setting can be flipped from the Settings card while this is mounted; re-read it when it
  // changes. This is an in-memory subscription — no window/document listener, so an opted-out
  // member still has none.
  useEffect(() => subscribeAppLock(() => setRevision((n) => n + 1)), [])

  // Only a passkey session can be re-prompted, which is the same posture the setting itself is
  // offered under (FR-004 / FR-025): a lock nobody could open would be a trap, not a feature.
  const armed = Boolean(isConnected) && loginMethod === 'passkey' && isAppLockEnabled()
  if (!armed) return null

  return <ArmedAppLock disconnectWallet={disconnectWallet} />
}
