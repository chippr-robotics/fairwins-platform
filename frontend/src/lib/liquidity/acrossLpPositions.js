/**
 * Across bridge-liquidity client (spec 067, T090).
 *
 * Everything a member needs to supply to, read, and exit an Across **bridge pool** — the
 * single-asset pot the bridge lends out to pay people instantly on other networks.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTER IS NEVER IN THIS PATH. That is a ruling, not an omission.
 *
 * `HubPool.addLiquidity(address l1Token, uint256 l1TokenAmount)` has **no recipient
 * parameter** — LP tokens mint to `msg.sender`. A fee-skimming wrapper would therefore
 * receive the LP tokens itself, making FairWins the custodian of the member's position and
 * leaving them unable to ever call `removeLiquidity`. That violates FR-023 (non-custodial)
 * and FR-021 (always exitable), so bridge-liquidity deposits are a **DIRECT member call**
 * and are **FEE-FREE in v1** (research R3 — the same rule spec 066 applied to delegated
 * staking: a fee is charged only where it can be charged atomically WITHOUT taking custody).
 *
 * Consequences this module is built to keep true:
 *   - nothing here imports, resolves, or targets `LiquidityRouter`. Every call it builds
 *     targets the HubPool or the supplied ERC-20, and nothing else;
 *   - there is no `maxFeeBps` argument and no fee-quoting function, because there is no fee.
 *     A bridge pool must show **no fee line at all** — not a line reading 0.00, which would
 *     imply a lever that does not exist;
 *   - a router pause, misconfiguration, or upgrade cannot stand between a member and their
 *     money. `LiquidityRouter` curates and lists bridge pools; it is not their path.
 *
 * `frontend/src/lib/liquidity/__tests__/acrossLpPositions.test.js` asserts all of the above
 * executably (T092).
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * BRIDGE LIQUIDITY IS ETHEREUM ONLY, AND SAYS SO.
 *
 * Across's HubPool is an L1 contract by design: the pot lives on Ethereum and the bridge
 * lends *from* it to every other network. Trading liquidity (Uniswap) is on all five
 * mainnets; bridge liquidity is on one (research R8). Every entry point here answers for a
 * network it does not serve with `bridgeLiquiditySupport(chainId)` — an explicit
 * `available: false` **and a reason naming where it IS available** — rather than returning
 * an empty list and letting the surface imply the feature merely has nothing in it. The
 * network list is derived from config, never hardcoded, so it stays true if Across ever
 * ships a second HubPool.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * TWO READS THAT LOOK LIKE VIEWS AND ARE NOT.
 *
 * `exchangeRateCurrent` and `liquidityUtilizationCurrent` are **state-changing** on Across
 * (they settle accrued LP fees before answering). Under ethers that meant an explicit
 * `contract.fn.staticCall(...)`, because reading them any other way would have BUILT A
 * TRANSACTION the member is asked to sign. The spec-110 seam removes the hazard rather than
 * managing it: `readContract` is an `eth_call` whatever a function's declared mutability, and
 * it has no path that sends one — so the two reads below are ordinary reads here, and cannot
 * become transactions by omission. The ABI still declares them without `view`, which is their
 * real mutability on-chain. Every read goes through `safeCall` and returns `null` when it
 * fails: a member shown "0" when the truth is "we could not read it" has been told something
 * false about their own money (FR-054). Nothing here ever substitutes a zero, a cached figure,
 * or an invented one.
 * ---------------------------------------------------------------------------
 *
 * ADDRESSES. `hubPool` is always an explicit argument, resolved by the caller from
 * `getHubPoolAddress(chainId)` (the network's own config record) or from the curated
 * `PoolListing.poolAddress` read off the router. Nothing here hardcodes one.
 */
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../chains/readContract'
import { NETWORKS, cohortChainIds } from '../../config/networks'
import { isBitcoinNetworkId } from '../../config/bitcoinNetworks'
import { assertEvmChainId } from '../bridge/bridgeRouter'

