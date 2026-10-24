/**
 * GMX v2 calldata (spec 083, T014) — Arbitrum only.
 *
 * Every builder returns a `{ target, data, value }` call object, the shape `WalletContext.sendCalls`
 * consumes (the `lib/earn/vaultActions.js` convention that `venues/gains.js` also follows): a passkey
 * session authorizes approve + open with one ceremony, a classic wallet signs them in order.
 *
 * THE OWNERSHIP INVARIANT — and the one misreading that would create custody. GMX's
 * `CreateOrderParams.addresses.receiver` LOOKS like an owner field. It is not. Ownership is
 * `msg.sender` of `createOrder` (`ExchangeRouter.sol`: `address account = msg.sender;`), hashed into
 * the position key `keccak256(account, market, collateralToken, isLong)` — which is why
 * `positionKey()` below takes an account and not a receiver. `receiver` is a PAYOUT target and
 * `cancellationReceiver` is a REFUND target; both are the MEMBER here. `multicall` is
 * delegatecall-to-self, so batching cannot move the caller either. The ONLY FairWins address that
 * may appear anywhere in this calldata is `addresses.uiFeeReceiver`. Anyone tempted to put a
 * FairWins address in `receiver` "so the app can route proceeds" would be handing FairWins the
 * member's position; there is no version of that which is safe.
 *
 * An absent `uiFeeReceiver` is `address(0)` and NOT an error: GMX early-returns a zero UI fee for
 * the zero address, so an unconfigured receiver is structurally fee-free (fee-rails.md).
 *
 * THE APPROVAL TRAP. Collateral is pulled by `Router.pluginTransfer`, so the ERC-20 approval goes to
 * GMX's **Router**, never to the ExchangeRouter this module calls. Two different addresses, both
 * named "router" — see `buildApprovalCall`.
 *
 * SCALES. `sizeDeltaUsd`, `triggerPrice` and `acceptablePrice` are 1e30; collateral amounts are in
 * the collateral token's OWN decimals; `executionFee` is wei. Token amounts and fees are strictly
 * `bigint` — a JS number there is the tell of a human-unit value that would encode as dust.
 *
 * Builders THROW on malformed input rather than returning a sentinel: they run when a member is
 * about to sign, never during render, and a silently-wrong call object would reach the wallet with
 * the member's collateral attached. The decoders, the execution-fee estimate and its live read are
 * the opposite — they run over venue data inside effects and render, so they are total and return
 * null / []. `readExecutionFee` is the one asynchronous thing here and it is total too: no GMX on
 * this chain, no read connection, a reverting call and a suspicious zero all resolve to `null`, and
 * the surface says the fee could not be read rather than guessing at money the member will pay.
 */
import {
  encodeAbiParameters,
  encodeFunctionData,
  decodeEventLog,
  decodeFunctionResult,
  isHex,
  keccak256,
  pad,
  toEventSelector,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { normalizeAbi, readContract } from '../../chains/readContract'
import { getAddress, isAddress } from '../../evm/address'
import { formatUnits, parseUnits } from '../../evm/units'
import { GMX_DATA_STORE_ABI } from '../../../abis/perps/gmxDataStore'
import {
  GMX_DECREASE_POSITION_SWAP_TYPE,
  GMX_EVENT_EMITTER_ABI,
  GMX_EXCHANGE_ROUTER_ABI,
  GMX_ORDER_EVENT_NAMES,
  GMX_ORDER_TYPE,
} from '../../../abis/perps/gmxExchangeRouter'
import { GMX_READER_ABI } from '../../../abis/perps/gmxReader'
import { gmxAddressesFor } from '../../../config/perps'
import { getPublicClient } from '../../chains/publicClient'

const EXCHANGE_ROUTER = normalizeAbi(GMX_EXCHANGE_ROUTER_ABI)
const EVENT_EMITTER = normalizeAbi(GMX_EVENT_EMITTER_ABI)
const READER = normalizeAbi(GMX_READER_ABI)

/** Exact-amount approvals only — the repo never grants an unlimited allowance for collateral. */
const ERC20 = normalizeAbi(['function approve(address spender, uint256 value) returns (bool)'])

/** `Interface.encodeFunctionData(name, args)`, in the shape viem spells it. Byte-identical. */
const callData = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args })

/**
 * GMX v2 is deployed on Arbitrum and nowhere else this product touches, so builders default to it.
 * The parameter still exists: `requireGmx` refuses any chain the config does not carry, rather than
 * silently aiming Arbitrum calldata at another chain.
 */
export const GMX_CHAIN_ID = 42161

/** `sizeDeltaUsd`, `triggerPrice`, `acceptablePrice` and `Position.sizeInUsd` are all 1e30. */
export const GMX_USD_DECIMALS = 30

/** GMX's `Precision.FLOAT_PRECISION` — the denominator every `applyFactor` divides by. */
export const GMX_FLOAT_PRECISION = 10n ** 30n

/** `oraclePriceCount = 3 + swapPath.length` for the execution-fee estimate. */
export const GMX_ORACLE_PRICE_COUNT_BASE = 3

/**
 * How far above the computed execution fee to bid, in bps of the fee. 1000 bps = 10%.
 *
 * BIASED HIGH DELIBERATELY, AND THE ASYMMETRY IS THE WHOLE ARGUMENT.
 *
 *  - Overpaying: `GasUtils.payExecutionFee` pays the keeper only what it actually spent
 *    (`executionFeeForKeeper`, capped at the declared fee) and sends `executionFee - that` straight
 *    back to the member, emitting `ExecutionFeeRefund`. The surplus is a few seconds of float, and
 *    no cap eats it: `validateAndCapExecutionFee` only caps when `shouldCapMaxExecutionFee` is set
 *    (subaccount orders with a callback contract — this app has neither), and that cap is
 *    `MAX_EXECUTION_FEE_MULTIPLIER_FACTOR`, read live as 1e32 = **100×**, three orders of magnitude
 *    above this buffer.
 *  - Underpaying: `createOrder` reverts `InsufficientExecutionFee` — after the member signed and
 *    paid gas — because the minimum is computed against the CREATING transaction's own
 *    `tx.gasprice`, which is not the gas price we quoted at, only what the wallet ends up sending
 *    at. A member who raises the gas price in their wallet, or a base fee that ticks up between
 *    the quote and the signature, is the ordinary case this covers.
 *
 * So the buffer is insurance against gas moving between the read and the signature, paid for with
 * money that comes back. It is disclosed to the member as an estimate with the refund named — see
 * `PositionSheet`'s keeper-fee line.
 */
