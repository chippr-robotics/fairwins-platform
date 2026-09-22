/**
 * What a GMX position is worth, worked out from GMX's own position read (spec 083, US1).
 *
 * WHY THIS EXISTS. `Reader.getAccountPositions` returns `Position.Props` — `sizeInUsd` (1e30),
 * `sizeInTokens` (the INDEX token's own decimals), `collateralAmount` (the COLLATERAL token's own
 * decimals) and the side — and nothing else. It returns no entry price, no leverage, no P&L and no
 * mark price, so `usePerpsPositions` published all four as null and a member closing a leveraged
 * GMX position read six dashes in a row: entry, leverage, liquidation, P&L, proceeds and the
 * venue's fee. Three of those are not missing data at all — they are arithmetic over numbers the
 * venue DID report, once the scales are known.
 *
 * WHERE THE SCALES COME FROM — the pairs feed already on screen, not a new network read. The
 * gateway publishes each GMX market with its accepted collaterals, their decimals and GMX's own USD
 * price for them (`normalizeGmxPairs`), which is exactly what turns `collateralAmount` into money.
 * The INDEX token's decimals are not published as such, so they are read off the same list — see
 * `gmxIndexDecimals` for what that assumes and, more importantly, for when it refuses.
 *
 * FIVE RULES, and every one of them is about not inventing a number in front of a member's money:
 *
 *  1. **A DERIVED FIGURE IS NEVER PRESENTED AS THE VENUE'S.** Every row this module touches carries
 *     `derivedFields` naming exactly what FairWins worked out, and the surfaces label those (the
 *     sheet's "calculated" tag and its attribution sentence). The alternative — filling the same
 *     fields the gateway fills for Gains — would silently turn our arithmetic into GMX's own
 *     figures under the sentence "every figure above is as GMX reports it".
 *  2. **THE P&L IS NOT WHAT GMX WILL SETTLE AT.** It is size-in-tokens marked at the current price
 *     against the position's notional: it EXCLUDES accrued borrowing and funding (the accumulators
 *     are on the position, but the pool-side factors they are applied against are not read here)
 *     and the price impact of actually closing. Both surfaces say so.
 *  3. **ANY MISSING INPUT ⇒ null, NEVER A PARTIAL FIGURE.** No market match, no decimals, no price,
 *     a zero size — each leaves the field null and renders '—'. A wrong entry price on a leveraged
 *     position is worse than none.
 *  4. **THE LIQUIDATION PRICE IS NOT DERIVED AND MUST NOT BE.** It needs GMX's min-collateral
 *     factor and the accrued borrowing/funding, which this app does not read. It stays null and the
 *     sheet says specifically why, because that is the number a member expects most.
 *  5. **NOTHING HERE IS A GATE.** Pure functions over plain data — no network, no clock, no
 *     permission question. This module sits on the exit path (it is what a member reads before
 *     closing) and is classified there in `test/perps/safetyInvariants.test.js`.
 */
import { formatUnits } from '../evm/units'
import { findGmxPair } from './gmxMarkets'

/** The fields this module may fill in. Nothing else on a position row is ever written here. */
export const GMX_DERIVED_FIELDS = Object.freeze([
  'entryPrice',
  'leverage',
  'collateralUsd',
  'unrealizedPnlUsd',
])

/** `Position.sizeInUsd` and every other GMX USD value is 1e30 fixed point. */
const GMX_USD_DECIMALS = 30

/**
 * How far the derived entry price may sit from the venue's own current price before the index
 * scale is treated as unconfirmed.
 *
 * This is a DECIMALS check, not a market-plausibility one. Getting the index token's decimals wrong
 * moves the entry price by a factor of at least ten and usually 10^10, so a band this wide catches
 * every such error while accepting any position a market could actually produce (a 100× move
 * against a leveraged position liquidates long before it gets here). It can only ever turn a figure
 * into '—' — it never changes one.
 */
const MAX_ENTRY_MARK_RATIO = 100

