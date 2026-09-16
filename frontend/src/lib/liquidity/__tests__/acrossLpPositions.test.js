/**
 * Spec 067 (T090/T092) — the Across bridge-liquidity client.
 *
 * The headline test is T092: **the Across LP path never routes through `liquidityRouter`**.
 * That is research R3's ruling in executable form — `HubPool.addLiquidity` has no recipient
 * parameter, so a fee-taking wrapper would own the member's LP tokens and they could never
 * exit (FR-021/FR-023). It is asserted four independent ways below, because a regression
 * could arrive as a new import, a resolved address, a wrapped call target, or a fee argument.
 *
 * The rest covers what the surface depends on: Ethereum-only availability that SAYS SO
 * (research R8), the two state-changing reads that need a static call, honest nulls rather
 * than zeros (FR-054), partial-withdrawal math (FR-022), and call construction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeFunctionData } from 'viem'
import { normalizeAbi } from '../../chains/readContract'
// The module's own source text, so the "no router import" assertion below reads what ships
// rather than what a mock happens to expose.
import acrossLpSource from '../acrossLpPositions.js?raw'
import { LIQUIDITY_ROUTER_ABI } from '../../../abis/LiquidityRouter'

const m = vi.hoisted(() => ({ methods: {}, calls: [] }))

// Every read rides the spec-110 chain seam; fake it there and record what was asked of it.
// `exchangeRateCurrent` and `liquidityUtilizationCurrent` are NOT view functions — they settle
// accrued LP fees before answering — and the seam is what makes reading them safe: it is an
// `eth_call` whatever the declared mutability, with no path that sends a transaction.
vi.mock('../../chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (chainId, { functionName, args = [] }) => {
      m.calls.push([functionName, ...args])
      const f = m.methods[functionName]
      if (!f) throw new Error('unmocked method: ' + functionName)
      return f(...args)
    },
  }
})

// A SPY over the real resolver, not a replacement: the R3 test asserts this is never asked
// for the liquidity router, which only means something if the real lookup still works.
const addressSpy = vi.hoisted(() => ({ fn: null }))
vi.mock('../../../config/contracts', async (orig) => {
  const actual = await orig()
  addressSpy.fn = vi.fn(actual.getContractAddressForChain)
  return { ...actual, getContractAddressForChain: addressSpy.fn }
})

import {
  HUB_POOL_ABI,
  LP_TOKEN_ABI,
  EXCHANGE_RATE_SCALE,
  BRIDGE_LP_CHARGES_PLATFORM_FEE,
  bridgeLiquidityNetworks,
  getHubPoolAddress,
  bridgeLiquiditySupport,
  readPooledToken,
  readExchangeRate,
  readUtilization,
  readLpBalance,
  readHubPoolPaused,
  lpValueInUnderlying,
  maxWithdrawable,
  readLpPosition,
  buildAddLiquidityCalls,
  buildRemoveLiquidityCalls,
} from '../acrossLpPositions'
// Imported by the TEST only, as the control for the "never resolves a router address" check.
import { getLiquidityRouterAddress } from '../liquidityRouter'
// The cohort roster the availability answers are bounded by (#1265).
import { NETWORKS, cohortChainIds, isInCohort, listSupportedChainIds } from '../../../config/networks'

const HUB_POOL_PARSED = normalizeAbi(HUB_POOL_ABI)
const ROUTER_PARSED = normalizeAbi(LIQUIDITY_ROUTER_ABI)
const ERC20_PARSED = normalizeAbi(['function approve(address spender, uint256 amount) returns (bool)'])

/**
 * Decode one call's arguments, asserting it really is the function named (spec 110).
 *
 * ethers' `decodeFunctionData(name, data)` threw when the selector belonged to another function;
 * viem's derives the name FROM the selector, so without this check it would decode the wrong call
 * and hand back plausible arguments.
 */
function decodeAs(abi, name, data) {
  const { functionName, args } = decodeFunctionData({ abi, data })
  expect(functionName, `expected calldata for ${name}`).toBe(name)
  return args
}

/** True when this ABI can decode the calldata at all. viem THROWS where ethers returned null. */
function decodesWith(abi, data) {
  try {
    decodeFunctionData({ abi, data })
    return true
  } catch {
    return false
  }
}

