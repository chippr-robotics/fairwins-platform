// Spec 085 follow-up — the words a member reads while connecting a device, DERIVED from the
// transport the adapter would actually open (adapters.js#ledgerTransportKind) rather than assumed.
//
// This exists because the copy was written for a desk: "Plug the device into this computer" is
// simply false on a phone pairing a Nano X over Bluetooth, and a member following it will conclude
// the feature is broken. Every hardware-connect string in the UI comes from here, so the guidance
// and the rail can never drift apart — a component that hardcodes a sentence is the bug this
// module prevents.
//
// It states copy only; it opens nothing and imports no vendor SDK.

import { detectTransports, ledgerTransportKind, vendorAvailability, TRANSPORT_KINDS } from './adapters'

const LEDGER_USB_STEPS = Object.freeze([
  'Plug the device into this computer.',
  'Unlock it with your PIN.',
  'Open the Ethereum app on the device.',
])

const LEDGER_BLE_STEPS = Object.freeze([
  'Turn on your Ledger and unlock it with your PIN.',
  'Open the Ethereum app on the device.',
  'Choose your Ledger in the Bluetooth pairing prompt.',
])

const SIGIL_STEPS = Object.freeze([
  'On this computer, start sigil-daemon and sigil-bridge with this site as an allowed origin.',
  'Insert the Sigil floppy disk for the account.',
  'Paste the pairing token from the bridge’s token file below.',
])

const TREZOR_STEPS = Object.freeze([
  'Plug the device into this computer.',
  'Unlock it with your PIN.',
  'Approve the connection in the Trezor window when it opens.',
])

/**
 * @typedef {object} ConnectGuidance
 * @property {string|null} transport the rail that will be used, or null when there is none
 *   (and for Trezor, which runs through the vendor's own window and has no local rail)
 * @property {string} optionHint one line under the vendor choice — or the refusal reason
 * @property {string} reconnectHint one sentence for the reconnect dialog
 * @property {string[]} steps the connect checklist; empty when no rail exists (the reason stands
 *   in its place, so the member is never given steps that cannot work)
 */

/**
 * @param {'ledger'|'trezor'|'sigil'} vendor
 * @param {{ webhid: boolean, webusb: boolean, webble: boolean }} [transports]
 * @returns {ConnectGuidance}
 */
export function connectGuidance(vendor, transports = detectTransports()) {
  if (vendor === 'trezor') {
    return {
      transport: null,
      optionHint: 'Connect through the Trezor window',
      reconnectHint: 'Plug in the device and approve the connection in the Trezor window.',
      steps: [...TREZOR_STEPS],
    }
  }

  if (vendor === 'sigil') {
    const availability = vendorAvailability('sigil', transports)
    if (!availability.available) {
      return { transport: null, optionHint: availability.reason, reconnectHint: availability.reason, steps: [] }
    }
    return {
      transport: TRANSPORT_KINDS.SIGIL_BRIDGE,
      optionHint: 'MPC cold signer — floppy disk + your computer',
      reconnectHint: 'Make sure sigil-daemon and sigil-bridge are running on this computer, and insert the Sigil disk for this account.',
      steps: [...SIGIL_STEPS],
    }
  }

  if (vendor === 'ledger') {
    const transport = ledgerTransportKind(transports)
    if (transport === TRANSPORT_KINDS.WEBBLE) {
      return {
        transport,
        optionHint: 'Pair over Bluetooth',
        reconnectHint:
          'Turn on your Ledger, unlock it, open the Ethereum app, then choose it in the Bluetooth pairing prompt.',
        steps: [...LEDGER_BLE_STEPS],
      }
    }
    if (transport) {
      return {
        transport,
        optionHint: 'Connect over USB',
        reconnectHint: 'Plug in the device, unlock it, and open the Ethereum app.',
        steps: [...LEDGER_USB_STEPS],
      }
    }
    // No rail: the reason IS the copy, in both places — never a checklist that cannot succeed.
    const reason = vendorAvailability('ledger', transports).reason
    return { transport: null, optionHint: reason, reconnectHint: reason, steps: [] }
  }

  const reason = vendorAvailability(vendor, transports).reason
  return { transport: null, optionHint: reason, reconnectHint: reason, steps: [] }
}

/** "742 of 1000 signatures left · expires in 30 days" — every figure the disk reported, none invented. */
export function describeSigilBudget(detail) {
  if (!detail) return null
  const parts = []
  if (detail.presigsRemaining != null && detail.presigsTotal != null) {
    parts.push(`${detail.presigsRemaining} of ${detail.presigsTotal} signatures left`)
  } else if (detail.presigsRemaining != null) {
    parts.push(`${detail.presigsRemaining} signatures left`)
  }
  if (detail.daysUntilExpiry != null) {
    parts.push(detail.daysUntilExpiry === 1 ? 'disk expires in 1 day' : `disk expires in ${detail.daysUntilExpiry} days`)
  }
  return parts.length ? parts.join(' · ') : null
}

export default connectGuidance
