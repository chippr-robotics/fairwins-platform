/**
 * The ONE runtime seam for the native channels (spec 102).
 *
 * Every native-conditional in the app reads this module — never a user-agent
 * sniff, never a direct `Capacitor.*` call from UI code. The contract lives in
 * `specs/102-capacitor-channels/contracts/native-runtime-seams.md` §1.
 *
 * `nativeCapability` is a three-state honest read in the estate tradition:
 * `available` only when the underlying machinery has actually confirmed itself
 * (on native, the bridging plugin being registered; on web, the browser API
 * existing), and `unavailable` ALWAYS carries a member-renderable reason.
 * "Probably fine" has no constructor here — fabricating `available` ahead of
 * the plugin is exactly how a dead button ships (constitution III).
 */
import { Capacitor } from '@capacitor/core'

export const RUNTIMES = Object.freeze({
  WEB: 'web',
  NATIVE_IOS: 'native-ios',
  NATIVE_ANDROID: 'native-android',
})

export const NATIVE_CAPABILITIES = Object.freeze({
  PASSKEY_CEREMONY: 'passkey-ceremony',
  BLE: 'ble',
  DEEP_LINKS: 'deep-links',
})

let cachedRuntime

/** 'web' | 'native-ios' | 'native-android' — memoized; the packaging layer's answer, once. */
export function getRuntime() {
  if (cachedRuntime === undefined) {
    const platform = Capacitor.getPlatform()
    cachedRuntime = platform === 'ios'
      ? RUNTIMES.NATIVE_IOS
      : platform === 'android'
        ? RUNTIMES.NATIVE_ANDROID
        : RUNTIMES.WEB
  }
  return cachedRuntime
}

export function isNativeRuntime() {
  return getRuntime() !== RUNTIMES.WEB
}

function available() {
  return { state: 'available' }
}

function unavailable(reason) {
  return { state: 'unavailable', reason }
}

/**
 * Which Capacitor plugin carries each capability on a native runtime. A
 * capability is `available` there ONLY when its plugin is actually registered
 * — an installed npm package whose native side did not load must read as the
 * gap it is, not as a capability.
 */
const NATIVE_PLUGIN_FOR = Object.freeze({
  [NATIVE_CAPABILITIES.PASSKEY_CEREMONY]: 'CapacitorPasskey',
  [NATIVE_CAPABILITIES.BLE]: 'BluetoothLe',
  [NATIVE_CAPABILITIES.DEEP_LINKS]: 'App',
})

const NATIVE_GAP_REASON = Object.freeze({
  [NATIVE_CAPABILITIES.PASSKEY_CEREMONY]:
    'This device cannot run the passkey sign-in ceremony (no platform passkey support in this app build or OS version).',
  [NATIVE_CAPABILITIES.BLE]:
    'Bluetooth is not available in this app build on this device.',
  [NATIVE_CAPABILITIES.DEEP_LINKS]:
    'Links cannot be routed into this app build.',
})

/**
 * Three-state capability read: `{ state: 'available' }` or
 * `{ state: 'unavailable', reason }`. On web it wraps the existing browser
 * checks — this seam never forks web behavior, it only answers the question
 * from the right place per runtime.
 */
export function nativeCapability(name, {
  nav = typeof navigator !== 'undefined' ? navigator : undefined,
  isPluginAvailable = (plugin) => Capacitor.isPluginAvailable(plugin),
} = {}) {
  if (!Object.values(NATIVE_CAPABILITIES).includes(name)) {
    throw new Error(`Unknown native capability: ${name}`)
  }

  if (!isNativeRuntime()) {
    if (name === NATIVE_CAPABILITIES.PASSKEY_CEREMONY) {
      return nav?.credentials
        ? available()
        : unavailable('This browser does not support passkeys.')
    }
    if (name === NATIVE_CAPABILITIES.BLE) {
      return nav && 'bluetooth' in nav
        ? available()
        : unavailable('This browser does not offer Bluetooth device access.')
    }
    // Plain web links always route.
    return available()
  }

  return isPluginAvailable(NATIVE_PLUGIN_FOR[name])
    ? available()
    : unavailable(NATIVE_GAP_REASON[name])
}

/** Test-only: clear the memoized runtime so a mocked platform takes effect. */
export function __resetRuntimeForTests() {
  cachedRuntime = undefined
}