const HUB_POOL = '0xc186fA914353c44b2E33eBE05f21846F1048bEda'
const LIQUIDITY_ROUTER = '0x1111111111111111111111111111111111111111'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const LP_TOKEN = '0x7355Efc63Ae731f584380a9838292c7046c1e433'
const MEMBER = '0x2222222222222222222222222222222222222222'
const WAD = 10n ** 18n

/** A raw `pooledTokens(l1Token)` result as ethers would decode it. */
function rawPooled(over = {}) {
  return {
    lpToken: LP_TOKEN,
    isEnabled: true,
    lastLpFeeUpdate: 1_800_000_000n,
    utilizedReserves: 400_000_000n,
    liquidReserves: 1_000_000_000n,
    undistributedLpFees: 5_000_000n,
    ...over,
  }
}

beforeEach(() => {
  m.methods = {}
  m.calls = []
  addressSpy.fn?.mockClear()
})

// -------------------------------------------------------- T092: no router in the path

describe('T092 — the Across LP path never routes through liquidityRouter (research R3)', () => {
  const source = acrossLpSource

  it('imports nothing from the liquidity router module', () => {
    // Import SPECIFIERS only — the module's prose explains at length why the router is absent,
    // and this must not be a test that the word never appears.
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((mm) => mm[1])
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((s) => /liquidityRouter/i.test(s))).toEqual([])
    expect(specifiers.filter((s) => /LiquidityRouter/.test(s))).toEqual([]) // the ABI, too
  })

  it('never resolves a liquidityRouter address, on any code path', async () => {
    m.methods.pooledTokens = () => rawPooled()
    m.methods.exchangeRateCurrent = () => WAD
    m.methods.liquidityUtilizationCurrent = () => WAD / 2n
    m.methods.balanceOf = () => 5n * WAD
    m.methods.paused = () => false

    bridgeLiquidityNetworks()
    getHubPoolAddress(1)
    bridgeLiquiditySupport(1)
    bridgeLiquiditySupport(137)
    await readLpPosition({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC, owner: MEMBER })
    await readHubPoolPaused({ chainId: 1, provider: {}, hubPool: HUB_POOL })
    buildAddLiquidityCalls({ hubPool: HUB_POOL, l1Token: USDC, amount: 1n })
    buildRemoveLiquidityCalls({ hubPool: HUB_POOL, l1Token: USDC, lpTokenAmount: 1n })

    const keysAsked = addressSpy.fn.mock.calls.map(([key]) => key)
    expect(keysAsked).not.toContain('liquidityRouter')
    expect(keysAsked.filter((k) => /liquidity/i.test(String(k)))).toEqual([])
  })

  it('(control) the address spy above would in fact catch a router lookup', () => {
    // Without this, the assertion above passes for the wrong reason if the mock ever stops
    // being wired. `getLiquidityRouterAddress` is the call the Across path must never make.
    getLiquidityRouterAddress(1)
    expect(addressSpy.fn.mock.calls.map(([key]) => key)).toContain('liquidityRouter')
  })

  it('builds calldata no LiquidityRouter function can decode, targeting only the pool and the token', () => {
    const supply = buildAddLiquidityCalls({ hubPool: HUB_POOL, l1Token: USDC, amount: 1_000_000n })
    const exit = buildRemoveLiquidityCalls({ hubPool: HUB_POOL, l1Token: USDC, lpTokenAmount: 5n * WAD })

    for (const call of [...supply.calls, ...exit.calls]) {
      expect([HUB_POOL, USDC]).toContain(call.target)
      expect(call.target).not.toBe(LIQUIDITY_ROUTER)
      // If any leg were a router call, the router's own ABI would decode it.
      expect(decodesWith(ROUTER_PARSED, call.data), 'no leg is a router call').toBe(false)
    }
  })

  it('has no fee argument and no fee leg — a bridge pool is fee-free, not zero-fee', () => {
    expect(BRIDGE_LP_CHARGES_PLATFORM_FEE).toBe(false)

    // A caller that mistakenly passes a fee ceiling changes nothing: there is no parameter for
    // it, so the calldata is byte-identical to the call without it.
    const plain = buildAddLiquidityCalls({ hubPool: HUB_POOL, l1Token: USDC, amount: 1_000_000n })
    const withFee = buildAddLiquidityCalls({
      hubPool: HUB_POOL,
      l1Token: USDC,
      amount: 1_000_000n,
      maxFeeBps: 250,
    })
    expect(withFee.calls.map((c) => c.data)).toEqual(plain.calls.map((c) => c.data))

    // The deposit itself carries exactly the token and the full amount — nothing is skimmed.
    const deposit = plain.calls.at(-1)
    const decoded = decodeAs(HUB_POOL_PARSED, 'addLiquidity', deposit.data)
    expect(decoded[0]).toBe(USDC)
    expect(decoded[1]).toBe(1_000_000n)
  })
})

