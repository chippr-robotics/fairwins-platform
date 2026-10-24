/**
 * usePerpsPositions (spec 082 US2, extended by spec 083 T032) — the connected account's open perp
 * positions per venue, and the venue handles a sheet needs to act on one.
 *
 * TWO SOURCES, ONE LIST:
 *
 *   - **The gateway** (`/v1/perps/positions`) serves Gains and Hyperliquid. Since spec 083 each
 *     Gains position carries a `venueRef` — the identifiers the calldata builders consume. It is
 *     read DEFENSIVELY: a payload with no refs is an older gateway build, and those positions must
 *     still render (with `venueRef: null`) rather than disappearing from a member's own list.
 *   - **GMX** is read here, client-side, from GMX's `Reader.getAccountPositions` on Arbitrum. The
 *     gateway deliberately does not serve it (the GMX REST API does not expose positions), so the
 *     venue would otherwise be honestly absent forever. The app's read provider is used —
 *     `getReadProvider`, never a hand-built endpoint — so a member's own RPC settings apply
 *     (spec 069).
 *
 * PER-VENUE ISOLATION IN BOTH DIRECTIONS. A GMX read failure marks GMX unreadable and disturbs
 * nothing else; a gateway outage leaves the GMX positions on screen and NAMES the venues that went
 * missing, because an absent Gains position rendered silently reads as "you have no position".
 *
 * HONEST NUMBERS. Every value comes from the venue that reported it. GMX's Reader gives size in
 * 1e30 USD and nothing else this hook can price — collateral is in the collateral token's own
 * decimals with no price attached, and entry/leverage/PnL all need data the Reader does not fetch —
 * so those stay `null` and render '—'. None of them may become 0.
 *
 * NOTHING HERE MAY BECOME A GATE. This list is what a member closes a position FROM, so it is
 * produced under every restriction the product has: no attestation, no management kill switch, no
 * screening, and no "would the venue accept an open" question is consulted, and a sibling test
 * asserts that over this file's own source. `available()` is the spec-082 gateway/cohort switch and
 * stays exactly as phase 0 had it — it decides whether this build reads mainnet venues at all
 * (a testnet cohort must not, constitution III), not whether a member may manage what it finds.
 *
 * Conventions carried over from phase 0 and shared with `usePerpsOrders.js`: a 60s poll aligned
 * with the portfolio cadence, a request-id stale guard, a synchronous hard reset before paint on
 * account change, and injectable deps.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readContract } from '../lib/chains/readContract'
import { getPublicClient } from '../lib/chains/publicClient'

import { GMX_READER_ABI } from '../abis/perps/gmxReader'
import { gmxAddressesFor, perpsAvailable } from '../config/perps'
import { fetchPerpPositions } from '../lib/perps/perpsClient'
import { tradeIndex as gainsTradeIndex } from '../lib/perps/venues/gains'
import { GMX_CHAIN_ID, decodeAccountPositions, fromUsdUnits } from '../lib/perps/venues/gmx'

const POLL_MS = 60_000

/**
 * How many of the account's GMX positions one read asks for. `getAccountPositions` is a paged read
 * (`start`, `end`) over the account's own key set, so the limit is a bound on the response, not a
 * filter. A member at the bound may have more, which is why `sources.gmx.truncated` exists — an
 * incomplete list is disclosed, never presented as the whole truth.
 */
export const GMX_POSITION_PAGE_LIMIT = 250

/**
 * Per-venue read outcome in the spec-071 estate vocabulary, matching `usePerpsOrders`. It applies
 * to the venue THIS hook reads (GMX); the gateway's own `sources` entries pass through in the
 * gateway's vocabulary (`read` / `degraded`) so nothing spec-082 consumed changes shape.
 */
export const POSITION_SOURCE_STATUS = Object.freeze({
  READ: 'read',
  NOT_DEPLOYED: 'not-deployed',
  UNREADABLE: 'unreadable',
})

/**
 * Both words for "we could not read this venue" — the gateway says `degraded`, the estate
 * vocabulary says `unreadable`. A venue must never fall out of `unreadableVenues` (and so out of
 * the surface's disclosure) because of which of the two arrived.
 */
