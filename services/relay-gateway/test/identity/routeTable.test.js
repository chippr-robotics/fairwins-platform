/**
 * Protected-route table (spec 106, T007).
 *
 * The important test here is `every mounted route is declared`, and it deliberately enumerates the
 * REAL Express app rather than comparing against a list written by hand. A hand-copied list drifts
 * the moment someone adds a route, and it drifts SILENTLY — the new route simply would not appear
 * in either the list or the table, and a test comparing one to the other would stay green while the
 * route shipped ungated and unmetered. That is exactly how the gateway reached the state this
 * feature repairs, so the guard has to read the source of truth.
 *
 * The reverse direction matters too: a declared route that is not mounted is dead configuration
 * that will read as protection during a review.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createApp } from '../../src/server.js'
import { testConfig, mockEngine, mockProviders } from '../helpers.js'
import {
  ROUTE_TABLE,
  DELEGATED_PREFIXES,
  UPSTREAMS,
  lookupRoute,
} from '../../src/identity/routeTable.js'
import { TIERS } from '../../src/identity/tiers.js'

/** Walk an Express 5 app/router stack and collect "METHOD /path" for every mounted route. */
function mountedRoutes(app) {
  const out = []
  const walk = (stack) => {
    for (const layer of stack || []) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          if (m !== '_all') out.push(`${m.toUpperCase()} ${layer.route.path}`)
        }
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack)
      }
    }
  }
  walk(app._router?.stack || app.router?.stack)
  return [...new Set(out)]
}

const declared = new Set(ROUTE_TABLE.map((r) => `${r.method} ${r.pattern}`))
const isDelegated = (p) => DELEGATED_PREFIXES.some((prefix) => p.startsWith(prefix))

describe('route table — coverage against the real app', () => {
  let mounted
  beforeAll(() => {
    // Enable every optional module, so the enumeration sees the routes a production deployment
    // mounts rather than only the always-on subset. A module that is off still mounts (it answers
    // 503), but keeping this explicit means the guard cannot be weakened by a config default.
    const config = testConfig({
      OPENSEA_API_KEY: 'test-os-key',
      POLYMARKET_API_KEY: 'test-pm-key',
      POLYMARKET_API_SECRET: 'test-pm-secret',
      POLYMARKET_API_PASSPHRASE: 'test-pm-pass',
      PERPS_ENABLED: 'true',
      BTC_ENABLED: 'true',
      MEMBER_API_ENABLED: 'true',
    })
    const { app } = createApp(config, {
      providers: mockProviders(config),
      engineClient: mockEngine(),
    })
    mounted = mountedRoutes(app)
  })

  it('mounts something at all (guards against a broken enumeration silently passing)', () => {
    // If the walk ever stops finding routes, every other assertion in this file becomes vacuous.
    expect(mounted.length).toBeGreaterThan(5)
  })

  it('declares EVERY mounted route — silence is not permission', () => {
    const undeclared = mounted.filter((entry) => {
      const path = entry.slice(entry.indexOf(' ') + 1)
      return !isDelegated(path) && !declared.has(entry)
    })
    expect(undeclared, `undeclared routes would ship ungated:\n${undeclared.join('\n')}`).toEqual([])
  })

  it('declares nothing that is not mounted — dead config reads as protection', () => {
    const mountedSet = new Set(mounted)
    const phantom = [...declared].filter((d) => !mountedSet.has(d))
    // /healthz and /status are declared for completeness; everything else must be real.
    const unexpected = phantom.filter((p) => !/\/(healthz|status)$/.test(p))
    expect(unexpected, `declared but not mounted:\n${unexpected.join('\n')}`).toEqual([])
  })
})