/**
 * The index token's decimals for a GMX market, or null.
 *
 * GMX does not publish the index token's decimals to this app, so they are taken from the market's
 * OWN collateral list: on every non-synthetic GMX market the long collateral IS the index asset
 * (ETH/USD [WETH-USDC] collateralises in WETH, BTC/USD [WBTC.e-USDC] in WBTC.e), and a wrapped or
 * bridged form of an asset carries that asset's decimals.
 *
 * THE REFUSALS ARE THE POINT. A synthetic market — DOGE/USD [WETH-USDC] — has no collateral naming
 * its index asset, so this returns null and every figure that needs the index scale stays '—'. So
 * does a market whose two candidates disagree about decimals. Nothing here falls back to 18: an
 * assumed scale on a WBTC market would misstate the entry price by 10^10.
 */
export function gmxIndexDecimals(pair) {
  const base = upper(pair?.base) ?? baseFromSymbol(pair?.symbol)
  if (!base) return null
  const matches = (Array.isArray(pair?.collaterals) ? pair.collaterals : []).filter((c) =>
    namesAsset(c?.symbol, base),
  )
  const decimals = new Set(matches.map((c) => tokenDecimals(c?.decimals)).filter((d) => d !== null))
  return decimals.size === 1 ? [...decimals][0] : null
}

/**
 * The collateral record a GMX position is actually held in, matched on the token ADDRESS.
 *
 * Never on the symbol: a market's two collaterals can share a base name (a WBTC.b/WBTC pair would),
 * and pricing a member's collateral off the wrong token is the same class of error as pricing it
 * off the wrong market. No match ⇒ null ⇒ no collateral value and no leverage.
 */
export function gmxCollateralOf(position, pair) {
  const address = lowerAddress(position?.venueRef?.collateralToken ?? position?.raw?.collateralToken)
  if (!address) return null
  const list = Array.isArray(pair?.collaterals) ? pair.collaterals : []
  const found = list.filter((c) => lowerAddress(c?.address) === address)
  return found.length === 1 ? found[0] : null
}

/**
 * One GMX position + its market record → the figures GMX did not report but its own numbers imply.
 *
 * Returns all four keys always, each a number or null, so a caller never has to distinguish
 * "absent" from "could not be established" — to a member they are the same dash.
 *
 * @param {object} position a `PerpPosition` from `usePerpsPositions` (its `raw` is the venue read)
 * @param {object} pair     the market's record from `buildGmxMarketIndex`, or null
 */
export function deriveGmxFigures(position, pair) {
  const none = { entryPrice: null, leverage: null, collateralUsd: null, unrealizedPnlUsd: null }
  if (position?.venue !== 'gmx') return none
  const raw = position?.raw ?? null
  if (!raw || typeof raw !== 'object') return none

  const sizeUsd = usdUnits(raw.sizeInUsd) ?? positiveNumber(position.sizeUsd)
  if (sizeUsd === null) return none

  /* Collateral, and with it leverage. Deliberately independent of the index scale: a synthetic
   * market with no index decimals still gets a collateral value and a leverage, because those come
   * from the collateral token alone. Half an answer is fine when each half is exact; what is
   * forbidden is half a NUMBER. */
  const collateral = gmxCollateralOf(position, pair)
  const collateralUsd = multiply(
    humanUnits(raw.collateralAmount, tokenDecimals(collateral?.decimals)),
    positiveNumber(collateral?.usdPrice),
  )
  const leverage = collateralUsd !== null && collateralUsd > 0 ? sizeUsd / collateralUsd : null

  const sizeTokens = humanUnits(raw.sizeInTokens, gmxIndexDecimals(pair))
  if (sizeTokens === null || sizeTokens <= 0) return { ...none, collateralUsd, leverage }

  const entryPrice = sizeUsd / sizeTokens
  const markPrice = positiveNumber(pair?.price)

  // The scale check (see MAX_ENTRY_MARK_RATIO): an entry price that cannot be reconciled with the
  // venue's own current price means the index decimals are not what this module took them to be,
  // and BOTH index-scaled figures go rather than one of them being quietly wrong.
  if (markPrice !== null) {
    const ratio = entryPrice / markPrice
    if (!Number.isFinite(ratio) || ratio > MAX_ENTRY_MARK_RATIO || ratio < 1 / MAX_ENTRY_MARK_RATIO) {
      return { ...none, collateralUsd, leverage }
    }
  }

  const isLong = sideOf(position)
  const unrealizedPnlUsd =
    markPrice === null || isLong === null
      ? null
      : isLong
        ? sizeTokens * markPrice - sizeUsd
        : sizeUsd - sizeTokens * markPrice

  return { entryPrice, leverage, collateralUsd, unrealizedPnlUsd }
}

