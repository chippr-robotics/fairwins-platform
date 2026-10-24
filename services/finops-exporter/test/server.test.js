/**
 * End-to-end exporter behaviour (spec 089, SC-002 / SC-003 / FR-007 / FR-027).
 *
 * The headline assertion is SC-003: killing any single source's credential produces `unreadable` on
 * exactly that source, a partial-total verdict naming it, and **zero `$0` renderings anywhere in the
 * exposition**. That last clause is checked against the rendered Prometheus text, not against
 * internal state, because the text is what the dashboard actually sees.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server.js'
import { loadConfig } from '../src/config/index.js'
import { read, notConfigured, unreadable } from '../src/reading.js'
import { SOURCES, withinCohort } from '@fairwins/finops-catalogue'

/** A config with no chains and no credentials — every real collector would report not-configured. */
const baseConfig = () =>
  loadConfig({
    PORT: '0',
    FINOPS_COHORT_CHAIN_IDS: '137',
    FINOPS_VERSION: 'test',
    FINOPS_COMMIT: 'abc123',
  })

/**
 * Build an app whose collectors are all stubs. `overrides` maps a source id to the Reading it
 * should produce; anything unnamed reads a plausible value.
 */
async function appWith(overrides = {}) {
  const stub = async (source) => overrides[source.id] ?? read(10, source.unit ?? 'USD')
  const collectors = Object.fromEntries(
    ['feeRouter', 'membership', 'referral', 'pools', 'gcpBilling', 'cloudflare', 'quicknode', 'x402'].map((name) => [name, stub]),
  )
  const harness = createApp({
    config: baseConfig(),
    providers: {},
    collectors,
    fx: { refresh: async () => {}, rateFor: () => 1, emit: () => {}, _cached: () => ({}) },
    log: () => {},
  })
  await harness.scheduler.collectAll()
  return harness
}

describe('exporter surfaces', () => {
  it('serves /healthz', async () => {
    const { app } = await appWith()
    const res = await request(app).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
  })

  it('serves /metrics as Prometheus text', async () => {
    const { app } = await appWith()
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.text).toContain('# TYPE fairwins_finops_source_configured gauge')
  })

  it('covers every catalogued source IN THE COHORT with an honesty gauge (SC-002)', async () => {
    // Scoped to the cohort deliberately: a 137-only build must NOT emit a series for a source pinned
    // to Mordor, and asserting over the raw catalogue would demand exactly that constitution-III
    // violation. The cohort-isolation test below asserts the other half of this property.
    const { app } = await appWith()
    const text = (await request(app).get('/metrics')).text
    for (const source of withinCohort(SOURCES, [137])) {
      expect(text, `no configured gauge for ${source.id}`).toContain(`source="${source.id}"`)
    }
  })

  it('/status reports credential PRESENCE, never a value', async () => {
    const harness = createApp({
      config: loadConfig({
        FINOPS_COHORT_CHAIN_IDS: '137',
        CLOUDFLARE_ANALYTICS_TOKEN: 'cf_supersecret_value',
        CLOUDFLARE_ZONE_ID: 'zone123',
        QUICKNODE_API_KEY: 'qn_supersecret_value',
      }),
      providers: {},
      collectors: { cloudflare: async () => read(1, 'USD') },
      fx: { refresh: async () => {}, rateFor: () => 1, emit: () => {} },
      log: () => {},
    })
    await harness.scheduler.collectAll()
    const res = await request(harness.app).get('/status')

    expect(res.body.config.credentials.cloudflare).toBe(true)
    expect(res.body.config.credentials.quicknode).toBe(true)
    // The whole payload must not contain any part of a token.
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('supersecret')
    expect(body).not.toContain('cf_')
    expect(body).not.toContain('qn_')
  })
})

