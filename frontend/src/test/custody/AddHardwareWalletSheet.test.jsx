// Spec 085 — the guided add-a-hardware-wallet wizard, driven end to end with a mock adapter
// session (FR-013: every flow is testable without hardware). Covers vendor availability gating
// (FR-003), the honest connect failure states (FR-012), scheme switching + paging (FR-004),
// and save: store + address book + audit + toast (FR-005/006/007/011).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { axe } from 'vitest-axe'

const OWNER = '0x1111111111111111111111111111111111111111'
const ADDRS = [
  '0xAAA0000000000000000000000000000000000001',
  '0xAAA0000000000000000000000000000000000002',
  '0xAAA0000000000000000000000000000000000003',
  '0xAAA0000000000000000000000000000000000004',
  '0xAAA0000000000000000000000000000000000005',
  '0xBBB0000000000000000000000000000000000006',
]

let walletCtx = { address: OWNER, chainId: 137 }
vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => walletCtx }))

const bookApi = {
  findByAddress: vi.fn(() => null),
  addContact: vi.fn(),
  updateContact: vi.fn(),
}
vi.mock('../../hooks/useAddressBook', () => ({ useAddressBook: () => bookApi }))

vi.mock('../../data/ledger/sources/hardwareWalletSource', () => ({
  captureHardwareAccountAdded: vi.fn(),
  captureHardwareAccountRemoved: vi.fn(),
}))

import { UIContext } from '../../contexts/UIContext'
import { HardwareWalletError, HW_ERROR_CODES } from '../../lib/hardware/errors'
import { vendorAvailability } from '../../lib/hardware/adapters'
import { connectGuidance } from '../../lib/hardware/connectCopy'
import { hardwareWalletVault } from '../../lib/hardware/hardwareAccounts'
import { captureHardwareAccountAdded } from '../../data/ledger/sources/hardwareWalletSource'
import AddHardwareWalletSheet from '../../components/custody/AddHardwareWalletSheet'

const showNotification = vi.fn()

/** A well-behaved fake device session, addresses per requested path index. */
function makeSession() {
  return {
    vendor: 'ledger',
    getAddress: vi.fn(async () => ({ address: ADDRS[0] })),
    getAddresses: vi.fn(async (paths) =>
      paths.map((path, i) => ({ path, address: ADDRS[(i + (makeSession.offset || 0)) % ADDRS.length] })),
    ),
    signPersonalMessage: vi.fn(),
    signTransaction: vi.fn(),
    close: vi.fn(async () => {}),
  }
}

const provider = { getBalance: vi.fn(async () => 1500000000000000000n) } // 1.5 native

function renderSheet(overrides = {}) {
  const session = overrides.session ?? makeSession()
  const deps = {
    connect: vi.fn(async () => session),
    availability: () => ({ available: true, reason: null }),
    provider,
    ...overrides.deps,
  }
  const onClose = vi.fn()
  const utils = render(
    <UIContext.Provider value={{ showNotification }}>
      <AddHardwareWalletSheet open onClose={onClose} deps={deps} />
    </UIContext.Provider>,
  )
  return { ...utils, session, deps, onClose }
}

/** Drive vendor → connect → pick with default mocks. */
async function reachPickStep(opts) {
  const ctx = renderSheet(opts)
  fireEvent.click(screen.getByTestId('hw-vendor-ledger'))
  fireEvent.click(screen.getByTestId('hw-connect'))
  await waitFor(() => expect(screen.getByTestId('hw-step-pick')).toBeInTheDocument())
  return ctx
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  walletCtx = { address: OWNER, chainId: 137 }
  bookApi.findByAddress.mockReturnValue(null)
})

