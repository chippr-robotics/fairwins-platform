import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useWallet, useWalletConnection } from '../../hooks'
import { useModal } from '../../hooks/useUI'
import { useIsMobile } from '../../hooks/useMediaQuery'
import CreateChallengePanel from './CreateChallengePanel'
import PayPanel from './PayPanel'
import RequestPanel from './RequestPanel'
import UnifiedLookupModal from './UnifiedLookupModal'
import MyMarketsModal from './MyMarketsModal'
import PolymarketTickerCrawler from './PolymarketTickerCrawler'
import PremiumPurchaseModal from '../ui/PremiumPurchaseModal'
import DeviceLossWarning from '../wallet/DeviceLossWarning'
import SectionIconNav from '../nav/SectionIconNav'
import NavIcon from '../nav/NavIcon'
import PillSelect from '../ui/PillSelect'
import { parseTakeChallengeParams } from '../../utils/claimCode/deepLink.js'
import { OPEN_RESOLUTION_TYPES } from '../../hooks/useOpenChallengeCreate'
import { useFriendMarkets } from '../../contexts/FriendMarketsContext.js'
import { getDefaultHomeMode, subscribe as subscribeHomePreference } from '../../utils/homePreference'
import './Dashboard.css'
import './HomeScreen.css'

/**
 * HomeScreen (specs 053 + 058) — the app's landing surface at /app, now a
 * three-mode money surface sharing one payments-style layout:
 *
 *   pay     — send value (default; spec 058 US1)
 *   request — generate a payment-request QR (spec 058 US2)
 *   wager   — the spec-053 create-a-challenge view, unchanged
 *
 * All three panels stay MOUNTED while the screen is open — the inactive two
 * get the `hidden` attribute — so each mode's draft survives switching and
 * never leaks into another mode (FR-015). The switcher is the SectionIconNav
 * bottom bar on mobile (outgoing / incoming / head-to-head glyphs) and a
 * PillSelect row on larger viewports; the wager-only extras (Accept a
 * challenge, My Wagers, the Polymarket ticker) render only in wager mode.
 */

const MODE_OPTIONS = [
  { id: 'pay', label: 'Pay', icon: 'arrowOut' },
  { id: 'request', label: 'Request', icon: 'arrowIn' },
  { id: 'wager', label: 'Wager', icon: 'headToHead' },
]

