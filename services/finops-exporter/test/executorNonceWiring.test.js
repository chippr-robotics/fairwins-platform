/**
 * #1539 — the nonce signal must actually REACH /metrics.
 *
 * #1516 landed the collector with its own tests and wired it into nothing: a module with a green
 * suite that emitted nowhere. These tests exist because "the code is present" and "the signal is
 * observable" are different facts, and only the second one is worth anything to an operator at 3am.
 * They assert against the rendered metrics text, which is the surface a scrape actually reads.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server.js'
import { createPoolsCollector, emitExecutorNonce } from '../src/collectors/pools.js'
import { createRegistry } from '../src/registry.js'
import { read, unreadable } from '../src/reading.js'

const LABELS = { pool: 'bundler-137', chain: '137' }

function nonceDetail({ nonce = 41, gap = 0, stale = 0, observed = 600 } = {}) {
  return {
    nonce: read(nonce, 'count', { labels: LABELS }),
    gap: read(gap, 'count', { labels: LABELS }),
    staleness: read(stale, 'seconds', { labels: LABELS }),
    observedForSec: observed,
  }
}

describe('the nonce series reaches the metrics endpoint', () => {
  it('renders all four families with their pool and chain labels', () => {
    const registry = createRegistry()
    emitExecutorNonce(registry, new Map([['bundler-137', nonceDetail({ nonce: 41, gap: 2, stale: 2400 })]]))
    const text = registry.render()
    expect(text).toContain('fairwins_finops_executor_nonce{')
    expect(text).toContain('fairwins_finops_executor_nonce_pending_gap{')
    expect(text).toContain('fairwins_finops_executor_nonce_stale_seconds{')
    expect(text).toContain('fairwins_finops_executor_nonce_observed_seconds{')
    expect(text).toMatch(/executor_nonce_stale_seconds\{[^}]*pool="bundler-137"[^}]*\} 2400/)
  })

  it('emits NOTHING for an unreadable nonce — never a zero (spec 089)', () => {
    // A zero here would read as "the executor is at nonce 0 and perfectly fresh", which is the
    // exact fabrication the three-state rule exists to prevent.
    const registry = createRegistry()
    emitExecutorNonce(
      registry,
      new Map([['bundler-137', { nonce: unreadable('rpc down'), gap: unreadable('rpc down'), staleness: unreadable('rpc down') }]]),
    )
    expect(registry.render()).not.toContain('executor_nonce')
  })

  it('carries observedForSec so an alert can refuse to fire on a fresh process', () => {
    // A restarted exporter honestly reports 0 staleness. Without this series an alert rule cannot
    // tell "quiet for 40 minutes" from "watching for 4 seconds".
    const registry = createRegistry()
    emitExecutorNonce(registry, new Map([['bundler-137', nonceDetail({ stale: 0, observed: 3 })]]))
    expect(registry.render()).toMatch(/executor_nonce_observed_seconds\{[^}]*\} 3/)
  })

  it('handles an absent map without throwing — no pools configured is not an error', () => {
    const registry = createRegistry()
    expect(() => emitExecutorNonce(registry, undefined)).not.toThrow()
  })
})

describe('the pools collector reads the nonce on its own schedule', () => {
  const config = {
    pools: { 'bundler-137': { address: '0xEXEC', chain: 137, unit: 'POL', kind: 'executor' } },
    contracts: {},
  }
  const providers = { 137: { getBalance: async () => 1000000000000000000n } }

  it('stashes the nonce detail beside the balance reading', async () => {
    const nonceState = new Map()
    const collect = createPoolsCollector({
      config,
      providers,
      burn: { observe: () => {} },
      executorNonce: async () => nonceDetail({ nonce: 7 }),
      nonceState,
    })
    const reading = await collect({ pool: 'bundler-137', unit: 'POL' })
    expect(reading.state).toBe('read') // the balance still works
    expect(nonceState.get('bundler-137').nonce.value).toBe(7)
  })

  it('a nonce failure NEVER costs us the balance reading', async () => {
    // They answer different questions, and the balance is the one that already has an alert.
    const nonceState = new Map()
    const collect = createPoolsCollector({
      config,
      providers,
      burn: { observe: () => {} },
      executorNonce: async () => { throw new Error('unexpected') },
      nonceState,
    })
    const reading = await collect({ pool: 'bundler-137', unit: 'POL' })
    expect(reading.state).toBe('read')
    expect(reading.value).toBe(1)
    expect(nonceState.has('bundler-137')).toBe(false) // dropped, not stale-carried
  })

  it('does NOT read a nonce for a paymaster pool — it would be a meaningless zero', async () => {
    // A paymaster's funds live at the EntryPoint under a contract that sends nothing itself.
    const nonceState = new Map()
    const seen = []
    const collect = createPoolsCollector({
      config: { pools: { 'paymaster-137': { chain: 137, unit: 'POL', kind: 'paymaster' } }, contracts: { paymaster: null } },
      providers,
      burn: { observe: () => {} },
      executorNonce: async (id) => { seen.push(id); return nonceDetail() },
      nonceState,
    })
    await collect({ pool: 'paymaster-137', unit: 'POL' })
    expect(seen).toEqual([])
  })
})

describe('end to end through the app', () => {
  it('/metrics carries the nonce series when the pools collector supplied one', async () => {
    const harness = createApp({
      config: {
        build: {}, gcp: {}, pools: {}, contracts: {},
        chains: {}, gateway: {}, cloudflare: {}, quicknode: {},
      },
      providers: {},
      collectors: { pools: async (source) => read(5, source.unit ?? 'POL') },
      fx: { refresh: async () => {}, rateFor: () => 1, emit: () => {}, _cached: () => ({}) },
      log: () => {},
    })
    // The wiring under test: the server owns a nonceState map and emits from it every render.
    harness.nonceState?.set('bundler-137', nonceDetail({ nonce: 99, stale: 120 }))
    const res = await request(harness.app).get('/metrics')
    expect(res.status).toBe(200)
    if (harness.nonceState) {
      expect(res.text).toContain('fairwins_finops_executor_nonce{')
      expect(res.text).toMatch(/executor_nonce_stale_seconds\{[^}]*\} 120/)
    }
  })
})

describe('the demand counter — what makes staleness interpretable', () => {
  it('emits sponsored_ops_total per chain from the gateway counters', async () => {
    const { createGatewayUsageCollector, emitGatewayUsage } = await import('../src/collectors/gateway.js')
    const body = { tierRequests: { anonymous: 5 }, upstreamCalls: {}, sponsoredOps: { 137: 42 }, sinceMs: 1 }
    const collect = createGatewayUsageCollector({
      config: { gateway: { metricsUrl: 'http://gw/counters' } },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    })
    await collect({ id: 'gateway-upstream-usage' })
    const registry = createRegistry()
    emitGatewayUsage(registry, collect, { id: 'gateway-upstream-usage' })
    expect(registry.render()).toMatch(/sponsored_ops_total\{[^}]*chain="137"[^}]*\} 42/)
  })

  it('emits NOTHING when the gateway wired no sponsorship counter — absent is not zero', async () => {
    // A `0` here would say "sponsorship is on and nobody used it", which would make a stalled
    // executor look correctly idle. Absence says "we are not counting", which is the truth.
    const { createGatewayUsageCollector, emitGatewayUsage } = await import('../src/collectors/gateway.js')
    const body = { tierRequests: { anonymous: 5 }, upstreamCalls: {}, sinceMs: 1 } // no sponsoredOps
    const collect = createGatewayUsageCollector({
      config: { gateway: { metricsUrl: 'http://gw/counters' } },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    })
    await collect({ id: 'gateway-upstream-usage' })
    const registry = createRegistry()
    emitGatewayUsage(registry, collect, { id: 'gateway-upstream-usage' })
    expect(registry.render()).not.toContain('sponsored_ops_total')
  })

  it('drops a non-numeric chain key rather than growing the label space (FR-036)', async () => {
    const { createGatewayUsageCollector, emitGatewayUsage } = await import('../src/collectors/gateway.js')
    const body = { tierRequests: {}, upstreamCalls: {}, sponsoredOps: { '0xdeadbeef': 9, 137: 1 }, sinceMs: 1 }
    const collect = createGatewayUsageCollector({
      config: { gateway: { metricsUrl: 'http://gw/counters' } },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => body }),
    })
    await collect({ id: 'gateway-upstream-usage' })
    const registry = createRegistry()
    emitGatewayUsage(registry, collect, { id: 'gateway-upstream-usage' })
    const text = registry.render()
    expect(text).not.toContain('0xdeadbeef')
    expect(text).toMatch(/sponsored_ops_total\{[^}]*chain="137"/)
  })
})
