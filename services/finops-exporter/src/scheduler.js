/**
 * Per-source collection scheduling with failure isolation (spec 089, FR-007, FR-009).
 *
 * Two properties, both of which are the point:
 *
 *   1. INTERVALS ARE PER SOURCE. An on-chain balance changes every block; the BigQuery billing
 *      export lags hours and is billable to query. One global interval would either make the runway
 *      alerts useless or make the exporter a cost center of its own (FR-029 would then be measuring
 *      the wrong thing about us).
 *
 *   2. ONE FAILING SOURCE FAILS ALONE. A collector that throws, hangs, or returns nonsense yields
 *      `unreadable` for its own source and touches nothing else. A scrape NEVER fails because a
 *      vendor is down — a 500 on /metrics would blank every panel including the ones that are fine.
 *
 * The scheduler holds the last Reading per source and serves it to the scrape. Scrapes are therefore
 * cheap and constant-time, and a slow vendor cannot stall Prometheus.
 */
import { attempt, notConfigured, unreadable } from './reading.js'

/** How much older than its own interval a reading may get before it counts as stale. */
const STALE_FACTOR = 3

/** How many sources the boot pass collects at once. See `collectAll` for why this is bounded. */
const DEFAULT_BOOT_CONCURRENCY = 4

export function createScheduler({
  sources,
  collectors,
  now = () => Date.now(),
  log = console.warn,
  bootConcurrency = DEFAULT_BOOT_CONCURRENCY,
}) {
  /** @type {Map<string, {reading: object, collectedAt: number, durationMs: number, lastSuccessAt: number|null}>} */
  const state = new Map()
  /**
   * Sources with a collection in flight.
   *
   * A collection slower than its own interval would otherwise have the next tick start on top of it:
   * concurrent polls of the same source, multiplying load on the exact vendor or RPC that is already
   * struggling. The guard makes each source strictly serial — a tick that arrives while one is
   * running is DROPPED, not queued, because a queue would just defer the pile-up.
   */
  const inFlight = new Set()
  const timers = []
  let running = false

  function collectorFor(source) {
    const c = collectors[source.collector]
    if (!c) {
      // A catalogue entry naming a collector that does not exist is a build-time mistake, but it
      // must not take the process down at runtime: the other twenty-four sources are still useful.
      return async () => unreadable(`no collector named '${source.collector}' is registered`)
    }
    return c
  }

  async function collectOne(source) {
    if (inFlight.has(source.id)) return state.get(source.id)?.reading
    inFlight.add(source.id)

    const started = now()
    try {
      const fn = collectorFor(source)
      const reading = await attempt(() => fn(source))
      const durationMs = now() - started

      /**
       * `lastSuccessAt` SURVIVES a failed collection.
       *
       * It is the scheduler that must remember this, not the registry: the registry is rebuilt from
       * scratch on every scrape, so a gauge derived from the CURRENT reading vanishes the moment a
       * source goes unreadable — taking with it the one number that says HOW LONG it has been
       * unreadable. A staleness alert would then see an absent series rather than a growing age,
       * which is the difference between "stale for 6 hours" and "no idea".
       */
      const previous = state.get(source.id)
      const lastSuccessAt = reading.state === 'read' ? reading.at : (previous?.lastSuccessAt ?? null)

      state.set(source.id, { reading, collectedAt: now(), durationMs, lastSuccessAt })

      if (reading.state === 'unreadable') {
        // Reasons are already redacted by the Reading constructor (FR-025).
        log(`[finops] ${source.id}: unreadable — ${reading.reason}`)
      }
      return reading
    } finally {
      inFlight.delete(source.id)
    }
  }

  return {
    /**
     * Collect everything once — BOUNDED, not all at once.
     *
     * This was `Promise.all(sources.map(collectOne))`, which put ~25 sources onto the wire
     * simultaneously, each then chunking `eth_getLogs` up to 25 times over the lookback. On every
     * restart that took eleven sources `unreadable` with the vendor's `-32007 50/second request
     * limit reached` for about two minutes, on an endpoint whose budget is SHARED with the gateway
     * and the bundler (#1585).
     *
     * A bound costs nothing that matters: this pass is a warm-up, and since #1577 the listener no
     * longer waits for it. A source not yet reached reports `unreadable` — honest, and renderable.
     *
     * Concurrency bounds how many are IN FLIGHT; the shared rate limiter in `chain/rateLimit.js`
     * bounds requests per SECOND. Both exist because they bound different things and only one of
     * them is what the vendor actually measures.
     */
    async collectAll({ concurrency = bootConcurrency } = {}) {
      const queue = [...sources]
      const workers = Math.max(1, Math.min(concurrency, queue.length))
      await Promise.all(
        Array.from({ length: workers }, async () => {
          for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            await collectOne(next)
          }
        }),
      )
    },

    start() {
      if (running) return
      running = true
      for (const source of sources) {
        // A `planned` source has nothing to collect — it declares no metric by construction.
        if (source.status === 'planned') {
          state.set(source.id, { reading: notConfigured('not yet live'), collectedAt: now(), durationMs: 0, lastSuccessAt: null })
          continue
        }
        const t = setInterval(() => {
          collectOne(source).catch((err) => log(`[finops] scheduler: ${source.id} ${err?.message ?? err}`))
        }, source.interval * 1000)
        // Never hold the event loop open for a timer; the HTTP server owns the process lifetime.
        t.unref?.()
        timers.push(t)
      }
    },

    stop() {
      for (const t of timers) clearInterval(t)
      timers.length = 0
      running = false
    },

    /**
     * The latest Reading per source.
     *
     * A source that has never been collected reports `unreadable`, not a missing entry — "we have
     * not managed to read this yet" is genuinely unreadable, and silently omitting it would drop it
     * off the partial-total check that is supposed to name it (FR-011).
     */
    readings() {
      return sources.map((source) => {
        const entry = state.get(source.id)
        if (!entry) {
          return { source, reading: unreadable('not collected yet'), durationMs: null, lastSuccessAt: null, stale: true }
        }
        const age = (now() - entry.collectedAt) / 1000
        return {
          source,
          reading: entry.reading,
          durationMs: entry.durationMs,
          lastSuccessAt: entry.lastSuccessAt,
          stale: age > source.interval * STALE_FACTOR,
        }
      })
    },
  }
}
