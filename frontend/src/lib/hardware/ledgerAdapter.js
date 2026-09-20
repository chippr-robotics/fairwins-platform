// Spec 085 — Ledger adapter. Talks to the device over WebHID, Web Bluetooth, or WebUSB via the
// official @ledgerhq transports and the Ethereum app protocol (@ledgerhq/hw-app-eth). Loaded only
// through `connectHardware('ledger')` — never import this module directly from UI code.
//
// WHICH RAIL: decided by capability, in `ledgerTransportKind` (adapters.js) — a desktop keeps
// WebHID exactly as before, a phone with no WebHID pairs over Bluetooth. Everything above this
// module is transport-agnostic: the session shape is identical either way, which is what lets
// HardwareSigner sign without knowing (or caring) how the bytes reach the device.
//
// The device exposes public keys/addresses per derivation path and signs on-device; no secret can
// reach this code. Status words from the Ethereum app are normalized into typed errors so the UI
// can say "unlock the device" / "open the Ethereum app" instead of "0x6511".

import { HardwareWalletError, HW_ERROR_CODES } from './errors'
import { detectTransports, ledgerTransportKind, TRANSPORT_KINDS } from './adapters'
import { isNativeRuntime, nativeCapability, NATIVE_CAPABILITIES } from '../native/runtime'

