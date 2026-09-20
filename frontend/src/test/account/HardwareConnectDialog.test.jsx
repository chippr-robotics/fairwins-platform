// Spec 085 — the reconnect-to-act dialog. On success the device-backed signer is handed to the
// caller (who passes it to operateAsHardware); a wrong device or any transport failure renders
// the typed human sentence, never a raw SDK error (FR-012).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { connectGuidance } from '../../lib/hardware/connectCopy'
import { HardwareWalletError, HW_ERROR_CODES } from '../../lib/hardware/errors'
import HardwareConnectDialog from '../../components/account/HardwareConnectDialog'

const ENTRY = {
  address: '0xAAA0000000000000000000000000000000000001',
  vendor: 'ledger',
  path: "m/44'/60'/0'/0/0",
  label: 'Cold',
}

const renderDialog = (deps, onConnected = vi.fn(), onClose = vi.fn()) => {
  render(
    <HardwareConnectDialog open entry={ENTRY} onClose={onClose} onConnected={onConnected} deps={deps} />,
  )
  return { onConnected, onClose }
}

beforeEach(() => vi.clearAllMocks())

describe('HardwareConnectDialog', () => {
  it('explains the ceremony and connects on demand', async () => {
    const signer = { fake: true }
    const connectAccount = vi.fn(async () => signer)
    const { onConnected } = renderDialog({ connectAccount })

    expect(screen.getByText(/confirmed on your ledger screen/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(signer))
    expect(connectAccount).toHaveBeenCalledWith(expect.objectContaining({ entry: ENTRY }))
  })

  it('renders a wrong-device refusal as its human sentence (FR-012)', async () => {
    const connectAccount = vi.fn(async () => {
      throw new HardwareWalletError(
        HW_ERROR_CODES.UNKNOWN,
        'The connected device does not hold this account — it derives a different address for the saved path. Check that it is the same device (and passphrase, if you use one).',
      )
    })
    const { onConnected } = renderDialog({ connectAccount })
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not hold this account/i)
    expect(onConnected).not.toHaveBeenCalled()
  })

  // Spec 085 follow-up — the reconnect hint follows the rail the adapter would open. Telling a
  // phone member to plug in a Ledger they are about to pair over Bluetooth is simply untrue.
  it('describes Bluetooth pairing, not a cable, when BLE is the rail', () => {
    renderDialog({
      connectAccount: vi.fn(),
      guidance: (vendor) => connectGuidance(vendor, { webhid: false, webusb: true, webble: true }),
    })
    const hint = screen.getByText(/bluetooth pairing prompt/i)
    expect(hint).toBeInTheDocument()
    expect(hint.textContent).not.toMatch(/plug/i)
  })

  it('keeps the cable wording on a USB rail', () => {
    renderDialog({
      connectAccount: vi.fn(),
      guidance: (vendor) => connectGuidance(vendor, { webhid: true, webusb: true, webble: false }),
    })
    expect(screen.getByText(/plug in the device, unlock it, and open the ethereum app/i)).toBeInTheDocument()
  })

  it('never leaks a raw SDK error message', async () => {
    const connectAccount = vi.fn(async () => {
      throw new Error('TransportStatusError: 0x6511 UNKNOWN_APDU')
    })
    renderDialog({ connectAccount })
    fireEvent.click(screen.getByRole('button', { name: /^connect$/i }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/something went wrong talking to the device/i)
    expect(alert.textContent).not.toMatch(/0x6511|APDU/)
  })
})
