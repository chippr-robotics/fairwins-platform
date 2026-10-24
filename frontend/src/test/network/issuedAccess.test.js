/**
 * Issued RPC access — the client half of spec 107.
 *
 * The properties under test, in the order a regression would hurt:
 *
 *   1. THE CREDENTIAL NEVER TOUCHES STORAGE. An issued token in `fw_global_prefs` would ride the
 *      device backup — a stored secret nobody can revoke. The store is module memory, full stop.
 *
 *   2. ROTATION DOES NOT CHURN. The revision bumps only when the ROUTE changes (an issued
 *      endpoint appearing, moving, or being lost) — never on a renewal that keeps the URL. A
 *      per-renewal bump re-derives every provider memo on every chain on a timer.
 *
 *   3. PRECEDENCE: member > issued > default, and the route NEVER carries the credential — the
 *      token reaches the wire per request through the provider preflight, which is also what
 *      keeps it off the failover leg (a different host).
 *
 *   4. EVERY FAILURE MEANS "PUBLIC CAPACITY". A gateway that is down, unconfigured, or declines
 *      the chain leaves reads exactly where they were before this feature existed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  ensureIssuedAccess,
  getIssuedAccessSync,
  currentTokenFor,
  __resetIssuedAccessForTests,
} from '../../lib/network/issuedAccess'
import { resolveRpcEndpoints } from '../../lib/network/rpcEndpoints'
import { endpointsRevision } from '../../lib/network/endpointStore'

const ISSUED_URL = 'https://issued.example.quiknode.pro'
const okResponse = (over = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    endpoint: ISSUED_URL,
    credential: 'jwt-one',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    permits: ['eth_call'],
    tier: 'anonymous',
    keyId: 'k1',
    ...over,
  }),
})

async function acquire(chainId = 137, over = {}, fetchImpl) {
  const impl = fetchImpl ?? vi.fn(async () => okResponse(over))
  ensureIssuedAccess(chainId, { fetchImpl: impl })
  // single-flight promise settles on a microtask; give it a tick
  await new Promise((r) => setTimeout(r, 0))
  return impl
}

beforeEach(() => {
  __resetIssuedAccessForTests()
  vi.stubEnv('VITE_RELAYER_URL', 'https://relay.example')
  try { localStorage.clear() } catch { /* jsdom variants */ }
})

describe('acquisition', () => {
  it('holds the issued endpoint and token after a successful mint', async () => {
    await acquire()
    expect(getIssuedAccessSync(137)).toEqual({ url: ISSUED_URL, permits: ['eth_call'] })
    expect(currentTokenFor(137)).toBe('jwt-one')
  })

  it('does nothing at all when no gateway is configured — keyed access stays dormant', async () => {
    vi.stubEnv('VITE_RELAYER_URL', '')
    const impl = vi.fn()
    ensureIssuedAccess(137, { fetchImpl: impl })
    await new Promise((r) => setTimeout(r, 0))
    expect(impl).not.toHaveBeenCalled()
    expect(getIssuedAccessSync(137)).toBeNull()
  })

  it('is single-flight per chain — concurrent callers cost one request', async () => {
    const impl = vi.fn(async () => okResponse())
    ensureIssuedAccess(137, { fetchImpl: impl })
    ensureIssuedAccess(137, { fetchImpl: impl })
    ensureIssuedAccess(137, { fetchImpl: impl })
    await new Promise((r) => setTimeout(r, 0))
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('cools down after a failure instead of retrying per read', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
    await acquire(137, {}, impl)
    ensureIssuedAccess(137, { fetchImpl: impl })
    await new Promise((r) => setTimeout(r, 0))
    expect(impl).toHaveBeenCalledTimes(1) // the second call sat out the cooldown
    expect(getIssuedAccessSync(137)).toBeNull()
  })
})

describe('the credential never touches storage', () => {
  it('writes nothing to localStorage on acquisition', async () => {
    await acquire()
    const dump = JSON.stringify({ ...localStorage })
    expect(dump).not.toContain('jwt-one')
    expect(dump).not.toContain(ISSUED_URL)
  })
})

describe('rotation does not churn', () => {
  it('bumps the revision ONCE on acquisition', async () => {
    const before = endpointsRevision()
    await acquire()
    expect(endpointsRevision()).toBe(before + 1)
  })

  it('does NOT bump on a renewal that keeps the URL — the token swaps in place', async () => {
    await acquire()
    const before = endpointsRevision()
    // Move the module's clock into the renew-ahead window via the injected `now`, so the held
    // entry still EXISTS when the renewal runs — resetting state here would turn the renewal
    // into a fresh acquisition and make this test assert the wrong transition.
    const nearExpiry = () => Date.now() + 250_000 // inside the 60s renew-ahead of a 300s TTL
    const impl = vi.fn(async () => okResponse({ credential: 'jwt-two' }))
    ensureIssuedAccess(137, { fetchImpl: impl, now: nearExpiry })
    await new Promise((r) => setTimeout(r, 0))
    expect(impl).toHaveBeenCalledTimes(1) // the renewal genuinely ran
    expect(currentTokenFor(137)).toBe('jwt-two')
    expect(endpointsRevision()).toBe(before) // same URL: nothing re-derives
  })
})

describe('resolution precedence', () => {
  it('slots issued access between member override and build default', async () => {
    await acquire()
    const route = resolveRpcEndpoints(137)
    expect(route.source).toBe('issued')
    expect(route.primary.url).toBe(ISSUED_URL)
    // The build default survives as the failover: issued access going dark degrades to the
    // public route, never to nothing.
    expect(route.failover?.url).toBe(route.defaultUrl)
  })

  it('carries NO credential on the route — headers stay empty on both legs', async () => {
    await acquire()
    const route = resolveRpcEndpoints(137)
    expect(route.primary.headers).toEqual({})
    expect(route.failover?.headers ?? {}).toEqual({})
    expect(JSON.stringify(route)).not.toContain('jwt-one')
  })

  it('falls back to the default source when nothing was issued', () => {
    const route = resolveRpcEndpoints(137)
    expect(route.source).toBe('default')
  })

  it('reads an EXPIRED credential as absent, honestly', async () => {
    await acquire(137, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(getIssuedAccessSync(137)).toBeNull()
    expect(currentTokenFor(137)).toBeNull()
    expect(resolveRpcEndpoints(137).source).toBe('default')
  })
})

describe('per-chain honesty', () => {
  it('a 404 (chain deliberately unserved) reads as public-capacity-forever, not as an error', async () => {
    const impl = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    await acquire(63, {}, impl)
    expect(getIssuedAccessSync(63)).toBeNull()
    expect(resolveRpcEndpoints(63).source).toBe('default')
  })

  it('chains do not share state — access for 137 grants nothing to 1', async () => {
    await acquire(137)
    expect(getIssuedAccessSync(1)).toBeNull()
  })
})
