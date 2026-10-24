/**
 * App lock store (spec 041 amendment, release 1.14.0 — FR-025/FR-026/FR-028).
 *
 * Two pieces of state, deliberately separate:
 *  - the SETTING (`app_lock` in `fw_global_prefs`): device-scoped, off by default, and — like
 *    `nav_density` and `network_endpoints` — deliberately absent from the spec-032 synced backup.
 *  - the LOCK STATE (`fairwins.applock.state.v1` in localStorage): whether the screen is dark
 *    right now. It lives in localStorage precisely so the browser's `storage` event carries a
 *    lock/unlock to every other tab of the same session (FR-028).
 *
 * Neither piece ever touches `fairwins.passkey.session.v1` — the lock is a UI gate over an
 * intact session (FR-026), and these tests read the session key back to prove it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  APP_LOCK_PREF_KEY,
  APP_LOCK_STATE_KEY,
  IDLE_LOCK_MS,
  isAppLockEnabled,
  setAppLockEnabled,
  readLockState,
  engageLock,
  releaseLock,
  subscribeAppLock,
  __resetAppLockForTests,
} from '../../lib/applock/appLock'

const SESSION_KEY = 'fairwins.passkey.session.v1'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetAppLockForTests()
})

describe('the setting (FR-025)', () => {
  it('is OFF by default — a member who never enables it sees no lock behavior', () => {
    expect(isAppLockEnabled()).toBe(false)
  })

  it('persists device-scoped in fw_global_prefs under the app_lock key', () => {
    setAppLockEnabled(true)
    expect(isAppLockEnabled()).toBe(true)
    const prefs = JSON.parse(localStorage.getItem('fw_global_prefs'))
    expect(prefs[APP_LOCK_PREF_KEY]).toBe(true)
    // Survives a snapshot reset (fresh module read hits storage again).
    __resetAppLockForTests()
    expect(isAppLockEnabled()).toBe(true)
  })

  it('treats a foreign stored shape as off, never as on', () => {
    localStorage.setItem('fw_global_prefs', JSON.stringify({ [APP_LOCK_PREF_KEY]: 'yes' }))
    expect(isAppLockEnabled()).toBe(false)
  })

  it('turning the setting off also releases an engaged lock', () => {
    setAppLockEnabled(true)
    engageLock()
    setAppLockEnabled(false)
    expect(readLockState()).toBe(false)
  })
})

describe('the lock state (FR-026, FR-028)', () => {
  it('engage/release round-trips through the cross-tab localStorage key', () => {
    expect(readLockState()).toBe(false)
    engageLock()
    expect(readLockState()).toBe(true)
    expect(localStorage.getItem(APP_LOCK_STATE_KEY)).toBeTruthy()
    releaseLock()
    expect(readLockState()).toBe(false)
    expect(localStorage.getItem(APP_LOCK_STATE_KEY)).toBeNull()
  })

  it('never touches the passkey session (the session cookie stays; the screen goes dark)', () => {
    const session = JSON.stringify({ address: '0x' + '1'.repeat(40), credentialId: 'cred-1' })
    localStorage.setItem(SESSION_KEY, session)
    engageLock()
    expect(localStorage.getItem(SESSION_KEY)).toBe(session)
    releaseLock()
    expect(localStorage.getItem(SESSION_KEY)).toBe(session)
  })

  it('notifies subscribers on engage and release, and a bad subscriber never breaks the lock', () => {
    const seen = []
    subscribeAppLock(() => seen.push(readLockState()))
    subscribeAppLock(() => {
      throw new Error('bad subscriber')
    })
    expect(() => engageLock()).not.toThrow()
    expect(() => releaseLock()).not.toThrow()
    expect(seen).toEqual([true, false])
  })

  it('unsubscribe stops notifications', () => {
    const seen = []
    const unsub = subscribeAppLock(() => seen.push(1))
    unsub()
    engageLock()
    expect(seen).toEqual([])
  })
})

describe('constants', () => {
  it('locks after fifteen minutes idle (FR-025)', () => {
    expect(IDLE_LOCK_MS).toBe(15 * 60 * 1000)
  })
})

describe('stays out of the synced backup', () => {
  it('is absent from the spec-032 synced object registry', () => {
    // Whether one device auto-locks its screen is a device posture, not account data — the same
    // call already made for nav_density (081) and network_endpoints (069). Syncing it would arm
    // the lock on devices whose member never chose it, or carry a "locked" flag onto a device
    // that cannot run the unlock ceremony.
    const registry = readFileSync(resolve(process.cwd(), 'src/lib/backup/syncedObjects.js'), 'utf-8')
    expect(registry).not.toContain(APP_LOCK_PREF_KEY)
    expect(registry).not.toContain(APP_LOCK_STATE_KEY)
    expect(registry).not.toContain('appLock')
  })
})