describe('SC-003 — killing one source degrades exactly that source, and never to $0', () => {
  it('reports unreadable on the killed source only', async () => {
    const { app } = await appWith({ cloudflare: unreadable('HTTP 503 from cloudflare graphql') })
    const status = (await request(app).get('/status')).body

    const byId = Object.fromEntries(status.sources.map((s) => [s.id, s.state]))
    expect(byId.cloudflare).toBe('unreadable')
    // Failure isolation: its neighbours are untouched (FR-007).
    expect(byId.gcp).toBe('read')
    expect(byId.quicknode).toBe('read')
  })

  it('emits NO cost sample for the killed source — never a zero', async () => {
    const { app } = await appWith({ cloudflare: unreadable('HTTP 503') })
    const text = (await request(app).get('/metrics')).text

    const costLines = text.split('\n').filter((l) => l.startsWith('fairwins_finops_cost_usd_total'))
    expect(costLines.some((l) => l.includes('source="gcp"'))).toBe(true)
    // The killed source contributes no line at all.
    expect(costLines.some((l) => l.includes('source="cloudflare"'))).toBe(false)
  })

  it('renders no $0 anywhere in the exposition when a source is unreadable', async () => {
    // The literal check the success criterion asks for: scan every emitted VALUE metric line and
    // assert none of them is a zero standing in for a value we failed to read.
    const { app } = await appWith({
      cloudflare: unreadable('HTTP 503'),
      gcp: unreadable('bigquery timeout'),
      quicknode: notConfigured('no key'),
    })
    const text = (await request(app).get('/metrics')).text

    const valueFamilies = ['revenue_total', 'revenue_accrued', 'cost_usd_total', 'pool_balance', 'vendor_usage']
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || !line.trim()) continue
      if (!valueFamilies.some((f) => line.startsWith(`fairwins_finops_${f}`))) continue
      for (const id of ['cloudflare', 'gcp', 'quicknode']) {
        expect(line, `unreadable/not-configured source '${id}' emitted a value line`).not.toContain(`source="${id}"`)
      }
    }
  })

  it('marks the cost total partial and NAMES the missing source (FR-011)', async () => {
    const { app } = await appWith({ cloudflare: unreadable('HTTP 503') })
    const summary = (await request(app).get('/v1/finops/summary')).body

    expect(summary.cost.partial).toBe(true)
    expect(summary.cost.missingSources).toContain('cloudflare')
    // A not-configured source is NOT a missing one — it is an unwired feature.
    expect(summary.cost.missingSources).not.toContain('quicknode')
  })

  it('does not mark a total partial when a source is merely not-configured', async () => {
    const { app } = await appWith({ cloudflare: notConfigured('CLOUDFLARE_ANALYTICS_TOKEN unset') })
    const summary = (await request(app).get('/v1/finops/summary')).body
    expect(summary.cost.partial).toBe(false)
    expect(summary.cost.notConfiguredSources).toContain('cloudflare')
  })
})

describe('planned sources (FR-014)', () => {
  it('emit no value and are excluded from totals', async () => {
    const { app } = await appWith()
    const text = (await request(app).get('/metrics')).text
    const summary = (await request(app).get('/v1/finops/summary')).body

    for (const planned of SOURCES.filter((s) => s.status === 'planned')) {
      // Present as a fact...
      expect(text).toContain(`source="${planned.id}"`)
      // ...but never with a revenue value, and never as `up`.
      const lines = text.split('\n').filter((l) => l.includes(`source="${planned.id}"`))
      expect(lines.every((l) => !l.startsWith('fairwins_finops_revenue'))).toBe(true)
      expect(lines.every((l) => !l.startsWith('fairwins_finops_source_up'))).toBe(true)
      expect(summary.revenue.missingSources).not.toContain(planned.id)
    }
  })
})

describe('failure isolation (FR-007)', () => {
  it('a collector that throws never fails the scrape', async () => {
    const harness = createApp({
      config: baseConfig(),
      providers: {},
      collectors: {
        gcpBilling: async () => {
          throw new Error('bigquery exploded')
        },
        feeRouter: async () => read(5, 'USDC'),
      },
      fx: { refresh: async () => {}, rateFor: () => 1, emit: () => {} },
      log: () => {},
    })
    await harness.scheduler.collectAll()

    const res = await request(harness.app).get('/metrics')
    expect(res.status).toBe(200)
    expect(res.text).toContain('fairwins_finops_revenue_total')
  })

  it('a source that has never been collected reports unreadable, not absent', async () => {
    // Silently omitting it would drop it off the partial-total check that is supposed to name it.
    const harness = createApp({
      config: baseConfig(),
      providers: {},
      collectors: {},
      fx: { refresh: async () => {}, rateFor: () => 1, emit: () => {} },
      log: () => {},
    })
    const states = harness.scheduler.readings().map((r) => r.reading.state)
    expect(states.every((s) => s === 'unreadable')).toBe(true)
  })
})

describe('cohort isolation (FR-008, constitution III)', () => {
  it('a mainnet cohort collects no testnet-pinned source', async () => {
    const harness = createApp({
      config: loadConfig({ FINOPS_COHORT_CHAIN_IDS: '137' }),
      providers: {},
      collectors: { pools: async () => read(1, 'POL') },
      fx: { refresh: async () => {}, rateFor: () => 1, emit: () => {} },
      log: () => {},
    })
    const ids = harness.scheduler.readings().map((r) => r.source.id)
    // relayer-gas-mordor is pinned to chain 63 and must not appear in a 137-only cohort.
    expect(ids).not.toContain('relayer-gas-mordor')
    expect(ids).toContain('relayer-gas-polygon')
  })
})
