/**
 * Per-upstream ceilings (spec 106, T030 / FR-013).
 *
 * The requirement says the ceiling is enforced BEFORE the upstream is called, and the whole file
 * turns on proving that literally. **Asserting a 429 would not be enough**: a cap applied after the
 * fetch still lets the request reach the vendor, still gets counted against our key, and on a
 * metered API has already been billed. So the assertions below check that the upstream FUNCTION WAS
 * NOT INVOKED — a receipt versus a budget.
 *
 * The second thing worth pinning is that a cache hit must not spend the ceiling. That is why the
 * check wraps the client and not the route: most requests to these modules are served from cache
 * and never touch the vendor, and a route-level ceiling would exhaust a budget on traffic that
 * spends nothing — refusing callers to protect a credential nobody was using.
 */
import { describe, it, expect } from 'vitest'
import { createUpstreamCeilings, withUpstreamCeiling } from '../../src/identity/upstreamCeiling.js'

const clock = (start = 1_000_000) => {
  let t = start
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('upstream ceilings — the cap runs before the call', () => {
  it('does NOT invoke the upstream once the ceiling is reached', async () => {
    // The assertion that makes this a budget rather than a receipt.
    const c = clock()
    const ceilings = createUpstreamCeilings({ opensea: 2 }, 60_000, c.now)
    let calls = 0
    const client = withUpstreamCeiling({ get: async () => { calls++; return {} } }, 'opensea', ceilings)

    await client.get('/a')
    await client.get('/b')
    expect(calls).toBe(2)

    await expect(client.get('/c')).rejects.toMatchObject({ status: 429 })
    expect(calls, 'the upstream must not be reached past the ceiling').toBe(2)
  })

  it('throws rather than returning a verdict, so there is no way to spend past the cap', async () => {
    // A boolean return would invite "check afterwards", which is the failure mode being prevented.
    const ceilings = createUpstreamCeilings({ opensea: 0 + 1 }, 60_000, clock().now)
    const client = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    await client.get('/a')
    await expect(client.get('/b')).rejects.toThrow()
  })

  it('uses a distinct code from the per-caller quota', async () => {
    // A caller who has taken nothing must not be told they have taken too much.
    const ceilings = createUpstreamCeilings({ opensea: 1 }, 60_000, clock().now)
    const client = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    await client.get('/a')
    await expect(client.get('/b')).rejects.toMatchObject({ code: 'upstream_ceiling_reached' })
  })

  it('carries a Retry-After so a client backs off rather than hammering', async () => {
    const ceilings = createUpstreamCeilings({ opensea: 1 }, 60_000, clock().now)
    const client = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    await client.get('/a')
    await expect(client.get('/b')).rejects.toMatchObject({ retryAfterSec: expect.any(Number) })
  })

  it('recovers once the window rolls', async () => {
    const c = clock()
    const ceilings = createUpstreamCeilings({ opensea: 1 }, 60_000, c.now)
    let calls = 0
    const client = withUpstreamCeiling({ get: async () => { calls++; return {} } }, 'opensea', ceilings)
    await client.get('/a')
    await expect(client.get('/b')).rejects.toThrow()
    c.advance(60_001)
    await client.get('/c')
    expect(calls).toBe(2)
  })
})

describe('upstream ceilings — isolation and absence', () => {
  it('keeps upstreams in separate budgets', async () => {
    // Exhausting the collectibles vendor must not stop prediction-market reads.
    const ceilings = createUpstreamCeilings({ opensea: 1, polymarket: 5 }, 60_000, clock().now)
    const os = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    const pm = withUpstreamCeiling({ get: async () => ({}) }, 'polymarket', ceilings)
    await os.get('/a')
    await expect(os.get('/b')).rejects.toThrow()
    await pm.get('/a') // unaffected
  })

  it('treats an UNSET ceiling as unlimited, not as zero', async () => {
    // Absence is honest. Inventing a cap the operator did not choose would refuse traffic in the
    // name of a budget nobody set — and a default of zero would refuse everything.
    const ceilings = createUpstreamCeilings({}, 60_000, clock().now)
    const client = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    for (let i = 0; i < 50; i++) await client.get('/x')
  })
})

describe('upstream ceilings — the wrapper', () => {
  it('covers every function on the client, including ones added later', async () => {
    // An explicit method list fails in exactly one way: the method somebody forgets is the one that
    // spends without a cap. Proxying every function makes a new method covered by default.
    const ceilings = createUpstreamCeilings({ opensea: 1 }, 60_000, clock().now)
    const client = withUpstreamCeiling(
      { get: async () => ({}), post: async () => ({}), somethingNew: async () => ({}) },
      'opensea',
      ceilings
    )
    await client.somethingNew()
    await expect(client.post()).rejects.toMatchObject({ code: 'upstream_ceiling_reached' })
  })

  it('passes arguments and results through untouched', async () => {
    const ceilings = createUpstreamCeilings({}, 60_000, clock().now)
    const client = withUpstreamCeiling({ get: async (a, b) => ({ a, b }) }, 'opensea', ceilings)
    expect(await client.get('/path', { q: 1 })).toEqual({ a: '/path', b: { q: 1 } })
  })

  it('leaves non-function properties alone', () => {
    const ceilings = createUpstreamCeilings({}, 60_000, clock().now)
    const client = withUpstreamCeiling({ baseUrl: 'https://x', get: async () => ({}) }, 'opensea', ceilings)
    expect(client.baseUrl).toBe('https://x')
  })

  it('is a no-op when no ceilings are supplied, so a module without them is unaffected', async () => {
    const original = { get: async () => 'ok' }
    expect(withUpstreamCeiling(original, 'opensea', null)).toBe(original)
  })
})

describe('upstream ceilings — operator telemetry', () => {
  it('reports calls made per upstream in the current window', async () => {
    const c = clock()
    const ceilings = createUpstreamCeilings({ opensea: 10 }, 60_000, c.now)
    const client = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    await client.get('/a')
    await client.get('/b')
    expect(ceilings.snapshot()).toEqual({ opensea: 2 })
  })

  it('labels only by upstream id — never by anything from a request (FR-036)', async () => {
    const ceilings = createUpstreamCeilings({ opensea: 10 }, 60_000, clock().now)
    const client = withUpstreamCeiling({ get: async () => ({}) }, 'opensea', ceilings)
    await client.get('/v1/opensea/137/account/0xdeadbeef/nfts')
    const keys = Object.keys(ceilings.snapshot())
    expect(keys).toEqual(['opensea'])
    expect(JSON.stringify(keys)).not.toContain('deadbeef')
  })
})
