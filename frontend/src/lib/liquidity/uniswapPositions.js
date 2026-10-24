/**
 * Uniswap V3 full-range position client (spec 067).
 *
 * Everything a member needs to SEE about a trading-liquidity position, and everything they
 * need to GET OUT of one. Four jobs:
 *
 *   1. Full-range tick derivation, identical to `LiquidityRouter.fullRangeTicks` — computed
 *      locally so a member is never blocked by one RPC, and cross-checkable against the chain.
 *   2. Position discovery for an account (ERC-721 enumeration on the position manager).
 *   3. Current value, earnings accrued, and current asset composition (FR-020).
 *   4. The EXIT calls — `decreaseLiquidity` + `collect`, straight to Uniswap's position
 *      manager, with the router nowhere in the path.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE HERE IS AN ESTIMATE, SOURCED FROM THE PROTOCOL.
 *
 * A position's composition and value move with the pool price on every trade, and accrued
 * fees are read from a simulation of `collect` at the current block. So every returned
 * valuation carries `isEstimate: true` and every read that fails returns `null` — never a
 * zero, never a last-known figure, never an invented one. A member who is shown "0" when the
 * truth is "we could not read it" has been told something false about their own money
 * (FR-054, spec Assumptions).
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * THE ROUTER IS NEVER IN THE EXIT PATH — that is a load-bearing property, not an oversight.
 * The member owns the position NFT, so `decreaseLiquidity`/`collect` go directly to Uniswap's
 * `NonfungiblePositionManager`. A router pause, misconfiguration, or upgrade therefore cannot
 * block an exit (FR-021/FR-024), and no withdrawal can carry a FairWins platform fee
 * (FR-030) — there is no code path here that could charge one.
 * ---------------------------------------------------------------------------
 *
 * ADDRESSES. `positionManager` is always an explicit argument, resolved by the caller from
 * `readLiquidityRouterConfig().positionManager` (authoritative, read at runtime) with the
 * network's own `dex.positionManager` as the build-time fallback. It is NOT the same address
 * on every chain — Base's differs from the set Ethereum, Polygon, Arbitrum and Optimism share
 * — so nothing here hardcodes or infers one (research R4b, FR-016b).
 */
import { encodeFunctionData } from 'viem'
import { UNISWAP_V3_POOL_ABI } from '../../abis/UniswapV3PoolReader'
import { readContract, normalizeAbi } from '../chains/readContract'

/**
 * Uniswap V3's absolute tick bounds. Full range is these, ALIGNED DOWN to the pool's own tick
 * spacing — read from the pool rather than mapped from the fee tier, so a non-standard or
 * future tier cannot silently produce misaligned ticks.
 */
export const MIN_TICK = -887272
export const MAX_TICK = 887272

export const Q96 = 2n ** 96n
const Q192 = 2n ** 192n
const MAX_UINT128 = 2n ** 128n - 1n
const MAX_UINT256 = 2n ** 256n - 1n

/**
 * The position manager reads + exit legs this module uses. Kept local rather than added to
 * `abis/` because they are Uniswap's, not FairWins', and only this module speaks to them.
 * `collect` is declared (not just for the exit builder) because simulating it is how accrued
 * fees are read accurately — see `readUncollectedFees`.
 */
export const NFPM_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
]

const NFPM_ABI_PARSED = normalizeAbi(NFPM_ABI)

/** The pool reads: the shared spot-price surface plus the extra fields a position needs. */
const POOL_ABI = [
  ...UNISWAP_V3_POOL_ABI,
  'function tickSpacing() view returns (int24)',
  'function fee() view returns (uint24)',
  'function token1() view returns (address)',
]

const safe = (p) => p.then((v) => v).catch(() => undefined)

/**
 * `safe` for a call that can also throw SYNCHRONOUSLY while it is being built (a static call
 * with an override, an argument the interface rejects). Without this, such a throw escapes
 * past the `.catch` and turns an unreadable figure into a thrown error the caller never
 * expected — the surface would break instead of saying "unavailable".
 */
const safeCall = async (fn) => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Full-range ticks
// ---------------------------------------------------------------------------

/**
 * Full-range tick bounds for a pool's tick spacing — the JS twin of
 * `LiquidityRouter.fullRangeTicks`.
 *
 * Solidity integer division truncates TOWARD ZERO, which is ceil for the negative bound and
 * floor for the positive one — exactly the alignment Uniswap requires. `Math.trunc` has the
 * same behaviour, so the two agree bit for bit; `Math.floor` would NOT (it would push the
 * lower bound below the minimum usable tick and the mint would revert).
 *
 * @param {number} tickSpacing
 * @returns {{tickLower: number, tickUpper: number}}
 */
