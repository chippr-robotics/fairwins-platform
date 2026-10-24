/**
 * Regressions for defects found in review of PR #1195 (spec 089).
 *
 * Each of these shipped in the first draft and each fails in the direction that LOOKS FINE — an
 * understated cost, a fresh-looking stale source, a balance counted as spend. That is the whole
 * reason they get their own file: they are not hypothetical edge cases, they are the specific ways
 * this system was already lying before anyone read it closely.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server.js'
import { loadConfig } from '../src/config/index.js'
import { createRegistry } from '../src/registry.js'
import { createScheduler } from '../src/scheduler.js'
import { createFxReader } from '../src/collectors/fx.js'
import { createQuickNodeCollector } from '../src/collectors/quicknode.js'
import { createFlatSubscriptionCollector } from '../src/collectors/flatSubscription.js'
import { read, unreadable, notConfigured } from '../src/reading.js'
import { aggregate } from '../src/aggregate.js'

const cfg = (env = {}) => loadConfig({ FINOPS_COHORT_CHAIN_IDS: '63,137', ...env })

describe('pool sources do not publish their balance as a cost', () => {
  it('emits no cost_usd_total from the balance Reading', async () => {
    // The bug: a pool Reading carries a BALANCE in POL, while its catalogue metric is
    // cost_usd_total. Emitting it generically published `cost_usd_total{unit="POL"} <balance>` with
    // no `basis` label — so a cost total added pool balances to actual spend.
    const harness = createApp({
      config: cfg(),
      providers: {},
      collectors: { pools: async () => read(42, 'POL') },
      fx: { refresh: async () => {}, rateFor: () => null, emit: () => {} },
      log: () => {},
    })
    await harness.scheduler.collectAll()
    const text = (await request(harness.app).get('/metrics')).text

    const costLines = text.split('\n').filter((l) => l.startsWith('fairwins_finops_cost_usd_total'))
    for (const line of costLines) {
      expect(line, `a cost line carries a native unit: ${line}`).not.toMatch(/unit="(POL|ETC)"/)
      expect(line, `a cost line is missing its mandatory basis label: ${line}`).toContain('basis=')
    }
    // The balance is still published — as a balance.
    expect(text).toContain('fairwins_finops_pool_balance{pool="paymaster-137"')
  })

  it('still emits the honesty triplet for pool sources', async () => {
    const harness = createApp({
      config: cfg(),
      providers: {},
      collectors: { pools: async () => read(42, 'POL') },
      fx: { refresh: async () => {}, rateFor: () => null, emit: () => {} },
      log: () => {},
    })
    await harness.scheduler.collectAll()
    const text = (await request(harness.app).get('/metrics')).text
    expect(text).toContain('fairwins_finops_source_up{source="paymaster-gas"')
    expect(text).toContain('fairwins_finops_source_configured{source="paymaster-gas"')
  })
})

describe('last-success timestamp survives a failed collection', () => {
  const source = { id: 's', kind: 'cost', status: 'live', metric: 'fairwins_finops_cost_usd_total', unit: 'USD', interval: 60, collector: 'c', meaning: 'x' }

  it('is still emitted while the source is unreadable, carrying the ORIGINAL time', async () => {
    // The bug: the registry is rebuilt per scrape, so deriving this from the current Reading made it
    // vanish the moment a source failed — destroying the one number that says HOW LONG it has been
    // failing, exactly when that number matters.
    let succeed = true
    // The timestamp is taken from the READING, not from the scheduler's clock — deliberately, so a
    // collector that serves a stale-but-real value (gcpBilling's fallback) can report when the data
    // was actually obtained rather than when it was last asked for.
    const scheduler = createScheduler({
      sources: [source],
      collectors: { c: async () => (succeed ? read(1, 'USD', { at: 1_000_000 }) : unreadable('down')) },
      log: () => {},
    })

    await scheduler.collectAll()
    expect(scheduler.readings()[0].lastSuccessAt).toBe(1_000_000)

    succeed = false
    await scheduler.collectAll()

    const entry = scheduler.readings()[0]
    expect(entry.reading.state).toBe('unreadable')
    // Carried across the failure, and NOT advanced to now.
    expect(entry.lastSuccessAt).toBe(1_000_000)

    const registry = createRegistry()
    registry.record(source, entry.reading, {}, { lastSuccessAt: entry.lastSuccessAt })
    const snap = registry.snapshot()
    expect(snap.fairwins_finops_source_last_success_timestamp_seconds[0].value).toBe(1000)
    // And no value metric, because the current read failed.
    expect(snap.fairwins_finops_cost_usd_total).toBeUndefined()
  })

  it('is absent only when a source has genuinely never been read', () => {
    const registry = createRegistry()
    registry.record(source, unreadable('never worked'), {}, { lastSuccessAt: null })
    expect(registry.snapshot().fairwins_finops_source_last_success_timestamp_seconds).toBeUndefined()
  })
})

describe('scheduler does not overlap collections of one source', () => {
  it('drops a tick that arrives while a collection is in flight', async () => {
    let active = 0
    let maxActive = 0
    let release
    const gate = new Promise((r) => {
      release = r
    })
    const source = { id: 'slow', kind: 'cost', status: 'live', metric: 'fairwins_finops_cost_usd_total', unit: 'USD', interval: 60, collector: 'c', meaning: 'x' }

    const scheduler = createScheduler({
      sources: [source],
      collectors: {
        c: async () => {
          active++
          maxActive = Math.max(maxActive, active)
          await gate
          active--
          return read(1, 'USD')
        },
      },
      log: () => {},
    })

    const first = scheduler.collectAll()
    const second = scheduler.collectAll() // arrives while the first is still running
    release()
    await Promise.all([first, second])

    // Concurrent polls would multiply load on the very vendor already struggling.
    expect(maxActive).toBe(1)
  })
})

describe('FX: an unknown rate is null, never zero', () => {
  const fx = createFxReader({ config: cfg(), providers: {}, log: () => {} })

  it('returns null for ETC rather than valuing it at $0', () => {
    // Returning 0 made ETC look convertible, so a USD roll-up included it at zero instead of
    // declining to produce one — and it valued Ethereum Classic MAINNET gas at nothing.
    expect(fx.rateFor('ETC')).toBeNull()
  })

  it('returns 1 for dollar-denominated units and null for an unpriced POL', () => {
    expect(fx.rateFor('USD')).toBe(1)
    expect(fx.rateFor('USDC')).toBe(1)
    expect(fx.rateFor('POL')).toBeNull() // no feed read yet
  })

  it('an unconvertible unit suppresses the USD roll-up rather than understating it', () => {
    const src = (id, unit) => ({ id, kind: 'cost', status: 'live', metric: 'fairwins_finops_cost_usd_total', unit })
    const out = aggregate(
      [
        { source: src('a', 'USD'), reading: read(100, 'USD') },
        { source: src('b', 'ETC'), reading: read(5, 'ETC') },
      ],
      { rateFor: (u) => fx.rateFor(u) },
    )
    expect(out.cost.usd).toBeNull()
    expect(out.cost.usdUnavailableBecause).toContain('ETC')
  })
})

// The flat-subscription modeller MOVED out of collectors/quicknode.js once a fourth vendor needed
// it — a module named for one vendor had started telling the others their problem was a QuickNode
// API key. The contract below is unchanged and is what this block has always been about; only the
// import moved. See collectors/flatSubscription.js and its own suite.
describe('an unset flat subscription is not-configured, not $0', () => {
  const flatCollector = (env = {}) =>
    createFlatSubscriptionCollector({ config: { flatSubscriptions: cfg(env).flatSubscriptions } })

  it('reports not-configured when no plan price is declared', async () => {
    const result = await flatCollector()({ id: 'grafana-cloud' })
    expect(result.state).toBe('not-configured')
    expect(result.value).toBeNull()
  })

  it('reports $0 only when the free tier is asserted explicitly', async () => {
    const result = await flatCollector({ FINOPS_GRAFANA_PLAN_USD: '0' })({ id: 'grafana-cloud' })
    expect(result.state).toBe('read')
    expect(result.value).toBe(0)
  })

  it('still reports not-configured when QuickNode itself has no credential', async () => {
    // The other half of the split: quicknode.js now only ever answers about QuickNode.
    const collect = createQuickNodeCollector({
      config: cfg(),
      fetchImpl: async () => { throw new Error('should not be called') },
      log: () => {},
    })
    const result = await collect({ id: 'quicknode' })
    expect(result.state).toBe('not-configured')
    expect(result.reason).toMatch(/QUICKNODE_API_KEY/)
  })
})

describe('the GCP fallback does not refresh the success timestamp', () => {
  function collectorWith(queryImpl) {
    return (overrides = {}) =>
      import('../src/collectors/gcpBilling.js').then(({ createGcpBillingCollector }) =>
        createGcpBillingCollector({
          config: { gcp: { projectId: 'p', billingDataset: 'd', billingTablePrefix: 't_', maxBytesBilled: 1, lookbackDays: 30 }, ...overrides },
          bigQuery: async () => ({ query: queryImpl }),
          log: () => {},
        }),
      )
  }

  it('serves last-good data stamped with when it was actually read', async () => {
    let fail = false
    const make = collectorWith(async () => {
      if (fail) throw new Error('bigquery timeout')
      return [[{ service: 'Compute Engine', cost: 12, latest_export: { value: new Date().toISOString() } }]]
    })
    const collect = await make()

    const first = await collect({ id: 'gcp' })
    expect(first.state).toBe('read')
    const firstAt = first.at

    fail = true
    await new Promise((r) => setTimeout(r, 5))
    const second = await collect({ id: 'gcp' })

    expect(second.state).toBe('read')
    expect(second.value).toBe(12)
    // The timestamp must NOT have advanced: a served-stale value that claims to be fresh would keep
    // the staleness alert permanently silent through a sustained outage.
    expect(second.at).toBe(firstAt)
  })

  it('is unreadable when there is no last-good value to serve', async () => {
    const make = collectorWith(async () => {
      throw new Error('bigquery timeout')
    })
    const collect = await make()
    const result = await collect({ id: 'gcp' })
    expect(result.state).toBe('unreadable')
    expect(result.value).toBeNull()
  })

  it('treats a missing dataset as not-configured, not an outage', async () => {
    const make = collectorWith(async () => {
      throw new Error('Not found: Dataset p:d')
    })
    const collect = await make()
    expect((await collect({ id: 'gcp' })).state).toBe('not-configured')
  })

  it('treats a freshly-enabled export with no tables as not-configured', async () => {
    // The message a newly enabled export actually returns — different words, same fact. It matched
    // none of the original patterns, so it fell through to `unreadable`, which is configured=1/up=0,
    // which fires the staleness alert 15 minutes later. Google populates the first table on its own
    // schedule (hours) and never backfills, so that would have paged overnight for nothing.
    const make = collectorWith(async () => {
      throw new Error('p:billing_export.gcp_billing_export_v1_* does not match any table.')
    })
    const collect = await make()
    const r = await collect({ id: 'gcp' })
    expect(r.state).toBe('not-configured')
    expect(r.value).toBeNull()
    // The reason must name BOTH causes: a just-enabled export, and a wrong prefix for the export
    // type. They produce the identical error, but only one of them ends on its own — so a reason
    // mentioning only the delay sends the reader off to wait out a misconfiguration.
    expect(r.reason).toMatch(/matched no table/i)
    expect(r.reason).toMatch(/gcp_billing_export_resource_v1_/)
    expect(r.reason).toMatch(/prefix/i)
  })

  it('still reports a genuine query failure as unreadable', async () => {
    // The narrowing above must not swallow real breakage.
    const make = collectorWith(async () => {
      throw new Error('quota exceeded for project')
    })
    const collect = await make()
    expect((await collect({ id: 'gcp' })).state).toBe('unreadable')
  })
})

describe('the credentialed RPC primary', () => {
  // The exporter reads treasury, gas-wallet and paymaster balances over these endpoints. A keyed
  // archive endpoint cannot live in the compose file (its token is in the URL path), so it arrives
  // as RPC_URL_PRIMARY_<chainId> from Secret Manager and is prepended to the public list.
  const PUBLIC_A = 'https://public-a.example.invalid'
  const PUBLIC_B = 'https://public-b.example.invalid'
  const KEYED = 'https://keyed.matic.quiknode.pro/token-shaped-path'

  it('is prepended, leaving the public endpoints behind it as failover', () => {
    const config = cfg({ RPC_URLS_137: `${PUBLIC_A},${PUBLIC_B}`, RPC_URL_PRIMARY_137: KEYED })
    // Substituting instead of prepending would make one credential's rate limit the difference
    // between every on-chain source being `read` and every one being `unreadable`.
    expect(config.rpcUrls[137]).toEqual([KEYED, PUBLIC_A, PUBLIC_B])
  })

  it('changes nothing when it is absent — it is fetched OPTIONAL on purpose', () => {
    expect(cfg({ RPC_URLS_137: PUBLIC_A }).rpcUrls[137]).toEqual([PUBLIC_A])
  })

  it('never lists one endpoint twice', () => {
    // buildProviders wraps a multi-URL list in a FallbackProvider; a duplicate would have it fail
    // over from a host to itself and report two independent endpoints where there is one.
    const config = cfg({ RPC_URLS_137: `${KEYED},${PUBLIC_A}`, RPC_URL_PRIMARY_137: KEYED })
    expect(config.rpcUrls[137]).toEqual([KEYED, PUBLIC_A])
  })

  it('works for a chain with no RPC_URLS_ list at all', () => {
    expect(cfg({ RPC_URL_PRIMARY_137: KEYED }).rpcUrls[137]).toEqual([KEYED])
  })

  it('does not leak across chains', () => {
    const config = cfg({ RPC_URLS_137: PUBLIC_A, RPC_URLS_63: PUBLIC_B, RPC_URL_PRIMARY_137: KEYED })
    expect(config.rpcUrls[137]).toEqual([KEYED, PUBLIC_A])
    expect(config.rpcUrls[63]).toEqual([PUBLIC_B])
  })
})
