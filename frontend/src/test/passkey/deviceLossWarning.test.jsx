/**
 * Spec 041 FR-021 / issue #1405 — the device-loss warning itself.
 *
 * FR-021 is a promise about WHO is warned, not just about copy existing: a member with a second
 * controller must not be nagged, a member with one must be told, and telling the app once must
 * stick. These drive the real component against a real (in-memory) storage and a stubbed
 * controller read, so every gate in it can fail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

const wallet = {
  address: '0x00000000000000000000000000000000000A11CE',
  chainId: 80002,
  loginMethod: 'passkey',
  isConnected: true,
  provider: null,
}
vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => wallet }))

const { default: DeviceLossWarning } = await import('../../components/wallet/DeviceLossWarning')
const { dismissedAt } = await import('../../lib/passkey/accountProfile')

/** A localStorage-shaped object the test can read back — no globals, no leakage between cases. */
function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

function controllers(n) {
  return Array.from({ length: n }, (_, i) => ({
    index: BigInt(i),
    ownerBytes: `0x${String(i).repeat(128)}`,
    kind: 'passkey',
    address: null,
  }))
}

/**
 * `deps` is passed straight through to usePasskeyAccount, so the controller read and the storage
 * are both injectable. `knownCredentials` is stubbed to keep the hook off the real localStorage.
 */
function renderWarning({ count = 1, deployed = true, storage = memoryStorage(), moment = 'creation', onAddController = vi.fn() } = {}) {
  const deps = {
    storage,
    knownCredentials: () => [],
    encryptionCapability: () => ({ state: 'available' }),
    readControllers: async () => ({ deployed, controllers: controllers(count) }),
  }
  const utils = render(<DeviceLossWarning moment={moment} onAddController={onAddController} deps={deps} />)
  return { ...utils, storage, onAddController, deps }
}

/**
 * Let the controller read resolve inside React's act() scope.
 *
 * Every absence assertion below is paired with a presence assertion that uses the SAME settle(),
 * so "nothing rendered" can never be "the effect had not run yet".
 */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

beforeEach(() => {
  wallet.loginMethod = 'passkey'
  wallet.isConnected = true
})

describe('DeviceLossWarning — who gets warned (FR-021)', () => {
  it('warns an account guarded by ONE controller, and names both ways out', async () => {
    renderWarning({ count: 1 })
    const alert = await screen.findByTestId('device-loss-warning-creation')
    expect(alert).toHaveAttribute('role', 'alert')
    expect(alert).toHaveTextContent(/one passkey guards this account/i)
    // "offered to add a second passkey or recovery wallet" is the half of FR-021 that makes it a
    // warning rather than an alarm.
    expect(screen.getByRole('button', { name: /add a backup now/i })).toBeEnabled()
  })

  it('says nothing to an account that already has two controllers', async () => {
    // Paired: the one-controller account under the same settle() DOES warn, so the absence below
    // is a fact about the controller count and not about timing.
    const one = renderWarning({ count: 1 })
    await settle()
    expect(screen.getByTestId('device-loss-warning-creation')).toBeInTheDocument()
    one.unmount()

    renderWarning({ count: 2 })
    await settle()
    expect(screen.queryByTestId('device-loss-warning-creation')).toBeNull()
  })

  it('says nothing on a classic wallet session — this is a passkey-custody risk', async () => {
    wallet.loginMethod = 'wallet'
    renderWarning({ count: 1 })
    await settle()
    expect(screen.queryByTestId('device-loss-warning-creation')).toBeNull()
  })

  it('still warns a counterfactual (not yet deployed) account — its one credential is the risk', async () => {
    renderWarning({ count: 0, deployed: false })
    expect(await screen.findByTestId('device-loss-warning-creation')).toBeInTheDocument()
  })

  it('renders NOTHING while the controller read is still outstanding', () => {
    // An unread controller set is not "one controller". Before the effect resolves, `controllers`
    // is [] for every account — a two-key member would otherwise see this flash.
    renderWarning({ count: 2 })
    expect(screen.queryByTestId('device-loss-warning-creation')).toBeNull()
  })

  it('routes "Add a backup now" to whatever the mounting surface passed', async () => {
    const onAddController = vi.fn()
    renderWarning({ count: 1, onAddController })
    fireEvent.click(await screen.findByRole('button', { name: /add a backup now/i }))
    expect(onAddController).toHaveBeenCalledTimes(1)
  })
})

describe('DeviceLossWarning — dismissal is per account, per moment, and it sticks', () => {
  it('records the dismissal against the account and hides the warning', async () => {
    const { storage } = renderWarning({ count: 1, moment: 'first-funding' })
    await screen.findByTestId('device-loss-warning-first-funding')
    fireEvent.click(screen.getByRole('button', { name: /i understand the risk/i }))
    expect(screen.queryByTestId('device-loss-warning-first-funding')).toBeNull()
    expect(dismissedAt(wallet.address, 'first-funding', storage)).toBe(true)
  })

  it('stays dismissed on the next mount — the moment does not come back on every visit', async () => {
    const storage = memoryStorage()
    const first = renderWarning({ count: 1, moment: 'first-funding', storage })
    fireEvent.click(await screen.findByRole('button', { name: /i understand the risk/i }))
    first.unmount()

    renderWarning({ count: 1, moment: 'first-funding', storage })
    // Settled, and still silent. (Before #1405 the stored dismissal was read once in a lazy
    // initializer — while the address was still null — so it never took.)
    await settle()
    expect(screen.queryByTestId('device-loss-warning-first-funding')).toBeNull()
  })

  it('dismissing one moment leaves the other two armed', async () => {
    const storage = memoryStorage()
    const first = renderWarning({ count: 1, moment: 'creation', storage })
    fireEvent.click(await screen.findByRole('button', { name: /i understand the risk/i }))
    first.unmount()

    renderWarning({ count: 1, moment: 'membership-purchase', storage })
    expect(await screen.findByTestId('device-loss-warning-membership-purchase')).toBeInTheDocument()
  })
})
