/**
 * LiquidityRouter read + supply-call layer (spec 067).
 *
 * The Supply area reads its on-chain control surface at runtime: which pools are curated, of
 * which kind, their per-transaction ceilings, the Uniswap position manager in use, and the
 * per-network pause flag (FR-051). When the router is undeployed or unreadable this returns
 * `null` and the caller shows an honest unavailable state — availability is withheld, never
 * invented (FR-054). Same shape and same null-on-failure contract as
 * `lib/bridge/bridgeRouter.js` and `lib/staking/stakingRouter.js`, deliberately.
 *
 * ---------------------------------------------------------------------------
 * THE TWO POOL KINDS ARE NOT SYMMETRIC. Read this before wiring any UI.
 *
 *   TRADING_LP (Uniswap V3) — routed through this contract, and fee-charged. The position
 *     NFT is minted straight to the member.
 *
 *   BRIDGE_LP (Across HubPool) — NOT routed through this contract, and FEE-FREE. Across's
 *     `addLiquidity` has no recipient parameter, so a fee-taking wrapper would own the LP
 *     tokens and the member could never exit (research R3). Those deposits are a DIRECT
 *     member call; see `lib/liquidity/acrossLpPositions.js`.
 *
 * So `buildSupplyCalls` REFUSES a bridge pool rather than producing calldata that reverts,
 * and `chargesPlatformFee(pool)` is false for one. A bridge pool must show NO fee line at
 * all — not a line reading 0.00, which would imply a lever that does not exist.
 *
 * Bridge liquidity is also ETHEREUM-ONLY (the Across HubPool is an L1 contract by design)
 * while trading liquidity is on all five mainnets. That asymmetry is a property of the
 * curated pool list, so it needs no special-casing here — but copy must state it plainly
 * rather than implying every network offers both kinds (research R8).
 * ---------------------------------------------------------------------------
 *
 * THE FEE IS CHARGED ON CAPITAL ACTUALLY DEPLOYED, NOT ON WHAT THE MEMBER OFFERS. Uniswap
 * consumes only what the current price ratio needs and refunds the rest, so `_supply` quotes
 * the fee AFTER the mint against the CONSUMED amounts. This module therefore exposes
 * `maxSupplyFee` — an explicit UPPER BOUND — and deliberately exposes no function that
 * computes "the fee" from a desired amount, because no such number exists before the mint.
 * A confirm screen discloses the RATE, says the fee applies to whatever is actually supplied,
 * and says the remainder comes back whole (FR-028).
 *
 * The quoted bps is passed straight back as `maxFeeBps` on submit, so a live rate above it
 * reverts rather than overcharging. Never synthesise a `maxFeeBps` here.
 *
 * ---------------------------------------------------------------------------
 * CHAIN IDS. Bitcoin network ids are STRINGS (spec 061) and are out of scope for both
 * surfaces (FR-006), so every entry point runs the shared `assertEvmChainId` FIRST — the
 * same guard the bridge client uses, imported rather than re-rolled, so there is one
 * definition of "an EVM chain id" across spec 067. It throws rather than returning null on
 * purpose: `null` is this module's honest "unavailable" answer for a RUNTIME failure, and a
 * Bitcoin id arriving here is a caller bug, not a runtime failure.
 * ---------------------------------------------------------------------------
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, zeroAddress } from 'viem'
import { readContract, normalizeAbi } from '../chains/readContract'
import { LIQUIDITY_ROUTER_ABI } from '../../abis/LiquidityRouter'
import { getContractAddressForChain } from '../../config/contracts'
import { splitFee } from '../fees/feeQuote'
import { PIN_MODE, createPin, filterByPin, revalidateSelection, samePair } from '../assets/networkPin'
import { assertEvmChainId } from '../bridge/bridgeRouter'

const ROUTER_ABI = normalizeAbi(LIQUIDITY_ROUTER_ABI)
const ERC20_APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * `ILiquidityRouter.PoolKind`. `UNLISTED` is 0 on purpose: `getPool` on an unknown id does
 * NOT revert — Solidity returns the default-initialised struct — so a missing pool must be
 * distinguishable from a real one, and reserving 0 means it can never be mistaken for a
 * bridge pool.
 */
