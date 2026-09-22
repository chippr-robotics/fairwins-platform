/**
 * The OpenPositionSheet's venue work (spec 083, T050) — the ENTRY-path twin of
 * `positionSheetActions.js`.
 *
 * Its own module for the same two reasons that one is: `OpenPositionSheet.jsx` may only export
 * components (`react-refresh/only-export-components`), and the parts worth testing directly are
 * exactly the parts that decide what calldata a member signs — the ownership field this never
 * touches, the venue handle it refuses to guess, and the refusals it produces BEFORE a wallet
 * prompt.
 *
 * THIS MODULE IS ON THE ENTRY PATH, which is what makes it different from every other module in
 * `components/perps/`. Opening is the ONE action FairWins gates (FR-014/FR-015), so this file is
 * allowed to name the attestation and the screening client, and it is classified as ENTRY in
 * `test/perps/safetyInvariants.test.js`. Nothing here may ever be imported by an exit-path module;
 * that suite fails the build if one does.
 *
 * FOUR RULES, each of which is a specific harm when broken:
 *
 * 1. **THE MEMBER IS ALWAYS `msg.sender`.** Neither `buildOpenDescriptor` nor anything it returns
 *    carries a `trader` / `account` field: the hook supplies the member's own address to the venue
 *    builders, and those overwrite-and-check it (`gains.buildOpenTradeCall` refuses an open owned
 *    by the FairWins referrer address). The only FairWins address that leaves here is
 *    `uiFeeReceiver`, and it travels as its own named GMX parameter. **No Gains referrer is sent
 *    at all** — the venue has not whitelisted FairWins, so an address there would earn nothing and
 *    would put a FairWins address one field away from `Trade.user`.
 *
 * 2. **A VENUE HANDLE IS NEVER GUESSED.** Gains needs its own `pairIndex` and 1-based
 *    `collateralIndex`; GMX needs the market token. Where the feed did not supply one, this refuses
 *    with the venue named — it does not fall back to "the first BTC market", because a wrong market
 *    on a leveraged position is worse than no position (`lib/perps/gmxMarkets.js`, same rule).
 *
 * 3. **HONEST NUMBERS.** Every preview figure is an ESTIMATE derived from figures the venue
 *    published, and anything that cannot be derived is `null` for the caller to render '—'. The
 *    liquidation estimate deliberately ignores fees and funding and says so: a number that looks
 *    exact and is not is worse than one labelled approximate.
 *
 * 4. **REFUSE, DO NOT THROW.** Every export runs from a render or a click handler. Junk in yields
 *    `{ ok: false, reason }` with a member-facing sentence, never an exception in front of someone
 *    about to commit money.
 */

import { parseUnits } from '../../lib/evm/units'
import { readContract } from '../../lib/chains/readContract'

import { ERC20_ABI } from '../../abis/ERC20'
import { MAINNET_CHAIN_ID, membershipChainId } from '../../config/networks'
import {
  PERP_VENUES,
  gainsDiamondFor,
  gmxAddressesFor,
  isEvmPerpVenue,
  perpsManageEnabled,
} from '../../config/perps'
import { defaultCollateral, defaultSlippage } from '../../lib/perps/defaults'
import { feeUsdFromNotional, venueFeeFromNotional } from '../../lib/perps/feeUnits'
import { parseGmxPairId } from '../../lib/perps/gmxMarkets'
import { GMX_ORDER_KIND, readExecutionFee } from '../../lib/perps/venues/gmx'
import { canOpen } from '../../lib/perps/venueStatus'
import { getReadProvider } from '../../utils/rpcProvider'
import { screenAddress } from '../../utils/sanctionsScreen'

/* ------------------------------------------------------------------------------------------- *
 * Total coercions — these run during render
 * ------------------------------------------------------------------------------------------- */

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

function refuse(reason) {
  return { ok: false, reason }
}

function venueLabelOf(venue) {
  return PERP_VENUES[venue]?.shortLabel ?? PERP_VENUES[venue]?.label ?? 'the venue'
}

/* ------------------------------------------------------------------------------------------- *
 * Amounts
 * ------------------------------------------------------------------------------------------- */

/**
 * A member's typed amount → the collateral token's own base units.
 *
 * TRUNCATES anything below the token's precision rather than rounding: the extra digits are the
 * member's money, and rounding up would build an order for more than they asked for. Returns null
 * for junk and for a token whose decimals the venue did not publish — an amount in unknown units
 * is not an amount, and `validateOpen` refuses to compare across units for the same reason.
 */
