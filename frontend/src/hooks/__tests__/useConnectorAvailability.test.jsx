/**
 * Spec 045 T008 — shared connector availability probe (FR-003): injected
 * detection, walletConnect always-on, passkey gated on device capability AND
 * network config. Every connect surface consumes THIS hook so availability
 * states can never diverge between entry points again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

import { useConnect } from 'wagmi'

const { detectCapability, getPasskeySupport } = vi.hoisted(() => ({
  detectCapability: vi.fn(),
  getPasskeySupport: vi.fn(),
}))
vi.mock('../../lib/passkey/credentials', () => ({ detectCapability }))
// The hook gates on the JOINED support check (bundler configured AND account stack deployed),
// not on `capabilities.passkeyAccounts` alone — a bundler URL with no factory would render a
// login button that fails at account creation (spec 041 FR-004).
vi.mock('../../config/passkeySupport', () => ({ getPasskeySupport }))

import { setWalletChain } from '../../test/helpers/walletChain'
import { useConnectorAvailability } from '../useConnectorAvailability'

const CONNECTORS = [
  { id: 'injected', name: 'Injected', type: 'injected' },
  { id: 'walletConnect', name: 'WalletConnect', type: 'walletConnect' },
  { id: 'fairwinsPasskey', name: 'Passkey', type: 'passkey' },
]

beforeEach(() => {
  vi.clearAllMocks()
  useConnect.mockReturnValue({ connect: vi.fn(), connectors: CONNECTORS })
  setWalletChain(137)
  detectCapability.mockResolvedValue({ available: true, platformAuthenticator: true })
  getPasskeySupport.mockReturnValue({ supported: true, reason: null })
})

describe('useConnectorAvailability', () => {
  it('marks walletConnect always available and passkey available when device + network allow', async () => {
    const { result } = renderHook(() => useConnectorAvailability())
    await waitFor(() => expect(result.current.isChecking).toBe(false))
    expect(result.current.isAvailable(CONNECTORS[1])).toBe(true)
    expect(result.current.isAvailable(CONNECTORS[2])).toBe(true)
  })

  it('reports an honest reason when the device cannot do passkeys (FR-003)', async () => {
    detectCapability.mockResolvedValue({ available: false, reason: 'This browser does not support passkeys.' })
    const { result } = renderHook(() => useConnectorAvailability())
    await waitFor(() => expect(result.current.isChecking).toBe(false))
    expect(result.current.isAvailable(CONNECTORS[2])).toBe(false)
    expect(result.current.unavailableReason(CONNECTORS[2])).toMatch(/does not support/i)
  })

  it('keeps passkey available even when the network cannot carry a transaction (the lockout fix)', async () => {
    // Availability here means "can this member SIGN IN", which is device-scoped. Gating it on the
    // network locked members out: the selected chain persists, so an unsupported chain hid the
    // only way back in. Asserting availability stays TRUE while getPasskeySupport reports
    // unsupported proves the hook does not consult it — the exact regression to prevent.
    getPasskeySupport.mockReturnValue({ supported: false, reason: 'Not available on this network' })
    const { result } = renderHook(() => useConnectorAvailability())
    await waitFor(() => expect(result.current.isChecking).toBe(false))
    expect(result.current.isAvailable(CONNECTORS[2])).toBe(true)
    expect(result.current.unavailableReason(CONNECTORS[2])).toBeUndefined()
  })

  it('never consults the network support gate at all (sign-in is chain-independent)', async () => {
    // getPasskeySupport remains the right gate for the Network tab and for explaining why a
    // TRANSACTION cannot be sent. It must simply play no part in whether a member may log in.
    getPasskeySupport.mockClear()
    const { result } = renderHook(() => useConnectorAvailability())
    await waitFor(() => expect(result.current.isChecking).toBe(false))
    expect(result.current.isAvailable(CONNECTORS[2])).toBe(true)
    expect(getPasskeySupport).not.toHaveBeenCalled()
  })

  it('does not re-probe when the connectors array identity changes but content does not', async () => {
    const { result, rerender } = renderHook(() => useConnectorAvailability())
    await waitFor(() => expect(result.current.isChecking).toBe(false))
    const calls = detectCapability.mock.calls.length
    useConnect.mockReturnValue({ connect: vi.fn(), connectors: [...CONNECTORS] }) // fresh array
    rerender()
    await waitFor(() => expect(result.current.isChecking).toBe(false))
    expect(detectCapability.mock.calls.length).toBe(calls)
  })
})
