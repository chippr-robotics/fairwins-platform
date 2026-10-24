// Spec 085 follow-up — Ledger over Bluetooth on mobile.
//
// The transport is chosen INSIDE the adapter seam from what the browser actually offers, and the
// member-facing copy is derived from the transport that was chosen — never assumed. These tests
// pin the capability matrix (desktop keeps WebHID exactly as it was; a phone with no WebHID but
// Web Bluetooth gets BLE; a browser with neither says so), the BLE-specific failures (pairing
// cancelled, radio off, disconnect mid-session), and that Trezor is untouched by any of it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const webhidCreate = vi.fn()
const webusbCreate = vi.fn()
const webbleCreate = vi.fn()

vi.mock('@ledgerhq/hw-transport-webhid', () => ({ default: { create: webhidCreate } }))
vi.mock('@ledgerhq/hw-transport-webusb', () => ({ default: { create: webusbCreate } }))
vi.mock('@ledgerhq/hw-transport-web-ble', () => ({ default: { create: webbleCreate } }))

const ethGetAddress = vi.fn(async () => ({ address: '0xAAA0000000000000000000000000000000000001' }))
class FakeEth {
  constructor(transport) {
    this.transport = transport
  }
  getAddress(...args) {
    return ethGetAddress(...args)
  }
}
vi.mock('@ledgerhq/hw-app-eth', () => ({ default: FakeEth }))
vi.mock('../../lib/hardware/nodeShims', () => ({ ensureNodeGlobals: vi.fn(async () => {}) }))

import {
  detectTransports,
  ledgerTransportKind,
  vendorAvailability,
  connectHardware,
  TRANSPORT_KINDS,
} from '../../lib/hardware/adapters'
import { connectGuidance } from '../../lib/hardware/connectCopy'
import { connectLedger, classifyLedgerError } from '../../lib/hardware/ledgerAdapter'
import { HW_ERROR_CODES, HardwareWalletError } from '../../lib/hardware/errors'

/** Install a fake capability set on the real navigator; removed again in afterEach. */
const planted = []
function plantNavigator({ hid = false, usb = false, bluetooth = null }) {
  const set = (key, value) => {
    Object.defineProperty(navigator, key, { value, configurable: true })
    planted.push(key)
  }
  if (hid) set('hid', {})
  if (usb) set('usb', {})
  if (bluetooth) set('bluetooth', bluetooth)
}
const bluetoothRadio = (available = true) => ({ getAvailability: vi.fn(async () => available) })

const fakeTransport = () => ({ close: vi.fn(async () => {}) })

beforeEach(() => {
  vi.clearAllMocks()
  webhidCreate.mockResolvedValue(fakeTransport())
  webusbCreate.mockResolvedValue(fakeTransport())
  webbleCreate.mockResolvedValue(fakeTransport())
})

afterEach(() => {
  for (const key of planted.splice(0)) delete navigator[key]
})

describe('transport capability detection', () => {
  it('reports Web Bluetooth alongside WebHID/WebUSB', () => {
    plantNavigator({ hid: true, usb: true, bluetooth: bluetoothRadio() })
    expect(detectTransports()).toEqual({ webhid: true, webusb: true, webble: true })
  })

  it('reads nothing as nothing (iOS Safari has neither rail)', () => {
    expect(detectTransports({})).toEqual({ webhid: false, webusb: false, webble: false })
  })

  it('keeps WebHID on a desktop that also exposes Bluetooth (today’s transport, unchanged)', () => {
    expect(
      ledgerTransportKind({ webhid: true, webusb: true, webble: true }),
    ).toBe(TRANSPORT_KINDS.WEBHID)
  })

  it('chooses Bluetooth where WebHID is absent but Web Bluetooth is present (Android Chrome)', () => {
    // Android Chrome also exposes WebUSB, which needs an OTG cable and is not what a phone member
    // means by "connect my Ledger" — BLE is the rail that works there.
    expect(ledgerTransportKind({ webhid: false, webusb: true, webble: true })).toBe(TRANSPORT_KINDS.WEBBLE)
  })

  it('still falls back to WebUSB when that is the only rail', () => {
    expect(ledgerTransportKind({ webhid: false, webusb: true, webble: false })).toBe(TRANSPORT_KINDS.WEBUSB)
  })

  it('resolves to no transport when the browser offers neither rail', () => {
    expect(ledgerTransportKind({ webhid: false, webusb: false, webble: false })).toBeNull()
  })
})

describe('vendorAvailability', () => {
  it('reports Ledger available over Bluetooth on a phone, naming the transport', () => {
    const a = vendorAvailability('ledger', { webhid: false, webusb: true, webble: true })
    expect(a).toMatchObject({ available: true, reason: null, transport: TRANSPORT_KINDS.WEBBLE })
  })

  it('refuses honestly when neither rail exists, naming USB and Bluetooth (FR-003)', () => {
    const a = vendorAvailability('ledger', { webhid: false, webusb: false, webble: false })
    expect(a.available).toBe(false)
    expect(a.transport).toBeNull()
    expect(a.reason).toMatch(/USB/i)
    expect(a.reason).toMatch(/bluetooth/i)
  })

  it('leaves Trezor exactly as it was — no Bluetooth claim for a vendor that has none', () => {
    const a = vendorAvailability('trezor', { webhid: false, webusb: false, webble: true })
    expect(a).toMatchObject({ available: true, reason: null, transport: null })
  })
})

