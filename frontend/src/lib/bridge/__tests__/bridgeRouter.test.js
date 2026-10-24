/**
 * Spec 067 (T069): the BridgeRouter read layer withholds availability rather than
 * inventing it, treats a zero-filled `getRoute` struct as "no such route", keeps
 * Bitcoin's string network ids out of `getContractAddressForChain` entirely, and the
 * call builder passes the QUOTED bps through as `maxFeeBps` (FR-028).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AbiCoder, Interface, ZeroAddress, keccak256 } from 'ethers'
import { BRIDGE_ROUTER_ABI } from '../../../abis/BridgeRouter'

const m = vi.hoisted(() => ({ address: null, methods: {}, calls: [] }))

// Spec 110 Phase 1: the module reads through the chain seam; the driveable method registry
// keeps its exact shape. The ethers Interface imports BELOW stay deliberately — decoding the
// viem-built calldata with ethers is a live cross-library byte-compatibility assertion.
vi.mock('../../chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args = [] }) => {
      m.calls.push([functionName, ...args])
      const f = m.methods[functionName]
      if (!f) throw new Error('unmocked method: ' + functionName)
      return f(...args)
    },
  }
})

const getContractAddressForChain = vi.hoisted(() => vi.fn())
vi.mock('../../../config/contracts', () => ({ getContractAddressForChain }))

import {
  assertEvmChainId,
  isEvmChainId,
  getBridgeRouterAddress,
  computeRouteId,
  normalizeRoute,
  readBridgeRouterConfig,
  readBridgeRoute,
  findRoute,
  buildBridgeCalls,
} from '../bridgeRouter'

const IFACE = new Interface(BRIDGE_ROUTER_ABI)
const APPROVE_IFACE = new Interface(['function approve(address spender, uint256 amount) returns (bool)'])

const ROUTER = '0x1111111111111111111111111111111111111111'
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDC_POLY = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const MEMBER = '0x2222222222222222222222222222222222222222'

/** A raw `getRoute` tuple as ethers would decode it (named fields). */
function rawRoute(over = {}) {
  return {
    inputToken: USDC_ETH,
    enabled: true,
    nativeInput: false,
    expectedFillSeconds: 180n,
    outputToken: USDC_POLY,
    destinationChainId: 137n,
    maxAmount: 5_000_000_000n,
    ...over,
  }
}

const ID_A = '0x' + 'aa'.repeat(32)
const ID_B = '0x' + 'bb'.repeat(32)

const ZERO_FILLED = rawRoute({
  inputToken: ZeroAddress,
  outputToken: ZeroAddress,
  enabled: false,
  nativeInput: false,
  expectedFillSeconds: 0n,
  destinationChainId: 0n,
  maxAmount: 0n,
})

beforeEach(() => {
  m.address = null
  m.methods = {}
  m.calls = []
  getContractAddressForChain.mockReset()
  getContractAddressForChain.mockImplementation(() => m.address)
})

// ---------------------------------------------------------------- chain-id guard (T070)

describe('assertEvmChainId — Bitcoin string ids never reach the EVM plumbing (FR-006)', () => {
  it('rejects Bitcoin network ids by name', () => {
    expect(() => assertEvmChainId('bitcoin')).toThrow(/not an EVM chain/)
    expect(() => assertEvmChainId('bitcoin-testnet')).toThrow(/not an EVM chain/)
  })

  it('rejects numeric STRING chain ids, so there is one representation only', () => {
    expect(() => assertEvmChainId('137')).toThrow(/positive integer EVM chain id/)
  })

  it('rejects nullish, zero, negative and non-integer ids', () => {
    for (const bad of [null, undefined, 0, -1, 1.5, NaN, {}, []]) {
      expect(() => assertEvmChainId(bad)).toThrow()
    }
  })

  it('accepts and returns real EVM chain ids', () => {
    for (const id of [1, 10, 137, 8453, 42161]) expect(assertEvmChainId(id)).toBe(id)
  })

  it('isEvmChainId is the non-throwing form', () => {
    expect(isEvmChainId(137)).toBe(true)
    expect(isEvmChainId('bitcoin')).toBe(false)
    expect(isEvmChainId('137')).toBe(false)
  })
})

