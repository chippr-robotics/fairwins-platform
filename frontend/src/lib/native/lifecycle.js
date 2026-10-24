/**
 * Native lifecycle adapter (spec 102, contracts/native-runtime-seams.md §4).
 *
 * A backgrounded native WebView does not reliably fire `visibilitychange`, so
 * the app-lock's "hidden ⇒ engage immediately" rule (FR-025b) needs the OS's
 * own lifecycle signal there. This module is PURE EVENT MAPPING: no
 * thresholds, no policy, no storage — the lock policy stays exactly where it
 * is (`lib/applock/appLock.js` + `AppLockOverlay`), consuming this seam the
 * same way it consumes the DOM events.
 *
 * On web the subscription is INERT (a no-op unsubscribe): the overlay keeps
 * its existing `visibilitychange`/`pagehide` listeners, and an inert adapter
 * cannot double-fire beside them.
 */
import { App } from '@capacitor/app'

import { isNativeRuntime } from './runtime'

/**
 * Call `onHidden` whenever the native app leaves the foreground. Returns an
 * unsubscribe function. Inert (immediate no-op) on the web runtime.
 */
export function subscribeAppHidden(onHidden, { native = isNativeRuntime() } = {}) {
  if (!native) return () => {}

  // Capacitor 8 listener registration is async; keep the handle promises and
  // remove through them so an unsubscribe that races registration still wins.
  const handles = [
    App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) onHidden()
    }),
    // iOS also emits a bare `pause` as the app resigns active; mapping both is
    // belt-and-braces for the one event class the lock must never miss.
    App.addListener('pause', () => onHidden()),
  ]

  let removed = false
  return () => {
    if (removed) return
    removed = true
    for (const handle of handles) {
      Promise.resolve(handle).then((h) => h?.remove?.()).catch(() => {})
    }
  }
}