export function fullRangeTicks(tickSpacing) {
  const spacing = Number(tickSpacing)
  if (!Number.isInteger(spacing) || spacing <= 0) {
    throw new Error(`fullRangeTicks: tickSpacing must be a positive integer, received ${JSON.stringify(tickSpacing)}`)
  }
  return {
    tickLower: Math.trunc(MIN_TICK / spacing) * spacing,
    tickUpper: Math.trunc(MAX_TICK / spacing) * spacing,
  }
}

/** True when a position spans the full range for its pool's spacing (v1 ships these only). */
export function isFullRange({ tickLower, tickUpper }, tickSpacing) {
  const full = fullRangeTicks(tickSpacing)
  return Number(tickLower) === full.tickLower && Number(tickUpper) === full.tickUpper
}

// ---------------------------------------------------------------------------
// Tick math — a direct port of Uniswap V3's TickMath.getSqrtRatioAtTick
// ---------------------------------------------------------------------------

/** [bit, multiplier] pairs from TickMath, in ascending bit order. */
const TICK_MULTIPLIERS = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
]

/**
 * sqrt(1.0001^tick) * 2^96, exactly as Uniswap computes it on-chain.
 *
 * Ported rather than approximated with floating point: a float `Math.sqrt(1.0001 ** tick)`
 * loses precision well before the extremes, and these values feed a position's composition —
 * the number a member reads as "what's in my position".
 */
export function getSqrtRatioAtTick(tick) {
  const t = Number(tick)
  if (!Number.isInteger(t)) throw new Error(`getSqrtRatioAtTick: tick must be an integer, received ${tick}`)
  const absTick = t < 0 ? -t : t
  if (absTick > MAX_TICK) throw new Error(`getSqrtRatioAtTick: tick ${t} is outside Uniswap's usable range`)

  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n
  for (const [bit, mul] of TICK_MULTIPLIERS) {
    if ((absTick & bit) !== 0) ratio = (ratio * mul) >> 128n
  }
  if (t > 0) ratio = MAX_UINT256 / ratio
  // Round up when shifting from Q128.128 to Q64.96, matching the contract.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n)
}

// ---------------------------------------------------------------------------
// Position composition — LiquidityAmounts, ported
// ---------------------------------------------------------------------------

function sortSqrt(a, b) {
  return a > b ? [b, a] : [a, b]
}

/** token0 held by `liquidity` between two sqrt prices. */
export function getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) {
  const [lo, hi] = sortSqrt(BigInt(sqrtRatioAX96), BigInt(sqrtRatioBX96))
  const L = BigInt(liquidity)
  if (L === 0n || lo === 0n) return 0n
  return ((L << 96n) * (hi - lo)) / hi / lo
}

/** token1 held by `liquidity` between two sqrt prices. */
export function getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) {
  const [lo, hi] = sortSqrt(BigInt(sqrtRatioAX96), BigInt(sqrtRatioBX96))
  return (BigInt(liquidity) * (hi - lo)) / Q96
}

/**
 * What a position currently HOLDS, in the two tokens (FR-020 "current composition").
 *
 * A full-range position is always in range, so both legs are normally non-zero — but the
 * split moves with every trade in the pool, and at an extreme price one leg goes to zero.
 * That is the mechanism behind impermanent loss, and it is why this is an estimate that must
 * be re-read rather than a stored figure.
 *
 * @returns {{amount0: bigint, amount1: bigint, inRange: boolean, isEstimate: true}}
 */
export function positionAmounts({ liquidity, sqrtPriceX96, tickLower, tickUpper }) {
  const L = BigInt(liquidity ?? 0n)
  const P = BigInt(sqrtPriceX96 ?? 0n)
  const A = getSqrtRatioAtTick(tickLower)
  const B = getSqrtRatioAtTick(tickUpper)
  const [lo, hi] = sortSqrt(A, B)

  if (P <= lo) {
    // Price below the range: the position is entirely token0.
    return { amount0: getAmount0ForLiquidity(lo, hi, L), amount1: 0n, inRange: false, isEstimate: true }
  }
  if (P >= hi) {
    // Price above the range: entirely token1.
    return { amount0: 0n, amount1: getAmount1ForLiquidity(lo, hi, L), inRange: false, isEstimate: true }
  }
  return {
    amount0: getAmount0ForLiquidity(P, hi, L),
    amount1: getAmount1ForLiquidity(lo, P, L),
    inRange: true,
    isEstimate: true,
  }
}

