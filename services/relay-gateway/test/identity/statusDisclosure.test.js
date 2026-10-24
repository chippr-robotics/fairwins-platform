/**
 * Status disclosure (spec 106 slice 5c, #1448 / T037; narrowed by #1505).
 *
 * THREE rules now, and the third was bought in production:
 *
 *   1. /status IS ORIGIN-LOCK EXEMPT. The first draft of the API contract asserted the opposite,
 *      and anything added on that belief would have been world-readable on the raw origin URL.
 *      The identity/access blocks therefore sit behind the edge gate, and the PUBLIC body test
 *      is the load-bearing one here.
 *
 *   2. DISABLED MUST BE LEGIBLE (FR-015) — but to an OPERATOR, not to the world. A gateway with
 *      identity checks off looks exactly like one enforcing them from the outside. That legibility
 *      now lives at BOOT and on every SIGHUP reload (`describeIdentityMode`), which is always
 *      available to anyone who can read the journal; it is no longer carried by an HTTP body.
 *
 *   3. `enforcing` IS OPERATOR-ONLY (#1505), and this rule was bought in production. The origin
 *      lock is NOT an authorization check: Cloudflare's zone-wide Transform Rule injects
 *      `X-Origin-Auth` on every request, so the "gated" view was readable by anyone curling the
 *      public hostname — measured 2026-09-06. `enforcing` is the single most useful fact an abuser
 *      can learn here (observe mode says the door is open), so it moved behind a real inbound
 *      operator secret. Everything else stays at the edge tier, because the on-VM probe reads that
 *      view for the gas-wallet runway.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../../src/server.js'
import { testConfig, mockEngine, mockProviders, ORIGIN_SECRET } from '../helpers.js'

const OPS_SECRET = 'ops-only-secret'

function build(env = {}) {
  const config = testConfig({ OPS_STATUS_SECRET: OPS_SECRET, ...env })
  const { app } = createApp(config, { providers: mockProviders(config), engineClient: mockEngine() })
  return { app, config }
}

describe('/status — the gated identity disclosure', () => {
  it('withholds callerIdentity, upstreams and access from the PUBLIC body', async () => {
    // The load-bearing test: /status answers without the origin-lock header, so everything in
    // the public body is readable by anyone who finds the raw origin URL.
    const { app } = build({ IDENTITY_ENABLED: 'true' })
    const res = await request(app).get('/status')
    expect(res.status).toBe(200)
    expect(res.body.callerIdentity).toBeUndefined()
    expect(res.body.upstreams).toBeUndefined()
    expect(res.body.access).toBeUndefined()
  })

  it('disclosed: reports enforcing:false EXPLICITLY when the layer is off (FR-015)', async () => {
    const { app } = build({ IDENTITY_ENABLED: 'false' })
    const res = await request(app).get('/status')
      .set('X-Origin-Auth', ORIGIN_SECRET).set('X-FairWins-Ops', OPS_SECRET)
    expect(res.body.callerIdentity.enabled).toBe(false)
    expect(res.body.callerIdentity.enforcing).toBe(false) // present, not merely absent
  })

  it('disclosed: resolving-but-not-enforcing reads as enabled:true, enforcing:false', async () => {
    const { app } = build({ IDENTITY_ENABLED: 'true' })
    const res = await request(app).get('/status')
      .set('X-Origin-Auth', ORIGIN_SECRET).set('X-FairWins-Ops', OPS_SECRET)
    expect(res.body.callerIdentity).toMatchObject({ enabled: true, enforcing: false })
  })

  it('disclosed: enforcement reads the LIVE config, so a SIGHUP reload shows on the next poll', async () => {
    const { app, config } = build({ IDENTITY_ENABLED: 'true' })
    config.identity.enforce = true // what the reload handler's mutation amounts to
    const res = await request(app).get('/status')
      .set('X-Origin-Auth', ORIGIN_SECRET).set('X-FairWins-Ops', OPS_SECRET)
    expect(res.body.callerIdentity.enforcing).toBe(true)
  })

  it('disclosed: the killswitch reads as not-enforcing even while enabled', async () => {
    const { app } = build({ IDENTITY_ENABLED: 'true', IDENTITY_ENFORCE: 'true', IDENTITY_KILLSWITCH: 'true' })
    const res = await request(app).get('/status')
      .set('X-Origin-Auth', ORIGIN_SECRET).set('X-FairWins-Ops', OPS_SECRET)
    expect(res.body.callerIdentity.enforcing).toBe(false)
  })

  it('disclosed: attestation reports "not-built" — a fact about the codebase, not a switch', async () => {
    const { app } = build({ IDENTITY_ENABLED: 'true' })
    const res = await request(app).get('/status').set('X-Origin-Auth', ORIGIN_SECRET)
    expect(res.body.callerIdentity.verifiers.attestation).toBe('not-built')
  })

  it('disclosed: the challenge verifier states configured / not-configured honestly', async () => {
    const off = await request(build({ IDENTITY_ENABLED: 'true' }).app)
      .get('/status').set('X-Origin-Auth', ORIGIN_SECRET)
    expect(off.body.callerIdentity.verifiers.challenge).toBe('not-configured')

    const on = await request(build({ IDENTITY_ENABLED: 'true', CHALLENGE_SECRET: 'real-secret' }).app)
      .get('/status').set('X-Origin-Auth', ORIGIN_SECRET)
    expect(on.body.callerIdentity.verifiers.challenge).toBe('configured')
  })

  it('disclosed: upstream labels come from the bounded table, never request content (FR-036)', async () => {
    const { app } = build({ IDENTITY_ENABLED: 'true', UPSTREAM_CEILING_OPENSEA: '100' })
    const res = await request(app).get('/status').set('X-Origin-Auth', ORIGIN_SECRET)
    expect(res.body.upstreams.state).toBe('read')
    for (const key of Object.keys(res.body.upstreams.ceilings)) {
      expect(key).toMatch(/^[a-z]+$/) // module ids — never an address, wager id, or path
    }
  })

  // ---- #1505: the case production actually is ----

  it('withholds `enforcing` from an EDGE caller — the case production actually was', async () => {
    // THE REGRESSION TEST FOR #1505. Cloudflare injects X-Origin-Auth for everyone, so this
    // request is what any member of the public sends. It still gets the operator telemetry the
    // on-VM probe needs, but NOT the one field that tells an abuser the door is open.
    const { app } = build({ IDENTITY_ENABLED: 'true', IDENTITY_ENFORCE: 'true' })
    const res = await request(app).get('/status').set('X-Origin-Auth', ORIGIN_SECRET)
    expect(res.body.callerIdentity).toBeDefined()
    expect(res.body.callerIdentity.enabled).toBe(true)
    expect(res.body.callerIdentity).not.toHaveProperty('enforcing')
  })

  it('gives `enforcing` ONLY to the operator secret, and the edge secret does not substitute', async () => {
    const { app } = build({ IDENTITY_ENABLED: 'true', IDENTITY_ENFORCE: 'true' })
    const ops = await request(app).get('/status')
      .set('X-Origin-Auth', ORIGIN_SECRET).set('X-FairWins-Ops', OPS_SECRET)
    expect(ops.body.callerIdentity.enforcing).toBe(true)

    const wrong = await request(app).get('/status')
      .set('X-Origin-Auth', ORIGIN_SECRET).set('X-FairWins-Ops', 'not-the-secret')
    expect(wrong.body.callerIdentity).not.toHaveProperty('enforcing')
  })

  it('withholds `enforcing` when NO operator secret is configured — absent, never a public fallback', async () => {
    // The failure direction matters: "nobody sees it" is recoverable, "everybody sees it" is not.
    const config = testConfig({ IDENTITY_ENABLED: 'true', IDENTITY_ENFORCE: 'true' }) // no OPS_STATUS_SECRET
    const { app } = createApp(config, { providers: mockProviders(config), engineClient: mockEngine() })
    const res = await request(app).get('/status')
      .set('X-Origin-Auth', ORIGIN_SECRET).set('X-FairWins-Ops', 'anything')
    expect(res.body.callerIdentity).not.toHaveProperty('enforcing')
  })

  it('the operator secret alone does NOT unlock the edge tier — the two gates are independent', async () => {
    // Guards against someone collapsing the two into one predicate later. The probe's runway
    // fields must stay on the edge gate; the ops secret only adds `enforcing`.
    const { app } = build({ IDENTITY_ENABLED: 'true' })
    const res = await request(app).get('/status').set('X-FairWins-Ops', OPS_SECRET)
    expect(res.body.callerIdentity).toBeUndefined()
    expect(res.body.upstreams).toBeUndefined()
  })

  it('disclosed: keyed access reports not-configured while dormant, as a state and not an absence', async () => {
    const { app } = build({})
    const res = await request(app).get('/status').set('X-Origin-Auth', ORIGIN_SECRET)
    expect(res.body.access).toEqual({ state: 'not-configured' })
  })
})
