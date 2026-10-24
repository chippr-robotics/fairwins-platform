/**
 * Spec 067 (T088/T091): the LiquidityRouter read layer withholds availability rather than
 * inventing it, keeps a RETIRED pool visible (FR-024), treats an `Unlisted` struct as "no
 * such pool", refuses to build calldata for the bridge-liquidity path (research R3), honours
 * BOTH per-transaction ceilings independently, and passes the QUOTED bps through as
 * `maxFeeBps` (FR-028).
 *
 * It also pins the PAIR rule — `samePair`, the exact inverse of the Bridge surface's
 * `bridgeDest`. Swapping the two has no loud failure, so the inversion is asserted here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AbiCoder, Interface, ZeroAddress, keccak256 } from 'ethers'
import { LIQUIDITY_ROUTER_ABI } from '../../../abis/LiquidityRouter'
import { PIN_MODE } from '../../assets/networkPin'

const m = vi.hoisted(() => ({ address: null, methods: {}, calls: [] }))

// Spec 110 Phase 1: the module reads through the chain seam; the driveable method registry
// keeps its exact shape. ethers Interface imports elsewhere in this file stay deliberately —
// decoding viem-built calldata with ethers is a live cross-library byte-compatibility check.
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
  POOL_KIND,
  getLiquidityRouterAddress,
  computePoolId,
  normalizePool,
  readLiquidityRouterConfig,
  readLiquidityPool,
  findPool,
  chargesPlatformFee,
  maxSupplyFee,
  poolLimitViolation,
  buildSupplyCalls,
  createLiquidityPin,
  filterPairCounterparts,
  revalidatePairCounterpart,
} from '../liquidityRouter'

const IFACE = new Interface(LIQUIDITY_ROUTER_ABI)
const APPROVE_IFACE = new Interface(['function approve(address spender, uint256 amount) returns (bool)'])

const ROUTER = '0x1111111111111111111111111111111111111111'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const POOL = '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8'
const HUB_POOL = '0xc186fA914353c44b2E33eBE05f21846F1048bEda'
const DEADLINE = 1_800_000_000

/** A raw `getPool` tuple as ethers would decode it (named fields). */
function rawPool(over = {}) {
  return {
    kind: 2n,
    enabled: true,
    feeTier: 3000n,
    token0: USDC,
    token1: WETH,
    poolAddress: POOL,
    maxDeposit0PerTx: 25_000_000_000n, // 25,000 USDC (6dp)
    maxDeposit1PerTx: 10_000_000_000_000_000_000n, // 10 WETH (18dp)
    ...over,
  }
}

const rawBridgePool = (over = {}) =>
  rawPool({ kind: 1n, feeTier: 0n, token0: USDC, token1: ZeroAddress, poolAddress: HUB_POOL, ...over })

/** The zero-filled struct `getPool` returns for an unknown id — never a real pool. */
const UNLISTED = rawPool({
  kind: 0n,
  enabled: false,
  feeTier: 0n,
  token0: ZeroAddress,
  token1: ZeroAddress,
  poolAddress: ZeroAddress,
  maxDeposit0PerTx: 0n,
  maxDeposit1PerTx: 0n,
})

const ID_A = '0x' + 'aa'.repeat(32)
const ID_B = '0x' + 'bb'.repeat(32)

const READABLE = {
  paused: () => Promise.resolve(false),
  feeRouter: () => Promise.resolve('0xfee'),
  positionManager: () => Promise.resolve('0xnfpm'),
  sanctionsGuard: () => Promise.resolve(ZeroAddress),
  liquidityDepositServiceId: () => Promise.resolve('0xservice'),
  MAX_FEE_BPS: () => Promise.resolve(250n),
}

beforeEach(() => {
  m.address = null
  m.methods = {}
  m.calls = []
  getContractAddressForChain.mockReset()
  getContractAddressForChain.mockImplementation(() => m.address)
})

// ---------------------------------------------------------------- chain-id guard

