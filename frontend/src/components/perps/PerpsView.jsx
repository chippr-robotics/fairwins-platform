/**
 * PerpsView (spec 082, extended by spec 083) — the Perps view inside the Trade section
 * (`?view=perps`).
 *
 * One merged, searchable market-data surface over Gains Network / GMX / Hyperliquid, the connected
 * account's positions, and the orders a venue is still holding. Every state is honest
 * (FR-004/FR-005/FR-013): loading, ready, per-venue degraded (named, with the healthy venues still
 * rendering), fully unavailable, and the testnet-cohort notice (FR-017). The Hyperliquid builder
 * fee is disclosed here BEFORE any link-out when FairWins can actually place a Hyperliquid order
 * AND the rate is above zero — zero means no fee line at all (FR-010), and where the capability is
 * absent (every build today) the footnote says plainly that FairWins earns nothing there instead.
 *
 * THIS FILE IS WHERE SPEC 083's COMPOSITION DECISIONS LIVE, and there are three of them:
 *
 * 1. **The management gate is here and only here.** `canManage` is
 *    `perpsManageFeatureEnabled() && perpsManageEnabled(venue, chainId)` — the release kill switch
 *    AND the per-venue/per-chain capability. With the flag off no management control renders
 *    anywhere: the view is exactly the spec-082 read-only surface, because a disabled or dead
 *    button would be the dishonest outcome (`config/perps.js`). Nothing downstream re-derives this
 *    — `PositionSheet` and `PerpsPendingOrders` deliberately cannot even read the flag, so a
 *    second copy of the question here is the only way it could be answered inconsistently.
 *
 * 2. **The stuck-order list is NOT behind that flag.** An order the venue never executed is holding
 *    the member's collateral, and US4 acceptance 3 is explicit: a recovery control is never gated by
 *    screening, jurisdiction, killswitch **or feature flag** (FR-005 / SC-004). It is mounted
 *    whenever an account is connected — including in the market-data-unavailable branch, because a
 *    pairs feed being down says nothing about whether a member can get their collateral back. It
 *    self-hides when there is genuinely nothing to say, so with the flag off and no stuck order the
 *    view renders as it always did.
 *
 * 3. **It sits ABOVE the positions list.** A stuck order is more urgent than a healthy position.
 *
 * The one thing the cohort gate still governs is whether this build reads MAINNET venues at all:
 * on a testnet cohort every venue read is passed a null account / a false `available()`, so no
 * cross-cohort read happens (constitution III), and the notice renders instead of the data.
 */
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { WalletContext } from '../../contexts/WalletContext.js'
import InfoTip from '../ui/InfoTip'
import OpenPositionSheet from './OpenPositionSheet'
import PerpsPairTable from './PerpsPairTable'
import PerpsPendingOrders from './PerpsPendingOrders'
import PerpsPositions from './PerpsPositions'
import PositionSheet from './PositionSheet'
import { defaultReadCollateralBalances, openVenueOptionsFor } from './openPositionActions'
import { usePerpsMarkets } from '../../hooks/usePerpsMarkets'
import { usePerpsOrders } from '../../hooks/usePerpsOrders'
import { usePerpsPositions } from '../../hooks/usePerpsPositions'
import { fetchPerpsConfig } from '../../lib/perps/perpsClient'
import {
  PERP_VENUES,
  PERP_VENUE_IDS,
  perpsCohortSupported,
  perpsGatewayUrl,
  perpsManageEnabled,
  perpsManageFeatureEnabled,
  perpsVenueManageableAnywhere,
} from '../../config/perps'
import { bpsToPct } from '../../lib/perps/format'
import { withGmxDerivedFigures } from '../../lib/perps/gmxDerived'
import { buildGmxMarketIndex, findGmxPair, withGmxMarketSymbols } from '../../lib/perps/gmxMarkets'
import { readVenueStatuses } from '../../lib/perps/venueStatus'
import {
  PERPS_TIPS,
  PERPS_HYPERLIQUID_NO_FEE_NOTE,
  PERPS_RISK_DISCLOSURE,
  PERPS_EXTERNAL_NOTE,
  PERPS_TESTNET_NOTE,
  PERPS_UNAVAILABLE_NOTE,
  PERPS_FEE_UNCONFIRMED_NOTE,
} from '../../lib/perps/perpsCopy'
import './Perps.css'

