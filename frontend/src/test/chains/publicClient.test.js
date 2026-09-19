// Spec 110 Phase 1 (#1592) — the viem read seam must resolve endpoints exactly as the
// ethers seam it replaces (spec 069 precedence, header rules, failover shape), pinned here
// against the REAL endpoint store and REAL viem transports (no network I/O — construction
// only). The twin ethers suite is src/test/network/rpcProvider.endpoints.test.js; these run
// side by side until the last read caller leaves utils/rpcProvider.js.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPublicClient, custom, encodeAbiParameters, parseAbi } from 'viem'

// The global setup mocks the client factory with the canned test world (its ethers-Contract
// parity); THIS suite is the one place that must see the real thing.
vi.unmock('../../lib/chains/publicClient')

const { AUTH_MODES, saveEndpointSettings, __resetEndpointStoreForTests } = await import(
  '../../lib/network/endpointStore'
)
const { getPublicClient, __resetPublicClientCache, chainUsesUnbatchedRpc } = await import(
  '../../lib/chains/publicClient'
)
const { readContract, NoRpcEndpointError, normalizeAbi } = await import(
  '../../lib/chains/readContract'
)
const { NETWORKS } = await import('../../config/networks')
const publicClientModule = await import('../../lib/chains/publicClient')

const MEMBER_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/member-key'
const MEMBER_FAILOVER = 'https://polygon.drpc.org'

describe('getPublicClient — spec-069 route resolution on the viem seam', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetEndpointStoreForTests()
    __resetPublicClientCache()
  })

  it('uses the build default when the member has configured nothing', () => {
    const client = getPublicClient(137)
    expect(client).not.toBeNull()
    const urls =
      client.transport.key === 'fallback'
        ? client.transport.transports.map((t) => t.value.url)
        : [client.transport.url]
    expect(urls[0]).toBe(NETWORKS[137].rpcUrl)
  })

  it('a member endpoint replaces the default as the primary', () => {
    saveEndpointSettings(137, { url: MEMBER_RPC, authMode: AUTH_MODES.NONE })
    const client = getPublicClient(137)
    const primaryUrl =
      client.transport.key === 'fallback'
        ? client.transport.transports[0].value.url
        : client.transport.url
    expect(primaryUrl).toBe(MEMBER_RPC)
  })

  it('a member failover produces an ordered, un-ranked fallback transport (quorum-1 shape)', () => {
    saveEndpointSettings(137, {
      url: MEMBER_RPC,
      failoverUrl: MEMBER_FAILOVER,
      authMode: AUTH_MODES.NONE,
    })
    const client = getPublicClient(137)
    expect(client.transport.key).toBe('fallback')
    expect(client.transport.transports.map((t) => t.value.url)).toEqual([
      MEMBER_RPC,
      MEMBER_FAILOVER,
    ])
  })

  it('a member API key rides as a fetch HEADER on the primary only — never in a URL', () => {
    saveEndpointSettings(137, {
      url: MEMBER_RPC,
      failoverUrl: MEMBER_FAILOVER,
      authMode: AUTH_MODES.HEADER,
      authHeaderName: 'x-api-key',
      authToken: 'secret-key',
    })
    const client = getPublicClient(137)
    const [primary, failover] = client.transport.transports
    expect(primary.value.fetchOptions?.headers?.['x-api-key']).toBe('secret-key')
    expect(primary.value.url).not.toContain('secret-key')
    expect(failover.value.fetchOptions?.headers?.['x-api-key']).toBeUndefined()
  })

  it('client identity is STABLE across calls and rebuilds only when the route changes', () => {
    const first = getPublicClient(137)
    expect(getPublicClient(137)).toBe(first)
    saveEndpointSettings(137, { url: MEMBER_RPC, authMode: AUTH_MODES.NONE })
    const rebuilt = getPublicClient(137)
    expect(rebuilt).not.toBe(first)
    expect(getPublicClient(137)).toBe(rebuilt)
  })

  it('ETC/Mordor stay unbatched; other chains batch (the ethers request-volume parity)', () => {
    expect(chainUsesUnbatchedRpc(61)).toBe(true)
    expect(chainUsesUnbatchedRpc(63)).toBe(true)
    expect(chainUsesUnbatchedRpc(137)).toBe(false)
  })

  it('returns null for a chain with no endpoint at all', () => {
    expect(getPublicClient(424242)).toBeNull()
  })
})