/**
 * Positions with each GMX row's derivable figures filled in and NAMED as derived.
 *
 * Every other row passes through untouched (per-venue isolation: nothing about a Gains position may
 * change because of what GMX did or did not report), and a field the venue itself reported is never
 * overwritten — a producer's own answer outranks this arithmetic, exactly as `withGmxMarketSymbols`
 * treats a symbol.
 *
 * Returns the ORIGINAL array when nothing was derived, so a memo downstream does not see a new
 * identity on every poll that changed nothing.
 */
export function withGmxDerivedFigures(positions, index) {
  const rows = Array.isArray(positions) ? positions : []
  let changed = false
  const next = rows.map((row) => {
    if (row?.venue !== 'gmx') return row
    const missing = GMX_DERIVED_FIELDS.filter((field) => row[field] == null)
    if (missing.length === 0) return row
    const figures = deriveGmxFigures(row, findGmxPair(row, index))
    const filled = missing.filter((field) => figures[field] !== null)
    if (filled.length === 0) return row
    changed = true
    const patch = {}
    for (const field of filled) patch[field] = figures[field]
    return Object.freeze({ ...row, ...patch, derivedFields: Object.freeze(filled) })
  })
  return changed ? next : rows
}

/**
 * Whether a figure on a row was worked out here rather than reported by the venue. Total, and false
 * for everything it has no reason to be true of — a surface asks this to decide whether to label a
 * number, so an error would either mislabel a venue figure or leave ours unlabelled.
 */
export function isDerivedFigure(position, field) {
  const fields = position?.derivedFields
  return Array.isArray(fields) && fields.includes(field)
}

/* ------------------------------------------------------------------------------------------- *
 * Internals — every one of them total
 * ------------------------------------------------------------------------------------------- */

/** 1e30 venue units → a display number, or null. Never NaN, never a silent 0. */
function usdUnits(units) {
  const n = humanUnits(units, GMX_USD_DECIMALS)
  return n === null || n <= 0 ? null : n
}

/** Raw token units → a human number at `decimals`, or null for anything that is not exact. */
function humanUnits(units, decimals) {
  if (units == null || decimals === null) return null
  if (typeof units === 'number' && !Number.isInteger(units)) return null
  if (typeof units === 'string' && !/^-?\d+$/.test(units.trim())) return null
  try {
    const n = Number(formatUnits(units, decimals))
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** A token decimals value, or null. 0 is a legal decimals; 18 is never assumed. */
function tokenDecimals(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null
}

function multiply(a, b) {
  if (a === null || b === null) return null
  const n = a * b
  return Number.isFinite(n) ? n : null
}

function positiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** true / false / null — the side, from the branded ref first and the venue read second. */
function sideOf(position) {
  const ref = position?.venueRef?.isLong
  if (typeof ref === 'boolean') return ref
  const raw = position?.raw?.isLong
  if (typeof raw === 'boolean') return raw
  if (position?.direction === 'long') return true
  if (position?.direction === 'short') return false
  return null
}

function upper(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : null
}

/** 'BTC/USD' → 'BTC'. The pair's own `base` is preferred; this is the fallback. */
function baseFromSymbol(symbol) {
  const s = upper(symbol)
  if (!s || !s.includes('/')) return null
  return upper(s.split('/')[0])
}

/**
 * Whether a collateral symbol names the market's base asset — 'WETH' and 'WBTC.e' do, 'USDC' does
 * not. The bridged suffix is stripped before the wrapper prefix so 'WBTC.e' → 'WBTC' → 'BTC', and
 * the exact match is tried FIRST so a base that legitimately begins with W (WIF) is not mangled
 * into something else.
 */
function namesAsset(symbol, base) {
  const s = upper(symbol)
  if (!s || !base) return false
  if (s === base) return true
  const unbridged = s.replace(/\.[A-Z0-9]+$/, '')
  if (unbridged === base) return true
  return unbridged.length > 1 && unbridged.startsWith('W') && unbridged.slice(1) === base
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function lowerAddress(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value.toLowerCase() : null
}
