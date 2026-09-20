// Spec 085 — the single seam between the app and hardware-wallet vendors. Everything above this
// module (the add-account sheet, the connect dialog, the signer) talks to one adapter interface;
// everything vendor-specific (Ledger APDU transports, the Trezor Connect popup) lives behind it.
//
// Adapter interface — `connectHardware(vendor)` resolves to a session:
//
//   {
//     vendor: 'ledger' | 'trezor',
//     getAddress(path, { display = false }) → Promise<{ address: string }>,
//     getAddresses(paths)                   → Promise<Array<{ path, address }>>,
//     signPersonalMessage(path, messageBytes) → Promise<`0x…` 65-byte signature>,
//     signTransaction(path, unsignedSerialized, txFields) → Promise<{ r, s, v }>,
//     close() → Promise<void>,
//   }
//
// Vendor SDKs are loaded lazily (dynamic import) so members who never open the flow never download
// them. Failures are normalized to HardwareWalletError before they leave this layer (FR-012).
//
// Test seam: in DEV builds only, a capture harness or e2e run may plant
// `window.__fwHardwareTestAdapter__(vendor)` and the factory uses it instead of real vendor code.
// The guard is `import.meta.env.DEV`, so production bundles contain no test path at all —
// dead-code elimination removes the branch (constitution III: no mocks in shipped paths).

import { HardwareWalletError, HW_ERROR_CODES } from './errors'
import { ensureNodeGlobals } from './nodeShims'

export const VENDOR_LABELS = Object.freeze({ ledger: 'Ledger', trezor: 'Trezor' })

/** The rails a Ledger can be reached over from a browser. */
export const TRANSPORT_KINDS = Object.freeze({
  WEBHID: 'webhid',
  WEBUSB: 'webusb',
  WEBBLE: 'webble',
  // The EMULATOR rail (Speculos). DEV builds only — it aims signing at an arbitrary HTTP origin,
  // so a production bundle must contain no path to it (see `connectHardware`).
  SPECULOS: 'speculos',
  // Spec 102: the native apps' Bluetooth rail — the OS BLE stack via the
  // Capacitor plugin, since a native WebView has no Web Bluetooth. Selected
  // by runtime in ledgerAdapter.js, never by this browser-capability probe.
  NATIVEBLE: 'nativeble',
})

/** Which browser transports exist here. Pure capability read — no permission prompt. */
export function detectTransports(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  return {
    webhid: Boolean(nav && 'hid' in nav),
    webusb: Boolean(nav && 'usb' in nav),
    webble: Boolean(nav && 'bluetooth' in nav),
  }
}

/**
 * Which rail this browser should use for a Ledger, or null when it has none.
 *
 * WebHID first: that is what every desktop Chromium exposes, so a computer keeps exactly the
 * transport it has always used. Bluetooth comes SECOND — ahead of WebUSB — and only where WebHID
 * is absent, which in practice is Android Chrome: it exposes WebUSB too, but reaching a Ledger
 * that way needs an OTG cable, while BLE is the rail a Nano X actually offers a phone. WebUSB
 * stays as the last fallback for a browser that has only that. iOS Safari has none of the three,
 * which is a stated refusal, not a dead button (FR-003).
 */
export function ledgerTransportKind(transports = detectTransports()) {
  if (transports.webhid) return TRANSPORT_KINDS.WEBHID
  if (transports.webble) return TRANSPORT_KINDS.WEBBLE
  if (transports.webusb) return TRANSPORT_KINDS.WEBUSB
  return null
}

/** The one sentence for "no rail at all" — same text the thrown error carries (errors.js). */
const noTransportReason = () => new HardwareWalletError(HW_ERROR_CODES.TRANSPORT_UNSUPPORTED).message

/**
 * Whether a vendor's connect flow can run in this browser, with the honest reason when it cannot
 * (FR-003 — a vendor the browser cannot reach renders disabled with the reason, never as a dead
 * control). `transport` names the rail that would be used, so the connect copy can describe the
 * ceremony the member will actually see instead of assuming a cable.
 * @returns {{ available: boolean, reason: string|null, transport: string|null }}
 */
export function vendorAvailability(vendor, transports = detectTransports()) {
  if (vendor === 'ledger') {
    const transport = ledgerTransportKind(transports)
    if (transport) return { available: true, reason: null, transport }
    return { available: false, reason: noTransportReason(), transport: null }
  }
  if (vendor === 'trezor') {
    // Trezor Connect runs in a vendor popup and needs no local transport, but it does need a
    // window. It has no Bluetooth rail at all, so nothing here changes with one present.
    if (typeof window === 'undefined') {
      return { available: false, reason: 'Trezor Connect needs a browser window.', transport: null }
    }
    return { available: true, reason: null, transport: null }
  }
  return { available: false, reason: 'Unknown device vendor.', transport: null }
}

/**
 * Open a session with the device. The caller owns the session and MUST `close()` it when the flow
 * ends (the sheet's teardown does), so the transport is released for other tabs/tools.
 */
export async function connectHardware(vendor, { transport, speculosUrl } = {}) {
  if (import.meta.env.DEV && typeof window !== 'undefined' && typeof window.__fwHardwareTestAdapter__ === 'function') {
    return window.__fwHardwareTestAdapter__(vendor)
  }
  /*
   * The emulator rail, and the guard is the whole of why it is safe.
   *
   * Speculos is REAL device firmware reached over HTTP, which is what makes `hardwareSigner.js`
   * testable without a thumb — but "reached over HTTP" is also a way to point a member's signing
   * at an origin they never chose. So this branch lives under `import.meta.env.DEV` exactly as the
   * test-adapter seam above does, and is dead-code-eliminated from a release build. A caller must
   * ASK for it by name: no capability probe returns `speculos`, so nothing selects it by accident.
   */
  if (import.meta.env.DEV && transport === TRANSPORT_KINDS.SPECULOS) {
    if (vendor !== 'ledger') {
      throw new HardwareWalletError(HW_ERROR_CODES.TRANSPORT_UNSUPPORTED, 'Only a Ledger can be emulated.', { vendor })
    }
    await ensureNodeGlobals()
    const { connectLedger } = await import('./ledgerAdapter')
    return connectLedger({ transport: TRANSPORT_KINDS.SPECULOS, speculosUrl })
  }
  const availability = vendorAvailability(vendor)
  if (!availability.available) {
    throw new HardwareWalletError(HW_ERROR_CODES.TRANSPORT_UNSUPPORTED, availability.reason, { vendor })
  }
  // The vendor SDKs assume Node globals (Buffer); install the browser polyfill before any of
  // their code loads. See nodeShims.js for why this exists and why it is lazy.
  await ensureNodeGlobals()
  if (vendor === 'ledger') {
    const { connectLedger } = await import('./ledgerAdapter')
    return connectLedger()
  }
  if (vendor === 'trezor') {
    const { connectTrezor } = await import('./trezorAdapter')
    return connectTrezor()
  }
  throw new HardwareWalletError(HW_ERROR_CODES.UNKNOWN, `Unknown device vendor: ${vendor}`)
}
