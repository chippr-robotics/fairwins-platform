/**
 * The PositionSheet's venue work (spec 083, T034 + T040) — the descriptors an exit or a protection
 * change is made of, and the live fee rate that is disclosed before either.
 *
 * Its own module because `PositionSheet.jsx` may only export components
 * (`react-refresh/only-export-components`, the `components/perps/pendingOrderRecovery.js`
 * convention) — and because these are the parts worth testing directly rather than only through
 * the DOM: the ownership fields they never touch, the index space they never cross, and the
 * refusals they produce BEFORE a wallet prompt are the whole safety story of the exit path.
 *
 * NOTHING HERE MAY BECOME A GATE. This module is on the exit path, so it does not import the
 * attestation, the management kill switch, or the venue's open-permission check, and a sibling
 * test greps this file for each of those names.
 *
 * TOTALITY: every export runs from a click handler or a render, over whatever the venue reported.
 * Junk in yields a refusal with a member-facing sentence — never a throw, and never a silent pass.
 */

import { readContract } from '../../lib/chains/readContract'

import { GAINS_DIAMOND_ABI, GAINS_SCALES } from '../../abis/perps/gainsDiamond'
import { GMX_DATA_STORE_ABI } from '../../abis/perps/gmxDataStore'
import { gainsDiamondFor, gmxAddressesFor, perpsUiFeeReceiver } from '../../config/perps'
import { defaultSlippage } from '../../lib/perps/defaults'
import { gmxUiFeeFactorKey, gmxUiFeeFactorToBps } from '../../lib/perps/feeUnits'
import { isTradeIndex, tradeIndex as brandTradeIndex } from '../../lib/perps/venues/gains'
import { GMX_ORDER_KIND, readExecutionFee } from '../../lib/perps/venues/gmx'
import { getReadProvider } from '../../utils/rpcProvider'

/* ------------------------------------------------------------------------------------------- *
 * Descriptor builders — pure, exported, and the only place venue params are assembled
 *
 * They return `{ ok: false, reason }` rather than throwing: a member-facing sentence BEFORE any
 * wallet prompt is the whole of FR-022, and a builder throw at signing time would be a developer
 * message in front of someone's money. Where a value genuinely cannot be established, the refusal
 * names the venue's own surface as the way through — an exit is never simply withheld.
 * ------------------------------------------------------------------------------------------- */

function refuse(reason) {
  return { ok: false, reason }
}

/** A branded Gains TRADE index, or null. Only ever read from the field NAMED `tradeIndex`. */
export function gainsTradeIndexOf(position) {
  const raw = position?.venueRef?.tradeIndex
  if (raw == null) return null
  // Already branded by `usePerpsPositions` in the normal path. A raw value is branded here rather
  // than refused, because `venueRef.tradeIndex` is a NAMED crossing of the boundary — the same one
  // the positions hook makes. What must never happen is reading `index` / `pendingOrderIndex` into
  // this: that is the index trap, and it acts on a different object (contracts/venue-calldata.md).
  if (isTradeIndex(raw)) return raw
  try {
    return brandTradeIndex(raw)
  } catch {
    return null
  }
}

/** `value × percent / 100`, exact in venue units. */
function shareOf(value, percent) {
  if (typeof value !== 'bigint') return null
  if (percent >= 100) return value
  return (value * BigInt(Math.round(percent))) / 100n
}

/**
 * The price bound for a DECREASE, in human units.
 *
 * A decrease of a LONG is a sell, so `acceptablePrice` is a MINIMUM; a decrease of a SHORT is a
 * buy, so it is a MAXIMUM. This asymmetry is the trap: `0` is a perfectly safe "any price" bound
 * for a long and an order that can NEVER fill for a short.
 */
function decreaseAcceptablePrice(price, isLong, slippagePct) {
  const p = Number(price)
  if (!Number.isFinite(p) || p <= 0) return null
  const s = Math.max(0, Number(slippagePct) || 0) / 100
  const bound = isLong ? p * (1 - s) : p * (1 + s)
  return bound > 0 ? bound : null
}

/**
 * The descriptor for closing or reducing a position.
 *
 * `percent` is the share the member asked to close; 100 is a full close (`action: 'close'`) and
 * anything less is a reduce (`action: 'reduce'`) — two different venue calls on Gains, the same
 * call with a smaller size on GMX.
 */