describe('the shared EVM chain-id guard applies here too (FR-006)', () => {
  it('getLiquidityRouterAddress throws before touching the contract config', () => {
    expect(() => getLiquidityRouterAddress('bitcoin')).toThrow(/not an EVM chain/)
    expect(() => getLiquidityRouterAddress('137')).toThrow(/positive integer/)
    expect(getContractAddressForChain).not.toHaveBeenCalled()
  })

  it('readLiquidityRouterConfig and readLiquidityPool reject a Bitcoin id', async () => {
    await expect(readLiquidityRouterConfig({ chainId: 'bitcoin', provider: {} })).rejects.toThrow()
    await expect(
      readLiquidityPool({ chainId: 'bitcoin', provider: {}, kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: USDC, token1: WETH }),
    ).rejects.toThrow()
    expect(getContractAddressForChain).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- address resolution

describe('getLiquidityRouterAddress', () => {
  it('returns null when the router is undeployed (empty/absent/malformed)', () => {
    for (const value of ['', undefined, null, '0xnope']) {
      m.address = value
      expect(getLiquidityRouterAddress(1)).toBeNull()
    }
  })

  it('resolves the address from the generated config, never a hardcoded one', () => {
    m.address = ROUTER
    expect(getLiquidityRouterAddress(1)).toBe(ROUTER)
    expect(getContractAddressForChain).toHaveBeenCalledWith('liquidityRouter', 1)
  })
})

// ---------------------------------------------------------------- pool id

describe('computePoolId — byte-identical to the contract', () => {
  const encode = (kind, poolAddress, token0, token1) =>
    keccak256(AbiCoder.defaultAbiCoder().encode(['uint8', 'address', 'address', 'address'], [kind, poolAddress, token0, token1]))

  it('matches keccak256(abi.encode(kind, poolAddress, token0, token1))', () => {
    expect(computePoolId({ kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: USDC, token1: WETH })).toBe(
      encode(2, POOL, USDC, WETH),
    )
  })

  it('KIND is part of the identity — the review change', () => {
    const trading = computePoolId({ kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: USDC, token1: WETH })
    const bridge = computePoolId({ kind: POOL_KIND.BRIDGE_LP, poolAddress: POOL, token0: USDC, token1: WETH })
    expect(trading).not.toBe(bridge)
  })

  it('a bridge pool has one asset — token1 defaults to the zero address', () => {
    expect(computePoolId({ kind: POOL_KIND.BRIDGE_LP, poolAddress: HUB_POOL, token0: USDC })).toBe(
      encode(1, HUB_POOL, USDC, ZeroAddress),
    )
  })

  it('refuses to address the Unlisted kind or a missing one', () => {
    expect(() => computePoolId({ kind: POOL_KIND.UNLISTED, poolAddress: POOL, token0: USDC })).toThrow(/kind/)
    expect(() => computePoolId({ poolAddress: POOL, token0: USDC })).toThrow(/kind/)
  })

  it('refuses a trading pool with a defaulted token1 — that id is not on the router', () => {
    expect(() => computePoolId({ kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: USDC })).toThrow(/token1 is required/)
    expect(() => computePoolId({ kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: USDC, token1: ZeroAddress })).toThrow(
      /token1 is required/,
    )
  })
})

// ---------------------------------------------------------------- struct normalization

describe('normalizePool — Unlisted is absence, retired is NOT', () => {
  it('returns null for the zero-filled struct getPool() returns for unknown ids', () => {
    expect(normalizePool(ID_A, UNLISTED)).toBeNull()
  })

  it('returns null for a missing struct', () => {
    expect(normalizePool(ID_A, undefined)).toBeNull()
  })

  it('KEEPS a retired pool — it stays visible and withdrawable (FR-024)', () => {
    const pool = normalizePool(ID_A, rawPool({ enabled: false }))
    expect(pool).not.toBeNull()
    expect(pool.enabled).toBe(false)
    expect(pool.isTradingLp).toBe(true)
  })

  it('normalizes both kinds into the shapes the UI uses', () => {
    expect(normalizePool(ID_A, rawPool())).toEqual({
      poolId: ID_A,
      kind: POOL_KIND.TRADING_LP,
      enabled: true,
      feeTier: 3000,
      token0: USDC,
      token1: WETH,
      poolAddress: POOL,
      maxDeposit0PerTx: 25_000_000_000n,
      maxDeposit1PerTx: 10_000_000_000_000_000_000n,
      isTradingLp: true,
      isBridgeLp: false,
    })
    expect(normalizePool(ID_B, rawBridgePool())).toMatchObject({
      kind: POOL_KIND.BRIDGE_LP,
      token1: ZeroAddress,
      feeTier: 0,
      isBridgeLp: true,
      isTradingLp: false,
    })
  })
})

// ---------------------------------------------------------------- config read

describe('readLiquidityRouterConfig — honest null, never an invented availability', () => {
  it('returns null when no router is deployed', async () => {
    m.address = null
    expect(await readLiquidityRouterConfig({ chainId: 1, provider: {} })).toBeNull()
  })

  it('returns null when there is no provider', async () => {
    m.address = ROUTER
    expect(await readLiquidityRouterConfig({ chainId: 1, provider: null })).toBeNull()
  })

  it('returns null when the load-bearing paused() read fails (unreadable router)', async () => {
    m.address = ROUTER
    m.methods = { paused: () => Promise.reject(new Error('rpc down')) }
    expect(await readLiquidityRouterConfig({ chainId: 1, provider: {} })).toBeNull()
  })

  it('normalizes config, pause state and the curated pools of BOTH kinds', async () => {
    m.address = ROUTER
    const ids = [ID_A, ID_B]
    const raws = { [ID_A]: rawPool(), [ID_B]: rawBridgePool() }
    m.methods = {
      ...READABLE,
      poolCount: () => Promise.resolve(2n),
      poolAt: (i) => Promise.resolve(ids[Number(i)]),
      getPool: (id) => Promise.resolve(raws[id]),
    }

    const cfg = await readLiquidityRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.routerAddress).toBe(ROUTER)
    expect(cfg.positionManager).toBe('0xnfpm')
    expect(cfg.maxFeeBps).toBe(250)
    expect(cfg.paused).toBe(false)
    expect(cfg.poolsComplete).toBe(true)
    expect(cfg.pools.map((p) => p.poolId)).toEqual([ID_A, ID_B])
    expect(cfg.pools[0].isTradingLp).toBe(true)
    expect(cfg.pools[1].isBridgeLp).toBe(true)
  })

  it('reports paused honestly rather than hiding it', async () => {
    m.address = ROUTER
    m.methods = { ...READABLE, paused: () => Promise.resolve(true), poolCount: () => Promise.resolve(0n) }
    const cfg = await readLiquidityRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.paused).toBe(true)
    expect(cfg.pools).toEqual([])
  })

  it('one failed getPool drops that pool and marks the list incomplete', async () => {
    m.address = ROUTER
    m.methods = {
      ...READABLE,
      poolCount: () => Promise.resolve(2n),
      poolAt: (i) => Promise.resolve([ID_A, ID_B][Number(i)]),
      getPool: (id) => (id === ID_A ? Promise.resolve(rawPool()) : Promise.reject(new Error('rpc'))),
    }
    const cfg = await readLiquidityRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.pools).toHaveLength(1)
    expect(cfg.poolsComplete).toBe(false)
  })

  it('an Unlisted enumerated pool is skipped without claiming an incomplete read', async () => {
    m.address = ROUTER
    m.methods = {
      ...READABLE,
      poolCount: () => Promise.resolve(1n),
      poolAt: () => Promise.resolve(ID_A),
      getPool: () => Promise.resolve(UNLISTED),
    }
    const cfg = await readLiquidityRouterConfig({ chainId: 1, provider: {} })
    expect(cfg.pools).toEqual([])
    expect(cfg.poolsComplete).toBe(true)
  })

  it('a failed optional getter does not blank the whole overlay', async () => {
    m.address = ROUTER
    m.methods = {
      ...READABLE,
      positionManager: () => Promise.reject(new Error('rpc')),
      MAX_FEE_BPS: () => Promise.reject(new Error('rpc')),
      poolCount: () => Promise.resolve(0n),
    }
    const cfg = await readLiquidityRouterConfig({ chainId: 1, provider: {} })
    expect(cfg).not.toBeNull()
    expect(cfg.positionManager).toBeUndefined()
    expect(cfg.maxFeeBps).toBeNull()
  })
})

// ---------------------------------------------------------------- single-pool read

describe('readLiquidityPool', () => {
  const args = { chainId: 1, provider: {}, kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: USDC, token1: WETH }

  it('returns null when the router is undeployed', async () => {
    m.address = null
    expect(await readLiquidityPool(args)).toBeNull()
  })

  it('looks the pool up by the contract-identical id', async () => {
    m.address = ROUTER
    m.methods = { getPool: () => Promise.resolve(rawPool()) }
    const pool = await readLiquidityPool(args)
    const expectedId = computePoolId({ kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: USDC, token1: WETH })
    expect(m.calls).toContainEqual(['getPool', expectedId])
    expect(pool.poolId).toBe(expectedId)
  })

  it('returns null for a pool that is not curated (Unlisted struct, no revert)', async () => {
    m.address = ROUTER
    m.methods = { getPool: () => Promise.resolve(UNLISTED) }
    expect(await readLiquidityPool(args)).toBeNull()
  })

  it('returns null when the read fails — unavailable, not assumed available', async () => {
    m.address = ROUTER
    m.methods = { getPool: () => Promise.reject(new Error('rpc')) }
    expect(await readLiquidityPool(args)).toBeNull()
  })
})

// ---------------------------------------------------------------- pure matcher

describe('findPool', () => {
  const pools = [normalizePool(ID_A, rawPool()), normalizePool(ID_B, rawBridgePool())]

  it('matches on the full identity, case-insensitively', () => {
    expect(
      findPool(pools, { kind: POOL_KIND.TRADING_LP, poolAddress: POOL.toLowerCase(), token0: USDC.toUpperCase(), token1: WETH })
        ?.poolId,
    ).toBe(ID_A)
  })

  it('does not confuse a bridge pool with a trading pool', () => {
    expect(findPool(pools, { kind: POOL_KIND.TRADING_LP, poolAddress: HUB_POOL, token0: USDC })).toBeNull()
    expect(findPool(pools, { kind: POOL_KIND.BRIDGE_LP, poolAddress: HUB_POOL, token0: USDC })?.poolId).toBe(ID_B)
  })

  it('returns null for a missing list or no match', () => {
    expect(findPool(null, { kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: USDC, token1: WETH })).toBeNull()
    expect(findPool(pools, { kind: POOL_KIND.TRADING_LP, poolAddress: POOL, token0: WETH, token1: USDC })).toBeNull()
  })
})

// ---------------------------------------------------------------- fee treatment

describe('the platform fee applies to trading pools ONLY (research R3)', () => {
  const trading = normalizePool(ID_A, rawPool())
  const bridge = normalizePool(ID_B, rawBridgePool())

  it('a bridge pool charges no fee at all — so the UI shows no fee line, not a 0.00 one', () => {
    expect(chargesPlatformFee(bridge)).toBe(false)
    expect(chargesPlatformFee(trading)).toBe(true)
    expect(chargesPlatformFee(null)).toBe(false)
  })

  it('maxSupplyFee is an UPPER BOUND on the gross, because the fee lands on what is consumed', () => {
    // 25 bps of 1,000 USDC = 2.5 USDC — at MOST. Uniswap consumes only what the price ratio
    // needs, the fee is charged on that, and the remainder is refunded whole.
    expect(maxSupplyFee({ amountDesired: 1_000_000_000n, bps: 25 })).toBe(2_500_000n)
  })

  it('a zero rate produces no fee at all (FR-029)', () => {
    expect(maxSupplyFee({ amountDesired: 1_000_000_000n, bps: 0 })).toBe(0n)
  })

  it('rejects a rate that is not a quoted integer bps', () => {
    for (const bad of [undefined, null, -1, 10_001, 1.5, '25']) {
      expect(() => maxSupplyFee({ amountDesired: 1n, bps: bad })).toThrow(/bps/)
    }
  })
})

// ---------------------------------------------------------------- per-tx ceilings

describe('poolLimitViolation — TWO ceilings, checked independently', () => {
  const pool = normalizePool(ID_A, rawPool())

  it('passes when both legs fit', () => {
    expect(poolLimitViolation(pool, { amount0: 1_000_000n, amount1: 1_000_000_000_000_000_000n })).toBeNull()
  })

  it('catches a token1 breach even when token0 fits — the decimals point', () => {
    // 1 USDC (1e6) is far under the token0 cap; 11 WETH (1.1e19) is over the token1 cap. A
    // single scalar compared against both would have let this through.
    const v = poolLimitViolation(pool, { amount0: 1_000_000n, amount1: 11_000_000_000_000_000_000n })
    expect(v).toEqual({ leg: 1, amount: 11_000_000_000_000_000_000n, max: 10_000_000_000_000_000_000n })
  })

  it('catches a token0 breach', () => {
    expect(poolLimitViolation(pool, { amount0: 25_000_000_001n, amount1: 0n })?.leg).toBe(0)
  })

  it('treats 0 as uncapped, exactly as the contract does', () => {
    const uncapped = normalizePool(ID_A, rawPool({ maxDeposit0PerTx: 0n, maxDeposit1PerTx: 0n }))
    expect(poolLimitViolation(uncapped, { amount0: 2n ** 200n, amount1: 2n ** 200n })).toBeNull()
  })
})

// ---------------------------------------------------------------- call builder

describe('buildSupplyCalls', () => {
  const pool = normalizePool(ID_A, rawPool())
  const bridge = normalizePool(ID_B, rawBridgePool())
  const base = {
    routerAddress: ROUTER,
    pool,
    amount0Desired: 1_000_000_000n,
    amount1Desired: 500_000_000_000_000_000n,
    amount0Min: 0n,
    amount1Min: 0n,
    deadline: DEADLINE,
    maxFeeBps: 25,
  }

  it('approves BOTH legs for the gross, then calls the router', () => {
    const { calls, requiresApproval } = buildSupplyCalls(base)
    expect(requiresApproval).toBe(true)
    expect(calls).toHaveLength(3)

    expect(calls[0].target).toBe(USDC)
    expect(APPROVE_IFACE.decodeFunctionData('approve', calls[0].data)).toEqual([ROUTER, 1_000_000_000n])
    expect(calls[1].target).toBe(WETH)
    expect(APPROVE_IFACE.decodeFunctionData('approve', calls[1].data)).toEqual([ROUTER, 500_000_000_000_000_000n])

    expect(calls[2].target).toBe(ROUTER)
    expect(calls[2].value).toBe(0n)
  })

  it('passes the QUOTED bps through as maxFeeBps, unchanged (FR-028)', () => {
    const { calls } = buildSupplyCalls({ ...base, maxFeeBps: 25 })
    expect(IFACE.decodeFunctionData('mintFullRangeWithFee', calls[2].data)).toEqual([
      ID_A,
      1_000_000_000n,
      500_000_000_000_000_000n,
      0n,
      0n,
      BigInt(DEADLINE),
      25n,
    ])
  })

  it('a zero quoted rate is passed as zero — never widened to the router cap', () => {
    const { calls } = buildSupplyCalls({ ...base, maxFeeBps: 0 })
    expect(IFACE.decodeFunctionData('mintFullRangeWithFee', calls[2].data)[6]).toBe(0n)
  })

  it('a zero leg gets no approve — the contract does not pull it', () => {
    const { calls, requiresApproval } = buildSupplyCalls({ ...base, amount1Desired: 0n })
    expect(requiresApproval).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[0].target).toBe(USDC)
    expect(calls[1].target).toBe(ROUTER)
  })

  it('REFUSES a bridge pool — that deposit is a direct, fee-free call to Across (R3)', () => {
    expect(() => buildSupplyCalls({ ...base, pool: bridge })).toThrow(/direct, fee-free member call to the Across HubPool/)
  })

  it('refuses a retired pool rather than building a transaction that cannot succeed', () => {
    expect(() => buildSupplyCalls({ ...base, pool: { ...pool, enabled: false } })).toThrow(/retired/)
  })

  it('refuses an amount over EITHER per-transaction ceiling', () => {
    expect(() => buildSupplyCalls({ ...base, amount0Desired: 25_000_000_001n })).toThrow(/token0 amount/)
    expect(() => buildSupplyCalls({ ...base, amount1Desired: 11_000_000_000_000_000_000n })).toThrow(/token1 amount/)
  })

  it('refuses calldata that is guaranteed to revert or under-specify consent', () => {
    expect(() => buildSupplyCalls({ ...base, routerAddress: null })).toThrow(/routerAddress/)
    expect(() => buildSupplyCalls({ ...base, pool: null })).toThrow(/pool/)
    expect(() => buildSupplyCalls({ ...base, amount0Desired: 0n, amount1Desired: 0n })).toThrow(/non-zero/)
    expect(() => buildSupplyCalls({ ...base, deadline: 0 })).toThrow(/deadline/)
    for (const bad of [undefined, null, -1, 10_001, 1.5, '25']) {
      expect(() => buildSupplyCalls({ ...base, maxFeeBps: bad })).toThrow(/maxFeeBps/)
    }
  })
})