export function toBaseUnits(text, decimals) {
  // `Number(null)` is 0, which is a VALID decimals value for some tokens — so an absent decimals
  // must be rejected before the coercion, or an amount in unknown units would be read as base units.
  if (decimals == null || decimals === '' || typeof decimals === 'boolean') return null
  const d = Number(decimals)
  if (!Number.isInteger(d) || d < 0 || d > 36) return null
  const s = String(text ?? '').trim()
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null
  const [whole, fraction = ''] = s.split('.')
  try {
    return parseUnits(`${whole === '' ? '0' : whole}.${fraction.slice(0, d) || '0'}`, d)
  } catch {
    return null
  }
}

/** Base units → a human Number, for arithmetic the preview does in dollars. */
export function toHumanAmount(base, decimals) {
  const raw = bigintOrNull(base)
  if (decimals == null || decimals === '' || typeof decimals === 'boolean') return null
  const d = Number(decimals)
  if (raw === null || !Number.isInteger(d) || d < 0 || d > 36) return null
  return Number(raw) / 10 ** d
}

/**
 * What one unit of the collateral is worth in USD.
 *
 * Never assumed to be 1. A stablecoin usually is, but "usually" is how a member ends up with a
 * position sized against a peg that broke, and the venues accept volatile collateral too. Order of
 * preference: a price the caller was given, then the member's own holding (value ÷ balance), then
 * nothing — and nothing means the preview says '—' rather than inventing a size.
 */
export function collateralUsdPrice(collateral) {
  const direct = positiveNumber(collateral?.usdPrice)
  if (direct !== null) return direct
  const usdValue = positiveNumber(collateral?.usdValue)
  const balance = toHumanAmount(collateral?.balance, collateral?.decimals)
  if (usdValue !== null && balance !== null && balance > 0) return usdValue / balance
  return null
}

/* ------------------------------------------------------------------------------------------- *
 * Venue eligibility — what may be OFFERED
 *
 * "Never a dead control" is a property of this function. A venue is offered only when the app can
 * actually build an order for it: the venue itself says it is open, this build has a calldata path
 * for it on that chain, and the venue's own handle for the pair is resolvable. Anything else is
 * excluded WITH A REASON that names the venue as the source (FR-016/FR-017), so the sheet explains
 * rather than presenting a control that cannot work.
 * ------------------------------------------------------------------------------------------- */

/**
 * Normalise whatever the caller supplied into one option per venue.
 *
 * The caller may pass nothing at all, in which case the pair row the member tapped IS the single
 * option — the sheet still works from a bare feed row, and simply refuses further down where the
 * venue handle is missing rather than pretending it has one.
 */
export function normalizeVenueOptions(pair, venueOptions) {
  const list = Array.isArray(venueOptions) && venueOptions.length > 0
    ? venueOptions
    : pair
      ? [{ venue: pair.venue, chainId: pair.chainId, pair }]
      : []

  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const venue = typeof raw.venue === 'string' ? raw.venue.trim().toLowerCase() : null
    if (!venue || !PERP_VENUES[venue]) continue
    const row = raw.pair ?? (pair?.venue === venue ? pair : null)
    const chainId = Number(raw.chainId ?? row?.chainId)
    out.push({
      venue,
      chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : null,
      label: venueLabelOf(venue),
      pair: row ?? null,
      status: raw.status ?? null,
      venueRef: raw.venueRef ?? null,
      collaterals: Array.isArray(raw.collaterals) ? raw.collaterals : [],
      limits: raw.limits ?? null,
      minNotional: raw.minNotional ?? null,
      minCollateralUsd: raw.minCollateralUsd ?? null,
      /* The venue's own PUBLISHED RATE, not a dollar figure: the fee is a fraction of position size,
       * so a per-venue amount would be the fee for one size and wrong for every other. `previewOpen`
       * turns it into money for the size actually on screen. */
      venueFee: raw.venueFee ?? null,
    })
  }
  return out
}

/**
 * The venue's own handle for this pair — Gains' `pairIndex`, GMX's market token.
 *
 * → `{ ok: true, ... }` or `{ ok: false, reason }`. GMX's market address is recovered from the
 * feed's own pair id (`gmx:<chainId>:<symbol>:<marketToken>`), which is the same exact-match
 * resolution the positions surface uses; a caller that already holds the address wins over it.
 */
