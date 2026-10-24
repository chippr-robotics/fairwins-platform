import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

// Spec 102 FR-002 — the degradation surface renders the seam's reason, or
// nothing at all. A blank notice for an unavailable capability would be a
// silent hide with extra steps.

const platformRef = { value: 'web', plugins: {} }
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => platformRef.value,
    isPluginAvailable: (name) => Boolean(platformRef.plugins[name]),
  },
}))

import NativeCapabilityNotice from '../../components/native/NativeCapabilityNotice'
import { NATIVE_CAPABILITIES, __resetRuntimeForTests } from '../../lib/native/runtime'

describe('NativeCapabilityNotice', () => {
  beforeEach(() => {
    platformRef.value = 'web'
    platformRef.plugins = {}
    __resetRuntimeForTests()
  })

  it('renders nothing when the capability is available', () => {
    // Web runtime: deep links are plain links, always available.
    const { container } = render(<NativeCapabilityNotice capability={NATIVE_CAPABILITIES.DEEP_LINKS} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the seam reason, never blank, when unavailable', () => {
    platformRef.value = 'android' // native, no BLE plugin registered
    __resetRuntimeForTests()
    render(<NativeCapabilityNotice capability={NATIVE_CAPABILITIES.BLE} />)
    const notice = screen.getByRole('status')
    expect(notice.textContent.trim().length).toBeGreaterThan(0)
    expect(notice).toHaveTextContent(/bluetooth/i)
  })
})
