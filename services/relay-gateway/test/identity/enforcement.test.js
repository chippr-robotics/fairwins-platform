/**
 * Enforcement (spec 106, T025) — the slice that actually refuses.
 *
 * Three properties matter more than the refusal codes themselves, and each is a way this could be
 * shipped wrong while looking correct:
 *
 *   1. READS KEEP SERVING. Enforcement must be invisible on every read surface, including with the
 *      challenge service down. A change that gates reads would look like a working security feature
 *      and read as an outage to every logged-out visitor.
 *
 *   2. UNVERIFIABLE IS 503, NEVER 403. If a dependency was unreachable we do not know whether the
 *      caller qualifies. Answering 403 tells a member their credential is bad because our RPC was
 *      slow — and, being non-retryable, tells their client to stop trying.
 *
 *   3. A BUG IN THIS LAYER MUST NOT OPEN A GATED ROUTE. Signing with the platform's credentials is
 *      exactly what an attacker would want a crash here to unlock. It also must not take the
 *      gateway down, so reads still serve and gated routes answer 503.
 */
import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createIdentityMiddleware } from '../../src/identity/middleware.js'
import { TIERS } from '../../src/identity/tiers.js'

const stub = (kind, outcome, tierIfAccepted = TIERS.ANONYMOUS, subject = null) => ({
  kind,
  verify: async () => ({ kind, outcome, tierIfAccepted, subject }),
})

/** Real declared routes: one read (anonymous), one signing route (address). */
const READ = '/v1/perps/pairs'
const SIGN = '/v1/polymarket/137/builder-sign'
const BROADCAST = '/v1/bitcoin/testnet4/tx'

function build({ verifiers = [], enforce = true } = {}) {
  const app = express()
  app.use((req, res, next) => (req.method === 'OPTIONS' ? res.status(204).end() : next()))
  app.use(createIdentityMiddleware({ enabled: true, enforce }, verifiers))
  app.get(READ, (_req, res) => res.json({ ok: true }))
  app.post(SIGN, (_req, res) => res.json({ ok: true }))
  app.post(BROADCAST, (_req, res) => res.json({ ok: true }))
  app.get('/v1/member/me', (_req, res) => res.json({ ok: true }))
  return app
}

describe('enforcement — reads are never gated', () => {
  it('serves a read to a caller with nothing at all', async () => {
    await request(build()).get(READ).expect(200)
  })

  it('serves a read with the challenge service unreachable', async () => {
    // FR-017. A challenge outage costs throughput, never access — that is the whole reason reads
    // sit at the anonymous minimum instead of at `human`.
    const app = build({ verifiers: [stub('challenge', 'unverifiable', TIERS.HUMAN)] })
    await request(app).get(READ).expect(200)
  })

  it('serves a read even when a credential was outright rejected', async () => {
    const app = build({ verifiers: [stub('grant', 'rejected', TIERS.ADDRESS)] })
    await request(app).get(READ).expect(200)
  })
})

describe('enforcement — signing and broadcast demand proof of control', () => {
  it('refuses the builder-signing route with 403 and a code that says what is missing', async () => {
    const res = await request(build()).post(SIGN).send({})
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('account_proof_required')
    expect(res.body.error.required).toEqual({ tier: TIERS.ADDRESS })
  })

  it('refuses Bitcoin broadcast, which is irreversible once it lands', async () => {
    const res = await request(build()).post(BROADCAST).send({})
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('account_proof_required')
  })

  it('admits a caller who has proven control', async () => {
    const app = build({ verifiers: [stub('grant', 'accepted', TIERS.ADDRESS, '0xabc')] })
    await request(app).post(SIGN).send({}).expect(200)
  })

  it('admits a member, since member outranks address', async () => {
    const app = build({ verifiers: [stub('grant', 'accepted', TIERS.MEMBER, '0xabc')] })
    await request(app).post(SIGN).send({}).expect(200)
  })

  it('does NOT admit a caller who only proved they are human', async () => {
    // A challenge proves a browser existed. It says nothing about who is answerable for an order
    // signed with the platform's builder credentials.
    const app = build({ verifiers: [stub('challenge', 'accepted', TIERS.HUMAN, 'tok')] })
    const res = await request(app).post(SIGN).send({})
    expect(res.status).toBe(403)
  })

  it('gives a reason a member can act on, not just a status', async () => {
    const res = await request(build()).post(SIGN).send({})
    expect(res.body.error.reason).toMatch(/authorise|Settings/i)
  })
})

describe('enforcement — unverifiable is retryable, never a denial', () => {
  it('answers 503 auth_unverifiable when a gated route cannot verify the caller', async () => {
    const app = build({ verifiers: [stub('grant', 'unverifiable', TIERS.ADDRESS)] })
    const res = await request(app).post(SIGN).send({})
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('auth_unverifiable')
  })

  it('says explicitly that this is not a decision about the credential', async () => {
    const app = build({ verifiers: [stub('grant', 'unverifiable', TIERS.ADDRESS)] })
    const res = await request(app).post(SIGN).send({})
    expect(res.body.error.reason).toMatch(/not a decision/i)
  })

  it('still refuses with 403 when the credential was genuinely rejected', async () => {
    // The other half of the distinction: we DID check, and the answer was no.
    const app = build({ verifiers: [stub('grant', 'rejected', TIERS.ADDRESS)] })
    const res = await request(app).post(SIGN).send({})
    expect(res.status).toBe(403)
  })
})

describe('enforcement — observe mode changes nothing', () => {
  it('serves a gated route untouched when enforce is off', async () => {
    // The deployment path: resolve in production, watch the tiers, then turn enforcement on.
    await request(build({ enforce: false })).post(SIGN).send({}).expect(200)
  })
})

describe('enforcement — route surface is not disclosed', () => {
  it('lets an unlisted path 404 rather than converting it to a 403', async () => {
    // The table's completeness is guaranteed by CI (routeTable.test.js enumerates the real app),
    // not by refusing everything unlisted at runtime — which would hand a prober a map of which
    // paths exist, since this middleware runs before dispatch and cannot tell mounted from not.
    await request(build()).get('/v1/not/a/route').expect(404)
  })

  it('leaves the member tree to its own verifier', async () => {
    await request(build()).get('/v1/member/me').expect(200)
  })
})

describe('enforcement — a fault in this layer must not open a gated route', () => {
  it('answers 503 on a gated route when resolution itself crashes', async () => {
    // Fail-open here would mean a bug in the identity layer unlocks signing with the platform's
    // credentials — precisely what an attacker would aim for.
    const app = build({ verifiers: /** @type {any} */ ({}) })
    const res = await request(app).post(SIGN).send({})
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('auth_unverifiable')
  })

  it('still serves reads when resolution crashes, so the gateway does not go down with it', async () => {
    const app = build({ verifiers: /** @type {any} */ ({}) })
    await request(app).get(READ).expect(200)
  })
})
