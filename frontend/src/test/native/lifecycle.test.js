import { describe, it, expect, vi, beforeEach } from 'vitest'

// Spec 102 §4 — pure event mapping, inert on web (the no-double-fire rule:
// the overlay keeps its DOM listeners, so a web-active adapter would engage
// the lock twice per hide — harmless for the lock, but a lie about what this
// seam is for).

const platformRef = { value: 'web' }
const listeners = []

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => platformRef.value,
    isPluginAvailable: () => true,
  },
}))

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event, handler) => {
      const entry = { event, handler, removed: false }
      listeners.push(entry)
      return Promise.resolve({ remove: () => { entry.removed = true } })
    }),
  },
}))

import { subscribeAppHidden } from '../../lib/native/lifecycle'
import { __resetRuntimeForTests } from '../../lib/native/runtime'

function fire(event, payload) {
  for (const entry of listeners) {
    if (entry.event === event && !entry.removed) entry.handler(payload)
  }
}

describe('native lifecycle adapter', () => {
  beforeEach(() => {
    platformRef.value = 'web'
    listeners.length = 0
    __resetRuntimeForTests()
  })

  it('is INERT on web: registers nothing, unsubscribe is a no-op', () => {
    const onHidden = vi.fn()
    const unsubscribe = subscribeAppHidden(onHidden)
    expect(listeners).toHaveLength(0)
    expect(onHidden).not.toHaveBeenCalled()
    expect(() => unsubscribe()).not.toThrow()
  })

  it('maps backgrounding to onHidden on native, and NOT foregrounding', () => {
    platformRef.value = 'android'
    __resetRuntimeForTests()
    const onHidden = vi.fn()
    subscribeAppHidden(onHidden)

    fire('appStateChange', { isActive: true })
    expect(onHidden).not.toHaveBeenCalled()

    fire('appStateChange', { isActive: false })
    expect(onHidden).toHaveBeenCalledTimes(1)

    fire('pause', undefined)
    expect(onHidden).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe removes both listeners, once', async () => {
    platformRef.value = 'ios'
    __resetRuntimeForTests()
    const onHidden = vi.fn()
    const unsubscribe = subscribeAppHidden(onHidden)
    expect(listeners).toHaveLength(2)

    unsubscribe()
    unsubscribe() // idempotent
    await Promise.resolve() // let the async handle removal settle
    await Promise.resolve()
    expect(listeners.every((entry) => entry.removed)).toBe(true)

    fire('appStateChange', { isActive: false })
    expect(onHidden).not.toHaveBeenCalled()
  })
})