export function resolveVenueHandle(option) {
  const venue = option?.venue ?? null
  const label = venueLabelOf(venue)
  if (venue === 'gains') {
    const pairIndex = numberOrNull(option?.venueRef?.pairIndex ?? option?.pair?.pairIndex)
    if (pairIndex === null || !Number.isInteger(pairIndex) || pairIndex < 0) {
      return refuse(`${label}’ own number for this market could not be read, so a position cannot be opened here. You can open one on ${label}.`)
    }
    return { ok: true, pairIndex }
  }
  if (venue === 'gmx') {
    const direct = option?.venueRef?.market ?? option?.pair?.market ?? null
    const market = typeof direct === 'string' && direct.trim() !== ''
      ? direct.trim()
      : (parseGmxPairId(option?.pair?.id)?.marketToken ?? null)
    if (!market) {
      return refuse(`${label}’s own market for this pair could not be read, so a position cannot be opened here. You can open one on ${label}.`)
    }
    return { ok: true, market }
  }
  return refuse('Positions on this venue are opened on the venue’s own app.')
}

/**
 * Can a new position be opened on this venue right now, and if not, why — in the venue's name.
 *
 * `status` absent means nobody asked the venue. That is NOT permission: `canOpen` fails closed on
 * anything that is not a positive "open", which is the behaviour FR-017 requires.
 */
export function openEligibility(option) {
  const label = option?.label ?? venueLabelOf(option?.venue)
  if (!option?.chainId) {
    return { ok: false, reason: `${label}’s network could not be determined, so a position cannot be opened here.` }
  }
  if (!perpsManageEnabled(option.venue, option.chainId)) {
    return { ok: false, reason: `Positions on ${label} are opened on ${label}’s own app.` }
  }
  if (!canOpen(option.status)) {
    return { ok: false, reason: openStatusReason(option.status, label) }
  }
  const handle = resolveVenueHandle(option)
  if (!handle.ok) return { ok: false, reason: handle.reason }
  return { ok: true, reason: null, handle }
}

/**
 * The venue's own words for why it will not take a new position. Deliberately NOT
 * `venueStatus.openBlockedNote` — that module's phrasing is about a position the member already
 * holds ("you can still close or reduce what you hold"), and this sheet has no position to say
 * that about.
 */
function openStatusReason(status, label) {
  const name = typeof status === 'string' ? status : status?.status
  if (name === 'close-only') {
    return `${label} is in close-only mode right now, so it is not taking new positions.`
  }
  if (name === 'paused') return `${label} has paused trading, so it is not taking new positions.`
  if (name === 'not-deployed') return `${label} is not available on this network.`
  return `${label}’s trading status could not be confirmed, so a position cannot be opened there right now.`
}

/* ------------------------------------------------------------------------------------------- *
 * Composing the venue options for a tapped pair row
 *
 * This is what turns the pairs FEED into the `venueOptions` the sheet consumes, and it is the one
 * place that decides which venues a member is offered for a market. Three rules:
 *
 * 1. **ONE CHAIN — the tapped row's.** Gains lists the same symbol on Arbitrum, Base and Polygon.
 *    A sheet that silently switched a member to another chain's market would be opening a
 *    different position, on a different network, than the row they tapped. The pairs table already
 *    renders the venue+chain badge per row, so the member picks the chain by picking the row.
 *
 * 2. **AN AMBIGUOUS VENUE IS NOT OFFERED.** GMX lists several markets on one base pair
 *    ("BTC/USD [WBTC.b-USDC]" and "BTC/USD [BTC-USDC]" are different markets with different
 *    collateral). Where a venue OTHER than the tapped row's has more than one market for the
 *    symbol on that chain, there is no non-arbitrary answer to which one is meant — so it is left
 *    out, and the member reaches it by tapping its own row. `gmxMarkets.js` refuses the same way.
 *
 * 3. **NOTHING IS INVENTED.** Handles (`pairIndex`, `market`), collateral sets and limits come
 *    from the venue's own feed. Where the feed did not publish one, the option is still built and
 *    `openEligibility` refuses it WITH THE VENUE NAMED — the sheet then explains instead of
 *    offering a control that cannot submit.
 * ------------------------------------------------------------------------------------------- */

/**
 * The feed rows for one venue, for the tapped pair's symbol and chain.
 *
 * Symbols are compared case- and whitespace-insensitively, the way `defaults.js#pickVenue` does,
 * so one venue writing "BTC/USD " does not split a market in two.
 */