describe('readContract — the seam contract', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetEndpointStoreForTests()
    __resetPublicClientCache()
  })

  it('throws NoRpcEndpointError for a chain with no route — never a defaulted value', async () => {
    await expect(
      readContract(424242, {
        address: '0x0000000000000000000000000000000000000001',
        abi: ['function decimals() view returns (uint8)'],
        functionName: 'decimals',
      }),
    ).rejects.toBeInstanceOf(NoRpcEndpointError)
  })

  it('accepts human-readable signature ABIs (parsed once per array identity)', () => {
    const abi = ['function balanceOf(address) view returns (uint256)']
    const parsed = normalizeAbi(abi)
    expect(parsed[0]).toMatchObject({ type: 'function', name: 'balanceOf' })
    expect(normalizeAbi(abi)).toBe(parsed)
  })

  it("parses ethers-v6 'tuple(...)' struct spellings (the repo's ABI files)", () => {
    const abi = ['function getRoute(bytes32 id) view returns (tuple(address inputToken, bool enabled) route)']
    const parsed = normalizeAbi(abi)
    expect(parsed[0].outputs[0].components.map((c) => c.name)).toEqual(['inputToken', 'enabled'])
  })

  it('passes JSON ABIs through untouched', () => {
    const abi = [{ type: 'function', name: 'decimals', inputs: [], outputs: [], stateMutability: 'view' }]
    expect(normalizeAbi(abi)).toBe(abi)
  })
})

/*
 * A function with SEVERAL named outputs is the one place viem is not a drop-in for ethers, and it
 * is silent: ethers handed back a Result addressable as both `r[2]` and `r.token0`; viem returns a
 * bare array, so `r.token0` is `undefined` — not an error, not a failed read, just a field that
 * quietly is not there. A caller that reads it by name concludes the record is unreadable and
 * renders an empty list, which a member reads as "you have none".
 *
 * This is driven through a REAL viem client over a fake transport, encoding and decoding real ABI
 * bytes, because that is the part a mock cannot stand in for: every unit fake in this migration
 * returns ethers-shaped objects, and so answers a question the chain no longer answers.
 */