export function buildExitDescriptor(input) {
  const {
    position,
    percent = 100,
    markPrice = null,
    slippagePct = defaultSlippage(),
    quote = null,
    uiFeeReceiver = null,
  } = input ?? {}
  const venue = position?.venue ?? null
  const chainId = Number(position?.chainId ?? position?.venueRef?.chainId)
  const isLong = directionOf(position)
  const full = Number(percent) >= 100
  const action = full ? 'close' : 'reduce'
  const validate = { position, closeFraction: Number(percent) / 100 }

  if (!Number.isInteger(chainId) || chainId <= 0) {
    return refuse('This position’s network could not be determined, so it cannot be closed from here. You can close it on the venue.')
  }
  if (isLong === null) {
    return refuse('Whether this position is long or short could not be read, so a close cannot be prepared here. You can close it on the venue.')
  }

  if (venue === 'gains') {
    const index = gainsTradeIndexOf(position)
    if (!index) {
      return refuse('Gains’ own handle for this position could not be read, so it cannot be closed from here. You can close it on Gains.')
    }
    const price = positiveNumber(markPrice)
    if (price === null) {
      // `closeTradeMarket` takes the price its slippage bound is measured from; a zero would make
      // the venue cancel the close. Refusing is more honest than a signature that cannot execute.
      return refuse('The current price for this market could not be read just now, so a close cannot be priced here. You can close it on Gains.')
    }
    if (full) {
      return {
        ok: true,
        descriptor: {
          action: 'close',
          venue,
          chainId,
          validate,
          params: { tradeIndex: index, expectedPrice: price, maxSlippageP: slippagePct },
        },
      }
    }
    // A PARTIAL exit on Gains has two levers, and which one is available depends on what the venue
    // told us. Proportional (collateral out, leverage unchanged) is the one members expect, and it
    // needs the collateral in the token's OWN base units — a figure the gateway does not currently
    // publish. Deriving it from `collateralUsd` would mean assuming a $1 peg for a collateral that
    // may be WETH: a fabricated number in front of a leveraged position. So the leverage lever is
    // the honest fallback, it reduces the size by exactly the share asked for, and the sheet SAYS
    // that the collateral stays in the position.
    const collateralAmount = bigintOrNull(position?.venueRef?.collateralAmount ?? position?.collateralAmount)
    if (collateralAmount !== null && collateralAmount > 0n) {
      return {
        ok: true,
        descriptor: {
          action: 'reduce',
          venue,
          chainId,
          validate,
          params: {
            tradeIndex: index,
            collateralDelta: shareOf(collateralAmount, Number(percent)),
            leverageDelta: 0,
            expectedPrice: price,
          },
        },
      }
    }
    const leverage = positiveNumber(position?.leverage)
    if (leverage === null) {
      return refuse('This position’s size could not be read from Gains, so part of it cannot be closed here. You can close it on Gains.')
    }
    return {
      ok: true,
      descriptor: {
        action: 'reduce',
        venue,
        chainId,
        validate,
        params: {
          tradeIndex: index,
          collateralDelta: 0n,
          leverageDelta: roundLeverage((leverage * Number(percent)) / 100),
          expectedPrice: price,
        },
      },
    }
  }

  if (venue === 'gmx') {
    const ref = position?.venueRef ?? {}
    const raw = position?.raw ?? {}
    const sizeInUsd = bigintOrNull(raw.sizeInUsd ?? ref.sizeInUsd)
    if (sizeInUsd === null || sizeInUsd <= 0n) {
      return refuse('GMX did not report this position’s size, so a close cannot be prepared here. You can close it on GMX.')
    }
    if (!ref.market || !ref.collateralToken) {
      return refuse('GMX’s own handle for this position could not be read, so it cannot be closed from here. You can close it on GMX.')
    }
    const executionFee = bigintOrNull(quote?.executionFee)
    if (executionFee === null || executionFee <= 0n) {
      // GMX orders are settled by keepers the member pays for, and the fee comes from GMX's own
      // DataStore configuration. Guessing it either strands the order unexecuted or overcharges.
      return refuse('GMX’s keeper fee for this order could not be read just now, so a close cannot be prepared here. You can close it on GMX.')
    }
    const acceptablePrice =
      quote?.acceptablePrice ?? decreaseAcceptablePrice(markPrice, isLong, slippagePct)
    if (acceptablePrice == null) {
      return refuse('The current price for this market could not be read just now, so a close cannot be priced here. You can close it on GMX.')
    }
    const collateralAmount = bigintOrNull(raw.collateralAmount) ?? 0n
    return {
      ok: true,
      descriptor: {
        action,
        venue,
        chainId,
        validate,
        params: {
          market: ref.market,
          collateralToken: ref.collateralToken,
          isLong,
          sizeDeltaUsd: shareOf(sizeInUsd, Number(percent)),
          collateralAmount: shareOf(collateralAmount, Number(percent)) ?? 0n,
          acceptablePrice,
          executionFee,
          uiFeeReceiver,
        },
      },
    }
  }

  return refuse('Positions on this venue are managed on the venue’s own app.')
}

