/**
 * Market-data seam (spec 114, R10): `subscribe(keys, onReadings) → unsubscribe`.
 *
 * Keys are venue-neutral, '<venue>:<instrument>' (e.g. 'polymarket:1116…'). Callers receive
 * PriceReadings only — the seam classifies them (priceReading.js), so nothing downstream ever holds a
 * bare price. At most ONE network conversation exists however many components subscribe: keys are
 * reference-counted, a key nobody holds stops being requested, and the last unsubscribe stops it all.
 *
 * Sources sit behind a tiny internal interface `{ start(keys, deliver), setKeys(keys), stop() }` so a
 * stream source can be added later without touching a caller. Slice 2 ships the proxy-poll source only.
 *
 * Imports nothing from components/ or hooks/. It never throws into a subscriber, and a subscriber that
 * throws cannot break another.
 */
import { fetchBooks } from '../predict/predictClient'
import { getNetwork, listSupportedChainIds } from '../../config/networks'
import { stamp as makeStamp, monotonicNow } from './serverClock'
import { classify, reclassify, unknown, displayPrice } from './priceReading'
import { setBooksRouteMissing } from './routeSupport'

export const POLL_MS = 2000
export const BACKOFF_MS = 10000
export const TICK_MS = 1000
export const BATCH_SIZE = 10

const POLYMARKET_PREFIX = 'polymarket:'

/** The chain Polymarket is served on, from the `capabilities.predict` flag — never a literal. */
function predictChainId() {
  return listSupportedChainIds().find((id) => getNetwork(id)?.capabilities?.predict) ?? null
}

const tokenOf = (key) => key.slice(POLYMARKET_PREFIX.length)
const isPolymarketKey = (key) => typeof key === 'string' && key.startsWith(POLYMARKET_PREFIX) && key.length > POLYMARKET_PREFIX.length

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible'

function readingFromBook(book, envelope, receivedAt) {
  const bids = Array.isArray(book.bids) ? book.bids : []
  const asks = Array.isArray(book.asks) ? book.asks : []
  const price = displayPrice(bids[0]?.[0], asks[0]?.[0], book.lastTradePrice ?? null)
  return classify(
    {
      price,
      bids,
      asks,
      stamp: makeStamp({ confirmedAt: envelope.confirmedAt, serverNow: envelope.serverNow }, receivedAt),
      stale: envelope.stale === true,
      extra: {
        tokenId: book.tokenId,
        tickSize: book.tickSize ?? null,
        minOrderSize: book.minOrderSize ?? null,
        lastTradePrice: book.lastTradePrice ?? null,
        venueTime: book.venueTime ?? null,
        venueHash: book.venueHash ?? null,
      },
    },
    receivedAt,
  )
}

