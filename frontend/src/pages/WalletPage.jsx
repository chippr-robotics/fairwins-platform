import { useState, useCallback, useEffect, useMemo } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useWallet, useWalletRoles } from '../hooks'
import { useEncryption } from '../hooks/useEncryption'
import { useUserPreferences } from '../hooks/useUserPreferences'
import { usePwaInstall } from '../hooks/usePwaInstall'
import { usePwaUpdate } from '../hooks/usePwaUpdate'
import { useChainTokens } from '../hooks/useChainTokens'
import { useModal } from '../hooks/useUI'
import { useRoleDetails } from '../hooks/useRoleDetails'
import { ROLES, ROLE_INFO } from '../contexts/RoleContext'
import { hasRegisteredKey } from '../utils/keyRegistryService'
import TradeSection from '../components/fairwins/TradeSection'
import EarnPanel from '../components/earn/EarnPanel'
import PayTransferPanel from '../components/wallet/PayTransferPanel'
import CollectiblesPanel from '../components/collectibles/CollectiblesPanel'
import PredictPanel from '../components/predict/PredictPanel'
import CustodyPanel from '../components/custody/CustodyPanel'
import CatalogPanel from '../components/miniapps/CatalogPanel'
import MyAccountView from '../components/account/MyAccountView'
import ControllersPanel from '../components/account/ControllersPanel'
import RecoverAccountPanel from '../components/account/RecoverAccountPanel'
import LegacyKeyRecoveryPanel from '../components/account/LegacyKeyRecoveryPanel'
import NotificationProfilesPanel from '../components/account/NotificationProfilesPanel'
import HomePreferencesPanel from '../components/account/HomePreferencesPanel'
import WalletDisplayPreferencesPanel from '../components/account/WalletDisplayPreferencesPanel'
import PortfolioPreferencesPanel from '../components/account/PortfolioPreferencesPanel'
import PrivacyPreferencesPanel from '../components/account/PrivacyPreferencesPanel'
import AppLockPreferencesPanel from '../components/account/AppLockPreferencesPanel'
import NavigationPreferencesPanel from '../components/account/NavigationPreferencesPanel'
import AssistantToolsPanel from '../components/assistant/AssistantToolsPanel'
import AddressBookPanel from '../components/account/AddressBookPanel'
import CallsignPanel from '../components/account/CallsignPanel'
import BackupPanel from '../components/account/BackupPanel'
import AccordionGroup from '../components/account/AccordionGroup'
import AccordionSection from '../components/account/AccordionSection'
import NetworkPanel from '../components/account/NetworkPanel'
import RecoveryCodesPanel from '../components/account/RecoveryCodesPanel'
import TaxReportsPanel from '../components/wallet/TaxReportsPanel'
import SectionIconNav from '../components/nav/SectionIconNav'
import {
  groupForTab,
  isNavItemEnabledForTenant,
  ACCOUNT_VIEWS,
  ACCOUNT_DEFAULT_VIEW,
  accountViewFromParam,
  PORTFOLIO_PATH,
  TAB_ALIASES,
} from '../config/appNav'
import { accordionSectionForHash } from '../config/navSearchIndex'
import { collectiblesGatewayUrl } from '../lib/collectibles/gatewayClient'
import { predictGatewayUrl } from '../lib/predict/predictClient'
import PremiumPurchaseModal from '../components/ui/PremiumPurchaseModal'
import NavIcon from '../components/nav/NavIcon'
import { LEGAL_LINKS } from '../constants/legalLinks'
import './WalletPage.css'

// Icon per Settings → App → Legal & Policies row (issue #1025). Keyed by href
// since that's the stable identity LEGAL_LINKS already uses as its list key.
const LEGAL_LINK_ICONS = {
  '/terms': 'reports',
  '/risk': 'alert',
  '/privacy': 'lock',
}
const LEGAL_LINK_ICON_DEFAULT = 'ban' // Account Moderation (deep-links into /terms)

// Settings deep links whose hash does not simply name their card — the alias cases. Every other
// card resolves through the nav search index (`accordionSectionForHash`), which is also what the
// menu search links to, so a card added there is deep-linkable without being added here too.
// Cards are collapsed by default, so a link that only scrolled would leave the member staring at
// a closed heading; these ids are the AccordionSection ids on the tab.
const SETTINGS_HASH_ALIASES = {
  '#notification-profiles-new': 'notifications',
}

