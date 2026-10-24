/**
 * Deep links into the native apps (spec 102 US5,
 * contracts/native-runtime-seams.md §5).
 *
 * Universal/App Links deliver the member's ordinary web URLs into the app via
 * Capacitor's `appUrlOpen`. This seam maps such a URL to the SPA route and
 * hands it to the EXISTING navigation — nothing here knows what any route
 * means. Three rules:
 *
 *  · TENANT-ORIGIN URLS ONLY. Anything else that reaches the app through the
 *    link channel is ignored outright — never opened, never navigated.
 *  · An unroutable path inside the tenant origin is handed over as-is; the
 *    router's own catch-all lands it on the home surface claiming nothing.
 *  · The destination survives the gate: the app-lock overlay COVERS the app
 *    without unmounting the route underneath (spec 041 amendment), and the
 *    sign-in surfaces render in place on the destination route — so
 *    navigating immediately preserves the destination through either gate by
 *    construction.
 *  · A COLD START IS A LINK TOO. `appUrlOpen` only fires for links arriving
 *    while the app is already running; the link that LAUNCHED the app was
 *    consumed by the platform before any listener could exist, and is
 *    readable only from `App.getLaunchUrl()`. Both channels are read, and a
 *    URL that reaches us down both is delivered exactly once.
 */
import { App } from '@capacitor/app'

import { isNativeRuntime } from './runtime'

/**
 * Map an incoming link URL to an SPA path, or null when it is not this
 * tenant's to open. Exported for tests.
 */
export function pathForIncomingUrl(url, { appOrigin }) {
  let incoming
  try {
    incoming = new URL(url)
  } catch {
    return null
  }
  let expected
  try {
    expected = new URL(appOrigin)
  } catch {
    return null
  }
  if (incoming.origin !== expected.origin) return null
  return `${incoming.pathname}${incoming.search}${incoming.hash}` || '/'
}

/**
 * Subscribe the packaging layer's link channels. `onPath` receives the mapped
 * SPA path, for links arriving while the app runs AND for the link that
 * launched it. Inert on web (real links navigate the document; there is
 * nothing to bridge). Returns an unsubscribe function.
 */
export function subscribeDeepLinks(onPath, { appOrigin, native = isNativeRuntime() } = {}) {
  if (!native) return () => {}

  let stopped = false
  const deliver = (url) => {
    if (stopped) return
    const path = pathForIncomingUrl(url, { appOrigin })
    if (path) onPath(path)
  }

  // A cold-start link can reach us down BOTH channels — Android reports it as
  // an `appUrlOpen` as well as the launch URL, iOS only as the launch URL —
  // and either can land first. Two single-use tokens, one per ordering, so the
  // duplicate is dropped exactly once and a member deliberately re-opening the
  // same link later still navigates.
  let launchSettled = false
  const seenBeforeLaunchSettled = new Set()
  let spendNextEventMatching = null

  const handle = App.addListener('appUrlOpen', ({ url }) => {
    // The duplicate, if the platform sends one, is the very next event. The
    // window closes at the first event whatever it carried.
    const isLaunchEcho = url === spendNextEventMatching
    spendNextEventMatching = null
    if (isLaunchEcho) return
    if (!launchSettled) seenBeforeLaunchSettled.add(url)
    deliver(url)
  })

  Promise.resolve()
    .then(() => App.getLaunchUrl?.())
    .then((result) => {
      launchSettled = true
      const url = result?.url
      const alreadyDelivered = seenBeforeLaunchSettled.has(url)
      seenBeforeLaunchSettled.clear()
      if (!url || alreadyDelivered) return
      spendNextEventMatching = url
      deliver(url)
    })
    .catch(() => {
      launchSettled = true
      seenBeforeLaunchSettled.clear()
    }) // no launch URL, or a packaging layer that does not implement one

  return () => {
    if (stopped) return
    stopped = true
    Promise.resolve(handle).then((h) => h?.remove?.()).catch(() => {})
  }
}