export const GMX_EXECUTION_FEE_BUFFER_BPS = 1000

const BPS_DENOMINATOR = 10_000n

/* ------------------------------------------------------------------------------------------- *
 * Input validation and scaling
 * ------------------------------------------------------------------------------------------- */

function describe(value) {
  if (value === null) return 'null'
  if (typeof value === 'object') return 'an object'
  return `a ${typeof value} (${String(value)})`
}

/**
 * The GMX address set for a chain. Throws where GMX is not deployed: a call object with a null
 * target would be a transaction to the zero address carrying the member's collateral.
 */
function requireGmx(chainId) {
  const gmx = gmxAddressesFor(chainId)
  if (!gmx) throw new Error(`GMX v2 is not deployed on chain ${String(chainId)}`)
  return gmx
}

/**
 * `isAddress` comes from `lib/evm/address` rather than straight from viem: neither of viem's two
 * settings reproduces ethers, and the safety invariant this module is built around depends on it —
 * an ALL-UPPERCASE FairWins address must get past the format check so the receiver guard below can
 * refuse it by identity (safetyInvariants.test.js), while a mistyped MIXED-CASE address must still
 * be refused as malformed. See that seam for the full table.
 */
function requireAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new TypeError(`${label} must be an address, received ${describe(value)}`)
  }
  const addr = getAddress(value)
  if (addr === zeroAddress) throw new TypeError(`${label} cannot be the zero address`)
  return addr
}

/**
 * An optional address. Absent → `address(0)`, which is meaningful to GMX rather than broken:
 * a zero `uiFeeReceiver` is a zero UI fee, and a zero `cancellationReceiver` defaults to the account.
 */
function optionalAddress(value, label) {
  if (value == null || value === '') return zeroAddress
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new TypeError(`${label} must be an address or null, received ${describe(value)}`)
  }
  return getAddress(value)
}

/**
 * Token amounts and wei values are `bigint` only. A JS number here would almost always be a
 * human-unit amount (10 meaning 10 USDC) which encodes as 10 base units.
 */
function requireTokenAmount(value, label) {
  if (typeof value !== 'bigint') {
    throw new TypeError(`${label} must be a bigint in the token's own decimals`)
  }
  if (value < 0n) throw new RangeError(`${label} cannot be negative`)
  return value
}

/**
 * The execution fee must be positive and must equal the `sendWnt` amount — GMX reverts
 * `InsufficientWntAmountForExecutionFee` when the vault received less than the order declares.
 * Both come from this one value, so they cannot drift apart.
 */
function requireExecutionFee(value) {
  const fee = requireTokenAmount(value, 'executionFee')
  if (fee === 0n) {
    throw new RangeError('executionFee must be greater than zero — GMX keepers will not execute a fee-free order')
  }
  return fee
}

/** A plain uint256 (callbackGasLimit, minOutputAmount, validFromTime). */
function requireUint(value, label) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError(`${label} cannot be negative`)
    return value
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value)
  throw new TypeError(`${label} must be a non-negative integer, received ${describe(value)}`)
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean, received ${describe(value)}`)
  return value
}

function requireBytes32(value, label) {
  // ethers' `isHexString(v, 32)` in two viem words: hex, and exactly 32 bytes of it.
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66) {
    throw new TypeError(`${label} must be a 32-byte hex string, received ${describe(value)}`)
  }
  return value
}

function optionalBytes32(value, label) {
  if (value == null || value === '') return zeroHash
  return requireBytes32(value, label)
}

/**
 * Human units → GMX's 1e30 fixed point. A `bigint` passes through UNCHANGED because it is already
 * in venue units — that is how a `sizeInUsd` read back from the Reader is re-sent as the
 * `sizeDeltaUsd` of a full close without a round trip through a float.
 */
export function toUsdUnits(value, label = 'value') {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError(`${label} cannot be negative`)
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`)
    if (value < 0) throw new RangeError(`${label} cannot be negative`)
    return parseUnits(value.toFixed(GMX_USD_DECIMALS), GMX_USD_DECIMALS)
  }
  if (typeof value === 'string') {
    const s = value.trim()
    if (!/^\d+(\.\d+)?$/.test(s)) {
      throw new RangeError(`${label} must be a non-negative decimal, received "${value}"`)
    }
    const [whole, frac = ''] = s.split('.')
    // Truncate rather than round: below the venue's precision is the member's side of the line.
    return parseUnits(`${whole}.${frac.slice(0, GMX_USD_DECIMALS) || '0'}`, GMX_USD_DECIMALS)
  }
  throw new RangeError(`${label} is required`)
}

