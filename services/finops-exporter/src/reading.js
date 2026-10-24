/**
 * A Reading is the ONLY thing a collector may return (spec 089, FR-006).
 *
 * The three states are constructed by three functions, and only one of them accepts a value. That is
 * the enforcement: there is no code path that produces "zero because the read failed", because the
 * constructor for a failed read takes no number. A `?? 0` has nowhere to live.
 *
 * This matters more here than anywhere else in the codebase. On a cost dashboard, a source that
 * failed to load and a source that cost nothing are the difference between "we are fine" and "we are
 * bleeding and blind", and they render identically the moment a zero is allowed to stand in for an
 * absence.
 */

export const READ = 'read'
export const NOT_CONFIGURED = 'not-configured'
export const UNREADABLE = 'unreadable'

/**
 * A successful read.
 *
 * @param {number} value   the number. Must be finite — NaN/Infinity are unreadable, not read.
 * @param {string} unit
 * @param {object} [extra] `labels` merged into the emitted series; `at` overrides the timestamp.
 */
export function read(value, unit, extra = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    // A NaN that reaches a gauge renders as a gap that looks exactly like an outage, and an
    // Infinity in a runway metric reads to an alert rule as "infinite runway, all is well".
    return unreadable(`collector produced a non-finite value (${String(value)})`)
  }
  return {
    state: READ,
    value,
    unit,
    at: extra.at ?? Date.now(),
    labels: extra.labels ?? {},
    reason: null,
  }
}

/**
 * The source has no credential/config. Nothing is broken; it simply is not wired up.
 *
 * This is a first-class state, not a soft failure: it does not alert, does not count as an outage,
 * and says something actionable ("we have not wired this up") where a zero would say something
 * untrue ("we wired it up and it earns nothing"). Research R7 — the unset OpenSea/Gains/GMX
 * attribution ids are exactly this.
 */
export function notConfigured(reason = null) {
  return { state: NOT_CONFIGURED, value: null, unit: null, at: Date.now(), labels: {}, reason }
}

/**
 * The source IS configured and could not be read. Distinct from not-configured, and the distinction
 * decides whether anyone gets paged.
 *
 * `reason` is redacted before it is ever rendered or logged (FR-025).
 */
export function unreadable(reason) {
  return { state: UNREADABLE, value: null, unit: null, at: Date.now(), labels: {}, reason: redact(String(reason ?? 'unknown')) }
}

/**
 * Strip anything credential-shaped from a failure reason before it reaches a metric label, a log
 * line or the summary endpoint (FR-025).
 *
 * Errors from HTTP clients routinely embed the request URL, and vendor tokens ride in query strings
 * and headers often enough that echoing an error verbatim is a real leak path.
 */
export function redact(text) {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1<redacted>')
    .replace(/(x-api-key\s*[:=]\s*)\S+/gi, '$1<redacted>')
    .replace(/([?&](?:key|token|api[_-]?key|access[_-]?token|secret)=)[^&\s]+/gi, '$1<redacted>')
    .replace(/\b(0x)?[A-Fa-f0-9]{64}\b/g, '<redacted-key-material>')
    .slice(0, 300)
}

/**
 * How long one collection may run before it is reported `unreadable` rather than waited on.
 *
 * A VENDOR THAT NEVER ANSWERS IS NOT DISTINGUISHABLE FROM ONE THAT SAID NO, and both are
 * `unreadable` — but only if something eventually says so. Without a deadline a hung fetch or an
 * RPC that accepts a connection and goes quiet holds its source's in-flight slot forever, so that
 * source is never polled again and its last reading ages silently while every other source looks
 * healthy. The staleness signal exists, but a never-resolving promise is the one failure it cannot
 * see, because nothing ever writes a new reading for it to be stale about.
 *
 * Generous on purpose: the slowest legitimate collector is the BigQuery billing query. This is a
 * backstop against a hang, not a latency budget.
 */
const DEFAULT_DEADLINE_MS = 120_000

/**
 * Run a collector function and normalize ANY throw into `unreadable` (FR-007).
 *
 * Failure isolation lives here rather than in each collector so that a collector cannot forget it.
 * One vendor being down must never fail the scrape or hide the other twenty-four sources.
 */
export async function attempt(fn, { deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
  let timer
  try {
    const result = await Promise.race([
      fn(),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve(unreadable(`collector did not answer within ${Math.round(deadlineMs / 1000)}s`)),
          deadlineMs,
        )
        // Never hold the event loop open for the deadline itself.
        timer.unref?.()
      }),
    ])
    // A collector that returns nothing has a bug; reporting `read` with undefined would be worse
    // than reporting it unreadable, because it would enter the totals.
    if (!result || typeof result.state !== 'string') {
      return unreadable('collector returned no Reading')
    }
    return result
  } catch (err) {
    return unreadable(err?.message ?? err)
  } finally {
    clearTimeout(timer)
  }
}
