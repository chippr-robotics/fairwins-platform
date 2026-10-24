/**
 * Executor nonce accountability (#1501).
 *
 * The load-bearing test is `the 2026-07-12 shape`: a bundler answering RPC while its executor sends
 * nothing. Balance-based monitoring cannot see it — burn falls to zero, runway correctly goes null,
 * the series disappears and the alert reads OK. These tests pin the signal that CAN see it, and
 * pin just as hard the things it must NOT do: never invent a verdict from staleness alone, and
 * never carry a stale nonce forward when the read fails.
 */
import { describe, it, expect } from 'vitest'
import { createExecutorNonceCollector } from '../src/executorNonce.js'

const CONFIG = { pools: { 'bundler-137': { address: '0xEXEC', chain: 137, unit: 'POL' } } }

/** A provider whose nonce pair is whatever the test says it is right now. */
function providerAt(state) {
  return {
    getTransactionCount: async (_addr, block) => {
      if (state.throws) throw new Error(state.throws)
      return block === 'pending' ? state.pending : state.latest
    },
  }
}

function harness(state, clock) {
  const providers = { 137: providerAt(state) }
  return createExecutorNonceCollector({ config: CONFIG, providers, now: () => clock.t })
}

describe('executor nonce — the signal balance cannot express', () => {
  it('reports the nonce and a zero queue gap on a healthy executor', async () => {
    const clock = { t: 1_000_000 }
    const state = { latest: 42, pending: 42 }
    const out = await harness(state, clock)('bundler-137')
    expect(out.nonce.state).toBe('read')
    expect(out.nonce.value).toBe(42)
    expect(out.gap.value).toBe(0)
    expect(out.staleness.value).toBe(0) // first observation: we have watched for no time at all
  })

  it('THE 2026-07-12 SHAPE: a frozen nonce accrues staleness while the read keeps succeeding', async () => {
    // alto answers RPC, balance reads fine, burn is zero, runway is null — and this number grows.
    const clock = { t: 1_000_000 }
    const state = { latest: 42, pending: 42 }
    const collect = harness(state, clock)
    await collect('bundler-137')
    clock.t += 40 * 60 * 1000 // the 40 minutes it actually ran
    const out = await collect('bundler-137')
    expect(out.nonce.state).toBe('read')
    expect(out.staleness.value).toBe(2400)
  })

  it('staleness RESETS when the nonce advances — an active bundler never accrues it', async () => {
    const clock = { t: 1_000_000 }
    const state = { latest: 42, pending: 42 }
    const collect = harness(state, clock)
    await collect('bundler-137')
    clock.t += 600_000
    state.latest = 43
    state.pending = 43
    const out = await collect('bundler-137')
    expect(out.staleness.value).toBe(0)
  })

  it('reports a queue GAP without judging it — a stuck tx and a nonce collision both show here', async () => {
    const clock = { t: 1_000_000 }
    const out = await harness({ latest: 42, pending: 45 }, clock)('bundler-137')
    expect(out.gap.value).toBe(3)
    expect(out.gap.state).toBe('read')
  })

  it('NEVER carries a stale nonce forward when the read fails — unreadable, not the last value', async () => {
    // Carrying it forward would let an RPC outage look like a steadily-advancing executor.
    const clock = { t: 1_000_000 }
    const state = { latest: 42, pending: 42 }
    const collect = harness(state, clock)
    await collect('bundler-137')
    state.throws = 'connection refused'
    const out = await collect('bundler-137')
    expect(out.nonce.state).toBe('unreadable')
    expect(out.gap.state).toBe('unreadable')
    expect(out.staleness.state).toBe('unreadable')
    // spec 089: a value exists only in state `read`. This codebase encodes that as `value: null`
    // rather than an absent key (see reading.js#unreadable), so assert the null explicitly —
    // and never `?? 0` it downstream, which is where that encoding turns back into a fabricated zero.
    expect(out.nonce.value).toBeNull()
  })

  it('a non-numeric provider answer is unreadable, never coerced', async () => {
    const clock = { t: 1_000_000 }
    const out = await harness({ latest: undefined, pending: undefined }, clock)('bundler-137')
    expect(out.nonce.state).toBe('unreadable')
  })

  it('an unknown pool or missing provider is not-configured, which is not a fault', async () => {
    const clock = { t: 1_000_000 }
    const collect = harness({ latest: 1, pending: 1 }, clock)
    expect((await collect('nope')).nonce.state).toBe('not-configured')

    const noProvider = createExecutorNonceCollector({ config: CONFIG, providers: {}, now: () => 1 })
    expect((await noProvider('bundler-137')).nonce.state).toBe('not-configured')
  })

  it('a BACKWARDS nonce resets the baseline rather than reporting staleness against another world', async () => {
    // Cannot happen for one account; means the address changed or a provider served a forked view.
    const clock = { t: 1_000_000 }
    const state = { latest: 42, pending: 42 }
    const collect = harness(state, clock)
    await collect('bundler-137')
    clock.t += 600_000
    state.latest = 7
    state.pending = 7
    const out = await collect('bundler-137')
    expect(out.staleness.value).toBe(0)
    expect(out.nonce.value).toBe(7)
  })

  it('labels stay the bounded (pool, chain) pair — never the address', async () => {
    const clock = { t: 1_000_000 }
    const out = await harness({ latest: 1, pending: 1 }, clock)('bundler-137')
    expect(out.nonce.labels).toEqual({ pool: 'bundler-137', chain: '137' })
    expect(JSON.stringify(out)).not.toContain('0xEXEC')
  })
})
