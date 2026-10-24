/**
 * App lock store (spec 041 amendment, release 1.14.0 — FR-025 / FR-026 / FR-028).
 *
 * Two pieces of state, deliberately separate, because they answer different questions and have
 * different lifetimes:
 *
 *   · THE SETTING (`app_lock` in `fw_global_prefs`) — "should this device darken itself?".
 *     Device-scoped, OFF by default, and — like `nav_density` (spec 081) and `network_endpoints`
 *     (spec 069) — deliberately ABSENT from the spec-032 synced backup. Whether one browser
 *     auto-locks is a posture of that browser, not account data: syncing it would arm a lock on a
 *     device whose member never chose one, or carry a "locked" flag onto a device that cannot run
 *     the unlock ceremony at all.
 *
 *   · THE LOCK STATE (`fairwins.applock.state.v1` in localStorage) — "is the screen dark right
 *     now?". It lives in its OWN localStorage key rather than in the prefs blob for one reason:
 *     the browser's `storage` event fires in every OTHER tab of the origin when that key changes,
 *     which is exactly FR-028 — one lock event darkens every tab, one unlock ceremony lifts them
 *     all. A tab-local React state could never do that.
 *
 * Neither piece ever reads, writes, or clears `fairwins.passkey.session.v1`. That is the whole
 * design (FR-026): the lock is a UI gate over an INTACT session — the session cookie stays, the
 * screen goes dark — and explicit sign-out remains the only thing that clears session state.
 */
import { getGlobalPreference, saveGlobalPreference } from '../../utils/userStorage'

/** Global-preference key holding the member's opt-in. Device-scoped, never synced. */
export const APP_LOCK_PREF_KEY = 'app_lock'

/** Cross-tab lock flag. Its own localStorage key so the `storage` event carries it (FR-028). */
export const APP_LOCK_STATE_KEY = 'fairwins.applock.state.v1'

/** Idle period before the overlay engages (FR-025). */
export const IDLE_LOCK_MS = 15 * 60 * 1000

/** @type {boolean|null} lazily loaded snapshot of the setting */
let enabledSnapshot = null
const listeners = new Set()

function readEnabledFromStorage() {
  // `=== true` and nothing looser: a foreign stored shape ('yes', 1, {}) is read as OFF. A
  // security setting must never be turned ON by a value nobody in this codebase wrote — and it
  // must never be turned on by accident at all, since the member would then face a lock they
  // did not ask for.
  return getGlobalPreference(APP_LOCK_PREF_KEY, false) === true
}

/** Is the app lock armed on this device? Off unless the member explicitly turned it on. */
export function isAppLockEnabled() {
  if (enabledSnapshot === null) enabledSnapshot = readEnabledFromStorage()
  return enabledSnapshot
}

/** Subscribe to setting/lock changes made in THIS tab. Returns an unsubscribe function. */
export function subscribeAppLock(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify() {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A bad subscriber must never leave the lock half-applied: the state is already written,
      // and a thrown render is not a reason to hand back an unlocked UI.
    }
  }
}

/** Is the screen dark right now? Read straight from storage — other tabs write this key too. */
export function readLockState() {
  try {
    const raw = globalThis.localStorage?.getItem(APP_LOCK_STATE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    return parsed?.locked === true
  } catch {
    // Unparseable means we cannot prove the app is unlocked. A storage read that fails is not
    // permission to show account content, so treat the presence of the key as locked.
    return Boolean(globalThis.localStorage?.getItem(APP_LOCK_STATE_KEY))
  }
}

/**
 * Darken the screen. Writes the shared key (so every other tab follows) and notifies this tab.
 * Touches nothing else — no session, no credential, no cached role.
 */
export function engageLock() {
  if (readLockState()) return
  try {
    globalThis.localStorage?.setItem(APP_LOCK_STATE_KEY, JSON.stringify({ locked: true, at: Date.now() }))
  } catch {
    // Storage refused (private mode, quota). The overlay still renders from the notify below;
    // it simply will not survive a reload or reach other tabs. Degrading to "no lock at all"
    // would be the worse failure.
  }
  notify()
}

/** Lift the screen. Only ever called after a successful ceremony, a sign-out, or opting out. */
export function releaseLock() {
  const wasLocked = readLockState()
  try {
    globalThis.localStorage?.removeItem(APP_LOCK_STATE_KEY)
  } catch {
    // See engageLock.
  }
  if (wasLocked) notify()
}

/**
 * Turn the setting on or off for this device.
 *
 * Turning it OFF also releases any engaged lock: leaving the overlay up after the member has
 * just said "stop locking me" would be a lock with no setting behind it, and the only way out
 * would be a ceremony for a feature they had already switched off.
 */
export function setAppLockEnabled(next) {
  const value = next === true
  enabledSnapshot = value
  saveGlobalPreference(APP_LOCK_PREF_KEY, value)
  if (!value) releaseLock()
  notify()
}

/** Test seam: forget the in-memory snapshot and subscribers; storage is left untouched. */
export function __resetAppLockForTests() {
  enabledSnapshot = null
  listeners.clear()
}
