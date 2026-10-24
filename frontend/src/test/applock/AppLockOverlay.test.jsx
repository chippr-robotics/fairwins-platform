/**
 * AppLockOverlay (spec 041 amendment, release 1.14.0 — User Story 7).
 *
 * The overlay is a UI gate over an intact session, and almost every test here proves a negative:
 *  - default off ⇒ the component renders NOTHING and installs NO listeners (SC-010: today's
 *    behavior, byte-for-byte);
 *  - locking, staying locked, unlocking and failing to unlock never touch the persisted passkey
 *    session (FR-026 — the session key is read back verbatim);
 *  - a failed/cancelled ceremony leaves the app locked with retry, never unlocked, never
 *    signed out (FR-027);
 *  - the app tree underneath stays MOUNTED — the overlay covers, it does not unmount, so an
 *    in-flight confirmation modal is neither confirmed nor dropped by the act of locking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

let walletState
const getAssertionMock = vi.fn()

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => walletState }))
vi.mock('../../lib/passkey/credentials', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getAssertion: (...args) => getAssertionMock(...args) }
})

// Spec 102: the overlay also subscribes the native lifecycle seam. The seam's
// own event mapping (and its web inertness) is proven in
// src/test/native/lifecycle.test.js; here we capture the callback the overlay
// hands it and fire it to stand in for the OS backgrounding the app.
const nativeHiddenRef = { fire: null }
vi.mock('../../lib/native/lifecycle', () => ({
  subscribeAppHidden: (onHidden) => {
    nativeHiddenRef.fire = onHidden
    return () => { nativeHiddenRef.fire = null }
  },
}))

import AppLockOverlay from '../../components/applock/AppLockOverlay'
import {
  APP_LOCK_STATE_KEY,
  IDLE_LOCK_MS,
  setAppLockEnabled,
  readLockState,
  __resetAppLockForTests,
} from '../../lib/applock/appLock'
import { CeremonyCancelled, AuthenticatorUnavailable } from '../../lib/passkey/credentials'

const SESSION_KEY = 'fairwins.passkey.session.v1'
const ADDRESS = '0x' + '2'.repeat(40)
const SESSION = JSON.stringify({ address: ADDRESS, credentialId: 'cred-lock-1', chainId: 137 })

const LOCK_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel', 'pagehide', 'storage']

function passkeySession() {
  localStorage.setItem(SESSION_KEY, SESSION)
  walletState = {
    address: ADDRESS,
    isConnected: true,
    loginMethod: 'passkey',
    chainId: 137,
    disconnectWallet: vi.fn().mockResolvedValue(undefined),
  }
}

function overlay() {
  return screen.queryByRole('dialog', { name: /locked/i })
}

function hideDocument() {
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  sessionStorage.clear()
  __resetAppLockForTests()
  getAssertionMock.mockReset()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  passkeySession()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('default off (SC-010)', () => {
  it('renders nothing and installs no window/document listeners', () => {
    const winSpy = vi.spyOn(window, 'addEventListener')
    const docSpy = vi.spyOn(document, 'addEventListener')
    render(<AppLockOverlay />)
    expect(overlay()).toBeNull()
    const winEvents = winSpy.mock.calls.map(([type]) => type)
    const docEvents = docSpy.mock.calls.map(([type]) => type)
    for (const type of LOCK_EVENTS) expect(winEvents).not.toContain(type)
    expect(docEvents).not.toContain('visibilitychange')
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS * 4))
    expect(overlay()).toBeNull()
  })

  it('renders nothing for a classic-wallet session even with the setting on', () => {
    setAppLockEnabled(true)
    walletState = { ...walletState, loginMethod: 'injected' }
    const winSpy = vi.spyOn(window, 'addEventListener')
    render(<AppLockOverlay />)
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS * 2))
    expect(overlay()).toBeNull()
    expect(winSpy.mock.calls.map(([type]) => type)).not.toContain('pointerdown')
  })
})

describe('engaging the lock (FR-025)', () => {
  it('locks after 15 minutes without interaction', () => {
    setAppLockEnabled(true)
    render(<AppLockOverlay />)
    expect(overlay()).toBeNull()
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS - 1000))
    expect(overlay()).toBeNull()
    act(() => vi.advanceTimersByTime(1000))
    expect(overlay()).not.toBeNull()
  })

  it('member activity resets the idle timer', () => {
    setAppLockEnabled(true)
    render(<AppLockOverlay />)
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS - 60_000))
    act(() => {
      window.dispatchEvent(new Event('pointerdown'))
    })
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS - 60_000))
    expect(overlay()).toBeNull()
    act(() => vi.advanceTimersByTime(61_000))
    expect(overlay()).not.toBeNull()
  })

  it('locks immediately when the page is hidden (visibilitychange)', () => {
    setAppLockEnabled(true)
    render(<AppLockOverlay />)
    act(() => {
      hideDocument()
    })
    expect(overlay()).not.toBeNull()
  })

  it('locks immediately when the NATIVE lifecycle reports backgrounding (spec 102)', () => {
    setAppLockEnabled(true)
    render(<AppLockOverlay />)
    expect(nativeHiddenRef.fire).toBeTypeOf('function')
    act(() => {
      nativeHiddenRef.fire()
    })
    expect(overlay()).not.toBeNull()
    // Persisted like every other engage: a process restart relaunches locked.
    expect(readLockState()).toBe(true)
  })

  it('locks immediately on pagehide, persisting the lock for the return visit', () => {
    setAppLockEnabled(true)
    render(<AppLockOverlay />)
    act(() => {
      window.dispatchEvent(new Event('pagehide'))
    })
    expect(overlay()).not.toBeNull()
    expect(readLockState()).toBe(true)
  })

  it('locking never clears or alters the persisted session (FR-026)', () => {
    setAppLockEnabled(true)
    render(<AppLockOverlay />)
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS))
    expect(overlay()).not.toBeNull()
    expect(localStorage.getItem(SESSION_KEY)).toBe(SESSION)
    // The overlay never uses session-expiry language: the session is intact.
    expect(screen.queryByText(/session expired/i)).toBeNull()
  })

  it('covers the app instead of unmounting it — in-flight UI underneath survives', () => {
    setAppLockEnabled(true)
    render(
      <>
        <div data-testid="in-flight-confirmation">Confirm sending 5 USDC</div>
        <AppLockOverlay />
      </>
    )
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS))
    expect(overlay()).not.toBeNull()
    // Still mounted: nothing was confirmed, submitted, or dropped by the act of locking.
    expect(screen.getByTestId('in-flight-confirmation')).toBeInTheDocument()
  })
})

describe('unlocking (FR-027)', () => {
  function renderLocked() {
    setAppLockEnabled(true)
    const view = render(<AppLockOverlay />)
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS))
    expect(overlay()).not.toBeNull()
    return view
  }

  it('a successful WebAuthn ceremony lifts the overlay and touches nothing else', async () => {
    getAssertionMock.mockResolvedValue({ credentialId: 'cred-lock-1' })
    renderLocked()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /unlock/i }))
    })
    expect(overlay()).toBeNull()
    // The ceremony was pinned to the session's own credential.
    expect(getAssertionMock).toHaveBeenCalledTimes(1)
    expect(getAssertionMock.mock.calls[0][0].credentialId).toBe('cred-lock-1')
    // Session intact, sign-out not run: unlock is not sign-in and lock was not sign-out.
    expect(localStorage.getItem(SESSION_KEY)).toBe(SESSION)
    expect(walletState.disconnectWallet).not.toHaveBeenCalled()
    // Other tabs read the release through the shared key.
    expect(readLockState()).toBe(false)
  })

  it('a cancelled ceremony stays locked with retry available, session intact', async () => {
    getAssertionMock.mockRejectedValue(new CeremonyCancelled())
    renderLocked()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /unlock/i }))
    })
    expect(overlay()).not.toBeNull()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    // Retry is the same button, still offered.
    expect(screen.getByRole('button', { name: /unlock/i })).toBeEnabled()
    expect(localStorage.getItem(SESSION_KEY)).toBe(SESSION)
    expect(walletState.disconnectWallet).not.toHaveBeenCalled()

    // And retry can then succeed.
    getAssertionMock.mockResolvedValue({ credentialId: 'cred-lock-1' })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /unlock/i }))
    })
    expect(overlay()).toBeNull()
  })

  it('an unavailable authenticator is reported honestly; sign-out stays reachable', async () => {
    getAssertionMock.mockRejectedValue(new AuthenticatorUnavailable('no credential manager in this context'))
    renderLocked()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /unlock/i }))
    })
    expect(overlay()).not.toBeNull()
    expect(screen.getByRole('alert').textContent).toMatch(/not available/i)
    expect(screen.getByRole('button', { name: /sign out/i })).toBeEnabled()
  })

  it('sign-out from the overlay runs the real FR-003 sign-out', async () => {
    renderLocked()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /sign out/i }))
    })
    expect(walletState.disconnectWallet).toHaveBeenCalledTimes(1)
    expect(getAssertionMock).not.toHaveBeenCalled()
  })
})

describe('cross-tab consistency (FR-028)', () => {
  it('a lock engaged in another tab locks this one', () => {
    setAppLockEnabled(true)
    render(<AppLockOverlay />)
    expect(overlay()).toBeNull()
    act(() => {
      // What another tab's engageLock() looks like from here: the key changes under us and the
      // browser delivers a storage event.
      localStorage.setItem(APP_LOCK_STATE_KEY, JSON.stringify({ locked: true, at: Date.now() }))
      window.dispatchEvent(
        new StorageEvent('storage', { key: APP_LOCK_STATE_KEY, newValue: localStorage.getItem(APP_LOCK_STATE_KEY) })
      )
    })
    expect(overlay()).not.toBeNull()
  })

  it("another tab's successful unlock unlocks this one — one ceremony, all tabs", () => {
    setAppLockEnabled(true)
    render(<AppLockOverlay />)
    act(() => vi.advanceTimersByTime(IDLE_LOCK_MS))
    expect(overlay()).not.toBeNull()
    act(() => {
      localStorage.removeItem(APP_LOCK_STATE_KEY)
      window.dispatchEvent(new StorageEvent('storage', { key: APP_LOCK_STATE_KEY, newValue: null }))
    })
    expect(overlay()).toBeNull()
    expect(getAssertionMock).not.toHaveBeenCalled()
  })

  it('a locked state persisted before this render locks the overlay on mount', () => {
    setAppLockEnabled(true)
    localStorage.setItem(APP_LOCK_STATE_KEY, JSON.stringify({ locked: true, at: Date.now() }))
    render(<AppLockOverlay />)
    expect(overlay()).not.toBeNull()
  })
})
