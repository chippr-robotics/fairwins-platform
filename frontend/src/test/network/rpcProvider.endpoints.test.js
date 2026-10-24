// Spec 069 — the provider factory every read in the app goes through.
//
// The claim being tested is the one that matters to a member: configure an endpoint in
// Network settings and the app's lookups actually take it, with the API key on the request
// and the failover behind it. ethers is mocked locally (the global setup mock ignores
// constructor arguments, which is exactly what these assertions need to see).

import { describe, it, expect, beforeEach, vi } from 'vitest'

const constructed = []

vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers')
  class MockFetchRequest {
    constructor(url) {
      this.url = url
      this.headers = {}
    }
    setHeader(name, value) {
      this.headers[name] = value
    }
  }
  class MockJsonRpcProvider {
    constructor(target, network, options) {
      this.target = target
      this.network = network
      this.options = options
      constructed.push({ kind: 'json-rpc', target, network, options })
    }
  }
  class MockFallbackProvider {
    constructor(configs, network, options) {
      this.configs = configs
      this.network = network
      this.options = options
      constructed.push({ kind: 'fallback', configs, network, options })
    }
  }
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      FetchRequest: MockFetchRequest,
      JsonRpcProvider: MockJsonRpcProvider,
      FallbackProvider: MockFallbackProvider,
      Network: actual.ethers.Network,
    },
  }
})

const { AUTH_MODES, saveEndpointSettings, __resetEndpointStoreForTests } = await import(
  '../../lib/network/endpointStore'
)
const { makeReadProvider, getReadProvider, chainNeedsUnbatchedRpc } = await import(
  '../../utils/rpcProvider'
)
const { NETWORKS } = await import('../../config/networks')

const MEMBER_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/member-key'
const MEMBER_FAILOVER = 'https://polygon.drpc.org'

describe('makeReadProvider — member endpoints', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetEndpointStoreForTests()
    constructed.length = 0
  })

  it('uses the caller-supplied default when the member has configured nothing', () => {
    // 137 now declares a build-curated rpcFailoverUrl (generalized beyond ETC), so this legitimately
    // builds a fallback pair rather than a single provider — Amoy is the chain still on one leg.
    makeReadProvider(NETWORKS[80002].rpcUrl, 80002)
    expect(constructed).toHaveLength(1)
    expect(constructed[0]).toMatchObject({ kind: 'json-rpc', target: NETWORKS[80002].rpcUrl })
  })

  it('overrides the caller-supplied URL with the member endpoint', () => {
    saveEndpointSettings(137, { url: MEMBER_RPC, failoverUrl: MEMBER_FAILOVER })
    makeReadProvider(NETWORKS[137].rpcUrl, 137)

    const fallbackCall = constructed.find((c) => c.kind === 'fallback')
    expect(fallbackCall).toBeTruthy()
    // Quorum 1: the failover answers as soon as the primary stalls or errors.
    expect(fallbackCall.options).toMatchObject({ quorum: 1 })
    expect(fallbackCall.configs.map((c) => c.provider.target)).toEqual([
      MEMBER_RPC,
      MEMBER_FAILOVER,
    ])
    expect(fallbackCall.configs[0].priority).toBeLessThan(fallbackCall.configs[1].priority)
  })

  it('puts the API key in a request header, never in the URL', () => {
    saveEndpointSettings(137, {
      url: MEMBER_RPC,
      authMode: AUTH_MODES.HEADER,
      authHeaderName: 'x-api-key',
      authToken: 'member-token',
    })
    makeReadProvider(NETWORKS[137].rpcUrl, 137)

    const primary = constructed.find((c) => c.kind === 'json-rpc' && c.target?.headers)
    expect(primary.target.headers).toEqual({ 'x-api-key': 'member-token' })
    expect(primary.target.url).toBe(MEMBER_RPC)
  })

  it('keeps the unbatched-RPC workaround on ETC-family chains with a member endpoint', () => {
    saveEndpointSettings(63, { url: 'https://mordor.rpc.example.rivet.link/x' })
    makeReadProvider(NETWORKS[63].rpcUrl, 63)
    expect(chainNeedsUnbatchedRpc(63)).toBe(true)
    expect(constructed.some((c) => c.options?.batchMaxCount === 1)).toBe(true)
  })

  it('getReadProvider resolves the endpoint itself', () => {
    saveEndpointSettings(137, { url: MEMBER_RPC })
    expect(getReadProvider(137)).toBeTruthy()
    expect(constructed.some((c) => c.kind === 'fallback')).toBe(true)
    // A chain with no endpoint at all yields null rather than a broken provider.
    expect(getReadProvider(999999)).toBeNull()
  })
})

