/**
 * Prepaid gas pool collector (spec 089, FR-015; research R6).
 *
 * The paymaster deposit and the executor EOAs are prepaid pools. When one empties, sponsorship or
 * relaying stops and members see failures — and today the ONLY signal that has ever produced is
 * members reporting failures (it happened on 2026-07-12). This collector is the reason the feature
 * has a P1 alerting story.
 *
 * The collector reports the BALANCE. Burn rate and runway are derived by `burnRate.js` from the
 * balance history, and the runway is deliberately absent rather than infinite when it cannot be
 * known — an `+Inf` runway reads to an alert rule as the healthiest possible pool.
 */
import { ethers } from 'ethers'
import { read, notConfigured } from '../reading.js'

/** EntryPoint v0.6: the paymaster's sponsorship deposit is held here, not on the paymaster. */
const ENTRYPOINT_IFACE = new ethers.Interface(['function balanceOf(address account) view returns (uint256)'])

export function createPoolsCollector({ config, providers, burn, executorNonce = null, nonceState = new Map() }) {
  /**
   * @param {object} source catalogue entry carrying `pool`
   */
  return async function collectPool(source) {
    const poolId = source.pool
    const pool = config.pools[poolId]
    if (!pool) return notConfigured(`pool '${poolId}' is not configured`)

    const provider = providers[pool.chain]
    if (!provider) return notConfigured(`no provider for chain ${pool.chain}`)

    let balanceWei
    if (pool.kind === 'paymaster') {
      if (!config.contracts.paymaster) return notConfigured('PAYMASTER_ADDRESS_137 is not set')
      // Read the deposit from the EntryPoint. Reading the paymaster's own native balance would be a
      // different and misleading number: a paymaster holding 0 native can still be fully funded,
      // because the deposit lives at the EntryPoint.
      const data = ENTRYPOINT_IFACE.encodeFunctionData('balanceOf', [config.contracts.paymaster])
      const raw = await provider.call({ to: config.contracts.entryPoint, data })
      ;[balanceWei] = ENTRYPOINT_IFACE.decodeFunctionResult('balanceOf', raw)
    } else {
      if (!pool.address) return notConfigured(`no address configured for pool '${poolId}'`)
      balanceWei = await provider.getBalance(pool.address)
    }

    const balance = Number(ethers.formatEther(balanceWei))
    burn.observe(poolId, balance)

    // The executor's NONCE, read on the same schedule and stashed as side detail (#1539) — the
    // `emitGcpDetail`/`emitCloudflareUsage` pattern, because buildRegistry is synchronous and a
    // chain read cannot happen at render time.
    //
    // Deliberately isolated: a nonce failure must NEVER cost us the balance reading. They answer
    // different questions and the balance is the one with an alert already attached.
    //
    // Only executor pools have a nonce. A paymaster's funds live at the EntryPoint under a contract
    // that sends nothing itself, so `getTransactionCount` on it would be a meaningless zero — the
    // kind of confident wrong number this codebase spends most of its comments preventing.
    if (executorNonce && pool.kind !== 'paymaster') {
      try {
        nonceState.set(poolId, await executorNonce(poolId))
      } catch {
        // The collector already reports its own failures as `unreadable` readings; this catch is
        // only for an unexpected throw, and dropping the sample is honest — a stale nonce carried
        // forward would let an outage look like a steadily advancing executor.
        nonceState.delete(poolId)
      }
    }

    return read(balance, pool.unit, { labels: { pool: poolId, chain: String(pool.chain) } })
  }
}

/**
 * Emit the derived pool series: balance, burn rate, runway, and the window's spend as cost.
 *
 * Called by the server after the scheduler's readings are in, because these are functions of the
 * balance history rather than independent reads.
 *
 * @param {object} registry
 * @param {Array<{source: object, reading: object}>} readings
 * @param {object} burn burn tracker
 * @param {(unit: string) => number|null} usdRate  price lookup; null when unknown
 */
