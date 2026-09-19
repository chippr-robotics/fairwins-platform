/**
 * usePerpsOrders (spec 083, T031, US4) — the member's PENDING and STUCK orders across venues.
 *
 * This is the data behind the recovery control, and it is ON THE EXIT PATH. Nothing here may
 * consult screening, the jurisdiction attestation, the management kill switch, or venue "may they
 * open" state: an order holding collateral in limbo with no visible control is indistinguishable
 * from lost money (US4), so the list is produced under every restriction the product has. The
 * module deliberately imports none of those gates — a sibling test asserts that over this file's
 * own source, the same way `test/perps/safetyInvariants.test.js` does for the lib modules.
 *
 * TWO SOURCES, ONE SHAPE:
 *
 *   - **Gains** pending orders arrive from the gateway (`/v1/perps/positions` → `pendingOrders`).
 *     A payload WITHOUT that key is read as "this gateway does not report them yet", NOT as "the
 *     member has none" — an older gateway build is an unread venue, and an absent key must never
 *     render as proven absence. The pending-order facet has its own readiness signal
 *     (`sources.gains.pendingOrderChains`), and `sources.gains.status` — which is the POSITIONS
 *     facet — is deliberately not consulted; see `loadGainsOrders`.
 *   - **GMX** frozen/pending orders are folded from the account's own `EventLog2` history on the
 *     app's read provider. That choice is deliberate and is written up in the header of
 *     `loadGmxOrders`.
 *
 * STATE IS NEVER RE-DERIVED HERE. Every order's state comes out of `lib/perps/orderState.js` —
 * the venue's events (or the venue's own pending-order storage) driven through the machine. This
 * hook decides *which* orders to show and *whether a recovery call exists*; it never decides what
 * a state means, and it never maps a receipt to `executed`.
 *
 * HONEST NUMBERS. A value the venue did not report is `null` and renders '—'. An unreadable venue
 * is named in `unreadableVenues` and contributes NO orders — so **an empty `orders` is proven
 * absence only when `unreadableVenues` is empty**. Callers must render that distinction.
 *
 * Conventions carried over from `usePerpsPositions.js`: a 60s poll, a request-id stale guard, a
 * synchronous hard reset before paint on account change, per-venue isolation, injectable deps.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { decodeEventLog } from 'viem'
import { normalizeAbi } from '../lib/chains/readContract'

import { GAINS_DIAMOND_ABI, GAINS_PENDING_ORDER_TYPE } from '../abis/perps/gainsDiamond'
import { GMX_EVENT_EMITTER_ABI, GMX_ORDER_TYPE } from '../abis/perps/gmxExchangeRouter'
import { gainsDiamondFor, gmxAddressesFor } from '../config/perps'
import { fetchPerpPositions } from '../lib/perps/perpsClient'
import {
  ORDER_STATE,
  SIGNAL,
  createOrderState,
  gainsTimeoutSignal,
  gmxEventSignal,
  isPendingState,
  orderStatusText,
  reduceOrderState,
} from '../lib/perps/orderState'
import {
  GainsIndexSpaceError,
  buildCancelOrderAfterTimeoutCall,
  isPendingOrderIndex,
  pendingOrderIndex,
} from '../lib/perps/venues/gains'
import {
  GMX_CHAIN_ID,
  buildCancelOrderCall,
  decodeOrderEvent,
  eventTopicsForAccount,
} from '../lib/perps/venues/gmx'
import { getPublicClient } from '../lib/chains/publicClient'
import { readContract } from '../lib/chains/readContract'

/** The portfolio cadence, matching `usePerpsPositions`. */
const POLL_MS = 60_000

/**
 * How far back the GMX log read looks.
 *
 * A window exists because `eth_getLogs` is range-limited by most endpoints (this repo has already
 * met a provider capping it at FIVE blocks), and Arbitrum produces blocks roughly four times a
 * second — an unbounded scan is not a read, it is a timeout. The consequence is disclosed rather
 * than hidden: `sources.gmx.windowed` is true and carries `fromBlock`/`lookbackBlocks`, so the
 * surface can say that an order frozen before that block is not listed here and point at GMX.
 * Overridable through `deps.lookbackBlocks`.
 */
export const GMX_ORDER_LOOKBACK_BLOCKS = 1_000_000