/**
 * The pool's own spot price of token0 in token1, as a Number, for display only.
 *
 * Derived from the pool's `sqrtPriceX96` — the protocol's own figure, no external oracle and
 * no invented price. Returns null when it cannot be derived, so a caller shows "unavailable"
 * rather than a zero. Decimals are required because the raw ratio is in token base units.
 */
export function poolPriceFromSqrt({ sqrtPriceX96, decimals0, decimals1 }) {
  const P = BigInt(sqrtPriceX96 ?? 0n)
  if (P <= 0n) return null
  if (!Number.isInteger(decimals0) || !Number.isInteger(decimals1)) return null
  // Scale before the float conversion so precision is not lost on small prices.
  const SCALE = 10n ** 18n
  const scaled = (P * P * SCALE) / Q192
  const price = Number(scaled) / 1e18
  if (!Number.isFinite(price)) return null
  return price * 10 ** (decimals0 - decimals1)
}

/**
 * The share of the position's value in each leg, using the pool's own spot price.
 *
 * Percentages, not currency: converting to fiat would need a price source this module does not
 * have, and inventing one is exactly what FR-054 forbids. Returns null for an empty position
 * (nothing to apportion) rather than a meaningless 50/50.
 *
 * @returns {null | {share0: number, share1: number, isEstimate: true}}
 */
