/**
 * Gateway usage collector (spec 106/#1447).
 *
 * The two assertions that matter: an unreachable gateway is UNREADABLE and never a zero (a
 * gateway that cannot be scraped is not a gateway serving no traffic), and the emitted labels are
 * RE-BOUNDED here — a collector must not trust its scrape target to keep a cardinality promise on
 * its behalf.
 */
import { describe, it, expect, vi } from 'vitest'
import { createGatewayUsageCollector, emitGatewayUsage } from '../src/collectors/gateway.js'

const CONFIG = { gateway: { metricsUrl: 'http://gateway:9091/counters' } }
const SOURCE = { id: 'gateway-upstream-usage' }

const ok = (body) => vi.fn(async () => ({ ok: true, status: 200, json: async () => body }))

describe('the reading', () => {
  it('is not-configured with no URL — unwired, not broken', async () => {
    const collect = createGatewayUsageCollector({ config: { gateway: {} } })
    expect((await collect(SOURCE)).state).toBe('not-configured')
  })

  it('is UNREADABLE when the gateway cannot be reached — never a zero', async () => {
    const collect = createGatewayUsageCollector({ config: CONFIG, fetchImpl: vi.fn(async () => { throw new Error('down') }) })
    const reading = await collect(SOURCE)
    expect(reading.state).toBe('unreadable')
    expect(reading.value).toBeNull()
  })

  it('is UNREADABLE on an unrecognised shape — a zero parsed from the wrong shape reports "no consumption" for a gateway that is definitely consuming', async () => {
    const collect = createGatewayUsageCollector({ config: CONFIG, fetchImpl: ok({ something: 'else' }) })
    expect((await collect(SOURCE)).state).toBe('unreadable')
  })

  it('reads the total across tiers on the honest shape', async () => {
    const collect = createGatewayUsageCollector({
      config: CONFIG,
      fetchImpl: ok({ tierRequests: { anonymous: 3, member: 2 }, upstreamCalls: { opensea: 4 } }),
    })
    const reading = await collect(SOURCE)
    expect(reading.state).toBe('read')
    expect(reading.value).toBe(5)
  })
})

describe('the emitted detail', () => {
  it('emits per-tier and per-upstream counters with bounded labels only', async () => {
    const collect = createGatewayUsageCollector({
      config: CONFIG,
      fetchImpl: ok({
        tierRequests: { anonymous: 3, '0xdeadbeef': 9 }, // the poison label must be dropped
        upstreamCalls: { opensea: 4, 'not a label!': 9 },
      }),
    })
    await collect(SOURCE)
    const emitted = []
    emitGatewayUsage({ emit: (...args) => emitted.push(args) }, collect, SOURCE)
    const labels = emitted.map(([, , , l]) => l)
    expect(labels).toEqual([
      { source: 'gateway-upstream-usage', metric: 'tier_requests', tier: 'anonymous' },
      { source: 'gateway-upstream-usage', metric: 'upstream_calls', upstream: 'opensea' },
    ])
  })

  it('emits nothing before a successful scrape — no fabricated series', () => {
    const collect = createGatewayUsageCollector({ config: CONFIG })
    const emitted = []
    emitGatewayUsage({ emit: (...args) => emitted.push(args) }, collect, SOURCE)
    expect(emitted).toEqual([])
  })
})