/**
 * The descriptor for setting, changing or removing protection.
 *
 * `stopLoss` / `takeProfit` are the levels the member wants, `null` meaning "remove it". Only the
 * legs that actually CHANGED are sent: an unchanged take-profit re-sent alongside a new stop is a
 * second signature that buys the member nothing.
 */
export function buildProtectDescriptor(input) {
  const {
    position,
    stopLoss = null,
    takeProfit = null,
    stored = null,
    markPrice = null,
    slippagePct = defaultSlippage(),
    quote = null,
    uiFeeReceiver = null,
  } = input ?? {}
  const venue = position?.venue ?? null
  const chainId = Number(position?.chainId ?? position?.venueRef?.chainId)
  const isLong = directionOf(position)
  const slChanged = !sameLevel(stopLoss, stored?.stopLoss)
  const tpChanged = !sameLevel(takeProfit, stored?.takeProfit)

  if (!slChanged && !tpChanged) {
    return refuse('These are already the levels the venue has stored for this position.')
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return refuse('This position’s network could not be determined, so protection cannot be set from here.')
  }
  if (isLong === null) {
    return refuse('Whether this position is long or short could not be read, so protection cannot be checked against it.')
  }

  const validate = {
    position: {
      markPrice,
      entryPrice: position?.entryPrice ?? null,
      isLong,
      liquidationPrice: position?.liquidationPrice ?? null,
    },
    stopLoss,
    takeProfit,
    liquidationPrice: position?.liquidationPrice ?? null,
    isLong,
  }

  if (venue === 'gains') {
    const index = gainsTradeIndexOf(position)
    if (!index) {
      return refuse('Gains’ own handle for this position could not be read, so protection cannot be set from here.')
    }
    // `sl` / `tp` PRESENT means "write this leg"; absent means "leave it alone". A null VALUE is
    // how both venues spell "remove it", so the two must not be collapsed into one another.
    const params = { tradeIndex: index }
    if (slChanged) params.sl = stopLoss
    if (tpChanged) params.tp = takeProfit
    return { ok: true, descriptor: { action: 'protect', venue, chainId, validate, params } }
  }

  if (venue === 'gmx') {
    const ref = position?.venueRef ?? {}
    const raw = position?.raw ?? {}
    const sizeInUsd = bigintOrNull(raw.sizeInUsd ?? ref.sizeInUsd)
    if (sizeInUsd === null || sizeInUsd <= 0n) {
      return refuse('GMX did not report this position’s size, so protection cannot be prepared here.')
    }
    if (!ref.market || !ref.collateralToken) {
      return refuse('GMX’s own handle for this position could not be read, so protection cannot be set from here.')
    }
    const executionFee = bigintOrNull(quote?.executionFee)
    if (executionFee === null || executionFee <= 0n) {
      return refuse('GMX’s keeper fee for a trigger order could not be read just now, so protection cannot be prepared here.')
    }
    // GMX expresses protection as separate trigger orders, so REMOVING a level is cancelling that
    // order — a different call, keyed by the order's own key, which this sheet does not hold.
    // Saying so is better than silently writing a new order and leaving the old one live.
    if ((slChanged && stopLoss == null) || (tpChanged && takeProfit == null)) {
      return refuse('On GMX a stop or target is its own order — remove it from the pending orders list rather than here.')
    }
    const leg = (trigger) => ({
      sizeDeltaUsd: sizeInUsd,
      triggerPrice: trigger,
      acceptablePrice: decreaseAcceptablePrice(trigger, isLong, slippagePct) ?? 0,
      executionFee,
    })
    return {
      ok: true,
      descriptor: {
        action: 'protect',
        venue,
        chainId,
        validate,
        params: {
          market: ref.market,
          collateralToken: ref.collateralToken,
          isLong,
          executionFee,
          uiFeeReceiver,
          // `autoCancel: true` is not passed — the builder hardcodes it, so a trigger order can
          // never outlive its position as stale exposure (US2 acceptance 4).
          stopLoss: slChanged && stopLoss != null ? leg(stopLoss) : null,
          takeProfit: tpChanged && takeProfit != null ? leg(takeProfit) : null,
        },
      },
    }
  }

  return refuse('Positions on this venue are managed on the venue’s own app.')
}