function sameMarketRows(rows, symbol, chainId, venue) {
  return rows.filter(
    (row) =>
      row?.venue === venue &&
      normalizeSymbol(row?.symbol) === symbol &&
      Number(row?.chainId) === Number(chainId),
  )
}

function normalizeSymbol(value) {
  if (typeof value !== 'string') return null
  const s = value.trim().toUpperCase().replace(/\s+/g, '')
  return s === '' ? null : s
}

/**
 * The pair row's own venue handles, in the shape `resolveVenueHandle` reads.
 *
 * Gains publishes `pairIndex`; GMX publishes `market` (and its id carries the same address, which
 * `resolveVenueHandle` falls back to). A row from an older gateway carries neither, and the
 * resulting option is refused by name rather than guessed at.
 */
function venueRefForRow(row) {
  if (!row || typeof row !== 'object') return null
  const ref = {}
  if (Number.isInteger(row.pairIndex) && row.pairIndex >= 0) ref.pairIndex = row.pairIndex
  if (typeof row.market === 'string' && row.market.trim() !== '') ref.market = row.market.trim()
  return Object.keys(ref).length > 0 ? ref : null
}

/**
 * The venue options for a tapped pair row → the `venueOptions` prop of `OpenPositionSheet`.
 *
 * @param pair      the row the member tapped
 * @param allPairs  the UNFILTERED venue feed (never the search-filtered view — the member's search
 *                  box must not decide which venues they may open on)
 * @param statuses  `readVenueStatuses(chainId)` output, venue-keyed. Absent ⇒ every option carries
 *                  no status, and `openEligibility` fails CLOSED on that (FR-017).
 * @param holdings  the member's balances, used only to attach the venue's own USD price to a
 *                  collateral the member actually holds; never to decide eligibility.
 */
export function openVenueOptionsFor(pair, allPairs, options) {
  const { statuses = null } = options ?? {}
  const symbol = normalizeSymbol(pair?.symbol)
  const chainId = Number(pair?.chainId)
  if (!symbol || !Number.isInteger(chainId) || chainId <= 0) return []

  const rows = Array.isArray(allPairs) ? allPairs : []
  // The tapped row's venue is always first: it is the one the member actually chose, so it leads
  // the list and `pickVenue`'s input order tie-break resolves in its favour.
  const venues = [pair.venue, ...rows.map((row) => row?.venue)].filter(
    (venue, i, list) => typeof venue === 'string' && isEvmPerpVenue(venue) && list.indexOf(venue) === i,
  )

  const out = []
  for (const venue of venues) {
    const candidates = sameMarketRows(rows, symbol, chainId, venue)
    // Rule 2: the tapped row settles its own venue; another venue with more than one market for
    // this symbol has no non-arbitrary answer, so it is not offered.
    const row =
      pair.venue === venue ? pair : candidates.length === 1 ? candidates[0] : null
    if (!row) continue
    out.push({
      venue,
      chainId,
      pair: row,
      status: statuses?.[venue] ?? null,
      venueRef: venueRefForRow(row),
      collaterals: Array.isArray(row.collaterals) ? row.collaterals : [],
      limits: {
        maxLeverage: numberOrNull(row.maxLeverage),
        minLeverage: numberOrNull(row.minLeverage),
      },
      /* Straight off the feed row, never invented here (rule 3). The gateway publishes
       * `minNotional: null` for Gains because since v9 the venue HAS no minimum notional — its
       * `minPositionSizeUsd` is a fee floor, and refusing a position the venue would fill is a dead
       * control. The bound that does exist is on collateral, in USD, and is the next field. */
      minNotional: row.minNotional ?? null,
      minCollateralUsd: numberOrNull(row.minCollateralUsd),
      venueFee: row.venueFee ?? null,
    })
  }
  return out
}

/**
 * Whether this pair can be opened AT ALL right now — the predicate that keeps the entry control
 * from ever being a dead one.
 *
 * True requires a venue that is open, manageable on this build, whose handle resolves, AND a
 * collateral the member actually holds: a sheet with no spendable collateral cannot submit, so
 * offering the control would be offering a form that always refuses.
 */
export function canOfferOpen(venueOptions, holdings) {
  const list = Array.isArray(venueOptions) ? venueOptions : []
  return list.some(
    (option) => openEligibility(option).ok && defaultCollateral(holdings, option.collaterals) !== null,
  )
}