/** Source A — one poller for the whole app. */
function createProxyPollSource() {
  let keys = []
  let deliver = () => {}
  let timer = null
  let running = false
  let inflight = false
  let dirty = false
  let delay = POLL_MS

  const clear = () => {
    if (timer != null) clearTimeout(timer)
    timer = null
  }
  const schedule = (ms) => {
    clear()
    if (running && isVisible()) timer = setTimeout(poll, ms)
  }

  async function poll() {
    timer = null
    if (!running || !isVisible() || inflight || keys.length === 0) return
    inflight = true
    dirty = false
    const snapshot = keys.slice()
    const chainId = predictChainId()
    let failed = chainId == null
    if (chainId != null) {
      const batches = []
      for (let i = 0; i < snapshot.length; i += BATCH_SIZE) batches.push(snapshot.slice(i, i + BATCH_SIZE))
      await Promise.all(
        batches.map(async (batch) => {
          try {
            const res = await fetchBooks(chainId, batch.map(tokenOf))
            if (!res || !Array.isArray(res.books)) throw new Error('malformed books response')
            setBooksRouteMissing(false)
            const receivedAt = monotonicNow()
            const unreadable = new Set((res.unreadable || []).map(String))
            const byToken = new Map(res.books.map((b) => [String(b.tokenId), b]))
            const out = new Map()
            for (const key of batch) {
              const token = tokenOf(key)
              const book = byToken.get(token)
              if (book) out.set(key, readingFromBook(book, res, receivedAt))
              else out.set(key, unknown(unreadable.has(token) ? 'unreadable' : 'missing'))
            }
            if (running) deliver(out)
          } catch (err) {
            failed = true // keep the last readings; they age on the tick
            // A gateway that has no books route (404) can never make a reading live: say so, so the order
            // surface can fall back to the fixed-price form. Any other failure is an outage, not an absence.
            if (err?.status === 404) setBooksRouteMissing(true)
          }
        }),
      )
    }
    inflight = false
    if (!running) return
    delay = failed ? BACKOFF_MS : POLL_MS
    schedule(dirty ? 0 : delay)
  }

  const onVisibility = () => {
    if (!running) return
    if (isVisible()) {
      if (!inflight) schedule(0)
    } else {
      clear()
    }
  }

  return {
    start(initialKeys, deliverFn) {
      keys = initialKeys.slice()
      deliver = deliverFn
      running = true
      delay = POLL_MS
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
      schedule(0)
    },
    setKeys(next) {
      const had = new Set(keys)
      const added = next.some((k) => !had.has(k))
      keys = next.slice()
      if (!running || !added) return
      dirty = true
      if (!inflight && delay === POLL_MS) schedule(0)
    },
    stop() {
      running = false
      clear()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}

/* ── seam state ── */
const held = new Map() // key → reference count
const subscribers = new Set() // { keys:Set<string>, cb }
const readings = new Map() // key → PriceReading
let source = null
let tickTimer = null

const polledKeys = () => [...held.keys()].filter(isPolymarketKey)

function notify(changed) {
  if (changed.size === 0) return
  for (const sub of [...subscribers]) {
    let subset = null
    for (const [key, reading] of changed) {
      if (sub.keys.has(key)) (subset ||= new Map()).set(key, reading)
    }
    if (!subset) continue
    try {
      sub.cb(subset)
    } catch {
      /* a subscriber's failure is its own */
    }
  }
}

function deliverFromSource(incoming) {
  const changed = new Map()
  for (const [key, reading] of incoming) {
    if (!held.has(key)) continue // nobody holds it any more
    readings.set(key, reading)
    changed.set(key, reading)
  }
  notify(changed)
}

function tick() {
  const now = monotonicNow()
  const changed = new Map()
  for (const [key, reading] of readings) {
    const next = reclassify(reading, now)
    if (next !== reading) {
      readings.set(key, next)
      changed.set(key, next)
    }
  }
  notify(changed)
}

function reconcile() {
  const keys = polledKeys()
  if (held.size === 0) {
    if (source) source.stop()
    source = null
    if (tickTimer != null) clearInterval(tickTimer)
    tickTimer = null
    return
  }
  if (tickTimer == null) tickTimer = setInterval(tick, TICK_MS)
  if (keys.length === 0) {
    if (source) source.stop()
    source = null
    return
  }
  if (!source) {
    source = createProxyPollSource()
    source.start(keys, deliverFromSource)
  } else {
    source.setKeys(keys)
  }
}

/**
 * Subscribe to PriceReadings for `keys`. `onReadings(Map<key, PriceReading>)` is called with whatever
 * changed (and once, immediately, with anything already known for these keys). Returns `unsubscribe`.
 */
export function subscribe(keys, onReadings) {
  const mine = new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k !== ''))
  const sub = { keys: mine, cb: typeof onReadings === 'function' ? onReadings : () => {} }
  subscribers.add(sub)

  const immediate = new Map()
  for (const key of mine) {
    held.set(key, (held.get(key) || 0) + 1)
    if (!isPolymarketKey(key) && !readings.has(key)) readings.set(key, unknown('unsupported-venue'))
    if (readings.has(key)) immediate.set(key, readings.get(key))
  }
  reconcile()
  if (immediate.size > 0) {
    try {
      sub.cb(immediate)
    } catch {
      /* ignore */
    }
  }

  let done = false
  return function unsubscribe() {
    if (done) return
    done = true
    subscribers.delete(sub)
    for (const key of mine) {
      const n = (held.get(key) || 0) - 1
      if (n > 0) held.set(key, n)
      else {
        held.delete(key)
        readings.delete(key)
      }
    }
    reconcile()
  }
}

export function __resetForTests() {
  if (source) source.stop()
  source = null
  if (tickTimer != null) clearInterval(tickTimer)
  tickTimer = null
  held.clear()
  subscribers.clear()
  readings.clear()
}
