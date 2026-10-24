import { useLayoutEffect, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAccountStats } from '../../hooks/useAccountStats'
import usePortfolio from '../../hooks/usePortfolio'
import { useWalletConnection } from '../../hooks/useWalletManagement'
import { useEffectiveAccount } from '../../hooks/useEffectiveAccount'
import { ACCOUNT_VIEWS, ACCOUNT_DEFAULT_VIEW, accountViewFromParam } from '../../config/appNav'
import AccountCardsCarousel from './AccountCardsCarousel'
import PortfolioPanel from '../wallet/PortfolioPanel'
import DeviceLossWarning from '../wallet/DeviceLossWarning'
import SummaryTiles from './SummaryTiles'
import PnlChart from './PnlChart'
import ActivityBreakdowns from './ActivityBreakdowns'
import EstateBreakdown from './EstateBreakdown'
import RecentActivityFeed from './RecentActivityFeed'
import FreshnessIndicator from './FreshnessIndicator'
import WalletUtilitiesPanel from './WalletUtilitiesPanel'
import EmptyState from './EmptyState'
import './MyAccountView.css'

/**
 * MyAccountView — the unified Account tab body (spec 074, replacing the
 * spec-020 AccountDashboard's role). Top half: the account card carousel
 * (personal / multisig / recovered — selecting a card switches the app-wide
 * acting account; the active card carries the portfolio total). Bottom half:
 * ONE of three views of the selected account — Portfolio (the default),
 * Activity (the ledger feed), or Stats (tiles + P&L chart + breakdowns) —
 * driven by `?view=` so each is deep-linkable (the PayTransferPanel idiom).
 * The switcher is WalletPage's bottom icon bar on mobile and the tab strip
 * here on desktop; exactly one is visible at any width (the strip hides
 * ≤768px in CSS, SectionIconNav renders only ≤768px).
 *
 * Stats and Activity follow the ACTING account (spec 063 pattern): the acting
 * address is passed into useAccountStats, mirroring how PortfolioPanel already
 * resolves useEffectiveAccount internally.
 */