export function compositionShares({ amount0, amount1, sqrtPriceX96 }) {
  const a0 = BigInt(amount0 ?? 0n)
  const a1 = BigInt(amount1 ?? 0n)
  const P = BigInt(sqrtPriceX96 ?? 0n)
  if (P <= 0n) return null
  // Value both legs in token1 terms: amount0 * (sqrtP^2 / 2^192).
  const value0InToken1 = (a0 * P * P) / Q192
  const total = value0InToken1 + a1
  if (total === 0n) return null
  const share0 = Number((value0InToken1 * 10_000n) / total) / 100
  return { share0, share1: Math.round((100 - share0) * 100) / 100, isEstimate: true }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Normalize a raw `positions(tokenId)` result. Returns null when the read is absent or the
 * token has no pool identity — never a zero-filled placeholder.
 */
export function normalizePosition(tokenId, raw) {
  if (!raw) return null
  // `positions()` returns TWELVE named outputs. The read seam restores those names (see
  // `withOutputNames`), but this function is exported and can be handed a decoder's raw array
  // directly, so each field also names its position — the same belt-and-braces `?? raw[i]` the
  // rest of this file and acrossLpPositions already use. Reading only by name is what turned a
  // member's position list into an empty one.
  const token0 = raw.token0 ?? raw[2]
  const token1 = raw.token1 ?? raw[3]
  if (!token0 || !token1) return null
  const liquidity = BigInt(raw.liquidity ?? raw[7])
  const tokensOwed0 = BigInt(raw.tokensOwed0 ?? raw[10])
  const tokensOwed1 = BigInt(raw.tokensOwed1 ?? raw[11])
  return {
    tokenId: BigInt(tokenId),
    token0,
    token1,
    feeTier: Number(raw.fee ?? raw[4]),
    tickLower: Number(raw.tickLower ?? raw[5]),
    tickUpper: Number(raw.tickUpper ?? raw[6]),
    liquidity,
    tokensOwed0,
    tokensOwed1,
    // A burned-down position: nothing supplied and nothing owed. Still shown — a member's
    // history is theirs — but it is not an open position.
    isClosed: liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n,
  }
}

/**
 * Read one position by token id. Null when the read fails (honest unavailable, not "empty").
 */
export async function readPosition({ chainId, provider, positionManager, tokenId }) {
  if (!provider || !positionManager) return null
  const raw = await safe(
    readContract(chainId, { address: positionManager, abi: NFPM_ABI, functionName: 'positions', args: [BigInt(tokenId)] }),
  )
  if (raw === undefined) return null
  return normalizePosition(tokenId, raw)
}

/**
 * Enumerate the position NFTs an account owns (ERC-721 enumerable, on-chain — no indexer).
 *
 * Returns null when the balance read fails: we do not know whether the member has positions,
 * so we say we do not know. `complete` distinguishes "this is all of them" from "some ids
 * could not be read", so a caller never presents a partial list as a full one — a member
 * looking for a position that exists but did not load must be told the list is incomplete.
 *
 * @returns {Promise<null | {tokenIds: bigint[], complete: boolean}>}
 */
export async function listPositionTokenIds({ chainId, provider, positionManager, owner }) {
  if (!provider || !positionManager || !owner) return null
  const nfpmRead = (functionName, args) =>
    readContract(chainId, { address: positionManager, abi: NFPM_ABI, functionName, args })
  const balance = await safe(nfpmRead('balanceOf', [owner]))
  if (balance === undefined) return null

  const n = Number(balance)
  const raw = await Promise.all(Array.from({ length: n }, (_, i) => safe(nfpmRead('tokenOfOwnerByIndex', [owner, BigInt(i)]))))
  const tokenIds = []
  let complete = true
  for (const id of raw) {
    if (id === undefined) {
      complete = false
      continue
    }
    tokenIds.push(BigInt(id))
  }
  return { tokenIds, complete }
}

/** True when a position is in the given curated pool (same legs, same fee tier). */
export function matchesPool(position, pool) {
  if (!position || !pool) return false
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()
  return (
    eq(position.token0, pool.token0) && eq(position.token1, pool.token1) && Number(position.feeTier) === Number(pool.feeTier)
  )
}

/**
 * Read the pool state a valuation needs. `slot0` is load-bearing — without the current price
 * there is no composition to show — so a failed `slot0` returns null. The rest are optional
 * and come back undefined rather than blanking the read.
 */
export async function readPoolState({ chainId, provider, poolAddress }) {
  if (!provider || !poolAddress) return null
  const poolRead = (functionName) =>
    readContract(chainId, { address: poolAddress, abi: POOL_ABI, functionName })
  const slot0 = await safe(poolRead('slot0'))
  if (slot0 === undefined) return null
  const [tickSpacing, fee] = await Promise.all([safe(poolRead('tickSpacing')), safe(poolRead('fee'))])
  return {
    sqrtPriceX96: BigInt(slot0.sqrtPriceX96 ?? slot0[0]),
    tick: Number(slot0.tick ?? slot0[1]),
    tickSpacing: tickSpacing === undefined ? null : Number(tickSpacing),
    feeTier: fee === undefined ? null : Number(fee),
  }
}

/**
 * Earnings accrued to date, in both tokens.
 *
 * PREFERRED source is a SIMULATION of `collect` from the owner's address: that is what Uniswap
 * would actually pay out right now, fees included, and it is the only way to see fees earned
 * since the position was last touched. `positions().tokensOwed*` is a SNAPSHOT that only
 * updates when the position is poked, so it under-reports — it is the fallback, and it says so
 * in `source` rather than passing itself off as the live figure.
 *
 * Returns null when neither can be read: the member is told the figure is unavailable, not
 * that they have earned nothing.
 *
 * @returns {Promise<null | {amount0: bigint, amount1: bigint, source: 'simulated'|'accrued-snapshot', isEstimate: true}>}
 */
export async function readUncollectedFees({ chainId, provider, positionManager, tokenId, owner, position }) {
  if (!provider || !positionManager) return null

  if (owner) {
    // ethers' `collect.staticCall(..., { from: owner })` — an eth_call from the owner, which is
    // the only address the simulation pays out for. The seam's `account` carries the same from.
    const simulated = await safeCall(() =>
      readContract(chainId, {
        address: positionManager,
        abi: NFPM_ABI,
        functionName: 'collect',
        args: [{ tokenId: BigInt(tokenId), recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        account: owner,
      }),
    )
    if (simulated !== undefined) {
      return {
        amount0: BigInt(simulated.amount0 ?? simulated[0]),
        amount1: BigInt(simulated.amount1 ?? simulated[1]),
        source: 'simulated',
        isEstimate: true,
      }
    }
  }

  const snapshot = position ?? (await readPosition({ chainId, provider, positionManager, tokenId }))
  if (!snapshot) return null
  return {
    amount0: snapshot.tokensOwed0,
    amount1: snapshot.tokensOwed1,
    source: 'accrued-snapshot',
    isEstimate: true,
  }
}

/**
 * One position, valued: what it holds now, what it has earned, and how it is split.
 *
 * Returns null when the position itself cannot be read. When the POOL cannot be read, the
 * position is still returned with `composition: null` and `shares: null` — the member keeps
 * seeing that the position exists (and can still exit it) while the figures honestly read as
 * unavailable. Hiding the position because a price read failed would be the worse lie.
 *
 * @returns {Promise<null | object>}
 */
export async function readPositionSnapshot({ chainId, provider, positionManager, tokenId, owner, poolAddress }) {
  const position = await readPosition({ chainId, provider, positionManager, tokenId })
  if (!position) return null

  const [poolState, earnings] = await Promise.all([
    poolAddress ? readPoolState({ chainId, provider, poolAddress }) : Promise.resolve(null),
    readUncollectedFees({ chainId, provider, positionManager, tokenId, owner, position }),
  ])

  const composition = poolState
    ? positionAmounts({
        liquidity: position.liquidity,
        sqrtPriceX96: poolState.sqrtPriceX96,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
      })
    : null

  return {
    ...position,
    poolAddress: poolAddress ?? null,
    poolState,
    composition,
    shares: composition
      ? compositionShares({
          amount0: composition.amount0,
          amount1: composition.amount1,
          sqrtPriceX96: poolState.sqrtPriceX96,
        })
      : null,
    earnings,
    // Every figure above moves with the market and is read from the protocol, never promised.
    isEstimate: true,
  }
}

/**
 * Every position an account holds, optionally narrowed to a curated pool list.
 *
 * `complete` propagates from the enumeration AND from per-position read failures, so a caller
 * can say "this may not be all of them" instead of implying a short list is the whole truth.
 *
 * @returns {Promise<null | {positions: Array, complete: boolean}>}
 */
export async function readMemberPositions({ chainId, provider, positionManager, owner, pools }) {
  const listed = await listPositionTokenIds({ chainId, provider, positionManager, owner })
  if (!listed) return null

  let complete = listed.complete
  const positions = []
  const raw = await Promise.all(
    listed.tokenIds.map((tokenId) => readPosition({ chainId, provider, positionManager, tokenId })),
  )
  for (const position of raw) {
    if (!position) {
      complete = false
      continue
    }
    // `pools` is the curated list from the router. Positions outside it are the member's own
    // (opened elsewhere) — filtered out of the Supply area, never deleted or hidden on-chain.
    if (Array.isArray(pools)) {
      const pool = pools.find((p) => matchesPool(position, p))
      if (!pool) continue
      positions.push({ ...position, poolId: pool.poolId, poolAddress: pool.poolAddress, poolEnabled: pool.enabled })
      continue
    }
    positions.push(position)
  }
  return { positions, complete }
}

// ---------------------------------------------------------------------------
// Exit — direct to Uniswap, never through the router
// ---------------------------------------------------------------------------

/**
 * Build the exit calls for a position: `decreaseLiquidity` (turns liquidity back into tokens,
 * credited to the position) then `collect` (sweeps those tokens PLUS accrued fees to the
 * member).
 *
 * Both target Uniswap's position manager DIRECTLY. `LiquidityRouter` is deliberately absent:
 * the member owns the NFT, so no FairWins state — pause, retirement, misconfiguration, or a
 * pending upgrade — can stand between them and their money (FR-021/FR-024), and there is no
 * path on which a platform fee could be charged on a withdrawal (FR-030).
 *
 * A retired pool exits by exactly this path, unchanged. Passing a partial `liquidity` is a
 * partial withdrawal; the remainder stays in the position (FR-022).
 *
 * @param {{positionManager: string, tokenId: bigint|number, liquidity: bigint, amount0Min?: bigint, amount1Min?: bigint, deadline: number|bigint, recipient: string}} args
 * @returns {{calls: Array<{target: string, data: string, value: bigint}>}}
 */
export function buildExitCalls({
  positionManager,
  tokenId,
  liquidity,
  amount0Min = 0n,
  amount1Min = 0n,
  deadline,
  recipient,
}) {
  if (!positionManager) throw new Error('buildExitCalls: positionManager is required')
  if (tokenId === undefined || tokenId === null) throw new Error('buildExitCalls: tokenId is required')
  if (!recipient) throw new Error('buildExitCalls: recipient is required — the member receives the tokens')
  const dl = BigInt(deadline ?? 0n)
  if (dl <= 0n) throw new Error('buildExitCalls: deadline must be a future unix timestamp')

  const id = BigInt(tokenId)
  const L = BigInt(liquidity ?? 0n)
  const calls = []

  // Liquidity 0 is legitimate: a fees-only sweep on a position already fully withdrawn.
  if (L > 0n) {
    calls.push({
      target: positionManager,
      data: encodeFunctionData({
        abi: NFPM_ABI_PARSED,
        functionName: 'decreaseLiquidity',
        args: [{ tokenId: id, liquidity: L, amount0Min: BigInt(amount0Min ?? 0n), amount1Min: BigInt(amount1Min ?? 0n), deadline: dl }],
      }),
      value: 0n,
    })
  }

  calls.push({
    target: positionManager,
    data: encodeFunctionData({
      abi: NFPM_ABI_PARSED,
      functionName: 'collect',
      args: [{ tokenId: id, recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    }),
    value: 0n,
  })

  return { calls }
}