/* ------------------------------------------------------------------------------------------- *
 * The FairWins fee rate — read from the contract that enforces it
 * ------------------------------------------------------------------------------------------- */

/**
 * The live FairWins rate for a venue, in bps.
 *
 *  - **GMX** enforces it from its own DataStore (`uiFeeFactorKey(receiver)`), so that is where it
 *    is read. An unset receiver is a STRUCTURAL zero — GMX early-returns a zero UI fee for
 *    `address(0)` — so it reports 0 rather than "unknown".
 *  - **Gains** has no FairWins-priced fee at all (fee-rails.md): the referral share is paid by the
 *    venue out of its own fees and is not a member cost, so a fee line there would invent one.
 *
 * → `{ bps }` when the rate is known, or `{ failed: true }`. **A failure never blocks a close** —
 * the caller renders the honest note and leaves the exit exactly where it was (rule 4 of
 * fee-rails.md, which blocks OPENING only).
 */
export async function defaultReadFeeBps({ venue, chainId, getProvider = getReadProvider } = {}) {
  if (venue !== 'gmx') return { bps: 0 }
  try {
    const receiver = perpsUiFeeReceiver()
    if (!receiver) return { bps: 0 } // address(0) ⇒ GMX charges nothing, structurally
    const key = gmxUiFeeFactorKey(receiver)
    const addresses = gmxAddressesFor(chainId)
    if (!key || !addresses?.dataStore) return { failed: true }
    const provider = getProvider(chainId)
    if (!provider) return { failed: true }
    const bps = gmxUiFeeFactorToBps(
      await readContract(chainId, {
        address: addresses.dataStore,
        abi: GMX_DATA_STORE_ABI,
        functionName: 'getUint',
        args: [key],
      }),
    )
    return bps === null ? { failed: true } : { bps }
  } catch {
    return { failed: true }
  }
}


/* ------------------------------------------------------------------------------------------- *
 * The venue's own quote — the keeper fee a GMX order cannot be built without
 * ------------------------------------------------------------------------------------------- */

/**
 * What the venue requires this exit to carry, beyond what the position itself says.
 *
 *  - **GMX** settles every order through a keeper the member pays, so an order without an
 *    `executionFee` is one GMX will refuse at `createOrder`. The fee is GMX's own arithmetic over
 *    its own DataStore configuration and the live gas price (`lib/perps/venues/gmx.js`), so it is
 *    READ, never assumed: a guessed fee either strands the order unexecuted or overcharges.
 *  - **Every other venue** needs nothing here, and `null` says exactly that — an absent quote is
 *    not a failed one, and Gains must never render a keeper-fee line it does not have.
 *
 * → `{ executionFee, estimate }` when GMX answered, `{ failed: true }` when it could not be read,
 * or `null` where the venue has no such fee. **A failure never removes the exit** — it is disclosed
 * on the sheet and the venue's own app stays one tap away (FR-014/SC-004). This is an inability to
 * build valid calldata, not a permission, and nothing here consults one.
 */
export async function defaultReadVenueQuote({ venue, chainId, deps } = {}) {
  if (venue !== 'gmx') return null
  try {
    // Every exit is a DECREASE — a close, a reduce, and both protection legs. One read, one fee.
    const estimate = await readExecutionFee({ chainId, orderKind: GMX_ORDER_KIND.DECREASE, ...(deps ?? {}) })
    if (!estimate || typeof estimate.fee !== 'bigint' || estimate.fee <= 0n) return { failed: true }
    return { executionFee: estimate.fee, estimate }
  } catch {
    return { failed: true }
  }
}