/**
 * The member's balance for each collateral a set of venue options accepts, on ONE chain.
 *
 * → `[{ symbol, address, decimals, balance, usdValue }]`, holding only what the member actually
 * has. A token whose balance could not be read is OMITTED rather than reported as zero: zero is a
 * statement about the member's wallet, and the honest consequence of not knowing is that the venue
 * is not offered, not that it is offered and refuses at the wallet.
 *
 * Totally injectable and total — it runs in an effect, and a dropped connection returns `[]`.
 */
export async function defaultReadCollateralBalances(input) {
  const {
    chainId,
    account,
    venueOptions,
    getProvider = getReadProvider,
    makeContract = defaultErc20,
  } = input ?? {}
  if (typeof account !== 'string' || account.trim() === '') return []

  // One entry per token across every option — two venues sharing USDC is one balance read.
  const wanted = new Map()
  for (const option of Array.isArray(venueOptions) ? venueOptions : []) {
    for (const collateral of option?.collaterals ?? []) {
      const address = typeof collateral?.address === 'string' ? collateral.address.trim() : null
      const decimals = numberOrNull(collateral?.decimals)
      if (!address || decimals === null) continue
      if (!wanted.has(address.toLowerCase())) wanted.set(address.toLowerCase(), { ...collateral, address, decimals })
    }
  }
  if (wanted.size === 0) return []

  let provider = null
  try {
    provider = getProvider(chainId)
  } catch {
    provider = null
  }
  if (!provider) return []

  const tokens = [...wanted.values()]
  const settled = await Promise.allSettled(
    tokens.map((token) =>
      Promise.resolve().then(() => makeContract(token.address, provider, chainId).balanceOf(account)),
    ),
  )

  const out = []
  settled.forEach((outcome, i) => {
    if (outcome.status !== 'fulfilled') return
    const balance = bigintOrNull(outcome.value)
    if (balance === null || balance <= 0n) return
    const token = tokens[i]
    const price = positiveNumber(token.usdPrice)
    const human = toHumanAmount(balance, token.decimals)
    out.push({
      symbol: token.symbol ?? null,
      address: token.address,
      decimals: token.decimals,
      balance,
      // Derived from the VENUE's own price when it published one — never assumed to be a dollar.
      usdValue: price !== null && human !== null ? human * price : null,
    })
  })
  return out
}

/* ------------------------------------------------------------------------------------------- *
 * The preview — every number an estimate, and labelled as one
 * ------------------------------------------------------------------------------------------- */

/**
 * Where the venue would liquidate this position, APPROXIMATELY.
 *
 * At Nx the market has to move about 1/N against the position to exhaust the collateral, so the
 * level is `entry × (1 ∓ 1/N)`. It deliberately ignores the venue's own fees, borrowing and
 * funding, all of which move the real level slightly CLOSER to entry — so this estimate is
 * optimistic, and the sheet says so beside it rather than dressing it up as the venue's number.
 * The venue's own liquidation price only exists once the position does.
 */
export function estimateLiquidationPrice(input) {
  // Destructured INSIDE the body: a parameter-list destructure throws on an explicit `null`, and
  // this runs while the sheet paints.
  const { entryPrice, leverage, isLong } = input ?? {}
  const price = positiveNumber(entryPrice)
  const lev = positiveNumber(leverage)
  if (price === null || lev === null || (isLong !== true && isLong !== false)) return null
  const level = isLong ? price * (1 - 1 / lev) : price * (1 + 1 / lev)
  return level > 0 ? level : null
}

/**
 * Everything the confirm step shows, computed once from the same inputs the descriptor is built
 * from — so the number a member reads and the number they sign for cannot drift apart.
 *
 * Every field is null where it could not be derived; the sheet renders '—'. `feeUsd` is null both
 * when the rate is zero (there is no fee, so there is no line) and when the notional is unknown
 * (we cannot state the money impact, and FR-013 requires us to state it before a signature).
 *
 * THE VENUE'S FEE IS COMPUTED HERE, from the rate the venue published, for exactly the size shown.
 * It used to be a per-venue dollar figure nobody produced, so it was always '—' — and a dash beside
 * FairWins' fee in money reads as "FairWins is what this costs", which is the opposite of what this
 * disclosure is for. It is an ESTIMATE from a published rate, never a quote: `venueFeeAtFloor` says
 * when the venue's minimum-fee floor is what is being charged rather than the rate on this size,
 * and the sheet says so beside it.
 */
