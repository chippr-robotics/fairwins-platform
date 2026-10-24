/**
 * Spec 067 (T089/T091): full-range tick derivation matches the contract bit for bit, position
 * valuation is the ported Uniswap math rather than a float approximation, every figure is
 * labelled an estimate, every failed read is `null` rather than a zero, and the EXIT path
 * never touches the router (FR-020/FR-021/FR-030/FR-054).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeFunctionData, toFunctionSelector } from 'viem'
import { normalizeAbi } from '../../chains/readContract'

const m = vi.hoisted(() => ({ methods: {}, calls: [] }))

// Spec 110 Phase 1: the module reads through the chain seam; the driveable registry keeps its
// shape. A read carrying `account` is ethers' `collect.staticCall(..., { from })` — routed to
// the same `<fn>.staticCall` key the suite already registers.
vi.mock('../../chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args = [], account }) => {
      const key = account !== undefined ? `${functionName}.staticCall` : functionName
      // Record the caller the way the ethers harness did ({ from }) so assertions on the
      // simulated collect's msg.sender keep reading naturally.
      m.calls.push(account !== undefined ? [key, ...args, { from: account }] : [key, ...args])
      const f = m.methods[key]
      if (!f) throw new Error('unmocked method: ' + key)
      return f(...args)
    },
  }
})

import {
  MIN_TICK,
  MAX_TICK,
  Q96,
  NFPM_ABI,
  fullRangeTicks,
  isFullRange,
  getSqrtRatioAtTick,
  getAmount0ForLiquidity,
  getAmount1ForLiquidity,
  positionAmounts,
  poolPriceFromSqrt,
  compositionShares,
  normalizePosition,
  readPosition,
  listPositionTokenIds,
  matchesPool,
  readPoolState,
  readUncollectedFees,
  readPositionSnapshot,
  readMemberPositions,
  buildExitCalls,
} from '../uniswapPositions'

const NFPM_PARSED = normalizeAbi(NFPM_ABI)

/**
 * Decode one call's arguments, asserting it really is the function named (spec 110).
 *
 * ethers' `decodeFunctionData(name, data)` threw when the selector belonged to a different
 * function; viem's derives the name FROM the selector, so it would happily decode the wrong call
 * and hand back plausible arguments. The name check is what restores the guarantee — without it
 * these assertions would stop distinguishing `decreaseLiquidity` from `collect`.
 */
function decodeCall(name, data) {
  const { functionName, args } = decodeFunctionData({ abi: NFPM_PARSED, data })
  expect(functionName, `expected calldata for ${name}`).toBe(name)
  return args
}

const selectorOf = (name) => toFunctionSelector(NFPM_PARSED.find((f) => f.type === 'function' && f.name === name))

const NFPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'
const POOL = '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const MEMBER = '0x2222222222222222222222222222222222222222'
const DEADLINE = 1_800_000_000

/** A raw `positions(tokenId)` result as ethers would decode it. */
function rawPosition(over = {}) {
  return {
    nonce: 0n,
    operator: '0x0000000000000000000000000000000000000000',
    token0: USDC,
    token1: WETH,
    fee: 3000n,
    tickLower: -887220n,
    tickUpper: 887220n,
    liquidity: 10n ** 18n,
    feeGrowthInside0LastX128: 0n,
    feeGrowthInside1LastX128: 0n,
    tokensOwed0: 1_000_000n,
    tokensOwed1: 2_000_000_000_000_000n,
    ...over,
  }
}

beforeEach(() => {
  m.methods = {}
  m.calls = []
})

// ---------------------------------------------------------------- tick derivation

