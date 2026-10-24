/**
 * Chunked, resumable event-log scanning (spec 089).
 *
 * Public RPC endpoints cap `eth_getLogs` ranges (commonly 1k–10k blocks) and answer an over-wide
 * range with an error rather than a truncated result. Scanning in chunks is therefore not an
 * optimisation — an unchunked scan simply fails on every provider we use.
 *
 * The cursor is what makes the counters cumulative: each pass resumes where the last finished, so a
 * revenue counter accumulates instead of re-reporting the same window forever.
 */

import { sharedRateLimiter } from './rateLimit.js'

const DEFAULT_CHUNK = 2_000

/**
 * How many logs one scan may accumulate before it is treated as a mis-specified filter.
 *
 * THIS IS A GATE, NOT A TUNING KNOB. Every filter in this exporter is scoped to a FairWins contract
 * or to an indexed address on a token, and each yields tens of logs per pass — three orders of
 * magnitude under this. A scan that blows through it is not a busy day; it is a filter that forgot
 * to narrow, and the only two outcomes available to it are "throw" and "exhaust the container".
 *
 * That is not hypothetical. The x402 collector asked for every `Transfer` on Polygon USDC and
 * filtered in JS: ~1.1M logs and ~635 MB of raw JSON over the default lookback, inside a 192 MB
 * limit. The process was OOM-killed before `app.listen()` on every boot — 5,966 consecutive times —
 * so the exporter never served a scrape and EVERY FinOps panel read "no data". A crash before the
 * listener is the worst shape this failure can take, because it takes down the twenty-four sources
 * that were fine along with the one that was wrong, and it does it silently: there is no metric to
 * carry the bad news when the thing that publishes metrics is the thing that died.
 *
 * Throwing turns that into one `unreadable` source with a reason that names the filter.
 */
const DEFAULT_MAX_LOGS = 50_000

/**
 * Scan `[fromBlock, toBlock]` for a filter, in chunks.
 *
 * Throws on failure rather than returning partial results. A partial log scan silently understates
 * revenue, and an understated revenue number that looks successful is worse than a source that
 * honestly reports itself unreadable (FR-006).
 */
export async function scanLogs(
  provider,
  filter,
  fromBlock,
  toBlock,
  { chunk = DEFAULT_CHUNK, maxLogs = DEFAULT_MAX_LOGS, limiter = null } = {},
) {
  // The process-wide pace (#1585). Resolved per CALL rather than captured at module load, so
  // `configureSharedRateLimit` at boot is picked up by collectors that were built before it.
  const pace = limiter ?? sharedRateLimiter()
  const out = []
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock)
    await pace.acquire()
    const logs = await provider.getLogs({ ...filter, fromBlock: start, toBlock: end })
    out.push(...logs)
    if (out.length > maxLogs) {
      // Named parts only — a topic array is the diagnostic detail that says WHICH filter is too wide.
      throw new Error(
        `log scan exceeded ${maxLogs} entries at block ${end} (address=${filter.address ?? 'any'}, ` +
          `topics=${JSON.stringify(filter.topics ?? null)}); the filter is too wide to hold in memory`,
      )
    }
  }
  return out
}

/**
 * Per-(chain, topic) scan cursors.
 *
 * In memory only. On restart the exporter resumes from `head - lookbackBlocks`, so counters restart
 * from that point — which the dashboard states as "since exporter start" rather than implying
 * all-time totals it does not have. Persisting cursors would mean owning a datastore, and a
 * datastore whose corruption silently understates revenue is a worse failure than a documented
 * restart boundary.
 */
export function createCursorStore() {
  const cursors = new Map()
  return {
    get(key, fallback) {
      return cursors.get(key) ?? fallback
    },
    set(key, block) {
      cursors.set(key, block)
    },
    /** Cumulative totals survive a cursor advance; the cursor only says where to read NEXT. */
    accumulate(key, delta) {
      const k = `total:${key}`
      const next = (cursors.get(k) ?? 0n) + delta
      cursors.set(k, next)
      return next
    },
    total(key) {
      return cursors.get(`total:${key}`) ?? 0n
    },
  }
}