describe('readContract — multi-output results keep their names (the ethers Result shape)', () => {
  const NFPM = [
    'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    'function balanceOf(address owner) view returns (uint256)',
    'function pooled(address t) view returns (address lpToken, bool isEnabled)',
  ]
  const TOKEN0 = '0x2222222222222222222222222222222222222222'
  const TOKEN1 = '0x3333333333333333333333333333333333333333'

  /** A client whose eth_call answers with real encoded bytes for `positions`. */
  function installChain(encodedFor) {
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }) {
          if (method !== 'eth_call') throw new Error(`unexpected ${method}`)
          return encodedFor(params[0].data)
        },
      }),
    })
    vi.spyOn(publicClientModule, 'getPublicClient').mockReturnValue(client)
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('addresses a 12-output result by NAME as well as by index', async () => {
    const parsed = parseAbi(NFPM)
    const outputs = parsed.find((f) => f.name === 'positions').outputs
    const encoded = encodeAbiParameters(outputs, [
      1n, '0x1111111111111111111111111111111111111111', TOKEN0, TOKEN1,
      3000, -100, 100, 500n, 0n, 0n, 7n, 9n,
    ])
    installChain(() => encoded)

    const raw = await readContract(137, {
      address: '0x00000000000000000000000000000000000000a1',
      abi: NFPM,
      functionName: 'positions',
      args: [1n],
    })

    // The read that broke: by name.
    expect(raw.token0).toBe(TOKEN0)
    expect(raw.token1).toBe(TOKEN1)
    expect(raw.fee).toBe(3000)
    expect(raw.liquidity).toBe(500n)
    expect(raw.tokensOwed0).toBe(7n)
    // …and it is still the array viem returned, unchanged in every other respect.
    expect(Array.isArray(raw)).toBe(true)
    expect(raw[2]).toBe(TOKEN0)
    expect(raw).toHaveLength(12)
  })

  it('leaves a SINGLE output alone — a lone tuple already carries its own names', async () => {
    const parsed = parseAbi(NFPM)
    const encoded = encodeAbiParameters(parsed.find((f) => f.name === 'balanceOf').outputs, [4n])
    installChain(() => encoded)
    const raw = await readContract(137, {
      address: '0x00000000000000000000000000000000000000a1',
      abi: NFPM,
      functionName: 'balanceOf',
      args: ['0x1111111111111111111111111111111111111111'],
    })
    expect(raw).toBe(4n)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DIVERGENCE 24 — one attempt at a dead endpoint, ethers' throttle backoff at a 429.
//
// viem's http() retries 403/408/413/429/500/502/503/504 and any status-less error three times;
// ethers retried ONE status, 429. That difference is not latency trivia here: the sweeps that
// produce `unreadable` readings are sequential, so four attempts per failed read turned a total
// outage into minutes of "checking…" on the screen whose whole job is to say it could not ask
// (admin-console AD-03, which is what caught it).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('throttledFetch — ethers’ retry rule, not viem’s', () => {
  const originalFetch = globalThis.fetch
  beforeEach(() => {
    localStorage.clear()
    __resetEndpointStoreForTests()
    __resetPublicClientCache()
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.useRealTimers()
  })

  const reply = (status, headers = {}) => ({
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  })

  it('attempts a 503 EXACTLY once — the case that was costing four', async () => {
    const calls = []
    globalThis.fetch = vi.fn(async (url) => {
      calls.push(url)
      return reply(503)
    })
    const res = await publicClientModule.throttledFetch('https://rpc.example/x', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(1)
  })

  it('a network failure is not swallowed into a retry loop either', async () => {
    let attempts = 0
    globalThis.fetch = vi.fn(async () => {
      attempts += 1
      throw new Error('connection refused')
    })
    await expect(
      publicClientModule.throttledFetch('https://rpc.example/x', {}),
    ).rejects.toThrow(/connection refused/)
    expect(attempts).toBe(1)
  })

  it('a 429 DOES back off and retry — the one case ethers retried', async () => {
    let attempts = 0
    globalThis.fetch = vi.fn(async () => {
      attempts += 1
      return attempts < 3 ? reply(429) : reply(200)
    })
    const res = await publicClientModule.throttledFetch('https://rpc.example/x', {})
    expect(res.status).toBe(200)
    expect(attempts).toBe(3)
  })

  it('honours `retry-after` as SECONDS — ethers read it as milliseconds, which is its bug', async () => {
    vi.useFakeTimers()
    let attempts = 0
    globalThis.fetch = vi.fn(async () => {
      attempts += 1
      return attempts === 1 ? reply(429, { 'retry-after': '2' }) : reply(200)
    })
    const pending = publicClientModule.throttledFetch('https://rpc.example/x', {})
    await vi.advanceTimersByTimeAsync(1999)
    expect(attempts).toBe(1) // still waiting: 2 SECONDS, not 2 milliseconds
    await vi.advanceTimersByTimeAsync(2)
    await expect(pending).resolves.toMatchObject({ status: 200 })
    expect(attempts).toBe(2)
  })

  it('a dead endpoint costs ONE request through the REAL transport, not four', async () => {
    // The end-to-end wiring, not a config assertion: viem exposes no `fetchFn` on the transport
    // object, and its `fallback` already zeroes its LEGS' retryCount — so anything short of
    // counting actual requests would be checking viem's behaviour rather than ours.
    // Mordor, because it curates no build-time failover: one transport, one leg.
    globalThis.fetch = vi.fn(async () => new Response('upstream unavailable', { status: 503 }))
    await expect(
      readContract(63, {
        address: '0x0000000000000000000000000000000000000001',
        abi: parseAbi(['function hasRole(bytes32,address) view returns (bool)']),
        functionName: 'hasRole',
        args: ['0x' + '00'.repeat(32), '0x0000000000000000000000000000000000000002'],
      }),
    ).rejects.toThrow()
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('and a failover chain tries each leg once — the whole sequence is not retried either', async () => {
    // Polygon curates a build-time failover, so this is the `fallback` shape every member on
    // default settings gets. Two requests: primary, then failover. Not eight.
    globalThis.fetch = vi.fn(async () => new Response('upstream unavailable', { status: 503 }))
    const client = getPublicClient(137)
    expect(client.transport.key).toBe('fallback')
    await expect(
      readContract(137, {
        address: '0x0000000000000000000000000000000000000001',
        abi: parseAbi(['function hasRole(bytes32,address) view returns (bool)']),
        functionName: 'hasRole',
        args: ['0x' + '00'.repeat(32), '0x0000000000000000000000000000000000000002'],
      }),
    ).rejects.toThrow()
    expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })
})