/** 1e30 venue units → a decimal string. Total: junk in → null out (it renders in the sheet). */
export function fromUsdUnits(units) {
  try {
    if (typeof units === 'string' && !/^-?\d+$/.test(units.trim())) return null
    return formatUnits(units, GMX_USD_DECIMALS)
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Order construction
 * ------------------------------------------------------------------------------------------- */

/**
 * `CreateOrderParams` in ABI field order.
 *
 * `receiver` and `cancellationReceiver` are BOTH the member: proceeds and refunds go to the member's
 * own wallet, and neither field confers ownership (see the module header). `uiFeeReceiver` is the
 * single permitted FairWins address; `callbackContract` is zero because this feature has no callback
 * and a contract there would be a third party in the member's order.
 */
function createOrderParams({
  account,
  market,
  collateralToken,
  uiFeeReceiver,
  orderType,
  sizeDeltaUsd,
  initialCollateralDeltaAmount,
  triggerPrice,
  acceptablePrice,
  executionFee,
  minOutputAmount,
  validFromTime,
  isLong,
  shouldUnwrapNativeToken,
  autoCancel,
  referralCode,
}) {
  // THE OWNERSHIP INVARIANT, enforced rather than only asserted in a test. Ownership is `msg.sender`
  // of `createOrder`, so building an order whose account IS the FairWins fee receiver means FairWins
  // holds the position — forbidden pattern 2 in venue-calldata.md. Both sides are already
  // checksum-normalised (`requireAddress` / `optionalAddress`), so this compares addresses, not case.
  if (uiFeeReceiver !== zeroAddress && uiFeeReceiver === account) {
    throw new Error(
      'refusing to build a GMX order owned by the FairWins UI-fee receiver — the position owner is ' +
        'msg.sender, so this would give FairWins the position (venue-calldata.md, forbidden pattern 2)',
    )
  }
  return [
    [
      account, // receiver — the MEMBER (payout target, NOT ownership)
      account, // cancellationReceiver — the MEMBER (refund target, NOT ownership)
      zeroAddress, // callbackContract
      uiFeeReceiver, // ← the ONLY FairWins address permitted in this calldata
      market,
      collateralToken,
      [], // swapPath — this feature never swaps on the way in or out
    ],
    [
      sizeDeltaUsd, // 1e30 notional
      initialCollateralDeltaAmount, // collateral token decimals
      triggerPrice, // 1e30, 0 for a market order
      acceptablePrice, // 1e30 slippage bound
      executionFee, // wei — must equal the sendWnt amount
      0n, // callbackGasLimit
      minOutputAmount,
      validFromTime,
    ],
    orderType,
    GMX_DECREASE_POSITION_SWAP_TYPE.NO_SWAP,
    isLong,
    shouldUnwrapNativeToken,
    autoCancel,
    referralCode,
    [], // dataList
  ]
}

/** One transaction to the ExchangeRouter carrying the encoded venue calls and the execution fee. */
function multicall(exchangeRouter, calls, value) {
  return {
    target: exchangeRouter,
    data: callData(EXCHANGE_ROUTER, 'multicall', [calls]),
    value,
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Builders
 * ------------------------------------------------------------------------------------------- */

/**
 * `approve(router, amount)` on the COLLATERAL TOKEN.
 *
 * THE SPENDER IS GMX'S `Router`, NOT THE `ExchangeRouter` THIS MODULE CALLS. The ExchangeRouter is
 * the call target; the Router is what actually pulls tokens (`Router.pluginTransfer`), so approving
 * the ExchangeRouter yields a `sendTokens` that reverts at execution — after the member has signed
 * and paid. The two addresses are pinned separately in `config/perps.js` with the same warning; do
 * not "simplify" this to `gmx.exchangeRouter`.
 */
export function buildApprovalCall({ chainId = GMX_CHAIN_ID, token, amount }) {
  const gmx = requireGmx(chainId)
  const collateral = requireAddress(token, 'token')
  const value = requireTokenAmount(amount, 'amount')
  return {
    target: collateral,
    data: callData(ERC20, 'approve', [gmx.router, value]),
    value: 0n,
  }
}

/**
 * Open (or add to) a position: ONE ExchangeRouter `multicall` of
 * `[sendWnt, sendTokens, createOrder]` with `value` = the execution fee.
 *
 * Ordering is load-bearing. Both transfers must land in the OrderVault before `createOrder` runs,
 * because `createOrder` measures what arrived (`recordTransferIn`) rather than trusting the
 * parameters. That is also why a WNT collateral token is safe in this three-call form: the vault's
 * balance delta covers fee + collateral together and GMX subtracts the declared execution fee from
 * it (venue-calldata.md).
 */
export function buildOpenPositionCalls({
  chainId = GMX_CHAIN_ID,
  account,
  market,
  collateralToken,
  collateralAmount,
  sizeDeltaUsd,
  acceptablePrice,
  executionFee,
  isLong,
  uiFeeReceiver = null,
  referralCode = null,
}) {
  const gmx = requireGmx(chainId)
  const member = requireAddress(account, 'account')
  const collateral = requireTokenAmount(collateralAmount, 'collateralAmount')
  if (collateral === 0n) throw new RangeError('collateralAmount must be greater than zero to open')
  const size = toUsdUnits(sizeDeltaUsd, 'sizeDeltaUsd')
  if (size === 0n) throw new RangeError('sizeDeltaUsd must be greater than zero to open')
  const fee = requireExecutionFee(executionFee)
  const collateralAddress = requireAddress(collateralToken, 'collateralToken')

  const params = createOrderParams({
    account: member,
    market: requireAddress(market, 'market'),
    collateralToken: collateralAddress,
    uiFeeReceiver: optionalAddress(uiFeeReceiver, 'uiFeeReceiver'),
    orderType: GMX_ORDER_TYPE.MARKET_INCREASE,
    sizeDeltaUsd: size,
    initialCollateralDeltaAmount: collateral,
    triggerPrice: 0n, // a market order has no trigger
    // Not range-checked: the safe bound is a MAXIMUM for a long and a MINIMUM for a short, so any
    // bound this module invented would be wrong for one of them. The caller states it explicitly.
    acceptablePrice: toUsdUnits(acceptablePrice, 'acceptablePrice'),
    executionFee: fee,
    minOutputAmount: 0n, // an increase produces no output token
    validFromTime: 0n,
    isLong: requireBoolean(isLong, 'isLong'),
    shouldUnwrapNativeToken: false,
    autoCancel: false, // only protection orders die with the position
    referralCode: optionalBytes32(referralCode, 'referralCode'),
  })

  return multicall(
    gmx.exchangeRouter,
    [
      callData(EXCHANGE_ROUTER, 'sendWnt', [gmx.orderVault, fee]),
      callData(EXCHANGE_ROUTER, 'sendTokens', [collateralAddress, gmx.orderVault, collateral]),
      callData(EXCHANGE_ROUTER, 'createOrder', [params]),
    ],
    fee,
  )
}

/**
 * Close or reduce a position: `[sendWnt, createOrder]` with `orderType = MarketDecrease`.
 *
 * NO `sendTokens` — a decrease sends nothing to the vault but the execution fee. Adding one would
 * pull collateral out of the member's wallet for an order that is returning collateral to it.
 *
 * `sizeDeltaUsd` is the notional to close (a full close is the position's own `sizeInUsd`, which is
 * why `toUsdUnits` passes a bigint straight through), and `initialCollateralDeltaAmount` is the
 * collateral to withdraw — zero is legitimate, meaning "reduce size, leave the collateral".
 */
export function buildClosePositionCalls({
  chainId = GMX_CHAIN_ID,
  account,
  market,
  collateralToken,
  collateralAmount = 0n,
  sizeDeltaUsd,
  acceptablePrice,
  executionFee,
  isLong,
  uiFeeReceiver = null,
  referralCode = null,
  minOutputAmount = 0n,
  shouldUnwrapNativeToken = false,
}) {
  const gmx = requireGmx(chainId)
  const member = requireAddress(account, 'account')
  const size = toUsdUnits(sizeDeltaUsd, 'sizeDeltaUsd')
  const collateral = requireTokenAmount(collateralAmount, 'collateralAmount')
  if (size === 0n && collateral === 0n) {
    throw new RangeError('a decrease needs a sizeDeltaUsd or a collateralAmount to withdraw')
  }
  const fee = requireExecutionFee(executionFee)

  const params = createOrderParams({
    account: member,
    market: requireAddress(market, 'market'),
    collateralToken: requireAddress(collateralToken, 'collateralToken'),
    uiFeeReceiver: optionalAddress(uiFeeReceiver, 'uiFeeReceiver'),
    orderType: GMX_ORDER_TYPE.MARKET_DECREASE,
    sizeDeltaUsd: size,
    initialCollateralDeltaAmount: collateral,
    triggerPrice: 0n,
    acceptablePrice: toUsdUnits(acceptablePrice, 'acceptablePrice'),
    executionFee: fee,
    minOutputAmount: requireUint(minOutputAmount, 'minOutputAmount'),
    validFromTime: 0n,
    isLong: requireBoolean(isLong, 'isLong'),
    shouldUnwrapNativeToken: requireBoolean(shouldUnwrapNativeToken, 'shouldUnwrapNativeToken'),
    autoCancel: false, // a market decrease executes or cancels; there is no position to outlive
    referralCode: optionalBytes32(referralCode, 'referralCode'),
  })

  return multicall(
    gmx.exchangeRouter,
    [
      callData(EXCHANGE_ROUTER, 'sendWnt', [gmx.orderVault, fee]),
      callData(EXCHANGE_ROUTER, 'createOrder', [params]),
    ],
    fee,
  )
}

/**
 * Stop-loss (`StopLossDecrease`) and/or take-profit (`LimitDecrease`), as INDEPENDENT call objects —
 * one `[sendWnt, createOrder]` multicall per leg, each carrying its own execution fee.
 *
 * `autoCancel` is hardcoded TRUE and is not an option. A trigger order that outlives its position is
 * stale exposure: the member closes manually, believes they are flat, and a lingering stop opens a
 * NEW position in the opposite direction when it fires. `autoCancel` is what makes the order die
 * with the position.
 *
 * The stop-loss leg is emitted FIRST so that a member who abandons the second signature is left with
 * the protective order rather than only the profit-taking one.
 *
 * `acceptablePrice` has no default per leg for the same reason it has none on an open: the safe
 * bound is a maximum for one side and a minimum for the other, and a stop that cannot fill is worse
 * than no stop at all.
 */
export function buildProtectionCalls({
  chainId = GMX_CHAIN_ID,
  account,
  market,
  collateralToken,
  isLong,
  executionFee,
  stopLoss = null,
  takeProfit = null,
  uiFeeReceiver = null,
  referralCode = null,
}) {
  const gmx = requireGmx(chainId)
  const member = requireAddress(account, 'account')
  const marketAddress = requireAddress(market, 'market')
  const collateralAddress = requireAddress(collateralToken, 'collateralToken')
  const uiFee = optionalAddress(uiFeeReceiver, 'uiFeeReceiver')
  const code = optionalBytes32(referralCode, 'referralCode')
  const long = requireBoolean(isLong, 'isLong')
  if (stopLoss == null && takeProfit == null) {
    throw new RangeError('buildProtectionCalls needs a stopLoss, a takeProfit, or both')
  }

  const leg = (spec, orderType, label) => {
    const fee = requireExecutionFee(spec.executionFee ?? executionFee)
    const size = toUsdUnits(spec.sizeDeltaUsd, `${label}.sizeDeltaUsd`)
    if (size === 0n) throw new RangeError(`${label}.sizeDeltaUsd must be greater than zero`)
    const trigger = toUsdUnits(spec.triggerPrice, `${label}.triggerPrice`)
    if (trigger === 0n) throw new RangeError(`${label}.triggerPrice must be greater than zero`)
    if (spec.acceptablePrice == null) {
      throw new RangeError(`${label}.acceptablePrice is required — its safe value depends on direction`)
    }
    const params = createOrderParams({
      account: member,
      market: marketAddress,
      collateralToken: collateralAddress,
      uiFeeReceiver: uiFee,
      orderType,
      sizeDeltaUsd: size,
      initialCollateralDeltaAmount: requireTokenAmount(spec.collateralAmount ?? 0n, `${label}.collateralAmount`),
      triggerPrice: trigger,
      acceptablePrice: toUsdUnits(spec.acceptablePrice, `${label}.acceptablePrice`),
      executionFee: fee,
      minOutputAmount: requireUint(spec.minOutputAmount ?? 0n, `${label}.minOutputAmount`),
      validFromTime: requireUint(spec.validFromTime ?? 0n, `${label}.validFromTime`),
      isLong: long,
      shouldUnwrapNativeToken: Boolean(spec.shouldUnwrapNativeToken),
      autoCancel: true, // NOT configurable — see the doc comment above
      referralCode: code,
    })
    return multicall(
      gmx.exchangeRouter,
      [
        callData(EXCHANGE_ROUTER, 'sendWnt', [gmx.orderVault, fee]),
        callData(EXCHANGE_ROUTER, 'createOrder', [params]),
      ],
      fee,
    )
  }

  const calls = []
  if (stopLoss != null) calls.push(leg(stopLoss, GMX_ORDER_TYPE.STOP_LOSS_DECREASE, 'stopLoss'))
  if (takeProfit != null) calls.push(leg(takeProfit, GMX_ORDER_TYPE.LIMIT_DECREASE, 'takeProfit'))
  return calls
}

/**
 * `cancelOrder(key)` — the only way out of a frozen trigger order, and the member's alone: GMX
 * reverts unless `order.account() == msg.sender`. Nothing auto-clears a frozen order, which is why
 * this control is always offered rather than gated.
 *
 * Accepts a bare key as well as an options object, because the contract doc names it `cancelOrder(key)`.
 */
export function buildCancelOrderCall(arg) {
  const { chainId = GMX_CHAIN_ID, key } = typeof arg === 'string' ? { key: arg } : (arg ?? {})
  const gmx = requireGmx(chainId)
  return {
    target: gmx.exchangeRouter,
    data: callData(EXCHANGE_ROUTER, 'cancelOrder', [requireBytes32(key, 'key')]),
    value: 0n,
  }
}

/**
 * `updateOrder(key, …)` — retune a pending or frozen trigger order in place. Owner-gated the same
 * way `cancelOrder` is.
 *
 * `autoCancel` defaults to TRUE because `updateOrder` OVERWRITES the stored flag: omitting it with a
 * `false` default would quietly convert a protection order into one that outlives its position,
 * which is exactly the stale exposure `buildProtectionCalls` refuses to create.
 *
 * No execution-fee top-up is modelled: `value` is zero. If GMX ever requires more fee for an updated
 * order, that is a `sendWnt` in a multicall and must be added deliberately, not inferred here.
 */
export function buildUpdateOrderCall({
  chainId = GMX_CHAIN_ID,
  key,
  sizeDeltaUsd,
  acceptablePrice,
  triggerPrice,
  minOutputAmount = 0n,
  validFromTime = 0n,
  autoCancel = true,
}) {
  const gmx = requireGmx(chainId)
  return {
    target: gmx.exchangeRouter,
    data: callData(EXCHANGE_ROUTER, 'updateOrder', [
      requireBytes32(key, 'key'),
      toUsdUnits(sizeDeltaUsd, 'sizeDeltaUsd'),
      toUsdUnits(acceptablePrice, 'acceptablePrice'),
      toUsdUnits(triggerPrice, 'triggerPrice'),
      requireUint(minOutputAmount, 'minOutputAmount'),
      requireUint(validFromTime, 'validFromTime'),
      requireBoolean(autoCancel, 'autoCancel'),
    ]),
    value: 0n,
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Execution fee — GMX's DataStore keys, the estimate, and the live read
 *
 * EVERY GMX ORDER IS SETTLED BY A KEEPER THE MEMBER PAYS FOR. `createOrder` validates the declared
 * `executionFee` against GMX's own arithmetic at creation time
 * (`OrderUtils.createOrder` → `GasUtils.validateAndCapExecutionFee` → `validateExecutionFee`, which
 * reverts `InsufficientExecutionFee(minExecutionFee, executionFee)`), so a fee this app invents is
 * not a cosmetic number: too low and the member's signed close REVERTS or never runs; too high and
 * — see the buffer below — the surplus comes back.
 *
 * THE KEYS ARE READ FROM THE CHAIN, NOT TRANSCRIBED FROM A GUIDE. GMX's DataStore is a flat
 * `bytes32 → uint256` map, so the name is the only thing standing between a read and the wrong
 * number. Each constant below was derived as `keccak256(abi.encode("<NAME>"))` and `eth_call`ed
 * against the deployed Arbitrum DataStore 0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8 on
 * **2026-08-12** (block 493,775,585). What it answered:
 *
 *   ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1   0x39288f22…  →             207,024
 *   ESTIMATED_GAS_FEE_PER_ORACLE_PRICE   0xf9591537…  →             525,368
 *   ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR  0xce135f2a…  → 1.584563439287042e30  (≈ ×1.5846)
 *   INCREASE_ORDER_GAS_LIMIT             0x983e0a7f…  →           3,000,000
 *   DECREASE_ORDER_GAS_LIMIT             0xfce7a344…  →           3,000,000
 *   SINGLE_SWAP_GAS_LIMIT                0x3be28fb3…  →           1,000,000
 *
 * > **THE TRAP THAT "A WRONG KEY RETURNS 0" DOES NOT CATCH.** `keccak256(abi.encode(
 * > INCREASE_ORDER_GAS_LIMIT))` — the DOUBLE hash, which older GMX releases' getters used — is
 * > `0x05f62d77…` and the live DataStore answers **4,000,000** for it, not zero. Two plausible
 * > keys, two different non-zero answers, and the usual "a mis-derived key reads as 0" heuristic
 * > discriminates neither. The flat constant is the right one:
 * > `Keys.increaseOrderGasLimitKey()` returns `INCREASE_ORDER_GAS_LIMIT` directly
 * > (gmx-synthetics `contracts/data/Keys.sol` L246/L655), so the value GMX itself validates
 * > against is 3,000,000. Re-check the SOURCE, not just the store, before changing a key here.
 *
 * The formula is GMX's own (`GasUtils.adjustGasLimitForEstimate` + `estimateExecuteOrderGasLimit` +
 * `estimateOrderOraclePriceCount`), reproduced in `estimateExecutionFee` below.
 * ------------------------------------------------------------------------------------------- */

/** A DataStore key: `keccak256(abi.encode("<NAME>"))`, the derivation `feeUnits.js` uses for the UI fee. */
function dataStoreKey(name) {
  return keccak256(encodeAbiParameters([{ type: 'string' }], [name]))
}

/** `Keys.ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1` — the flat base, before the per-oracle term. */
export const GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY = dataStoreKey('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1')
/** `Keys.ESTIMATED_GAS_FEE_PER_ORACLE_PRICE` — charged once per oracle price the keeper must post. */
export const GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY = dataStoreKey('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE')
/** `Keys.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR` — 1e30 fixed point, applied to the order's own limit. */
export const GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY = dataStoreKey('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR')
/** `Keys.increaseOrderGasLimitKey()` — opening or adding. THE FLAT CONSTANT; see the trap above. */
export const GMX_INCREASE_ORDER_GAS_LIMIT_KEY = dataStoreKey('INCREASE_ORDER_GAS_LIMIT')
/** `Keys.decreaseOrderGasLimitKey()` — closing, reducing, AND both protection legs. */
export const GMX_DECREASE_ORDER_GAS_LIMIT_KEY = dataStoreKey('DECREASE_ORDER_GAS_LIMIT')
/** `Keys.singleSwapGasLimitKey()` — per swap hop. This feature never swaps, so it is read only if asked. */
export const GMX_SINGLE_SWAP_GAS_LIMIT_KEY = dataStoreKey('SINGLE_SWAP_GAS_LIMIT')

/**
 * Which per-order-type gas limit an order draws on.
 *
 * Every EXIT is a decrease — `MarketDecrease` for a close or reduce, `StopLossDecrease` /
 * `LimitDecrease` for protection — so one read serves the whole exit path.
 */
export const GMX_ORDER_KIND = Object.freeze({ INCREASE: 'increase', DECREASE: 'decrease' })

const ORDER_GAS_LIMIT_KEY_BY_KIND = Object.freeze({
  [GMX_ORDER_KIND.INCREASE]: GMX_INCREASE_ORDER_GAS_LIMIT_KEY,
  [GMX_ORDER_KIND.DECREASE]: GMX_DECREASE_ORDER_GAS_LIMIT_KEY,
})

/** The order-gas-limit key for a kind, or null for a word this module does not know. */
export function orderGasLimitKeyFor(kind) {
  return ORDER_GAS_LIMIT_KEY_BY_KIND[kind] ?? null
}

/** GMX's `Precision.applyFactor` — `value × factor / 1e30`. Total: junk in → null out. */
export function applyFactor(value, factor) {
  const v = toUnsigned(value)
  const f = toUnsigned(factor)
  if (v === null || f === null) return null
  return (v * f) / GMX_FLOAT_PRECISION
}

/**
 * The keeper execution fee for one order, per venue-calldata.md and GMX's `GasUtils`:
 *
 *   estimatedGasLimit = orderGasLimit + singleSwapGasLimit × swapPath.length   (callbackGasLimit is 0)
 *   gasLimit          = baseGasLimit + gasPerOraclePrice × (3 + swapPath.length)
 *                       + applyFactor(estimatedGasLimit, multiplierFactor)
 *   fee               = gasLimit × gasPrice, plus `bufferBps`
 *
 * Every GMX-sourced input is REQUIRED and none is defaulted: `baseGasLimit`, `gasPerOraclePrice`,
 * `orderGasLimit` and `multiplierFactor` all live in GMX's DataStore and change with the venue's
 * own configuration. Inventing a fallback for one would put a fabricated number in front of a
 * member, so a missing input returns null and the caller discloses that the fee is unknown. A
 * `swapPathLength` above zero without a `singleSwapGasLimit` is the same kind of hole — the swap
 * hops would raise the oracle-price count while contributing no gas — so it returns null too,
 * rather than an estimate that is quietly short by a hop.
 *
 * The result is biased HIGH by `bufferBps` on purpose — see `GMX_EXECUTION_FEE_BUFFER_BPS`:
 * overpaying is refunded, underpaying cancels the order after the member has signed.
 *
 * → `{ gasLimit, oraclePriceCount, gasPrice, baseFee, fee, bufferBps }` or null.
 */
export function estimateExecutionFee(input) {
  // Destructured INSIDE the body, from `?? {}`: a parameter-list default only covers `undefined`, and
  // the DataStore constants this reads arrive asynchronously — `estimateExecutionFee(gasParams)` with
  // `gasParams` still null is the normal first render, not an error, and must yield null not a throw.
  const {
    gasPrice,
    baseGasLimit,
    gasPerOraclePrice,
    orderGasLimit,
    multiplierFactor,
    singleSwapGasLimit = null,
    swapPathLength = 0,
    bufferBps = GMX_EXECUTION_FEE_BUFFER_BPS,
  } = input ?? {}
  const price = toUnsigned(gasPrice)
  const base = toUnsigned(baseGasLimit)
  const perOracle = toUnsigned(gasPerOraclePrice)
  const orderGas = toUnsigned(orderGasLimit)
  const factor = toUnsigned(multiplierFactor)
  const buffer = toUnsigned(bufferBps)
  if (price === null || base === null || perOracle === null || orderGas === null || factor === null) return null
  if (buffer === null) return null
  if (!Number.isInteger(swapPathLength) || swapPathLength < 0) return null
  const swapGas = swapPathLength === 0 ? 0n : toUnsigned(singleSwapGasLimit)
  if (swapGas === null) return null

  const oraclePriceCount = GMX_ORACLE_PRICE_COUNT_BASE + swapPathLength
  const estimatedGasLimit = orderGas + swapGas * BigInt(swapPathLength)
  const gasLimit = base + perOracle * BigInt(oraclePriceCount) + (estimatedGasLimit * factor) / GMX_FLOAT_PRECISION
  const baseFee = gasLimit * price
  return {
    gasLimit,
    oraclePriceCount,
    gasPrice: price,
    baseFee,
    fee: baseFee + (baseFee * buffer) / BPS_DENOMINATOR,
    bufferBps: Number(buffer),
  }
}

/**
 * The network's current gas price, or null.
 *
 * `eth_gasPrice` is what `tx.gasprice` will be on Arbitrum, which is the number GMX validates
 * against; the EIP-1559 ceiling is only a fallback and is never below it. ethers' `getFeeData`
 * answered both in one round trip and viem splits them, so the fallback costs a second call — and
 * is only paid when the first had nothing to say. A gas price of ZERO is passed through rather than
 * fallen back from, because `readExecutionFee`'s zero rule must see it: a chain answering 0 is an
 * unreadable venue, not an invitation to substitute a different number.
 */
async function defaultGasPrice(client) {
  const direct = toUnsigned(await client.getGasPrice().catch(() => null))
  if (direct !== null) return direct
  const fees = await client.estimateFeesPerGas().catch(() => null)
  return toUnsigned(fees?.maxFeePerGas)
}

/**
 * The DataStore read handle. `chainId` is the trailing argument rather than a property of the
 * client, so the chain a read lands on is named at the call site (spec 110) and an injected fake
 * keeps the shape it always had.
 */
function defaultMakeDataStore(address, abi, client, chainId) {
  return { getUint: (key) => readContract(chainId, { address, abi, functionName: 'getUint', args: [key] }) }
}

/**
 * THE PRODUCER. Reads GMX's own gas configuration plus the network's gas price and returns the
 * execution fee to attach to one order, in WEI.
 *
 * Everything is injectable (`getClient` / `makeContract` / `getGasPrice`), so the estimate is
 * exercised with no network — the `venueStatus.js` convention. The client comes from
 * `lib/chains/publicClient` so the member's own endpoint, headers and failover apply (spec 069);
 * never hand-build one from `NETWORKS[chainId].rpcUrl`.
 *
 * **A ZERO FROM ANY OF THE FOUR CONSTANTS IS TREATED AS AN UNREADABLE VENUE, NOT AS ZERO GAS.**
 * GMX has never configured one of these at zero, and a zero `multiplierFactor` or `orderGasLimit`
 * deletes the dominant term of the fee — which is precisely the shape a mis-derived key or a wrong
 * DataStore address produces. Refusing here means the sheet says the fee could not be read and
 * points at GMX's own app, instead of asking a member to sign an order that cannot execute.
 *
 * TOTAL: it runs inside an effect, so every failure — no GMX on this chain, no read connection, a
 * reverting call, a dropped connection — is `null`, never a throw and never a guess.
 *
 * → `{ chainId, orderKind, fee, baseFee, gasLimit, gasPrice, oraclePriceCount, bufferBps }` or null.
 */
export async function readExecutionFee(input) {
  const {
    chainId = GMX_CHAIN_ID,
    orderKind = GMX_ORDER_KIND.DECREASE,
    swapPathLength = 0,
    bufferBps = GMX_EXECUTION_FEE_BUFFER_BPS,
    addressesFor = gmxAddressesFor,
    getClient = getPublicClient,
    makeContract = defaultMakeDataStore,
    getGasPrice = defaultGasPrice,
  } = input ?? {}

  const orderKey = orderGasLimitKeyFor(orderKind)
  if (!orderKey) return null
  if (!Number.isInteger(swapPathLength) || swapPathLength < 0) return null

  try {
    const addresses = addressesFor(chainId)
    if (!addresses?.dataStore) return null // GMX is not deployed here — absence, not a failed read
    // The client is the availability gate: no endpoint configured for this chain is a different
    // fact from a read that failed, and it costs nothing to establish before any round trip.
    const client = getClient(chainId)
    if (!client) return null

    const store = makeContract(addresses.dataStore, GMX_DATA_STORE_ABI, client, chainId)
    const [baseGasLimit, gasPerOraclePrice, multiplierFactor, orderGasLimit, singleSwapGasLimit, gasPrice] =
      await Promise.all([
        store.getUint(GMX_ESTIMATED_GAS_FEE_BASE_AMOUNT_KEY),
        store.getUint(GMX_ESTIMATED_GAS_FEE_PER_ORACLE_PRICE_KEY),
        store.getUint(GMX_ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR_KEY),
        store.getUint(orderKey),
        // Not read at all when nothing swaps — this feature's swapPath is always empty, and an
        // extra call is an extra way for the read to fail for no gain.
        swapPathLength > 0 ? store.getUint(GMX_SINGLE_SWAP_GAS_LIMIT_KEY) : 0n,
        getGasPrice(client),
      ])

    const required = [baseGasLimit, gasPerOraclePrice, multiplierFactor, orderGasLimit, gasPrice]
    if (swapPathLength > 0) required.push(singleSwapGasLimit)
    for (const value of required) {
      const n = toUnsigned(value)
      if (n === null || n === 0n) return null // see the zero rule above
    }

    const estimate = estimateExecutionFee({
      gasPrice,
      baseGasLimit,
      gasPerOraclePrice,
      orderGasLimit,
      multiplierFactor,
      singleSwapGasLimit,
      swapPathLength,
      bufferBps,
    })
    if (!estimate || estimate.fee <= 0n) return null
    return { chainId: Number(chainId), orderKind, ...estimate }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Reading — Reader positions and the EventEmitter filter
 * ------------------------------------------------------------------------------------------- */

/**
 * `Position.getPositionKey` — `keccak256(abi.encode(account, market, collateralToken, isLong))`.
 *
 * The ACCOUNT in this hash is `msg.sender` of `createOrder`. It is the concrete reason no field in
 * `CreateOrderParams` can redirect ownership: a different receiver produces the same key, so it
 * addresses the same member's position.
 *
 * Total: junk in → null out.
 */
export function positionKey(account, market, collateralToken, isLong) {
  try {
    return keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bool' }],
        [getAddress(account), getAddress(market), getAddress(collateralToken), Boolean(isLong)],
      ),
    )
  } catch {
    return null
  }
}

/**
 * `Reader.getAccountPositions` → normalized position objects.
 *
 * Accepts either the decoded read result or the raw returndata hex, so a caller that already has
 * a decoded result and one that has bytes both land here rather than each rolling their own.
 *
 * TOTAL: an empty array for junk, and an unreadable ROW is dropped rather than emitted with holes —
 * an account with no positions returns a clean empty array from GMX, so absence is never an error
 * and must never render as a failed read. Values stay in VENUE units (`sizeInUsd` 1e30,
 * `sizeInTokens` in the index token's decimals, collateral in the collateral token's) and are
 * scaled for display by the caller, never re-derived here.
 */
export function decodeAccountPositions(readerResult) {
  const rows = positionRows(readerResult)
  if (!rows) return []
  const out = []
  for (const row of rows) {
    const position = decodePosition(row)
    if (position) out.push(position)
  }
  return out
}

function positionRows(readerResult) {
  if (typeof readerResult === 'string') {
    try {
      // `getAccountPositions` has ONE output, and viem hands a single output back directly where
      // ethers wrapped it in a Result — so there is no array to destructure off the front. Taking
      // `[0]` here would yield the first POSITION and then `Array.from` its three tuples.
      return Array.from(decodeFunctionResult({ abi: READER, functionName: 'getAccountPositions', data: readerResult }))
    } catch {
      return null
    }
  }
  if (readerResult == null || typeof readerResult !== 'object') return null
  try {
    return Array.from(readerResult)
  } catch {
    return null
  }
}

/**
 * viem decodes a named tuple into an OBJECT (`{ addresses, numbers, flags }`) and has no positional
 * access at all; ethers' `Result` had both; a plain array fixture only the index. Reading by name
 * FIRST is therefore the production path as well as the honest one — it keeps the field mapping
 * correct even if the tuple ever gains a member — and the positional fallback keeps test fixtures
 * from having to fake a decode.
 */
function at(tuple, name, index) {
  if (tuple == null) return undefined
  try {
    const named = tuple[name]
    if (named !== undefined) return named
  } catch {
    /* Result throws on an unknown name — fall through to the index */
  }
  try {
    return tuple[index]
  } catch {
    return undefined
  }
}

function decodePosition(row) {
  const addresses = at(row, 'addresses', 0)
  const numbers = at(row, 'numbers', 1)
  const flags = at(row, 'flags', 2)
  const account = toAddress(at(addresses, 'account', 0))
  const market = toAddress(at(addresses, 'market', 1))
  const collateralToken = toAddress(at(addresses, 'collateralToken', 2))
  const sizeInUsd = toUnsigned(at(numbers, 'sizeInUsd', 0))
  if (!account || !market || !collateralToken || sizeInUsd === null) return null
  const isLong = Boolean(at(flags, 'isLong', 0))
  return {
    key: positionKey(account, market, collateralToken, isLong),
    account,
    market,
    collateralToken,
    isLong,
    sizeInUsd,
    sizeInTokens: toUnsigned(at(numbers, 'sizeInTokens', 1)),
    collateralAmount: toUnsigned(at(numbers, 'collateralAmount', 2)),
    // int256 and routinely negative — decoding it unsigned turns a small debit into ~2^256.
    pendingImpactAmount: toSigned(at(numbers, 'pendingImpactAmount', 3)),
    borrowingFactor: toUnsigned(at(numbers, 'borrowingFactor', 4)),
    fundingFeeAmountPerSize: toUnsigned(at(numbers, 'fundingFeeAmountPerSize', 5)),
    longTokenClaimableFundingAmountPerSize: toUnsigned(at(numbers, 'longTokenClaimableFundingAmountPerSize', 6)),
    shortTokenClaimableFundingAmountPerSize: toUnsigned(at(numbers, 'shortTokenClaimableFundingAmountPerSize', 7)),
    // TIMESTAMPS in seconds, not block numbers — earlier GMX releases carried blocks in these slots.
    increasedAtTime: toSeconds(at(numbers, 'increasedAtTime', 8)),
    decreasedAtTime: toSeconds(at(numbers, 'decreasedAtTime', 9)),
  }
}

/** The `EventLog2` topic — every order event GMX emits shares it. */
export const GMX_EVENT_LOG2_TOPIC = toEventSelector(
  EVENT_EMITTER.find((item) => item.type === 'event' && item.name === 'EventLog2'),
)

/**
 * The log filter for one member's order events.
 *
 * `EventLog2` carries three indexed topics: `eventNameHash`, `topic1` (the order key) and `topic2`
 * (`Cast.toBytes32(account)` — the member's address left-padded to 32 bytes). Filtering on topic2 is
 * what makes "this member's orders" a node-side query instead of a full scan; topic1 is left open
 * because we want every order, not one known key.
 *
 * TOTAL: null for a bad address or a chain without GMX, so an effect can branch instead of throwing.
 *
 * → `{ address, topics }` — a raw `eth_getLogs` filter, ready for the read seam's log scan.
 */
export function eventTopicsForAccount(account, options) {
  // `?? {}` inside the body — an explicit null options object must degrade, not throw (see above).
  const { chainId = GMX_CHAIN_ID, eventNames = GMX_ORDER_EVENT_NAMES } = options ?? {}
  if (typeof account !== 'string' || !isAddress(account)) return null
  const gmx = gmxAddressesFor(chainId)
  if (!gmx) return null
  const names = Array.isArray(eventNames) ? eventNames.filter((name) => typeof name === 'string' && name !== '') : []
  return {
    address: gmx.eventEmitter,
    topics: [
      GMX_EVENT_LOG2_TOPIC,
      // An indexed string is topic'd as keccak(bytes(name)); an array here is an OR filter.
      names.length ? names.map((name) => keccak256(toHex(name))) : null,
      null, // topic1 = the order key
      pad(getAddress(account).toLowerCase(), { size: 32 }),
    ],
  }
}

/**
 * One raw `EventLog2` log → the flat order event `orderState.js`'s `gmxEventSignal` consumes:
 * `{ eventName, key, account, reason, msgSender }`.
 *
 * GMX emits EVERY order event through the single EventEmitter as an `EventLog2` whose real payload
 * is nested inside the `EventLogData` key/value bag, so "which event is this" is not the log's topic0
 * — topic0 is `EventLog2` for all of them. The discriminator is the `eventName` STRING in the data
 * (`eventNameHash` is its indexed twin and comes back as a hash, not the name).
 *
 * `reason` is pulled out of `stringItems` because that is where GMX puts its own words for a
 * cancellation or a freeze ("OrderNotFulfillableAtAcceptablePrice"). It is passed through verbatim —
 * translating it would mean inventing a cause we have not confirmed (FR-008).
 *
 * `account` is returned as the raw bytes32 topic (`Cast.toBytes32(account)`), NOT narrowed to an
 * address: `gmxEventSignal` compares the trailing 20 bytes itself, and re-formatting it here would
 * be a second place to get that padding wrong.
 *
 * TOTAL: it runs over arbitrary logs inside an effect, so a log from another contract, a non-order
 * event, or malformed data returns null rather than taking the sheet down.
 */
export function decodeOrderEvent(log) {
  const topics = Array.isArray(log?.topics) ? log.topics : null
  if (!topics?.length) return null
  if (String(topics[0]).toLowerCase() !== GMX_EVENT_LOG2_TOPIC.toLowerCase()) return null
  let parsed
  try {
    parsed = decodeEventLog({ abi: EVENT_EMITTER, topics: [...topics], data: log.data ?? '0x' })
  } catch {
    return null
  }
  if (parsed?.eventName !== 'EventLog2') return null
  const eventName = typeof parsed.args?.eventName === 'string' ? parsed.args.eventName : null
  // Not one of ours — a position/market event sharing the emitter, not an order event.
  if (!eventName || !GMX_ORDER_EVENT_NAMES.includes(eventName)) return null
  return {
    eventName,
    key: parsed.args.topic1,
    account: parsed.args.topic2,
    reason: stringEventItem(parsed.args.eventData, 'reason'),
    msgSender: parsed.args.msgSender,
  }
}

/** One `stringItems` entry out of an `EventLogData` bag, or null. Never throws on a shape change. */
function stringEventItem(eventData, key) {
  try {
    for (const item of eventData?.stringItems?.items ?? []) {
      if (item?.key === key && typeof item.value === 'string' && item.value !== '') return item.value
    }
  } catch {
    /* an unexpected bag shape is "no reason", never a crash */
  }
  return null
}

/* ------------------------------------------------------------------------------------------- *
 * Total coercions (decoder side)
 * ------------------------------------------------------------------------------------------- */

function toUnsigned(value) {
  const n = toSigned(value)
  return n === null || n < 0n ? null : n
}

function toSigned(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : null
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim())
  return null
}

function toAddress(value) {
  if (typeof value !== 'string' || !isAddress(value)) return null
  const addr = getAddress(value)
  return addr === zeroAddress ? null : addr
}

function toSeconds(value) {
  const n = toUnsigned(value)
  return n === null ? null : Number(n)
}