describe('fullRangeTicks — the JS twin of LiquidityRouter.fullRangeTicks', () => {
  it('aligns the absolute bounds DOWN toward zero, per fee tier spacing', () => {
    // Truncation toward zero: ceil for the negative bound, floor for the positive one —
    // exactly what Solidity's integer division does, and what Uniswap requires.
    expect(fullRangeTicks(1)).toEqual({ tickLower: -887272, tickUpper: 887272 })
    expect(fullRangeTicks(10)).toEqual({ tickLower: -887270, tickUpper: 887270 })
    expect(fullRangeTicks(60)).toEqual({ tickLower: -887220, tickUpper: 887220 })
    expect(fullRangeTicks(200)).toEqual({ tickLower: -887200, tickUpper: 887200 })
  })

  it('is symmetric and never exceeds the usable range', () => {
    for (const spacing of [1, 10, 60, 200]) {
      const { tickLower, tickUpper } = fullRangeTicks(spacing)
      expect(tickLower).toBe(-tickUpper)
      expect(tickLower).toBeGreaterThanOrEqual(MIN_TICK)
      expect(tickUpper).toBeLessThanOrEqual(MAX_TICK)
      expect(Math.abs(tickLower % spacing)).toBe(0)
      expect(Math.abs(tickUpper % spacing)).toBe(0)
    }
  })

  it('would NOT match the contract if it floored — the guard against that regression', () => {
    // Math.floor(-887272 / 60) * 60 === -887280, which is below MIN_TICK and reverts on mint.
    expect(fullRangeTicks(60).tickLower).not.toBe(Math.floor(MIN_TICK / 60) * 60)
  })

  it('accepts the bigint the pool read actually returns', () => {
    expect(fullRangeTicks(60n)).toEqual({ tickLower: -887220, tickUpper: 887220 })
  })

  it('refuses a spacing that cannot produce ticks', () => {
    for (const bad of [0, -60, 1.5, null, undefined, 'sixty', {}]) {
      expect(() => fullRangeTicks(bad)).toThrow(/tickSpacing/)
    }
  })

  it('isFullRange recognises the v1 shape and rejects a concentrated range', () => {
    expect(isFullRange({ tickLower: -887220, tickUpper: 887220 }, 60)).toBe(true)
    expect(isFullRange({ tickLower: -60, tickUpper: 60 }, 60)).toBe(false)
  })
})

// ---------------------------------------------------------------- tick math

describe('getSqrtRatioAtTick — Uniswap TickMath, ported not approximated', () => {
  it('is 2^96 at tick 0', () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96)
    expect(Q96).toBe(79228162514264337593543950336n)
  })

  it('matches the canonical MIN_SQRT_RATIO / MAX_SQRT_RATIO constants', () => {
    expect(getSqrtRatioAtTick(MIN_TICK)).toBe(4295128739n)
    expect(getSqrtRatioAtTick(MAX_TICK)).toBe(1461446703485210103287273052203988822378723970342n)
  })

  it('is strictly increasing in tick', () => {
    let prev = 0n
    for (const tick of [-887272, -100000, -60, -1, 0, 1, 60, 100000, 887272]) {
      const v = getSqrtRatioAtTick(tick)
      expect(v).toBeGreaterThan(prev)
      prev = v
    }
  })

  it('approximates sqrt(1.0001^tick) — cross-checked against floating point in the safe middle', () => {
    for (const tick of [-20000, -600, 600, 20000]) {
      const exact = Number(getSqrtRatioAtTick(tick)) / Number(Q96)
      const approx = Math.sqrt(1.0001 ** tick)
      expect(Math.abs(exact - approx) / approx).toBeLessThan(1e-9)
    }
  })

  it('refuses ticks outside the usable range or non-integers', () => {
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(/usable range/)
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow(/usable range/)
    expect(() => getSqrtRatioAtTick(1.5)).toThrow(/integer/)
  })
})

// ---------------------------------------------------------------- composition