/**
 * The HubPool surface this module speaks to. Kept local rather than added to `abis/` because
 * it is Across's contract, not FairWins' — the same reasoning `uniswapPositions.js` applies
 * to Uniswap's position manager.
 *
 * `exchangeRateCurrent` / `liquidityUtilizationCurrent` are declared WITHOUT `view` on
 * purpose: that is their real mutability on-chain. Declaring them `view` to make a read
 * convenient would be recording something untrue about Across's contract — and a writing
 * caller reading that declaration would then build a call where a transaction is required.
 * They are read as `eth_call`s through the chain seam; see the header note.
 */
export const HUB_POOL_ABI = [
  'function addLiquidity(address l1Token, uint256 l1TokenAmount) payable',
  'function removeLiquidity(address l1Token, uint256 lpTokenAmount, bool sendEth)',
  'function pooledTokens(address l1Token) view returns (address lpToken, bool isEnabled, uint32 lastLpFeeUpdate, int256 utilizedReserves, uint256 liquidReserves, uint256 undistributedLpFees)',
  'function exchangeRateCurrent(address l1Token) returns (uint256)',
  'function liquidityUtilizationCurrent(address l1Token) returns (uint256)',
  'function paused() view returns (bool)',
  'function weth() view returns (address)',
]

/** The LP token is a plain ERC-20; only the balance and its metadata are needed. */
export const LP_TOKEN_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]

const HUB_POOL = normalizeAbi(HUB_POOL_ABI)
const LP_TOKEN = normalizeAbi(LP_TOKEN_ABI)
const ERC20_APPROVE_ABI = normalizeAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Across quotes the LP exchange rate scaled by 1e18. */
export const EXCHANGE_RATE_SCALE = 10n ** 18n

/**
 * Bridge-liquidity deposits carry NO FairWins platform fee, on any network, ever (research
 * R3). Exported as a constant so a surface can assert the absence rather than remember it,
 * and so `grep` finds one authoritative statement of the rule in the client code.
 */
export const BRIDGE_LP_CHARGES_PLATFORM_FEE = false

/**
 * `safe` for a call that can also throw SYNCHRONOUSLY while it is being built (a static call
 * the interface rejects, a bad address). Without this, such a throw escapes past a `.catch`
 * and turns an unreadable figure into a thrown error the caller never expected — the surface
 * would break instead of saying "unavailable".
 */
const safeCall = async (fn) => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

