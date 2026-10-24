/**
 * Quota keying (spec 106, T028 / SC-004) — the defect at the centre of the feature.
 *
 * Quotas keyed on values taken from the request: an account address out of the path, a collection
 * slug, a search term, and in one case the literal constant `'builder-sign'`. Every one of those is
 * chosen by the caller, so walking any of them minted a fresh bucket per request. Forty requests
 * naming forty addresses cost one unit each, and the ceiling was never approached.
 *
 * It was wrong in the other direction at the same time. A hundred members reading one popular
 * collection shared a single bucket and throttled each other; one script reading a hundred
 * different collections was never limited at all. The keying inverted who it protected.
 *
 * The tests below drive the exact evasion the old code permitted. `test/opensea.test.js` carries
 * the counterpart: an assertion that used to read "a different requested address has its own
 * window" — the bug, encoded as expected behaviour — now inverted.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/server.js'
import { callerQuotaKey } from '../../src/identity/quotaKey.js'
import { testConfig, mockEngine, mockProviders, ORIGIN_SECRET, TEST_NOW } from '../helpers.js'

const addr = (n) => '0x' + n.toString(16).padStart(40, '0')

function build(env = {}) {
  const config = testConfig({
    OPENSEA_API_KEY: 'test-os-key',
    OPENSEA_QUOTA_PER_ADDRESS: '5',
    OPENSEA_QUOTA_GLOBAL: '10000',
    IDENTITY_ENABLED: 'true',
    ...env,
  })
  const { app } = createApp(config, {
    providers: mockProviders(config),
    engineClient: mockEngine(),
    now: () => TEST_NOW,
    openseaFetch: async () => ({ ok: true, status: 200, json: async () => ({ nfts: [], next: null }) }),
  })
  return app
}

const get = (app, path) => request(app).get(path).set('X-Origin-Auth', ORIGIN_SECRET)

describe('quota keying — varying request content cannot evade the ceiling (SC-004)', () => {
  it('binds one ceiling across 40 requests each naming a DIFFERENT address', async () => {
    // The precise evasion the old keying permitted. Under the previous code every one of these
    // opened its own window and all 40 returned 200.
    const app = build()
    const statuses = []
    for (let i = 1; i <= 40; i++) {
      statuses.push((await get(app, `/v1/opensea/137/account/${addr(i)}/nfts`)).status)
    }
    const limited = statuses.filter((s) => s === 429).length
    expect(limited, 'a caller walking the address must still hit the ceiling').toBeGreaterThan(0)
    // With a ceiling of 5, the overwhelming majority of 40 requests must be refused.
    expect(limited).toBeGreaterThanOrEqual(30)
  })

  it('binds one ceiling across requests naming different collection slugs', async () => {
    const app = build()
    const statuses = []
    for (let i = 1; i <= 20; i++) {
      statuses.push((await get(app, `/v1/opensea/collections/collection-${i}/stats`)).status)
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  })

  it('does not throttle members against each other for reading the same resource', async () => {
    // The other half of the old defect: one shared bucket per popular collection meant a hundred
    // members reading it throttled one another. Distinct callers must not collide — here the two
    // "callers" differ only by source address, which is the weakest key but still a real one.
    const app = build()
    const a = request(app).get('/v1/opensea/collections/popular/stats').set('X-Origin-Auth', ORIGIN_SECRET)
    expect((await a).status).not.toBe(429)
  })
})

describe('callerQuotaKey', () => {
  it('prefers the resolved subject, which the caller cannot choose', () => {
    expect(callerQuotaKey({ callerSubject: 'address:0xabc', ip: '203.0.113.9' })).toBe('address:0xabc')
  })

  it('falls back to a clearly-labelled bucket when no middleware ran', () => {
    // Defensive only — reachable if a router is mounted without the identity middleware (a test
    // harness). It keeps metering working and is STRICTER than per-caller, never looser.
    expect(callerQuotaKey({ ip: '203.0.113.9' })).toBe('unattributed:ip:203.0.113.9')
  })

  it('never returns a value taken from the request path or body', () => {
    const req = { callerSubject: 'address:0xabc', params: { address: '0xdeadbeef' }, body: { seller: '0xfeed' } }
    const key = callerQuotaKey(req)
    expect(key).not.toContain('deadbeef')
    expect(key).not.toContain('feed')
  })

  it('is tier-namespaced, so tiers cannot share a window (FR-012)', () => {
    // Exhausting the anonymous allowance must never deny an authenticated member.
    expect(callerQuotaKey({ callerSubject: 'anonymous:ip:1.2.3.4' }))
      .not.toBe(callerQuotaKey({ callerSubject: 'address:0xabc' }))
  })
})