describe('positionAmounts — what the position HOLDS right now (FR-020)', () => {
  const full = fullRangeTicks(60)
  const L = 10n ** 18n

  it('splits both ways while the price is inside the range, and says so', () => {
    const at = positionAmounts({ liquidity: L, sqrtPriceX96: Q96, ...full })
    expect(at.inRange).toBe(true)
    expect(at.amount0).toBeGreaterThan(0n)
    expect(at.amount1).toBeGreaterThan(0n)
    expect(at.isEstimate).toBe(true)
  })

  it('is symmetric at price 1 for a symmetric range', () => {
    const { amount0, amount1 } = positionAmounts({ liquidity: L, sqrtPriceX96: Q96, ...full })
    const diff = amount0 > amount1 ? amount0 - amount1 : amount1 - amount0
    expect(Number(diff) / Number(amount0)).toBeLessThan(0.001)
  })

  it('is entirely token0 below the range and entirely token1 above it', () => {
    const below = positionAmounts({ liquidity: L, sqrtPriceX96: getSqrtRatioAtTick(full.tickLower), ...full })
    expect(below.amount1).toBe(0n)
    expect(below.amount0).toBeGreaterThan(0n)
    expect(below.inRange).toBe(false)

    const above = positionAmounts({ liquidity: L, sqrtPriceX96: getSqrtRatioAtTick(full.tickUpper), ...full })
    expect(above.amount0).toBe(0n)
    expect(above.amount1).toBeGreaterThan(0n)
    expect(above.inRange).toBe(false)
  })

  it('an empty position holds nothing — not an invented balance', () => {
    expect(positionAmounts({ liquidity: 0n, sqrtPriceX96: Q96, ...full })).toMatchObject({ amount0: 0n, amount1: 0n })
  })

  it('the leg helpers agree regardless of argument order', () => {
    const a = getSqrtRatioAtTick(-600)
    const b = getSqrtRatioAtTick(600)
    expect(getAmount0ForLiquidity(a, b, L)).toBe(getAmount0ForLiquidity(b, a, L))
    expect(getAmount1ForLiquidity(a, b, L)).toBe(getAmount1ForLiquidity(b, a, L))
  })

  it('a wider range holds more of both legs for the same liquidity', () => {
    const narrow = positionAmounts({ liquidity: L, sqrtPriceX96: Q96, tickLower: -600, tickUpper: 600 })
    const wide = positionAmounts({ liquidity: L, sqrtPriceX96: Q96, ...full })
    expect(wide.amount0).toBeGreaterThan(narrow.amount0)
    expect(wide.amount1).toBeGreaterThan(narrow.amount1)
  })
})

describe('compositionShares / poolPriceFromSqrt — protocol-derived, labelled, never invented', () => {
  it('splits roughly 50/50 at parity and always sums to 100', () => {
    const shares = compositionShares({ amount0: 1_000_000_000_000_000_000n, amount1: 1_000_000_000_000_000_000n, sqrtPriceX96: Q96 })
    expect(shares.share0).toBeCloseTo(50, 1)
    expect(shares.share0 + shares.share1).toBeCloseTo(100, 5)
    expect(shares.isEstimate).toBe(true)
  })

  it('returns null for an empty position rather than a meaningless 50/50', () => {
    expect(compositionShares({ amount0: 0n, amount1: 0n, sqrtPriceX96: Q96 })).toBeNull()
  })

  it('returns null when the price is unknown — unavailable, not zero', () => {
    expect(compositionShares({ amount0: 1n, amount1: 1n, sqrtPriceX96: 0n })).toBeNull()
    expect(poolPriceFromSqrt({ sqrtPriceX96: 0n, decimals0: 6, decimals1: 18 })).toBeNull()
    expect(poolPriceFromSqrt({ sqrtPriceX96: Q96 })).toBeNull()
  })

  it('scales the raw ratio by the two tokens decimals', () => {
    // Equal decimals at parity: 1 token0 = 1 token1.
    expect(poolPriceFromSqrt({ sqrtPriceX96: Q96, decimals0: 18, decimals1: 18 })).toBeCloseTo(1, 9)
    // USDC (6) / WETH (18) at the same raw ratio is 1e12 in human terms.
    expect(poolPriceFromSqrt({ sqrtPriceX96: Q96, decimals0: 6, decimals1: 18 })).toBeCloseTo(1e-12, 20)
  })
})

// ---------------------------------------------------------------- position reads

describe('normalizePosition', () => {
  it('normalizes into the shape the UI uses', () => {
    expect(normalizePosition(42n, rawPosition())).toMatchObject({
      tokenId: 42n,
      token0: USDC,
      token1: WETH,
      feeTier: 3000,
      tickLower: -887220,
      tickUpper: 887220,
      liquidity: 10n ** 18n,
      isClosed: false,
    })
  })

  it('marks a fully-withdrawn position closed, but still returns it', () => {
    const closed = normalizePosition(42n, rawPosition({ liquidity: 0n, tokensOwed0: 0n, tokensOwed1: 0n }))
    expect(closed.isClosed).toBe(true)
  })

  it('does not treat a position with fees still owed as closed', () => {
    expect(normalizePosition(42n, rawPosition({ liquidity: 0n, tokensOwed1: 0n })).isClosed).toBe(false)
  })

  it('returns null for a missing read rather than a zero-filled placeholder', () => {
    expect(normalizePosition(42n, undefined)).toBeNull()
    expect(normalizePosition(42n, rawPosition({ token0: null }))).toBeNull()
  })
})

