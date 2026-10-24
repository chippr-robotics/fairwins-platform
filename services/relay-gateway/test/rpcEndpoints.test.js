/**
 * RPC endpoint resolution and the boot-time wrong-chain guard.
 *
 * Both exist because of ONE credential shape. A QuickNode Multi-Chain endpoint selects the chain
 * from a hostname infix on a single shared token — `<name>.matic.quiknode.pro` is Polygon and
 * `<name>.matic-amoy.quiknode.pro` is Amoy — so pointing a chain at the wrong one returns HTTP 200
 * with valid data from the wrong chain rather than a 401. Nothing downstream would notice: the
 * providers are built with `staticNetwork`, which tells ethers to trust the configured id.
 *
 * These tests use redacted, obviously-fake hosts. A real endpoint URL is a credential.
 */
import { describe, it, expect, vi } from 'vitest'
import { testConfig } from './helpers.js'
import { assertChainEndpoints, redactRpcUrl } from '../src/config/providers.js'

const PUBLIC_A = 'https://public-a.example.invalid'
const PUBLIC_B = 'https://public-b.example.invalid'
const KEYED = 'https://keyed.matic.quiknode.pro/token-shaped-path'

/** A fetch that answers eth_chainId per host, from a { url -> chainId | 'error' } map. */
function chainIdFetch(byUrl) {
  return vi.fn(async (url) => {
    const answer = byUrl[url]
    if (answer === undefined || answer === 'error') throw new Error(`upstream refused ${url}`)
    if (answer === 'http500') return { ok: false, status: 500, json: async () => ({}) }
    return {
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: `0x${Number(answer).toString(16)}` }),
    }
  })
}

describe('RPC_URL_PRIMARY_<chainId>', () => {
  it('prepends the credentialed primary so the public list stays behind it as failover', () => {
    const config = testConfig({
      ENABLED_CHAIN_IDS: '137',
      RPC_URLS_137: `${PUBLIC_A},${PUBLIC_B}`,
      RPC_URL_PRIMARY_137: KEYED,
    })
    // Prepended, not substituted — FR-007 wants >= 2 independent endpoints, and a keyed endpoint
    // that rate-limits must degrade to a slower route rather than take the chain down.
    expect(config.chains[137].rpcUrls).toEqual([KEYED, PUBLIC_A, PUBLIC_B])
  })

  it('leaves the list exactly as written when no primary is delivered', () => {
    // fetch-secrets.sh emits this one OPTIONAL: an unavailable credential must cost latency and
    // archive depth, never availability.
    const config = testConfig({ ENABLED_CHAIN_IDS: '137', RPC_URLS_137: `${PUBLIC_A},${PUBLIC_B}` })
    expect(config.chains[137].rpcUrls).toEqual([PUBLIC_A, PUBLIC_B])
  })

  it('does not list the same endpoint twice', () => {
    // One URL repeated is one endpoint, not two. Left duplicated it would be retried against
    // itself on failover and would make the "only 1 endpoint" warning below fail to fire.
    const config = testConfig({
      ENABLED_CHAIN_IDS: '137',
      RPC_URLS_137: `${PUBLIC_A},${KEYED}`,
      RPC_URL_PRIMARY_137: KEYED,
    })
    expect(config.chains[137].rpcUrls).toEqual([KEYED, PUBLIC_A])
  })

  it('is per chain — a primary for one chain never leaks into another', () => {
    const config = testConfig({
      ENABLED_CHAIN_IDS: '137,63',
      RPC_URLS_137: PUBLIC_A,
      RPC_URLS_63: PUBLIC_B,
      RPC_URL_PRIMARY_137: KEYED,
    })
    expect(config.chains[137].rpcUrls).toEqual([KEYED, PUBLIC_A])
    expect(config.chains[63].rpcUrls).toEqual([PUBLIC_B])
  })

  it('is genuinely generic — the seam is chainId-keyed, not hardcoded to 137 (release 1.14.0 task 8)', () => {
    // config/index.js reads `RPC_URL_PRIMARY_${chainId}` inside a loop over enabledChainIds, so
    // every enabled chain already gets this for free — Amoy here, not Polygon, to prove it.
    const AMOY_KEYED = 'https://keyed.matic-amoy.quiknode.pro/token-shaped-path'
    const config = testConfig({
      ENABLED_CHAIN_IDS: '80002',
      RPC_URLS_80002: `${PUBLIC_A},${PUBLIC_B}`,
      RPC_URL_PRIMARY_80002: AMOY_KEYED,
    })
    expect(config.chains[80002].rpcUrls).toEqual([AMOY_KEYED, PUBLIC_A, PUBLIC_B])
  })
})

describe('CHAIN_DEFS default RPC lists (release 1.14.0 task 8)', () => {
  // Every enabled chain's default list already carries >= 2 independent public endpoints
  // (FR-007) BEFORE any RPC_URL_PRIMARY_<chainId> is set, so a fresh deploy with no QuickNode
  // credential provisioned yet still has real failover rather than a single point of failure.
  it('every chain currently wired into the gateway ships >= 2 default public endpoints', () => {
    const config = testConfig({ ENABLED_CHAIN_IDS: '137,80002,63' })
    for (const chainId of [137, 80002, 63]) {
      expect(config.chains[chainId].rpcUrls.length, `chain ${chainId}`).toBeGreaterThanOrEqual(2)
    }
  })

  it("Polygon's default pair is publicnode primary, drpc.org secondary — matches the frontend's pair", () => {
    // frontend/src/config/networks.js NETWORKS[137]: rpcUrl defaults to the same publicnode host,
    // rpcFailoverUrl to the same drpc.org host. Keeping the two planes' defaults aligned is what
    // makes "QuickNode primary, publicnode failover" one consistent story across the app.
    const config = testConfig({ ENABLED_CHAIN_IDS: '137' })
    expect(config.chains[137].rpcUrls).toEqual([
      'https://polygon-bor-rpc.publicnode.com',
      'https://polygon.drpc.org',
    ])
  })
})