export const POOL_KIND = Object.freeze({
  UNLISTED: 0,
  BRIDGE_LP: 1,
  TRADING_LP: 2,
})

/** Resolve the router address for a chain, or null when it isn't deployed. */
export function getLiquidityRouterAddress(chainId) {
  assertEvmChainId(chainId, 'getLiquidityRouterAddress')
  const addr = getContractAddressForChain('liquidityRouter', chainId)
  return addr && ADDRESS_RE.test(addr) ? addr : null
}

const safe = (p) => p.then((v) => v).catch(() => undefined)

/**
 * Pool id, computed exactly as the contract does:
 *
 *   keccak256(abi.encode(kind, poolAddress, token0, token1))
 *
 * `kind` LEADS and is part of the identity — the interface changed during security review,
 * and an id computed without it addresses nothing on-chain. Any change to the field list or
 * order here must be mirrored in `contracts/liquidity/LiquidityRouter.sol#computePoolId`.
 *
 * Unlike the bridge's route id, this one carries no chain id: a pool id identifies a pool
 * ON its own network's router, and the routers are per-network.
 *
 * @param {{kind: number, poolAddress: string, token0: string, token1?: string}} args
 * @returns {string} bytes32 hex
 */
export function computePoolId({ kind, poolAddress, token0, token1 = zeroAddress }) {
  if (kind !== POOL_KIND.BRIDGE_LP && kind !== POOL_KIND.TRADING_LP) {
    throw new Error(`computePoolId: kind must be BRIDGE_LP or TRADING_LP, received ${JSON.stringify(kind)}`)
  }
  // A trading pool with a defaulted token1 would hash to an id the router has never listed,
  // and the caller would read back "not curated" for a pool that is. Fail on the mistake.
  if (kind === POOL_KIND.TRADING_LP && (!token1 || token1 === zeroAddress)) {
    throw new Error('computePoolId: a trading pool has two legs — token1 is required')
  }
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'address' }],
      [Number(kind), poolAddress, token0, token1 || zeroAddress],
    ),
  )
}

/**
 * Normalize a raw `PoolListing` tuple into plain JS, or null when the listing does not exist.
 *
 * `kind === UNLISTED` is the ONLY signal that a pool is not listed, because `getPool` returns
 * a zero-filled struct for unknown ids rather than reverting. Treating that struct as a real
 * pool would offer the member a pool at address(0) with an uncapped deposit limit.
 *
 * `enabled: false` is NOT absence — it is RETIREMENT. A retired pool is returned like any
 * other and stays visible and withdrawable; only NEW deposits are closed (FR-024). Hiding a
 * pool while a member's money is inside it is exactly what the requirement forbids.
 *
 * @param {string} poolId
 * @param {*} raw ethers Result for the PoolListing tuple
 * @returns {null | {poolId: string, kind: number, enabled: boolean, feeTier: number, token0: string, token1: string, poolAddress: string, maxDeposit0PerTx: bigint, maxDeposit1PerTx: bigint, isTradingLp: boolean, isBridgeLp: boolean}}
 */
export function normalizePool(poolId, raw) {
  if (!raw) return null
  const kind = Number(raw.kind)
  if (kind !== POOL_KIND.BRIDGE_LP && kind !== POOL_KIND.TRADING_LP) return null
  return {
    poolId,
    kind,
    enabled: Boolean(raw.enabled),
    feeTier: Number(raw.feeTier),
    token0: raw.token0,
    // A bridge pool has exactly one asset; the contract stores address(0) for the second leg.
    token1: raw.token1,
    poolAddress: raw.poolAddress,
    maxDeposit0PerTx: BigInt(raw.maxDeposit0PerTx),
    maxDeposit1PerTx: BigInt(raw.maxDeposit1PerTx),
    isTradingLp: kind === POOL_KIND.TRADING_LP,
    isBridgeLp: kind === POOL_KIND.BRIDGE_LP,
  }
}