export function previewOpen(input) {
  const {
    collateralAmount,
    collateralDecimals,
    collateralUsdPrice: price,
    leverage,
    entryPrice,
    isLong,
    feeBps,
    venueFee = null,
  } = input ?? {}

  const human = toHumanAmount(collateralAmount, collateralDecimals)
  const usdPrice = positiveNumber(price)
  const collateralUsd = human !== null && usdPrice !== null ? human * usdPrice : null
  const lev = positiveNumber(leverage)
  const notionalUsd = collateralUsd !== null && lev !== null ? collateralUsd * lev : null

  const bps = numberOrNull(feeBps)
  const feeApplies = bps !== null && bps > 0
  const feeUsd = feeApplies && notionalUsd !== null ? feeUsdFromNotional(notionalUsd, bps) : null

  const venue = notionalUsd !== null ? venueFeeFromNotional(notionalUsd, venueFee, 'open') : null
  const costParts = [collateralUsd]
  if (feeApplies) costParts.push(feeUsd)
  if (venue !== null) costParts.push(venue.usd)
  const totalCostUsd = costParts.every((part) => part !== null)
    ? costParts.reduce((sum, part) => sum + part, 0)
    : null

  return {
    collateralUsd,
    notionalUsd,
    entryPrice: positiveNumber(entryPrice),
    liquidationPrice: estimateLiquidationPrice({ entryPrice, leverage, isLong }),
    feeBps: bps,
    feeApplies,
    feeUsd,
    venueFeeUsd: venue?.usd ?? null,
    venueFeeRate: venue?.rate ?? null,
    // The size the venue's fee is actually charged on. Equal to `notionalUsd` in the ordinary case,
    // and the venue's floor when the position is under it — which is the whole reason it is named.
    venueFeeChargedOnUsd: venue?.chargedOnUsd ?? null,
    venueFeeAtFloor: venue?.atFloor ?? false,
    totalCostUsd,
  }
}

/* ------------------------------------------------------------------------------------------- *
 * The descriptor
 * ------------------------------------------------------------------------------------------- */

/**
 * The price bound for an INCREASE, in human units.
 *
 * The mirror image of the exit path's bound, and the asymmetry is the trap: opening a LONG is a
 * buy, so `acceptablePrice` is a MAXIMUM; opening a SHORT is a sell, so it is a MINIMUM. Copying
 * the decrease helper here would produce an order that can never fill in one direction and no
 * protection at all in the other.
 */
export function increaseAcceptablePrice(price, isLong, slippagePct) {
  const p = positiveNumber(price)
  if (p === null) return null
  const s = Math.max(0, Number(slippagePct) || 0) / 100
  const bound = isLong ? p * (1 + s) : p * (1 - s)
  return bound > 0 ? bound : null
}

/**
 * The descriptor for opening a position.
 *
 * NOTE WHAT IS ABSENT: no `trader`, no `account`, no `receiver`. The member's address is supplied
 * by `usePerpsTrade` from the connected wallet and reaches the venue builders as `msg.sender`'s own
 * value; there is nowhere in this object to put a FairWins address in an ownership field, which is
 * the structural form of rule 1.
 */