// -------------------------------------------------------- availability (research R8)

describe('availability is Ethereum only, and says so', () => {
  it('resolves the HubPool only where one is configured', () => {
    expect(getHubPoolAddress(1)).toBe(HUB_POOL)
    expect(getHubPoolAddress(137)).toBeNull()
    expect(getHubPoolAddress(8453)).toBeNull()
  })

  it('lists exactly the networks carrying a HubPool that this build may read', () => {
    // The config fact, which holds in every build: one HubPool, on Ethereum.
    expect(listSupportedChainIds().filter((id) => NETWORKS[id].bridge?.hubPool)).toEqual([1])

    // The roster narrows that to the cohort (#1265) — constitution III forbids a
    // testnet build describing, or reading, the mainnet HubPool. This test build
    // is a testnet one, so the honest answer is an empty list.
    const nets = bridgeLiquidityNetworks()
    expect(nets.map((n) => n.chainId)).toEqual(
      cohortChainIds().filter((id) => NETWORKS[id].bridge?.hubPool),
    )
    for (const net of nets) {
      expect(isInCohort(net.chainId)).toBe(true)
      expect(net.hubPool).toBe(NETWORKS[net.chainId].bridge.hubPool)
    }
    if (isInCohort(1)) expect(nets.map((n) => n.hubPool)).toContain(HUB_POOL)
  })

  it('reports unsupported networks with a REASON naming where it is available', () => {
    const polygon = bridgeLiquiditySupport(137)
    expect(polygon.available).toBe(false)
    expect(polygon.hubPool).toBeNull()
    // Honest, not silent: it says where it is not, and either where it IS or —
    // in a build with no bridge pool to name — that there is none to name.
    expect(polygon.reason).toMatch(/Polygon/)
    expect(polygon.reason).toMatch(
      isInCohort(1) ? /Ethereum/ : /No network is set up for bridge pools in this build yet/i,
    )
  })

  it('says yes on Ethereum, with the address and no reason', () => {
    expect(bridgeLiquiditySupport(1)).toEqual({
      available: true,
      chainId: 1,
      hubPool: HUB_POOL,
      reason: null,
    })
  })

  it('answers for Bitcoin instead of throwing, and never lets a string id reach a lookup', () => {
    const btc = bridgeLiquiditySupport('bitcoin')
    expect(btc.available).toBe(false)
    expect(btc.reason).toMatch(/Bitcoin/)
    expect(btc.reason).toMatch(
      isInCohort(1) ? /Ethereum/ : /No network is set up for bridge pools in this build yet/i,
    )
    // The throwing form is the caller-bug boundary guard (spec 061).
    expect(() => getHubPoolAddress('bitcoin')).toThrow(/not an EVM chain/)
  })

  it('never returns available:true without a reason to show when it is false', () => {
    for (const chainId of [137, 8453, 42161, 10, 61, 63, 999999]) {
      const support = bridgeLiquiditySupport(chainId)
      if (!support.available) expect(support.reason).toBeTruthy()
    }
  })
})

// -------------------------------------------------------- reads

