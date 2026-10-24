import { describe, it, expect, vi, beforeEach } from 'vitest'

// Spec 102 — the ONE runtime seam (contracts/native-runtime-seams.md §1).
//
// The rule under test with teeth: a capability is `available` on a native
// runtime ONLY when its bridging plugin is actually registered. Fabricating
// `available` from the platform alone is how a dead button ships.

const platformRef = { value: 'web', plugins: {} }

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => platformRef.value,
    isPluginAvailable: (name) => Boolean(platformRef.plugins[name]),
  },
}))

import {
  getRuntime,
  isNativeRuntime,
  nativeCapability,
  NATIVE_CAPABILITIES,
  RUNTIMES,
  __resetRuntimeForTests,
} from '../../lib/native/runtime'

describe('native runtime seam', () => {
  beforeEach(() => {
    platformRef.value = 'web'
    platformRef.plugins = {}
    __resetRuntimeForTests()
  })

  it('resolves web / native-ios / native-android from the packaging layer', () => {
    expect(getRuntime()).toBe(RUNTIMES.WEB)
    expect(isNativeRuntime()).toBe(false)

    __resetRuntimeForTests()
    platformRef.value = 'ios'
    expect(getRuntime()).toBe(RUNTIMES.NATIVE_IOS)
    expect(isNativeRuntime()).toBe(true)

    __resetRuntimeForTests()
    platformRef.value = 'android'
    expect(getRuntime()).toBe(RUNTIMES.NATIVE_ANDROID)
  })

  it('memoizes the runtime — one answer per boot', () => {
    expect(getRuntime()).toBe(RUNTIMES.WEB)
    platformRef.value = 'ios' // packaging cannot change mid-session
    expect(getRuntime()).toBe(RUNTIMES.WEB)
  })

  it('web capabilities wrap the existing browser checks', () => {
    const withApis = { credentials: {}, bluetooth: {} }
    expect(nativeCapability(NATIVE_CAPABILITIES.PASSKEY_CEREMONY, { nav: withApis }).state).toBe('available')
    expect(nativeCapability(NATIVE_CAPABILITIES.BLE, { nav: withApis }).state).toBe('available')
    expect(nativeCapability(NATIVE_CAPABILITIES.DEEP_LINKS, { nav: withApis }).state).toBe('available')

    const bare = {}
    const passkey = nativeCapability(NATIVE_CAPABILITIES.PASSKEY_CEREMONY, { nav: bare })
    expect(passkey.state).toBe('unavailable')
    expect(passkey.reason).toMatch(/passkey/i)
    const ble = nativeCapability(NATIVE_CAPABILITIES.BLE, { nav: bare })
    expect(ble.state).toBe('unavailable')
    expect(ble.reason).toMatch(/bluetooth/i)
  })

  it('NEVER fabricates available on native ahead of the plugin confirming', () => {
    platformRef.value = 'android'
    // No plugins registered: every capability is an honest, reasoned gap.
    for (const name of Object.values(NATIVE_CAPABILITIES)) {
      const result = nativeCapability(name)
      expect(result.state).toBe('unavailable')
      expect(result.reason).toBeTruthy()
    }
  })

  it('reports available on native exactly when the bridging plugin is registered', () => {
    platformRef.value = 'ios'
    platformRef.plugins = { BluetoothLe: true, App: true }
    expect(nativeCapability(NATIVE_CAPABILITIES.BLE).state).toBe('available')
    expect(nativeCapability(NATIVE_CAPABILITIES.DEEP_LINKS).state).toBe('available')
    // The passkey bridge is not registered — still a named gap.
    const passkey = nativeCapability(NATIVE_CAPABILITIES.PASSKEY_CEREMONY)
    expect(passkey.state).toBe('unavailable')
    expect(passkey.reason).toMatch(/passkey/i)
  })

  it('throws on an unknown capability name rather than guessing', () => {
    expect(() => nativeCapability('teleport')).toThrow(/unknown native capability/i)
  })
})