/**
 * Read the router's managed config for a chain: the Uniswap position manager + FeeRouter it
 * points at, its own fee ceiling, the pause flag, and every curated pool of BOTH kinds.
 *
 * Returns `null` when no router is deployed OR when the load-bearing `paused()` read fails —
 * an unreadable router means supplying is unavailable on this network, and the caller says so
 * (FR-051/FR-053). One missing optional getter never blanks the whole overlay; a pool whose
 * `getPool` read fails is dropped rather than guessed, and `poolsComplete` reports whether
 * the list is whole so a caller never presents a partial list as the full curated set.
 *
 * `positionManager` may legitimately be the zero address: a network can curate bridge pools
 * without having Uniswap wired up. That is not a failure — it means trading pools are not
 * mintable there, and `mintFullRangeWithFee` would revert `PositionManagerUnset`.
 *
 * @param {{chainId: number, provider: *}} args
 * @returns {Promise<null | {routerAddress: string, feeRouter: *, positionManager: *, sanctionsGuard: *, liquidityDepositServiceId: *, maxFeeBps: number|null, paused: boolean, pools: Array, poolsComplete: boolean}>}
 */
export async function readLiquidityRouterConfig({ chainId, provider }) {
  assertEvmChainId(chainId, 'readLiquidityRouterConfig')
  const routerAddress = getLiquidityRouterAddress(chainId)
  if (!routerAddress || !provider) return null

  // Spec 110 Phase 1: reads go through the chain seam; `provider` stays the caller-side
  // availability gate (null means "do not read") until callers convert.
  const routerRead = (functionName, args) =>
    readContract(chainId, { address: routerAddress, abi: ROUTER_ABI, functionName, args })
  // `paused` is the load-bearing read — if even it fails, treat the router as unreadable and
  // withhold availability (never guess that supplying is open).
  const paused = await safe(routerRead('paused'))
  if (paused === undefined) return null

  const [feeRouter, positionManager, sanctionsGuard, liquidityDepositServiceId, maxFeeBps, count] =
    await Promise.all([
      safe(routerRead('feeRouter')),
      safe(routerRead('positionManager')),
      safe(routerRead('sanctionsGuard')),
      safe(routerRead('liquidityDepositServiceId')),
      safe(routerRead('MAX_FEE_BPS')),
      safe(routerRead('poolCount')),
    ])

  const pools = []
  let poolsComplete = count !== undefined
  if (count !== undefined) {
    const n = Number(count)
    const ids = await Promise.all(Array.from({ length: n }, (_, i) => safe(routerRead('poolAt', [BigInt(i)]))))
    const raws = await Promise.all(ids.map((id) => (id ? safe(routerRead('getPool', [id])) : Promise.resolve(undefined))))
    for (let i = 0; i < n; i += 1) {
      const id = ids[i]
      const raw = raws[i]
      if (!id || raw === undefined) {
        poolsComplete = false
        continue
      }
      const pool = normalizePool(id, raw)
      if (pool) pools.push(pool)
      // An `Unlisted` struct at an enumerated id is not an incomplete read — the id is simply
      // no longer a pool — so it does not clear `poolsComplete`.
    }
  }

  return {
    routerAddress,
    feeRouter,
    positionManager,
    sanctionsGuard,
    liquidityDepositServiceId,
    maxFeeBps: maxFeeBps === undefined ? null : Number(maxFeeBps),
    paused: Boolean(paused),
    pools,
    poolsComplete,
  }
}

/**
 * Read one pool directly by its (kind, poolAddress, token0, token1) identity.
 *
 * Used to re-read a pool at submit time, so a pool retired or re-limited between the quote
 * and the signature is caught before the member signs. Returns `null` for both "is not
 * curated" (zero-filled struct) and "could not read" — the caller's honest answer is the same
 * in both cases: this pool is not on offer right now.
 *
 * @param {{chainId: number, provider: *, kind: number, poolAddress: string, token0: string, token1?: string}} args
 * @returns {Promise<null | object>} normalized pool
 */
export async function readLiquidityPool({ chainId, provider, kind, poolAddress, token0, token1 }) {
  assertEvmChainId(chainId, 'readLiquidityPool')
  const routerAddress = getLiquidityRouterAddress(chainId)
  if (!routerAddress || !provider) return null

  const poolId = computePoolId({ kind, poolAddress, token0, token1 })
  const raw = await safe(
    readContract(chainId, { address: routerAddress, abi: ROUTER_ABI, functionName: 'getPool', args: [poolId] }),
  )
  if (raw === undefined) return null
  return normalizePool(poolId, raw)
}