describe('reads — state-changing calls are static-called, failures are null', () => {
  it('reads the pooled-token record', async () => {
    m.methods.pooledTokens = () => rawPooled()
    const pooled = await readPooledToken({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC })
    expect(pooled).toEqual({
      lpToken: LP_TOKEN,
      isEnabled: true,
      lastLpFeeUpdate: 1_800_000_000,
      utilizedReserves: 400_000_000n,
      liquidReserves: 1_000_000_000n,
      undistributedLpFees: 5_000_000n,
    })
  })

  it('treats a zero LP token as "not a pooled token here", not as a real pool', async () => {
    m.methods.pooledTokens = () => rawPooled({ lpToken: '0x' + '0'.repeat(40) })
    expect(await readPooledToken({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC })).toBeNull()
  })

  it('keeps a DISABLED pooled token readable — no new deposits, still withdrawable (FR-024)', async () => {
    m.methods.pooledTokens = () => rawPooled({ isEnabled: false })
    const pooled = await readPooledToken({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC })
    expect(pooled.isEnabled).toBe(false)
    expect(pooled.lpToken).toBe(LP_TOKEN)
  })

  // The two fee-settling functions are NOT views, and the danger was never that they would be
  // read wrongly — it was that reading them wrongly builds a TRANSACTION the member is asked to
  // sign. Under ethers that was held off by spelling `.staticCall(...)` at each site, which is a
  // thing a future edit can forget. On the chain seam it cannot happen: `readContract` is an
  // eth_call whatever the declared mutability, and has no path that sends one. So what is
  // asserted now is the property itself — these two are READ, and never end up in a built call.
  it('reads exchangeRateCurrent through the read seam, which cannot send a transaction', async () => {
    m.methods.exchangeRateCurrent = () => (WAD * 1013n) / 1000n
    const rate = await readExchangeRate({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC })
    expect(rate).toBe((WAD * 1013n) / 1000n)
    expect(m.calls.map(([k]) => k)).toContain('exchangeRateCurrent')
  })

  it('reads liquidityUtilizationCurrent the same way', async () => {
    m.methods.liquidityUtilizationCurrent = () => WAD / 4n
    expect(await readUtilization({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC })).toBe(WAD / 4n)
    expect(m.calls.map(([k]) => k)).toContain('liquidityUtilizationCurrent')
  })

  it('never encodes either fee-settling function into a call the member would sign', () => {
    // Source-level, because the failure it guards is a call that is never built in any test:
    // an edit that encodes one of these into `{target, data, value}` would settle Across's fees
    // at the member's expense and could not be read back from a return value.
    const encoded = [...acrossLpSource.matchAll(/functionName:\s*'([^']+)'/g)].map((mm) => mm[1])
    const built = [...acrossLpSource.matchAll(/encodeFunctionData\(\{[^}]*functionName:\s*'([^']+)'/g)].map(
      (mm) => mm[1],
    )
    expect(encoded).toContain('exchangeRateCurrent') // it IS read
    expect(built).toEqual(expect.arrayContaining(['approve', 'addLiquidity', 'removeLiquidity']))
    expect(built).not.toContain('exchangeRateCurrent')
    expect(built).not.toContain('liquidityUtilizationCurrent')
  })

  it('returns null — never a zero or a 1e18 stand-in — when a read fails', async () => {
    m.methods.pooledTokens = () => {
      throw new Error('rpc down')
    }
    m.methods.exchangeRateCurrent = () => {
      throw new Error('rpc down')
    }
    m.methods.balanceOf = () => {
      throw new Error('rpc down')
    }
    m.methods.paused = () => {
      throw new Error('rpc down')
    }
    expect(await readPooledToken({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC })).toBeNull()
    expect(await readExchangeRate({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC })).toBeNull()
    expect(await readLpBalance({ chainId: 1, provider: {}, lpToken: LP_TOKEN, owner: MEMBER })).toBeNull()
    // Unknown pause state is null, NOT false — "we could not check" is not "it is running".
    expect(await readHubPoolPaused({ chainId: 1, provider: {}, hubPool: HUB_POOL })).toBeNull()
  })

  it('returns null when an argument is missing, without touching the chain', async () => {
    expect(await readPooledToken({ chainId: 1, provider: null, hubPool: HUB_POOL, l1Token: USDC })).toBeNull()
    expect(await readLpBalance({ chainId: 1, provider: {}, lpToken: LP_TOKEN, owner: null })).toBeNull()
    expect(m.calls).toEqual([])
  })

  it('exposes the LP token as a plain ERC-20 read surface', () => {
    expect(LP_TOKEN_ABI.some((f) => f.includes('balanceOf'))).toBe(true)
  })
})

