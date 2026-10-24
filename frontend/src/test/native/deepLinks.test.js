import { describe, it, expect, vi, beforeEach } from 'vitest'

// Spec 102 §5 — deep links. The rules with teeth: ONLY the tenant's own
// origin routes (a foreign URL through the link channel is ignored outright),
// and the seam is inert on web.

const platformRef = { value: 'android' }
const listeners = []
// What `App.getLaunchUrl()` reports. `null` = the app was not opened by a link.
const launchUrlRef = { value: null }

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
    getLaunchUrl: vi.fn(() => Promise.resolve(
      launchUrlRef.value ? { url: launchUrlRef.value } : null,
    )),
  },
}))

import { pathForIncomingUrl, subscribeDeepLinks } from '../../lib/native/deepLinks'
import { __resetRuntimeForTests } from '../../lib/native/runtime'

const ORIGIN = 'https://fairwins.app'

function fire(url) {
  for (const entry of listeners) {
    if (entry.event === 'appUrlOpen' && !entry.removed) entry.handler({ url })
  }
}

describe('deep links', () => {
  beforeEach(() => {
    platformRef.value = 'android'
    listeners.length = 0
    launchUrlRef.value = null
    __resetRuntimeForTests()
  })

  it('maps tenant-origin URLs to SPA paths, query and hash intact', () => {
    expect(pathForIncomingUrl('https://fairwins.app/wallet?tab=trade&view=perps#top', { appOrigin: ORIGIN }))
      .toBe('/wallet?tab=trade&view=perps#top')
    expect(pathForIncomingUrl('https://fairwins.app/', { appOrigin: ORIGIN })).toBe('/')
  })

  it('IGNORES anything that is not the tenant origin — never opened, never navigated', () => {
    expect(pathForIncomingUrl('https://evil.example/wallet', { appOrigin: ORIGIN })).toBeNull()
    expect(pathForIncomingUrl('http://fairwins.app/wallet', { appOrigin: ORIGIN })).toBeNull() // scheme downgrade
    expect(pathForIncomingUrl('not a url', { appOrigin: ORIGIN })).toBeNull()
  })

  it('delivers mapped paths to the consumer and drops foreign ones', () => {
    const onPath = vi.fn()
    subscribeDeepLinks(onPath, { appOrigin: ORIGIN })
    fire('https://fairwins.app/wallet?tab=custody')
    fire('https://attacker.example/wallet')
    expect(onPath).toHaveBeenCalledTimes(1)
    expect(onPath).toHaveBeenCalledWith('/wallet?tab=custody')
  })

  // The launch read is a promise chain; let it settle.
  const settle = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve() }

  it('delivers the link that LAUNCHED the app — the cold-start case', async () => {
    launchUrlRef.value = 'https://fairwins.app/fund/0xabc'
    const onPath = vi.fn()
    subscribeDeepLinks(onPath, { appOrigin: ORIGIN })
    expect(onPath).not.toHaveBeenCalled() // nothing fired an event; only the launch URL exists
    await settle()
    expect(onPath).toHaveBeenCalledTimes(1)
    expect(onPath).toHaveBeenCalledWith('/fund/0xabc')
  })

  it('delivers a cold-start link ONCE when the platform reports it down both channels', async () => {
    // Android's ordering: the launch read resolves first, then the same URL
    // arrives as an event.
    launchUrlRef.value = 'https://fairwins.app/wallet?tab=custody'
    const onPath = vi.fn()
    subscribeDeepLinks(onPath, { appOrigin: ORIGIN })
    await settle()
    fire('https://fairwins.app/wallet?tab=custody')
    expect(onPath).toHaveBeenCalledTimes(1)

    // …and the other ordering: the event beats the launch read.
    onPath.mockClear()
    listeners.length = 0
    launchUrlRef.value = 'https://fairwins.app/fund/0xdef'
    subscribeDeepLinks(onPath, { appOrigin: ORIGIN })
    fire('https://fairwins.app/fund/0xdef')
    await settle()
    expect(onPath).toHaveBeenCalledTimes(1)
  })

  it('still navigates when the member re-opens the SAME link later — the suppression is single-use', async () => {
    launchUrlRef.value = 'https://fairwins.app/wallet?tab=custody'
    const onPath = vi.fn()
    subscribeDeepLinks(onPath, { appOrigin: ORIGIN })
    await settle()
    fire('https://fairwins.app/wallet?tab=custody') // the platform's echo — spent
    fire('https://fairwins.app/wallet?tab=custody') // a deliberate re-open — must navigate
    expect(onPath).toHaveBeenCalledTimes(2)
  })

  it('ignores a foreign launch URL, exactly as it ignores a foreign event', async () => {
    launchUrlRef.value = 'https://evil.example/wallet'
    const onPath = vi.fn()
    subscribeDeepLinks(onPath, { appOrigin: ORIGIN })
    await settle()
    expect(onPath).not.toHaveBeenCalled()
  })

  it('is inert on web and unsubscribes cleanly on native', async () => {
    platformRef.value = 'web'
    __resetRuntimeForTests()
    const onPath = vi.fn()
    const unsubscribe = subscribeDeepLinks(onPath, { appOrigin: ORIGIN })
    expect(listeners).toHaveLength(0)
    unsubscribe()

    platformRef.value = 'ios'
    __resetRuntimeForTests()
    const stop = subscribeDeepLinks(onPath, { appOrigin: ORIGIN })
    expect(listeners).toHaveLength(1)
    stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(listeners[0].removed).toBe(true)
  })
})
