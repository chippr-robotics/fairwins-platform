/**
 * Gains Network (gTrade v10) calldata (spec 083, T013).
 *
 * Every builder returns a `{ target, data, value }` call object — the shape
 * `WalletContext.sendCalls` consumes (the `lib/earn/vaultActions.js` convention), so a passkey
 * session authorizes an approve + open batch with one ceremony and a classic wallet signs them in
 * order. FairWins builds calldata and nothing else: the member's own wallet is always `msg.sender`,
 * and on Gains there is no ownership parameter to get wrong — `Trade.user` is overwritten to
 * `_msgSender()` by the venue.
 *
 * THE INDEX TRAP (contracts/venue-calldata.md). Two disjoint index spaces share the type `uint32`:
 * a PENDING-ORDER index (`MarketOrderInitiated.orderId.index`, consumed only by
 * `cancelOrderAfterTimeout`) and a TRADE index (`MarketExecuted.index` / `getTrades[].index`,
 * consumed by everything else). Passing one where the other belongs acts on a DIFFERENT OBJECT —
 * it does not revert, it succeeds against someone else's meaning of that number. That is why the
 * two are branded types here and a raw number is refused at every boundary: the only way to obtain
 * a branded index is to name which space it came from.
 *
 * SCALES. leverage and slippage are 1e3 (10x = 10_000; 1% = 1_000); prices are 1e10;
 * `collateralAmount` is in the COLLATERAL TOKEN'S OWN DECIMALS (USDC = 1e6, resolved by the caller
 * from `getCollateral(index).precision`) — which is why token amounts here are strictly `bigint`
 * and a JS number is refused: a number is the tell of a human-unit value that would encode as dust.
 *
 * Builders THROW on a malformed input rather than returning a sentinel. They never run during
 * render — they run when a member is about to sign — and a silently-wrong call object would reach
 * the wallet with the member's collateral attached. The event decoders below are the opposite:
 * they run over arbitrary logs in effects, so they are total and return null.
 */
import { decodeEventLog, encodeEventTopics, encodeFunctionData, parseUnits, zeroAddress } from 'viem'
// Not viem's `isAddress`: neither of its settings reproduces ethers' (see the seam's table).
import { getAddress, isAddress } from '../../evm/address'
import { normalizeAbi } from '../../chains/readContract'
import { GAINS_DIAMOND_ABI, GAINS_CANCEL_REASON, GAINS_TRADE_TYPE } from '../../../abis/perps/gainsDiamond'
import { gainsDiamondFor } from '../../../config/perps'

const DIAMOND_ABI = normalizeAbi(GAINS_DIAMOND_ABI)

/** Exact-amount approvals only — the repo never grants an unlimited allowance for collateral. */
const ERC20_APPROVE_ABI = ['function approve(address spender, uint256 value) returns (bool)']
const ERC20_ABI = normalizeAbi(ERC20_APPROVE_ABI)

/** Decimal places behind each venue scale. A missing factor here is a 1000x order. */
const PRICE_DECIMALS = 10
const LEVERAGE_DECIMALS = 3
const SLIPPAGE_DECIMALS = 3

/**
 * The venue SDK's default closing slippage, in PERCENT (encoded as 1 * 1e3). Exported so the sheet
 * shows the same tolerance the venue's own app would apply rather than inventing one.
 */
export const GAINS_DEFAULT_CLOSING_SLIPPAGE_P = 1

/* ------------------------------------------------------------------------------------------- *
 * The two index spaces
 * ------------------------------------------------------------------------------------------- */

const TRADE_BRAND = 'gains:tradeIndex'
const PENDING_ORDER_BRAND = 'gains:pendingOrderIndex'

/** Thrown when a raw number, or an index from the wrong space, reaches a builder. */
export class GainsIndexSpaceError extends TypeError {
  constructor(message) {
    super(message)
    this.name = 'GainsIndexSpaceError'
  }
}

function brand(kind, label, value) {
  const n = Number(value) // uint32 fits a JS number exactly, so this is lossless for a valid index
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new GainsIndexSpaceError(`${label} must be a uint32, received ${String(value)}`)
  }
  // Frozen so a caller cannot re-label an index into the other space after the fact.
  return Object.freeze({ __gainsIndexSpace: kind, value: n })
}