/**
 * The four events that move a GMX order between states. `OrderUpdated` and the auto-update events
 * are omitted from the FILTER as well as from the machine: they change an order's numbers, not its
 * state, and every log we do not ask for is one the endpoint does not have to return.
 */
const GMX_ORDER_LIFECYCLE_EVENTS = Object.freeze([
  'OrderCreated',
  'OrderExecuted',
  'OrderCancelled',
  'OrderFrozen',
])

/**
 * Per-venue read outcome, in the spec-071 estate vocabulary: a venue is `read`, `not-deployed`, or
 * `unreadable`, and orders exist only on `read`. There is no fourth state meaning "empty because
 * something went wrong" — that is what `unreadable` is for.
 */
export const ORDER_SOURCE_STATUS = Object.freeze({
  READ: 'read',
  NOT_DEPLOYED: 'not-deployed',
  UNREADABLE: 'unreadable',
})

/**
 * The pending-order types `cancelOrderAfterTimeout` actually REFUNDS (venue-calldata.md). Used for
 * copy only — never to withhold the control. The call is offered for any timed-out order carrying
 * a pending-order index, because a recovery that the venue might refuse is honest, while hiding
 * the attempt is the app standing between a member and their collateral.
 */
const GAINS_REFUNDING_ORDER_TYPES = Object.freeze([
  GAINS_PENDING_ORDER_TYPE.MARKET_OPEN,
  GAINS_PENDING_ORDER_TYPE.MARKET_PARTIAL_OPEN,
  GAINS_PENDING_ORDER_TYPE.UPDATE_LEVERAGE,
])

const GAINS_ORDER_TYPE_NAMES = reverseLookup(GAINS_PENDING_ORDER_TYPE)
const GMX_ORDER_TYPE_NAMES = reverseLookup(GMX_ORDER_TYPE)

const EVENT_EMITTER_ABI = normalizeAbi(GMX_EVENT_EMITTER_ABI)

/* ------------------------------------------------------------------------------------------- *
 * The hook
 * ------------------------------------------------------------------------------------------- */

export function usePerpsOrders(account, { deps } = {}) {
  const io = {
    fetchPositions: fetchPerpPositions,
    getProvider: defaultGetProvider,
    makeContract: defaultMakeContract,
    diamondFor: gainsDiamondFor,
    addressesFor: gmxAddressesFor,
    gmxChainId: GMX_CHAIN_ID,
    lookbackBlocks: GMX_ORDER_LOOKBACK_BLOCKS,
    ...deps,
  }

  // Deliberately NOT gated on `perpsAvailable()`. A missing gateway is a missing GAINS read, and
  // it says so per venue; it is not a reason to stop showing a member the GMX order they are
  // stuck in. Nothing but the absence of an account stops this hook running.
  const supported = Boolean(account)

  const [status, setStatus] = useState('idle') // 'idle' | 'loading' | 'ready' | 'unavailable'
  const [orders, setOrders] = useState([])
  const [sources, setSources] = useState({})
  const reqIdRef = useRef(0)
  const ioRef = useRef(io)
  useEffect(() => {
    ioRef.current = io
  })

  const load = useCallback(async (addr) => {
    if (!addr) {
      setStatus('idle')
      return
    }
    const reqId = ++reqIdRef.current
    const bag = ioRef.current

    // PER-VENUE ISOLATION. Both loaders are already total; `allSettled` is belt-and-braces over a
    // loader someone later wraps or replaces — one venue's failure may never blank the other's
    // stuck orders (FR-018), which on this path means never hiding a recovery control.
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => loadGainsOrders(addr, bag)),
      Promise.resolve().then(() => loadGmxOrders(addr, bag)),
    ])
    if (reqIdRef.current !== reqId) return // a newer request (or another account) owns the state

    const [gains, gmx] = settled.map((outcome, i) =>
      outcome.status === 'fulfilled' && outcome.value
        ? outcome.value
        : {
            orders: [],
            source: unreadableSource(['gains', 'gmx'][i], null, failureDetail(outcome.reason)),
          },
    )

    const next = { gains: gains.source, gmx: gmx.source }
    setSources(next)
    setOrders([...gains.orders, ...gmx.orders])
    // `unavailable` only when NOTHING could be determined about any venue. A single readable venue
    // is a usable surface, and the unreadable one is named rather than silently empty.
    const anyRead = Object.values(next).some((s) => s.status !== ORDER_SOURCE_STATUS.UNREADABLE)
    setStatus(anyRead ? 'ready' : 'unavailable')
  }, [])

  // Account change (or connect/disconnect): hard reset BEFORE paint, so one account's stuck orders
  // — and the recovery controls aimed at them — can never render for another.
  useEffect(() => {
    reqIdRef.current += 1
    setOrders([])
    setSources({})
    if (!supported) {
      setStatus('idle')
      return undefined
    }
    setStatus('loading')
    load(account)
    const timer = setInterval(() => load(account), POLL_MS)
    return () => clearInterval(timer)
  }, [supported, account, load])

  const unreadableVenues = useMemo(
    () =>
      Object.entries(sources)
        .filter(([, s]) => s?.status === ORDER_SOURCE_STATUS.UNREADABLE)
        .map(([venue]) => venue),
    [sources],
  )

  const recoverableOrders = useMemo(() => orders.filter((o) => o.recoverable), [orders])

  return {
    status,
    supported,
    orders,
    recoverableOrders,
    sources,
    unreadableVenues,
    refresh: () => load(account),
  }
}