/* ------------------------------------------------------------------------------------------- *
 * The venue's STORED protection — the only levels this sheet may ever present as saved
 *
 * A Gains `updateTp` / `updateSl` SETTLES INSIDE THE MEMBER'S OWN TRANSACTION. There is no keeper
 * round and the diamond emits no order event this app decodes, so the order machine has nothing to
 * watch: left alone it rests at "Sent to Gains" forever, and the member is never told whether their
 * stop exists. The confirmation is therefore a READ — the venue's own `getTrade` — and US2
 * acceptance 3 is the reason it must be a read rather than an assumption: the sheet has to reflect
 * what Gains STORED, which is not necessarily what was asked for (the venue may round to its 1e10
 * price grid, or clamp a level to its own limits).
 *
 * THREE PROPERTIES ARE LOAD-BEARING.
 *
 * 1. **Inclusion is still not execution.** Nothing here reads a receipt. The only thing that moves
 *    a protection update to `executed` is this re-read coming back with the venue's own numbers,
 *    and `usePerpsTrade#confirmFromVenue` refuses the payload for any keeper-settled action.
 * 2. **It is BOUNDED, and exhaustion is honest.** A read that never catches up must not spin: after
 *    `PROTECTION_CONFIRM_ATTEMPTS` the caller is told it could not be confirmed, which lands the
 *    machine in `unknown` with the venue's own surface one tap away — never a false success, and
 *    never a spinner with no end.
 * 3. **A change must be PROVEN, not assumed.** An RPC endpoint a block or two behind still answers
 *    the pre-write values, and accepting that would report the OLD level as the new one. So a read
 *    settles only when every leg that was written has moved off the value the venue held before —
 *    or, where no baseline was ever read, when it holds exactly what was asked for.
 * ------------------------------------------------------------------------------------------- */

/** How many times a confirmation re-reads the venue before it admits it cannot confirm. */
export const PROTECTION_CONFIRM_ATTEMPTS = 8

/** How long between those re-reads. 8 × 1.5s ≈ 12s — ample for an Arbitrum read to catch up. */
export const PROTECTION_CONFIRM_INTERVAL_MS = 1_500

/** `{ sl, tp }` (what the venue calls them) → `{ stopLoss, takeProfit }` (what a member calls them). */
const PROTECTION_LEGS = Object.freeze({ sl: 'stopLoss', tp: 'takeProfit' })

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The default Gains diamond reader. `chainId` is a THIRD argument rather than a replacement: the
 * `makeContract` seam is injected by tests, and an added parameter leaves every existing fake
 * working unchanged while the real one names the chain it reads (spec 110). `provider` stays the
 * availability gate the caller already checked.
 */
function defaultMakeDiamond(address, provider, chainId) {
  const call = (functionName, args) =>
    readContract(chainId, { address, abi: GAINS_DIAMOND_ABI, functionName, args })
  return {
    getTrade: (account, index) => call('getTrade', [account, index]),
    getTrades: (account) => call('getTrades', [account]),
  }
}

/**
 * A venue price (1e10) → human units. The venue's own `0` means "no level set", so it maps to
 * `null` and the sheet renders '—' / an empty field — never `0`, which is a price.
 */
function fromGainsPrice(value) {
  const raw = bigintOrNull(value)
  if (raw === null || raw <= 0n) return null
  return Number(raw) / Number(GAINS_SCALES.PRICE)
}