describe('AddHardwareWalletSheet', () => {
  it('starts on the vendor step and shows both vendors', () => {
    renderSheet()
    expect(screen.getByTestId('hw-step-vendor')).toBeInTheDocument()
    expect(screen.getByTestId('hw-vendor-ledger')).toBeEnabled()
    expect(screen.getByTestId('hw-vendor-trezor')).toBeEnabled()
  })

  it('disables an unavailable vendor and shows the reason, never a dead control (FR-003)', () => {
    renderSheet({
      deps: {
        availability: (v) =>
          v === 'ledger'
            ? // the real refusal sentence, so this cannot pass on copy the app no longer produces
              vendorAvailability('ledger', { webhid: false, webusb: false, webble: false })
            : { available: true, reason: null, transport: null },
      },
    })
    expect(screen.getByTestId('hw-vendor-ledger')).toBeDisabled()
    expect(screen.getByText(/cannot reach the device over USB or Bluetooth/i)).toBeInTheDocument()
  })

  it('renders a connect failure as the typed human sentence (FR-012)', async () => {
    renderSheet({
      deps: {
        connect: vi.fn(async () => {
          throw new HardwareWalletError(HW_ERROR_CODES.DEVICE_LOCKED)
        }),
      },
    })
    fireEvent.click(screen.getByTestId('hw-vendor-ledger'))
    fireEvent.click(screen.getByTestId('hw-connect'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/device is locked/i)
    // Still on the connect step — the member can retry after unlocking.
    expect(screen.getByTestId('hw-step-connect')).toBeInTheDocument()
  })

  it('lists derived accounts with balances after connecting (FR-004)', async () => {
    const { session } = await reachPickStep()
    // Ledger default scheme is Ledger Live: hardened account index.
    expect(session.getAddresses).toHaveBeenCalledWith([
      "m/44'/60'/0'/0/0",
      "m/44'/60'/1'/0/0",
      "m/44'/60'/2'/0/0",
      "m/44'/60'/3'/0/0",
      "m/44'/60'/4'/0/0",
    ])
    expect(screen.getAllByRole('checkbox')).toHaveLength(5)
    expect(screen.getAllByText('1.5 POL').length).toBeGreaterThan(0)
  })

  it('switches derivation scheme and reloads from the device (FR-004)', async () => {
    const { session } = await reachPickStep()
    fireEvent.click(screen.getByRole('radio', { name: /BIP-44 standard/i }))
    await waitFor(() =>
      expect(session.getAddresses).toHaveBeenLastCalledWith([
        "m/44'/60'/0'/0/0",
        "m/44'/60'/0'/0/1",
        "m/44'/60'/0'/0/2",
        "m/44'/60'/0'/0/3",
        "m/44'/60'/0'/0/4",
      ]),
    )
  })

  it('pages further accounts with "Show more" (FR-004)', async () => {
    const { session } = await reachPickStep()
    fireEvent.click(screen.getByTestId('hw-load-more'))
    await waitFor(() => expect(session.getAddresses).toHaveBeenCalledTimes(2))
    expect(session.getAddresses.mock.calls[1][0][0]).toBe("m/44'/60'/5'/0/0")
  })

  it('saves selected accounts: store + address book + audit + toast, then the saved step', async () => {
    await reachPickStep()
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    fireEvent.change(screen.getByLabelText(/label/i), { target: { value: 'Cold storage' } })
    fireEvent.click(screen.getByTestId('hw-save'))

    await waitFor(() => expect(screen.getByTestId('hw-step-saved')).toBeInTheDocument())
    const saved = hardwareWalletVault(OWNER).list()
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ address: ADDRS[0], vendor: 'ledger', path: "m/44'/60'/0'/0/0", label: 'Cold storage' })
    expect(bookApi.addContact).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: 'Cold storage' }),
    )
    expect(captureHardwareAccountAdded).toHaveBeenCalledWith(OWNER, 137, {
      address: ADDRS[0],
      vendor: 'ledger',
      path: "m/44'/60'/0'/0/0",
    })
    expect(showNotification).toHaveBeenCalledWith(expect.stringMatching(/saved/i), 'success')
  })

  it('marks already-saved addresses in the picker (FR-011)', async () => {
    hardwareWalletVault(OWNER).add({ address: ADDRS[0], vendor: 'ledger', path: "m/44'/60'/0'/0/0" })
    await reachPickStep()
    expect(screen.getByText('Saved')).toBeInTheDocument()
  })

  it('withholds save until something is selected (no dead submit)', async () => {
    await reachPickStep()
    expect(screen.getByTestId('hw-save')).toBeDisabled()
  })

  it('releases the device session when the sheet is closed mid-flow', async () => {
    const { session } = await reachPickStep()
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(session.close).toHaveBeenCalled())
  })

  it('has no axe violations on the picker step', async () => {
    const { container } = await reachPickStep()
    expect(await axe(container)).toHaveNoViolations()
  })
})

// Spec 085 follow-up — the connect ceremony is described from the transport the adapter would
// actually open. "Plug the device into this computer" is false on a phone pairing over Bluetooth,
// and a member who follows it concludes the feature is broken.
describe('AddHardwareWalletSheet transport-aware copy', () => {
  const guidanceFor = (transports) => (vendor) => connectGuidance(vendor, transports)
  const DESKTOP = { webhid: true, webusb: true, webble: false }
  const PHONE = { webhid: false, webusb: true, webble: true }
  const NEITHER = { webhid: false, webusb: false, webble: false }

  it('says plug in over a USB rail', () => {
    renderSheet({ deps: { guidance: guidanceFor(DESKTOP) } })
    expect(screen.getByTestId('hw-vendor-ledger')).toHaveTextContent(/connect over usb/i)
    fireEvent.click(screen.getByTestId('hw-vendor-ledger'))
    expect(screen.getByTestId('hw-step-connect')).toHaveTextContent(/plug the device/i)
  })

  it('describes Bluetooth pairing — and never "plug in" — when BLE is the rail', () => {
    renderSheet({ deps: { guidance: guidanceFor(PHONE) } })
    expect(screen.getByTestId('hw-vendor-ledger')).toHaveTextContent(/pair over bluetooth/i)
    fireEvent.click(screen.getByTestId('hw-vendor-ledger'))
    const step = screen.getByTestId('hw-step-connect')
    expect(step).toHaveTextContent(/bluetooth pairing prompt/i)
    expect(step).toHaveTextContent(/ethereum/i)
    expect(step.textContent).not.toMatch(/plug/i)
  })

  it('leaves the Trezor ceremony exactly as it was on that same phone', () => {
    renderSheet({ deps: { guidance: guidanceFor(PHONE) } })
    fireEvent.click(screen.getByTestId('hw-vendor-trezor'))
    const step = screen.getByTestId('hw-step-connect')
    expect(step).toHaveTextContent(/approve the connection in the trezor window/i)
    expect(step.textContent).not.toMatch(/bluetooth/i)
  })

  it('states the reason instead of a checklist when the browser has no rail (FR-003)', () => {
    renderSheet({
      deps: {
        guidance: guidanceFor(NEITHER),
        availability: (v) =>
          v === 'ledger'
            ? { available: false, reason: connectGuidance('ledger', NEITHER).optionHint, transport: null }
            : { available: true, reason: null, transport: null },
      },
    })
    const option = screen.getByTestId('hw-vendor-ledger')
    expect(option).toBeDisabled()
    expect(option).toHaveTextContent(/usb or bluetooth/i)
  })
})