describe('route table — tier assignment', () => {
  it('puts EVERY read at anonymous: a challenge buys throughput, not entry', () => {
    // FR-006 + FR-017. If a read ever gains a minimum above anonymous, an unreachable challenge
    // service becomes a non-retryable 403 on the surfaces that must keep working, and a logged-out
    // visitor needs a challenge ceremony before the first market fetch.
    const gatedReads = ROUTE_TABLE.filter(
      (r) => r.class === 'read' && r.minimumTier !== TIERS.ANONYMOUS
    )
    expect(gatedReads.map((r) => r.pattern)).toEqual([])
  })

  it('requires an answerable party for everything that signs or broadcasts', () => {
    const risky = ROUTE_TABLE.filter((r) => r.class === 'write' || r.class === 'sign')
    expect(risky.length).toBeGreaterThan(0)
    for (const route of risky) {
      expect(route.minimumTier, `${route.pattern} must demand proof of control`).toBe(TIERS.ADDRESS)
    }
  })

  it('never demands `member`, so trading does not silently require a purchase', () => {
    // The spec-095 verifier refuses without an ACTIVE PAID membership. Demanding `member` on a
    // trading route would stop an unpaid member from trading at all — a regression this table
    // would have introduced quietly.
    const paywalled = ROUTE_TABLE.filter((r) => r.minimumTier === TIERS.MEMBER)
    expect(paywalled.map((r) => r.pattern)).toEqual([])
  })

  it('gates the builder-signing route, which spends commercial standing rather than money', () => {
    const signing = ROUTE_TABLE.find((r) => r.pattern.endsWith('/builder-sign'))
    expect(signing).toBeDefined()
    expect(signing.minimumTier).toBe(TIERS.ADDRESS)
    expect(signing.class).toBe('sign')
  })

  it('gates Bitcoin broadcast but not Bitcoin reads', () => {
    const broadcast = ROUTE_TABLE.find((r) => r.method === 'POST' && r.pattern === '/v1/bitcoin/:network/tx')
    const read = ROUTE_TABLE.find((r) => r.pattern === '/v1/bitcoin/:network/fees')
    expect(broadcast.minimumTier).toBe(TIERS.ADDRESS)
    expect(read.minimumTier).toBe(TIERS.ANONYMOUS)
  })

  it('leaves self-authenticating value paths at anonymous', () => {
    // The member's signature is inside the payload and these routes already enforce spend caps.
    // A tier minimum here would break the never-stranded rule: a second credential would be needed
    // to submit an intent the member has already signed.
    for (const p of ['/v1/intents', '/v1/paymaster']) {
      expect(ROUTE_TABLE.find((r) => r.pattern === p).minimumTier).toBe(TIERS.ANONYMOUS)
    }
  })
})

describe('lookupRoute', () => {
  it('matches a concrete path against its parameterised declaration', () => {
    const hit = lookupRoute('POST', '/v1/bitcoin/testnet4/tx')
    expect(hit.minimumTier).toBe(TIERS.ADDRESS)
  })

  it('anchors the match, so a longer path cannot ride a shorter declaration', () => {
    // Without anchoring, `/v1/perps/pairs/../../admin` style paths could match a read declaration.
    expect(lookupRoute('GET', '/v1/perps/pairs/extra')).toBeNull()
  })

  it('does not let one method borrow another method\'s declaration', () => {
    // GET /v1/bitcoin/:network/tx/:txid is a read; POST /v1/bitcoin/:network/tx is a broadcast.
    expect(lookupRoute('GET', '/v1/bitcoin/testnet4/tx')).toBeNull()
  })

  it('reports the member tree as delegated rather than matching or refusing it', () => {
    expect(lookupRoute('GET', '/v1/member/me')).toEqual({ delegated: true })
  })

  it('returns null for an unknown path rather than defaulting it open', () => {
    expect(lookupRoute('GET', '/v1/something/new')).toBeNull()
  })
})

describe('UPSTREAMS', () => {
  it('is a bounded label set derived from the table, never from request content', () => {
    expect(UPSTREAMS.length).toBeGreaterThan(0)
    for (const u of UPSTREAMS) expect(typeof u).toBe('string')
    expect(new Set(UPSTREAMS).size).toBe(UPSTREAMS.length)
  })
})