// -------------------------------------------------------- valuation

describe('valuation and partial withdrawal (FR-020/FR-022)', () => {
  it('values an LP balance at the current exchange rate', () => {
    expect(lpValueInUnderlying(5n * WAD, (WAD * 12n) / 10n)).toBe(6n * WAD)
    expect(EXCHANGE_RATE_SCALE).toBe(WAD)
  })

  it('refuses to value what it does not know', () => {
    expect(lpValueInUnderlying(null, WAD)).toBeNull()
    expect(lpValueInUnderlying(5n * WAD, null)).toBeNull()
  })

  it('allows a FULL exit when the reserves cover it', () => {
    expect(maxWithdrawable({ lpBalance: 10n * WAD, exchangeRate: WAD, liquidReserves: 50n * WAD })).toEqual({
      lpTokens: 10n * WAD,
      underlying: 10n * WAD,
      isFull: true,
    })
  })

  it('caps at the liquid reserves and flags the shortfall, rounding DOWN', () => {
    // 10 LP at 1.5 = 15 owed, but only 6 is sitting in the pot right now.
    const capped = maxWithdrawable({
      lpBalance: 10n * WAD,
      exchangeRate: (WAD * 15n) / 10n,
      liquidReserves: 6n * WAD,
    })
    expect(capped.isFull).toBe(false)
    expect(capped.lpTokens).toBe(4n * WAD)
    // Rounded down so the HubPool can certainly honour it.
    expect(capped.underlying).toBeLessThanOrEqual(6n * WAD)
  })

  it('returns null rather than implying nothing can be withdrawn', () => {
    expect(maxWithdrawable({ lpBalance: null, exchangeRate: WAD, liquidReserves: WAD })).toBeNull()
    expect(maxWithdrawable({ lpBalance: WAD, exchangeRate: null, liquidReserves: WAD })).toBeNull()
    expect(maxWithdrawable({ lpBalance: WAD, exchangeRate: 0n, liquidReserves: WAD })).toBeNull()
  })

  it('assembles a position, labelled an estimate', async () => {
    m.methods.pooledTokens = () => rawPooled({ liquidReserves: 10n * WAD })
    m.methods.balanceOf = () => 4n * WAD
    m.methods.exchangeRateCurrent = () => (WAD * 11n) / 10n
    m.methods.liquidityUtilizationCurrent = () => WAD / 3n

    const position = await readLpPosition({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC, owner: MEMBER })
    expect(position.lpToken).toBe(LP_TOKEN)
    expect(position.acceptsDeposits).toBe(true)
    expect(position.lpBalance).toBe(4n * WAD)
    expect(position.currentValue).toBe((4n * WAD * 11n) / 10n)
    expect(position.withdrawable).toEqual({ lpTokens: 4n * WAD, underlying: (44n * WAD) / 10n, isFull: true })
    expect(position.isEstimate).toBe(true)
    // Earnings are NOT invented here — they need the ledger's cost basis.
    expect(position.earningsToDate).toBeUndefined()
  })

  it('keeps the position visible when a FIGURE is unreadable', async () => {
    m.methods.pooledTokens = () => rawPooled()
    m.methods.balanceOf = () => 4n * WAD
    m.methods.exchangeRateCurrent = () => {
      throw new Error('rpc down')
    }
    m.methods.liquidityUtilizationCurrent = () => {
      throw new Error('rpc down')
    }
    const position = await readLpPosition({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC, owner: MEMBER })
    expect(position.lpBalance).toBe(4n * WAD) // still there, still exitable
    expect(position.currentValue).toBeNull() // honestly unavailable, not 0
    expect(position.withdrawable).toBeNull()
    expect(position.utilization).toBeNull()
  })

  it('returns null only when the pool record itself is unreadable', async () => {
    m.methods.pooledTokens = () => {
      throw new Error('rpc down')
    }
    expect(await readLpPosition({ chainId: 1, provider: {}, hubPool: HUB_POOL, l1Token: USDC, owner: MEMBER })).toBeNull()
  })
})

// -------------------------------------------------------- calls