/* ------------------------------------------------------------------------------------------- *
 * Recovery calldata
 * ------------------------------------------------------------------------------------------- */

/**
 * A recovery descriptor → the `{ target, data, value }` call object the wallet consumes.
 *
 * THE ONE PLACE a descriptor becomes calldata, so no surface reaches for the venue builders with a
 * loose number. The branded Gains index travels inside the descriptor UNWRAPPED BY NOBODY: the
 * builder refuses a raw number and refuses a trade index, which is the guard that keeps a recovery
 * from acting on a different object entirely (venue-calldata.md, the index trap).
 *
 * Throws (it never runs during render — it runs when a member has asked to recover), so the caller
 * surfaces the failure rather than sending a call object built from nothing.
 */
export function buildRecoveryCall(recovery) {
  if (!recovery || typeof recovery !== 'object') {
    throw new TypeError('buildRecoveryCall needs a recovery descriptor from usePerpsOrders')
  }
  if (recovery.action === 'cancelOrderAfterTimeout') {
    return buildCancelOrderAfterTimeoutCall({
      chainId: recovery.chainId,
      pendingOrderIndex: recovery.pendingOrderIndex,
    })
  }
  if (recovery.action === 'cancelOrder') {
    return buildCancelOrderCall({ chainId: recovery.chainId, key: recovery.orderKey })
  }
  throw new TypeError(`unknown recovery action ${JSON.stringify(recovery.action)}`)
}

/* ------------------------------------------------------------------------------------------- *
 * Gains — pending orders from the gateway, timing from the chain
 * ------------------------------------------------------------------------------------------- */

/**
 * The member's Gains pending orders, with recoverability proven rather than assumed.
 *
 * A pending order listed by the venue is one the member SIGNED, that WAS submitted, and that the
 * venue HAS acknowledged — all three are facts about an order sitting in `getPendingOrders`
 * storage, not inferences — so the machine is walked through exactly those states rather than a
 * hand-built state object. Past `createdBlock + getMarketOrdersTimeoutBlocks()` the venue's own
 * timeout mapper moves it to `timed_out` and the recovery control appears.
 *
 * Never rejects: it returns an `unreadable` source instead, because the caller renders a list.
 */