describe('every entry point is guarded', () => {
  it('getBridgeRouterAddress throws before calling getContractAddressForChain', () => {
    expect(() => getBridgeRouterAddress('bitcoin')).toThrow()
    expect(getContractAddressForChain).not.toHaveBeenCalled()
  })

  it('readBridgeRouterConfig rejects a Bitcoin id without touching the config', async () => {
    await expect(readBridgeRouterConfig({ chainId: 'bitcoin', provider: {} })).rejects.toThrow()
    expect(getContractAddressForChain).not.toHaveBeenCalled()
  })

  it('readBridgeRoute rejects a Bitcoin id in either position', async () => {
    await expect(
      readBridgeRoute({ chainId: 'bitcoin', provider: {}, inputToken: USDC_ETH, outputToken: USDC_POLY, destinationChainId: 137 }),
    ).rejects.toThrow()
    await expect(
      readBridgeRoute({ chainId: 1, provider: {}, inputToken: USDC_ETH, outputToken: USDC_POLY, destinationChainId: 'bitcoin' }),
    ).rejects.toThrow()
    expect(getContractAddressForChain).not.toHaveBeenCalled()
  })

  it('computeRouteId rejects a Bitcoin id in either position', () => {
    const args = { inputToken: USDC_ETH, outputToken: USDC_POLY, originChainId: 1, destinationChainId: 137 }
    expect(() => computeRouteId({ ...args, originChainId: 'bitcoin' })).toThrow()
    expect(() => computeRouteId({ ...args, destinationChainId: 'bitcoin' })).toThrow()
  })
})

// ---------------------------------------------------------------- address resolution

describe('getBridgeRouterAddress', () => {
  it('returns null when the router is undeployed (empty/absent/malformed)', () => {
    for (const value of ['', undefined, null, '0xnope']) {
      m.address = value
      expect(getBridgeRouterAddress(1)).toBeNull()
    }
  })

  it('returns the address when deployed', () => {
    m.address = ROUTER
    expect(getBridgeRouterAddress(1)).toBe(ROUTER)
    expect(getContractAddressForChain).toHaveBeenCalledWith('bridgeRouter', 1)
  })
})

// ---------------------------------------------------------------- route id

