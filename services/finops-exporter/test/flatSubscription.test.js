/**
 * The flat-subscription modeller (spec 089).
 *
 * Extracted from `collectors/quicknode.js`, and these tests are written around the failure that
 * made the extraction necessary rather than around the happy path: a source pointed at this
 * collector with no entry in the config table used to fall through to QuickNode's credit path and
 * report `not-configured` citing `QUICKNODE_API_KEY` — a credential for a vendor it has never
 * spoken to. `alphaday-news-api` shipped that way with spec 109 and was dead for its whole life,
 * reading as an operator oversight rather than a wiring bug, which is why nobody looked at it.
 */
import { describe, it, expect } from 'vitest'
import { createFlatSubscriptionCollector } from '../src/collectors/flatSubscription.js'
import { SOURCES } from '@fairwins/finops-catalogue'

const collectorFor = (flatSubscriptions) => createFlatSubscriptionCollector({ config: { flatSubscriptions } })

describe('flat-subscription modeller', () => {
  it('reports a declared price as a MODEL, never as an invoice', async () => {
    const r = await collectorFor({ 'grafana-cloud': 0 })({ id: 'grafana-cloud' })
    expect(r.state).toBe('read')
    expect(r.value).toBe(0)
    expect(r.unit).toBe('USD')
    expect(r.labels.basis).toBe('modelled')
  })

  it('distinguishes an ASSERTED zero from an unset price', async () => {
    const asserted = await collectorFor({ x: 0 })({ id: 'x' })
    const unset = await collectorFor({ x: null })({ id: 'x' })

    // "We confirmed the free tier" vs "nobody ever set this" — different facts, different states.
    expect(asserted.state).toBe('read')
    expect(asserted.value).toBe(0)
    expect(unset.state).toBe('not-configured')
    expect(unset.value).toBeNull()
    expect(unset.reason).toMatch(/0 asserts a free tier/)
  })

  it('calls an unknown source a WIRING BUG, not a missing price', async () => {
    const r = await collectorFor({ 'grafana-cloud': 0 })({ id: 'alphaday-news-api' })
    expect(r.state).toBe('not-configured')
    // The old behaviour blamed a QuickNode credential. The reason must point at the code instead,
    // or the next one of these is another source that is quietly dead for months.
    expect(r.reason).toMatch(/wiring bug/)
    expect(r.reason).toMatch(/config\/index\.js/)
    expect(r.reason).not.toMatch(/QUICKNODE/i)
  })

  it('never fabricates a zero for a source it cannot price', async () => {
    for (const table of [{}, { x: null }]) {
      const r = await collectorFor(table)({ id: 'x' })
      expect(r.value).toBeNull()
    }
  })
})

describe('the catalogue and the config table cannot drift apart', () => {
  /**
   * This is the gate the extraction is actually for. Every source naming this collector MUST have a
   * config entry; a missing one is not "no price declared", it is a dead source that reports a
   * plausible-sounding operator TODO. Asserted here rather than only in `check:finops`, because
   * this is the file whose contract it is.
   */
  it('every catalogued flatSubscription source has a config entry', async () => {
    const { loadConfig } = await import('../src/config/index.js')
    const declared = Object.keys(loadConfig({}).flatSubscriptions)
    const users = SOURCES.filter((s) => s.collector === 'flatSubscription').map((s) => s.id)

    expect(users.length).toBeGreaterThan(0)
    for (const id of users) {
      expect(declared, `'${id}' names the flatSubscription collector but has no flatSubscriptions entry`).toContain(id)
    }
  })

  it('no source still points at quicknode for a flat subscription', () => {
    const onQuickNode = SOURCES.filter((s) => s.collector === 'quicknode').map((s) => s.id)
    // QuickNode's collector reads CREDITS. Anything else on it is a source that will be told its
    // problem is a QuickNode API key.
    expect(onQuickNode).toEqual(['quicknode'])
  })
})
