/**
 * Executor nonce accountability (#1501).
 *
 * WHY THIS EXISTS, AND WHY BALANCE WAS NOT ENOUGH.
 * The pools collector watches the executor EOA's BALANCE, and `burnRate.js` derives a runway from
 * it. Both are correct, and together they cannot see the failure that has actually happened here.
 *
 * On 2026-07-12 alto served JSON-RPC for 40 minutes while its executor sent nothing. Every check
 * stayed green, and the only signal that ever fired was members reporting failures. Balance-based
 * monitoring cannot catch it BY CONSTRUCTION: a stalled executor spends nothing, so burn falls to
 * zero, so `runwaySeconds` correctly returns null (you cannot divide by a zero rate), so the series
 * disappears, so `min by (pool)` has nothing to compare and the alert's noDataState reads OK.
 *
 * A STALLED EXECUTOR AND A HEALTHY IDLE ONE PRODUCE IDENTICAL TELEMETRY, and the dashboard prefers
 * the healthy reading. Note the fix is NOT to make runway non-null on zero burn — null is the honest
 * answer there and spec 089 requires it. The fix is to observe the thing balance cannot express:
 * whether the executor is still SENDING.
 *
 * THREE READS, one nonce pair per chain:
 *   · `latest`  — transactions mined from this EOA. Advancing ⇒ bundles are landing.
 *   · `pending` — includes queued-but-unmined. The GAP (pending − latest) is queue depth: a
 *     persistent non-zero gap is a stuck transaction, and it is also the direct read for the nonce
 *     collision G-11 exists to prevent — two senders on one EOA produce a gap that does not drain.
 *   · elapsed since `latest` last CHANGED — staleness.
 *
 * STALENESS ALONE IS NOT A FAULT. An idle bundler has a frozen nonce and is perfectly healthy, so
 * this module reports the observation and never the verdict; pairing it with demand is the alert
 * rule's job, not this file's. Reporting "stalled" here would page every quiet night.
 *
 * SPEC 089 RULES BIND. A failed read is `unreadable`, never a zero and never a stale value carried
 * forward — a nonce that cannot be read says nothing about whether the executor is sending. Labels
 * are the bounded (pool, chain) pair already used by the pools collector, never an address.
 */
import { read, notConfigured, unreadable } from './reading.js'

/**
 * @param {object} deps
 * @param {object} deps.config      exporter config, carrying `pools`
 * @param {object} deps.providers   chainId -> ethers provider
 * @param {() => number} [deps.now] injectable clock (tests; never Date.now() inline)
 */
export function createExecutorNonceCollector({ config, providers, now = () => Date.now() }) {
  /** poolId -> { nonce, firstSeenAt, lastAdvancedAt } — in-process, like the balance history. */
  const seen = new Map()

  /**
   * Read one executor's nonce pair and derive staleness.
   * @returns {{nonce: object, gap: object, staleness: object}} three independent readings, so one
   *   failing leg cannot fabricate the others.
   */
  return async function collectExecutorNonce(poolId) {
    const pool = config.pools?.[poolId]
    if (!pool) return { nonce: notConfigured(`pool '${poolId}' is not configured`), gap: notConfigured(), staleness: notConfigured() }
    if (!pool.address) return { nonce: notConfigured(`pool '${poolId}' has no address`), gap: notConfigured(), staleness: notConfigured() }

    const provider = providers?.[pool.chain]
    if (!provider) {
      const why = `no provider for chain ${pool.chain}`
      return { nonce: notConfigured(why), gap: notConfigured(why), staleness: notConfigured(why) }
    }

    const labels = { pool: poolId, chain: String(pool.chain) }

    let latest
    let pending
    try {
      // Sequential, not Promise.all: if `latest` fails there is nothing to compare `pending` to,
      // and a half-read pair is exactly the kind of partial truth this codebase refuses to emit.
      latest = await provider.getTransactionCount(pool.address, 'latest')
      pending = await provider.getTransactionCount(pool.address, 'pending')
    } catch (err) {
      const why = `nonce read failed: ${err?.shortMessage || err?.message || 'unknown'}`
      // Deliberately NOT falling back to the previous sample. A nonce we could not read tells us
      // nothing about whether the executor is sending, and carrying the old one forward would let
      // an RPC outage masquerade as a healthy, steadily-advancing executor.
      return { nonce: unreadable(why), gap: unreadable(why), staleness: unreadable(why) }
    }

    if (!Number.isFinite(latest) || !Number.isFinite(pending)) {
      const why = 'provider returned a non-numeric nonce'
      return { nonce: unreadable(why), gap: unreadable(why), staleness: unreadable(why) }
    }

    const at = now()
    const prev = seen.get(poolId)
    if (!prev) {
      seen.set(poolId, { nonce: latest, firstSeenAt: at, lastAdvancedAt: at })
    } else if (latest > prev.nonce) {
      seen.set(poolId, { nonce: latest, firstSeenAt: prev.firstSeenAt, lastAdvancedAt: at })
    } else if (latest < prev.nonce) {
      // A nonce cannot go backwards for one account. Seeing it means the address changed under us,
      // or a provider served a stale/forked view. Either way the stored baseline is meaningless, so
      // reset rather than report a staleness measured against a number from a different world.
      seen.set(poolId, { nonce: latest, firstSeenAt: at, lastAdvancedAt: at })
    }
    const state = seen.get(poolId)

    // Seconds since the nonce last ADVANCED. On the first observation this is 0 by construction —
    // honest (we have watched for no time at all), and the alert rule must therefore require a
    // minimum observation window rather than trusting a fresh process.
    const stalenessSec = Math.max(0, Math.round((at - state.lastAdvancedAt) / 1000))
    const observedForSec = Math.max(0, Math.round((at - state.firstSeenAt) / 1000))

    return {
      nonce: read(latest, 'count', { labels }),
      // Queue depth. Zero is the healthy steady state; a gap that persists across polls is a stuck
      // transaction or two senders on one EOA (G-11).
      gap: read(pending - latest, 'count', { labels }),
      staleness: read(stalenessSec, 'seconds', { labels }),
      // OUTSIDE the Reading on purpose: `read()` builds a CLOSED shape (state/value/unit/at/
      // labels/reason) and drops anything else, so a field smuggled through `extra` is silently
      // lost. It rides here instead — an alert rule needs it to refuse to fire on a fresh process,
      // which honestly reports 0 staleness because it has watched for no time at all.
      observedForSec,
    }
  }
}