// My Account section panels, keyed by tab id. The section MENU now lives in the
// global nav drawer + account button (see config/appNav.js) — this page just
// hosts the panels and reads `?tab=` to pick one. WALLET_TABS is the flat list
// used for deep-link/alias resolution and for the active tab's heading label.
// (Account / Membership / Network / Settings are reached from the account button;
// 'custody' is surfaced to users as "Protect" and 'paytransfer' as "Transfer" —
// the ids stay stable so saved links keep resolving, spec 067 FR-002.)
const WALLET_TABS = [
  { id: 'account', label: 'Account' },
  { id: 'membership', label: 'Membership' },
  { id: 'network', label: 'Network' },
  { id: 'settings', label: 'Settings' },
  { id: 'security', label: 'Recovery' },
  { id: 'earn', label: 'Earn' },
  { id: 'trade', label: 'Trade' },
  { id: 'collectibles', label: 'Collect' },
  { id: 'predict', label: 'Predict' },
  { id: 'paytransfer', label: 'Transfer' },
  { id: 'custody', label: 'Protect' },
  { id: 'addressbook', label: 'Address Book' },
  { id: 'reports', label: 'Reporting' },
  // Apps (spec 073) — the mini-app catalog, and the only Apps nav item. ClearPath and Token
  // Mint stay listed below because their tabs still RENDER: they left the menu, not the app.
  { id: 'apps', label: 'Apps' },
  // Assistant (spec 104) — the agent controls: which rail answers, the GutterToken key, API access.
  { id: 'assistant', label: 'Assistant' },
]

// Legacy deep-link aliases live in config/appNav.js — the drawer resolves the same
// map, and two copies of it drifted the last time a tab was renamed.
//
// Spec 073 (FR-009). The Apps nav group collapsed to the single mini-app catalog entry, and both
// apps that used to live in it are packages now: `?tab=tokens` and `?tab=clearpath` REDIRECT to
// `/apps/token-mint` (T027) and `/apps/clearpath` (T029) via TAB_REDIRECTS below, so saved deep
// links land where the feature actually lives. Wagers is absent from both maps and is NOT a
// package: it moved into the Transfer section as `?tab=paytransfer&view=wagers`, and the legacy
// `/wagers` route redirects there from App.jsx. This map must stay in parity with the copy in
// components/nav/AppNavDrawer.jsx.

/**
 * Tabs that have BECOME mini-apps (spec 073 T027) or moved into another section. Unlike
 * `TAB_ALIASES`, which renames a tab within this page, these leave the tab entirely — the
 * feature now lives elsewhere, so a saved deep link has to land there rather than on a tab
 * that no longer exists. Kept in parity with the same map in `components/nav/AppNavDrawer.jsx`.
 *
 * Portfolio (spec 074): the standalone tab folded into the unified My Account view as its
 * `?view=portfolio`, so `?tab=portfolio` redirects to `/wallet?tab=account&view=portfolio`.
 */
const TAB_REDIRECTS = {
  tokens: '/apps/token-mint',
  clearpath: '/apps/clearpath',
  portfolio: PORTFOLIO_PATH,
}

// Canonical Polymarket category slugs — kept here to keep WalletPage
// self-contained. Order matches PolymarketBrowser's quick-filter row.
const POLYMARKET_CATEGORY_OPTIONS = [
  { slug: 'politics', label: 'Politics' },
  { slug: 'sports', label: 'Sports' },
  { slug: 'crypto', label: 'Crypto' },
  { slug: 'pop-culture', label: 'Pop Culture' },
  { slug: 'business', label: 'Business' },
  { slug: 'science', label: 'Science' },
  { slug: 'entertainment', label: 'Entertainment' },
  { slug: 'tech', label: 'Tech' },
]