describe('connectHardware transport gating', () => {
  it('throws the typed transport failure when no rail exists, with copy naming both', async () => {
    const err = await connectHardware('ledger').catch((e) => e)
    expect(err).toBeInstanceOf(HardwareWalletError)
    expect(err.code).toBe(HW_ERROR_CODES.TRANSPORT_UNSUPPORTED)
    expect(err.message).toMatch(/bluetooth/i)
  })
})

describe('the Ledger adapter opens the transport the browser can actually use', () => {
  it('uses WebHID when it exists', async () => {
    plantNavigator({ hid: true, usb: true, bluetooth: bluetoothRadio() })
    await connectLedger()
    expect(webhidCreate).toHaveBeenCalledTimes(1)
    expect(webbleCreate).not.toHaveBeenCalled()
  })

  it('uses Bluetooth on a phone (no WebHID), never WebUSB', async () => {
    plantNavigator({ usb: true, bluetooth: bluetoothRadio() })
    const session = await connectLedger()
    expect(webbleCreate).toHaveBeenCalledTimes(1)
    expect(webusbCreate).not.toHaveBeenCalled()
    expect(session.vendor).toBe('ledger')
    expect(session.transport).toBe(TRANSPORT_KINDS.WEBBLE)
  })

  it('refuses with a stated reason when the Bluetooth radio is off, before any pairing prompt', async () => {
    plantNavigator({ bluetooth: bluetoothRadio(false) })
    const err = await connectLedger().catch((e) => e)
    expect(err).toBeInstanceOf(HardwareWalletError)
    expect(err.code).toBe(HW_ERROR_CODES.BLUETOOTH_UNAVAILABLE)
    expect(err.message).toMatch(/bluetooth/i)
    expect(webbleCreate).not.toHaveBeenCalled()
  })

  it('normalizes a cancelled pairing prompt to the permission failure, not "unknown"', async () => {
    plantNavigator({ bluetooth: bluetoothRadio() })
    const cancelled = new Error('User cancelled the requestDevice() chooser.')
    cancelled.name = 'TransportOpenUserCancelled'
    webbleCreate.mockRejectedValueOnce(cancelled)
    const err = await connectLedger().catch((e) => e)
    expect(err.code).toBe(HW_ERROR_CODES.PERMISSION_DENIED)
  })

  it('normalizes a dismissed browser chooser (raw DOMException) the same way', () => {
    const dom = new Error('User cancelled the requestDevice() chooser.')
    dom.name = 'NotFoundError'
    expect(classifyLedgerError(dom)).toBe(HW_ERROR_CODES.PERMISSION_DENIED)
  })

  it('classifies a BLE link dropping mid-session as the existing disconnect path', () => {
    const gone = new Error('GATT Server is disconnected.')
    gone.name = 'NetworkError'
    expect(classifyLedgerError(gone)).toBe(HW_ERROR_CODES.DISCONNECTED)
    const ledgerGone = new Error('device disconnected')
    ledgerGone.name = 'DisconnectedDeviceDuringOperation'
    expect(classifyLedgerError(ledgerGone)).toBe(HW_ERROR_CODES.DISCONNECTED)
  })

  it('surfaces a BLE disconnect during a derive as the disconnect sentence', async () => {
    plantNavigator({ bluetooth: bluetoothRadio() })
    const session = await connectLedger()
    const gone = new Error('GATT Server is disconnected.')
    gone.name = 'NetworkError'
    ethGetAddress.mockRejectedValueOnce(gone)
    const err = await session.getAddress("m/44'/60'/0'/0/0").catch((e) => e)
    expect(err.code).toBe(HW_ERROR_CODES.DISCONNECTED)
  })
})

describe('connect copy follows the transport that was chosen', () => {
  it('says plug in on a USB rail', () => {
    const g = connectGuidance('ledger', { webhid: true, webusb: true, webble: false })
    expect(g.transport).toBe(TRANSPORT_KINDS.WEBHID)
    expect(g.steps.join(' ')).toMatch(/plug/i)
    expect(g.optionHint).toMatch(/USB/i)
  })

  it('never says plug in when Bluetooth is the rail', () => {
    const g = connectGuidance('ledger', { webhid: false, webusb: true, webble: true })
    expect(g.transport).toBe(TRANSPORT_KINDS.WEBBLE)
    const copy = [g.optionHint, g.reconnectHint, ...g.steps].join(' ')
    expect(copy).not.toMatch(/plug/i)
    expect(copy).toMatch(/bluetooth/i)
    expect(copy).toMatch(/pair/i)
    // The Ethereum app is still required over BLE.
    expect(copy).toMatch(/ethereum app/i)
  })

  it('states the reason instead of steps when no rail exists', () => {
    const g = connectGuidance('ledger', { webhid: false, webusb: false, webble: false })
    expect(g.transport).toBeNull()
    expect(g.steps).toEqual([])
    expect(g.optionHint).toMatch(/bluetooth/i)
    expect(g.reconnectHint).toMatch(/USB/i)
  })

  it('leaves the Trezor copy exactly as it was, on a phone too', () => {
    const g = connectGuidance('trezor', { webhid: false, webusb: false, webble: true })
    expect(g.transport).toBeNull()
    expect(g.steps).toEqual([
      'Plug the device into this computer.',
      'Unlock it with your PIN.',
      'Approve the connection in the Trezor window when it opens.',
    ])
    expect([g.optionHint, g.reconnectHint].join(' ')).not.toMatch(/bluetooth/i)
  })
})
