/* FairWins service worker.
 *
 * Kept intentionally minimal: its job is to make the app a real, installable PWA
 * (Chromium's install criteria historically want a registered service worker with
 * a fetch handler) — NOT to aggressively cache. Aggressive caching of a web3 app
 * risks serving stale JS bundles against live on-chain state, so we only pre-cache
 * a tiny app-shell for an offline fallback and pass everything else straight to the
 * network. Bump CACHE_VERSION to invalidate the shell cache on deploy.
 */
const CACHE_VERSION = 'fairwins-shell-v1'
const OFFLINE_URLS = ['/', '/index.html', '/manifest.webmanifest']

/* ------------------------------------------------------------------------- *
 * Mini-app package cache (spec 073 T043, research R10)
 *
 * The one place this worker DOES cache aggressively, and it is safe for a
 * reason the shell cache cannot claim: package URLs are CONTENT-ADDRESSED.
 * `/ipfs/<cid>/<path>` names bytes by their own hash, so the bytes behind a
 * given URL can never change. A new app version is a new CID, which is a new
 * URL, which is a cache miss — the staleness risk that keeps the rest of this
 * worker network-first simply does not exist here.
 *
 * THIS CACHE IS NOT A TRUST BOUNDARY. The loader re-verifies every byte it gets
 * — manifest keccak against the on-chain hash, then per-file sha256 — AFTER the
 * response is handed over, cached or not. So a poisoned or corrupted cache
 * entry cannot execute; it fails the same integrity check a poisoned gateway
 * response would (FR-011). Nor can the cache resurrect a suspended app: launch
 * re-reads the registry first, and status is decided on-chain, never here
 * (FR-010).
 * ------------------------------------------------------------------------- */

const MINIAPP_CACHE = 'fairwins-miniapp-packages-v1'

/** Every cache this worker owns; anything else found at activate is swept. */
const OWNED_CACHES = [CACHE_VERSION, MINIAPP_CACHE]

/**
 * Entry ceiling for the package cache.
 *
 * Packages are small (one ES module plus stylesheets) but the origin's storage
 * budget is shared with the member's own data. A bound is not optional: without
 * one, every version of every app the member ever launched accumulates forever,
 * and the browser evicts the whole origin — including the member's ledger and
 * address book — rather than the part that is disposable.
 */
const MINIAPP_CACHE_MAX_ENTRIES = 60

/**
 * Where the LRU index lives, inside the package cache itself.
 *
 * The Cache API records no access time and no insertion order, so eviction
 * needs its own bookkeeping. An in-memory Map would be wrong: a service worker
 * is terminated aggressively between events, so the index would reset to empty
 * every few minutes and the cache would grow unbounded while believing it was
 * empty. Keeping it in the cache means it survives exactly as long as the
 * entries it describes.
 *
 * The host is `.invalid` (RFC 2606) so this synthetic key can never collide
 * with a real gateway URL and can never be resolved on a network.
 */
const MINIAPP_INDEX_URL = 'https://miniapp-cache-index.fairwins.invalid/index.json'

/** CIDv0 (`Qm…`, base58btc) or CIDv1 (`b…`, base32) — the two forms a gateway serves. */
const CID_PATTERN = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})$/

/**
 * Is this a mini-app package file?
 *
 * Classified by URL SHAPE — an `/ipfs/<cid>/<path>` path — rather than against a
 * gateway allowlist, because the worker has no access to the app's build-time
 * gateway configuration and a member may point the app at their own gateway
 * (spec 069's bring-your-own-node principle). Shape is the honest test anyway:
 * what makes cache-first safe is that the URL names its own content, and that
 * is true of any gateway serving that path.
 *
 * A bare `/ipfs/<cid>` with no file path is NOT matched — the loader always
 * requests a named file within the package, and a directory listing is not
 * content whose immutability we can reason about.
 */
function isMiniAppPackageUrl(rawUrl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 3 || segments[0] !== 'ipfs') return false
  return CID_PATTERN.test(segments[1])
}

/** Is this one of our own URLs? Same parse guard as above — an unparseable URL is not ours. */
function isSameOrigin(rawUrl) {
  try {
    return new URL(rawUrl).origin === self.location.origin
  } catch {
    return false
  }
}

/**
 * Move `url` to the head of the LRU index and report what that pushes out.
 *
 * Pure — no Cache API, no clock, no worker state — so the eviction policy can
 * be tested directly (T044) instead of inferred from cache behaviour.
 *
 * @param {string[]} index - urls, most recently used FIRST
 * @param {string} url
 * @param {number} max
 * @returns {{index: string[], evict: string[]}}
 */
function touchMiniAppIndex(index, url, max) {
  const withoutUrl = (Array.isArray(index) ? index : []).filter(
    (entry) => typeof entry === 'string' && entry !== url,
  )
  const next = [url, ...withoutUrl]
  const limit = Math.max(1, max)
  return { index: next.slice(0, limit), evict: next.slice(limit) }
}

/** Read the LRU index, tolerating a missing or damaged one (it is a hint, not data). */
async function readMiniAppIndex(cache) {
  try {
    const stored = await cache.match(MINIAPP_INDEX_URL)
    if (!stored) return []
    const parsed = await stored.json()
    return Array.isArray(parsed) ? parsed.filter((e) => typeof e === 'string') : []
  } catch {
    return []
  }
}