function WalletPage() {
  const { address, isConnected, provider, signer, loginMethod, openConnectModal } = useWallet()
  const isPasskey = loginMethod === 'passkey'
  const { showModal, hideModal } = useModal()
  const { roles, hasRole } = useWalletRoles()
  /*
   * Membership status is the ACTING account's, so it comes from `useRoleDetails` rather than
   * `hasRole` (which reads the connected wallet and cannot see an acting account —
   * CustodyProvider nests inside WalletProvider). Saying "Active — you have access to create
   * wagers" off the wrong account is a claim the contract would refuse.
   *
   * `readable === false`, or no answer yet, is UNKNOWN — neither "Active" nor "get one". A
   * separate branch says so instead of picking one and being confidently wrong.
   */
  const { getRoleDetails: getMembershipDetails } = useRoleDetails()
  const membershipDetails = getMembershipDetails('WAGER_PARTICIPANT')
  const membershipUnknown = !membershipDetails || membershipDetails.readable === false
  const membershipActive = Boolean(membershipDetails?.isActive)
  const { isInitialized, isInitializing, registerKeyNow } = useEncryption()
  const { preferences, setPolymarketCategories } = useUserPreferences()
  const { capabilities } = useChainTokens()
  const polymarketSidebetsEnabled = Boolean(capabilities?.polymarketSidebets)
  // Collectibles (spec 055): tab exists only where OpenSea serves the chain AND a gateway
  // proxy is configured — everywhere else it hides and deep links fall back (FR-007).
  const collectiblesEnabled = Boolean(capabilities?.collectibles) && collectiblesGatewayUrl() !== ''
  // Predict (spec 057): tab exists only on Polygon (capability) AND with a gateway proxy configured —
  // everywhere else it hides and deep links fall back (FR-018).
  const predictEnabled = Boolean(capabilities?.predict) && predictGatewayUrl() !== ''
  // Apps (spec 073 FR-009): the mini-app catalog is a tenant feature ('miniapps'), not a chain
  // capability — a tenant that has not enabled it has no Apps nav item, so the `?tab=apps` deep
  // link must not render a section that tenant does not have. Gated the same way as the two
  // chain-gated tabs above, and for the same reason: a tab reachable by URL but absent from every
  // menu is exactly how a "dead tab" gets shipped.
  //
  // Only the NEW tab is gated. The `?tab=clearpath` / `?tab=tokens` redirects above are not
  // tenant-filtered: a tenant without mini-apps has no package to serve either way, and the
  // redirect landing on the catalog's honest unavailable state is a better answer than a tab that
  // silently falls back to Account.
  const miniAppsEnabled = isNavItemEnabledForTenant('apps')
  // Assistant (spec 104): gated the same way and for the same reason — the launcher already reads
  // the `assistant` tenant feature, and a tab reachable by URL on a tenant with no assistant would
  // offer controls for a thing that does not exist there.
  const assistantEnabled = isNavItemEnabledForTenant('assistant')
  const {
    isStandalone: pwaStandalone,
    canPrompt: pwaCanPrompt,
    isIos: pwaIsIos,
    hidden: pwaPromptHidden,
    setHidden: setPwaPromptHidden,
    promptInstall: pwaPromptInstall,
  } = usePwaInstall()
  const { updateReady: pwaUpdateReady, applyUpdate: pwaApplyUpdate, checkForUpdate: pwaCheckForUpdate } = usePwaUpdate()
  const [pwaChecking, setPwaChecking] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  // The section is driven by `?tab=` so the global nav drawer and the account
  // button can route straight to a panel (e.g. the update toast → ?tab=settings).
  const requestedTab = searchParams.get('tab')
  /*
   * A tab that has become a mini-app leaves this page. Done as an effect rather than during
   * render because a redirect is a side effect, and done with `replace` so the member's Back
   * button returns to wherever they came from rather than bouncing off the dead tab again.
   */
  const redirectTo = TAB_REDIRECTS[requestedTab] || null
  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true })
  }, [redirectTo, navigate])

  /*
   * Spec 104. The Assistant and API access cards left Settings for the Assistant tab, but their
   * card ids did not change — so the old `?tab=settings#assistant-prefs` / `#api-access` links (the
   * update toast idiom, support answers, bookmarks) still name a real card, just on another tab.
   * Rather than a second hash map here, ask the ONE hash→section seam whether the assistant tab
   * owns the hash: a card that moves in `navSearchIndex.js` moves its redirect with it. Every other
   * query param is carried (the menu search's `focus=` marker in particular), only `tab` changes.
   */
  const settingsHashMovedToAssistant =
    (TAB_ALIASES[requestedTab] || requestedTab) === 'settings' &&
    assistantEnabled &&
    Boolean(accordionSectionForHash('assistant', location.hash))
  useEffect(() => {
    if (!settingsHashMovedToAssistant) return
    const next = new URLSearchParams(location.search)
    next.set('tab', 'assistant')
    navigate(`/wallet?${next.toString()}${location.hash}`, { replace: true })
  }, [settingsHashMovedToAssistant, location.search, location.hash, navigate])

  const [activeTab, setActiveTab] = useState(() => {
    const requested = requestedTab
    const resolved = TAB_ALIASES[requested] || requested
    if (resolved === 'collectibles' && !collectiblesEnabled) return 'account'
    if (resolved === 'predict' && !predictEnabled) return 'account'
    if (resolved === 'apps' && !miniAppsEnabled) return 'account'
    if (resolved === 'assistant' && !assistantEnabled) return 'account'
    return WALLET_TABS.some((t) => t.id === resolved) ? resolved : 'account'
  })
  const [keyRegistered, setKeyRegistered] = useState(null)
  const [keyCheckLoading, setKeyCheckLoading] = useState(false)
  const [keyRegisterLoading, setKeyRegisterLoading] = useState(false)
  const [keyError, setKeyError] = useState(null)


  const handleOpenPurchaseModal = () => {
    showModal(<PremiumPurchaseModal onClose={hideModal} />, {
      title: '',
      size: 'large',
      closable: false
    })
  }

  const handleNavigateToAdmin = () => {
    navigate('/admin')
  }

  const handleCheckKeyStatus = useCallback(async () => {
    if (!address || !provider) return
    setKeyCheckLoading(true)
    setKeyError(null)
    try {
      const registered = await hasRegisteredKey(address, provider)
      setKeyRegistered(registered)
    } catch (err) {
      setKeyError('Could not check key status: ' + err.message)
    } finally {
      setKeyCheckLoading(false)
    }
  }, [address, provider])

  const handleRegisterKey = useCallback(async () => {
    // registerKeyNow derives the account's encryption keys and AWAITS the on-chain registration,
    // login-method agnostic: a passkey submits through the smart account (sendCalls / one WebAuthn
    // ceremony), a classic wallet signs the register tx. Awaiting it — rather than the old
    // fire-and-forget + poll — is what lets a passkey user actually see success or a real failure
    // reason instead of a status stuck on "Not registered".
    if (!address || (!signer && !isPasskey)) {
      setKeyError('Not connected. Please sign in again.')
      return
    }
    setKeyRegisterLoading(true)
    setKeyError(null)
    try {
      await registerKeyNow()
      // Confirm against the registry so the flip to "Registered" reflects on-chain truth. A passkey
      // UserOp can take a moment to include, so poll briefly before reporting.
      let registered = await hasRegisteredKey(address, provider)
      for (let i = 0; !registered && isPasskey && i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000))
        registered = await hasRegisteredKey(address, provider)
      }
      setKeyRegistered(registered)
      if (!registered && isPasskey) {
        setKeyError('Encryption key setup submitted — it can take a moment to confirm. Use “Check Status” shortly.')
      }
    } catch (err) {
      if (err.message.includes('rejected') || err.message.includes('denied') || err.name === 'CeremonyCancelled') {
        setKeyError('Registration was cancelled.')
      } else if (err.message.includes('KeyAlreadyExists') || err.message.includes('0xe0accd63')) {
        // Key already exists on-chain — treat as success
        setKeyRegistered(true)
      } else {
        setKeyError('Key registration failed: ' + err.message)
      }
    } finally {
      setKeyRegisterLoading(false)
    }
  }, [registerKeyNow, signer, address, isPasskey, provider])

  // Auto-check key status when Security tab is shown
  useEffect(() => {
    if (activeTab === 'security' && isConnected && keyRegistered === null) {
      handleCheckKeyStatus()
    }
  }, [activeTab, isConnected, keyRegistered, handleCheckKeyStatus])

  // Keep the active panel in sync with `?tab=` so navigating from the global
  // nav drawer / account button (which change the URL) switches sections here.
  // Always derive from the URL — a missing or unknown tab falls back to Account
  // so the panel never drifts out of sync with the address bar.
  useEffect(() => {
    const requested = searchParams.get('tab')
    const resolved = TAB_ALIASES[requested] || requested
    const known = WALLET_TABS.some((t) => t.id === resolved)
    const available =
      (resolved !== 'collectibles' || collectiblesEnabled) &&
      (resolved !== 'predict' || predictEnabled) &&
      (resolved !== 'apps' || miniAppsEnabled) &&
      (resolved !== 'assistant' || assistantEnabled)
    setActiveTab(known && available ? resolved : 'account')
  }, [searchParams, collectiblesEnabled, predictEnabled, miniAppsEnabled, assistantEnabled])

  const handleCheckForUpdate = useCallback(async () => {
    setPwaChecking(true)
    try {
      await pwaCheckForUpdate()
    } finally {
      setPwaChecking(false)
    }
  }, [pwaCheckForUpdate])

  // Settings and Recovery cards are collapsed by default, so a deep link has to name the card it
  // means: the hash picks which one the group opens, and the same effect scrolls its header into
  // view. Read from the router's location rather than window.location so a hash arriving while
  // the tab is already open still lands.
  //
  // Both tabs resolve the same way now. Recovery is a stack of collapsed cards for exactly the
  // same reason Settings is, and the menu search links into both — sending a member to
  // "Legacy account recovery" and landing them on a closed heading would be the search stopping
  // one step short of the thing it found.
  const hashOpenSection = useMemo(
    () =>
      (activeTab === 'settings' ? SETTINGS_HASH_ALIASES[location.hash] : null) ||
      accordionSectionForHash(activeTab, location.hash),
    [activeTab, location.hash],
  )

  useEffect(() => {
    if (!hashOpenSection) return
    const id = window.setTimeout(() => {
      document
        .getElementById(`${hashOpenSection}-header`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 60)
    return () => window.clearTimeout(id)
  }, [hashOpenSection])

  const selectedPolymarketCategories = useMemo(
    () => preferences?.polymarketCategories || [],
    [preferences?.polymarketCategories],
  )

  const togglePolymarketCategory = useCallback((slug) => {
    if (!isConnected) return
    const next = selectedPolymarketCategories.includes(slug)
      ? selectedPolymarketCategories.filter((s) => s !== slug)
      : [...selectedPolymarketCategories, slug]
    setPolymarketCategories(next)
  }, [isConnected, selectedPolymarketCategories, setPolymarketCategories])

  // Sibling sub-items for the mobile bottom icon nav — the group the active tab
  // belongs to (Finance / Tools / Apps). Absent for membership/network/etc.
  //
  // Spec 074: the Account tab has no section group (deliberately — it lives on
  // the account button), so its bottom bar carries the unified view's THREE
  // views (Activity / Portfolio / Stats) instead, in lockstep with
  // MyAccountView's desktop tab strip via the shared ACCOUNT_VIEWS ids.
  const currentSectionGroup = groupForTab(activeTab)
  const isAccountTab = activeTab === 'account'
  const accountView = accountViewFromParam(searchParams.get('view'))
  const sectionNavItems = isAccountTab
    ? ACCOUNT_VIEWS
    : (currentSectionGroup?.items || []).filter(
        (item) =>
          (item.id !== 'collectibles' || collectiblesEnabled) && (item.id !== 'predict' || predictEnabled),
      )

  return (
    <div className="wallet-page-wrapper">
      <div className="wallet-page">

          {!isConnected ? (
            <div className="connect-section">
              <div className="connect-prompt">
                <div className="connect-icon" aria-hidden="true">{'\uD83D\uDD17'}</div>
                <h3>Connect Your Wallet</h3>
                <p>Sign in with a passkey or connect your Web3 wallet to access all features, manage your membership, and create wagers.</p>

                {/* Spec 045 FR-001: no inline connector list \u2014 every entry
                    point opens the ONE shared connect surface. */}
                <div className="connector-options">
                  <button onClick={openConnectModal} className="connector-btn">
                    Connect
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="wallet-portal wallet-portal--flat">
              {/* The wallet identity + copy-address affordance now lives on the
                  account button (top right); the section panels below no longer
                  duplicate it. */}
              <div className="wallet-portal-main">
                {/* No in-page section title — every panel renders its own
                    heading, and the section name is shown in the nav. */}
                <div className="tab-content">
                {activeTab === 'account' && (
                  <div className="profile-section" role="tabpanel">
                    {/* Spec 074 — the unified My Account experience: account card
                        carousel + Activity/Portfolio/Stats views. The standalone
                        Portfolio tab folded into it (see TAB_REDIRECTS). */}
                    <MyAccountView />

                    {hasRole(ROLES.ADMIN) && (
                      <div className="section admin-section">
                        <h3>Administration</h3>
                        <p className="section-description">Manage roles and permissions for users</p>
                        <button onClick={handleNavigateToAdmin} className="admin-panel-btn">Role Management</button>
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'collectibles' && collectiblesEnabled && (
                  <div className="collectibles-section" role="tabpanel">
                    <CollectiblesPanel />
                  </div>
                )}

                {activeTab === 'predict' && predictEnabled && (
                  <div className="predict-section" role="tabpanel">
                    <PredictPanel />
                  </div>
                )}

                {activeTab === 'paytransfer' && (
                  <div className="paytransfer-section" role="tabpanel">
                    <PayTransferPanel />
                  </div>
                )}

                {activeTab === 'custody' && (
                  <div className="custody-section" role="tabpanel">
                    {/* Spec 085 — Protect is an accordion now; the hash names the card to land open,
                        same mechanism as Recovery/Settings. */}
                    <CustodyPanel openSection={hashOpenSection} />
                  </div>
                )}

                {activeTab === 'addressbook' && (
                  <div className="addressbook-section" role="tabpanel">
                    <AddressBookPanel address={address} />
                  </div>
                )}

                {activeTab === 'membership' && (
                  <div className="membership-section" role="tabpanel">
                    <CallsignPanel />
                    <div className="section">
                      <h3>Your Roles</h3>
                      {roles.length > 0 ? (
                        <div className="user-roles-list">
                          {roles.map(role => {
                            const roleInfo = ROLE_INFO[role]
                            return (
                              <div key={role} className="user-role-item">
                                <div className="role-header">
                                  <span className="role-badge">{roleInfo?.name || role}</span>
                                  {roleInfo?.premium && <span className="premium-badge">Premium</span>}
                                </div>
                                <p className="role-desc">{roleInfo?.description || 'No description'}</p>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="no-roles-message">
                          <p>You don't have any roles yet. Get a membership to create and accept wagers.</p>
                        </div>
                      )}
                    </div>

                    <div className="section">
                      <h3>Membership</h3>
                      {membershipUnknown ? (
                        <div className="membership-inactive">
                          <p>
                            Your membership could not be read right now, so this may be out of
                            date. It is not a sign that you have none — check back in a moment.
                          </p>
                          <button onClick={handleOpenPurchaseModal} className="get-roles-btn">View Membership</button>
                        </div>
                      ) : membershipActive ? (
                        <div className="membership-active">
                          <div className="membership-status-badge active">Active</div>
                          <p>You have access to create and accept P2P wagers.</p>
                          <button onClick={handleOpenPurchaseModal} className="renew-btn">Renew / Upgrade</button>
                        </div>
                      ) : (
                        <div className="membership-inactive">
                          <p>Get access to create and accept encrypted P2P wagers with friends.</p>
                          <button onClick={handleOpenPurchaseModal} className="get-roles-btn">Get Membership</button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {activeTab === 'network' && (
                  <div className="network-section" role="tabpanel">
                    <NetworkPanel />
                  </div>
                )}

                {activeTab === 'security' && (
                  <div className="security-section" role="tabpanel">
                    {/* Recovery collects several independent, high-stakes features. Each one
                        renders as a COLLAPSED AccordionSection that states its own status in a
                        line, so the tab opens as a scannable list rather than a stack of fully
                        expanded panels; one section is open at a time, and every consequential
                        or destructive action confirms in a bottom sheet. */}
                    <p className="security-section__intro">
                      Everything that protects your access to this account. Open a section to see or change it.
                    </p>
                    <AccordionGroup openId={hashOpenSection}>
                      {/* Data backup — encrypted backup/restore of device-local data (spec 032). */}
                      <BackupPanel />
                      {/* Spec 045 US5/US6 — account controllers & recovery.
                          ControllersPanel renders for passkey sessions (add a
                          passkey / link a wallet as recovery); the recovery
                          panel renders for wallet sessions (regain passkey
                          access using a linked wallet). Each self-gates. */}
                      <ControllersPanel />
                      <RecoverAccountPanel />
                      {/* Recover an account from a legacy private key or word
                          list, store it encrypted on-device, and move its funds
                          to a smart account. Self-gates to connected sessions. */}
                      <LegacyKeyRecoveryPanel />
                      <AccordionSection
                        id="encryption-key"
                        title="Encryption key"
                        summary={
                          keyRegistered
                            ? 'Registered on-chain'
                            : isInitialized
                              ? 'Derived on this device'
                              : 'Not initialized'
                        }
                        badge={keyRegistered === false ? 'Not registered' : null}
                        badgeTone="warn"
                      >
                        <p className="section-description">
                          Your encryption key allows you to send and receive encrypted wagers. It is derived from
                          {isPasskey ? ' your passkey' : ' your wallet signature'} and registered on-chain.
                        </p>

                        <div className="key-status-card">
                          <div className="key-status-row">
                            <span className="key-status-label">Local Keys:</span>
                            <span className={`key-status-value ${isInitialized ? 'active' : 'inactive'}`}>
                              {isInitializing ? 'Initializing...' : isInitialized ? 'Derived' : 'Not initialized'}
                            </span>
                          </div>
                          <div className="key-status-row">
                            <span className="key-status-label">On-chain Registration:</span>
                            <span className={`key-status-value ${keyRegistered ? 'active' : keyRegistered === false ? 'inactive' : ''}`}>
                              {keyCheckLoading ? 'Checking...' : keyRegistered === null ? 'Not checked' : keyRegistered ? 'Registered' : 'Not registered'}
                            </span>
                          </div>
                        </div>

                        {keyError && (
                          <div className="key-error" role="alert">
                            {keyError}
                          </div>
                        )}

                        <div className="key-actions">
                          <button
                            onClick={handleCheckKeyStatus}
                            className="key-action-btn secondary"
                            disabled={keyCheckLoading}
                          >
                            {keyCheckLoading ? 'Checking...' : 'Check Status'}
                          </button>

                          {!keyRegistered && (
                            <button
                              onClick={handleRegisterKey}
                              className="key-action-btn primary"
                              disabled={keyRegisterLoading}
                            >
                              {keyRegisterLoading ? 'Registering...' : 'Register Encryption Key'}
                            </button>
                          )}
                        </div>
                      </AccordionSection>

                      <RecoveryCodesPanel />
                    </AccordionGroup>
                  </div>
                )}

                {activeTab === 'settings' && (
                  <div className="settings-section" role="tabpanel">
                    {/* Settings is the app's global preference surface. Like Recovery, it is a
                        list of COLLAPSED cards: each states its current value in the header, so
                        the whole tab scans in one screen and the member opens only what they
                        came for. One card is open at a time. */}
                    <p className="settings-section__intro">
                      How this app looks and behaves. Open a card to change it.
                    </p>
                    <AccordionGroup openId={hashOpenSection}>
                      {/* Each preference panel supplies its own card header + summary. */}
                      <HomePreferencesPanel />
                      <NavigationPreferencesPanel />
                      <WalletDisplayPreferencesPanel address={address} />
                      <PortfolioPreferencesPanel />
                      <PrivacyPreferencesPanel />
                      {/* Spec 041 amendment: the optional app lock. Renders NOTHING for a classic
                          wallet — there is no WebAuthn re-prompt that could reopen it, so the
                          setting is not offered where the lock could never be lifted. */}
                      <AppLockPreferencesPanel />
                      <NotificationProfilesPanel />
                      {/* The Assistant and API access cards (spec 095) moved to the Assistant tab in
                          Tools (spec 104): they are agent controls, not appearance. Their old
                          `#assistant-prefs` / `#api-access` hashes on this tab redirect there. */}

                      <AccordionSection
                        id="markets"
                        title="Markets"
                        summary={
                          selectedPolymarketCategories.length
                            ? `${selectedPolymarketCategories.length} categor${selectedPolymarketCategories.length === 1 ? 'y' : 'ies'} followed`
                            : 'All categories'
                        }
                        icon={<NavIcon name="trending" size={18} />}
                      >
                        <p className="section-description">
                          Categories you pick surface first in your feed and preselect the market browser&apos;s filter.
                        </p>

                        {!polymarketSidebetsEnabled && (
                          <div className="key-error" role="note">
                            Polymarket is only available on Polygon. Switch networks to use these.
                          </div>
                        )}

                        <div className="polymarket-category-grid">
                          {POLYMARKET_CATEGORY_OPTIONS.map(({ slug, label }) => {
                            const checked = selectedPolymarketCategories.includes(slug)
                            return (
                              <label key={slug} className={`polymarket-category-option ${checked ? 'checked' : ''}`}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => togglePolymarketCategory(slug)}
                                />
                                <span>{label}</span>
                              </label>
                            )
                          })}
                        </div>

                        {selectedPolymarketCategories.length > 0 && (
                          <button
                            type="button"
                            className="key-action-btn secondary"
                            onClick={() => setPolymarketCategories([])}
                          >
                            Clear all
                          </button>
                        )}
                      </AccordionSection>

                      <AccordionSection
                        id="install-app"
                        title="Install app"
                        summary={pwaStandalone ? 'Installed on this device' : 'Runs in the browser'}
                        icon={<NavIcon name="grid" size={18} />}
                      >
                        {pwaStandalone ? (
                          <div className="key-status" role="note">
                            FairWins is already installed and running as an app on this device.
                          </div>
                        ) : (
                          <>
                            <p className="section-description">
                              Install FairWins for full-screen access — no app store, no download.
                            </p>
                            <label className="pwa-pref-toggle">
                              <input
                                type="checkbox"
                                checked={!pwaPromptHidden}
                                onChange={(e) => setPwaPromptHidden(!e.target.checked)}
                              />
                              <span>Show the install prompt when I visit in a browser</span>
                            </label>

                            {pwaCanPrompt && (
                              <button
                                type="button"
                                className="key-action-btn primary"
                                onClick={pwaPromptInstall}
                              >
                                Install now
                              </button>
                            )}

                            {pwaIsIos && !pwaCanPrompt && (
                              <p className="section-description">
                                On iOS, open the Share menu in Safari and choose{' '}
                                <strong>Add to Home Screen</strong> to install.
                              </p>
                            )}
                          </>
                        )}
                      </AccordionSection>

                      {/* Reached from the update toast via ?tab=settings#pwa-update — the hash
                          map below opens this card, so the member lands on the button, not on a
                          collapsed heading. */}
                      <AccordionSection
                        id="pwa-update"
                        title="Software update"
                        summary={pwaUpdateReady ? 'A new version is available' : "You're on the latest version"}
                        badge={pwaUpdateReady ? 'Update ready' : null}
                        badgeTone="info"
                        icon={<NavIcon name="arrowIn" size={18} />}
                      >
                        <div
                          className={`pwa-update-status ${pwaUpdateReady ? 'is-available' : 'is-current'}`}
                          role="status"
                        >
                          {pwaUpdateReady
                            ? 'A new version is available. Installing it reloads the app.'
                            : "You're running the latest version."}
                        </div>

                        <div className="pwa-update-buttons">
                          {pwaUpdateReady && (
                            <button
                              type="button"
                              className="key-action-btn primary"
                              onClick={pwaApplyUpdate}
                            >
                              Update now
                            </button>
                          )}
                          <button
                            type="button"
                            className="key-action-btn secondary"
                            onClick={handleCheckForUpdate}
                            disabled={pwaChecking}
                          >
                            {pwaChecking ? 'Checking\u2026' : 'Check for updates'}
                          </button>
                        </div>
                      </AccordionSection>

                      {/* Issue #1025 — moved from the side nav drawer's footer into Settings,
                          after Install app / Software update. */}
                      <AccordionSection
                        id="legal-policies"
                        title="Legal & policies"
                        summary="Terms, risk, privacy, moderation"
                        icon={<NavIcon name="reports" size={18} />}
                      >
                        <nav className="app-legal-links" aria-label="Legal and policy documents">
                          {LEGAL_LINKS.map((link) => (
                            <a key={link.href} href={link.href} className="app-legal-link-row">
                              <span className="app-legal-link-icon" aria-hidden="true">
                                <NavIcon name={LEGAL_LINK_ICONS[link.href] || LEGAL_LINK_ICON_DEFAULT} size={18} />
                              </span>
                              <span className="app-legal-link-label">{link.label}</span>
                              <span className="app-legal-link-chevron" aria-hidden="true">›</span>
                            </a>
                          ))}
                        </nav>
                      </AccordionSection>
                    </AccordionGroup>
                  </div>
                )}

                {activeTab === 'reports' && (
                  <div className="reports-section" role="tabpanel">
                    <TaxReportsPanel />
                  </div>
                )}

                {/* Apps (spec 073 US1) — the mini-app catalog. The panel does its own registry
                    read and is honest about every way that read can fail; this branch only
                    decides that the section exists for this tenant. */}
                {activeTab === 'apps' && miniAppsEnabled && (
                  <div className="apps-section" role="tabpanel">
                    <CatalogPanel />
                  </div>
                )}
                {/* Assistant (spec 104) — the agent controls. The panel is an accordion like
                    Settings, so the hash picks the card that lands open. */}
                {activeTab === 'assistant' && assistantEnabled && (
                  <div className="assistant-section" role="tabpanel">
                    <AssistantToolsPanel openSection={hashOpenSection} />
                  </div>
                )}
                {activeTab === 'trade' && (
                  <div className="trade-section" role="tabpanel">
                    <TradeSection />
                  </div>
                )}
                {activeTab === 'earn' && (
                  <div className="earn-section" role="tabpanel">
                    <EarnPanel />
                  </div>
                )}
                </div>

                {/* Mobile-only quick switching between the current section's
                    sibling views (Finance / Tools / Apps), pinned to the bottom. */}
                <SectionIconNav
                  items={sectionNavItems}
                  activeId={isAccountTab ? accountView : activeTab}
                  onSelect={(id) =>
                    navigate(
                      isAccountTab
                        ? `/wallet?tab=account${id === ACCOUNT_DEFAULT_VIEW ? '' : `&view=${id}`}`
                        : `/wallet?tab=${id}`,
                    )
                  }
                  ariaLabel={
                    isAccountTab
                      ? 'Account views'
                      : currentSectionGroup
                        ? `${currentSectionGroup.label} sections`
                        : 'Section navigation'
                  }
                />
              </div>
            </div>
          )}
      </div>
    </div>
  )
}

export default WalletPage