async function loadGainsOrders(account, io) {
  let body
  try {
    body = await io.fetchPositions(account)
  } catch (e) {
    return {
      orders: [],
      source: unreadableSource('gains', null, gatewayFailureDetail(e)),
    }
  }

  // A payload with no `pendingOrders` key at all is what a gateway build predating this feature
  // returns. That is "we never asked", not "the member has none" — `unreadable`, never an empty
  // list, because an empty list reads as "nothing is stuck".
  if (!Array.isArray(body?.pendingOrders)) {
    return {
      orders: [],
      source: unreadableSource(
        'gains',
        null,
        'This gateway does not report pending orders yet, so stuck orders cannot be listed here.',
      ),
    }
  }

  // `sources.gains.status` is the POSITIONS facet and is deliberately NOT consulted here. The
  // gateway resolves the two facets independently precisely so a positions outage still serves the
  // recovery handles (`routes.js`: "a 502 would bury a recovery handle behind an error screen"), so
  // reading `status !== 'read'` as unreadable would throw away orders it went out of its way to
  // send. The pending-order facet has its own signal: which chains answered.
  const facet = body?.sources?.gains
  const chains = Array.isArray(facet?.pendingOrderChains) ? facet.pendingOrderChains : null
  if (chains && chains.length === 0) {
    return { orders: [], source: unreadableSource('gains', null, 'Gains Network could not be read just now.') }
  }

  const rows = body.pendingOrders.filter((row) => row && typeof row === 'object')

  // One timing read per chain the member actually has orders on — never one per order. The head
  // block has no other source; the timeout window is only read from the diamond when the venue did
  // not already report it through the gateway.
  const chainIds = [...new Set(rows.map((row) => toChainId(row.chainId)).filter((id) => id != null))]
  const timings = new Map()
  const settled = await Promise.allSettled(
    chainIds.map((chainId) =>
      readGainsTiming(chainId, io, {
        needTimeout: rows.some(
          (row) => toChainId(row.chainId) === chainId && toBlockNumber(row.timeoutBlocks) == null,
        ),
      }),
    ),
  )
  chainIds.forEach((chainId, i) => {
    timings.set(
      chainId,
      settled[i].status === 'fulfilled' ? settled[i].value : { currentBlock: null, timeoutBlocks: null },
    )
  })

  const orders = rows.map((row) => toGainsOrder(row, timings))
  return {
    orders,
    source: readSource('gains', null, {
      count: orders.length,
      // Gains runs on three chains; a read covering fewer is partial, and the surface has to be able
      // to say which — a total missing one of its parts is never presented as complete (spec 071).
      chains,
    }),
  }
}

/**
 * `getMarketOrdersTimeoutBlocks()` + the head block, for one chain.
 *
 * The timeout is VENUE CONFIGURATION and is read from the diamond, never from a constant: it is
 * 200 blocks on Arbitrum and 30 on Base/Polygon today, and both are the venue's to change.
 *
 * It is read here rather than through `lib/perps/venueStatus.js` on purpose. That module's job is
 * answering whether a venue will accept an OPEN; an exit path must not depend on it, or the day
 * someone adds a gate there it silently becomes a gate on recovery too. This is one config call.
 *
 * Total — both values are independently nullable, and a null simply means the timeout cannot be
 * PROVEN, which leaves the order pending with `timing.readable: false` rather than claiming
 * either that it is recoverable or that it is fine.
 */
async function readGainsTiming(chainId, io, { needTimeout = true } = {}) {
  const provider = attempt(() => io.getProvider(chainId))
  if (!provider) return { currentBlock: null, timeoutBlocks: null }
  const diamond = needTimeout ? attempt(() => io.diamondFor(chainId)) : null
  const contract = diamond ? attempt(() => io.makeContract(diamond, GAINS_DIAMOND_ABI, provider)) : null

  const [block, timeout] = await Promise.allSettled([
    provider.getBlockNumber(),
    contract ? contract.getMarketOrdersTimeoutBlocks() : Promise.resolve(null),
  ])
  return {
    currentBlock: block.status === 'fulfilled' ? toBlockNumber(block.value) : null,
    timeoutBlocks: timeout.status === 'fulfilled' ? toBlockNumber(timeout.value) : null,
  }
}