const asBigInt = (v) => {
  try {
    return v === undefined || v === null ? null : BigInt(v)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Availability — Ethereum only, stated rather than implied
// ---------------------------------------------------------------------------

/**
 * Every network IN THIS BUILD'S COHORT carrying an Across HubPool. Derived from config so
 * the answer stays true if that ever stops being exactly one network; never a hardcoded
 * chain id.
 *
 * `cohortChainIds()` and never `listSupportedChainIds()` (issue #1265): this roster is what
 * the availability copy names, and constitution III forbids a testnet build describing —
 * or reading — the mainnet HubPool. A testnet build therefore gets an empty list, which the
 * callers below already render as "not set up in this build yet".
 *
 * @returns {Array<{chainId: number, name: string, hubPool: string}>}
 */
export function bridgeLiquidityNetworks() {
  return cohortChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => ADDRESS_RE.test(String(net?.bridge?.hubPool ?? '')))
    .map((net) => ({ chainId: net.chainId, name: net.name, hubPool: net.bridge.hubPool }))
}

/**
 * The HubPool address for a chain, or null when that network has none.
 *
 * Throws on a non-EVM id (Bitcoin ids are strings — spec 061) because that is a caller bug,
 * not a runtime failure; `null` is reserved for "this EVM network has no HubPool". Surfaces
 * that may legitimately be handed a Bitcoin id should ask `bridgeLiquiditySupport` instead,
 * which answers rather than throws.
 *
 * @param {number} chainId
 * @returns {string|null}
 */
export function getHubPoolAddress(chainId) {
  assertEvmChainId(chainId, 'getHubPoolAddress')
  const addr = NETWORKS[chainId]?.bridge?.hubPool
  return addr && ADDRESS_RE.test(addr) ? addr : null
}

function whereAvailable() {
  const names = bridgeLiquidityNetworks().map((n) => n.name)
  if (names.length === 0) return null
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Whether bridge liquidity can be supplied on `chainId`, and — when it cannot — a plain
 * reason naming where it can (FR-025/FR-054, research R8).
 *
 * This never throws: it is the answer a surface shows, and it is handed whatever network the
 * member happens to be looking at, including Bitcoin. An unsupported network gets an explicit
 * `available: false` with a reason, never an empty list that reads as "nothing here yet".
 *
 * NOTE FOR CALLERS: this describes ONE network. The Supply area itself is NOT gated on the
 * wallet's active network — pools from every network are listed together and the wallet
 * switches at signing (FR-059/FR-061). Use this where a specific network is genuinely the
 * subject, not as a whole-surface gate.
 *
 * @param {number|string} chainId
 * @returns {{available: boolean, chainId: number|string|null, hubPool: string|null, reason: string|null}}
 */
export function bridgeLiquiditySupport(chainId) {
  const where = whereAvailable()
  const elsewhere = where
    ? `Bridge pools are available on ${where} only — the bridge’s shared pot lives there by design, so it is not offered on other networks.`
    : 'No network is set up for bridge pools in this build yet.'

  if (isBitcoinNetworkId(chainId)) {
    return {
      available: false,
      chainId,
      hubPool: null,
      reason: `Bitcoin is its own network and does not run the bridge this pool belongs to. ${elsewhere}`,
    }
  }
  if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) {
    return { available: false, chainId: chainId ?? null, hubPool: null, reason: elsewhere }
  }

  const hubPool = getHubPoolAddress(chainId)
  if (hubPool) return { available: true, chainId, hubPool, reason: null }

  const net = NETWORKS[chainId]
  const here = net?.name
    ? `Bridge liquidity is not offered on ${net.name}.`
    : 'Bridge liquidity is not offered on this network.'
  return { available: false, chainId, hubPool: null, reason: `${here} ${elsewhere}` }
}

// ---------------------------------------------------------------------------
// Reads — every one honestly null on failure
// ---------------------------------------------------------------------------

/**
 * The HubPool's record for one L1 token: its LP token, whether it still accepts deposits,
 * and how much of the pot is sitting there right now.
 *
 * `isEnabled: false` is Across's own retirement flag and behaves exactly like a retired
 * FairWins listing (FR-024): no new deposits, but the position stays readable and
 * withdrawable. It is never treated as "this pool does not exist".
 *
 * @returns {Promise<null | {lpToken: string, isEnabled: boolean, liquidReserves: bigint, utilizedReserves: bigint, undistributedLpFees: bigint, lastLpFeeUpdate: number}>}
 */
export async function readPooledToken({ chainId, provider, hubPool, l1Token }) {
  if (!provider || !hubPool || !l1Token || chainId == null) return null
  const raw = await safeCall(() =>
    readContract(chainId, { address: hubPool, abi: HUB_POOL, functionName: 'pooledTokens', args: [l1Token] }),
  )
  if (raw === undefined || raw === null) return null
  const lpToken = raw.lpToken ?? raw[0]
  // An unlisted token returns a zero-filled struct rather than reverting. A zero LP token is
  // the only reliable "not a pooled token here" signal — treating it as a real pool would
  // offer the member a deposit into address(0).
  if (!lpToken || !ADDRESS_RE.test(String(lpToken)) || /^0x0{40}$/i.test(String(lpToken))) return null
  return {
    lpToken: String(lpToken),
    isEnabled: Boolean(raw.isEnabled ?? raw[1]),
    lastLpFeeUpdate: Number(raw.lastLpFeeUpdate ?? raw[2] ?? 0),
    utilizedReserves: asBigInt(raw.utilizedReserves ?? raw[3]) ?? 0n,
    liquidReserves: asBigInt(raw.liquidReserves ?? raw[4]) ?? 0n,
    undistributedLpFees: asBigInt(raw.undistributedLpFees ?? raw[5]) ?? 0n,
  }
}

/**
 * The current LP exchange rate, scaled by 1e18 — how much of the underlying asset one LP
 * token is worth right now, INCLUDING fees earned since the last settlement.
 *
 * STATIC CALL, because `exchangeRateCurrent` settles accrued fees and is therefore
 * state-changing. Reading it any other way would build a transaction.
 *
 * @returns {Promise<bigint|null>} null when unreadable — never a 1e18 stand-in
 */
export async function readExchangeRate({ chainId, provider, hubPool, l1Token }) {
  if (!provider || !hubPool || !l1Token || chainId == null) return null
  const raw = await safeCall(() =>
    readContract(chainId, { address: hubPool, abi: HUB_POOL, functionName: 'exchangeRateCurrent', args: [l1Token] }),
  )
  return raw === undefined ? null : asBigInt(raw)
}

/**
 * How much of the pot is currently lent out, scaled by 1e18 (1e18 = fully utilized).
 * Also a state-changing read, also static-called. Used to explain a short withdrawal
 * honestly (FR-022) rather than failing with a bare revert.
 *
 * @returns {Promise<bigint|null>}
 */
export async function readUtilization({ chainId, provider, hubPool, l1Token }) {
  if (!provider || !hubPool || !l1Token || chainId == null) return null
  const raw = await safeCall(() =>
    readContract(chainId, {
      address: hubPool,
      abi: HUB_POOL,
      functionName: 'liquidityUtilizationCurrent',
      args: [l1Token],
    }),
  )
  return raw === undefined ? null : asBigInt(raw)
}

/** The member's LP token balance, or null when it cannot be read. */
export async function readLpBalance({ chainId, provider, lpToken, owner }) {
  if (!provider || !lpToken || !owner || chainId == null) return null
  const raw = await safeCall(() =>
    readContract(chainId, { address: lpToken, abi: LP_TOKEN, functionName: 'balanceOf', args: [owner] }),
  )
  return raw === undefined ? null : asBigInt(raw)
}

/** Whether the HubPool itself is paused, or null when that cannot be read (never `false`). */
export async function readHubPoolPaused({ chainId, provider, hubPool }) {
  if (!provider || !hubPool || chainId == null) return null
  const raw = await safeCall(() =>
    readContract(chainId, { address: hubPool, abi: HUB_POOL, functionName: 'paused' }),
  )
  return raw === undefined ? null : Boolean(raw)
}

// ---------------------------------------------------------------------------
// Valuation — pure, and explicit about what it cannot know
// ---------------------------------------------------------------------------

/**
 * What an LP balance is worth in the underlying asset. Pure.
 * @returns {bigint|null} null whenever either input is unknown — never a zero.
 */
export function lpValueInUnderlying(lpBalance, exchangeRate) {
  const bal = asBigInt(lpBalance)
  const rate = asBigInt(exchangeRate)
  if (bal === null || rate === null) return null
  return (bal * rate) / EXCHANGE_RATE_SCALE
}

/**
 * The most that can be withdrawn RIGHT NOW, in LP tokens and in the underlying asset.
 *
 * A bridge pool is lent out across networks at any moment, and the HubPool refuses a removal
 * larger than its liquid reserves. So a full exit is not always available immediately — FR-022
 * requires the member be told that plainly and offered what IS available, rather than shown a
 * transaction that reverts. `isFull` is the flag a surface uses to decide whether to say so.
 *
 * Pure. Returns null when any input is unknown, so the caller says "we could not work this
 * out" instead of implying nothing can be withdrawn.
 *
 * @param {{lpBalance: bigint, exchangeRate: bigint, liquidReserves: bigint}} args
 * @returns {null | {lpTokens: bigint, underlying: bigint, isFull: boolean}}
 */
export function maxWithdrawable({ lpBalance, exchangeRate, liquidReserves }) {
  const bal = asBigInt(lpBalance)
  const rate = asBigInt(exchangeRate)
  const liquid = asBigInt(liquidReserves)
  if (bal === null || rate === null || liquid === null || rate <= 0n) return null
  if (bal === 0n) return { lpTokens: 0n, underlying: 0n, isFull: true }

  const owed = (bal * rate) / EXCHANGE_RATE_SCALE
  if (owed <= liquid) return { lpTokens: bal, underlying: owed, isFull: true }
  // Round DOWN to LP tokens the reserves can certainly cover; rounding up would build a
  // removal the HubPool rejects.
  const lpTokens = (liquid * EXCHANGE_RATE_SCALE) / rate
  return { lpTokens, underlying: (lpTokens * rate) / EXCHANGE_RATE_SCALE, isFull: false }
}

/**
 * One member's bridge-pool position, valued (FR-020).
 *
 * Returns null only when the pool record itself is unreadable. When a FIGURE is unreadable
 * the position is still returned with that field `null` — the member keeps seeing that the
 * position exists (and can still exit it) while the numbers honestly read as unavailable.
 * Hiding a position because a rate read failed would be the worse lie.
 *
 * `earningsToDate` is deliberately ABSENT: Across LP fees accrue into the exchange rate, so
 * earnings can only be stated against what the member originally supplied — which lives in
 * the activity ledger, not on-chain. This module reports the live value and the rate that
 * produced it; the Supply view derives earnings from the ledger's recorded cost basis. Making
 * one up here would be inventing data (FR-054).
 *
 * @returns {Promise<null | object>}
 */
export async function readLpPosition({ chainId, provider, hubPool, l1Token, owner }) {
  const pooled = await readPooledToken({ chainId, provider, hubPool, l1Token })
  if (!pooled) return null

  const [lpBalance, exchangeRate, utilization] = await Promise.all([
    readLpBalance({ chainId, provider, lpToken: pooled.lpToken, owner }),
    readExchangeRate({ chainId, provider, hubPool, l1Token }),
    readUtilization({ chainId, provider, hubPool, l1Token }),
  ])

  return {
    hubPool,
    l1Token,
    lpToken: pooled.lpToken,
    // Across's own retirement flag: no new deposits, still withdrawable (FR-024).
    acceptsDeposits: pooled.isEnabled,
    lpBalance,
    exchangeRate,
    utilization,
    liquidReserves: pooled.liquidReserves,
    currentValue: lpValueInUnderlying(lpBalance, exchangeRate),
    withdrawable: maxWithdrawable({
      lpBalance,
      exchangeRate,
      liquidReserves: pooled.liquidReserves,
    }),
    // Every figure above moves with the pool and is read from the protocol, never promised.
    isEstimate: true,
  }
}

// ---------------------------------------------------------------------------
// Calls — direct to the HubPool, and free
// ---------------------------------------------------------------------------

function requireAmount(amount, fn) {
  const value = asBigInt(amount)
  if (value === null || value <= 0n) throw new Error(`${fn}: amount must be a positive integer`)
  return value
}

/**
 * Build the deposit call(s): approve the HubPool for exactly the amount, then `addLiquidity`.
 *
 * There is no `maxFeeBps` argument and no fee leg, because bridge-liquidity deposits carry no
 * FairWins platform fee (research R3). Adding one would require a wrapper that owns the LP
 * tokens, which is precisely what the ruling forbids.
 *
 * NATIVE ETH: the HubPool's WETH pool accepts a native deposit, wrapping it itself, and
 * requires `msg.value` to equal `l1TokenAmount` exactly. That path takes no approval. Pass
 * `weth` alongside `useNative` and this refuses the mistake of sending value to a non-WETH
 * pool — the HubPool would revert (`Cannot send eth`), and a member should not be asked to
 * sign a transaction that cannot succeed.
 *
 * @param {{hubPool: string, l1Token: string, amount: bigint|number|string, useNative?: boolean, weth?: string}} args
 * @returns {{calls: Array<{target: string, data: string, value: bigint}>, requiresApproval: boolean}}
 */
export function buildAddLiquidityCalls({ hubPool, l1Token, amount, useNative = false, weth }) {
  if (!hubPool) throw new Error('buildAddLiquidityCalls: hubPool is required')
  if (!l1Token) throw new Error('buildAddLiquidityCalls: l1Token is required')
  const value = requireAmount(amount, 'buildAddLiquidityCalls')
  if (useNative && weth && String(weth).toLowerCase() !== String(l1Token).toLowerCase()) {
    throw new Error(
      'buildAddLiquidityCalls: only the WETH pool accepts a native deposit — supply this pool’s ERC-20 instead',
    )
  }

  const calls = []
  if (!useNative) {
    calls.push({
      target: l1Token,
      data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: 'approve', args: [hubPool, value] }),
      value: 0n,
    })
  }
  calls.push({
    target: hubPool,
    data: encodeFunctionData({ abi: HUB_POOL, functionName: 'addLiquidity', args: [l1Token, value] }),
    // The HubPool requires msg.value == l1TokenAmount on the native path, and 0 otherwise.
    value: useNative ? value : 0n,
  })

  return { calls, requiresApproval: !useNative }
}