export function buildOpenDescriptor(input) {
  const {
    venue,
    chainId,
    handle,
    isLong,
    collateral,
    collateralAmount,
    leverage,
    entryPrice,
    notionalUsd = null,
    collateralUsd = null,
    minNotional = null,
    minCollateralUsd = null,
    venueLimits = null,
    slippagePct = defaultSlippage(),
    stopLoss = null,
    takeProfit = null,
    quote = null,
    uiFeeReceiver = null,
    allowance = null,
  } = input ?? {}

  const label = venueLabelOf(venue)
  const chain = Number(chainId)
  if (!Number.isInteger(chain) || chain <= 0) {
    return refuse(`${label}’s network could not be determined, so a position cannot be opened here.`)
  }
  if (isLong !== true && isLong !== false) {
    return refuse('Choose whether you are going long or short.')
  }
  const amount = bigintOrNull(collateralAmount)
  if (amount === null || amount <= 0n) {
    return refuse('Enter how much you want to put into this position.')
  }
  const lev = positiveNumber(leverage)
  if (lev === null) return refuse('Choose a leverage for this position.')
  const price = positiveNumber(entryPrice)
  if (price === null) {
    return refuse(`The current price for this market could not be read just now, so a position cannot be priced here. You can open one on ${label}.`)
  }
  const token = typeof collateral?.address === 'string' && collateral.address.trim() !== ''
    ? collateral.address.trim()
    : null
  if (!token) {
    return refuse('The collateral for this position could not be identified, so it cannot be prepared here.')
  }

  // What the member is asked to confirm, checked BEFORE any wallet prompt (FR-022). The balance
  // travels in the SAME unit as the amount — base units on both sides — because `validateOpen`
  // refuses to compare a bigint against a human float rather than silently coercing one.
  const validate = {
    collateralAmount: amount,
    balance: bigintOrNull(collateral?.balance),
    leverage: lev,
    venueLimits: venueLimits ?? {},
    notional: notionalUsd,
    minNotional,
    // The USD pair travels together: `minCollateralUsd` is the venue's bound and `collateralUsd` is
    // the only value in the same unit. Sending one without the other would leave the validator
    // holding a bound it cannot check, which it correctly treats as a refusal.
    collateralUsd,
    minCollateralUsd,
  }

  // A spending allowance is a leading leg only when the member does not already have one. An
  // approval they do not need is a second signature that buys them nothing.
  const held = bigintOrNull(allowance)
  const approval = held !== null && held >= amount ? null : { token, amount }

  if (venue === 'gains') {
    const pairIndex = numberOrNull(handle?.pairIndex)
    const collateralIndex = numberOrNull(collateral?.collateralIndex)
    if (pairIndex === null) {
      return refuse(`${label}’ own number for this market could not be read, so a position cannot be opened here. You can open one on ${label}.`)
    }
    // 1-BASED at the venue: a 0 here is not "the first collateral", it is an invalid index.
    if (collateralIndex === null || collateralIndex <= 0) {
      return refuse(`${label}’ own number for this collateral could not be read, so a position cannot be opened here. You can open one on ${label}.`)
    }
    return {
      ok: true,
      descriptor: {
        action: 'open',
        venue,
        chainId: chain,
        validate,
        approval,
        params: {
          pairIndex,
          collateralIndex,
          collateralAmount: amount,
          leverage: lev,
          long: isLong,
          openPrice: price,
          tp: positiveNumber(takeProfit),
          sl: positiveNumber(stopLoss),
          maxSlippageP: slippagePct,
          // NO REFERRER. Gains pays a referral share only to an address it has whitelisted, and it
          // has not whitelisted FairWins — so an address here would earn nothing while placing a
          // FairWins address one field away from `Trade.user`. `null` degrades to the zero address.
          referrer: null,
        },
      },
    }
  }

  if (venue === 'gmx') {
    const market = typeof handle?.market === 'string' ? handle.market : null
    if (!market) {
      return refuse(`${label}’s own market for this pair could not be read, so a position cannot be opened here. You can open one on ${label}.`)
    }
    const executionFee = bigintOrNull(quote?.executionFee)
    if (executionFee === null || executionFee <= 0n) {
      return refuse(`${label}’s keeper fee for this order could not be read just now, so a position cannot be prepared here. You can open one on ${label}.`)
    }
    const size = positiveNumber(notionalUsd)
    if (size === null) {
      return refuse(`This position’s size in dollars could not be worked out, so it cannot be prepared here. You can open one on ${label}.`)
    }
    const acceptablePrice = increaseAcceptablePrice(price, isLong, slippagePct)
    if (acceptablePrice === null) {
      return refuse(`The current price for this market could not be read just now, so a position cannot be priced here. You can open one on ${label}.`)
    }
    return {
      ok: true,
      descriptor: {
        action: 'open',
        venue,
        chainId: chain,
        validate,
        approval,
        params: {
          market,
          collateralToken: token,
          collateralAmount: amount,
          sizeDeltaUsd: size,
          acceptablePrice,
          executionFee,
          isLong,
          // The ONLY FairWins address in this calldata, and it is a fee field, never an owner one.
          uiFeeReceiver,
        },
      },
    }
  }

  return refuse('Positions on this venue are opened on the venue’s own app.')
}

/* ------------------------------------------------------------------------------------------- *
 * Reads — the venue's own numbers, never assumed
 * ------------------------------------------------------------------------------------------- */

/**
 * The keeper fee an INCREASE carries, which is a different order kind — and a different DataStore
 * gas limit — from the decrease the exit sheet reads. Using the decrease estimate here would
 * under-fund the order and GMX would cancel it after the member had signed.
 *
 * → `{ executionFee, estimate }`, `{ failed: true }`, or `null` where the venue has no such fee.
 */