function toGainsOrder(row, timings) {
  const chainId = toChainId(row.chainId)
  const venue = typeof row.venue === 'string' && row.venue ? row.venue : 'gains'
  const orderType = toInteger(row.orderType)
  const action = gainsAction(orderType)
  const identity = { venue, chainId, action }

  // The index is branded the moment it crosses into this app, and never unwrapped again. An index
  // the gateway could not supply stays null: a recovery aimed at a guessed number would act on
  // whatever order happens to hold it.
  //
  // IT IS READ BY NAME, AND THE NAME IS THE DEFENCE. A JSON wire carries no brands, so the gateway
  // deliberately emits `venueRef.pendingOrderIndex` / `venueRef.tradeIndex` and NEVER a bare
  // `index` — the two names are not guessable from each other. Reading `row.index` here would be
  // reading a field the gateway refuses to publish, and on a raw venue payload that same field IS
  // the pending-order index on the order but the TRADE index one level down. Never widen this.
  const rawIndex = row.venueRef?.pendingOrderIndex ?? row.pendingOrderIndex
  const index = attempt(() => (rawIndex == null ? null : pendingOrderIndex(rawIndex)))

  // The legal walk. Each step is a fact about an order the venue is holding: the member signed it,
  // it was submitted, and the venue acknowledged it by storing it as pending. Nothing here claims
  // execution — there is no edge to it from any of these states.
  let state = [
    { type: SIGNAL.SIGN, ...identity },
    { type: SIGNAL.SUBMITTED, ...identity, txHash: pickHash(row.txHash) },
    { type: SIGNAL.VENUE_ACKNOWLEDGED, ...identity, venueRef: index ? { pendingOrderIndex: index } : null },
  ].reduce(reduceOrderState, createOrderState(identity))

  const timing = timings.get(chainId) ?? { currentBlock: null, timeoutBlocks: null }
  const createdBlock = toBlockNumber(row.createdBlock)
  const timeoutBlocks = timing.timeoutBlocks ?? toBlockNumber(row.timeoutBlocks)
  const currentBlock = timing.currentBlock

  // Only the venue's own mapper decides a timeout, and only when all three block numbers prove it —
  // it returns null otherwise, and null leaves the order pending rather than offering a control
  // that would revert `WaitTimeout()`.
  if (venue === 'gains') {
    const timedOut = gainsTimeoutSignal({
      ...identity,
      createdBlock,
      currentBlock,
      timeoutBlocks,
      pendingOrderIndex: index,
    })
    if (timedOut) state = reduceOrderState(state, timedOut)
  }

  const readable = createdBlock != null && currentBlock != null && timeoutBlocks != null
  const recoverable =
    state.state === ORDER_STATE.TIMED_OUT && isPendingOrderIndex(state.venueRef?.pendingOrderIndex)

  return finalizeOrder({
    id:
      typeof row.id === 'string' && row.id
        ? row.id
        : `${venue}:${chainId ?? 'unknown'}:pending:${index ? index.value : 'unknown'}`,
    venue,
    chainId,
    // Whatever the venue named it. Null where the venue did not say, which renders '—'.
    symbol: typeof row.symbol === 'string' && row.symbol ? row.symbol : null,
    direction: row.direction === 'long' || row.direction === 'short' ? row.direction : null,
    state,
    orderType,
    orderTypeName: orderType == null ? null : (GAINS_ORDER_TYPE_NAMES[orderType] ?? null),
    // Copy-only: whether the venue REFUNDS collateral through this call for this order type.
    // `null` where the type is unknown — never a confident "yes" we cannot support.
    returnsCollateral: orderType == null ? null : GAINS_REFUNDING_ORDER_TYPES.includes(orderType),
    timing: {
      createdBlock,
      currentBlock,
      timeoutBlocks,
      readable,
      // Blocks left before the recovery call stops reverting. Null whenever any input is missing —
      // a countdown from a guessed timeout would be a fabricated number.
      blocksRemaining: readable ? Math.max(0, createdBlock + timeoutBlocks - currentBlock) : null,
    },
    recoverable,
    recovery: recoverable
      ? Object.freeze({
          venue: 'gains',
          chainId,
          action: 'cancelOrderAfterTimeout',
          // The PENDING-ORDER index, branded. `buildRecoveryCall` refuses anything else.
          pendingOrderIndex: state.venueRef.pendingOrderIndex,
          label: 'Recover your collateral',
        })
      : null,
    raw: row,
  })
}

/** A pending-order type → the machine's `action` vocabulary, for copy only. Unknown stays null. */
function gainsAction(orderType) {
  switch (orderType) {
    case GAINS_PENDING_ORDER_TYPE.MARKET_OPEN:
    case GAINS_PENDING_ORDER_TYPE.LIMIT_OPEN:
    case GAINS_PENDING_ORDER_TYPE.STOP_OPEN:
    case GAINS_PENDING_ORDER_TYPE.MARKET_PARTIAL_OPEN:
      return 'open'
    case GAINS_PENDING_ORDER_TYPE.MARKET_CLOSE:
    case GAINS_PENDING_ORDER_TYPE.TP_CLOSE:
    case GAINS_PENDING_ORDER_TYPE.SL_CLOSE:
    case GAINS_PENDING_ORDER_TYPE.LIQ_CLOSE:
      return 'close'
    case GAINS_PENDING_ORDER_TYPE.MARKET_PARTIAL_CLOSE:
      return 'reduce'
    default:
      return null
  }
}

/* ------------------------------------------------------------------------------------------- *
 * GMX — frozen and pending orders from the account's own event history
 * ------------------------------------------------------------------------------------------- */