export function emitPoolSeries(registry, readings, burn, usdRate) {
  for (const { source, reading } of readings) {
    if (!source.pool) continue

    const poolId = source.pool
    const chain = String(source.chains?.[0] ?? '')

    if (reading.state !== 'read') continue

    registry.emit(
      'pool_balance',
      'gauge',
      'Current balance of a prepaid gas pool, in its native unit.',
      { pool: poolId, unit: source.unit, chain },
      reading.value,
    )

    const rate = burn.burnRatePerSec(poolId)
    if (rate != null) {
      registry.emit(
        'pool_burn_rate',
        'gauge',
        'Trailing-window burn per second for a prepaid pool, counting only decreases so a top-up cannot read as negative burn.',
        { pool: poolId, unit: source.unit, chain },
        rate,
      )
    }

    // ABSENT, not infinite, when unknowable. This is the single most important line in the file:
    // an +Inf here would make every runway alert permanently green for a pool nobody can measure.
    const runway = burn.runwaySeconds(poolId, reading.value)
    if (runway != null) {
      registry.emit(
        'pool_runway_seconds',
        'gauge',
        'Seconds until a prepaid pool empties at the trailing burn rate. Absent when the burn rate is zero or not yet known.',
        { pool: poolId, chain },
        runway,
      )
    }

    // The pool's spend over the window, converted only if a price is actually available (FR-013).
    const spent = burn.spentInWindow(poolId)
    const price = usdRate(source.unit)
    if (spent != null && price != null) {
      registry.emit(
        'cost_usd_total',
        'counter',
        source.meaning,
        { source: source.id, basis: source.basis, unit: 'USD', chain },
        spent * price,
      )
    }
  }
}

/**
 * Emit the executor's nonce series (#1539).
 *
 * WHY THIS EXISTS BESIDE THE BALANCE SERIES. Balance-based monitoring cannot see a stalled
 * executor BY CONSTRUCTION: a stall spends nothing, so burn falls to zero, so `runwaySeconds`
 * correctly returns null (there is no dividing by a zero rate), so the series disappears, so
 * `min by (pool)` has nothing and the alert's noDataState reads OK. A stalled executor and a
 * healthy idle one produce identical telemetry, and the dashboard prefers the healthy reading.
 * That is the 2026-07-12 shape, in which alto served RPC for 40 minutes while its executor sent
 * nothing and the only alarm was members reporting failures.
 *
 * These three series are what balance cannot express. NONE of them is a verdict: an idle bundler
 * has a frozen nonce and is perfectly healthy, so `staleness` must be read against DEMAND
 * (`sponsored_ops_total`) by the alert rule, never alone. Emitting a "stalled" boolean here would
 * page every quiet night, and an alarm that cries wolf is how this failure class survives.
 *
 * @param {object} registry
 * @param {Map<string, {nonce: object, gap: object, staleness: object}>} nonceState
 */
export function emitExecutorNonce(registry, nonceState) {
  for (const [poolId, detail] of nonceState ?? new Map()) {
    const { nonce, gap, staleness } = detail ?? {}
    // `read` only — spec 089: a value exists only in that state, so an unreadable nonce publishes
    // NO sample rather than a zero. The absence is the honest signal; `source_up` already carries
    // whether the read succeeded.
    if (nonce?.state === 'read') {
      registry.emit(
        'executor_nonce',
        'gauge',
        'Transactions mined from a bundler executor EOA. Advancing means bundles are landing.',
        nonce.labels,
        nonce.value,
      )
    }
    if (gap?.state === 'read') {
      registry.emit(
        'executor_nonce_pending_gap',
        'gauge',
        'pending minus latest nonce — queue depth. A gap that will not drain is a stuck transaction, and it is the direct read for two senders on ONE EOA (G-11).',
        gap.labels,
        gap.value,
      )
    }
    if (staleness?.state === 'read') {
      registry.emit(
        'executor_nonce_stale_seconds',
        'gauge',
        'Seconds since this executor last ADVANCED its nonce. NOT a fault on its own — an idle bundler is healthy; pair with sponsored_ops_total before alerting.',
        staleness.labels,
        staleness.value,
      )
      // How long we have been watching. A freshly restarted exporter honestly reports 0 staleness,
      // so an alert rule must require a minimum observation window rather than trust a new process.
      if (typeof detail.observedForSec === 'number') {
        registry.emit(
          'executor_nonce_observed_seconds',
          'gauge',
          'How long this exporter has been watching that executor. An alert must require a minimum window: a fresh process reports 0 staleness truthfully.',
          staleness.labels,
          detail.observedForSec,
        )
      }
    }
    void poolId
  }
}