/**
 * Find an already-read pool in a config's list. Pure — no RPC — so a selector can filter one
 * `readLiquidityRouterConfig` snapshot.
 *
 * Matches on the full identity (kind, pool address, both legs); addresses are compared
 * case-insensitively because checksum casing varies by source. `kind` is part of the match
 * for the same reason it is part of the id: a bridge pool and a trading pool are different
 * products with different fee treatment and different deposit paths.
 *
 * @param {Array} pools
 * @param {{kind: number, poolAddress: string, token0: string, token1?: string}} match
 * @returns {object|null}
 */
export function findPool(pools, { kind, poolAddress, token0, token1 }) {
  if (!Array.isArray(pools)) return null
  const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase()
  const wantToken1 = token1 || zeroAddress
  return (
    pools.find(
      (p) =>
        Number(p.kind) === Number(kind) &&
        eq(p.poolAddress, poolAddress) &&
        eq(p.token0, token0) &&
        eq(p.token1, wantToken1),
    ) || null
  )
}

/**
 * Whether a FairWins platform fee applies to supplying to this pool.
 *
 * TRUE for trading pools only. A bridge pool is fee-free because the fee CANNOT be charged
 * there without taking custody (research R3) — so a bridge pool's confirm screen shows NO fee
 * line at all. Rendering a "0.00" line for one would imply a rate an operator could raise,
 * and no such control exists.
 */
export function chargesPlatformFee(pool) {
  return Boolean(pool && Number(pool.kind) === POOL_KIND.TRADING_LP)
}

/**
 * The MOST the platform fee can be on one leg, in that token's own units.
 *
 * An UPPER BOUND, not a prediction — and the only honest scalar available before the mint.
 * The contract charges `bps` on the amount Uniswap ACTUALLY consumed, which is at most the
 * amount offered, so this is a true ceiling; the member is charged less whenever the pool's
 * current ratio consumes less than they offered, and the unconsumed remainder is refunded
 * whole. Disclose it as "at most", never as "the fee" (FR-028) — `liquidityCopy.feeCeilingCopy`
 * is the matching wording.
 */
export function maxSupplyFee({ amountDesired, bps }) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error('maxSupplyFee: bps must be the quoted rate in basis points')
  }
  return splitFee(amountDesired ?? 0n, bps).feeAmount
}

/** Default slippage tolerance for a supply, in basis points (0.50%). */
export const DEFAULT_SUPPLY_SLIPPAGE_BPS = 50

/**
 * The minimum of each leg the member will accept the position to consume, given the amounts they
 * offered and the tolerance they were shown.
 *
 * Computed against the NET amount — what remains after the platform fee — because the fee is taken
 * before the mint. A bound derived from the gross would exceed what the position manager can
 * possibly consume and revert every supply the moment a non-zero fee rate goes live.
 *
 * A full-range mint consumes at the pool's current ratio, so one leg is normally consumed in full
 * and the other only partially; the bound is deliberately a floor on BOTH, which is what makes a
 * sandwich unprofitable rather than an attempt to predict the split.
 *
 * @returns {{amount0Min: bigint, amount1Min: bigint}}
 */
export function supplyMinimums({ amount0Desired, amount1Desired, bps, slippageBps = DEFAULT_SUPPLY_SLIPPAGE_BPS }) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new Error('supplyMinimums: slippageBps must be a tolerance in basis points')
  }
  const floor = (gross) => {
    const net = splitFee(gross ?? 0n, bps).netAmount
    // Zero legs stay zero: a leg the member is not supplying has no minimum to enforce.
    if (net === 0n) return 0n
    return (net * BigInt(10_000 - slippageBps)) / 10_000n
  }
  return { amount0Min: floor(amount0Desired), amount1Min: floor(amount1Desired) }
}

/**
 * Which per-transaction ceiling an amount pair would breach, or null when it fits.
 *
 * TWO ceilings, checked independently, because a pair's legs routinely differ in decimals —
 * 1e6 is one USDC but a millionth of a millionth of a WETH, so a single scalar compared
 * against both would be meaningless. `0` means uncapped, matching the contract.
 *
 * @returns {null | {leg: 0|1, amount: bigint, max: bigint}}
 */