/**
 * GMX orders, folded from `EventLog2` history on the app's read provider.
 *
 * WHY THE EVENT HISTORY AND NOT THE READER/DATASTORE. Three reasons, in order of weight:
 *
 *   1. **A frozen order's REASON only exists in the event.** US4 requires a frozen order to be
 *      presented with the venue's own stated reason (FR-008), and GMX states it as its own error
 *      name inside `OrderFrozen`'s `EventLogData`. `Order.Props` has no reason field, so a Reader
 *      read could list the order and would still have to say '—' for why it is stuck.
 *   2. **The Reader path would need an unverified ABI.** `abis/perps/gmxReader.js` carries exactly
 *      one function, verified by decoding live returndata, and its header explains why a
 *      hand-written GMX tuple is dangerous: a wrong field list decodes without error and produces
 *      garbage. Adding `getAccountOrders` on the strength of a memory of `Order.Props` would put a
 *      fabricated read in front of a member.
 *   3. The events are already pinned: `eventTopicsForAccount` and the `EventLog2` topic hash were
 *      checked against live Arbitrum logs, and `gmxEventSignal` already consumes exactly this
 *      shape — the state comes out of the machine rather than out of a flag we interpret.
 *
 * THE COST, DISCLOSED. A log read has a range, so an order frozen before `fromBlock` is not in
 * this list. `sources.gmx` carries `windowed`, `fromBlock` and `lookbackBlocks` so the surface can
 * say so and link to GMX, rather than presenting a windowed list as the whole truth.
 *
 * Never rejects.
 */
async function loadGmxOrders(account, io) {
  const chainId = toChainId(io.gmxChainId) ?? GMX_CHAIN_ID

  const addresses = attempt(() => io.addressesFor(chainId))
  if (!addresses) {
    return {
      orders: [],
      source: source('gmx', chainId, ORDER_SOURCE_STATUS.NOT_DEPLOYED, {
        detail: 'GMX is only deployed on Arbitrum.',
      }),
    }
  }

  const provider = attempt(() => io.getProvider(chainId))
  if (!provider) {
    return { orders: [], source: unreadableSource('gmx', chainId, 'No read connection to Arbitrum.') }
  }

  const filter = eventTopicsForAccount(account, { chainId, eventNames: GMX_ORDER_LIFECYCLE_EVENTS })
  if (!filter) {
    return { orders: [], source: unreadableSource('gmx', chainId, 'This account could not be read on GMX.') }
  }

  // Declared without an initializer on purpose: the catch below RETURNS, so every path that
  // reaches the window-reporting code past the try has assigned both. They are reported to the
  // member as the range actually searched, which is why they cannot be scoped to the try.
  let logs
  let fromBlock
  let toBlock
  try {
    const head = toBlockNumber(await provider.getBlockNumber())
    if (head == null) throw new Error('the network did not report a block height')
    const lookback = toBlockNumber(io.lookbackBlocks) ?? GMX_ORDER_LOOKBACK_BLOCKS
    fromBlock = Math.max(0, head - lookback)
    toBlock = head
    logs = await provider.getLogs({ ...filter, fromBlock, toBlock })
  } catch (e) {
    // A refused range, a dead endpoint, a timeout — all the same fact to a member: we could not
    // look. Never an empty list, which would read as "you have no stuck orders".
    return { orders: [], source: unreadableSource('gmx', chainId, failureDetail(e)) }
  }

  const events = (Array.isArray(logs) ? logs : [])
    .map(decodeOrderEventLog)
    .filter(Boolean)
    // Chain order, not response order: the fold is a state machine, and OrderFrozen arriving before
    // OrderCreated would be refused as an illegal transition rather than applied.
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)

  const byKey = new Map()
  for (const event of events) {
    if (!event.key) continue
    if (!byKey.has(event.key)) byKey.set(event.key, [])
    byKey.get(event.key).push(event)
  }

  const orders = []
  for (const [key, group] of byKey) {
    const order = toGmxOrder(account, chainId, key, group)
    // Executed and cancelled orders are RESOLVED — they are not pending and not stuck, and this
    // hook is the stuck-order surface. A frozen or still-pending one is kept.
    if (order) orders.push(order)
  }

  return {
    orders,
    source: readSource('gmx', chainId, {
      count: orders.length,
      windowed: true,
      fromBlock,
      toBlock,
      lookbackBlocks: toBlock == null || fromBlock == null ? null : toBlock - fromBlock,
      detail:
        'GMX orders are read from recent chain history, so an order frozen further back is not listed here.',
    }),
  }
}

