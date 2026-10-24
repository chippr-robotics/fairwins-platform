/**
 * Identity wiring, end to end through the real app (spec 106).
 *
 * The unit tests prove each piece behaves. This proves the pieces are actually CONNECTED — that the
 * middleware is mounted where the plan says, that the grant verifier is registered into the live
 * verifier array after the member-API dependencies are built, and that a real signed token
 * therefore moves a real request up the ladder.
 *
 * Worth its own file because the registration is deliberately late: the middleware mounts early
 * (before route dispatch) and the verifier is pushed in later (once the revocation store and
 * membership reader exist). That is correct but easy to break, and if it broke, every unit test
 * here would still pass while the deployed gateway silently resolved every caller anonymous.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/server.js'
import { TIER_HEADER } from '../../src/identity/middleware.js'
import { TIERS } from '../../src/identity/tiers.js'
import { testConfig, mockEngine, mockProviders, ORIGIN_SECRET, TEST_NOW } from '../helpers.js'
import { MEMBER_API_ENV, memberApiProviders, memberToken, ALL_SCOPES_V1 } from '../memberApiHelpers.js'

function build({ identity = 'true', membershipTier = 3 } = {}) {
  const config = testConfig({
    ...MEMBER_API_ENV,
    MEMBER_API_ENABLED: 'true',
    // Perps is deliberately left UNCONFIGURED. These tests are about the tier the middleware
    // resolves, which it sets before the route runs — so the route's own 503 is not only harmless
    // but preferable: enabling perps makes the handler fan out to three real venue APIs, which is
    // slow, flaky and completely irrelevant to what is being asserted here.
    IDENTITY_ENABLED: identity,
  })
  const { app } = createApp(config, {
    providers: memberApiProviders(config, { tier: membershipTier, membershipExpiresAt: TEST_NOW + 86400 }),
    engineClient: mockEngine(),
    now: () => TEST_NOW,
  })
  return app
}

const get = (app, path, headers = {}) => {
  let r = request(app).get(path).set('X-Origin-Auth', ORIGIN_SECRET)
  for (const [k, v] of Object.entries(headers)) r = r.set(k, v)
  return r
}

describe('identity wiring', () => {
  it('resolves a caller with no credential as anonymous, and still serves the read', async () => {
    const res = await get(build(), '/v1/perps/pairs')
    expect(res.headers[TIER_HEADER.toLowerCase()]).toBe(TIERS.ANONYMOUS)
    // Not 403: the read is not gated. (It is 503 here because perps is unconfigured, which is the
    // module answering honestly — a different thing entirely from being refused.)
    expect(res.status).not.toBe(403)
  })

  it('moves a real signed token up the ladder — proving the verifier is registered', async () => {
    // If the late registration ever regressed, this is the only test that would notice: every unit
    // test would still pass while the deployed gateway resolved everyone anonymous.
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const res = await get(build(), '/v1/perps/pairs', { Authorization: `Bearer ${token}` })
    const tier = res.headers[TIER_HEADER.toLowerCase()]
    expect(tier, 'a valid grant must resolve above anonymous').not.toBe(TIERS.ANONYMOUS)
    expect([TIERS.ADDRESS, TIERS.MEMBER]).toContain(tier)
  })

  it('reaches the MEMBER tier when the reference chain reports an active paid tier', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const res = await get(build({ membershipTier: 3 }), '/v1/perps/pairs', {
      Authorization: `Bearer ${token}`,
    })
    expect(res.headers[TIER_HEADER.toLowerCase()]).toBe(TIERS.MEMBER)
  })

  it('stops at ADDRESS when the account holds no paid tier, and does not refuse', async () => {
    // The regression guard, at the integration level: an unpaid member must still be identified
    // and must still be served.
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const app = build({ membershipTier: 0 })
    const res = await get(app, '/v1/perps/pairs', { Authorization: `Bearer ${token}` })
    expect(res.headers[TIER_HEADER.toLowerCase()]).toBe(TIERS.ADDRESS)
    expect(res.status).not.toBe(403)
  })

  it('does not disturb the member API, which runs its own verifier', async () => {
    // /v1/member/* is delegated: this layer observes it and must not add a second refusal for a
    // condition the module already answers more informatively.
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const res = await get(build(), '/v1/member/me', { Authorization: `Bearer ${token}` })
    expect(res.status).toBe(200)
  })

  it('reports anonymous for everyone when the layer is switched off', async () => {
    const token = await memberToken({ scopes: ALL_SCOPES_V1 })
    const res = await get(build({ identity: 'false' }), '/v1/perps/pairs', {
      Authorization: `Bearer ${token}`,
    })
    expect(res.headers[TIER_HEADER.toLowerCase()]).toBe(TIERS.ANONYMOUS)
  })

  it('keeps the origin lock in front of identity, so an off-edge caller costs no verification', async () => {
    // Ordering: the lock is a string comparison; resolution may make a network call. If identity
    // ran first, an off-edge caller could make us do upstream work per request.
    const res = await request(build()).get('/v1/perps/pairs')
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('origin_denied')
  })
})