/** A TRADE index — from `getTrades[].index` / `MarketExecuted.index`. */
export function tradeIndex(value) {
  return brand(TRADE_BRAND, 'trade index', value)
}

/** A PENDING-ORDER index — from `getPendingOrders[].index` / `MarketOrderInitiated.orderId.index`. */
export function pendingOrderIndex(value) {
  return brand(PENDING_ORDER_BRAND, 'pending-order index', value)
}

export function isTradeIndex(value) {
  return value?.__gainsIndexSpace === TRADE_BRAND
}

export function isPendingOrderIndex(value) {
  return value?.__gainsIndexSpace === PENDING_ORDER_BRAND
}

function requireTradeIndex(value, fn) {
  if (isTradeIndex(value)) return value.value
  if (isPendingOrderIndex(value)) {
    throw new GainsIndexSpaceError(
      `${fn} takes a trade index; received a pending-order index (${value.value}). ` +
        'The two are different objects — only cancelOrderAfterTimeout takes a pending-order index.',
    )
  }
  throw new GainsIndexSpaceError(
    `${fn} takes a trade index built with tradeIndex(); received ${describe(value)}.`,
  )
}

function requirePendingOrderIndex(value, fn) {
  if (isPendingOrderIndex(value)) return value.value
  if (isTradeIndex(value)) {
    throw new GainsIndexSpaceError(
      `${fn} takes a pending-order index; received a trade index (${value.value}). ` +
        'Cancelling by trade index would act on a different order.',
    )
  }
  throw new GainsIndexSpaceError(
    `${fn} takes a pending-order index built with pendingOrderIndex(); received ${describe(value)}.`,
  )
}

function describe(value) {
  if (value === null) return 'null'
  if (typeof value === 'object') return 'an unbranded object'
  return `a raw ${typeof value} (${String(value)})`
}

/* ------------------------------------------------------------------------------------------- *
 * Scaling
 * ------------------------------------------------------------------------------------------- */

/**
 * Human units → venue fixed-point. A `bigint` passes through UNCHANGED because it is already in
 * venue units — that is how a value read back from the diamond (a stored `tp` at 1e10, say) is
 * re-sent without a round trip through a float.
 */
function toFixedPoint(value, decimals, label) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`)
    if (value < 0) throw new RangeError(`${label} cannot be negative`)
    // toFixed both expands exponent notation and bounds the fraction to what the scale can hold.
    return parseUnits(value.toFixed(decimals), decimals)
  }
  if (typeof value === 'string') {
    const s = value.trim()
    if (!/^\d+(\.\d+)?$/.test(s)) throw new RangeError(`${label} must be a non-negative decimal, received "${value}"`)
    const [whole, frac = ''] = s.split('.')
    // Truncate rather than round: below the venue's precision is the member's side of the line.
    return parseUnits(`${whole}.${frac.slice(0, decimals) || '0'}`, decimals)
  }
  throw new RangeError(`${label} is required`)
}

/** Price in 1e10 venue units. */
function toPriceUnits(value, label) {
  return toFixedPoint(value, PRICE_DECIMALS, label)
}

/** Optional price (tp/sl): absent means 0, the venue's own "not set". */
function toOptionalPriceUnits(value, label) {
  if (value == null || value === '') return 0n
  return toPriceUnits(value, label)
}

/** Leverage in 1e3 venue units (10x → 10_000). */
function toLeverageUnits(value, label) {
  return toFixedPoint(value, LEVERAGE_DECIMALS, label)
}

/** Slippage percent in 1e3 venue units (1% → 1_000). */
function toSlippageUnits(value, label) {
  return toFixedPoint(value, SLIPPAGE_DECIMALS, label)
}

/**
 * Token amounts are `bigint` only. A JS number here would almost always be a human-unit amount
 * (10 meaning 10 USDC) which encodes as 10 base units — an order the member never intended.
 */
function requireTokenAmount(value, label) {
  if (typeof value !== 'bigint') {
    throw new TypeError(
      `${label} must be a bigint in the collateral token's own decimals ` +
        '(resolve the scale from getCollateral(index).precision)',
    )
  }
  if (value < 0n) throw new RangeError(`${label} cannot be negative`)
  return value
}