function toGmxOrder(account, chainId, key, events) {
  const orderType = events.map((e) => e.orderType).find((v) => v != null) ?? null
  const action = gmxAction(orderType)
  const identity = { venue: 'gmx', chainId, action }

  // Same legal walk as Gains: the member signed it and it was submitted — both facts, evidenced by
  // the venue having emitted an event about it at all. Every state after that comes from GMX.
  let state = [
    { type: SIGNAL.SIGN, ...identity },
    { type: SIGNAL.SUBMITTED, ...identity, txHash: events[0]?.txHash ?? null },
  ].reduce(reduceOrderState, createOrderState(identity))

  for (const event of events) {
    const signal = gmxEventSignal(event, { ...identity, account, orderKey: key })
    if (signal) state = reduceOrderState(state, signal)
  }

  const frozen = state.state === ORDER_STATE.FROZEN
  if (!frozen && !isPendingState(state)) return null

  return finalizeOrder({
    id: `gmx:${chainId}:${key}`,
    venue: 'gmx',
    chainId,
    // The order events name a market ADDRESS, not a pair. Naming the pair would need market
    // metadata this hook does not have, so it stays null and renders '—' rather than a guess.
    symbol: null,
    direction: null,
    state,
    orderType,
    orderTypeName: orderType == null ? null : (GMX_ORDER_TYPE_NAMES[orderType] ?? null),
    // GMX returns collateral to `cancellationReceiver` — the member — when an order is cancelled.
    returnsCollateral: frozen ? true : null,
    timing: { createdBlock: null, currentBlock: null, timeoutBlocks: null, readable: false, blocksRemaining: null },
    recoverable: frozen,
    recovery: frozen
      ? Object.freeze({
          venue: 'gmx',
          chainId,
          action: 'cancelOrder',
          orderKey: key,
          label: 'Cancel this order',
        })
      : null,
    raw: Object.freeze({ key, events: Object.freeze(events) }),
  })
}

/** A GMX order type → the machine's `action` vocabulary, for copy only. */
function gmxAction(orderType) {
  switch (orderType) {
    case GMX_ORDER_TYPE.MARKET_INCREASE:
      return 'open'
    case GMX_ORDER_TYPE.MARKET_DECREASE:
      return 'close'
    case GMX_ORDER_TYPE.LIMIT_DECREASE:
    case GMX_ORDER_TYPE.STOP_LOSS_DECREASE:
      return 'protect'
    default:
      return null
  }
}

/**
 * One `EventLog2` → the shape `gmxEventSignal` consumes, plus where the log sits in the chain.
 *
 * The venue module owns the unpacking (`decodeOrderEvent` — event identity, order key, account
 * topic and GMX's own reason string), and it is total: a log from another contract or a non-order
 * event is null, meaning "not our event", never a state change.
 *
 * `orderType` is the ONE field it does not carry, so it is read here — and only here — out of the
 * `uintItems` bag. It names a stuck order ("a stop-loss", not "an order") and never decides
 * anything: an unreadable one is null and renders '—'. If a second caller ever needs it, it should
 * be hoisted into `decodeOrderEvent` rather than copied.
 */
function decodeOrderEventLog(log) {
  const event = decodeOrderEvent(log)
  if (!event) return null
  return {
    ...event,
    orderType: readOrderType(log),
    blockNumber: toBlockNumber(log?.blockNumber) ?? 0,
    // ethers v6 names it `index`; a raw JSON-RPC log names it `logIndex`. Both order the fold.
    logIndex: toBlockNumber(log?.index ?? log?.logIndex) ?? 0,
    txHash: pickHash(log?.transactionHash),
  }
}

/** `eventData.uintItems.orderType`, or null. Total — it runs over arbitrary logs. */
function readOrderType(log) {
  try {
    const { args } = decodeEventLog({
      abi: EVENT_EMITTER_ABI,
      topics: [...(log?.topics ?? [])],
      data: log?.data ?? '0x',
    })
    for (const item of args?.eventData?.uintItems?.items ?? []) {
      if (item?.key === 'orderType') return toInteger(item.value)
    }
  } catch {
    /* an unexpected bag shape is "unknown", never a crash */
  }
  return null
}

/* ------------------------------------------------------------------------------------------- *
 * Shared shaping
 * ------------------------------------------------------------------------------------------- */

