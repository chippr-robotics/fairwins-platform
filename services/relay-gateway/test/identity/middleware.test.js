/**
 * Caller-identity middleware (spec 106, T011).
 *
 * Slice 1 resolves and does NOT enforce, so the most valuable assertion in this file is the boring
 * one: **no status code changed**. A safety layer that quietly starts refusing traffic the moment
 * it is mounted is worse than no safety layer, because the failure arrives as "the product is
 * broken" rather than "the feature is off".
 *
 * The rest pins the ordering facts, each of which is a real bug if it inverts:
 *   - preflight must never reach resolution, or every OPTIONS resolves anonymous and pollutes the
 *     metering this layer exists to make honest;
 *   - an unmounted path must still resolve, or a prober can map the route surface by comparing 404
 *     against 403;
 *   - a fault inside this layer must degrade to anonymous, never 500 the gateway.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createIdentityMiddleware, TIER_HEADER } from '../../src/identity/middleware.js'
import { createAttestationVerifier } from '../../src/identity/verifiers/attestation.js'
import { TIERS } from '../../src/identity/tiers.js'

const stub = (kind, outcome, tierIfAccepted = TIERS.ANONYMOUS, subject = null) => ({
  kind,
  verify: async () => ({ kind, outcome, tierIfAccepted, subject }),
})

/** Minimal app: the middleware plus one echo route and one 404-by-omission. */
function build({ enabled = true, verifiers = [createAttestationVerifier()] } = {}) {
  const app = express()
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return res.status(204).end() // stands in for the CORS layer
    next()
  })
  app.use(createIdentityMiddleware({ enabled }, verifiers))
  app.get('/v1/perps/pairs', (req, res) =>
    res.json({ tier: req.caller?.tier, subject: req.callerSubject, enforcement: req.caller?.enforcement })
  )
  app.post('/v1/bitcoin/testnet4/tx', (req, res) => res.status(202).json({ ok: true }))
  return app
}

describe('identity middleware — slice 1 changes no behaviour', () => {
  it('leaves a read route serving 200 with no credential at all', async () => {
    const res = await request(build()).get('/v1/perps/pairs')
    expect(res.status).toBe(200)
    expect(res.body.tier).toBe(TIERS.ANONYMOUS)
  })

  it('leaves a WRITE route serving its normal status even though nothing is proven', async () => {
    // Enforcement is a later slice. If mounting resolution alone started refusing writes, the
    // feature would have shipped its riskiest behaviour first and unannounced.
    const res = await request(build()).post('/v1/bitcoin/testnet4/tx').send({})
    expect(res.status).toBe(202)
  })

  it('still 404s an unmounted path rather than converting it to a 403', async () => {
    // A prober must not be able to map the route surface from the difference.
    const res = await request(build()).get('/v1/not/a/route')
    expect(res.status).toBe(404)
  })

  it('reports enforcement mode as `observe`, so the state is legible rather than inferred', async () => {
    const res = await request(build()).get('/v1/perps/pairs')
    expect(res.body.enforcement).toBe('observe')
  })
})

describe('identity middleware — the tier header', () => {
  it('reports the resolved tier', async () => {
    const app = build({ verifiers: [stub('grant', 'accepted', TIERS.ADDRESS, '0xabc')] })
    const res = await request(app).get('/v1/perps/pairs')
    expect(res.headers[TIER_HEADER.toLowerCase()]).toBe(TIERS.ADDRESS)
  })

  it('IGNORES a tier header sent by the caller', async () => {
    // The header is diagnostic output, never an input. If a caller could assert a tier, the whole
    // layer would be decorative.
    const app = build({ verifiers: [stub('grant', 'absent')] })
    const res = await request(app).get('/v1/perps/pairs').set(TIER_HEADER, TIERS.MEMBER)
    expect(res.headers[TIER_HEADER.toLowerCase()]).toBe(TIERS.ANONYMOUS)
    expect(res.body.tier).toBe(TIERS.ANONYMOUS)
  })

  it('never reports the app tier, which the web cannot reach', async () => {
    const app = build({
      verifiers: [createAttestationVerifier(), stub('grant', 'accepted', TIERS.MEMBER, '0xabc')],
    })
    const res = await request(app).get('/v1/perps/pairs')
    expect(res.headers[TIER_HEADER.toLowerCase()]).not.toBe(TIERS.APP)
  })
})