/** Record a use of `url` and evict whatever that pushes past the ceiling. */
async function recordMiniAppUse(cache, url) {
  try {
    const { index, evict } = touchMiniAppIndex(await readMiniAppIndex(cache), url, MINIAPP_CACHE_MAX_ENTRIES)
    await Promise.all(evict.map((stale) => cache.delete(stale)))
    await cache.put(
      MINIAPP_INDEX_URL,
      new Response(JSON.stringify(index), { headers: { 'Content-Type': 'application/json' } }),
    )
  } catch {
    // Bookkeeping is best-effort. Failing to record a use must never fail the
    // fetch that triggered it — the worst case is an over-large cache the
    // browser will evict on its own terms.
  }
}

/**
 * Cache-first for one package file.
 *
 * On a miss the network response is cached only when it is a real, readable
 * success: an `opaque` response has an unreadable body and an unknowable
 * status, so storing one would occupy the budget with bytes nothing can use.
 * A failed revalidation falls back to the cached copy — the bytes are still
 * verified downstream, so serving them offline is safe.
 */
async function serveMiniAppPackage(request) {
  const cache = await caches.open(MINIAPP_CACHE)
  const cached = await cache.match(request)
  if (cached) {
    await recordMiniAppUse(cache, request.url)
    return cached
  }
  const response = await fetch(request)
  if (response && response.ok && response.type !== 'opaque') {
    try {
      await cache.put(request, response.clone())
      await recordMiniAppUse(cache, request.url)
    } catch {
      // Quota or a non-storable response — serve it anyway.
    }
  }
  return response
}

self.addEventListener('install', (event) => {
  // NOTE: we deliberately do NOT call skipWaiting() here. On a fresh install there is
  // no controlling worker, so the new worker activates immediately anyway. On an UPDATE
  // the old worker keeps controlling open tabs and the new one parks in `waiting` until
  // the user approves the update (the app posts SKIP_WAITING). This gives a controlled,
  // user-driven update flow instead of swapping bundles out from under a live session.
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(OFFLINE_URLS).catch(() => undefined))
  )
})

// The page posts { type: 'SKIP_WAITING' } when the user clicks "Update now"; that
// promotes this waiting worker to active, which fires `controllerchange` on the client.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      // Sweep caches this worker no longer owns. The package cache MUST be in
      // OWNED_CACHES: it is not versioned with the shell (its entries are
      // immutable and outlive a deploy), so a bare `k !== CACHE_VERSION` filter
      // would silently delete every cached package on every activation.
      .then((keys) => Promise.all(keys.filter((k) => !OWNED_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

// Activity notifications. When the running PWA raises a system
// notification for a 'push'-mode activity entry (via registration.showNotification),
// tapping it must focus the app and deep-link to that entry. The entry's router
// link ({ to, state }) rides along in notification.data; we hand it to a focused
// client (the ActivityNotificationBridge performs the in-app navigation) or, if
// no window is open, open one at the link's path.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = (event.notification.data && event.notification.data.link) || null
  const targetPath = (link && link.to) || '/app'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus()
          client.postMessage({ type: 'ACTIVITY_NAVIGATE', link: link || { to: targetPath } })
          return undefined
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(targetPath) : undefined
    })
  )
})

// Forward-compat: real server-initiated Web Push. There is no push backend today
// (notifications are derived client-side), but wiring this listener now means a
// future backend can deliver push without another service-worker change.
self.addEventListener('push', (event) => {
  let payload
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }
  const title = payload.title || 'FairWins'
  const options = {
    body: payload.body || payload.message || 'New activity',
    icon: '/assets/fairwins_no-text_logo.svg',
    badge: '/assets/fairwins_no-text_logo.svg',
    tag: payload.tag || 'fairwins-activity',
    data: { link: payload.link || null },
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  // Only handle GET navigations for the offline fallback; everything else is network-only.
  if (request.method !== 'GET') return

  // Mini-app package files are content-addressed and therefore cache-first
  // (spec 073 T043). Checked before the navigation branch because a package URL
  // is never a navigation, and before the network-only default because this is
  // the one class of request where a cached copy cannot be stale.
  if (isMiniAppPackageUrl(request.url)) {
    event.respondWith(serveMiniAppPackage(request))
    return
  }

  // Everything past this point is an offline fallback for THIS origin's own shell. A
  // cross-origin GET — an analytics beacon, a CDN font, a third-party pixel — has no entry
  // in our cache and no offline story, so intercepting it can only make things worse, and
  // did: `respondWith` rejects the request outright when its promise resolves to
  // `undefined`, which is exactly what `caches.match` returns on a miss. One beacon
  // stopped by a content blocker therefore became a pair of console errors on every load
  // ("resulted in a network error response: the promise was rejected", then "Failed to
  // convert value to 'Response'"). Declining to intercept leaves the browser to fail it
  // natively and silently, precisely as it would with no worker installed.
  //
  // Mini-app packages are the one deliberately cross-origin class this worker must serve,
  // and they are matched above, before this guard.
  if (!isSameOrigin(request.url)) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () =>
        (await caches.match(request)) || (await caches.match('/index.html')) || Response.error()
      )
    )
    return
  }

  // Non-navigation same-origin GETs: try network, fall back to any cached shell asset if
  // offline. `Response.error()` is the floor — a cache miss must surface as the network
  // failure it actually is, never as `undefined`, which `respondWith` cannot convert.
  event.respondWith(
    fetch(request).catch(async () => (await caches.match(request)) || Response.error())
  )
})
