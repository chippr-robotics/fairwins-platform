//core
import { useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'
import './theme.css'
import './App.css'

//system hooks & effects
import { useWallet, useWalletNetwork } from './hooks'
import { useAnnouncement, useNotification } from './hooks/useUI'
import NotificationSystem from './components/ui/NotificationSystem'
import ModalSystem from './components/ui/ModalSystem'
import AnnouncementRegion from './components/ui/AnnouncementRegion'

// Main flow
import LandingRoute from './components/LandingRoute'
import HomeScreen from './components/fairwins/HomeScreen'
import { WAGERS_PATH } from './config/appNav'
import Header from './components/Header'
import Footer from './components/Footer'

// add-ons
import WalletPage from './pages/WalletPage'
import VouchersPage from './pages/VouchersPage'
import MarketAcceptancePage from './pages/MarketAcceptancePage'
import PoolPage from './pages/PoolPage'
import FundingPoolPage from './pages/FundingPoolPage'
import MiniAppWorkspace from './components/miniapps/MiniAppWorkspace'
import { TermsPage, RiskPage, PrivacyPage } from './pages/legal/LegalDocPage'
import EntryGate from './components/compliance/EntryGate'
import AutoConnectPrompt from './components/wallet/AutoConnectPrompt'
import { ActivityProvider } from './contexts/ActivityProvider.jsx'
import { NavDrawerProvider } from './contexts/NavDrawerContext.jsx'
import ActivityNotificationBridge from './components/notifications/ActivityNotificationBridge'
import SignerRequestHost from './components/account/SignerRequestHost'
import AppNavDrawer from './components/nav/AppNavDrawer'
import AttentionFocus from './components/nav/AttentionFocus'
import AssistantLauncher from './components/assistant/AssistantLauncher'

//admin
import ControlRoom from './components/admin/ControlRoom'
import AdminAppRoute from './components/admin/AdminAppRoute'

// dev
import DevelopmentWarningBanner from './components/ui/DevelopmentWarningBanner'
import StagingBanner from './components/ui/StagingBanner'
import StateManagementDemo from './components/StateManagementDemo'
import { ComponentExamples } from './components/ui'
import AppLockOverlay from './components/applock/AppLockOverlay'
import StaleBuildNotice from './components/native/StaleBuildNotice'
import NativeDeepLinks from './components/native/NativeDeepLinks'
import PwaInstallPrompt from './components/pwa/PwaInstallPrompt'
import PwaUpdateNotification from './components/pwa/PwaUpdateNotification'

function AppLayout() {
  // The global nav drawer ("us") already carries the legal/policy footer, so the
  // page-level footer is redundant on the dense hosts: the My Account screen
  // (/wallet) and the create-a-challenge home (/app, /main, /fairwins), where it
  // also pushed the ticker off the bottom of the view. Every other in-app route
  // keeps it.
  const { pathname } = useLocation()
  const HIDE_PAGE_FOOTER = ['/wallet', '/app', '/main', '/fairwins']
  const showPageFooter = !HIDE_PAGE_FOOTER.includes(pathname)

  return (
    /* Spec 031: platform-wide activity watcher scoped to the app-mode tree — the header bell and the views
       below consume it (wagers + DAO/token/membership sources); landing pages never poll. */
    <ActivityProvider>
      {/* App navigation redesign: the section menu ("us") is now a global left
          drawer opened by the clover logo, shared across every in-app route. */}
      <NavDrawerProvider>
        {/* `app-shell` reserves room for AppNavDrawer's persistent desktop icon
            gutter (see AppNavDrawer.css) — the drawer itself is fixed-position
            and ignores this padding, but everything below needs to clear it. */}
        <div className="app-shell">
          <Header appMode />
          <AppNavDrawer />
          {/* Spec 095: the opt-in assistant's floating entry point. Renders NOTHING unless the
              tenant enables it, a wallet is connected, that account opted in (default off), and its
              membership reads back active — so for most sessions this mounts and returns null. It
              sits beside the drawer because this is the only place that renders on every in-app
              route and on no landing page; z-index 1300 keeps it above the bottom nav (1200) and
              below the drawer backdrop (1400). */}
          <AssistantLauncher />
          {/* A menu-search result deep-links with `?focus=<id>`; this briefly highlights whatever
              carries the matching `data-attention` marker, so the member can see the thing they
              searched for on a screen they may never have opened before. */}
          <AttentionFocus />
          {/* Spec 086: no operating-as banner for ANY acting account kind — the header wallet
              avatar renders the acting identity, and every kind is treated equally. Switching
              back lives in the account switcher, where switching always lived. */}
          {/* Spec 041: route a tapped push notification into in-app navigation. */}
          <ActivityNotificationBridge />
          {/* Spec 088: the deferred-signing ceremony host — unlock/device dialogs render HERE,
              at the moment a signature is needed, never at account-switch time. */}
          <SignerRequestHost />
          {/* Spec 007 (US4): client-side eligibility notice gate before any app content. */}
          <EntryGate />
          {/* Entering the app with no account opens the unlock dialog by itself —
              every surface below is inert until one is connected. */}
          <AutoConnectPrompt />
          <Outlet />
          {/* Spec 010 (US2): condensed legal/policy footer inside the app. The menu
              drawer carries its own copy; /wallet relies on that to avoid duplication. */}
          {showPageFooter && <Footer variant="condensed" />}
        </div>
      </NavDrawerProvider>
    </ActivityProvider>
  )
}


function AppContent() {
  const { isConnected } = useWallet()
  const { networkError, switchNetwork } = useWalletNetwork()
  const { announce } = useAnnouncement()
  const { showNotification } = useNotification()

  const handleSwitchNetwork = async () => {
    announce('Attempting to switch network')
    showNotification('Switching network...', 'info')
    try {
      await switchNetwork()
    } catch (error) {
      // switchNetwork now genuinely rejects on a member decline / wallet failure (spec 088 —
      // the old non-async mutate swallowed rejections). The banner stays up; say what happened.
      showNotification(error?.message || 'The network switch was not completed.', 'warning')
    }
  }

  return (
    <>
      {/* Non-production marker (spec 076, FR-025/FR-026d). Renders nothing in production;
          on the mainnet staging service it is also the real-funds disclosure. */}
      <StagingBanner />

      {/* Development warning banner - always visible */}
      <DevelopmentWarningBanner />

      {/* Accessibility announcement region */}
      <AnnouncementRegion />

      {/* Notification system */}
      <NotificationSystem />

      {/* Modal system */}
      <ModalSystem />

      {/* PWA install bottom-sheet — shown to non-standalone visitors who haven't opted out */}
      <PwaInstallPrompt />

      {/* PWA update toast — routes to the Software Update section when a new version is ready */}
      <PwaUpdateNotification />

      {/* Network error banner */}
      {networkError && isConnected && (
        <div
          className="network-error-banner"
          role="alert"
          aria-live="assertive"
        >
          <span>{networkError}</span>
          <button
            onClick={handleSwitchNetwork}
            className="switch-network-button"
            aria-label="Switch to correct network"
          >
            Switch Network
          </button>
        </div>
      )}

      <Routes>
        <Route
          path="/"
          element={<LandingRoute />}
        />
        <Route path="/ui-components" element={<ComponentExamples />} />
        <Route path="/state-demo" element={<StateManagementDemo />} />

        {/* Public versioned legal documents (Spec 007) — readable before the entry gate */}
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/risk" element={<RiskPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />

        {/* App routes with header + wallet button */}
        <Route element={<AppLayout />}>
          <Route path="/app" element={<HomeScreen />} />
          <Route path="/main" element={<HomeScreen />} />
          <Route path="/fairwins" element={<HomeScreen />} />
          {/* Wagers moved into Finance ▸ Transfer (spec 073) — it sits beside Transfer and
              Bridge because all three are ways money leaves this section. `/wagers` stays a
              live route rather than being deleted: it is on printed cards, saved links and
              bookmarks, and a redirect costs nothing where a 404 costs a member their way in.
              `replace` so Back returns where they came from instead of bouncing off it. */}
          <Route path="/wagers" element={<Navigate to={WAGERS_PATH} replace />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/vouchers" element={<VouchersPage />} />
          <Route path="/friend-market/accept" element={<MarketAcceptancePage />} />
          <Route path="/pools/:address" element={<PoolPage />} />
          {/* Funding pools (spec 103): the share link lands on the pool page (four words or address). */}
          <Route path="/fund/:ref" element={<FundingPoolPage />} />
          {/* Spec 073: one mini-app workspace per registry listing. The slug is
              derived from the listing's on-chain (unique) name, and the workspace
              re-reads that record from the chain on every launch — a catalog card
              is never what decides that something may run. */}
          <Route path="/apps/:slug" element={<MiniAppWorkspace />} />
          {/* Operations (spec 093): /admin is the Control Room launcher; each admin
              group is its own lazily-loaded mini-app at /admin/:appId, with ?view=
              addressing the interior view. Access gating lives in the shared shell,
              so every depth shows the same honest denied/unverified screens. */}
          <Route path="/admin" element={<ControlRoom />} />
          <Route path="/admin/:appId" element={<AdminAppRoute />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Spec 041 amendment: the optional app lock. Rendered LAST and BESIDE the routes, never
          around them — the overlay covers the app, it does not unmount it, so an FR-008
          confirmation that was open when the lock fired is still there (unconfirmed, unsubmitted,
          undropped) after the member unlocks. It renders null for everyone who has not turned the
          setting on, which is everyone by default. */}
      <AppLockOverlay />

      {/* Spec 102 FR-015: on a native build older than the published support
          floor, say so with the update path named. Renders null on web and
          whenever no floor is knowable — it never manufactures a banner from
          a network failure. */}
      <StaleBuildNotice />

      {/* Spec 102 US5: universal/app links land on the linked surface. Inert
          on web; renders nothing everywhere. */}
      <NativeDeepLinks />
    </>
  )
}

function App() {
  // Spec 102: one boot marker for the native smoke tier. Capacitor forwards
  // console output to logcat / the simulator console, so the smoke jobs can
  // assert "the shell actually rendered" instead of "the process exists".
  useEffect(() => {
    console.info('[fw-smoke] shell-mounted')
  }, [])
  return (
    <Router>
      <AppContent />
    </Router>
  )
}

export default App