describe('buildAddLiquidityCalls', () => {
  it('approves exactly the amount, then deposits', () => {
    const { calls, requiresApproval } = buildAddLiquidityCalls({
      hubPool: HUB_POOL,
      l1Token: USDC,
      amount: 250_000_000n,
    })
    expect(requiresApproval).toBe(true)
    expect(calls).toHaveLength(2)

    expect(calls[0].target).toBe(USDC)
    const approve = decodeAs(ERC20_PARSED, 'approve', calls[0].data)
    expect(approve[0]).toBe(HUB_POOL)
    expect(approve[1]).toBe(250_000_000n)
    expect(calls[0].value).toBe(0n)

    expect(calls[1].target).toBe(HUB_POOL)
    expect(decodeAs(HUB_POOL_PARSED, 'addLiquidity', calls[1].data)).toEqual([USDC, 250_000_000n])
    expect(calls[1].value).toBe(0n)
  })

  it('sends native value equal to the amount on the WETH pool, with no approval', () => {
    const { calls, requiresApproval } = buildAddLiquidityCalls({
      hubPool: HUB_POOL,
      l1Token: WETH,
      amount: 3n * WAD,
      useNative: true,
      weth: WETH,
    })
    expect(requiresApproval).toBe(false)
    expect(calls).toHaveLength(1)
    // The HubPool requires msg.value == l1TokenAmount exactly.
    expect(calls[0].value).toBe(3n * WAD)
  })

  it('refuses a native deposit into a non-WETH pool instead of building a reverting call', () => {
    expect(() =>
      buildAddLiquidityCalls({ hubPool: HUB_POOL, l1Token: USDC, amount: 1n, useNative: true, weth: WETH }),
    ).toThrow(/only the WETH pool/)
  })

  it('rejects a missing pool, token, or non-positive amount', () => {
    expect(() => buildAddLiquidityCalls({ l1Token: USDC, amount: 1n })).toThrow(/hubPool is required/)
    expect(() => buildAddLiquidityCalls({ hubPool: HUB_POOL, amount: 1n })).toThrow(/l1Token is required/)
    expect(() => buildAddLiquidityCalls({ hubPool: HUB_POOL, l1Token: USDC, amount: 0n })).toThrow(/positive/)
  })
})

describe('buildRemoveLiquidityCalls', () => {
  it('is a single direct call with NO approval leg — the HubPool burns by role', () => {
    const { calls, requiresApproval } = buildRemoveLiquidityCalls({
      hubPool: HUB_POOL,
      l1Token: USDC,
      lpTokenAmount: 2n * WAD,
    })
    expect(requiresApproval).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].target).toBe(HUB_POOL)
    expect(calls[0].value).toBe(0n)
    expect(decodeAs(HUB_POOL_PARSED, 'removeLiquidity', calls[0].data)).toEqual([USDC, 2n * WAD, false])
  })

  it('supports a PARTIAL exit — the remainder stays supplied (FR-022)', () => {
    const { calls } = buildRemoveLiquidityCalls({
      hubPool: HUB_POOL,
      l1Token: USDC,
      lpTokenAmount: (2n * WAD) / 5n,
    })
    expect(decodeAs(HUB_POOL_PARSED, 'removeLiquidity', calls[0].data)[1]).toBe((2n * WAD) / 5n)
  })

  it('unwraps to ETH only for the WETH pool', () => {
    const { calls } = buildRemoveLiquidityCalls({
      hubPool: HUB_POOL,
      l1Token: WETH,
      lpTokenAmount: WAD,
      receiveNative: true,
      weth: WETH,
    })
    expect(decodeAs(HUB_POOL_PARSED, 'removeLiquidity', calls[0].data)[2]).toBe(true)
    expect(() =>
      buildRemoveLiquidityCalls({
        hubPool: HUB_POOL,
        l1Token: USDC,
        lpTokenAmount: WAD,
        receiveNative: true,
        weth: WETH,
      }),
    ).toThrow(/only the WETH pool/)
  })

  it('rejects a non-positive LP amount', () => {
    expect(() => buildRemoveLiquidityCalls({ hubPool: HUB_POOL, l1Token: USDC, lpTokenAmount: 0n })).toThrow(
      /positive/,
    )
  })
})
