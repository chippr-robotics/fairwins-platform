/**
 * A shared pace for outbound RPC (spec 089, #1585).
 *
 * THE LIMIT WE ARE RESPECTING IS NOT OURS. The keyed Polygon endpoint is capped at 50 req/s and
 * that budget is SHARED with the gateway and the bundler — the paths that actually move money
 * (`docs/architecture/workbook/06-external-vendors.md`). A reporting service must never be able to
 * spend a value path's headroom, so this exporter deliberately takes at most half by default and
 * leaves the rest alone.
 *
 * WHY A PACE AND NOT A CONCURRENCY CAP. They bound different things, and the vendor limits the one
 * a concurrency cap does not. Four workers issuing 100ms requests is 40 req/s; the same four
 * against a fast endpoint is 400. Concurrency bounds how many are in flight, which is a proxy for
 * rate only if you know the latency — and the moment the endpoint gets faster, the proxy breaks in
 * the direction that hurts. So the scheduler bounds concurrency (for memory and fairness) and this
 * bounds RATE, which is the thing with a number attached to it.
 *
 * Deliberately NOT a token bucket. A bucket permits a burst up to its size, and a burst is exactly
 * the failure mode here: the exporter's boot fan-out put ~11 sources × 25 log chunks onto the wire
 * at once and took eleven sources `unreadable` with `-32007` for about two minutes on every
 * restart. An evenly-spaced gap has no burst to allow.
 */

/** A limiter that permits everything — the honest representation of "not configured". */
const UNLIMITED = { acquire: async () => {}, perSecond: null }

export function createRateLimiter({ perSecond, now = () => Date.now(), sleep = defaultSleep } = {}) {
  // 0 or unset disables pacing rather than deadlocking on a zero rate. A misconfigured limiter that
  // silently stops every read would be a far worse outage than the one it is preventing.
  if (!perSecond || !Number.isFinite(perSecond) || perSecond <= 0) return UNLIMITED

  const minGapMs = 1000 / perSecond
  let nextAt = 0

  return {
    perSecond,
    /**
     * Resolves when the caller may issue its request.
     *
     * The slot is reserved SYNCHRONOUSLY (`nextAt` advances before the await), so concurrent
     * callers queue behind each other deterministically instead of all reading the same clock and
     * all deciding they may go now.
     */
    async acquire() {
      const t = now()
      const at = Math.max(t, nextAt)
      nextAt = at + minGapMs
      const wait = at - t
      if (wait > 0) await sleep(wait)
    },
  }
}

/**
 * NOT `unref()`ed, unlike the scheduler's interval timers, and the difference is the point.
 *
 * An interval is a background schedule — abandoning it at exit loses nothing. A pacing delay sits
 * INSIDE a request that is already in flight: unref it and, with nothing else holding the loop, the
 * process exits mid-collection and `acquire()` simply never resolves. Caught by the first script
 * that used this without a listening server, which exited silently at the first `await`.
 *
 * The delay is bounded by construction (1000/perSecond ms), so holding the loop for it costs a few
 * tens of milliseconds at shutdown and cannot hang anything.
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The process-wide limiter used by `scanLogs`.
 *
 * A module-level default rather than a parameter threaded through every collector: the thing being
 * protected is a per-PROCESS budget against one vendor, so a per-call limiter would bound each
 * caller separately and bound the total not at all. `scanLogs` still accepts an explicit `limiter`
 * so tests never depend on this.
 */
let shared = UNLIMITED

export function configureSharedRateLimit(perSecond) {
  shared = createRateLimiter({ perSecond })
  return shared
}

export function sharedRateLimiter() {
  return shared
}
