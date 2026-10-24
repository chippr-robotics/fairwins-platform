// Spec 085 — typed hardware-wallet failures. Every connect/derive/sign path must end in a stated,
// human-readable outcome (FR-012): the adapters normalize vendor-specific failures into these codes,
// and the UI renders `describeHardwareError` verbatim instead of raw SDK messages.

export const HW_ERROR_CODES = Object.freeze({
  TRANSPORT_UNSUPPORTED: 'transport-unsupported',
  // Distinct from TRANSPORT_UNSUPPORTED on purpose: the browser DOES have Web Bluetooth, the radio
  // is simply off or blocked. The remedy is the member's, and it is not "use another browser".
  BLUETOOTH_UNAVAILABLE: 'bluetooth-unavailable',
  PERMISSION_DENIED: 'permission-denied',
  DEVICE_LOCKED: 'device-locked',
  WRONG_APP: 'wrong-app',
  USER_CANCELLED: 'user-cancelled',
  // The Ethereum app refusing a payload it will not review on screen. Distinct from UNKNOWN
  // because the remedy is the MEMBER'S and it is a settings toggle on the device — telling them
  // to "reconnect and try again" is advice that can never work (found on the emulator: a typed-data
  // signature answers 0x6a80 with "Blind signing must be enabled in settings" on the screen).
  BLIND_SIGNING_REQUIRED: 'blind-signing-required',
  DISCONNECTED: 'disconnected',
  TIMEOUT: 'timeout',
  POPUP_BLOCKED: 'popup-blocked',
  // Spec 111 — Sigil (MPC floppy signer). Each is its own code because each has its own remedy:
  // start the bridge, re-pair, insert the disk, refill it at the mother device, or insert the RIGHT
  // disk. Folding them into DISCONNECTED would tell a member with an empty disk to "reconnect".
  SIGIL_BRIDGE_UNREACHABLE: 'sigil-bridge-unreachable',
  SIGIL_NOT_PAIRED: 'sigil-not-paired',
  SIGIL_DAEMON_DOWN: 'sigil-daemon-down',
  SIGIL_NO_DISK: 'sigil-no-disk',
  SIGIL_DISK_EXHAUSTED: 'sigil-disk-exhausted',
  SIGIL_DISK_INVALID: 'sigil-disk-invalid',
  SIGIL_WRONG_DISK: 'sigil-wrong-disk',
  SIGIL_DAEMON_OUTDATED: 'sigil-daemon-outdated',
  UNKNOWN: 'unknown',
})

export class HardwareWalletError extends Error {
  /**
   * @param {string} code one of HW_ERROR_CODES
   * @param {string} [message] optional override for the default description
   * @param {{ cause?: unknown, vendor?: string }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message || DESCRIPTIONS[code] || DESCRIPTIONS[HW_ERROR_CODES.UNKNOWN])
    this.name = 'HardwareWalletError'
    this.code = Object.values(HW_ERROR_CODES).includes(code) ? code : HW_ERROR_CODES.UNKNOWN
    if (opts.cause !== undefined) this.cause = opts.cause
    if (opts.vendor) this.vendor = opts.vendor
  }
}

const DESCRIPTIONS = {
  // Names both rails, because which one is missing depends on the device the member is holding:
  // a computer connects over USB, an Android phone over Bluetooth, and an iPhone or iPad can do
  // neither — saying "use Chromium" alone would be advice an iOS member cannot act on.
  [HW_ERROR_CODES.TRANSPORT_UNSUPPORTED]:
    'This browser cannot reach the device over USB or Bluetooth. On a computer use a Chromium-based browser (Chrome, Edge, Brave); on Android use Chrome and pair over Bluetooth. iPhones and iPads cannot connect a device to a website.',
  [HW_ERROR_CODES.BLUETOOTH_UNAVAILABLE]:
    'Bluetooth is off or unavailable on this device. Turn Bluetooth on, then try again.',
  [HW_ERROR_CODES.PERMISSION_DENIED]:
    'The browser was not given permission to use the device. Choose the device in the browser prompt to continue.',
  [HW_ERROR_CODES.DEVICE_LOCKED]: 'The device is locked. Unlock it with your PIN and try again.',
  [HW_ERROR_CODES.WRONG_APP]: 'Open the Ethereum app on the device, then try again.',
  [HW_ERROR_CODES.USER_CANCELLED]: 'The request was cancelled on the device.',
  [HW_ERROR_CODES.BLIND_SIGNING_REQUIRED]:
    'The device would not review this request. On the device open the Ethereum app, go to Settings and turn on "Blind signing", then try again.',
  [HW_ERROR_CODES.DISCONNECTED]: 'The device was disconnected. Reconnect it and try again.',
  [HW_ERROR_CODES.TIMEOUT]: 'The device did not respond in time. Check the connection and try again.',
  [HW_ERROR_CODES.POPUP_BLOCKED]:
    'The vendor window could not open or did not respond. Allow popups for this site and try again.',
  [HW_ERROR_CODES.SIGIL_BRIDGE_UNREACHABLE]:
    'The Sigil bridge on this computer did not answer. Start sigil-bridge (with this site as an allowed origin), allow this site to reach devices on your local network if the browser asks, then try again.',
  [HW_ERROR_CODES.SIGIL_NOT_PAIRED]:
    'The Sigil bridge did not accept this browser’s pairing token. Pair again in Protect ▸ Off chain with the token from the bridge’s token file.',
  [HW_ERROR_CODES.SIGIL_DAEMON_DOWN]:
    'The Sigil bridge is running but the Sigil daemon is not. Start sigil-daemon on this computer, then try again.',
  [HW_ERROR_CODES.SIGIL_NO_DISK]: 'No Sigil disk is inserted. Insert the floppy disk for this account, then try again.',
  [HW_ERROR_CODES.SIGIL_DISK_EXHAUSTED]:
    'This Sigil disk has no signatures left. Take it to your mother device to reconcile and refill it. Nothing was signed.',
  [HW_ERROR_CODES.SIGIL_DISK_INVALID]:
    'This Sigil disk has expired or failed its integrity check. Take it to your mother device to reconcile it. Nothing was signed.',
  [HW_ERROR_CODES.SIGIL_WRONG_DISK]:
    'The inserted Sigil disk belongs to a different account. Insert the disk for this account. Nothing was signed.',
  [HW_ERROR_CODES.SIGIL_DAEMON_OUTDATED]:
    'This Sigil daemon does not report its disk’s public key, so the account cannot be identified. Update sigil-daemon to a version that does, then try again.',
  [HW_ERROR_CODES.UNKNOWN]: 'Something went wrong talking to the device. Reconnect it and try again.',
}

/** One human sentence for any failure out of the hardware layer — never a raw SDK message. */
export function describeHardwareError(err) {
  if (err instanceof HardwareWalletError) return err.message
  return DESCRIPTIONS[HW_ERROR_CODES.UNKNOWN]
}

/**
 * The UI-boundary form: returns the human sentence AND logs the raw failure (with its cause)
 * to the console. The member never sees SDK internals, but an operator debugging a device
 * report must — the spec-085 staging validation found both vendors failing with "no relevant
 * logs" precisely because every raw error was swallowed on the way to the friendly sentence.
 */
export function reportHardwareError(err, context = 'hardware') {
  // Deliberate operator diagnostic (see docstring) — console.warn is allowed by this repo's lint.
  console.warn(`[${context}]`, err, err?.cause !== undefined ? { cause: err.cause } : '')
  return describeHardwareError(err)
}