describe('makeReadProvider — build-curated failover', () => {
  // A member who has configured nothing still needs redundancy on chains served by a single
  // community-run RPC. Ethereum Classic's default going dark is what motivated build-declared
  // failovers in the first place; they are now declared on every covered EVM mainnet.
  beforeEach(() => {
    localStorage.clear()
    __resetEndpointStoreForTests()
    constructed.length = 0
  })

  // ETC is the exception, and it inverted: the chain USED to declare a pair here
  // (`etc.rivet.link` primary, etcdesktop failover). rivet then stopped resolving entirely,
  // etcdesktop was promoted to primary, and no browser-usable second endpoint could be
  // verified to sit behind it (see `rpcFailover.test.js` for what was checked and rejected).
  //
  // So ETC now takes the SINGLE-provider path, and the consequence is deliberate rather than a
  // loss: `buildProvider` sets `staticNetwork` only for a failover SET, because every member of
  // a FallbackProvider has to agree on the network up front. A lone provider instead keeps
  // ethers' own network detection on purpose, so an endpoint that answers for the wrong chain
  // fails loudly instead of quietly serving another network's state into every ETC read. On a
  // chain down to one community-run RPC that verification is worth more than the saved probe.
  it('builds a single detecting provider on ETC, which declares no build failover', () => {
    expect(NETWORKS[61].rpcFailoverUrl).toBeNull()
    makeReadProvider(NETWORKS[61].rpcUrl, 61)

    expect(constructed.some((c) => c.kind === 'fallback')).toBe(false)
    const direct = constructed.filter((c) => c.kind !== 'fallback')
    expect(direct.map((c) => c.target)).toEqual([NETWORKS[61].rpcUrl])
    // Detection deliberately left on (see above), and ETC keeps its no-batch workaround.
    expect(direct.every((c) => c.options?.staticNetwork)).toBe(false)
    expect(direct.every((c) => c.options?.batchMaxCount === 1)).toBe(true)
  })

  it('leaves chains without a declared failover on a single provider', () => {
    // 137 now declares a build failover too (this task, generalizing beyond ETC) — Amoy is the
    // one still genuinely undeclared, so it is the honest fixture for "no failover at all".
    expect(NETWORKS[80002].rpcFailoverUrl).toBeFalsy()
    makeReadProvider(NETWORKS[80002].rpcUrl, 80002)
    expect(constructed.some((c) => c.kind === 'fallback')).toBe(false)
  })

  it('also falls back to the chain-declared endpoint on Polygon with no member settings', () => {
    // Generalized (this task) beyond ETC: every EVM mainnet the app supports now declares a
    // distinct public rpcFailoverUrl, so a deploy-time-keyed VITE_RPC_URL_POLYGON going dark
    // degrades to this route rather than leaving the chain unreadable.
    makeReadProvider(NETWORKS[137].rpcUrl, 137)

    const fallbackCall = constructed.find((c) => c.kind === 'fallback')
    expect(fallbackCall).toBeTruthy()
    expect(fallbackCall.configs.map((c) => c.provider.target)).toEqual([
      NETWORKS[137].rpcUrl,
      NETWORKS[137].rpcFailoverUrl,
    ])
  })

  it('still prefers the member endpoint, keeping the build default behind it', () => {
    saveEndpointSettings(61, { url: 'https://etc.member.example/rpc' })
    makeReadProvider(NETWORKS[61].rpcUrl, 61)

    const fallbackCall = constructed.find((c) => c.kind === 'fallback')
    expect(fallbackCall.configs.map((c) => c.provider.target)).toEqual([
      'https://etc.member.example/rpc',
      NETWORKS[61].rpcUrl,
    ])
  })
})
