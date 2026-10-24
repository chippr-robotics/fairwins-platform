// Spec 111 — the Sigil path through the add-account sheet: pairing fields, validation before any
// request, the one-account-per-disk pick step with the disk's own budget, and save.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { axe } from 'vitest-axe'

const OWNER = '0x1111111111111111111111111111111111111111'
const SIGIL_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const TOKEN = 'ab'.repeat(32)

let walletCtx = { address: OWNER, chainId: 137 }
vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => walletCtx }))
const bookApi = { findByAddress: vi.fn(() => null), addContact: vi.fn(), updateContact: vi.fn() }
vi.mock('../../hooks/useAddressBook', () => ({ useAddressBook: () => bookApi }))
vi.mock('../../data/ledger/sources/hardwareWalletSource', () => ({
  captureHardwareAccountAdded: vi.fn(),
  captureHardwareAccountRemoved: vi.fn(),
}))

import { UIContext } from '../../contexts/UIContext'
import { connectGuidance } from '../../lib/hardware/connectCopy'
import { hardwareWalletVault } from '../../lib/hardware/hardwareAccounts'
import { loadSigilBridge } from '../../lib/hardware/sigilBridgeStore'
import { HardwareWalletError, HW_ERROR_CODES } from '../../lib/hardware/errors'
import AddHardwareWalletSheet from '../../components/custody/AddHardwareWalletSheet'

function sigilSession(detail = {}) {
  return {
    vendor: 'sigil',
    getAddress: vi.fn(async () => ({ address: SIGIL_ADDR })),
    getAddresses: vi.fn(),
    describeAccounts: vi.fn(async () => [
      {
        path: 'sigil:9e8d7c6b',
        address: SIGIL_ADDR,
        detail: { childId: '9e8d7c6b', presigsRemaining: 742, presigsTotal: 1000, daysUntilExpiry: 30, valid: true, ...detail },
      },
    ]),
    signPersonalMessage: vi.fn(),
    signTransaction: vi.fn(),
    close: vi.fn(async () => {}),
  }
}

function renderSheet({ session = sigilSession(), connect } = {}) {
  const deps = {
    connect: connect ?? vi.fn(async () => session),
    availability: () => ({ available: true, reason: null }),
    // The real copy, so these tests fail if the words stop being produced.
    guidance: connectGuidance,
    provider: { getBalance: vi.fn(async () => 0n) },
  }
  const utils = render(
    <UIContext.Provider value={{ showNotification: vi.fn() }}>
      <AddHardwareWalletSheet open onClose={vi.fn()} deps={deps} />
    </UIContext.Provider>,
  )
  return { ...utils, deps, session }
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  walletCtx = { address: OWNER, chainId: 137 }
})