function MyAccountView() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const view = accountViewFromParam(searchParams.get('view'))

  const setView = (next) => {
    const params = new URLSearchParams(searchParams)
    if (next === ACCOUNT_DEFAULT_VIEW) params.delete('view')
    else params.set('view', next)
    setSearchParams(params, { replace: true })
  }

  const { disconnectWallet } = useWalletConnection()
  // Spec 074 (US3): the stats/activity data follows the account the member is
  // ACTING AS — the same seam the portfolio already reads. Personal mode passes
  // nothing → identical to the pre-074 behavior.
  const { address: actingAddress, isActingAccount } = useEffectiveAccount()
  const stats = useAccountStats(isActingAccount ? { accountAddress: actingAddress } : undefined)
  // ONE portfolio instance for the whole view (post-launch feedback): it backs
  // the Portfolio view AND the active card's quick-access total, and because
  // it lives here (not inside the view panel) the scan starts — and the
  // snapshot cache warms — the moment My Account opens, whichever view shows.
  const portfolio = usePortfolio(isActingAccount ? { accountAddress: actingAddress } : undefined)
  const activeTotalUsd = portfolio.status === 'ready' ? portfolio.totalUsd : null
  /*
   * FR-021 moment 2 of 3 — FIRST FUNDING (spec 041 US5, issue #1405).
   *
   * The app has no "money arrived" event to hang this on: there is no incoming-transfer watcher,
   * and the passkey account is counterfactual until its first action, so nothing fires when a
   * transfer lands. The honest definition, and the one this mount uses, is the observable one the
   * spec's own wording ("first meaningful balance", US5) points at: the first time the wallet home
   * shows this single-controller passkey account holding something.
   *
   * Judged on BALANCES, not on `totalUsd`. A holding with no resolvable on-chain price carries
   * `usd: null` and adds nothing to the total (usePortfolio's honest-state rules), so a funded
   * account whose price feed was unreachable would total $0 — and would go unwarned exactly when
   * it holds value. `holdings` only ever contains assets that were actually READ (a failed read is
   * skipped and reported in `failedAssets`, never rendered as zero), so a non-zero balance here is
   * a fact, and a read that failed simply does not claim one.
   */
  const funded = portfolio.status === 'ready' && (portfolio.holdings || []).some((h) => h.balance > 0)
  // Defaults matter here, not just for tidiness: `staleClasses`/`partialChains`
  // are read unconditionally below (they decide whether an empty feed may be
  // called "no activity"), so a hook shape that omits them must degrade to
  // "nothing was reported unread", never throw on render.
  const {
    summary, series, setRange, breakdowns, activity, staleClasses = [], prunedByChain,
    partialChains = [], chainId, isLoading, isEmpty, error, freshness, refresh,
  } = stats

  const handleDisconnect = () => {
    disconnectWallet()
    navigate('/app')
  }
  const goCreate = () => navigate('/app')

  // The account selection (cards + view switcher) stays frozen at the top
  // while the view below scrolls. It pins under the site header — itself
  // sticky with a height that isn't a constant (dev banner, wrap points) —
  // so the offset is measured from the header's live box, not hardcoded.
  const stickyRef = useRef(null)
  useLayoutEffect(() => {
    const el = stickyRef.current
    if (!el) return undefined
    const measure = () => {
      const header = document.querySelector('.site-header')
      const bottom = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0
      el.style.setProperty('--my-account-sticky-top', `${bottom}px`)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Honest empty states, per view and account-aware (spec 091's PR): acting
  // accounts (vault/recovered/hardware) get neutral wording and no wager CTA;
  // only the personal wallet is invited to wager. Spec 092 retired the
  // "network not supported" state: history now merges the whole cohort, so
  // the record no longer depends on where the wallet points — a chain that
  // could not be read is disclosed by name instead (`partialChains`), and an
  // all-chains failure surfaces the hook's error with last-known data kept.
  const unreadNetworks = Array.isArray(partialChains) ? partialChains : []
  const unreadClasses = Array.isArray(staleClasses) ? staleClasses : []
  const allNetworksFailed = Boolean(error) && unreadNetworks.length > 0 && activity.length === 0
  // #1280: an empty feed is only "no activity yet" when everything that feeds
  // it actually answered. With a chain or a class unread, the record we hold
  // is silent about them — and "your wagers, transfers, earn, pool, and
  // membership activity will appear here" claims all five were checked. Name
  // what could not be read instead; the disclosure is what makes the empty
  // list honest, so it must not be swallowed by the empty state.
  //
  // The two lists are DIFFERENT KINDS of label and are marked as such rather
  // than concatenated: `partialChains` holds network names ("Ethereum" — the
  // whole network went unread) while `staleClasses` already names both parts
  // ("wager on Polygon" — one class on a network that otherwise answered).
  // Run together in one comma list a reader cannot tell which they are looking
  // at, and "Ethereum, wager on Polygon" reads as if Ethereum were a class.
  const unreadSources = [
    ...unreadNetworks.map((n) => `${n} (entire network)`),
    ...unreadClasses,
  ]
  const partiallyUnread = !allNetworksFailed && activity.length === 0 && unreadSources.length > 0
  // Stats keeps its own condition: figures computed from wager records that DID
  // arrive must still render, so the note replaces them only when there is
  // nothing to compute from (`isEmpty`) AND something went unread.
  const wagerStatsPartiallyUnread = !allNetworksFailed && isEmpty && unreadSources.length > 0
  const unreadNote = `Could not be read: ${unreadSources.join(', ')}. Anything recorded there is missing from this list rather than absent.`

  const activityHonestState = () => {
    if (allNetworksFailed) {
      return (
        <EmptyState
          title="Your networks could not be read"
          message={`None of your networks answered: ${unreadNetworks.join(', ')}. Nothing is shown rather than an empty history that isn't true.`}
        />
      )
    }
    if (partiallyUnread) {
      return (
        <EmptyState
          title="Some of your activity could not be read"
          message={unreadNote}
        />
      )
    }
    if (isEmpty) {
      return isActingAccount ? (
        <EmptyState
          title="No activity recorded yet"
          message="No wagers, transfers, or other FairWins activity has been recorded for this account yet. Its balances across all networks are in Portfolio."
        />
      ) : (
        <EmptyState
          title="No activity yet"
          message="Your wagers, transfers, earn, pool, and membership activity will appear here."
          ctaLabel="Create a wager"
          onCta={goCreate}
        />
      )
    }
    return null
  }

  // Stats never blanks wholesale: the estate overview (fed by the portfolio's
  // cross-network scan) renders regardless, and only the WAGER sections get an
  // honest compact note when there is nothing to compute them from.
  const wagerStatsHonestState = () => {
    if (allNetworksFailed) {
      return (
        <EmptyState
          compact
          title="Your networks could not be read"
          message={`None of your networks answered: ${unreadNetworks.join(', ')}. Figures are withheld rather than shown as zeros.`}
        />
      )
    }
    if (wagerStatsPartiallyUnread) {
      return (
        <EmptyState
          compact
          title="Some of your activity could not be read"
          message={`Could not be read: ${unreadSources.join(', ')}. Figures are withheld for those rather than shown as zeros.`}
        />
      )
    }
    if (isEmpty) {
      return isActingAccount ? (
        <EmptyState
          compact
          title="No wager activity for this account"
          message="Performance charts appear once this account has wager history."
        />
      ) : (
        <EmptyState
          compact
          title="No wager activity yet"
          message="Create or accept your first wager to start building your performance stats."
          ctaLabel="Create a wager"
          onCta={goCreate}
        />
      )
    }
    return null
  }

  const activityState = activityHonestState()
  const wagerStatsState = wagerStatsHonestState()

  return (
    <div className="my-account">
      {funded && (
        <DeviceLossWarning
          moment="first-funding"
          onAddController={() => navigate('/wallet?tab=security#controllers')}
        />
      )}

      <div className="my-account-sticky" ref={stickyRef}>
        <AccountCardsCarousel activeTotalUsd={activeTotalUsd} />

        {/* Desktop view switcher (the pt-tabs idiom); hidden ≤768px where
            WalletPage's bottom icon bar carries the same three views. */}
        <div className="my-account-tabs" role="tablist" aria-label="Account views">
          {ACCOUNT_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={`my-account-tab ${view === v.id ? 'active' : ''}`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      {view === 'portfolio' && (
        <div role="tabpanel" aria-label="Portfolio" className="my-account-panel">
          <PortfolioPanel portfolio={portfolio} />
        </div>
      )}

      {view === 'activity' && (
        <div role="tabpanel" aria-label="Activity" className="my-account-panel">
          <div className="my-account-freshness">
            {/* The activity panel's own section state (#1280): the indicator
                describes the data beneath it, so a ledger that could not be
                read fully must not be labelled with the summary's freshness. */}
            <FreshnessIndicator state={freshness?.activity ?? freshness?.summary} onRefresh={refresh} />
          </div>
          {activityState || (
            <RecentActivityFeed
              entries={activity}
              chainId={chainId}
              staleClasses={unreadClasses}
              partialChains={unreadNetworks}
              prunedByChain={prunedByChain}
            />
          )}
        </div>
      )}

      {view === 'stats' && (
        <div role="tabpanel" aria-label="Stats" className="my-account-panel">
          <div className="my-account-freshness">
            <FreshnessIndicator state={freshness?.summary} onRefresh={refresh} />
          </div>
          {wagerStatsState ? (
            <>
              {/* Estate first when there are no wager stats: the account's
                  cross-network holdings ARE its stats (the screenshot case —
                  a recovered account holding real value saw only a wager
                  pitch). The wager note follows, compact. */}
              <EstateBreakdown portfolio={portfolio} />
              {wagerStatsState}
            </>
          ) : (
            <>
              {unreadNetworks.length > 0 && (
                <p className="my-account-partial" role="status">
                  Figures exclude {unreadNetworks.join(', ')} — could not be read. Totals are
                  partial.
                </p>
              )}
              <SummaryTiles summary={summary} isEmpty={isLoading && !summary} />
              <PnlChart series={series} onRangeChange={setRange} onCreateWager={goCreate} />
              {/* The by-status / by-token / by-resolution breakdowns are stats,
                  not a transaction log — they live here beside the tiles and
                  chart (post-launch feedback), keeping Activity a clean feed. */}
              <ActivityBreakdowns breakdowns={breakdowns} />
              {/* The whole estate, beyond the active network's wager data
                  (spec 044's scan, already loaded for the Portfolio view). */}
              <EstateBreakdown portfolio={portfolio} />
            </>
          )}
        </div>
      )}

      <WalletUtilitiesPanel onDisconnect={handleDisconnect} />
    </div>
  )
}

export default MyAccountView
