/**
 * AppLockPreferencesPanel (spec 041 amendment — FR-025's setting surface).
 *
 * The card exists only where a WebAuthn re-prompt is actually possible: a passkey session on a
 * device whose authenticator answers capability detection. Elsewhere it is hidden (no passkey
 * session — the lock could never open) or disabled with the detector's own honest reason —
 * never silently non-functional.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

let walletState
let capability

vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => walletState }))
vi.mock('../../lib/passkey/credentials', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, detectCapability: () => Promise.resolve(capability) }
})

import AppLockPreferencesPanel from '../../components/account/AppLockPreferencesPanel'
import { isAppLockEnabled, setAppLockEnabled, __resetAppLockForTests } from '../../lib/applock/appLock'

const ADDRESS = '0x' + '4'.repeat(40)

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  __resetAppLockForTests()
  walletState = { address: ADDRESS, isConnected: true, loginMethod: 'passkey', chainId: 137 }
  capability = { available: true, platformAuthenticator: true }
})

async function renderPanel() {
  let view
  await act(async () => {
    view = render(<AppLockPreferencesPanel />)
  })
  return view
}

describe('who is offered the setting (FR-025 / FR-004 posture)', () => {
  it('is hidden for a classic-wallet session — no WebAuthn re-prompt exists to open the lock', async () => {
    walletState = { ...walletState, loginMethod: 'injected' }
    await renderPanel()
    expect(screen.queryByText(/app lock/i)).toBeNull()
  })

  it('is hidden when no account is connected', async () => {
    walletState = { address: null, isConnected: false, loginMethod: null }
    await renderPanel()
    expect(screen.queryByText(/app lock/i)).toBeNull()
  })

  it('is disabled with the honest reason when the authenticator is unavailable', async () => {
    capability = { available: false, reason: 'This browser does not support passkeys.' }
    await renderPanel()
    expect(screen.getByText(/app lock/i)).toBeInTheDocument()
    const toggle = screen.getByRole('checkbox', { name: /app lock/i })
    expect(toggle).toBeDisabled()
    expect(screen.getByText(/does not support passkeys/i)).toBeInTheDocument()
  })
})

describe('the toggle', () => {
  it('defaults off and enables device-scoped on click', async () => {
    await renderPanel()
    const toggle = screen.getByRole('checkbox', { name: /app lock/i })
    expect(toggle).not.toBeChecked()
    expect(isAppLockEnabled()).toBe(false)
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(isAppLockEnabled()).toBe(true)
    expect(screen.getByRole('checkbox', { name: /app lock/i })).toBeChecked()
  })

  it('turns off again, and the summary tracks the state', async () => {
    setAppLockEnabled(true)
    await renderPanel()
    const toggle = screen.getByRole('checkbox', { name: /app lock/i })
    expect(toggle).toBeChecked()
    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(isAppLockEnabled()).toBe(false)
  })

  it('describes the behavior in lock language, never session-expiry language', async () => {
    await renderPanel()
    expect(screen.queryByText(/session (will )?expire/i)).toBeNull()
    expect(screen.getByText(/15 minutes/i)).toBeInTheDocument()
  })
})