describe('Add a Sigil account', () => {
  it('offers Sigil beside Ledger and Trezor', () => {
    renderSheet()
    expect(screen.getByTestId('hw-vendor-sigil')).toBeEnabled()
    expect(screen.getByTestId('hw-vendor-sigil')).toHaveTextContent('Sigil')
  })

  it('asks for the bridge address and pairing token, with the steps that make them exist', () => {
    renderSheet()
    fireEvent.click(screen.getByTestId('hw-vendor-sigil'))
    expect(screen.getByTestId('hw-sigil-url')).toHaveValue('http://127.0.0.1:7318')
    expect(screen.getByTestId('hw-sigil-token')).toHaveAttribute('type', 'password')
    expect(screen.getByText(/start sigil-daemon and sigil-bridge/i)).toBeInTheDocument()
  })

  it('refuses a non-loopback bridge before any request leaves the page', async () => {
    const { deps } = renderSheet()
    fireEvent.click(screen.getByTestId('hw-vendor-sigil'))
    fireEvent.change(screen.getByTestId('hw-sigil-url'), { target: { value: 'http://10.0.0.5:7318' } })
    fireEvent.change(screen.getByTestId('hw-sigil-token'), { target: { value: TOKEN } })
    fireEvent.click(screen.getByTestId('hw-connect'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/this computer/)
    expect(deps.connect).not.toHaveBeenCalled()
    expect(loadSigilBridge()).toBeNull()
  })

  it('refuses a malformed token before any request leaves the page', async () => {
    const { deps } = renderSheet()
    fireEvent.click(screen.getByTestId('hw-vendor-sigil'))
    fireEvent.change(screen.getByTestId('hw-sigil-token'), { target: { value: 'not-a-token' } })
    fireEvent.click(screen.getByTestId('hw-connect'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/token file/)
    expect(deps.connect).not.toHaveBeenCalled()
  })

  it('pairs, shows the one disk account with its budget, and saves public metadata only', async () => {
    const { deps } = renderSheet()
    fireEvent.click(screen.getByTestId('hw-vendor-sigil'))
    fireEvent.change(screen.getByTestId('hw-sigil-token'), { target: { value: TOKEN } })
    fireEvent.click(screen.getByTestId('hw-connect'))
    await screen.findByTestId('hw-step-pick')

    expect(deps.connect).toHaveBeenCalledWith('sigil', { sigilBridge: { url: 'http://127.0.0.1:7318', token: TOKEN } })
    expect(loadSigilBridge()).toEqual({ url: 'http://127.0.0.1:7318', token: TOKEN })
    expect(screen.getByTestId('hw-sigil-budget')).toHaveTextContent('742 of 1000 signatures left · disk expires in 30 days')
    // One account per disk: nothing to page, no derivation scheme to switch.
    expect(screen.queryByTestId('hw-load-more')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Derivation scheme' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByTestId('hw-save'))
    await screen.findByTestId('hw-step-saved')
    expect(screen.getByText(/unless its Sigil disk is in the drive/)).toBeInTheDocument()

    const saved = hardwareWalletVault(OWNER).list()
    expect(saved).toHaveLength(1)
    expect(Object.keys(saved[0]).sort()).toEqual(['addedAt', 'address', 'label', 'path', 'vendor'])
    expect(saved[0]).toMatchObject({ address: SIGIL_ADDR, vendor: 'sigil', path: 'sigil:9e8d7c6b' })
    // The pairing token never enters the account store.
    expect(JSON.stringify(localStorage.getItem(`fw_user_${OWNER.toLowerCase()}_hardware_accounts`) ?? '')).not.toContain(TOKEN)
  })

  it('warns when the disk is nearly out of signatures', async () => {
    renderSheet({ session: sigilSession({ presigsRemaining: 3 }) })
    fireEvent.click(screen.getByTestId('hw-vendor-sigil'))
    fireEvent.change(screen.getByTestId('hw-sigil-token'), { target: { value: TOKEN } })
    fireEvent.click(screen.getByTestId('hw-connect'))
    expect(await screen.findByTestId('hw-sigil-low')).toHaveTextContent(/nearly out of signatures/)
  })

  it('renders a connect failure as its own sentence (no disk)', async () => {
    renderSheet({ connect: vi.fn(async () => { throw new HardwareWalletError(HW_ERROR_CODES.SIGIL_NO_DISK) }) })
    fireEvent.click(screen.getByTestId('hw-vendor-sigil'))
    fireEvent.change(screen.getByTestId('hw-sigil-token'), { target: { value: TOKEN } })
    fireEvent.click(screen.getByTestId('hw-connect'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/No Sigil disk is inserted/)
  })

  it('reuses a pairing already saved on this device when the token field is left blank', async () => {
    localStorage.setItem('fw_global_prefs', JSON.stringify({ sigil_bridge: { url: 'http://localhost:7318', token: TOKEN } }))
    const { deps } = renderSheet()
    fireEvent.click(screen.getByTestId('hw-vendor-sigil'))
    expect(screen.getByTestId('hw-sigil-url')).toHaveValue('http://localhost:7318')
    fireEvent.click(screen.getByTestId('hw-connect'))
    await screen.findByTestId('hw-step-pick')
    expect(deps.connect).toHaveBeenCalledWith('sigil', { sigilBridge: { url: 'http://localhost:7318', token: TOKEN } })
  })

  it('the pairing step has no accessibility violations', async () => {
    const { container } = renderSheet()
    fireEvent.click(screen.getByTestId('hw-vendor-sigil'))
    expect(await axe(container)).toHaveNoViolations()
  })
})