describe('identity middleware — ordering', () => {
  it('never resolves a preflight', async () => {
    // A browser cannot attach credentials to OPTIONS. If resolution saw one, every preflight would
    // resolve anonymous and be metered as a real request.
    let calls = 0
    const counting = { kind: 'grant', verify: async () => { calls++; return { outcome: 'absent' } } }
    const app = build({ verifiers: [counting] })
    await request(app).options('/v1/perps/pairs').expect(204)
    expect(calls).toBe(0)
  })

  it('resolves for an unmounted path too', async () => {
    let calls = 0
    const counting = { kind: 'grant', verify: async () => { calls++; return { outcome: 'absent' } } }
    await request(build({ verifiers: [counting] })).get('/v1/not/a/route')
    expect(calls).toBe(1)
  })
})

describe('identity middleware — disabled is inert, not permissive-looking', () => {
  it('still populates req.caller so downstream code reads one shape always', async () => {
    const res = await request(build({ enabled: false })).get('/v1/perps/pairs')
    expect(res.body.tier).toBe(TIERS.ANONYMOUS)
    expect(res.body.subject).toMatch(/^anonymous:ip:/)
  })

  it('marks enforcement `off`, distinguishable from an enforcing layer that saw nothing', async () => {
    // FR-015. `off` and `observe` both yield an anonymous caller; only the mode says which.
    const res = await request(build({ enabled: false })).get('/v1/perps/pairs')
    expect(res.body.enforcement).toBe('off')
  })

  it('does not run verifiers at all when disabled', async () => {
    let calls = 0
    const counting = { kind: 'grant', verify: async () => { calls++; return { outcome: 'absent' } } }
    await request(build({ enabled: false, verifiers: [counting] })).get('/v1/perps/pairs')
    expect(calls).toBe(0)
  })
})

describe('identity middleware — a fault in this layer must not take down the gateway', () => {
  it('keeps serving when a VERIFIER throws, and stays in normal observe mode', async () => {
    // A throwing verifier is contained by the resolver, which records it as `unverifiable` and
    // carries on. Resolution SUCCEEDED — it produced a well-formed verdict — so the middleware has
    // nothing to degrade from. Asserting `degraded` here would have been asserting a worse design.
    const broken = { kind: 'grant', get verify() { throw new Error('exploded') } }
    const res = await request(build({ verifiers: [broken] })).get('/v1/perps/pairs')
    expect(res.status).toBe(200)
    expect(res.body.tier).toBe(TIERS.ANONYMOUS)
    expect(res.body.enforcement).toBe('observe')
  })

  it('degrades to anonymous and keeps serving when RESOLUTION itself throws', async () => {
    // The middleware's own guard, for a resolver-contract violation rather than a verifier fault:
    // a non-iterable verifier set makes resolve() reject outright. The gateway must keep serving —
    // a bug in the identity layer becoming a 500 on every request is a far worse outcome than the
    // layer temporarily knowing nothing.
    const res = await request(build({ verifiers: /** @type {any} */ ({}) })).get('/v1/perps/pairs')
    expect(res.status).toBe(200)
    expect(res.body.tier).toBe(TIERS.ANONYMOUS)
    expect(res.body.enforcement).toBe('degraded')
  })
})

describe('identity middleware — the metering subject', () => {
  it('keys on the proven account once something is proven', async () => {
    const app = build({ verifiers: [stub('grant', 'accepted', TIERS.ADDRESS, '0xabc')] })
    const res = await request(app).get('/v1/perps/pairs')
    expect(res.body.subject).toBe('address:0xabc')
  })

  it('does not key on anything the caller wrote into the request', async () => {
    // The defect being repaired: quotas keyed on an address supplied in the path, which is a name
    // the caller chooses and can change per request, so it metered nothing.
    const app = build({ verifiers: [stub('grant', 'absent')] })
    const res = await request(app).get('/v1/perps/pairs')
    expect(res.body.subject).not.toContain('0x')
  })
})