function HomeScreen() {
  const navigate = useNavigate()
  const location = useLocation()
  const { isConnected } = useWallet()
  const { connectWallet } = useWalletConnection()
  const { showModal, hideModal } = useModal()
  const { friendMarkets } = useFriendMarkets()
  const isMobile = useIsMobile()

  // Which mode the surface is on. Initialized from the device preference
  // (spec 058 US4); a preference change made elsewhere only moves the surface
  // until the user has picked a mode themselves this visit.
  const [mode, setMode] = useState(getDefaultHomeMode)
  const userPickedRef = useRef(false)

  useEffect(() => subscribeHomePreference(() => {
    if (!userPickedRef.current) setMode(getDefaultHomeMode())
  }), [])

  const selectMode = useCallback((next) => {
    userPickedRef.current = true
    setMode(next)
  }, [])

  // Preselect the oracle path (from the ticker) and force-remount the panel so a fresh
  // create starts cleanly after a success or a ticker pick.
  const [oraclePreselect, setOraclePreselect] = useState(false)
  const [oracleMarket, setOracleMarket] = useState(null)
  const [createKey, setCreateKey] = useState(0)

  const [showUnifiedLookup, setShowUnifiedLookup] = useState(false)
  const [unifiedInitialPhrase, setUnifiedInitialPhrase] = useState('')
  const [unifiedAutoResolve, setUnifiedAutoResolve] = useState(false)
  const [showMyWagers, setShowMyWagers] = useState(false)
  const [initialWagerId, setInitialWagerId] = useState(null)
  // Request ▸ Pool deep link (spec 103): /app?kind=pool opens the Request mode on its Pool kind. The
  // nonce re-applies the kind when the link is followed while this screen is already mounted.
  const [requestKind, setRequestKind] = useState({ kind: 'once', nonce: 0 })
  // While the create panel is on its oracle path, hide the secondary actions so the
  // taller oracle form (market + side picker) fits without scrolling (design feedback).
  const [oracleMode, setOracleMode] = useState(false)

  // Feed → wager navigation (spec 012): open My Wagers on a specific wager, then clear state.
  useEffect(() => {
    const openWagerId = location.state?.openWagerId
    if (openWagerId == null) return
    setInitialWagerId(String(openWagerId))
    setShowMyWagers(true)
    setMode('wager')
    navigate(location.pathname, { replace: true, state: {} })
  }, [location.state, location.pathname, navigate])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('kind') === 'pool') {
      userPickedRef.current = true
      setMode('request')
      setRequestKind((k) => ({ kind: 'pool', nonce: k.nonce + 1 }))
      params.delete('kind')
      const rest = params.toString()
      navigate(`${location.pathname}${rest ? `?${rest}` : ''}`, { replace: true, state: location.state ?? {} })
    }
  }, [location.search, location.pathname, location.state, navigate])

  // Shared-phrase deep link (spec 037): /app?oc=take&code=<four words> opens the unified lookup,
  // prefilled + auto-resolving. Strip the query after consuming it (FR-016).
  useEffect(() => {
    const code = parseTakeChallengeParams(location.search)
    if (code) {
      setUnifiedInitialPhrase(code)
      setUnifiedAutoResolve(true)
      setShowUnifiedLookup(true)
      setMode('wager')
      navigate(location.pathname, { replace: true, state: {} })
    }
  }, [location.search, location.pathname, navigate])

  const openAccept = useCallback(() => {
    setUnifiedInitialPhrase('')
    setUnifiedAutoResolve(false)
    setShowUnifiedLookup(true)
  }, [])

  // Ticker pick → the wager mode's create view, straight on its oracle (Polymarket)
  // path with the clicked market pre-selected (main #877).
  const handleTicker = useCallback((market) => {
    userPickedRef.current = true
    setMode('wager')
    setOraclePreselect(true)
    setOracleMarket(market || null)
    setCreateKey((k) => k + 1)
  }, [])

  // After a successful create, reset the inline panel for another challenge.
  const handleCreated = useCallback(() => {
    setOraclePreselect(false)
    setOracleMarket(null)
    setCreateKey((k) => k + 1)
  }, [])

  const wagerActive = mode === 'wager'

  return (
    <div className="dashboard-container home-screen">
      {/*
       * FR-021 moment 1 of 3 — ACCOUNT CREATION (spec 041 US5, issue #1405).
       *
       * This screen is where the passkey ceremony lands: ConnectModal closes itself the instant
       * the session connects, so the account it just created does not exist yet on any surface
       * inside that dialog — there is nothing there to warn. The first surface a brand-new
       * passkey account ever renders is this one, so this is "at account creation".
       *
       * It keeps showing on later visits until the member dismisses it or a second controller
       * exists, which is the honest reading of FR-021: the warning is about a risk that has not
       * gone away. It renders for nobody else — a wallet session, or an account with two
       * controllers, gets nothing (DeviceLossWarning self-gates).
       */}
      <DeviceLossWarning
        moment="creation"
        onAddController={() => navigate('/wallet?tab=security#controllers')}
      />

      {/* Desktop/tablet mode switcher; mobile uses the bottom SectionIconNav. */}
      {!isMobile && (
        <div className="home-mode-switcher">
          <PillSelect
            label="Home view"
            hideLabel
            options={MODE_OPTIONS.map((o) => ({
              value: o.id,
              label: o.label,
              icon: <NavIcon name={o.icon} size={16} />,
            }))}
            value={mode}
            onChange={selectMode}
          />
        </div>
      )}

      {/* Pay — the default mode (spec 058 US1). */}
      <section className="home-create home-mode-panel" aria-label="Pay" hidden={mode !== 'pay'}>
        <PayPanel />
      </section>

      {/* Request — payment-request QR (spec 058 US2). */}
      <section className="home-create home-mode-panel" aria-label="Request" hidden={mode !== 'request'}>
        <RequestPanel initialKind={requestKind.kind} kindNonce={requestKind.nonce} />
      </section>

      {/* Wager — the spec-053 inline open-challenge create view, unchanged. No disconnected
          banner — tapping the panel's primary button opens the connect panel as part of the
          create flow (spec 053 feedback), then continues once the wallet connects. */}
      <section className="home-create home-mode-panel" aria-label="Create a challenge" hidden={!wagerActive}>
        <CreateChallengePanel
          key={createKey}
          embedded
          isConnected={isConnected}
          onConnect={connectWallet}
          initialResolutionType={oraclePreselect ? OPEN_RESOLUTION_TYPES.Polymarket : undefined}
          initialMarket={oracleMarket}
          onOracleModeChange={setOracleMode}
          onDone={handleCreated}
        />
      </section>

      {/* Wager-only extras: take a challenge, winnings, and the ticker. Hidden in the other
          modes (spec 058 research R8) and on the oracle path (design feedback). */}
      {wagerActive && !oracleMode && (
        <section className="home-actions" aria-label="Other actions">
          <button type="button" className="fm-btn-secondary home-action" onClick={openAccept}>
            Accept a challenge
          </button>
          <button type="button" className="fm-btn-secondary home-action" onClick={() => setShowMyWagers(true)}>
            My Wagers
          </button>
        </section>
      )}

      {wagerActive && (
        <section className="dashboard-section home-ticker">
          <PolymarketTickerCrawler onSelectMarket={handleTicker} />
        </section>
      )}

      {/* Mobile bottom bar — Pay / Request / Wager glyphs (spec 058 US3).
          SectionIconNav self-gates to mobile viewports. */}
      <SectionIconNav
        items={MODE_OPTIONS}
        activeId={mode}
        onSelect={selectMode}
        ariaLabel="Home mode"
      />

      {/* Accept a challenge — the unified phrase lookup (spec 037). */}
      <UnifiedLookupModal
        key={showUnifiedLookup ? 'ul-open' : 'ul-closed'}
        isOpen={showUnifiedLookup}
        initialPhrase={unifiedInitialPhrase}
        autoResolve={unifiedAutoResolve}
        onClose={() => setShowUnifiedLookup(false)}
        onBuyMembership={() => {
          setShowUnifiedLookup(false)
          showModal(<PremiumPurchaseModal onClose={hideModal} />, { title: '', size: 'large', closable: false })
        }}
      />

      {/* My rewards — My Wagers, which lists claimable payouts + "Claim Winnings". */}
      <MyMarketsModal
        isOpen={showMyWagers}
        onClose={() => { setShowMyWagers(false); setInitialWagerId(null) }}
        friendMarkets={friendMarkets}
        initialSelectedMarketId={initialWagerId}
      />
    </div>
  )
}

export default HomeScreen
