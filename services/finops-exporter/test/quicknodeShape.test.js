/**
 * The QuickNode Admin API's ACTUAL response shape (spec 089).
 *
 * This suite exists because the collector guessed five field names and got none of them, so the
 * source reported `unreadable` for its entire life behind a message that read like a parser bug.
 * The shape below was observed against the live Admin API on 2026-09-12 — it is a recording of
 * what the vendor sends, not another guess, and that is the whole point of pinning it in a test.
 */
import { describe, it, expect } from 'vitest'
import { createQuickNodeCollector, emitQuickNodeUsage } from '../src/collectors/quicknode.js'
import { createRegistry } from '../src/registry.js'

/** Verbatim shape from the live endpoint. */
const LIVE_BODY = {
  data: {
    start_time: 1757000000,
    end_time: 1757600000,
    credits_used: 4_200_000,
    credits_remaining: 5_800_000,
    limit: 10_000_000,
    overages: null,
  },
  error: null,
}

const SOURCE = { id: 'quicknode', kind: 'cost', status: 'live', metric: 'fairwins_finops_cost_usd_total', meaning: 'x' }

function harness({ body = LIVE_BODY, status = 200, quicknode = {} } = {}) {
  return createQuickNodeCollector({
    config: {
      flatSubscriptions: {},
      quicknode: { apiKey: 'qn_key', endpoint: 'https://api.quicknode.com/v0', prometheusUrl: null, planMonthlyUsd: null, usdPerMillionCredits: null, ...quicknode },
    },
    fetchImpl: async () => ({ ok: status < 400, status, json: async () => body }),
    log: () => {},
  })
}

describe('the real Admin API shape', () => {
  it('reads credits from data.credits_used — the field that actually exists', async () => {
    const collect = harness({ quicknode: { usdPerMillionCredits: 10 } })
    const r = await collect(SOURCE)
    expect(r.state).toBe('read')
    // 4.2M credits at $10/M.
    expect(r.value).toBeCloseTo(42, 9)
    expect(collect._lastCredits()).toBe(4_200_000)
  })

  it('does NOT treat error:null as an error', async () => {
    // `error` is present on every response and is null on success. An `if (body.error)` that
    // tripped on the KEY rather than the value would make every successful read unreadable.
    const r = await harness({ quicknode: { planMonthlyUsd: 49 } })(SOURCE)
    expect(r.state).toBe('read')
    expect(r.value).toBe(49)
  })

  it('reports the vendor message when error IS set', async () => {
    const r = await harness({ body: { data: null, error: 'account suspended' } })(SOURCE)
    expect(r.state).toBe('unreadable')
    expect(r.reason).toMatch(/account suspended/)
  })

  it('names the NESTED keys when the shape is unrecognised', async () => {
    // The old message said `keys: data,error` — true, and useless: it described the envelope
    // while the answer was one level down.
    const r = await harness({ body: { data: { something_new: 1 }, error: null } })(SOURCE)
    expect(r.state).toBe('unreadable')
    expect(r.reason).toMatch(/data:\{something_new\}/)
  })

  it('never turns an unreadable shape into zero credits', async () => {
    const collect = harness({ body: { data: {}, error: null } })
    const r = await collect(SOURCE)
    expect(r.value).toBeNull()
    expect(collect._lastCredits()).toBeNull()
  })
})

describe('plan headroom rides along', () => {
  it('publishes remaining and limit beside the used count', async () => {
    const collect = harness({ quicknode: { planMonthlyUsd: 49 } })
    await collect(SOURCE)

    const registry = createRegistry()
    emitQuickNodeUsage(registry, collect, SOURCE)
    const usage = registry.snapshot()['fairwins_finops_vendor_usage']

    expect(usage).toEqual(
      expect.arrayContaining([
        { source: 'quicknode', metric: 'api_credits', value: 4_200_000 },
        { source: 'quicknode', metric: 'api_credits_remaining', value: 5_800_000 },
        { source: 'quicknode', metric: 'api_credits_limit', value: 10_000_000 },
      ]),
    )
  })

  it('omits a headroom field the vendor did not send rather than emitting zero', async () => {
    const collect = harness({ body: { data: { credits_used: 10 }, error: null }, quicknode: { planMonthlyUsd: 49 } })
    await collect(SOURCE)

    const registry = createRegistry()
    emitQuickNodeUsage(registry, collect, SOURCE)
    const usage = registry.snapshot()['fairwins_finops_vendor_usage']

    expect(usage.map((s) => s.metric)).toEqual(['api_credits'])
    // "0 credits remaining" is an alarm. "We could not see it" is not.
    expect(usage.some((s) => s.value === 0)).toBe(false)
  })
})
