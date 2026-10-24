/**
 * The exporter must be READABLE before it is COMPLETE (spec 089, FR-007).
 *
 * These tests exist because the opposite shipped and cost this estate every FinOps panel it had.
 * `start()` used to `await scheduler.collectAll()` before `app.listen()`, which put the only
 * surface that REPORTS failure behind the success of everything it reports on. A single collector
 * that was slow — or, as it turned out, one that pulled a token's entire log history into a 192 MB
 * container — meant the port never opened, the health check never passed, and every dashboard read
 * "no data" with no metric anywhere able to say why. Measured on the live node: 5,966 consecutive
 * OOM kills, none of which reached `listen()`.
 *
 * The property under test is therefore availability, not correctness of any one number: a source
 * that has not been collected is `unreadable`, which is honest and renderable. A closed port is
 * neither.
 */
import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createApp, start } from '../src/server.js'
import { attempt, read } from '../src/reading.js'
import { scanLogs } from '../src/chain/logs.js'

const BARE_CONFIG = {
  build: {},
  gcp: {},
  pools: {},
  contracts: {},
  chains: {},
  gateway: {},
  cloudflare: {},
  quicknode: {},
  // `/status` summarises credential PRESENCE across every collector family, so it reads each of
  // these namespaces. Complete here so the test exercises the route rather than a config gap.
  rpcUrls: {},
  referral: {},
  x402: {},
  port: 0,
  host: '127.0.0.1',
}

describe('a hung collector cannot keep the exporter dark', () => {
  it('serves /metrics and /healthz while a collector is still hanging', async () => {
    const never = new Promise(() => {})
    const harness = createApp({
      config: { ...BARE_CONFIG, cohortChainIds: [137] },
      providers: {},
      collectors: { pools: () => never, feeRouter: () => never, membership: () => never },
      fx: { refresh: async () => {}, rateFor: () => 1, emit: () => {}, _cached: () => ({}) },
      log: () => {},
    })

    // No collection has completed — exactly the boot state. Both routes must still answer.
    const health = await request(harness.app).get('/healthz')
    expect(health.status).toBe(200)

    const metrics = await request(harness.app).get('/metrics')
    expect(metrics.status).toBe(200)
    // The honesty triplet is published even with nothing collected: absence is reported, not hidden.
    expect(metrics.text).toContain('fairwins_finops_source_up')
  })

  it('reports an uncollected source as unreadable — never as a zero', async () => {
    const harness = createApp({
      config: { ...BARE_CONFIG, cohortChainIds: [137] },
      providers: {},
      collectors: {},
      fx: { refresh: async () => {}, rateFor: () => 1, emit: () => {}, _cached: () => ({}) },
      log: () => {},
    })
    const res = await request(harness.app).get('/status')
    expect(res.status).toBe(200)
    const states = new Set(res.body.sources.map((s) => s.state))
    expect(states.has('read')).toBe(false)
    // A value metric for an uncollected source would be a fabricated number entering a total.
    const metrics = await request(harness.app).get('/metrics')
    expect(metrics.text).not.toMatch(/fairwins_finops_revenue_total\{/)
  })
})

describe('every collection is deadline-bounded', () => {
  it('resolves a hung collector to unreadable rather than waiting forever', async () => {
    vi.useFakeTimers()
    try {
      const pending = attempt(() => new Promise(() => {}), { deadlineMs: 1_000 })
      await vi.advanceTimersByTimeAsync(1_001)
      const reading = await pending
      expect(reading.state).toBe('unreadable')
      expect(reading.reason).toMatch(/did not answer within 1s/)
      expect(reading.value).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not penalise a collector that answers inside the deadline', async () => {
    const reading = await attempt(async () => read(7, 'USDC'), { deadlineMs: 60_000 })
    expect(reading.state).toBe('read')
    expect(reading.value).toBe(7)
  })
})

describe('a log scan cannot silently become chain-wide', () => {
  it('throws — so the source reads unreadable — rather than accumulating without bound', async () => {
    const chunkOf = (n) => Array.from({ length: n }, (_, i) => ({ blockNumber: i, topics: [], data: '0x' }))
    const provider = { getLogs: async () => chunkOf(1_000) }

    await expect(
      scanLogs(provider, { address: '0xtoken', topics: [null] }, 0, 100_000, { chunk: 2_000, maxLogs: 5_000 }),
    ).rejects.toThrow(/exceeded 5000 entries/)
  })

  it('lets a correctly-narrowed scan through untouched', async () => {
    const provider = { getLogs: async () => [{ blockNumber: 1, topics: ['0xabc'], data: '0x' }] }
    // 0-1999, 2000-3999, 4000-4000 — three chunks, one log each.
    const out = await scanLogs(provider, { address: '0xtoken', topics: ['0xabc'] }, 0, 4_000, { chunk: 2_000, maxLogs: 5_000 })
    expect(out).toHaveLength(3)
  })
})

describe('start() opens the port before it collects', () => {
  it('resolves a listening server even though collection never finishes', async () => {
    const originalPort = process.env.PORT
    process.env.PORT = '0'
    try {
      // A real boot, with the one property that used to be fatal: collection that never returns.
      const server = await Promise.race([
        start(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('start() did not listen')), 5_000)),
      ])
      expect(server.listening).toBe(true)
      await new Promise((resolve) => server.close(resolve))
    } finally {
      if (originalPort == null) delete process.env.PORT
      else process.env.PORT = originalPort
    }
  }, 15_000)
})