describe('readPosition / listPositionTokenIds — honest null on a failed read', () => {
  it('returns null with no provider or no position manager', async () => {
    expect(await readPosition({ provider: null, positionManager: NFPM, tokenId: 1n })).toBeNull()
    expect(await readPosition({ provider: {}, positionManager: null, tokenId: 1n })).toBeNull()
    expect(await listPositionTokenIds({ provider: {}, positionManager: NFPM, owner: null })).toBeNull()
  })

  it('returns null when the position read fails', async () => {
    m.methods = { positions: () => Promise.reject(new Error('rpc')) }
    expect(await readPosition({ provider: {}, positionManager: NFPM, tokenId: 1n })).toBeNull()
  })

  it('returns null when the balance read fails — "we do not know", not "no positions"', async () => {
    m.methods = { balanceOf: () => Promise.reject(new Error('rpc')) }
    expect(await listPositionTokenIds({ provider: {}, positionManager: NFPM, owner: MEMBER })).toBeNull()
  })

  it('enumerates every token id the account owns', async () => {
    m.methods = {
      balanceOf: () => Promise.resolve(2n),
      tokenOfOwnerByIndex: (_o, i) => Promise.resolve([7n, 9n][Number(i)]),
    }
    expect(await listPositionTokenIds({ provider: {}, positionManager: NFPM, owner: MEMBER })).toEqual({
      tokenIds: [7n, 9n],
      complete: true,
    })
  })

  it('flags an incomplete enumeration instead of passing a short list off as the whole truth', async () => {
    m.methods = {
      balanceOf: () => Promise.resolve(2n),
      tokenOfOwnerByIndex: (_o, i) => (Number(i) === 0 ? Promise.resolve(7n) : Promise.reject(new Error('rpc'))),
    }
    const listed = await listPositionTokenIds({ provider: {}, positionManager: NFPM, owner: MEMBER })
    expect(listed.tokenIds).toEqual([7n])
    expect(listed.complete).toBe(false)
  })
})

describe('readPoolState', () => {
  it('returns null when slot0 — the load-bearing read — fails', async () => {
    m.methods = { slot0: () => Promise.reject(new Error('rpc')) }
    expect(await readPoolState({ provider: {}, poolAddress: POOL })).toBeNull()
    expect(await readPoolState({ provider: {}, poolAddress: null })).toBeNull()
  })

  it('keeps optional reads honest rather than blanking the whole state', async () => {
    m.methods = {
      slot0: () => Promise.resolve({ sqrtPriceX96: Q96, tick: 0n }),
      tickSpacing: () => Promise.reject(new Error('rpc')),
      fee: () => Promise.resolve(3000n),
    }
    expect(await readPoolState({ provider: {}, poolAddress: POOL })).toEqual({
      sqrtPriceX96: Q96,
      tick: 0,
      tickSpacing: null,
      feeTier: 3000,
    })
  })
})

// ---------------------------------------------------------------- earnings

