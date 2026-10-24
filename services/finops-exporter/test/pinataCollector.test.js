/**
 * Pinata collector (spec 089).
 *
 * Two things are under test, and the second is the one that matters more than the number:
 *
 *   1. Usage is MEASURED and cost is MODELLED, reported independently — an undeclared plan price
 *      must not look like a vendor outage, and a successful storage read must not be discarded
 *      because nobody has typed in what the plan costs.
 *   2. The credential is a READ-scoped key and the collector says so when it is missing or refused.
 *      This vendor's failure mode is scope, not validity: a key valid for `pinFileToIPFS` but not
 *      `pinJSONToIPFS` authenticates fine, passes `testAuthentication`, and breaks every member
 *      write — a real production incident (2026-08-30). "Unauthorized" here should not send an
 *      operator off to rotate a credential that is probably working exactly as issued.
 */
import { describe, it, expect } from 'vitest'
import { createPinataCollector, emitPinataUsage } from '../src/collectors/pinata.js'
import { createRegistry } from '../src/registry.js'

const SOURCE = { id: 'pinata', kind: 'cost', status: 'live', metric: 'fairwins_finops_cost_usd_total', meaning: 'x' }

const ok = (body) => ({ ok: true, status: 200, json: async () => body })
const status = (code) => ({ ok: false, status: code, json: async () => ({}) })

const USAGE = { pin_count: 412, pin_size_total: 8_000_000, pin_size_with_replications_total: 24_000_000 }

function harness({ readJwt = 'pinata_read_key', planMonthlyUsd = null, response = ok(USAGE) } = {}) {
  const calls = []
  const collect = createPinataCollector({
    config: { pinata: { readJwt, endpoint: 'https://api.pinata.cloud', planMonthlyUsd } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (typeof response === 'function') return response()
      return response
    },
    log: () => {},
  })
  collect.calls = calls
  return collect
}

describe('pinata collector — a paid vendor on the member write path', () => {
  it('models the declared plan price and labels it as a model, never an invoice', async () => {
    const r = await harness({ planMonthlyUsd: 20 })(SOURCE)
    expect(r.state).toBe('read')
    expect(r.value).toBe(20)
    expect(r.unit).toBe('USD')
    expect(r.labels.basis).toBe('modelled')
  })

  it('keeps the usage read when no plan price is declared — that is not an outage', async () => {
    const collect = harness({ planMonthlyUsd: null })
    const r = await collect(SOURCE)
    // not-configured, NOT unreadable: the vendor answered perfectly, we just have not priced it.
    expect(r.state).toBe('not-configured')
    expect(r.reason).toMatch(/FINOPS_PINATA_PLAN_USD/)
    // And the bytes survive, because they were successfully read.
    expect(collect._lastUsage()).toMatchObject({ pins: 412, bytes: 8_000_000 })
  })

  it('reports not-configured — never $0 — when no read key is set', async () => {
    const r = await harness({ readJwt: null })(SOURCE)
    expect(r.state).toBe('not-configured')
    expect(r.value).toBeNull()
    // The reason has to name the SCOPE requirement, or the next operator wires the pinning JWT.
    expect(r.reason).toMatch(/READ-SCOPED/)
    expect(r.reason).toMatch(/never the pinning JWT/)
  })

  it('sends the key as a bearer header, never in the URL', async () => {
    const collect = harness({ planMonthlyUsd: 20 })
    await collect(SOURCE)
    const { url, init } = collect.calls[0]
    expect(url).toBe('https://api.pinata.cloud/data/userPinnedDataTotal')
    expect(url).not.toMatch(/pinata_read_key/)
    expect(init.headers.authorization).toBe('Bearer pinata_read_key')
  })

  it('blames SCOPE, not validity, on a 401/403 — this vendor fails that way', async () => {
    for (const code of [401, 403]) {
      const r = await harness({ response: status(code) })(SOURCE)
      expect(r.state).toBe('unreadable')
      expect(r.reason).toMatch(/SCOPE/)
      expect(r.reason).toMatch(/userPinnedDataTotal/)
    }
  })

  it('never leaks the key into a failure reason', async () => {
    const r = await harness({ response: () => { throw new Error('connect ECONNREFUSED for Bearer pinata_read_key') } })(SOURCE)
    expect(r.state).toBe('unreadable')
    expect(r.reason).not.toContain('pinata_read_key')
    expect(r.reason).toContain('<redacted>')
  })

  it('treats an unrecognised response shape as unreadable, never as zero bytes', async () => {
    const r = await harness({ response: ok({ something_else: 1 }) })(SOURCE)
    // "0 bytes pinned" would claim the member-facing store is empty, which is definitely false.
    expect(r.state).toBe('unreadable')
    expect(r.value).toBeNull()
    expect(r.reason).toMatch(/pin_size_total/)
  })
})

describe('pinata usage emission — the part that is a fact', () => {
  it('publishes both size figures under distinct labels rather than electing one', async () => {
    const collect = harness({ planMonthlyUsd: 20 })
    await collect(SOURCE)

    const registry = createRegistry()
    emitPinataUsage(registry, collect, SOURCE)
    const usage = registry.snapshot()['fairwins_finops_vendor_usage']

    expect(usage).toEqual(
      expect.arrayContaining([
        { source: 'pinata', metric: 'pinned_objects', value: 412 },
        { source: 'pinata', metric: 'pinned_bytes', value: 8_000_000 },
        { source: 'pinata', metric: 'pinned_bytes_with_replication', value: 24_000_000 },
      ]),
    )
  })

  it('omits a field the vendor did not return rather than emitting a zero', async () => {
    const collect = harness({ planMonthlyUsd: 20, response: ok({ pin_size_total: 500 }) })
    await collect(SOURCE)

    const registry = createRegistry()
    emitPinataUsage(registry, collect, SOURCE)
    const usage = registry.snapshot()['fairwins_finops_vendor_usage'] ?? []

    expect(usage.map((s) => s.metric)).toEqual(['pinned_bytes'])
    // A 0 here would read as "nothing pinned" instead of "the vendor said nothing about this".
    expect(usage.some((s) => s.value === 0)).toBe(false)
  })

  it('emits nothing at all before a successful read', () => {
    const registry = createRegistry()
    emitPinataUsage(registry, harness(), SOURCE)
    expect(registry.snapshot()['fairwins_finops_vendor_usage']).toBeUndefined()
  })
})
