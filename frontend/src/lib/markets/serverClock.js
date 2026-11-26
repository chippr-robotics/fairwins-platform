/**
 * Server-clock ages (spec 114, R5).
 *
 * How old a price is must never depend on the device's wall clock: a phone set an hour wrong would
 * otherwise show every price as an hour stale (or, worse, from the future and therefore "live").
 * The gateway tells us two instants on ITS clock — when it last confirmed the value with the venue
 * (`confirmedAt`) and when it answered (`serverNow`) — and we add the time elapsed since the answer
 * arrived, measured on a MONOTONIC timer (`performance.now()`), which is immune to clock changes.
 *
 * This module never reads `Date.now()` or `new Date()` for "now".
 */

/** Milliseconds on the monotonic timer. Injectable everywhere it is used, for tests. */
export function monotonicNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : 0
}

function parseInstant(value) {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * Capture a gateway response's timestamps plus the monotonic receipt time. The result is opaque —
 * read it only through `ageMs`. An unparsable or missing timestamp is kept as null so that the age
 * is UNKNOWN rather than zero.
 */
export function stamp({ confirmedAt, serverNow } = {}, receivedAt = monotonicNow()) {
  return Object.freeze({
    confirmedAtMs: parseInstant(confirmedAt),
    serverNowMs: parseInstant(serverNow),
    receivedAt: Number.isFinite(receivedAt) ? receivedAt : null,
  })
}

/** The gateway's confirmation instant in epoch ms (gateway clock), or null. For display/identity only. */
export function confirmedAtMs(s) {
  return s && Number.isFinite(s.confirmedAtMs) ? s.confirmedAtMs : null
}

/**
 * Age of the stamped value in ms, or null when unknowable. Skew between the two gateway instants
 * that comes out negative clamps at 0 (a value cannot be younger than "just now").
 */
export function ageMs(s, now = monotonicNow()) {
  if (!s || !Number.isFinite(s.confirmedAtMs) || !Number.isFinite(s.serverNowMs)) return null
  if (!Number.isFinite(s.receivedAt) || !Number.isFinite(now)) return null
  const atResponse = Math.max(0, s.serverNowMs - s.confirmedAtMs)
  const sinceReceipt = Math.max(0, now - s.receivedAt)
  return atResponse + sinceReceipt
}