describe('readUncollectedFees — simulate the collect, fall back honestly, never guess', () => {
  it('prefers a simulated collect and labels it', async () => {
    m.methods = { 'collect.staticCall': () => Promise.resolve({ amount0: 12_345n, amount1: 6_789n }) }
    const fees = await readUncollectedFees({ provider: {}, positionManager: NFPM, tokenId: 42n, owner: MEMBER })
    expect(fees).toEqual({ amount0: 12_345n, amount1: 6_789n, source: 'simulated', isEstimate: true })
    // Simulated FROM the owner — the position manager rejects an unauthorised caller.
    const call = m.calls.find(([k]) => k === 'collect.staticCall')
    expect(call[1]).toMatchObject({ tokenId: 42n, recipient: MEMBER })
    expect(call[2]).toEqual({ from: MEMBER })
  })

  it('falls back to the on-chain snapshot and SAYS it is the snapshot', async () => {
    m.methods = {
      'collect.staticCall': () => Promise.reject(new Error('no simulation')),
      positions: () => Promise.resolve(rawPosition()),
    }
    const fees = await readUncollectedFees({ provider: {}, positionManager: NFPM, tokenId: 42n, owner: MEMBER })
    expect(fees).toEqual({
      amount0: 1_000_000n,
      amount1: 2_000_000_000_000_000n,
      source: 'accrued-snapshot',
      isEstimate: true,
    })
  })

  it('returns null when neither source can be read — unavailable, not "you earned nothing"', async () => {
    m.methods = {
      'collect.staticCall': () => Promise.reject(new Error('no simulation')),
      positions: () => Promise.reject(new Error('rpc')),
    }
    expect(await readUncollectedFees({ provider: {}, positionManager: NFPM, tokenId: 42n, owner: MEMBER })).toBeNull()
  })

  it('survives a simulation that throws synchronously while being built', async () => {
    m.methods = {
      'collect.staticCall': () => {
        throw new Error('bad override')
      },
      positions: () => Promise.resolve(rawPosition()),
    }
    expect((await readUncollectedFees({ provider: {}, positionManager: NFPM, tokenId: 42n, owner: MEMBER })).source).toBe(
      'accrued-snapshot',
    )
  })
})

// ---------------------------------------------------------------- snapshot

describe('readPositionSnapshot — value, earnings, composition, all as estimates', () => {
  it('returns null when the position itself cannot be read', async () => {
    m.methods = { positions: () => Promise.reject(new Error('rpc')) }
    expect(await readPositionSnapshot({ provider: {}, positionManager: NFPM, tokenId: 42n, owner: MEMBER, poolAddress: POOL })).toBeNull()
  })

  it('assembles composition, shares and earnings and labels every figure an estimate', async () => {
    m.methods = {
      positions: () => Promise.resolve(rawPosition()),
      slot0: () => Promise.resolve({ sqrtPriceX96: Q96, tick: 0n }),
      tickSpacing: () => Promise.resolve(60n),
      fee: () => Promise.resolve(3000n),
      'collect.staticCall': () => Promise.resolve({ amount0: 5n, amount1: 7n }),
    }
    const snap = await readPositionSnapshot({ provider: {}, positionManager: NFPM, tokenId: 42n, owner: MEMBER, poolAddress: POOL })
    expect(snap.isEstimate).toBe(true)
    expect(snap.composition.amount0).toBeGreaterThan(0n)
    expect(snap.composition.isEstimate).toBe(true)
    expect(snap.shares.share0 + snap.shares.share1).toBeCloseTo(100, 5)
    expect(snap.earnings).toMatchObject({ source: 'simulated', isEstimate: true })
  })

  it('KEEPS the position when the pool price is unreadable — figures unavailable, position visible', async () => {
    // The member must still see (and be able to exit) a position when a price read fails.
    m.methods = {
      positions: () => Promise.resolve(rawPosition()),
      slot0: () => Promise.reject(new Error('rpc')),
      'collect.staticCall': () => Promise.reject(new Error('rpc')),
      // `positions` is re-read by the fees fallback.
    }
    const snap = await readPositionSnapshot({ provider: {}, positionManager: NFPM, tokenId: 42n, owner: MEMBER, poolAddress: POOL })
    expect(snap).not.toBeNull()
    expect(snap.composition).toBeNull()
    expect(snap.shares).toBeNull()
    expect(snap.earnings.source).toBe('accrued-snapshot')
  })
})