export async function defaultReadOpenQuote({ venue, chainId, deps } = {}) {
  if (venue !== 'gmx') return null
  try {
    const estimate = await readExecutionFee({ chainId, orderKind: GMX_ORDER_KIND.INCREASE, ...(deps ?? {}) })
    if (!estimate || typeof estimate.fee !== 'bigint' || estimate.fee <= 0n) return { failed: true }
    return { executionFee: estimate.fee, estimate }
  } catch {
    return { failed: true }
  }
}

/** Who actually pulls the collateral. On GMX this is the Router, NOT the ExchangeRouter we call. */
export function collateralSpenderFor(venue, chainId) {
  if (venue === 'gains') return gainsDiamondFor(chainId)
  if (venue === 'gmx') return gmxAddressesFor(chainId)?.router ?? null
  return null
}

/**
 * The member's existing spending allowance for the venue's collateral puller.
 *
 * `null` means "we could not ask", which is deliberately NOT the same as `0n`: an unreadable
 * allowance makes the sheet include an approval leg (harmless if redundant), whereas treating it as
 * zero-and-known would be a claim about the member's wallet we cannot support.
 */
export async function defaultReadAllowance(input) {
  const { venue, chainId, token, owner, getProvider = getReadProvider, makeContract = defaultErc20 } = input ?? {}
  const spender = collateralSpenderFor(venue, chainId)
  if (!spender || typeof token !== 'string' || typeof owner !== 'string') return null
  try {
    const provider = getProvider(chainId)
    if (!provider) return null
    return bigintOrNull(await makeContract(token, provider, chainId).allowance(owner, spender))
  } catch {
    return null
  }
}

/**
 * The default ERC-20 reader. `chainId` is a THIRD argument rather than a replacement: the
 * `makeContract` seam is injected by tests, and an added parameter leaves every existing fake
 * working unchanged while the real one names the chain it reads (spec 110). `provider` stays the
 * availability gate the callers already check before getting here.
 */
function defaultErc20(address, provider, chainId) {
  const call = (functionName, args) =>
    readContract(chainId, { address, abi: ERC20_ABI, functionName, args })
  return {
    balanceOf: (owner) => call('balanceOf', [owner]),
    allowance: (owner, spender) => call('allowance', [owner, spender]),
  }
}

/* ------------------------------------------------------------------------------------------- *
 * The entry gates — reachable from here, and from nowhere on the exit path
 * ------------------------------------------------------------------------------------------- */

/**
 * Sanctions screening for an OPEN, in the shape `usePerpsTrade#runEntryGates` consumes:
 * `'clear'` / `'restricted'` / anything else (which the hook treats as unconfirmed and refuses).
 *
 * **It screens on the COHORT'S REFERENCE CHAIN, not the venue's chain**, and the venue chain
 * argument is accepted and ignored on purpose. The `SanctionsGuard` is a FairWins contract deployed
 * where FairWins operates — Polygon on a mainnet build — and it is not deployed on Arbitrum or Base
 * at all. Screening the venue's chain would therefore answer "could not be checked" for every
 * member on every open: not a safety property, just a surface that never works. The restriction is
 * a fact about the member's FairWins account, so it is read from the contract that holds it (the
 * spec-071 rule: authority is the contract that will act on it).
 *
 * Fail-closed by construction: an unreadable guard yields `'unconfirmed'`, which the hook refuses.
 */
export async function defaultScreenAccount(account, _venueChainId, deps) {
  const { getProvider = getReadProvider, screen = screenAddress, chainId = referenceChainId } = deps ?? {}
  if (typeof account !== 'string' || account.trim() === '') return 'unconfirmed'
  try {
    const provider = getProvider(typeof chainId === 'function' ? chainId() : chainId)
    if (!provider) return 'unconfirmed'
    const result = await screen(account, provider)
    if (!result?.available) return 'unconfirmed'
    return result.allowed ? 'clear' : 'restricted'
  } catch {
    return 'unconfirmed'
  }
}

/**
 * Where the guard lives for this build. `membershipChainId()` already derives the cohort's
 * reference chain from the build's own mainnet/testnet pair, so this cannot resolve a mainnet guard
 * in a testnet build (constitution III).
 */
export function referenceChainId() {
  try {
    return membershipChainId()
  } catch {
    return MAINNET_CHAIN_ID
  }
}
