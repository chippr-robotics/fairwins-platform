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