describe('readMemberPositions', () => {
  const pool = { poolId: '0xpool', token0: USDC, token1: WETH, feeTier: 3000, poolAddress: POOL, enabled: false }

  it('matchesPool compares both legs and the fee tier, case-insensitively', () => {
    const position = normalizePosition(1n, rawPosition())
    expect(matchesPool(position, pool)).toBe(true)
    expect(matchesPool(position, { ...pool, token0: pool.token0.toLowerCase() })).toBe(true)
    expect(matchesPool(position, { ...pool, feeTier: 500 })).toBe(false)
    expect(matchesPool(null, pool)).toBe(false)
  })

  it('annotates positions in curated pools — including RETIRED ones (FR-024)', async () => {
    m.methods = {
      balanceOf: () => Promise.resolve(1n),
      tokenOfOwnerByIndex: () => Promise.resolve(7n),
      positions: () => Promise.resolve(rawPosition()),
    }
    const result = await readMemberPositions({ provider: {}, positionManager: NFPM, owner: MEMBER, pools: [pool] })
    expect(result.complete).toBe(true)
    expect(result.positions).toHaveLength(1)
    // A retired pool still lists the member's position — hiding it would strand their money.
    expect(result.positions[0]).toMatchObject({ tokenId: 7n, poolId: '0xpool', poolEnabled: false })
  })

  it('drops positions outside the curated list without claiming an incomplete read', async () => {
    m.methods = {
      balanceOf: () => Promise.resolve(1n),
      tokenOfOwnerByIndex: () => Promise.resolve(7n),
      positions: () => Promise.resolve(rawPosition({ fee: 500n })),
    }
    const result = await readMemberPositions({ provider: {}, positionManager: NFPM, owner: MEMBER, pools: [pool] })
    expect(result.positions).toEqual([])
    expect(result.complete).toBe(true)
  })

  it('marks the list incomplete when one position read fails', async () => {
    m.methods = {
      balanceOf: () => Promise.resolve(2n),
      tokenOfOwnerByIndex: (_o, i) => Promise.resolve([7n, 9n][Number(i)]),
      positions: (id) => (BigInt(id) === 7n ? Promise.resolve(rawPosition()) : Promise.reject(new Error('rpc'))),
    }
    const result = await readMemberPositions({ provider: {}, positionManager: NFPM, owner: MEMBER })
    expect(result.positions).toHaveLength(1)
    expect(result.complete).toBe(false)
  })

  it('returns null when the account cannot be enumerated at all', async () => {
    m.methods = { balanceOf: () => Promise.reject(new Error('rpc')) }
    expect(await readMemberPositions({ provider: {}, positionManager: NFPM, owner: MEMBER })).toBeNull()
  })
})

// ---------------------------------------------------------------- exit

describe('buildExitCalls — direct to Uniswap, the router nowhere in the path', () => {
  const base = { positionManager: NFPM, tokenId: 42n, liquidity: 10n ** 18n, deadline: DEADLINE, recipient: MEMBER }

  it('decreases liquidity then collects, both to the position manager', () => {
    const { calls } = buildExitCalls(base)
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.target === NFPM)).toBe(true)
    expect(calls.every((c) => c.value === 0n)).toBe(true)

    const [decrease] = decodeCall('decreaseLiquidity', calls[0].data)
    expect(decrease.tokenId).toBe(42n)
    expect(decrease.liquidity).toBe(10n ** 18n)

    const [collect] = decodeCall('collect', calls[1].data)
    expect(collect.tokenId).toBe(42n)
    expect(collect.recipient).toBe(MEMBER)
    expect(collect.amount0Max).toBe(2n ** 128n - 1n)
  })

  it('carries no fee argument at all — a withdrawal can never be fee-gated (FR-030)', () => {
    const { calls } = buildExitCalls(base)
    // The only two selectors in an exit are Uniswap's own.
    expect(calls.map((c) => c.data.slice(0, 10))).toEqual([
      selectorOf('decreaseLiquidity'),
      selectorOf('collect'),
    ])
  })

  it('supports a partial withdrawal — the remainder stays in the position (FR-022)', () => {
    const { calls } = buildExitCalls({ ...base, liquidity: 4n * 10n ** 17n })
    const [decrease] = decodeCall('decreaseLiquidity', calls[0].data)
    expect(decrease.liquidity).toBe(4n * 10n ** 17n)
  })

  it('a zero-liquidity exit is a fees-only sweep — collect alone', () => {
    const { calls } = buildExitCalls({ ...base, liquidity: 0n })
    expect(calls).toHaveLength(1)
    expect(calls[0].data.slice(0, 10)).toBe(selectorOf('collect'))
  })

  it('refuses to build an exit that cannot land where the member expects', () => {
    expect(() => buildExitCalls({ ...base, positionManager: null })).toThrow(/positionManager/)
    expect(() => buildExitCalls({ ...base, tokenId: null })).toThrow(/tokenId/)
    expect(() => buildExitCalls({ ...base, recipient: null })).toThrow(/recipient/)
    expect(() => buildExitCalls({ ...base, deadline: 0 })).toThrow(/deadline/)
  })
})
