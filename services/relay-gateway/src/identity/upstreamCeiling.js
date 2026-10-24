/**
 * Per-upstream spend ceilings (spec 106, FR-013).
 *
 * ── A CAP CHECKED AFTER THE CALL BOUNDS NOTHING ──────────────────────────────────────────────
 *
 * The requirement says "enforced BEFORE the upstream is called", and the word is doing real work.
 * A limit applied to the response is a receipt, not a budget: by then the request has been made,
 * the vendor has counted it, and — for a metered API — we have already been billed for it. The
 * only cap that bounds anything runs before the fetch.
 *
 * ── WHY THIS WRAPS THE CLIENT AND NOT THE ROUTE ──────────────────────────────────────────────
 *
 * The obvious place is the route's `guard()`, alongside the per-caller quota. That would be wrong,
 * because most requests to these modules are served from cache and NEVER TOUCH THE UPSTREAM. A
 * route-level ceiling would count cache hits against the vendor's budget, so a well-cached endpoint
 * under heavy read load would exhaust a ceiling it was not spending — refusing callers to protect a
 * credential nobody was using.
 *
 * Wrapping the client puts the check exactly where the money is: one tick per real outbound call.
 *
 * ── THIS IS NOT THE PER-CALLER QUOTA, AND THEY ANSWER DIFFERENT QUESTIONS ────────────────────
 *
 *   per-caller quota  "is THIS caller taking more than their share?"   -> fair use
 *   upstream ceiling  "are we about to overspend THIS credential?"     -> blast radius
 *
 * A single abusive caller is caught by the first. A leaked credential, a broken client looping, or
 * simply more legitimate traffic than the vendor plan allows is caught only by the second. Both are
 * needed, and neither substitutes for the other.
 *
 * ── HONEST FAILURE ───────────────────────────────────────────────────────────────────────────
 *
 * Hitting the ceiling is a 429 with `upstream_ceiling_reached` — a distinct code from the
 * per-caller `quota_exceeded`, because a caller who has taken nothing must not be told they have
 * taken too much. The reason says the platform is at its limit for this data source, which is the
 * truth and is actionable by an operator rather than confusing to a member.
 */

import { GatewayError } from '../errors.js'

/**
 * @param {Record<string, number>} limits   upstreamId -> max calls per window (0/absent = unlimited)
 * @param {number} windowMs
 * @param {() => number} [now]
 */
export function createUpstreamCeilings(limits = {}, windowMs = 60_000, now = () => Date.now()) {
  /** @type {Map<string, number[]>} upstreamId -> call timestamps */
  const calls = new Map()
  /** Cumulative since boot, counted for EVERY outbound call — unlimited upstreams included —
   * because the FinOps usage series (#1447) is attribution, not enforcement, and an uncapped
   * upstream is exactly the one whose consumption most needs to be visible. */
  const cumulative = Object.create(null)

  const prune = (arr, cutoff) => {
    let i = 0
    while (i < arr.length && arr[i] <= cutoff) i += 1
    return i > 0 ? arr.slice(i) : arr
  }

  return {
    /**
     * Count one outbound call, or throw if the ceiling is already reached.
     *
     * THROWS rather than returning a verdict, deliberately: a boolean invites a caller to make the
     * request anyway and check afterwards, which is the failure mode this whole module exists to
     * prevent. There is no way to use this and still spend past the cap.
     */
    take(upstreamId) {
      cumulative[upstreamId] = (cumulative[upstreamId] ?? 0) + 1
      const limit = limits[upstreamId]
      if (!limit || limit <= 0) return // unset means unlimited — an ABSENT cap, stated as such

      const t = now()
      const live = prune(calls.get(upstreamId) ?? [], t - windowMs)
      if (live.length >= limit) {
        calls.set(upstreamId, live)
        const retryAfterSec = Math.max(1, Math.ceil((live[0] + windowMs - t) / 1000))
        throw new GatewayError(
          429,
          'upstream_ceiling_reached',
          `this platform is at its configured limit for ${upstreamId} data right now; try again shortly`,
          { retryAfterSec }
        )
      }
      live.push(t)
      calls.set(upstreamId, live)
    },

    /** Cumulative outbound calls since boot, per upstream — the counter the FinOps exporter
     * scrapes (rate() over it survives restarts like any Prometheus counter). */
    cumulative() {
      return { ...cumulative }
    },

    /** Operator telemetry: calls made in the current window, per upstream. Never a member label. */
    snapshot() {
      const t = now()
      const out = {}
      for (const [id, arr] of calls) out[id] = prune(arr, t - windowMs).length
      return out
    },
  }
}

/**
 * Wrap an upstream client so every method that reaches the network ticks the ceiling first.
 *
 * ASSUMES ASYNC METHODS, which is true of everything it wraps: these are network clients, and every
 * method that could breach a ceiling is one that makes a request. A ceiling breach is surfaced as a
 * rejected promise so the method keeps ONE contract regardless of budget state.
 *
 * Generic over the client shape: it proxies each function-valued property. That keeps this module
 * from having to know what OpenSea's client looks like versus Polymarket's, and means a NEW method
 * added to a client is covered automatically — the failure mode of an explicit method list is that
 * the one method somebody forgets is the one that spends without a cap.
 *
 * @template T
 * @param {T} client
 * @param {string} upstreamId
 * @param {{take: (id: string) => void}} ceilings
 * @returns {T}
 */
export function withUpstreamCeiling(client, upstreamId, ceilings) {
  if (!client || !ceilings) return client
  const wrapped = Object.create(Object.getPrototypeOf(client) || Object.prototype)
  for (const key of Reflect.ownKeys(client)) {
    const value = client[key]
    if (typeof value !== 'function') {
      wrapped[key] = value
      continue
    }
    wrapped[key] = (...args) => {
      // REJECT rather than throw synchronously. Every method this wraps performs network I/O and
      // returns a promise, so a synchronous throw on the ceiling path would give the function two
      // different contracts depending on whether the budget happened to be exhausted — fine for a
      // caller that `await`s inside try/catch, broken for one that uses `.catch()`. One contract.
      try {
        ceilings.take(upstreamId)
      } catch (err) {
        return Promise.reject(err)
      }
      return value.apply(client, args)
    }
  }
  return wrapped
}