describe('computeRouteId — byte-identical to the contract', () => {
  const encode = (inputToken, outputToken, origin, dest) =>
    keccak256(
      AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint256', 'uint256'], [inputToken, outputToken, origin, dest]),
    )

  it('matches keccak256(abi.encode(inputToken, outputToken, originChainId, destinationChainId))', () => {
    expect(computeRouteId({ inputToken: USDC_ETH, outputToken: USDC_POLY, originChainId: 1, destinationChainId: 137 })).toBe(
      encode(USDC_ETH, USDC_POLY, 1, 137),
    )
  })

  it('outputToken is part of the identity (the silent-substitution guard)', () => {
    const a = computeRouteId({ inputToken: USDC_ETH, outputToken: USDC_POLY, originChainId: 1, destinationChainId: 137 })
    const b = computeRouteId({ inputToken: USDC_ETH, outputToken: WETH, originChainId: 1, destinationChainId: 137 })
    expect(a).not.toBe(b)
  })

  it('the origin chain is part of the identity — ids never port across deployments', () => {
    const a = computeRouteId({ inputToken: USDC_ETH, outputToken: USDC_POLY, originChainId: 1, destinationChainId: 137 })
    const b = computeRouteId({ inputToken: USDC_ETH, outputToken: USDC_POLY, originChainId: 10, destinationChainId: 137 })
    expect(a).not.toBe(b)
  })

  it('the destination chain is part of the identity', () => {
    const a = computeRouteId({ inputToken: USDC_ETH, outputToken: USDC_POLY, originChainId: 1, destinationChainId: 137 })
    const b = computeRouteId({ inputToken: USDC_ETH, outputToken: USDC_POLY, originChainId: 1, destinationChainId: 8453 })
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------- struct normalization

describe('normalizeRoute — a zero-filled struct is not a route', () => {
  it('returns null for the default-initialised struct getRoute() returns for unknown ids', () => {
    expect(normalizeRoute(ID_A, ZERO_FILLED)).toBeNull()
  })

  it('returns null for a missing struct', () => {
    expect(normalizeRoute(ID_A, undefined)).toBeNull()
  })

  it('normalizes bigints to the shapes the UI uses', () => {
    const route = normalizeRoute('0xabc', rawRoute())
    expect(route).toEqual({
      routeId: '0xabc',
      inputToken: USDC_ETH,
      outputToken: USDC_POLY,
      destinationChainId: 137,
      maxAmount: 5_000_000_000n,
      expectedFillSeconds: 180,
      enabled: true,
      nativeInput: false,
    })
  })
})

// ---------------------------------------------------------------- config read

describe('readBridgeRouterConfig — honest null, never an invented availability', () => {
  it('returns null when no router is deployed', async () => {
    m.address = null
    expect(await readBridgeRouterConfig({ chainId: 1, provider: {} })).toBeNull()
  })

  it('returns null when there is no provider', async () => {
    m.address = ROUTER
    expect(await readBridgeRouterConfig({ chainId: 1, provider: null })).toBeNull()
  })

  it('returns null when the load-bearing paused() read fails (unreadable router)', async () => {
    m.address = ROUTER
    m.methods = { paused: () => Promise.reject(new Error('rpc down')) }
    expect(await readBridgeRouterConfig({ chainId: 1, provider: {} })).toBeNull()
  })

  it('normalizes config, pause state and the curated route list when readable', async () => {
    m.address = ROUTER
    const ids = [ID_A, ID_B]
    const raws = {
      [ID_A]: rawRoute(),
      [ID_B]: rawRoute({
        inputToken: WETH,
        outputToken: WETH,
        nativeInput: true,
        destinationChainId: 8453n,
        maxAmount: 0n,
        enabled: false,
      }),
    }
    m.methods = {
      paused: () => Promise.resolve(false),
      spokePool: () => Promise.resolve('0xspoke'),
      feeRouter: () => Promise.resolve('0xfee'),
      sanctionsGuard: () => Promise.resolve(ZeroAddress),
      bridgeTransferServiceId: () => Promise.resolve('0xservice'),
      MAX_FEE_BPS: () => Promise.resolve(250n),
      routeCount: () => Promise.resolve(2n),
      routeAt: (i) => Promise.resolve(ids[Number(i)]),
      getRoute: (id) => Promise.resolve(raws[id]),
    }

    const cfg = await readBridgeRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.routerAddress).toBe(ROUTER)
    expect(cfg.spokePool).toBe('0xspoke')
    expect(cfg.feeRouter).toBe('0xfee')
    expect(cfg.maxFeeBps).toBe(250)
    expect(cfg.paused).toBe(false)
    expect(cfg.routesComplete).toBe(true)
    expect(cfg.routes.map((r) => r.routeId)).toEqual([ID_A, ID_B])
    expect(cfg.routes[1]).toMatchObject({ nativeInput: true, enabled: false, destinationChainId: 8453, maxAmount: 0n })
  })

  it('reports paused honestly rather than hiding it', async () => {
    m.address = ROUTER
    m.methods = {
      paused: () => Promise.resolve(true),
      spokePool: () => Promise.resolve('0xspoke'),
      feeRouter: () => Promise.resolve('0xfee'),
      sanctionsGuard: () => Promise.resolve(ZeroAddress),
      bridgeTransferServiceId: () => Promise.resolve('0xservice'),
      MAX_FEE_BPS: () => Promise.resolve(250n),
      routeCount: () => Promise.resolve(0n),
    }
    const cfg = await readBridgeRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.paused).toBe(true)
    expect(cfg.routes).toEqual([])
  })

  it('one failed getRoute drops that route and marks the list incomplete', async () => {
    m.address = ROUTER
    m.methods = {
      paused: () => Promise.resolve(false),
      spokePool: () => Promise.resolve('0xspoke'),
      feeRouter: () => Promise.resolve('0xfee'),
      sanctionsGuard: () => Promise.resolve(ZeroAddress),
      bridgeTransferServiceId: () => Promise.resolve('0xservice'),
      MAX_FEE_BPS: () => Promise.resolve(250n),
      routeCount: () => Promise.resolve(2n),
      routeAt: (i) => Promise.resolve([ID_A, ID_B][Number(i)]),
      getRoute: (id) => (id === ID_A ? Promise.resolve(rawRoute()) : Promise.reject(new Error('rpc'))),
    }
    const cfg = await readBridgeRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.routes).toHaveLength(1)
    expect(cfg.routesComplete).toBe(false)
  })

  it('a zero-filled enumerated route is skipped without claiming an incomplete read', async () => {
    m.address = ROUTER
    m.methods = {
      paused: () => Promise.resolve(false),
      spokePool: () => Promise.resolve('0xspoke'),
      feeRouter: () => Promise.resolve('0xfee'),
      sanctionsGuard: () => Promise.resolve(ZeroAddress),
      bridgeTransferServiceId: () => Promise.resolve('0xservice'),
      MAX_FEE_BPS: () => Promise.resolve(250n),
      routeCount: () => Promise.resolve(1n),
      routeAt: () => Promise.resolve(ID_A),
      getRoute: () => Promise.resolve(ZERO_FILLED),
    }
    const cfg = await readBridgeRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.routes).toEqual([])
    expect(cfg.routesComplete).toBe(true)
  })

  it('a failed optional getter does not blank the whole overlay', async () => {
    m.address = ROUTER
    m.methods = {
      paused: () => Promise.resolve(false),
      spokePool: () => Promise.resolve('0xspoke'),
      feeRouter: () => Promise.reject(new Error('rpc')),
      sanctionsGuard: () => Promise.resolve(ZeroAddress),
      bridgeTransferServiceId: () => Promise.resolve('0xservice'),
      MAX_FEE_BPS: () => Promise.reject(new Error('rpc')),
      routeCount: () => Promise.resolve(0n),
    }
    const cfg = await readBridgeRouterConfig({ chainId: 1, provider: {} })
    expect(cfg).not.toBeNull()
    expect(cfg.feeRouter).toBeUndefined()
    expect(cfg.maxFeeBps).toBeNull()
  })
})