// hw-app-eth expects paths without the leading "m/".
const appPath = (path) => String(path).replace(/^m\//, '')

const bytesToHex = (bytes) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Map a raw transport/app error onto the typed vocabulary. Exported for tests. */
export function classifyLedgerError(err) {
  const name = err?.name || ''
  const status = err?.statusCode
  const message = String(err?.message || '')
  // TransportWebBLE turns a dismissed chooser into TransportOpenUserCancelled, but a raw
  // DOMException reaches us whenever the pairing prompt is answered outside that wrapper —
  // both are the member declining, not a fault.
  if (name === 'TransportOpenUserCancelled') return HW_ERROR_CODES.PERMISSION_DENIED
  if (name === 'NotFoundError' || name === 'NotAllowedError' || name === 'SecurityError') {
    return HW_ERROR_CODES.PERMISSION_DENIED
  }
  if (name === 'TransportInterfaceNotAvailable' || name === 'TransportWebUSBGestureRequired') {
    return HW_ERROR_CODES.PERMISSION_DENIED
  }
  if (name === 'DisconnectedDevice' || name === 'DisconnectedDeviceDuringOperation') {
    return HW_ERROR_CODES.DISCONNECTED
  }
  // A BLE link dropping mid-session surfaces as a GATT DOMException (NetworkError) or as one of
  // TransportWebBLE's own "bluetooth … not found" throws while it re-reads the service. Same
  // member-visible fact as a yanked cable: the device went away, reconnect and retry.
  if (name === 'NetworkError' || /gatt|bluetooth service/i.test(message)) {
    return HW_ERROR_CODES.DISCONNECTED
  }
  if (name === 'BluetoothRequired') return HW_ERROR_CODES.BLUETOOTH_UNAVAILABLE
  if (/web bluetooth not supported/i.test(message)) return HW_ERROR_CODES.TRANSPORT_UNSUPPORTED
  // The native BLE plugin (spec 102) reports its failures as plain Errors with
  // these wordings: a radio that is off/unauthorized is the member's Bluetooth
  // state (distinct remedy), a dismissed device chooser is a declined pairing.
  if (/bluetooth.*(disabled|turned off|not enabled|unauthorized)|location.*(disabled|denied)/i.test(message)) {
    return HW_ERROR_CODES.BLUETOOTH_UNAVAILABLE
  }
  if (/request ?device.*(cancel|closed)|user cancel/i.test(message)) return HW_ERROR_CODES.PERMISSION_DENIED
  if (status === 0x5515 || status === 0x6982 || status === 0x6b0c) return HW_ERROR_CODES.DEVICE_LOCKED
  if (status === 0x6511 || status === 0x6e00 || status === 0x6d00 || status === 0x6e01) {
    return HW_ERROR_CODES.WRONG_APP
  }
  if (status === 0x6985 || status === 0x5501) return HW_ERROR_CODES.USER_CANCELLED
  /*
   * 0x6a80 from a SIGN command is the app declining to display the payload, and on the Ethereum
   * app that means one thing in practice: blind signing is off. Found on the emulator, where the
   * device's own screen says "Blind signing must be enabled in settings" while the app returned
   * INCORRECT_DATA — which this layer was classifying UNKNOWN, so the member was told to
   * "reconnect the device and try again". That advice can never work: the remedy is a toggle in
   * the app's own settings, and nothing in the UI was saying so.
   */
  if (status === 0x6a80) return HW_ERROR_CODES.BLIND_SIGNING_REQUIRED
  return HW_ERROR_CODES.UNKNOWN
}

const wrap = (err) =>
  err instanceof HardwareWalletError
    ? err
    : new HardwareWalletError(classifyLedgerError(err), undefined, { cause: err, vendor: 'ledger' })

/**
 * Web Bluetooth exists but the radio can still be off or blocked. `getAvailability()` answers that
 * without a permission prompt, so the refusal is stated BEFORE a pairing chooser appears — a
 * chooser that can never find a device reads as a broken feature.
 */
async function assertBluetoothRadio() {
  const bt = typeof navigator !== 'undefined' ? navigator.bluetooth : undefined
  if (!bt || typeof bt.getAvailability !== 'function') return
  let available
  try {
    available = await bt.getAvailability()
  } catch {
    // An implementation that cannot answer is not an implementation that said "no" — carry on and
    // let the real open attempt decide.
    return
  }
  if (!available) {
    throw new HardwareWalletError(HW_ERROR_CODES.BLUETOOTH_UNAVAILABLE, undefined, { vendor: 'ledger' })
  }
}

/** @returns {Promise<{ transport: object, kind: string }>} */
async function openTransport({ transport: requested, speculosUrl } = {}) {
  /*
   * The EMULATOR rail, asked for by name and never selected by a capability probe.
   *
   * `import.meta.env.DEV` is repeated here even though `connectHardware` already checks it, and
   * the repetition is the POINT: the caller's guard is a runtime fact, not a static one, so the
   * bundler cannot prove `requested` is never SPECULOS and it kept the dynamic import — a
   * production build really did ship `speculosTransport` as its own chunk, with the seam's guard
   * in place and the structural test green. Only grepping `dist` showed it. With the constant
   * INSIDE this branch too, the condition folds to `false` and the chunk disappears; the build
   * check in the nightly workflow is what keeps that true.
   */
  if (import.meta.env.DEV && requested === TRANSPORT_KINDS.SPECULOS) {
    try {
      const { TransportSpeculosHttp } = await import('./speculosTransport')
      return { transport: await TransportSpeculosHttp.open(speculosUrl), kind: TRANSPORT_KINDS.SPECULOS }
    } catch (err) {
      throw wrap(err)
    }
  }

  // Spec 102: in the native apps the browser transports do not exist — the
  // rail is the OS Bluetooth stack behind the runtime seam, offered only when
  // the plugin has actually confirmed itself, refused with the seam's own
  // member-renderable reason otherwise. Everything below the `return` is
  // byte-identical web behavior.
  if (isNativeRuntime()) {
    const capability = nativeCapability(NATIVE_CAPABILITIES.BLE)
    if (capability.state !== 'available') {
      throw new HardwareWalletError(HW_ERROR_CODES.BLUETOOTH_UNAVAILABLE, capability.reason, { vendor: 'ledger' })
    }
    try {
      const { openNativeBleTransport } = await import('../native/ledgerBleTransport')
      return { transport: await openNativeBleTransport(), kind: TRANSPORT_KINDS.NATIVEBLE }
    } catch (err) {
      throw wrap(err)
    }
  }

  const kind = ledgerTransportKind(detectTransports())
  if (!kind) {
    throw new HardwareWalletError(HW_ERROR_CODES.TRANSPORT_UNSUPPORTED, undefined, { vendor: 'ledger' })
  }
  if (kind === TRANSPORT_KINDS.WEBBLE) await assertBluetoothRadio()
  try {
    if (kind === TRANSPORT_KINDS.WEBHID) {
      const { default: TransportWebHID } = await import('@ledgerhq/hw-transport-webhid')
      return { transport: await TransportWebHID.create(), kind }
    }
    if (kind === TRANSPORT_KINDS.WEBBLE) {
      const { default: TransportWebBLE } = await import('@ledgerhq/hw-transport-web-ble')
      return { transport: await TransportWebBLE.create(), kind }
    }
    const { default: TransportWebUSB } = await import('@ledgerhq/hw-transport-webusb')
    return { transport: await TransportWebUSB.create(), kind }
  } catch (err) {
    throw wrap(err)
  }
}

export async function connectLedger(options = {}) {
  const { transport, kind } = await openTransport(options)
  const { default: Eth } = await import('@ledgerhq/hw-app-eth')
  const eth = new Eth(transport)

  // Probe once so "locked" / "wrong app" surface at connect time, in the step whose UI explains
  // them, rather than mid-way through the account list.
  try {
    await eth.getAddress(appPath("m/44'/60'/0'/0/0"), false)
  } catch (err) {
    await transport.close().catch(() => {})
    throw wrap(err)
  }

  return {
    vendor: 'ledger',
    // Informational only — every method below behaves identically on either rail, and nothing
    // above this module branches on it (HardwareSigner must never learn what a transport is).
    transport: kind,

    async getAddress(path, { display = false } = {}) {
      try {
        const res = await eth.getAddress(appPath(path), display)
        return { address: res.address }
      } catch (err) {
        throw wrap(err)
      }
    },

    async getAddresses(paths) {
      // The Ethereum app answers one APDU at a time — sequential by protocol, not by choice.
      const out = []
      for (const path of paths) {
        const { address } = await this.getAddress(path)
        out.push({ path, address })
      }
      return out
    },

    async signPersonalMessage(path, messageBytes) {
      try {
        const hex = bytesToHex(messageBytes)
        const { r, s, v } = await eth.signPersonalMessage(appPath(path), hex)
        return `0x${r}${s}${Number(v).toString(16).padStart(2, '0')}`
      } catch (err) {
        throw wrap(err)
      }
    },

    async signTransaction(path, unsignedSerialized) {
      try {
        const raw = String(unsignedSerialized).replace(/^0x/, '')
        // `null` resolution: skip Ledger's remote clear-signing metadata service — no external
        // call from the app; the device falls back to on-screen review of the raw fields.
        const { r, s, v } = await eth.signTransaction(appPath(path), raw, null)
        return { r: `0x${r}`, s: `0x${s}`, v: `0x${v}` }
      } catch (err) {
        throw wrap(err)
      }
    },

    /**
     * EIP-712. The Ethereum app signs from the two 32-byte hashes (domain separator +
     * hashStruct(message)), which every firmware supports; the caller (HardwareSigner)
     * computes them with ethers' TypedDataEncoder.
     */
    async signTypedData(path, { domainSeparator, hashStructMessage }) {
      try {
        const { r, s, v } = await eth.signEIP712HashedMessage(
          appPath(path),
          String(domainSeparator).replace(/^0x/, ''),
          String(hashStructMessage).replace(/^0x/, ''),
        )
        return `0x${r}${s}${Number(v).toString(16).padStart(2, '0')}`
      } catch (err) {
        throw wrap(err)
      }
    },

    async close() {
      await transport.close().catch(() => {})
    },
  }
}
