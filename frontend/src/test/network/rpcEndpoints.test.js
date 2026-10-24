// Spec 069 — endpoint resolution and the save-time honesty gate.
//
// Resolution is what makes "services use the member's routes" real, so precedence is
// asserted directly rather than through a consumer. `probeRpcEndpoint` is the gate that
// keeps a wrong-chain endpoint out of the store: without it, an endpoint serving another
// network would answer every balance and position read for this one and look plausible.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NETWORKS } from '../../config/networks'
import {
  AUTH_MODES,
  saveEndpointSettings,
  __resetEndpointStoreForTests,
} from '../../lib/network/endpointStore'
import {
  authHeadersFor,
  defaultRpcUrlForChain,
  describeRpcRoute,
  getRpcUrlForChain,
  probeRpcEndpoint,
  resolveRpcEndpoints,
} from '../../lib/network/rpcEndpoints'

const MEMBER_RPC = 'https://polygon-mainnet.g.alchemy.com/v2/member-key'
const MEMBER_FAILOVER = 'https://polygon.drpc.org'

describe('resolveRpcEndpoints', () => {
  beforeEach(() => {
    localStorage.clear()
    __resetEndpointStoreForTests()
  })

  it('falls back to the build default when the member has set nothing', () => {
    const route = resolveRpcEndpoints(137)
    expect(route.source).toBe('default')
    expect(route.primary.url).toBe(NETWORKS[137].rpcUrl)
    // 137 now declares its own build-curated rpcFailoverUrl too (generalized beyond ETC — see
    // test/network/rpcFailover.test.js), so a member on default settings gets it automatically.
    expect(route.failover.url).toBe(NETWORKS[137].rpcFailoverUrl)
    expect(getRpcUrlForChain(137)).toBe(defaultRpcUrlForChain(137))
  })

  it('prefers the member endpoint and keeps the build default as an implicit failover', () => {
    saveEndpointSettings(137, { url: MEMBER_RPC })
    const route = resolveRpcEndpoints(137)
    expect(route.source).toBe('member')
    expect(route.primary.url).toBe(MEMBER_RPC)
    // A custom endpoint going dark must not take the network down with it.
    expect(route.failover.url).toBe(NETWORKS[137].rpcUrl)
  })

  it('uses the member failover when one is set', () => {
    saveEndpointSettings(137, { url: MEMBER_RPC, failoverUrl: MEMBER_FAILOVER })
    expect(resolveRpcEndpoints(137).failover.url).toBe(MEMBER_FAILOVER)
  })

  it('sends the API key to the primary endpoint only', () => {
    saveEndpointSettings(137, {
      url: MEMBER_RPC,
      failoverUrl: MEMBER_FAILOVER,
      authMode: AUTH_MODES.HEADER,
      authHeaderName: 'x-api-key',
      authToken: 'member-token',
    })
    const route = resolveRpcEndpoints(137)
    expect(route.primary.headers).toEqual({ 'x-api-key': 'member-token' })
    expect(route.failover.headers).toEqual({})
  })

  it('builds bearer headers for token-authenticated providers', () => {
    expect(authHeadersFor({ authMode: AUTH_MODES.BEARER, authToken: 'tok' })).toEqual({
      Authorization: 'Bearer tok',
    })
    expect(authHeadersFor({ authMode: AUTH_MODES.HEADER, authToken: 'tok' })).toEqual({})
    expect(authHeadersFor(null)).toEqual({})
  })

  it('keeps unconfigured chains on their own defaults', () => {
    saveEndpointSettings(137, { url: MEMBER_RPC })
    expect(resolveRpcEndpoints(1).source).toBe('default')
    expect(resolveRpcEndpoints(1).primary.url).toBe(NETWORKS[1].rpcUrl)
  })

  it('describes a route without ever revealing the credential', () => {
    saveEndpointSettings(137, {
      url: MEMBER_RPC,
      authMode: AUTH_MODES.BEARER,
      authToken: 'member-token',
    })
    const described = describeRpcRoute(137)
    expect(described).toMatchObject({
      source: 'member',
      primary: 'https://polygon-mainnet.g.alchemy.com/…',
      hasAuth: true,
    })
    expect(JSON.stringify(described)).not.toContain('member-token')
    expect(JSON.stringify(described)).not.toContain('member-key')
  })
})

describe('probeRpcEndpoint', () => {
  const okFetch = (chainIdHex) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ result: chainIdHex }) }))

  it('confirms an endpoint that serves the expected chain', async () => {
    const result = await probeRpcEndpoint(MEMBER_RPC, {
      expectedChainId: 137,
      fetchImpl: okFetch('0x89'),
    })
    expect(result).toMatchObject({ ok: true, chainId: 137, code: 'ok' })
  })

  it('reports a chain mismatch naming both chains', async () => {
    const result = await probeRpcEndpoint(MEMBER_RPC, {
      expectedChainId: 137,
      fetchImpl: okFetch('0x1'),
    })
    expect(result).toMatchObject({ ok: false, code: 'chain-mismatch', chainId: 1 })
    expect(result.message).toContain('chain 1')
    expect(result.message).toContain('chain 137')
  })

  it('reports an HTTP failure without echoing the credential', async () => {
    const result = await probeRpcEndpoint(MEMBER_RPC, {
      expectedChainId: 137,
      fetchImpl: vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
    })
    expect(result).toMatchObject({ ok: false, code: 'bad-response' })
    expect(result.message).toContain('401')
    expect(result.message).not.toContain('member-key')
  })

  it('reports an unreachable endpoint and names the causes a self-hosted node actually hits', async () => {
    const result = await probeRpcEndpoint(MEMBER_RPC, {
      expectedChainId: 137,
      fetchImpl: vi.fn(async () => {
        throw new Error(`fetch failed for ${MEMBER_RPC}`)
      }),
    })
    expect(result).toMatchObject({ ok: false, code: 'unreachable' })
    expect(result.message).toMatch(/reachable from this device/)
    expect(result.message).toMatch(/CORS/)
    // The thrown error carried the full URL; the reported message must not.
    expect(result.message).not.toContain('member-key')
  })

  it('sends the auth headers it was given', async () => {
    const fetchImpl = okFetch('0x89')
    await probeRpcEndpoint(MEMBER_RPC, {
      expectedChainId: 137,
      headers: { 'x-api-key': 'tok' },
      fetchImpl,
    })
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ 'x-api-key': 'tok' })
  })

  it('rejects an unparseable URL before making a request', async () => {
    const fetchImpl = vi.fn()
    const result = await probeRpcEndpoint('not a url', { fetchImpl })
    expect(result.code).toBe('invalid-url')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