describe('redactRpcUrl', () => {
  it('keeps the host and drops the path, because the credential is in the path', () => {
    expect(redactRpcUrl(KEYED)).toBe('https://keyed.matic.quiknode.pro/<redacted>')
  })

  it('leaves a bare host alone rather than implying a hidden credential', () => {
    expect(redactRpcUrl(PUBLIC_A)).toBe('https://public-a.example.invalid')
  })

  it('never throws on junk', () => {
    expect(redactRpcUrl('not a url')).toBe('(unparseable endpoint)')
  })
})

describe('assertChainEndpoints', () => {
  const silent = { warn: () => {}, error: () => {} }

  it('passes when every endpoint answers with the configured chain', async () => {
    const config = testConfig({ ENABLED_CHAIN_IDS: '137', RPC_URLS_137: `${PUBLIC_A},${PUBLIC_B}` })
    const result = await assertChainEndpoints(config, {
      fetchImpl: chainIdFetch({ [PUBLIC_A]: 137, [PUBLIC_B]: 137 }),
      log: silent,
    })
    expect(result).toMatchObject({ ok: true, mismatches: [], unreachable: [] })
  })

  it('FAILS on an endpoint serving another chain — the whole point', async () => {
    // 80002 is Amoy: the exact mistake the shared-token endpoint invites, four characters apart
    // from Polygon in the hostname.
    const config = testConfig({ ENABLED_CHAIN_IDS: '137', RPC_URLS_137: PUBLIC_A })
    const result = await assertChainEndpoints(config, {
      fetchImpl: chainIdFetch({ [PUBLIC_A]: 80002 }),
      log: silent,
    })
    expect(result.ok).toBe(false)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toMatchObject({ chainId: 137, detail: 'serves chain 80002' })
  })

  it('checks EVERY endpoint, not just the first', async () => {
    // A wrong second entry is invisible until the primary fails — the worst moment to find out.
    const config = testConfig({ ENABLED_CHAIN_IDS: '137', RPC_URLS_137: `${PUBLIC_A},${PUBLIC_B}` })
    const result = await assertChainEndpoints(config, {
      fetchImpl: chainIdFetch({ [PUBLIC_A]: 137, [PUBLIC_B]: 80002 }),
      log: silent,
    })
    expect(result.ok).toBe(false)
    expect(result.mismatches.map((m) => m.endpoint)).toEqual(['https://public-b.example.invalid'])
  })

  it('treats unreachable as unreachable, NEVER as a mismatch', async () => {
    // An RPC being down is the ordinary case the failover list exists for. Refusing to boot over
    // it would take the gasless path down for a condition that resolves itself.
    const config = testConfig({ ENABLED_CHAIN_IDS: '137', RPC_URLS_137: `${PUBLIC_A},${PUBLIC_B}` })
    const result = await assertChainEndpoints(config, {
      fetchImpl: chainIdFetch({ [PUBLIC_A]: 'error', [PUBLIC_B]: 'http500' }),
      log: silent,
    })
    expect(result.ok).toBe(true)
    expect(result.mismatches).toEqual([])
    expect(result.unreachable).toHaveLength(2)
  })

  it('a mismatch beside an unreachable endpoint still fails', async () => {
    const config = testConfig({ ENABLED_CHAIN_IDS: '137', RPC_URLS_137: `${PUBLIC_A},${PUBLIC_B}` })
    const result = await assertChainEndpoints(config, {
      fetchImpl: chainIdFetch({ [PUBLIC_A]: 'error', [PUBLIC_B]: 1 }),
      log: silent,
    })
    expect(result.ok).toBe(false)
  })

  it('never puts an unredacted endpoint in a result or a log line', async () => {
    const config = testConfig({ ENABLED_CHAIN_IDS: '137', RPC_URLS_137: KEYED })
    const lines = []
    const result = await assertChainEndpoints(config, {
      fetchImpl: chainIdFetch({ [KEYED]: 80002 }),
      log: { warn: (m) => lines.push(m), error: (m) => lines.push(m) },
    })
    const everything = JSON.stringify(result) + lines.join('\n')
    expect(everything).not.toContain('token-shaped-path')
    expect(everything).toContain('https://keyed.matic.quiknode.pro/<redacted>')
  })

  it('spans every enabled chain', async () => {
    const config = testConfig({
      ENABLED_CHAIN_IDS: '137,63',
      RPC_URLS_137: PUBLIC_A,
      RPC_URLS_63: PUBLIC_B,
    })
    const result = await assertChainEndpoints(config, {
      fetchImpl: chainIdFetch({ [PUBLIC_A]: 137, [PUBLIC_B]: 137 }), // 63's endpoint serves Polygon
      log: silent,
    })
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toMatchObject({ chainId: 63, detail: 'serves chain 137' })
  })
})