// ---------------------------------------------------------------- single-route read

describe('readBridgeRoute', () => {
  const args = { chainId: 1, provider: {}, inputToken: USDC_ETH, outputToken: USDC_POLY, destinationChainId: 137 }

  it('returns null when the router is undeployed', async () => {
    m.address = null
    expect(await readBridgeRoute(args)).toBeNull()
  })

  it('looks the route up by the contract-identical id', async () => {
    m.address = ROUTER
    m.methods = { getRoute: () => Promise.resolve(rawRoute()) }
    const route = await readBridgeRoute(args)
    const expectedId = computeRouteId({
      inputToken: USDC_ETH,
      outputToken: USDC_POLY,
      originChainId: 1,
      destinationChainId: 137,
    })
    expect(m.calls).toContainEqual(['getRoute', expectedId])
    expect(route.routeId).toBe(expectedId)
    expect(route.destinationChainId).toBe(137)
  })

  it('returns null for an unknown route (zero-filled struct, no revert)', async () => {
    m.address = ROUTER
    m.methods = { getRoute: () => Promise.resolve(ZERO_FILLED) }
    expect(await readBridgeRoute(args)).toBeNull()
  })

  it('returns null when the read fails — unavailable, not assumed available', async () => {
    m.address = ROUTER
    m.methods = { getRoute: () => Promise.reject(new Error('rpc')) }
    expect(await readBridgeRoute(args)).toBeNull()
  })
})

// ---------------------------------------------------------------- pure matcher

describe('findRoute', () => {
  const routes = [
    normalizeRoute(ID_A, rawRoute()),
    normalizeRoute(ID_B, rawRoute({ outputToken: WETH, destinationChainId: 8453n })),
  ]

  it('matches on the full identity, case-insensitively', () => {
    expect(
      findRoute(routes, { inputToken: USDC_ETH.toLowerCase(), outputToken: USDC_POLY.toUpperCase(), destinationChainId: 137 })
        ?.routeId,
    ).toBe(ID_A)
  })

  it('does not substitute a different delivered asset', () => {
    expect(findRoute(routes, { inputToken: USDC_ETH, outputToken: WETH, destinationChainId: 137 })).toBeNull()
  })

  it('returns null for a missing list or no match', () => {
    expect(findRoute(null, { inputToken: USDC_ETH, outputToken: USDC_POLY, destinationChainId: 137 })).toBeNull()
    expect(findRoute(routes, { inputToken: WETH, outputToken: WETH, destinationChainId: 10 })).toBeNull()
  })
})