function requireAddress(value, label) {
  if (typeof value !== 'string' || !isAddress(value)) {
    throw new TypeError(`${label} must be an address, received ${describe(value)}`)
  }
  const addr = getAddress(value)
  if (addr === zeroAddress) throw new TypeError(`${label} cannot be the zero address`)
  return addr
}

function requireUint(value, max, label) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new RangeError(`${label} must be an integer in [0, ${max}], received ${String(value)}`)
  }
  return n
}

/**
 * The diamond for a chain — call target AND approval target, because the diamond pulls the
 * collateral itself. Throws where Gains is not deployed: a call object with a null target would be
 * a transaction to the zero address carrying the member's collateral.
 */
function requireDiamond(chainId) {
  const diamond = gainsDiamondFor(chainId)
  if (!diamond) throw new Error(`Gains is not deployed on chain ${String(chainId)}`)
  return diamond
}

/* ------------------------------------------------------------------------------------------- *
 * Builders
 * ------------------------------------------------------------------------------------------- */

/**
 * `approve(diamond, amount)` on the COLLATERAL TOKEN.
 *
 * The spender is the diamond — the same address the trade call goes to. Gains has no separate
 * router to confuse it with (unlike GMX, where the approval target is NOT the call target), and no
 * FairWins address may ever be approved for perps collateral.
 */
export function buildApprovalCall({ chainId, token, amount }) {
  const diamond = requireDiamond(chainId)
  const collateral = requireAddress(token, 'token')
  const value = requireTokenAmount(amount, 'amount')
  return {
    target: collateral,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [diamond, value] }),
    value: 0n,
  }
}

/**
 * `openTrade(Trade, _maxSlippageP, _referrer)`.
 *
 * `trader` is written into `Trade.user`. The venue overwrites it with `_msgSender()`, and
 * `index` / `positionSizeToken` with 0 — they are passed as the member and 0 anyway so the
 * calldata is honest about who it is for and the ownership assertion has something to check.
 * `_referrer` is the ONLY FairWins address in this calldata and it is not an ownership field; an
 * unset referrer degrades to the zero address rather than blocking the open (`registerPotentialReferrer`
 * is idempotent and never reverts).
 */
export function buildOpenTradeCall({
  chainId,
  trader,
  pairIndex,
  collateralIndex,
  collateralAmount,
  leverage,
  long,
  openPrice,
  tp = null,
  sl = null,
  maxSlippageP,
  referrer = null,
  tradeType = GAINS_TRADE_TYPE.TRADE,
  isCounterTrade = false,
}) {
  const diamond = requireDiamond(chainId)
  const user = requireAddress(trader, 'trader')
  const openPriceUnits = toPriceUnits(openPrice, 'openPrice')
  if (openPriceUnits <= 0n) throw new RangeError('openPrice must be greater than zero')
  const trade = [
    user, // 0 user — OVERWRITTEN to _msgSender(); never a FairWins address
    0, // 1 index — OVERWRITTEN
    requireUint(pairIndex, 0xffff, 'pairIndex'),
    toLeverageUnits(leverage, 'leverage'), // 1e3
    Boolean(long),
    true, // isOpen
    requireUint(collateralIndex, 0xff, 'collateralIndex'), // 1-BASED
    requireUint(tradeType, 0xff, 'tradeType'),
    requireTokenAmount(collateralAmount, 'collateralAmount'), // token decimals, NOT 1e18
    openPriceUnits, // 1e10
    toOptionalPriceUnits(tp, 'tp'), // 1e10, 0 = none
    toOptionalPriceUnits(sl, 'sl'), // 1e10, 0 = none
    Boolean(isCounterTrade),
    0, // 13 positionSizeToken — OVERWRITTEN
    0, // 14 __placeholder
  ]
  const slippage = toSlippageUnits(maxSlippageP, 'maxSlippageP') // 1e3
  const ref = referrer == null || referrer === '' ? zeroAddress : requireAddress(referrer, 'referrer')
  // THE OWNERSHIP INVARIANT, enforced rather than only asserted in a test. The venue overwrites
  // `Trade.user` with `_msgSender()`, so an open built for the FairWins referrer address means
  // FairWins holds the position — forbidden pattern 2 in venue-calldata.md. Both are checksummed by
  // `requireAddress`, so this compares addresses, not case.
  if (ref !== zeroAddress && ref === user) {
    throw new Error(
      'refusing to build a Gains open owned by the FairWins referrer address — Trade.user is ' +
        'overwritten to _msgSender(), so this would give FairWins the position (venue-calldata.md)',
    )
  }
  return {
    target: diamond,
    data: encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'openTrade', args: [trade, slippage, ref] }),
    value: 0n,
  }
}