export function poolLimitViolation(pool, { amount0 = 0n, amount1 = 0n } = {}) {
  if (!pool) return null
  const a0 = BigInt(amount0)
  const a1 = BigInt(amount1)
  const max0 = BigInt(pool.maxDeposit0PerTx ?? 0n)
  const max1 = BigInt(pool.maxDeposit1PerTx ?? 0n)
  if (max0 !== 0n && a0 > max0) return { leg: 0, amount: a0, max: max0 }
  if (max1 !== 0n && a1 > max1) return { leg: 1, amount: a1, max: max1 }
  return null
}

/**
 * Build the `mintFullRangeWithFee` call(s) for the unified send rail.
 *
 * Approves the router for the GROSS amounts (the contract pulls the gross, mints, charges the
 * fee on what was consumed, then refunds the rest), then calls the router. Legs with a zero
 * amount get no approve leg — the contract does not pull them.
 *
 * `maxFeeBps` MUST be the rate the member was shown on the quote (FR-028). It is a required
 * argument with no default precisely so a caller cannot omit it and silently consent to any
 * rate. The router additionally enforces its own immutable `MAX_FEE_BPS` on-chain, whatever
 * the FeeRouter reports.
 *
 * `amount0Min` / `amount1Min` are REQUIRED for exactly the same reason, and were not always.
 * They become Uniswap's `MintParams.amount0Min`/`amount1Min`, where `LiquidityManagement` enforces
 * `require(amount0 >= amount0Min && amount1 >= amount1Min, 'Price slippage check')`. They used to
 * default to `0n`, and the only production caller never passed them — so every member position was
 * minted with that check switched off, leaving the deposit open to being sandwiched at a
 * manipulated price. The router cannot fix this for us: forwarding a caller-supplied minimum
 * verbatim is what Uniswap's own periphery does, and a bound hardcoded in the contract would be
 * wrong. So the defaults are gone and omitting them is now an error, not a silent zero.
 *
 * They must be computed against the NET (post-fee) amounts, since the fee is taken before the mint
 * and a bound derived from the gross would revert every supply the day a non-zero rate goes live.
 *
 * Refuses — rather than producing calldata guaranteed to revert — for a bridge pool (wrong
 * path entirely: research R3), a retired pool, both amounts zero, and an amount over either
 * per-transaction ceiling.
 *
 * @param {{routerAddress: string, pool: object, amount0Desired: bigint, amount1Desired: bigint, amount0Min?: bigint, amount1Min?: bigint, deadline: number|bigint, maxFeeBps: number}} args
 * @returns {{calls: Array<{target: string, data: string, value: bigint}>, requiresApproval: boolean}}
 */
export function buildSupplyCalls({
  routerAddress,
  pool,
  amount0Desired,
  amount1Desired,
  amount0Min,
  amount1Min,
  deadline,
  maxFeeBps,
}) {
  if (!routerAddress) throw new Error('buildSupplyCalls: routerAddress is required')
  // No defaults: a missing bound is a caller bug, and silently minting at any price is the failure
  // it used to cause. `0n` remains expressible, but only by asking for it in so many words.
  if (typeof amount0Min !== 'bigint' || typeof amount1Min !== 'bigint') {
    throw new Error(
      'buildSupplyCalls: amount0Min and amount1Min are required (bigint) — they are the slippage bound Uniswap enforces, and omitting them mints the position at any price',
    )
  }
  if (!pool?.poolId) throw new Error('buildSupplyCalls: a pool read from the router is required')
  if (Number(pool.kind) === POOL_KIND.BRIDGE_LP) {
    throw new Error(
      'buildSupplyCalls: bridge-liquidity deposits do not go through the router — they are a direct, fee-free member call to the Across HubPool (research R3)',
    )
  }
  if (Number(pool.kind) !== POOL_KIND.TRADING_LP) throw new Error('buildSupplyCalls: pool is not a trading pool')
  // A retired pool reverts on-chain (`PoolRetired`). Refusing to build the calldata keeps the
  // member from signing a transaction that cannot succeed — retired pools are still visible
  // and still withdrawable, they just take no new deposits (FR-024).
  if (!pool.enabled) throw new Error('buildSupplyCalls: pool is retired and takes no new deposits')

  const a0 = BigInt(amount0Desired ?? 0n)
  const a1 = BigInt(amount1Desired ?? 0n)
  if (a0 === 0n && a1 === 0n) throw new Error('buildSupplyCalls: at least one leg must be non-zero')

  const violation = poolLimitViolation(pool, { amount0: a0, amount1: a1 })
  if (violation) {
    throw new Error(
      `buildSupplyCalls: token${violation.leg} amount ${violation.amount} is above this pool's per-transaction limit ${violation.max}`,
    )
  }

  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > 10_000) {
    throw new Error('buildSupplyCalls: maxFeeBps must be the quoted rate in basis points (FR-028)')
  }
  const dl = BigInt(deadline ?? 0n)
  if (dl <= 0n) throw new Error('buildSupplyCalls: deadline must be a future unix timestamp')

  const calls = []
  if (a0 > 0n) {
    calls.push({
      target: pool.token0,
      data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [routerAddress, a0] }),
      value: 0n,
    })
  }
  if (a1 > 0n) {
    calls.push({
      target: pool.token1,
      data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [routerAddress, a1] }),
      value: 0n,
    })
  }
  calls.push({
    target: routerAddress,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'mintFullRangeWithFee',
      args: [pool.poolId, a0, a1, BigInt(amount0Min ?? 0n), BigInt(amount1Min ?? 0n), dl, BigInt(maxFeeBps)],
    }),
    // The router is ERC-20 only — a native leg is wrapped before it gets here.
    value: 0n,
  })

  return { calls, requiresApproval: calls.length > 1 }
}

