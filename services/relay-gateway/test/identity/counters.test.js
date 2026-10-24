/**
 * Usage counters (spec 106/#1447, T033).
 *
 * The property that outranks the rest: LABELS ARE BOUNDED BY CONSTRUCTION. The tier map is
 * pre-seeded from the ladder and CLOSED — an unknown value is dropped, never added — because a
 * label set that request content can grow makes series count a function of usage, which is the
 * exact cardinality failure FR-036 exists to prevent. Everything else here is plumbing.
 */
import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createIdentityCounters, startCountersServer } from '../../src/metrics/counters.js'
import { createUpstreamCeilings, withUpstreamCeiling } from '../../src/identity/upstreamCeiling.js'
import { createIdentityMiddleware } from '../../src/identity/middleware.js'
import { OBSERVABLE_TIERS, TIERS } from '../../src/identity/tiers.js'

describe('identity counters — bounded by construction', () => {
  it('pre-seeds exactly the observable tiers and starts them at zero', () => {
    const counters = createIdentityCounters()
    expect(Object.keys(counters.snapshot()).sort()).toEqual([...OBSERVABLE_TIERS].sort())
    for (const v of Object.values(counters.snapshot())) expect(v).toBe(0)
  })

  it('DROPS an unknown tier rather than growing the label set', () => {
    const counters = createIdentityCounters()
    counters.hitTier('0xdeadbeef-as-a-tier')
    counters.hitTier('app') // declared but unreachable — deliberately not observable
    expect(Object.keys(counters.snapshot()).sort()).toEqual([...OBSERVABLE_TIERS].sort())
    expect(Object.values(counters.snapshot()).reduce((a, b) => a + b, 0)).toBe(0)
  })

  it('counts per tier, cumulatively', () => {
    const counters = createIdentityCounters()
    counters.hitTier(TIERS.ANONYMOUS)
    counters.hitTier(TIERS.ANONYMOUS)
    counters.hitTier(TIERS.ADDRESS)
    expect(counters.snapshot()).toMatchObject({ anonymous: 2, address: 1, human: 0, member: 0 })
  })
})

describe('the middleware feeds the counters', () => {
  const stub = (outcome, tier, subject) => ({ kind: 'grant', verify: async () => ({ outcome, tierIfAccepted: tier, subject }) })

  it('counts at RESOLUTION, refusals included', async () => {
    // A refused request still consumed identity work; a series counting only successes would
    // understate exactly the traffic an operator is trying to see.
    const counters = createIdentityCounters()
    const app = express()
    app.use(createIdentityMiddleware({ enabled: true, enforce: true, counters }, []))
    app.post('/v1/bitcoin/testnet4/tx', (_req, res) => res.json({ ok: true }))
    await request(app).post('/v1/bitcoin/testnet4/tx').send({}).expect(403)
    expect(counters.snapshot().anonymous).toBe(1)
  })

  it('attributes an accepted credential to ITS tier', async () => {
    const counters = createIdentityCounters()
    const app = express()
    app.use(createIdentityMiddleware({ enabled: true, counters }, [stub('accepted', TIERS.MEMBER, '0xabc')]))
    app.get('/x', (_req, res) => res.json({}))
    await request(app).get('/x')
    expect(counters.snapshot().member).toBe(1)
  })

  it('counts a disabled layer as anonymous — traffic exists whether or not identity looks at it', async () => {
    const counters = createIdentityCounters()
    const app = express()
    app.use(createIdentityMiddleware({ enabled: false, counters }, []))
    app.get('/x', (_req, res) => res.json({}))
    await request(app).get('/x')
    expect(counters.snapshot().anonymous).toBe(1)
  })
})

describe('cumulative upstream calls', () => {
  it('counts UNLIMITED upstreams too — an uncapped upstream is the one that most needs visibility', async () => {
    const ceilings = createUpstreamCeilings({}, 60_000, () => 1_000_000)
    const client = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    await client.get('/a')
    await client.get('/b')
    expect(ceilings.cumulative()).toEqual({ opensea: 2 })
  })

  it('counts a refused call as an attempt in the window but the cumulative reflects the take', async () => {
    const ceilings = createUpstreamCeilings({ opensea: 1 }, 60_000, () => 1_000_000)
    const client = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    await client.get('/a')
    await expect(client.get('/b')).rejects.toThrow()
    // Both takes counted: attribution is about demand on the credential, and a refusal is demand.
    expect(ceilings.cumulative().opensea).toBe(2)
  })
})

describe('the counters endpoint', () => {
  it('serves the JSON shape the FinOps collector expects, and closes cleanly', async () => {
    const counters = createIdentityCounters()
    counters.hitTier(TIERS.HUMAN)
    const ceilings = createUpstreamCeilings({}, 60_000, () => 5)
    ceilings.take('perps')
    const server = startCountersServer({ port: 0, counters, upstreamCeilings: ceilings, now: () => 42 })
    await new Promise((r) => server.on('listening', r))
    const { port } = server.address()
    const res = await fetch(`http://127.0.0.1:${port}/counters`)
    const body = await res.json()
    server.close()
    expect(body.tierRequests.human).toBe(1)
    expect(body.upstreamCalls.perps).toBe(1)
    expect(body.sinceMs).toBe(42)
  })

  it('stands down on a bind failure instead of taking the gateway with it', async () => {
    const logs = []
    const counters = createIdentityCounters()
    const blocker = startCountersServer({ port: 0, counters, upstreamCeilings: null })
    await new Promise((r) => blocker.on('listening', r))
    const { port } = blocker.address()
    const loser = startCountersServer({ port, counters, upstreamCeilings: null, log: (m) => logs.push(m) })
    await new Promise((r) => setTimeout(r, 50))
    blocker.close()
    loser.close()
    expect(logs.join(' ')).toMatch(/degrades to unreadable/)
  })
})