/**
 * The member-facing envelope around a machine state. The state object itself is carried through
 * untouched — including the branded venue refs — so nothing downstream has to unwrap it, and the
 * status line comes from the machine's own copy table rather than from a string built here.
 */
function finalizeOrder(fields) {
  const { state } = fields
  return Object.freeze({
    ...fields,
    state: state.state,
    orderState: state,
    pending: state.pending,
    // The venue's own words wherever the venue gave any; null renders as nothing, never as a guess.
    reason: state.reason ?? null,
    statusText: orderStatusText(state),
    venueRef: state.venueRef ?? null,
    txHash: state.txHash ?? null,
  })
}

function source(venue, chainId, status, extra = {}) {
  return Object.freeze({
    venue,
    chainId: chainId == null ? null : Number(chainId),
    status,
    detail: null,
    // Present only on a `read`, so `?? 0` has nowhere to live: an unreadable venue has no count,
    // and a zero there would be a fabricated "no stuck orders" (spec-071 estate rule).
    count: null,
    windowed: false,
    fromBlock: null,
    toBlock: null,
    lookbackBlocks: null,
    ...extra,
  })
}

function readSource(venue, chainId, extra) {
  return source(venue, chainId, ORDER_SOURCE_STATUS.READ, extra)
}

function unreadableSource(venue, chainId, detail) {
  return source(venue, chainId, ORDER_SOURCE_STATUS.UNREADABLE, { detail })
}

function failureDetail(error) {
  const message = typeof error?.shortMessage === 'string' ? error.shortMessage : error?.message
  return message ? `This venue could not be read just now (${message}).` : 'This venue could not be read just now.'
}

function gatewayFailureDetail(error) {
  if (error?.code === 'unconfigured') {
    return 'This build has no connection to the perps service, so Gains orders cannot be listed here.'
  }
  return failureDetail(error)
}

/**
 * The default read connection for a chain, and the default contract over it (spec 110).
 *
 * Both stay injectable `io` seams — this hook's tests supply their own — but the real ones now
 * NAME the chain rather than inheriting it from a provider handed down. The reader keeps the two
 * methods this hook actually uses, `getBlockNumber` and `getLogs`, in the ethers shapes the GMX
 * fold was written against: a NUMBER block height, and logs whose `blockNumber`/`logIndex` sort
 * as numbers (the fold is a state machine and sorts on them).
 */
function defaultGetProvider(chainId) {
  const client = getPublicClient(chainId)
  if (!client) return null
  return {
    chainId,
    async getBlockNumber() {
      // Never cached: this head bounds the order-event scan, and a stale one hides the member's
      // most recent order. See the note in `lib/chains/eventScan.js`.
      return Number(await client.getBlockNumber({ cacheTime: 0 }))
    },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            address,
            topics,
            fromBlock: `0x${Number(fromBlock).toString(16)}`,
            toBlock: `0x${Number(toBlock).toString(16)}`,
          },
        ],
      })
      return logs.map((log) => ({
        ...log,
        blockNumber: log.blockNumber == null ? null : Number(BigInt(log.blockNumber)),
        logIndex: log.logIndex == null ? null : Number(BigInt(log.logIndex)),
        transactionIndex:
          log.transactionIndex == null ? null : Number(BigInt(log.transactionIndex)),
      }))
    },
  }
}

function defaultMakeContract(address, abi, provider) {
  const chainId = provider?.chainId
  return {
    getMarketOrdersTimeoutBlocks: () =>
      readContract(chainId, { address, abi, functionName: 'getMarketOrdersTimeoutBlocks' }),
  }
}

/** Runs a dependency that may throw OR return null, and treats both the same. */
function attempt(fn) {
  try {
    return fn() || null
  } catch {
    return null
  }
}

function reverseLookup(map) {
  return Object.freeze(Object.fromEntries(Object.entries(map).map(([name, value]) => [value, name])))
}

function toChainId(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function toBlockNumber(value) {
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : null
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null
}

function toInteger(value) {
  if (typeof value === 'bigint') return Number(value)
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/

function pickHash(value) {
  return typeof value === 'string' && HEX32.test(value.trim()) ? value.trim() : null
}

/* Re-exported so a surface can catch the index-space refusal by type without importing the venue
 * module directly — the one error `buildRecoveryCall` can raise that is a programming mistake
 * rather than a venue outcome. */
export { GainsIndexSpaceError }