const SORT_OPTIONS = [
  { id: 'oi', label: 'Open interest' },
  { id: 'volume', label: '24h volume' },
  { id: 'funding', label: 'Funding rate' },
  { id: 'symbol', label: 'Pair name' },
]

/** `usePerpsMarkets`' own initial sort. Kept here only so the toolbar can tell a member's choice
 *  from the default — the hook remains the one place the value is set. */
const DEFAULT_SORT_KEY = 'oi'

/** Public attribution + HL builder-fee config; `fee: null` = could not be confirmed (disclosed). */
function usePerpsConfigState(deps) {
  const [state, setState] = useState({ attribution: {}, fee: undefined }) // undefined = loading
  useEffect(() => {
    let alive = true
    const load = deps?.fetchConfig ?? fetchPerpsConfig
    load()
      .then((body) => {
        if (!alive) return
        setState({ attribution: body?.attribution ?? {}, fee: body?.hyperliquidBuilderFee ?? null })
      })
      .catch(() => {
        if (alive) setState({ attribution: {}, fee: null })
      })
    return () => {
      alive = false
    }
  }, [deps])
  return state
}

export default function PerpsView({ deps }) {
  const wallet = useContext(WalletContext) || {}
  // Cohort gating is structural: on a testnet cohort the hooks never fetch (FR-017) — the notice
  // below is rendered INSTEAD of cross-cohort data, not on top of a fetch of it.
  const cohortOk = perpsCohortSupported()
  const gate = (avail) => () => cohortOk && (avail ? avail() : perpsGatewayUrl() !== '')
  const account = wallet.isConnected ? wallet.address : null
  const markets = usePerpsMarkets({ deps: { ...deps?.markets, available: gate(deps?.markets?.available) } })
  const positions = usePerpsPositions(account, {
    deps: { ...deps?.positions, available: gate(deps?.positions?.available) },
  })
  // `usePerpsOrders` has no `available()` of its own — deliberately, so no gate can ever be wired
  // into the recovery read. The cohort boundary is honoured by withholding the ACCOUNT instead:
  // there is nothing for a testnet build to read on mainnet venues, and reading them anyway would
  // cross the cohort boundary (constitution III).
  const orders = usePerpsOrders(cohortOk ? account : null, { deps: deps?.orders })
  const { attribution, fee } = usePerpsConfigState(deps?.config)

  /* The whole management gate, in one expression. `perpsManageFeatureEnabled()` is read at render
   * time (never frozen into a module constant), and the per-row half asks whether this build can
   * actually build calldata for that venue on that chain — Hyperliquid answers no everywhere, which
   * is what keeps FR-021's "no dead in-app control" true without a special case for it. */
  const manageEnabled = perpsManageFeatureEnabled()
  const canManage = useCallback(
    (position) => manageEnabled && Boolean(position) && perpsManageEnabled(position.venue, position.chainId),
    [manageEnabled],
  )

  /* THE SAME GATE, ASKED FOR THE FEE FOOTNOTE — and it is asked of the CAPABILITY, not of the rate.
   *
   * FairWins' Hyperliquid builder fee can only ride an order FairWins sends Hyperliquid, and it
   * sends none: the venue is read-only here because its L1 actions need an agent key even to close
   * a position (hyperliquid-decision.md). The rate, however, is admin-settable from the Fees tab
   * (`perps.hyperliquid.builder`) — so a footnote conditioned on `fee.bps > 0`, as this one once
   * was, would let a single admin edit publish a member-facing claim that orders are placed through
   * FairWins. Conditioning it here means the claim can only return with the capability it
   * describes. Until then the footnote below states the true economics instead. */
  const hyperliquidManageable = manageEnabled && perpsVenueManageableAnywhere('hyperliquid')

  /* ------------------------------------------------------------------------------------------- *
   * THE CONTROLS ARE ONE ROW AT REST (issue #1440)
   *
   * The venue pills, the search box and the sort select were three stacked rows — on a phone the
   * pills alone wrapped onto two — and together they cost roughly a fifth of the viewport before a
   * single pair was on screen, on a surface whose entire job is the table underneath them. Search
   * stays on the toolbar (it is the control a member reaches for first); the venue filter and the
   * sort move behind a disclosure.
   *
   * A COLLAPSED PANEL NEVER HIDES AN ACTIVE FILTER, and that is the whole reason this is safe to
   * collapse. `filterSummary` names on the toggle itself whatever is currently shaping the table,
   * and the "showing N of M" line — until now `sr-only` — becomes VISIBLE the moment anything
   * narrows the list. A table that has silently lost rows is indistinguishable from a venue that
   * has stopped reporting, which is exactly the confusion the rest of this view is built to avoid.
   *
   * The panel is UNMOUNTED rather than hidden: a control still in the tab order under a heading
   * claiming `aria-expanded="false"` is claiming something untrue.
   * ------------------------------------------------------------------------------------------- */
  const [filtersOpen, setFiltersOpen] = useState(false)
  const venueFilterLabel =
    markets.venueFilter === 'all' ? null : (PERP_VENUES[markets.venueFilter]?.label ?? markets.venueFilter)
  const sortLabel =
    markets.sortKey === DEFAULT_SORT_KEY ? null : (SORT_OPTIONS.find((o) => o.id === markets.sortKey)?.label ?? null)
  const filterSummary = [venueFilterLabel, sortLabel].filter(Boolean).join(' · ')
  // The search box is its own visible evidence, so it is not summarised on the toggle — but it does
  // narrow the table, so it counts towards showing the member how many pairs they are looking at.
  const narrowed = markets.search !== '' || markets.venueFilter !== 'all'

  const [managed, setManaged] = useState(null)
  const dismissSheet = useCallback(() => setManaged(null), [])

  /* THE ENTRY SURFACE (US3). `opening` is the pair row the member tapped; null is the phase-0
   * state and is where this view stays for every build with the flag off.
   *
   * The control is offered on exactly the rows this build can build an order for — the same two
   * halves `canManage` uses above, so Hyperliquid never grows a dead in-app control (FR-021) and
   * neither does a Gains chain with no calldata path. Everything else the member needs to know —
   * whether the venue is taking new positions, whether its own handle for the pair resolves,
   * whether they hold collateral it accepts — is stated INSIDE the sheet with the venue named as
   * the source, because those are facts about the venue that deserve a sentence rather than a
   * control that silently is not there. */
  const [opening, setOpening] = useState(null)
  const dismissOpen = useCallback(() => setOpening(null), [])
  const offerOpen = useCallback(
    (pair) => manageEnabled && Boolean(pair) && perpsManageEnabled(pair.venue, pair.chainId),
    [manageEnabled],
  )

  /* ONE SHEET AT A TIME, and this is not cosmetic. Both sheets take the body scroll lock on mount
   * and restore what they found on unmount, so a second one mounting while the first is open
   * captures `overflow: hidden` as the "previous" value and leaves the page unscrollable after
   * both have gone. They also both bind a capture-phase Escape handler, so one dismissal would
   * close the wrong one. The positions list stays in the DOM behind the entry sheet and is
   * reachable by keyboard, so this is a state a member can actually get into. */
  const openManageSheet = useCallback((position) => {
    setOpening(null)
    setManaged(position)
  }, [])
  const openEntrySheet = useCallback((pair) => {
    setManaged(null)
    setOpening(pair)
  }, [])

  // Account change closes the sheet DURING RENDER, not in an effect: an open sheet aimed at the
  // previous account's position — and the venue handles inside it — must never be painted for
  // another account (spec 083 edge case). This is React's documented adjust-state-on-prop-change
  // pattern, and it matches the "hard reset before paint" the perps hooks already do.
  const [sheetAccount, setSheetAccount] = useState(account)
  if (sheetAccount !== account) {
    setSheetAccount(account)
    setManaged(null)
    // The entry sheet holds the previous account's balances and an in-flight confirmation of
    // theirs; it goes for the same reason, and before anything is painted for the new account.
    setOpening(null)
  }

  /* The sheet shows the venue's LATEST read of the position while the venue still reports it, and
   * keeps the last snapshot once it does not. That second half is deliberate: the moment a close
   * executes the row leaves the list, and re-resolving to `null` there would yank the venue's own
   * "Position closed." off screen before the member had read it. The figures are then the last ones
   * the venue reported, which is what they always were. */
  /* NAMING A GMX MARKET, from the feed that is already on screen.
   *
   * GMX's Reader names a MARKET ADDRESS and nothing else, so `usePerpsPositions` publishes those
   * rows with `symbol: null` — honestly, because a hook that reads one venue's Reader has no pair
   * table to consult. The gateway's GMX pairs carry the market token inside their id, so the
   * mapping is composed HERE, where both feeds meet, rather than by adding a second Arbitrum read
   * or by teaching the positions hook about markets it does not fetch (its shape and its per-venue
   * isolation are unchanged).
   *
   * `allPairs` again, for the same reason the price uses it: the member's search box shapes the
   * table, and must never decide whether their own position can be named. A market the feed does
   * not list stays `symbol: null` and renders '—' — `withGmxMarketSymbols` matches the market
   * address EXACTLY and never guesses a pair from a partial one. */
  /* WHAT A GMX POSITION IS WORTH, composed at the same seam and for the same reason.
   *
   * GMX's Reader returns the position in RAW VENUE UNITS — a 1e30 notional, a size in the index
   * token's decimals, collateral in the collateral token's — and no entry price, leverage or P&L.
   * `usePerpsPositions` therefore published those as null (correctly: it fetches no market list),
   * and a member closing a leveraged GMX position was shown almost nothing. The scales that turn
   * those raw numbers into money are on the pairs feed already fetched above, so the arithmetic
   * happens HERE, where both feeds meet — the hook still reads one venue and knows nothing about
   * markets.
   *
   * `withGmxDerivedFigures` NAMES what it worked out (`derivedFields`), and both surfaces label
   * those figures as calculated rather than as GMX's own — the derived P&L excludes GMX's
   * borrowing and funding charges and the price impact of closing, so it is not what GMX will
   * settle at. Any missing scale leaves the field null and it renders '—'. */
  const gmxMarkets = useMemo(() => buildGmxMarketIndex(markets.allPairs), [markets.allPairs])
  const positionRows = useMemo(
    () => withGmxDerivedFigures(withGmxMarketSymbols(positions.positions, gmxMarkets), gmxMarkets),
    [positions.positions, gmxMarkets],
  )

  const managedPosition = useMemo(() => {
    if (!managed) return null
    return positionRows.find((p) => p.id === managed.id) ?? managed
  }, [managed, positionRows])

  /* THE PAIR ROW BEHIND A MANAGED POSITION, AND WHY IT IS RESOLVED HERE.
   *
   * ONE resolution, feeding both the mark price and the venue's own fee below it. They must agree
   * about which market a position is: a price from one row and a fee rate from another would be two
   * different markets' numbers in one breakdown, and nothing on screen would say so.
   *
   * A position read carries what the member is holding, not what the market is doing: neither the
   * gateway's `normalizeGainsPositions` nor the GMX Reader returns a mark price or a fee schedule,
   * so a sheet handed only a position has neither. That is not cosmetic — `closeTradeMarket(index,
   * price)` takes the price its slippage bound is measured from, so with no price the sheet can
   * only refuse the close (which it did, honestly, and which made US1 unreachable in the assembled
   * view).
   *
   * The venue's own live price is already on screen one section up — it is what the pairs table
   * renders — so it is passed down rather than read again. Matched on VENUE FIRST: one venue's
   * price may never stand in for another's, and a pair only one venue lists must not silently
   * borrow the other's number. `allPairs`, not `pairs`, because the latter is filtered by the
   * member's own search box. No match leaves it null, and null renders '—' and refuses the close —
   * the honest outcome, never a guessed price.
   *
   * GMX IS MATCHED ON THE MARKET ADDRESS, NOT THE SYMBOL, and that is not a shortcut around the
   * resolution above — it is stricter than it. GMX lists several markets on one base pair
   * ("BTC/USD [WBTC.b-USDC]" and "BTC/USD [BTC-USDC]" are different markets), so a symbol match
   * would have two candidates on the position's own chain and would take whichever came first.
   * The position names its market exactly, so the price comes from THAT market's record. */
  const managedPair = useMemo(() => {
    if (!managedPosition?.venue) return null
    if (managedPosition.venue === 'gmx') return findGmxPair(managedPosition, gmxMarkets)
    const symbol = managedPosition.symbol
    if (!symbol) return null
    const sameVenue = markets.allPairs.filter((p) => p.venue === managedPosition.venue && p.symbol === symbol)
    // Gains lists the same pair on every chain it runs on; prefer the position's own chain, and
    // fall back to the venue's other listing only when the position did not name one.
    return sameVenue.find((p) => p.chainId != null && p.chainId === managedPosition.chainId) ?? sameVenue[0] ?? null
  }, [managedPosition, markets.allPairs, gmxMarkets])

  const markPrice = useMemo(() => {
    const price = Number(managedPair?.price)
    return Number.isFinite(price) && price > 0 ? price : null
  }, [managedPair])

  /* THE VENUE'S OWN CLOSING RATE, from the same row and for the same reason as the price: the exit
   * sheet has a position, and a position read carries no fee schedule. Without it the sheet showed
   * FairWins' fee in money beside the venue's as a dash, which reads as though ours were the cost
   * of closing. Passed as the RATE the venue published — the sheet multiplies it by the share the
   * member actually picks, which is chosen after this. A row the feed does not list (or a feed that
   * is down) leaves it null and the sheet says so; it can never withhold the exit. */
  const managedVenueFee = managedPair?.venueFee ?? null

  /* ------------------------------------------------------------------------------------------- *
   * The entry sheet's two live reads
   *
   * BOTH RUN ONLY WHILE A PAIR IS OPEN, and therefore never at all with the flag off — the tapped
   * pair is the only thing that starts them. That is what keeps "flag off ⇒ exactly the phase-0
   * view" true of network behaviour and not merely of pixels.
   * ------------------------------------------------------------------------------------------- */

  /* WHAT THE VENUES CURRENTLY PERMIT, read from the contracts that enforce it (FR-017). Absent is
   * NOT permission: `openEligibility` fails closed on a missing status, so the window between the
   * tap and the answer refuses the open rather than offering it. */
  const [venueStatuses, setVenueStatuses] = useState(null)
  const openChainId = opening?.chainId ?? null
  const readStatuses = deps?.open?.readVenueStatuses ?? readVenueStatuses
  useEffect(() => {
    if (openChainId == null) return undefined
    let alive = true
    setVenueStatuses(null)
    Promise.resolve()
      .then(() => readStatuses(openChainId))
      .then((result) => {
        if (alive) setVenueStatuses(result ?? null)
      })
      .catch(() => {
        // A failed read is not a status. Leaving it null keeps every venue refused-with-a-reason
        // rather than silently opening one we could not check.
        if (alive) setVenueStatuses(null)
      })
    return () => {
      alive = false
    }
    // `readStatuses` is caller-owned; re-reading on a new chain is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChainId])

  /* The venues that list the tapped market on the tapped row's own chain, with each venue's live
   * status attached. `allPairs`, never `pairs`: the member's search box shapes the table and must
   * not decide which venues they may open on. */
  const openVenueOptions = useMemo(
    () => (opening ? openVenueOptionsFor(opening, markets.allPairs, { statuses: venueStatuses }) : []),
    [opening, markets.allPairs, venueStatuses],
  )

  /* WHAT THE MEMBER ACTUALLY HOLDS of the collateral those venues accept. A balance that could not
   * be read is omitted rather than reported as zero — the sheet then says the member holds none of
   * the accepted collateral, which is the honest consequence of not knowing. */
  const openVenueOptionsRef = useRef(openVenueOptions)
  useEffect(() => {
    openVenueOptionsRef.current = openVenueOptions
  })
  const [holdings, setHoldings] = useState([])
  const readBalances = deps?.open?.readCollateralBalances ?? defaultReadCollateralBalances
  const collateralKey = openVenueOptions
    .flatMap((option) => (option.collaterals ?? []).map((c) => c?.address))
    .filter(Boolean)
    .join(',')
  useEffect(() => {
    if (openChainId == null || !account || collateralKey === '') {
      setHoldings([])
      return undefined
    }
    let alive = true
    setHoldings([])
    Promise.resolve()
      .then(() => readBalances({ chainId: openChainId, account, venueOptions: openVenueOptionsRef.current }))
      .then((result) => {
        if (alive) setHoldings(Array.isArray(result) ? result : [])
      })
      .catch(() => {
        if (alive) setHoldings([])
      })
    return () => {
      alive = false
    }
    // Keyed on the token SET rather than on the options object, which is a fresh array on every
    // market poll — an effect keyed on that would re-read balances every 30 seconds and reset the
    // member's collateral choice underneath them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openChainId, account, collateralKey])

  // Both refreshes ride a ref: `usePerpsPositions`/`usePerpsOrders` hand back a fresh `refresh`
  // closure every render, so putting either in a dependency array would make this callback's
  // identity change every render — and it is an effect dependency inside the sheet.
  const refreshRef = useRef(null)
  useEffect(() => {
    refreshRef.current = { positions: positions.refresh, orders: orders.refresh }
  })
  const handleActionComplete = useCallback(() => {
    // Only ever called on the venue's own execution event (the sheet drives the state machine), so
    // this re-reads what the venue actually did — never what the member asked for.
    refreshRef.current?.positions?.()
    refreshRef.current?.orders?.()
  }, [])

  const pendingOrders = (
    <PerpsPendingOrders
      status={orders.status}
      orders={orders.orders}
      unreadableVenues={orders.unreadableVenues}
      sources={orders.sources}
      refresh={orders.refresh}
      deps={deps?.trade}
    />
  )

  // Cohort + configuration honesty come before anything else (FR-013/FR-017).
  if (!perpsCohortSupported()) {
    return (
      <section className="perps-view" aria-label="Perps">
        <PerpsHeader />
        <p className="perps-unavailable" role="status">
          {PERPS_TESTNET_NOTE}
        </p>
      </section>
    )
  }
  if (perpsGatewayUrl() === '' || markets.status === 'unavailable') {
    return (
      <section className="perps-view" aria-label="Perps">
        <PerpsHeader />
        <div className="perps-unavailable" role="status">
          <p>{PERPS_UNAVAILABLE_NOTE}</p>
          {perpsGatewayUrl() !== '' && (
            <button type="button" className="perps-retry" onClick={markets.refresh}>
              Try again
            </button>
          )}
        </div>
        {/* Market data being down says nothing about a member's collateral. This list reads GMX
            straight from the chain and self-hides when there is nothing waiting, so it costs the
            ordinary member nothing and it is the difference between a recovery control existing and
            being hidden behind an unrelated outage (US4 acceptance 3). */}
        {pendingOrders}
      </section>
    )
  }

  return (
    <section className="perps-view" aria-label="Perps">
      <PerpsHeader />

      <div className="perps-controls">
        <div className="perps-toolbar">
          <label className="perps-search">
            <span className="sr-only">Search pairs</span>
            <input
              type="search"
              placeholder="Search pairs (BTC, ETH…)"
              value={markets.search}
              onChange={(e) => markets.setSearch(e.target.value)}
              aria-label="Search pairs"
            />
          </label>
          <button
            type="button"
            className={`perps-filter-toggle ${filterSummary ? 'has-filters' : ''}`}
            aria-expanded={filtersOpen}
            aria-controls="perps-filter-panel"
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <span>Filters</span>
            {/* The active filter, named on the closed control. Without this the panel would be
                hiding the reason the table is short. */}
            {filterSummary && <span className="perps-filter-summary">{filterSummary}</span>}
          </button>
        </div>

        {filtersOpen && (
          <div className="perps-filter-panel" id="perps-filter-panel">
            <div className="perps-venue-filter" role="group" aria-label="Filter by venue">
              <button
                type="button"
                className={`perps-filter-pill ${markets.venueFilter === 'all' ? 'active' : ''}`}
                aria-pressed={markets.venueFilter === 'all'}
                onClick={() => markets.setVenueFilter('all')}
              >
                All venues
              </button>
              {PERP_VENUE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`perps-filter-pill ${markets.venueFilter === id ? 'active' : ''}`}
                  aria-pressed={markets.venueFilter === id}
                  onClick={() => markets.setVenueFilter(id)}
                >
                  {PERP_VENUES[id].label}
                </button>
              ))}
            </div>
            <label className="perps-sort">
              <span className="perps-sort-label">Sort by</span>
              <select
                value={markets.sortKey}
                onChange={(e) => markets.setSortKey(e.target.value)}
                aria-label="Sort pairs"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {markets.degradedVenues.length > 0 && (
        <p className="perps-degraded-banner" role="status">
          {markets.degradedVenues.map((v) => PERP_VENUES[v]?.label ?? v).join(' and ')} market data is
          temporarily unavailable — those pairs are hidden rather than shown stale. Other venues are live.
        </p>
      )}

      {markets.status === 'loading' ? (
        <p className="perps-loading" role="status">
          Loading pairs from {PERP_VENUE_IDS.length} venues…
        </p>
      ) : markets.pairs.length === 0 ? (
        <p className="perps-empty" role="status">
          {markets.search || markets.venueFilter !== 'all'
            ? 'No pairs match your search or filter.'
            : 'No pairs are available right now.'}
        </p>
      ) : (
        <>
          {/* ONE element, not two: always announced, and visible exactly while something is
              narrowing the list. A second copy for sighted members would be announced twice. */}
          <p className={narrowed ? 'perps-result-count' : 'sr-only'} role="status">
            Showing {markets.pairs.length} of {markets.totalCount} pairs
          </p>
          <PerpsPairTable
            pairs={markets.pairs}
            attribution={attribution}
            offerOpen={offerOpen}
            onOpen={manageEnabled ? openEntrySheet : null}
          />
        </>
      )}

      {/* Above the positions list: an order the venue never executed is holding collateral, which
          is more urgent than any healthy position below it. */}
      {pendingOrders}

      <PerpsPositions
        status={positions.status}
        positions={positionRows}
        unreadableVenues={positions.unreadableVenues}
        attribution={attribution}
        canManage={canManage}
        onManage={manageEnabled ? openManageSheet : null}
      />

      {managedPosition && (
        <PositionSheet
          position={managedPosition}
          markPrice={markPrice}
          venueFee={managedVenueFee}
          attribution={attribution}
          onClose={dismissSheet}
          onActionComplete={handleActionComplete}
          deps={deps?.sheet}
        />
      )}

      {/* THE ENTRY SHEET. It is the only surface in this feature that carries a gate — the
          jurisdiction attestation and sanctions screening stand in front of OPENING and nothing
          else, and the sheet renders the acknowledgement immediately above the control it gates.
          Nothing above can reach it: the exit sheet, the recovery list and the positions list
          cannot even import it (asserted in test/perps/safetyInvariants.test.js). */}
      {opening && (
        <OpenPositionSheet
          pair={opening}
          venueOptions={openVenueOptions}
          holdings={holdings}
          attribution={attribution}
          onClose={dismissOpen}
          onActionComplete={handleActionComplete}
          deps={deps?.openSheet}
        />
      )}

      <footer className="perps-footnotes">
        {/* The Hyperliquid builder fee. The rate is only ASKED ABOUT where FairWins could place a
            Hyperliquid order — where it cannot, no rate is a member's cost, so neither the rate
            line nor the "could not be confirmed" note has anything to be about. Zero still renders
            nothing at all (FR-010), so a build that gains the capability at a zero rate looks
            exactly like this one. */}
        {!hyperliquidManageable ? null : fee === undefined ? null : fee === null ? (
          <p className="perps-fee-note" role="status">
            {PERPS_FEE_UNCONFIRMED_NOTE}
          </p>
        ) : fee.bps > 0 ? (
          <p className="perps-fee-note">
            FairWins charges a {bpsToPct(fee.bps)} fee on Hyperliquid orders placed through FairWins{' '}
            <InfoTip label="About the FairWins fee">{PERPS_TIPS.builderFee}</InfoTip>
          </p>
        ) : null}
        <p className="perps-benefit-note">
          Trading on GMX via FairWins gives you a GMX fee discount{' '}
          <InfoTip label="About the GMX discount">{PERPS_TIPS.gmxDiscount}</InfoTip> Gains Network trades cost
          you nothing extra <InfoTip label="About Gains referral">{PERPS_TIPS.gainsReferral}</InfoTip>
          {hyperliquidManageable ? null : (
            <>
              {' '}
              {PERPS_HYPERLIQUID_NO_FEE_NOTE}{' '}
              <InfoTip label="About Hyperliquid fees">{PERPS_TIPS.hyperliquidNoFee}</InfoTip>
            </>
          )}
        </p>
        <p className="perps-external-note">{PERPS_EXTERNAL_NOTE}</p>
        <p className="perps-risk-note">{PERPS_RISK_DISCLOSURE}</p>
      </footer>
    </section>
  )
}

function PerpsHeader() {
  return (
    /* No intro paragraph: it listed the columns the table already has headings for, and its one
       load-bearing sentence — that trading happens at the venue, with the member's own wallet — is
       what `PERPS_TIPS.venue` says in the tip beside this heading. Each venue is still named on
       every row it supplies, which is where attribution belongs. */
    <div className="perps-header">
      <h3>
        Perps <InfoTip label="About perps venues">{PERPS_TIPS.venue}</InfoTip>
      </h3>
    </div>
  )
}