const UNREADABLE_STATUSES = new Set(['degraded', POSITION_SOURCE_STATUS.UNREADABLE])

/**
 * The venues the gateway serves positions for (`services/relay-gateway/src/perps/routes.js`). When
 * the gateway itself is unreachable there is no `sources` map to pass through, so these are named
 * unreadable from here — the alternative is a list that quietly omits a member's Gains position
 * next to a GMX one, which reads as proven absence. Naming a venue this gateway may not have
 * configured at all is the safe direction to be wrong in: it over-discloses, never under-discloses.
 */
const GATEWAY_POSITION_VENUES = Object.freeze(['gains', 'hyperliquid'])

export function usePerpsPositions(account, { deps } = {}) {
  const io = {
    fetchPositions: fetchPerpPositions,
    available: perpsAvailable,
    getProvider: defaultGetProvider,
    makeContract: defaultMakeContract,
    addressesFor: gmxAddressesFor,
    gmxChainId: GMX_CHAIN_ID,
    positionLimit: GMX_POSITION_PAGE_LIMIT,
    ...deps,
  }
  const supported = io.available() && Boolean(account)

  const [status, setStatus] = useState('idle') // 'idle' | 'loading' | 'ready' | 'unavailable'
  const [positions, setPositions] = useState([])
  const [sources, setSources] = useState({})
  const reqIdRef = useRef(0)
  const ioRef = useRef(io)
  useEffect(() => {
    ioRef.current = io
  })

  const load = useCallback(async (addr) => {
    if (!addr || !ioRef.current.available()) {
      setStatus('idle')
      return
    }
    const reqId = ++reqIdRef.current
    const bag = ioRef.current

    // PER-VENUE ISOLATION. `allSettled`, not `all`: the gateway read and the GMX read fail
    // independently and neither may blank the other. `begin` starts both SYNCHRONOUSLY (a deferred
    // start would delay the first read of every poll by a microtask) while still turning a
    // dependency that throws on the way in into a settled rejection.
    const [gateway, gmx] = await Promise.allSettled([
      begin(() => bag.fetchPositions(addr)),
      begin(() => loadGmxPositions(addr, bag)),
    ])
    if (reqIdRef.current !== reqId) return // a newer request (or another account) owns the state

    const body = gateway.status === 'fulfilled' ? gateway.value : null
    const gmxRead =
      gmx.status === 'fulfilled' && gmx.value
        ? gmx.value
        : { positions: [], source: unreadableSource('gmx', null, failureDetail(gmx.reason)) }

    const gatewayPositions = Array.isArray(body?.positions) ? body.positions.map(withVenueRef) : []
    const gatewayRead = body != null
    const gmxReadable = gmxRead.source.status === POSITION_SOURCE_STATUS.READ

    if (!gatewayRead && !gmxReadable) {
      // Nothing could be determined about any venue. The surface's own "positions could not be read"
      // state is then the whole truth, and a per-venue banner beside it would claim that some other
      // venue is unaffected when none was reached. Phase-0 behaviour, unchanged.
      setPositions([])
      setSources({})
      setStatus('unavailable')
      return
    }

    const next = { ...(body?.sources ?? {}) }
    if (!gatewayRead) {
      for (const venue of GATEWAY_POSITION_VENUES) {
        next[venue] = unreadableSource(venue, null, gatewayFailureDetail(gateway.reason))
      }
    }
    next.gmx = gmxRead.source

    setPositions([...gatewayPositions, ...gmxRead.positions])
    setSources(next)
    setStatus('ready')
  }, [])

  // Account change (or connect/disconnect): hard reset BEFORE paint so another account's
  // positions — and the venue handles pointed at them — never render for this one (US2 acceptance 3).
  useEffect(() => {
    reqIdRef.current += 1
    setPositions([])
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

  /**
   * The venues whose absence from this list must be QUALIFIED on screen.
   *
   * Two facts land here, and they are the same fact to a member. A venue that did not answer at
   * all is `degraded`/`unreadable`. A venue that answered INCOMPLETELY is `read` with
   * `partial: true` — Hyperliquid's case: it is not one order book but a default one plus
   * validator-operated perp dexes (HIP-3), each read separately, so a dex that did not answer is a
   * part of the member's own position set we did not see. An empty Hyperliquid list rendered
   * beside a silently-skipped dex is the fabricated absence spec 083 went and fixed in the gateway
   * (hyperliquid-decision.md §5.2); dropping the disclosure here would put it straight back.
   *
   * Naming a partially-read venue here over-discloses slightly — some of it WAS read — and that is
   * the direction this file already chooses to be wrong in, for the reason above the constant.
   */
  const unreadableVenues = useMemo(
    () =>
      Object.entries(sources)
        .filter(([, s]) => UNREADABLE_STATUSES.has(s?.status) || s?.partial === true)
        .map(([venue]) => venue),
    [sources],
  )

  return { status, supported, positions, sources, unreadableVenues, refresh: () => load(account) }
}

/* ------------------------------------------------------------------------------------------- *
 * Venue refs — the handles a sheet acts through
 * ------------------------------------------------------------------------------------------- */

/**
 * A gateway position with its venue ref normalized. Every other field is passed through EXACTLY as
 * spec 082 shipped it — the phase-0 UI reads them.
 *
 * A row with no ref keeps `venueRef: null` and still renders. That is not defensive coding for its
 * own sake: the gateway change ships alongside this one, so an older gateway is a live possibility,
 * and a position dropped from the list because we could not act on it would be a member's exposure
 * hidden from them.
 */
function withVenueRef(row) {
  if (!row || typeof row !== 'object') return row
  return { ...row, venueRef: normalizeVenueRef(row) }
}

function normalizeVenueRef(row) {
  const ref = row.venueRef
  if (!ref || typeof ref !== 'object') return null
  const venue = typeof ref.venue === 'string' && ref.venue ? ref.venue : row.venue
  if (venue !== 'gains') {
    // A ref for a venue this build does not know how to brand is carried through untouched rather
    // than dropped: losing it would hide a handle the gateway went out of its way to publish.
    return Object.freeze({ ...ref })
  }
  return gainsVenueRef(ref, row)
}

/**
 * The Gains handles, with the trade index BRANDED the moment it crosses into this app.
 *
 * THE INDEX TRAP, and the field name is the defence. Gains has two disjoint uint32 index spaces —
 * a TRADE index (`closeTradeMarket` / `updateTp` / `updateSl` / `decreasePositionSize`) and a
 * PENDING-ORDER index (`cancelOrderAfterTimeout` only). Passing one where the other belongs does
 * not revert; it acts on a DIFFERENT OBJECT. JSON carries no brands, so the gateway emits
 * `venueRef.tradeIndex` and `venueRef.pendingOrderIndex` by name and never a bare `index` — and
 * this function reads `tradeIndex` and NOTHING else. Never widen it to `ref.index`, `row.index`, or
 * `ref.pendingOrderIndex`: the position id string `gains:<chain>:<index>` looks like a source for
 * one, and on a raw venue payload the same name means the other one level down.
 *
 * An index the gateway could not establish stays `null` — a sheet must refuse to act rather than
 * aim a close at whatever trade happens to hold a guessed number.
 */
function gainsVenueRef(ref, row) {
  return Object.freeze({
    venue: 'gains',
    chainId: toChainId(ref.chainId) ?? toChainId(row.chainId),
    tradeIndex: attempt(() => (ref.tradeIndex == null ? null : gainsTradeIndex(ref.tradeIndex))),
    pairIndex: toUint(ref.pairIndex),
    collateralIndex: toUint(ref.collateralIndex),
    collateralToken: toAddress(ref.collateralToken),
    collateralDecimals: toUint(ref.collateralDecimals),
    // 10**decimals, as an exact integer: it reaches 1e18 for DAI/WETH markets, past the range where
    // a float round-trip is guaranteed exact, so it crosses the wire as digits and becomes a bigint
    // here rather than a number the calldata builders would refuse anyway.
    collateralPrecision: toBigIntOrNull(ref.collateralPrecision),
  })
}

/* ------------------------------------------------------------------------------------------- *
 * GMX — positions from the Reader, client-side
 * ------------------------------------------------------------------------------------------- */

/**
 * The member's GMX v2 positions on Arbitrum.
 *
 * `Reader.getAccountPositions(dataStore, account, start, end)` returns `Position.Props[]` and an
 * EMPTY ARRAY for an account with no positions — absence is not an error here and must never render
 * as a failed read.
 *
 * The decoding is `decodeAccountPositions` from `lib/perps/venues/gmx.js` and there is deliberately
 * no second decoder: `Props` is 14 static words, so a `Props[]` is tightly packed and dropping a
 * trailing field nobody "needs" changes the element stride — every position after the first then
 * decodes into garbage without erroring. One decoder, checked against live returndata, is the whole
 * defence against that.
 *
 * Never rejects: it returns an unreadable source instead, because the caller renders a list.
 */
async function loadGmxPositions(account, io) {
  const chainId = toChainId(io.gmxChainId) ?? GMX_CHAIN_ID

  const addresses = attempt(() => io.addressesFor(chainId))
  if (!addresses?.reader || !addresses?.dataStore) {
    return {
      positions: [],
      source: source('gmx', chainId, POSITION_SOURCE_STATUS.NOT_DEPLOYED, {
        detail: 'GMX v2 is only deployed on Arbitrum.',
      }),
    }
  }

  const provider = attempt(() => io.getProvider(chainId))
  if (!provider) {
    return { positions: [], source: unreadableSource('gmx', chainId, 'No read connection to Arbitrum.') }
  }

  const reader = attempt(() => io.makeContract(addresses.reader, GMX_READER_ABI, provider))
  if (!reader) {
    return { positions: [], source: unreadableSource('gmx', chainId, 'GMX could not be read just now.') }
  }

  const limit = toLimit(io.positionLimit)
  let result
  try {
    result = await reader.getAccountPositions(addresses.dataStore, account, 0, limit)
  } catch (e) {
    // A dead endpoint, a timeout, a reverted read — one fact to a member: we could not look. Never
    // an empty list, which would read as "you hold nothing on GMX".
    return { positions: [], source: unreadableSource('gmx', chainId, failureDetail(e)) }
  }

  const decoded = decodeAccountPositions(result)
  const positions = decoded.map((p) => toGmxPosition(p, chainId))
  const rows = rowCount(result)
  return {
    positions,
    source: readSource('gmx', chainId, {
      count: positions.length,
      limit,
      // A response that filled the page may not be the whole set, and a row the decoder could not
      // read is a position that exists and is missing here. Both are disclosed rather than smoothed
      // over. The row count falls back to the decoded count because raw returndata has no rows to
      // count — it can only ever under-report truncation, never invent it.
      truncated: (rows ?? positions.length) >= limit,
      partial: rows != null && rows > positions.length,
    }),
  }
}

/**
 * One decoded `Position.Props` → the `PerpPosition` shape the gateway venues already use.
 *
 * Only two display facts survive the trip honestly: the direction and the 1e30 notional. Everything
 * else the row could carry needs data the Reader does not return — collateral is in the collateral
 * token's own decimals with no price, and entry price, leverage and PnL all need a mark price or
 * the index token's decimals — so each is null and renders '—'. Deriving any of them from what is
 * here would be a fabricated number in front of a member's money.
 *
 * The venue-unit position travels along as `raw`, so a sheet can show the venue's own figures and
 * re-read them at signing time rather than re-deriving them from a float.
 */
function toGmxPosition(p, chainId) {
  return Object.freeze({
    id: `gmx:${chainId}:${p.key ?? `${p.market}:${p.collateralToken}:${p.isLong ? 'long' : 'short'}`}`,
    venue: 'gmx',
    chainId,
    // The Reader names a MARKET ADDRESS, not a pair. Naming the pair needs the venue's market
    // list, which this hook does not fetch — so it stays null here rather than being guessed from
    // an address. The composition point resolves it against the pairs feed it already has
    // (`lib/perps/gmxMarkets.js`, keyed on `venueRef.market`); a market that feed does not list
    // stays null all the way to the screen and renders '—'.
    symbol: null,
    direction: p.isLong ? 'long' : 'short',
    sizeUsd: usdNumber(p.sizeInUsd),
    collateralUsd: null,
    entryPrice: null,
    leverage: null,
    unrealizedPnlUsd: null,
    // Identifiers only — never the mutable state a close is built from. `positionKey` is
    // keccak(account, market, collateralToken, isLong), so these four ARE the position's identity;
    // sizes and collateral are re-read at signing time because a cached amount is already stale.
    venueRef: Object.freeze({
      venue: 'gmx',
      chainId,
      positionKey: p.key,
      market: p.market,
      collateralToken: p.collateralToken,
      isLong: p.isLong,
    }),
    raw: Object.freeze(p),
  })
}

/* ------------------------------------------------------------------------------------------- *
 * Sources + total coercions
 * ------------------------------------------------------------------------------------------- */

function source(venue, chainId, status, extra = {}) {
  return Object.freeze({
    venue,
    chainId: chainId == null ? null : Number(chainId),
    status,
    detail: null,
    // Present only on a `read`, so `?? 0` has nowhere to live: an unreadable venue has no count,
    // and a zero there would be a fabricated "no positions" (the spec-071 estate rule).
    count: null,
    limit: null,
    truncated: false,
    partial: false,
    ...extra,
  })
}

function readSource(venue, chainId, extra) {
  return source(venue, chainId, POSITION_SOURCE_STATUS.READ, extra)
}

function unreadableSource(venue, chainId, detail) {
  return source(venue, chainId, POSITION_SOURCE_STATUS.UNREADABLE, { detail })
}

function failureDetail(error) {
  const message = typeof error?.shortMessage === 'string' ? error.shortMessage : error?.message
  return message ? `This venue could not be read just now (${message}).` : 'This venue could not be read just now.'
}

function gatewayFailureDetail(error) {
  if (error?.code === 'unconfigured') {
    return 'This build has no connection to the perps service, so these positions cannot be listed here.'
  }
  return failureDetail(error)
}

// Spec 110 Phase 1: the DEFAULTS are seam-backed while the injectable test contracts keep
// their shape — `getProvider(chainId)` yields a read handle, `makeContract(address, abi,
// provider)` yields the one GMX reader view this hook calls.
function defaultGetProvider(chainId) {
  const client = getPublicClient(chainId)
  if (!client) return null
  return { readContract: (args) => readContract(chainId, args) }
}

function defaultMakeContract(address, abi, provider) {
  return {
    getAccountPositions: (...args) =>
      provider.readContract({ address, abi, functionName: 'getAccountPositions', args }),
  }
}

/** Starts a read now, turning a synchronous throw into a rejection `allSettled` can carry. */
function begin(fn) {
  try {
    return Promise.resolve(fn())
  } catch (e) {
    return Promise.reject(e)
  }
}

/** Runs a dependency that may throw OR return null, and treats both the same. */
function attempt(fn) {
  try {
    return fn() ?? null
  } catch {
    return null
  }
}

/** 1e30 venue units → a display number, or null. Never NaN, never a silent 0. */
function usdNumber(units) {
  const text = fromUsdUnits(units)
  if (text == null) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/**
 * How many rows the venue actually returned, for the truncation/partial disclosure. Null when it
 * cannot be established — a hex returndata string has a length that means characters, not rows.
 */
function rowCount(result) {
  if (typeof result === 'string' || result == null) return null
  const n = Number(result.length)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function toLimit(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : GMX_POSITION_PAGE_LIMIT
}

function toChainId(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function toUint(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function toBigIntOrNull(value) {
  if (value == null || value === '') return null
  try {
    const n = BigInt(value)
    return n >= 0n ? n : null
  } catch {
    return null
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function toAddress(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value) ? value : null
}