// ---------------------------------------------------------------- call builder

describe('buildBridgeCalls', () => {
  const erc20Route = normalizeRoute(ID_A, rawRoute())
  const nativeRoute = normalizeRoute(ID_B, rawRoute({ inputToken: WETH, outputToken: WETH, nativeInput: true, destinationChainId: 8453n }))
  const base = {
    routerAddress: ROUTER,
    inputAmount: 1_000_000n,
    outputAmount: 995_000n,
    recipient: MEMBER,
    quoteTimestamp: 1_700_000_000,
    fillDeadline: 1_700_003_600,
    exclusivityDeadline: 1_700_000_060,
    exclusiveRelayer: '0x3333333333333333333333333333333333333333',
    maxFeeBps: 25,
  }

  it('ERC-20 route: approve then bridgeWithFee, no native value', () => {
    const { calls, requiresApproval } = buildBridgeCalls({ ...base, route: erc20Route })
    expect(requiresApproval).toBe(true)
    expect(calls).toHaveLength(2)

    expect(calls[0].target).toBe(USDC_ETH)
    expect(calls[0].value).toBe(0n)
    const approve = APPROVE_IFACE.decodeFunctionData('approve', calls[0].data)
    expect(approve[0]).toBe(ROUTER)
    expect(approve[1]).toBe(1_000_000n)

    expect(calls[1].target).toBe(ROUTER)
    expect(calls[1].value).toBe(0n)
  })

  it('passes the QUOTED bps through as maxFeeBps, unchanged (FR-028)', () => {
    const { calls } = buildBridgeCalls({ ...base, route: erc20Route, maxFeeBps: 25 })
    const args = IFACE.decodeFunctionData('bridgeWithFee', calls[1].data)
    expect(args).toEqual([
      ID_A,
      1_000_000n,
      995_000n,
      MEMBER,
      1_700_000_000n,
      1_700_003_600n,
      1_700_000_060n,
      base.exclusiveRelayer,
      25n,
    ])
  })

  it('a zero quoted rate is passed as zero — never widened to the cap', () => {
    const { calls } = buildBridgeCalls({ ...base, route: erc20Route, maxFeeBps: 0 })
    expect(IFACE.decodeFunctionData('bridgeWithFee', calls[1].data)[8]).toBe(0n)
  })

  it('native route: single call, no approve leg, value carries the input amount', () => {
    const { calls, requiresApproval } = buildBridgeCalls({ ...base, route: nativeRoute })
    expect(requiresApproval).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].target).toBe(ROUTER)
    expect(calls[0].value).toBe(1_000_000n)
  })

  it('defaults exclusivity to "none" when the quote omits it', () => {
    const { calls } = buildBridgeCalls({
      routerAddress: ROUTER,
      route: nativeRoute,
      inputAmount: 1n,
      outputAmount: 1n,
      recipient: MEMBER,
      quoteTimestamp: 1,
      fillDeadline: 2,
      maxFeeBps: 0,
    })
    const args = IFACE.decodeFunctionData('bridgeWithFee', calls[0].data)
    expect(args[6]).toBe(0n)
    expect(args[7]).toBe(ZeroAddress)
  })

  it('refuses to build calldata that is guaranteed to revert or under-specify consent', () => {
    expect(() => buildBridgeCalls({ ...base, routerAddress: null, route: erc20Route })).toThrow(/routerAddress/)
    expect(() => buildBridgeCalls({ ...base, route: null })).toThrow(/route/)
    expect(() => buildBridgeCalls({ ...base, route: { ...erc20Route, enabled: false } })).toThrow(/disabled/)
    for (const bad of [undefined, null, -1, 10_001, 1.5, '25']) {
      expect(() => buildBridgeCalls({ ...base, route: erc20Route, maxFeeBps: bad })).toThrow(/maxFeeBps/)
    }
  })
})