/**
 * `closeTradeMarket(_index, _expectedPrice)`, optionally preceded by an explicit closing tolerance.
 *
 * `closeTradeMarket` carries NO slippage parameter — closing slippage is stored per trade. When the
 * member picks a tolerance we pair the two calls in ONE diamond `multicall`, exactly as the venue's
 * own SDK does; `multicall` is delegatecall-to-self, so the outer caller (the member) is preserved.
 * With no tolerance supplied, the bare close is emitted and the trade's stored slippage applies.
 *
 * `expectedPrice` must be positive: it is the reference the venue's slippage bound is computed
 * from, so a zero would produce a bound of zero and the keeper would cancel the close. Refusing to
 * build is more honest than handing the member a signature for an order that cannot execute.
 */
export function buildCloseTradeCall({ chainId, tradeIndex: index, expectedPrice, maxSlippageP = null }) {
  const diamond = requireDiamond(chainId)
  const idx = requireTradeIndex(index, 'closeTradeMarket')
  const price = toPriceUnits(expectedPrice, 'expectedPrice')
  if (price <= 0n) throw new RangeError('expectedPrice must be greater than zero')
  const close = encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'closeTradeMarket', args: [idx, price] })
  if (maxSlippageP == null) {
    return { target: diamond, data: close, value: 0n }
  }
  const slippage = encodeFunctionData({
    abi: DIAMOND_ABI,
    functionName: 'updateMaxClosingSlippageP',
    args: [idx, toSlippageUnits(maxSlippageP, 'maxSlippageP')],
  })
  return {
    target: diamond,
    data: encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'multicall', args: [[slippage, close]] }),
    value: 0n,
  }
}

/**
 * `decreasePositionSize(_index, _collateralDelta, _leverageDelta, _expectedPrice)` — a partial
 * exit. Either leg may be zero (reduce collateral at constant leverage, or reduce leverage at
 * constant collateral) but not both: a no-op would cost gas and revert.
 */
export function buildReducePositionCall({
  chainId,
  tradeIndex: index,
  collateralDelta = 0n,
  leverageDelta = 0,
  expectedPrice,
}) {
  const diamond = requireDiamond(chainId)
  const idx = requireTradeIndex(index, 'decreasePositionSize')
  const collateral = requireTokenAmount(collateralDelta, 'collateralDelta')
  const leverage = toLeverageUnits(leverageDelta, 'leverageDelta')
  if (collateral === 0n && leverage === 0n) {
    throw new RangeError('decreasePositionSize needs a collateralDelta or a leverageDelta')
  }
  const price = toPriceUnits(expectedPrice, 'expectedPrice')
  if (price <= 0n) throw new RangeError('expectedPrice must be greater than zero')
  return {
    target: diamond,
    data: encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'decreasePositionSize', args: [idx, collateral, leverage, price] }),
    value: 0n,
  }
}

/** `updateTp(_index, _newTp)` — a null/absent tp is 0, the venue's own "remove it". */
export function buildUpdateTpCall({ chainId, tradeIndex: index, tp }) {
  const diamond = requireDiamond(chainId)
  const idx = requireTradeIndex(index, 'updateTp')
  return {
    target: diamond,
    data: encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'updateTp', args: [idx, toOptionalPriceUnits(tp, 'tp')] }),
    value: 0n,
  }
}

/** `updateSl(_index, _newSl)` — a null/absent sl is 0, the venue's own "remove it". */
export function buildUpdateSlCall({ chainId, tradeIndex: index, sl }) {
  const diamond = requireDiamond(chainId)
  const idx = requireTradeIndex(index, 'updateSl')
  return {
    target: diamond,
    data: encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'updateSl', args: [idx, toOptionalPriceUnits(sl, 'sl')] }),
    value: 0n,
  }
}