// ---------------------------------------------------------------- pair pinning (R11b)

describe('the pair selector uses samePair — the exact INVERSE of the bridge rule', () => {
  const usdcEth = { key: 'usdc-1', chainId: 1, symbol: 'USDC', name: 'USD Coin', networkName: 'Ethereum' }
  const wethEth = { key: 'weth-1', chainId: 1, symbol: 'WETH', name: 'Wrapped Ether', networkName: 'Ethereum' }
  const usdcPoly = { key: 'usdc-137', chainId: 137, symbol: 'USDC', name: 'USD Coin', networkName: 'Polygon' }
  const btc = { key: 'btc', chainId: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', networkName: 'Bitcoin' }

  it('pins the first leg in SAME_NETWORK mode', () => {
    expect(createLiquidityPin(usdcEth)).toMatchObject({ pinnedChainId: 1, mode: PIN_MODE.SAME_NETWORK })
    expect(createLiquidityPin(btc)).toBeNull()
  })

  it('offers counterparts on the PINNED network', () => {
    const pin = createLiquidityPin(usdcEth)
    expect(filterPairCounterparts([usdcEth, wethEth, usdcPoly, btc], pin).map((o) => o.key)).toEqual(['usdc-1', 'weth-1'])
  })

  it('NEVER offers the same asset on another network — that is the bridge rule (FR-063)', () => {
    // If `bridgeDest` were used here, this list would be exactly [usdc-137]: a "pair" spanning
    // two networks, which cannot exist and which nothing downstream would reject.
    const pin = createLiquidityPin(usdcEth)
    const offered = filterPairCounterparts([usdcPoly], pin)
    expect(offered).toEqual([])
    expect(offered.map((o) => o.key)).not.toContain('usdc-137')
  })

  it('clears a counterpart that is no longer on the pinned network when the first leg changes', () => {
    const pin = createLiquidityPin(usdcEth)
    expect(revalidatePairCounterpart(wethEth, pin)).toBe(wethEth)
    expect(revalidatePairCounterpart(usdcPoly, pin)).toBeNull()
    expect(revalidatePairCounterpart(wethEth, createLiquidityPin(usdcPoly))).toBeNull()
  })
})