/**
 * Build the exit call: `removeLiquidity`, straight to the HubPool.
 *
 * NO APPROVAL LEG, and that is correct rather than an oversight: Across's LP token grants the
 * HubPool the burner role, so it burns the member's LP tokens directly. An approve here would
 * be a pointless extra signature.
 *
 * NO FEE, on any path: withdrawals never carry a FairWins platform fee (FR-030), and this one
 * could not carry one even if the doctrine allowed it — the router is not in the path.
 *
 * A partial exit is simply a smaller `lpTokenAmount`; the remainder stays supplied and keeps
 * earning (FR-022). `maxWithdrawable` computes what the reserves can cover right now.
 *
 * `receiveNative` asks the HubPool to unwrap to ETH, which only the WETH pool can do; pass
 * `weth` and the mistake is refused here rather than reverting on-chain.
 *
 * @param {{hubPool: string, l1Token: string, lpTokenAmount: bigint|number|string, receiveNative?: boolean, weth?: string}} args
 * @returns {{calls: Array<{target: string, data: string, value: bigint}>, requiresApproval: false}}
 */
export function buildRemoveLiquidityCalls({
  hubPool,
  l1Token,
  lpTokenAmount,
  receiveNative = false,
  weth,
}) {
  if (!hubPool) throw new Error('buildRemoveLiquidityCalls: hubPool is required')
  if (!l1Token) throw new Error('buildRemoveLiquidityCalls: l1Token is required')
  const value = requireAmount(lpTokenAmount, 'buildRemoveLiquidityCalls')
  if (receiveNative && weth && String(weth).toLowerCase() !== String(l1Token).toLowerCase()) {
    throw new Error(
      'buildRemoveLiquidityCalls: only the WETH pool can pay out as ETH — withdraw this pool’s ERC-20 instead',
    )
  }

  return {
    calls: [
      {
        target: hubPool,
        data: encodeFunctionData({
          abi: HUB_POOL,
          functionName: 'removeLiquidity',
          args: [l1Token, value, Boolean(receiveNative)],
        }),
        value: 0n,
      },
    ],
    // The HubPool burns LP tokens by role, not by allowance.
    requiresApproval: false,
  }
}