function sameAccount(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** The venue's answer is only about THIS member's trade at THIS index, or it is not an answer. */
function isTradeFor(trade, account, index) {
  if (!trade) return false
  return sameAccount(trade.user, account) && numberOrNull(trade.index) === index
}

function storedProtectionFrom(trade, index) {
  const sl = bigintOrNull(trade.sl) ?? 0n
  const tp = bigintOrNull(trade.tp) ?? 0n
  return Object.freeze({
    name: 'GainsStoredProtection',
    tradeIndex: index,
    // VENUE UNITS (1e10) — the same units every other `order.execution` payload carries.
    sl,
    tp,
    // Human units, for the fields the member reads. `null` is the venue's "none", not zero.
    stopLoss: fromGainsPrice(sl),
    takeProfit: fromGainsPrice(tp),
    isOpen: trade.isOpen === true,
  })
}

async function readOneTrade(contract, account, index) {
  let trade
  try {
    trade = await contract.getTrade(account, index)
  } catch {
    trade = null
  }
  if (isTradeFor(trade, account, index)) return trade
  // `getTrade` is the cheap read; `getTrades` is the fallback for a diamond that does not serve it.
  // A second failure changes nothing — the caller already has "could not read", which is honest.
  try {
    const all = await contract.getTrades(account)
    const found = (Array.isArray(all) ? all : []).find((t) => numberOrNull(t?.index) === index) ?? null
    if (isTradeFor(found, account, index)) return found
  } catch {
    /* nothing to add: the first read already failed */
  }
  return null
}

/**
 * What Gains currently holds for a trade's stop-loss and take-profit.
 *
 * TOTAL: it runs in an effect and after a submission, so every failure — an undeployed venue, a
 * dead endpoint, a trade that no longer exists, an index from the wrong space — returns
 * `{ ok: false, reason }` rather than throwing. A refusal is never a claim about the levels.
 *
 * The index MUST already be branded (`gains.tradeIndex`). A pending-order index here would read a
 * different object entirely (contracts/venue-calldata.md, the index trap), so it is refused rather
 * than coerced — reporting another order's levels as this position's would be worse than silence.
 */
export async function readStoredProtection(input) {
  const {
    venue,
    chainId,
    account,
    tradeIndex,
    getProvider = getReadProvider,
    makeContract = defaultMakeDiamond,
  } = input ?? {}

  // Gains is the only venue whose protection lives ON the trade. GMX expresses it as separate
  // trigger orders, which are read (and cancelled) as orders — never through this.
  if (venue !== 'gains') return { ok: false, reason: 'unsupported' }
  if (!isTradeIndex(tradeIndex)) return { ok: false, reason: 'index_unavailable' }
  if (typeof account !== 'string' || account.trim() === '') return { ok: false, reason: 'account_unavailable' }

  const diamond = gainsDiamondFor(chainId)
  if (!diamond) return { ok: false, reason: 'venue_undeployed' }

  try {
    const provider = getProvider(chainId)
    if (!provider) return { ok: false, reason: 'unreadable' }
    const trade = await readOneTrade(makeContract(diamond, provider, chainId), account, tradeIndex.value)
    if (!trade) return { ok: false, reason: 'not_found' }
    return { ok: true, stored: storedProtectionFrom(trade, tradeIndex) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

/**
 * Has the venue's answer caught up with the write?
 *
 * `requested` carries ONLY the legs that were actually sent (`'sl' in requested`), because an
 * untouched leg proves nothing either way. A leg with a known baseline settles when the stored
 * value has MOVED; a leg with no baseline at all (the venue could not be read when the sheet
 * opened) can only settle by holding exactly what was asked for — an unproven change is not a
 * change, and reporting one would be the stale-read bug this exists to prevent.
 */
function protectionSettled(stored, requested, previous) {
  const legs = Object.keys(PROTECTION_LEGS).filter((leg) => leg in (requested ?? {}))
  if (legs.length === 0) return false
  return legs.every((leg) => {
    const field = PROTECTION_LEGS[leg]
    const now = stored?.[field] ?? null
    const asked = requested?.[leg] ?? null
    if (previous == null || !(field in previous)) return sameLevel(now, asked)
    return !sameLevel(now, previous[field] ?? null)
  })
}

/** Whether the venue stored exactly what was asked for, across every leg that was sent. */
function matchesRequested(stored, requested) {
  return Object.keys(PROTECTION_LEGS)
    .filter((leg) => leg in (requested ?? {}))
    .every((leg) => sameLevel(stored?.[PROTECTION_LEGS[leg]] ?? null, requested?.[leg] ?? null))
}

/**
 * Re-read the venue until it confirms the write, or until the bound is spent.
 *
 * → `{ ok: true, stored, matchesRequest }` — `stored` is what GAINS HOLDS, which is what the sheet
 *   must show and what `confirmFromVenue` is given. `matchesRequest: false` means the venue rounded
 *   or clamped, and the caller has to say so rather than keep showing the requested number.
 * → `{ ok: false, reason: 'unconfirmed', stored }` — the bound is spent. `stored` is the last thing
 *   the venue actually said, or null; the caller reports that it could not be confirmed and points
 *   at the venue. It is never reported as either a success or a failure of the write itself.
 * → `{ ok: false, reason: 'abandoned' }` — the sheet went away mid-poll. Nothing to report.
 */
export async function confirmStoredProtection(input) {
  const {
    venue,
    chainId,
    account,
    tradeIndex,
    /** Only the legs that were SENT: `{ sl?, tp? }` in human units, `null` meaning "removed". */
    requested = {},
    /** `{ stopLoss, takeProfit }` as the venue held them BEFORE the write, or `{}`/null if unknown. */
    previous = null,
    attempts = PROTECTION_CONFIRM_ATTEMPTS,
    intervalMs = PROTECTION_CONFIRM_INTERVAL_MS,
    deps,
  } = input ?? {}
  const { readStored = readStoredProtection, sleep = defaultSleep, alive = () => true } = deps ?? {}

  const rounds = Number.isInteger(attempts) && attempts > 0 ? attempts : PROTECTION_CONFIRM_ATTEMPTS
  const wait = Number.isFinite(Number(intervalMs)) && Number(intervalMs) >= 0 ? Number(intervalMs) : PROTECTION_CONFIRM_INTERVAL_MS
  let last = null

  for (let round = 0; round < rounds; round += 1) {
    if (round > 0) {
      await sleep(wait)
      if (!alive()) return { ok: false, reason: 'abandoned' }
    }
    let read
    try {
      read = await readStored({ venue, chainId, account, tradeIndex })
    } catch {
      read = null // a failed poll is not an outcome
    }
    if (!alive()) return { ok: false, reason: 'abandoned' }
    if (read?.ok && read.stored) {
      last = read.stored
      if (protectionSettled(read.stored, requested, previous)) {
        return { ok: true, stored: read.stored, matchesRequest: matchesRequested(read.stored, requested) }
      }
    }
  }
  return { ok: false, reason: 'unconfirmed', stored: last }
}

/**
 * A wei amount as a decimal string with at most `maxDecimals` places, for a fee line.
 *
 * TRUNCATES rather than rounds, and never renders a non-zero fee as "0": a fee below the display
 * precision comes back at its smallest representable value with a leading `<`, because "0" would
 * claim the member pays nothing. Total — junk in, null out, and the caller renders '—'.
 */
export function formatWeiAmount(wei, maxDecimals = 8) {
  const value = bigintOrNull(wei)
  // A negative fee is not a small fee — it is a misread, and rendering one would be a fabricated
  // number in a cost line. '—' is the honest answer.
  if (value === null || value < 0n) return null
  const decimals = Number.isInteger(maxDecimals) && maxDecimals > 0 ? maxDecimals : 8
  const scale = 10n ** 18n
  const whole = value / scale
  const fraction = value % scale
  const digits = fraction.toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '')
  if (digits === '') {
    if (whole === 0n && value > 0n) return `<0.${'0'.repeat(Math.max(0, decimals - 1))}1`
    return whole.toString()
  }
  return `${whole}.${digits}`
}

/* ------------------------------------------------------------------------------------------- *
 * Shared total coercions — exported because the sheet renders the same values it sends
 * ------------------------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------------------------- *
 * Total coercions — these run during render, so junk in yields null, never a throw
 * ------------------------------------------------------------------------------------------- */

export function directionOf(position) {
  if (position?.isLong === true || position?.isLong === false) return position.isLong
  const dir = typeof position?.direction === 'string' ? position.direction.trim().toLowerCase() : null
  if (dir === 'long') return true
  if (dir === 'short') return false
  if (position?.venueRef?.isLong === true || position?.venueRef?.isLong === false) return position.venueRef.isLong
  return null
}

export function numberOrNull(value) {
  if (value == null || typeof value === 'boolean' || typeof value === 'object') return null
  if (typeof value === 'string' && value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function positiveNumber(value) {
  const n = numberOrNull(value)
  return n !== null && n > 0 ? n : null
}

export function bigintOrNull(value) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim())
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value)
  return null
}

/** Gains leverage is 1e3-scaled by the builder; 3 decimals is all the venue can hold. */
function roundLeverage(value) {
  return Math.round(value * 1000) / 1000
}

/** Two levels are the same when both are absent or both are the same price. */
function sameLevel(a, b) {
  const left = positiveNumber(a)
  const right = positiveNumber(b)
  if (left === null && right === null) return true
  if (left === null || right === null) return false
  return Math.abs(left - right) < 1e-9
}