// ---------------------------------------------------------------------------
// Protocol events (T112, FR-037) — telling a member when the ground moves under
// money they have already supplied.
//
// A supplied position is long-lived and passive: the member does nothing for weeks, so the only
// way they learn that a curator retired their pool, delisted it, or paused supplying is if the app
// tells them. These two functions are the whole emitter — a pure snapshot and a pure diff — so the
// polling source that calls them holds no logic of its own and there is exactly one definition of
// "something happened to your pool".
//
// The rules that keep this honest:
//
//   1. **First sight is a baseline.** No prior snapshot means no events. A member who opens the app
//      for the first time in a month is not told that a pool "just closed" because this build has
//      only just looked at it.
//   2. **Only pools the member has actually supplied.** A curated list changing is operator news,
//      not member news. What earns an interruption is a change to a pool their money is in.
//   3. **An incomplete read is never a delisting.** `readLiquidityRouterConfig` reports
//      `poolsComplete: false` when any `getPool` failed; a pool missing from a partial list has not
//      been proven gone, so no event is emitted. Silence over a false alarm about their money.
//   4. **Nothing here claims a position is at risk.** Retiring and delisting close NEW deposits;
//      withdrawal never routed through this contract in the first place. The copy says exactly that
//      rather than implying funds are trapped.
// ---------------------------------------------------------------------------

/** The member-facing protocol events this module emits (FR-037). */
export const LIQUIDITY_EVENT = Object.freeze({
  /** A pool the member supplied stopped taking new deposits (FR-024). */
  POOL_CLOSED: 'liquidity-pool-closed',
  /** A protocol event changed the ground under a position they already hold. */
  POSITION_AFFECTED: 'liquidity-position-affected',
})

/** Why a `POSITION_AFFECTED` event fired — kept machine-readable so a surface can group them. */
export const LIQUIDITY_EVENT_REASON = Object.freeze({
  DELISTED: 'delisted',
  SUPPLY_PAUSED: 'supply-paused',
})

/**
 * Reduce a `readLiquidityRouterConfig` result to the small, comparable shape the diff below needs.
 *
 * Returns null for a null config — an unreadable router is NOT a snapshot of "nothing is listed",
 * and recording it as one would make the next successful read look like a mass relisting. The
 * caller keeps its prior snapshot instead (FR-051/FR-054).
 *
 * @param {object|null} config
 * @returns {null | {paused: boolean, poolsComplete: boolean, pools: Record<string, {enabled: boolean, kind: number}>}}
 */
export function snapshotLiquidityProtocolState(config) {
  if (!config) return null
  const pools = {}
  for (const pool of config.pools || []) {
    if (!pool?.poolId) continue
    pools[pool.poolId] = { enabled: Boolean(pool.enabled), kind: Number(pool.kind) }
  }
  return { paused: Boolean(config.paused), poolsComplete: config.poolsComplete !== false, pools }
}