/**
 * `cancelOrderAfterTimeout(_orderIndex)` — collateral recovery for a market order the keeper never
 * executed. It takes a PENDING-ORDER index and nothing else; a trade index here would target a
 * different order, so it is refused rather than encoded. Reverts on-chain with `WaitTimeout()`
 * before `createdBlock + getMarketOrdersTimeoutBlocks()`, `NoOrder()` once resolved.
 */
export function buildCancelOrderAfterTimeoutCall({ chainId, pendingOrderIndex: index }) {
  const diamond = requireDiamond(chainId)
  const idx = requirePendingOrderIndex(index, 'cancelOrderAfterTimeout')
  return {
    target: diamond,
    data: encodeFunctionData({ abi: DIAMOND_ABI, functionName: 'cancelOrderAfterTimeout', args: [idx] }),
    value: 0n,
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Event decoding — the only honest source of terminal order state
 * ------------------------------------------------------------------------------------------- */

/**
 * Member-facing text per `CancelReason`, from contracts/order-state-machine.md. Only the values the
 * venue actually emits on a cancelled open are mapped; anything else renders its number, because
 * inventing a cause for a code we have not confirmed would be a fabricated fact (FR-008).
 */
export const CANCEL_REASON_TEXT = Object.freeze({
  [GAINS_CANCEL_REASON.SLIPPAGE]: 'The price moved more than your slippage allowed.',
  [GAINS_CANCEL_REASON.EXPOSURE_LIMITS]: 'Gains is at its exposure limit for this pair right now.',
  [GAINS_CANCEL_REASON.PRICE_IMPACT]: "The trade's price impact was larger than allowed.",
  [GAINS_CANCEL_REASON.MAX_LEVERAGE]: 'The leverage exceeded what Gains allows for this pair.',
  [GAINS_CANCEL_REASON.NOT_HIT]: 'The trigger price was not reached.',
  [GAINS_CANCEL_REASON.LIQ_REACHED]: 'The position would have been liquidated immediately.',
})

/**
 * The four events that can terminate an order this module builds. `MarketOrderInitiated` is the
 * venue taking it, the next two are the two ways a market order ends, and the last is a recovery
 * executing.
 */
export const GAINS_ORDER_EVENT_NAMES = Object.freeze([
  'MarketOrderInitiated',
  'MarketExecuted',
  'MarketOpenCanceled',
  'CollateralReturnedAfterTimeout',
])

/**
 * The `getLogs` filter for the order events above, or null where Gains is not deployed.
 *
 * > **IT CANNOT FILTER BY MEMBER, and that is a property of the events, not an oversight.** The
 * > trader sits at a DIFFERENT indexed position in each event — `topic1` in `MarketOrderInitiated` /
 * > `MarketExecuted` / `MarketOpenCanceled`, but `topic2` in `CollateralReturnedAfterTimeout`
 * > (whose `topic1` is the collateral index). A single positional topic filter would therefore
 * > either drop one event or match on the wrong field. The member match happens after decoding
 * > instead — `orderState.js`'s `gainsEventSignal` refuses an event belonging to another trader or
 * > another order — so callers MUST pass their `account` in that context rather than assuming the
 * > node narrowed anything.
 *
 * Total: junk chain id → null, so an effect branches instead of throwing.
 */
export function orderEventFilter(chainId) {
  const diamond = gainsDiamondFor(chainId)
  if (!diamond) return null
  return {
    address: diamond,
    // A nested array is an OR over topic0 — any one of the four events.
    topics: [
      GAINS_ORDER_EVENT_NAMES.map(
        (name) => encodeEventTopics({ abi: DIAMOND_ABI, eventName: name })[0],
      ),
    ],
  }
}

/**
 * Total: the mapped sentence, or the bare code named as the venue's own. The fallback deliberately
 * makes no claim about WHY — it reports the number Gains gave us.
 */
export function cancelReasonText(reason) {
  // Guarded before Number(): Number(null) and Number('') are both 0, which would render the
  // "no reason" code as though the venue had reported one.
  if (reason == null || reason === '') return null
  const n = Number(reason)
  if (!Number.isInteger(n) || n < 0) return null
  return CANCEL_REASON_TEXT[n] ?? `Gains cancel reason ${n}`
}

/**
 * Decoders run over arbitrary logs in effects, so they are TOTAL: a log from another contract, a
 * different event, or malformed data returns null instead of taking the panel down.
 */
function parse(log, name) {
  try {
    const { eventName, args } = decodeEventLog({
      abi: DIAMOND_ABI,
      topics: [...(log?.topics ?? [])],
      data: log?.data ?? '0x',
    })
    // Shaped like the ethers parse result the decoders below read (`.name` / `.args`).
    return eventName === name ? { name: eventName, args } : null
  } catch {
    return null
  }
}

/** `MarketOrderInitiated` → venue_pending. Carries the PENDING-ORDER index, the only one recoverable. */
export function decodeMarketOrderInitiated(log) {
  const parsed = parse(log, 'MarketOrderInitiated')
  if (!parsed) return null
  const { orderId, trader, pairIndex, open } = parsed.args
  return {
    orderId: { user: orderId.user, index: Number(orderId.index) },
    pendingOrderIndex: pendingOrderIndex(orderId.index),
    trader,
    pairIndex: Number(pairIndex),
    open,
  }
}

/**
 * `MarketExecuted` → executed. The first moment fill price, actual size and liquidation price
 * exist; every number below is in VENUE units (prices 1e10, leverage 1e3, collateral in the token's
 * own decimals) and is scaled for display by the caller, never re-derived here.
 */
export function decodeMarketExecuted(log) {
  const parsed = parse(log, 'MarketExecuted')
  if (!parsed) return null
  const a = parsed.args
  const t = a.t
  return {
    orderId: { user: a.orderId.user, index: Number(a.orderId.index) },
    user: a.user,
    tradeIndex: tradeIndex(a.index),
    open: a.open,
    trade: {
      user: t.user,
      index: Number(t.index),
      pairIndex: Number(t.pairIndex),
      // Venue units (1e3), and a BIGINT like every other unscaled value here. Gains declares it
      // `uint24`, which ethers decoded to a bigint and viem decodes to a NUMBER — so the type is
      // stated rather than inherited from whichever decoder ran. Counters above stay numbers on
      // purpose; this is a value, and callers do bigint arithmetic with it.
      leverage: BigInt(t.leverage),
      long: t.long,
      isOpen: t.isOpen,
      collateralIndex: Number(t.collateralIndex),
      tradeType: Number(t.tradeType),
      collateralAmount: t.collateralAmount,
      openPrice: t.openPrice,
      tp: t.tp,
      sl: t.sl,
      isCounterTrade: t.isCounterTrade,
    },
    oraclePrice: a.oraclePrice,
    marketPrice: a.marketPrice,
    liqPrice: a.liqPrice,
    percentProfit: a.percentProfit,
    amountSentToTrader: a.amountSentToTrader,
    collateralPriceUsd: a.collateralPriceUsd,
  }
}

/**
 * `CollateralReturnedAfterTimeout` → the recovery `cancelOrderAfterTimeout` actually ran, and the
 * member's collateral is back. It carries the PENDING-ORDER index (the space the recovery call
 * consumes), never a trade index — the order it refers to never became a trade.
 *
 * The same event means OPPOSITE things to two different orders, which is why `orderState.js` reads
 * the tracked action rather than the event alone: to the recovery call it is that call executing; to
 * the original order it is the confirmation that the order never ran.
 */
export function decodeCollateralReturnedAfterTimeout(log) {
  const parsed = parse(log, 'CollateralReturnedAfterTimeout')
  if (!parsed) return null
  const { pendingOrderId, collateralIndex, trader, collateralAmount } = parsed.args
  return {
    orderId: { user: pendingOrderId.user, index: Number(pendingOrderId.index) },
    pendingOrderIndex: pendingOrderIndex(pendingOrderId.index),
    trader,
    collateralIndex: Number(collateralIndex),
    collateralAmount,
  }
}

/** `MarketOpenCanceled` → rejected, with the venue's own reason attached. */
export function decodeMarketOpenCanceled(log) {
  const parsed = parse(log, 'MarketOpenCanceled')
  if (!parsed) return null
  const { orderId, trader, pairIndex, cancelReason, collateralReturned } = parsed.args
  const reason = Number(cancelReason)
  return {
    orderId: { user: orderId.user, index: Number(orderId.index) },
    pendingOrderIndex: pendingOrderIndex(orderId.index),
    trader,
    pairIndex: Number(pairIndex),
    cancelReason: reason,
    cancelReasonText: cancelReasonText(reason),
    collateralReturned,
  }
}