/**
 * Diff two snapshots into the events a member with money in these pools is owed. Pure: no clock,
 * no network, no writes.
 *
 * @param {object} args
 * @param {object|null} args.prior previous snapshot (null on first sight → no events)
 * @param {object|null} args.next current snapshot (null when the router could not be read → no events)
 * @param {string[]} [args.heldPoolIds] pool ids the member has supplied — the scope of every event
 * @param {(poolId: string) => string} [args.labelFor] display label for a pool id
 * @param {string} [args.networkName] name of the network, for the pause message
 * @returns {Array<{type: string, reason: string, poolId: string|null, message: string, severity: string, actionable: boolean}>}
 */
export function detectLiquidityProtocolEvents({ prior, next, heldPoolIds = [], labelFor, networkName } = {}) {
  // No baseline, or nothing new to compare it against: say nothing.
  if (!prior || !next) return []

  const held = new Set((heldPoolIds || []).filter(Boolean))
  if (held.size === 0) return []

  const label = (poolId) => {
    const value = typeof labelFor === 'function' ? labelFor(poolId) : null
    return value || 'A pool you supplied'
  }
  const where = networkName ? ` on ${networkName}` : ''
  const events = []

  for (const poolId of held) {
    const before = prior.pools?.[poolId]
    const after = next.pools?.[poolId]
    if (!before) continue // first sight of this pool — baseline, not news

    if (!after) {
      // Absent from a COMPLETE list = actually delisted. Absent from a partial one proves nothing.
      if (prior.poolsComplete && next.poolsComplete) {
        events.push({
          type: LIQUIDITY_EVENT.POSITION_AFFECTED,
          reason: LIQUIDITY_EVENT_REASON.DELISTED,
          poolId,
          message: `${label(poolId)} is no longer listed on FairWins. Your position is unaffected and is still yours — withdrawing never went through FairWins. Open Supply to check it.`,
          severity: 'warning',
          actionable: true,
        })
      }
      continue
    }

    if (before.enabled === true && after.enabled === false) {
      events.push({
        type: LIQUIDITY_EVENT.POOL_CLOSED,
        reason: LIQUIDITY_EVENT.POOL_CLOSED,
        poolId,
        message: `${label(poolId)} is closed to new deposits. Nothing has changed for what you already supplied: your share stays there, keeps earning, and can be withdrawn at any time.`,
        severity: 'info',
        actionable: false,
      })
    }
  }

  // Network-wide: supplying paused while the member holds a position. Told once, on the change.
  if (prior.paused === false && next.paused === true) {
    events.push({
      type: LIQUIDITY_EVENT.POSITION_AFFECTED,
      reason: LIQUIDITY_EVENT_REASON.SUPPLY_PAUSED,
      poolId: null,
      message: `New pool deposits are paused${where}. What you already supplied is unaffected — it keeps earning and you can still withdraw it. Supplying reopens without any action from you.`,
      severity: 'warning',
      actionable: false,
    })
  }

  return events
}

// ---------------------------------------------------------------------------
// Pair selection — the PAIR rule, which is the exact INVERSE of the bridge's.
// ---------------------------------------------------------------------------

/**
 * Pin the network from the FIRST asset of a liquidity pair.
 *
 * A Uniswap pair lives on ONE network, so this uses `PIN_MODE.SAME_NETWORK` /
 * `samePair` — NOT `bridgeDest`, which is the Bridge surface's rule and would offer the
 * member the same asset on OTHER networks as a counterpart. That mistake has no loud failure:
 * an impossible cross-network "pair" would assemble, price, and reach the confirm step.
 * Fixing the mode here, in the liquidity client, means no surface has to remember it.
 */
export function createLiquidityPin(option) {
  return createPin(option, PIN_MODE.SAME_NETWORK)
}

/** The assets eligible as the SECOND leg under `pin` — same network, always (FR-062). */
export function filterPairCounterparts(options, pin) {
  return filterByPin(options, pin, samePair)
}

/**
 * Re-check the second leg after the member changed the first asset: keep it when it is still
 * on the pinned network, otherwise null so the caller clears it (FR-062) rather than leaving
 * an impossible pair assembled.
 */
export function revalidatePairCounterpart(selection, pin) {
  return revalidateSelection(selection, pin, samePair)
}
