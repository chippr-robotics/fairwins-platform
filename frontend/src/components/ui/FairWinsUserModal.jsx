import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWallet, useWalletConnection, useWalletRoles, useTheme, useNetworkMode } from '../../hooks'
import { useUserPreferences } from '../../hooks/useUserPreferences'
import { useModal } from '../../hooks/useUI'
import { usePrice } from '../../contexts/PriceContext'
import { useChainTokens } from '../../hooks/useChainTokens'
import { ROLES, ROLE_INFO } from '../../contexts/RoleContext'
import TradePanel from '../fairwins/TradePanel'
import PremiumPurchaseModal from './PremiumPurchaseModal'
import AccountAvatar from '../account/AccountAvatar'
import { buildIdentity } from '../../config/version'
import './FairWinsUserModal.css'

/**
 * FairWinsUserModal - Comprehensive user management modal
 *
 * Features:
 * - User profile and wallet management
 * - Theme switching (light/dark mode)
 * - Currency display toggle (USD/native)
 * - Role management and purchasing
 * - Testnet / Mainnet network toggle
 * - Market search
 * - Token swap integration
 * - Market creation launch
 *
 * @param {Function} onScanMarket - Callback for market scanning
 */
function FairWinsUserModal() {
  const { address, isConnected } = useWallet()
  const { disconnectWallet } = useWalletConnection()
  const { hideModal, showModal } = useModal()
  const { preferences } = useUserPreferences()
  const { roles, hasRole } = useWalletRoles()
  const { toggleMode, isDark } = useTheme()
  const {
    isMainnet,
    isOtherChain,
    network: activeNetwork,
    switchMode,
    isSwitching,
    error: networkSwitchError,
  } = useNetworkMode()
  const priceContext = usePrice() || {}
  const { showUsd = false, toggleCurrency = () => {} } = priceContext
  const { native: nativeSymbol } = useChainTokens()
  const symbol = nativeSymbol || 'POL'
  const navigate = useNavigate()

  const [activeTab, setActiveTab] = useState('profile')
  const [searchQuery, setSearchQuery] = useState('')

  // If somehow opened without a connection, just close to avoid empty UI
  if (!isConnected) {
    hideModal()
    return null
  }

  // === Event Handlers ===

  const handleDisconnect = () => {
    disconnectWallet()
    hideModal()
  }

  const handleToggleNetwork = () => {
    switchMode('toggle')
  }

  const handleSearchSubmit = (e) => {
    e.preventDefault()
    if (searchQuery.trim()) {
      hideModal()
      navigate(`/markets?search=${encodeURIComponent(searchQuery)}`)
    }
  }

  const handleLaunchMarket = () => {
    hideModal()
    navigate('/markets/create')
  }

  const handleOpenPurchaseModal = () => {
    showModal(<PremiumPurchaseModal onClose={hideModal} />, {
      title: '',
      size: 'large',
      closable: false
    })
  }

  const handleNavigateToAdmin = () => {
    hideModal()
    navigate('/admin')
  }

  const shortenAddress = (addr) => {
    if (!addr) return ''
    return `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`
  }

  // === Tab Configuration ===
  const tabs = [
    { id: 'profile', label: 'Profile', icon: '👤' },
    { id: 'settings', label: 'Settings', icon: '⚙️' },
    { id: 'search', label: 'Search', icon: '🔍' },
    { id: 'trade', label: 'Trade', icon: '🔄' },
    { id: 'launch', label: 'Launch', icon: '🚀' }
  ]

  return (
    <div className="fairwins-user-modal">
      {/* Header Section */}
      <header className="fwum-header">
        <div className="fwum-wallet-info">
          <AccountAvatar address={address} size={48} className="fwum-avatar" />
          <div className="fwum-wallet-details">
            <span className="fwum-address">{shortenAddress(address)}</span>
            <span className="fwum-address-full">{address}</span>
            <div className="fwum-connection-status">
              <span className="fwum-status-dot connected" aria-hidden="true" />
              <span className="fwum-status-text">Connected</span>
            </div>
          </div>
        </div>
        <button 
          onClick={handleDisconnect} 
          className="fwum-disconnect-btn"
          aria-label="Disconnect wallet"
        >
          <span aria-hidden="true">🔌</span>
          Disconnect
        </button>
      </header>

      {/* Tab Navigation */}
      <nav className="fwum-tabs" role="tablist" aria-label="User modal sections">
        {tabs.map(tab => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            className={`fwum-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="fwum-tab-icon" aria-hidden="true">{tab.icon}</span>
            <span className="fwum-tab-label">{tab.label}</span>
          </button>
        ))}
      </nav>

      {/* Tab Content */}
      <div className="fwum-content">
        {/* Profile Tab */}
        {activeTab === 'profile' && (
          <div id="panel-profile" role="tabpanel" className="fwum-panel">
            {/* Wallet Section */}
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">👛</span> Wallet
              </h3>
              <div className="fwum-wallet-card">
                <div className="fwum-info-row">
                  <span className="fwum-label">Address</span>
                  <span className="fwum-value fwum-monospace">{address}</span>
                </div>
              </div>
            </section>

            {/* Network */}
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">📡</span> Network
              </h3>
              <div className="fwum-datasource-card">
                <div className="fwum-status-row">
                  <span className={`fwum-mode-badge ${isMainnet ? 'live' : 'demo'}`}>
                    <span aria-hidden="true">{isMainnet ? '🌐' : '🧪'}</span>
                    {isMainnet ? 'Mainnet' : isOtherChain ? activeNetwork?.name || 'Other' : 'Testnet'}
                  </span>
                  <span className="fwum-mode-chain">{activeNetwork?.name}</span>
                </div>
                <p className="fwum-description">
                  {isMainnet
                    ? 'Connected to Polygon Mainnet. Transactions use real funds and gas.'
                    : isOtherChain
                      ? `You're on ${activeNetwork?.name || 'an unsupported chain'}. Switch to Testnet (Polygon Amoy) or Mainnet (Polygon).`
                      : 'Connected to Polygon Amoy testnet. Use a faucet for test POL.'}
                </p>
                <button
                  onClick={handleToggleNetwork}
                  className="fwum-action-btn secondary"
                  disabled={isSwitching}
                >
                  {isSwitching
                    ? 'Switching…'
                    : `Switch to ${isMainnet ? 'Testnet' : 'Mainnet'}`}
                </button>
                {networkSwitchError && (
                  <p className="fwum-description fwum-error-text" role="alert">
                    {networkSwitchError.shortMessage || networkSwitchError.message || 'Network switch failed.'}
                  </p>
                )}
              </div>
            </section>

            {/* Your Roles */}
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">🏆</span> Your Roles
              </h3>
              {roles.length > 0 ? (
                <div className="fwum-roles-list">
                  {roles.map(role => {
                    const roleInfo = ROLE_INFO[role]
                    return (
                      <div key={role} className="fwum-role-card">
                        <div className="fwum-role-header">
                          <span className="fwum-role-badge">{roleInfo?.name || role}</span>
                          {roleInfo?.premium && (
                            <span className="fwum-premium-badge">
                              <span aria-hidden="true">⭐</span> Premium
                            </span>
                          )}
                        </div>
                        <p className="fwum-role-description">
                          {roleInfo?.description || 'No description'}
                        </p>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="fwum-no-roles">
                  <span className="fwum-no-roles-icon" aria-hidden="true">🔐</span>
                  <p>You don't have any special roles yet.</p>
                  <button 
                    onClick={handleOpenPurchaseModal}
                    className="fwum-premium-btn"
                  >
                    <span aria-hidden="true">✨</span>
                    Get Premium Access
                  </button>
                </div>
              )}
            </section>

            {/* Admin Section (for admins) */}
            {hasRole(ROLES.ADMIN) && (
              <section className="fwum-section fwum-admin-section">
                <h3 className="fwum-section-title">
                  <span aria-hidden="true">⚡</span> Administration
                </h3>
                <p className="fwum-description">
                  Manage roles and permissions for users
                </p>
                <button 
                  onClick={handleNavigateToAdmin}
                  className="fwum-action-btn danger"
                >
                  Role Management
                </button>
              </section>
            )}

            {/* Preferences Summary */}
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">📊</span> Quick Stats
              </h3>
              <div className="fwum-stats-grid">
                <div className="fwum-stat-card">
                  <span className="fwum-stat-label">Favorite Markets</span>
                  <span className="fwum-stat-value">{preferences.favoriteMarkets?.length || 0}</span>
                </div>
                <div className="fwum-stat-card">
                  <span className="fwum-stat-label">Default Slippage</span>
                  <span className="fwum-stat-value">{preferences.defaultSlippage || 0.5}%</span>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div id="panel-settings" role="tabpanel" className="fwum-panel">
            {/* Appearance Section */}
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">🎨</span> Appearance
              </h3>
              
              {/* Theme Toggle */}
              <div className="fwum-setting-item">
                <div className="fwum-setting-info">
                  <span className="fwum-setting-icon" aria-hidden="true">
                    {isDark ? '🌙' : '☀️'}
                  </span>
                  <div className="fwum-setting-text">
                    <strong>Theme</strong>
                    <p>Switch between light and dark mode</p>
                  </div>
                </div>
                <button
                  className="fwum-toggle-btn"
                  onClick={toggleMode}
                  aria-pressed={isDark}
                  aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
                >
                  <span className="fwum-toggle-track">
                    <span className={`fwum-toggle-thumb ${isDark ? 'active' : ''}`} />
                  </span>
                  <span className="fwum-toggle-label">{isDark ? 'Dark' : 'Light'}</span>
                </button>
              </div>

            </section>

            {/* Display Section */}
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">💱</span> Display Currency
              </h3>
              
              <div className="fwum-setting-item">
                <div className="fwum-setting-info">
                  <span className="fwum-setting-icon" aria-hidden="true">
                    {showUsd ? '💵' : '⚡'}
                  </span>
                  <div className="fwum-setting-text">
                    <strong>Currency</strong>
                    <p>Toggle between USD and {symbol} display</p>
                  </div>
                </div>
                <button
                  className="fwum-toggle-btn"
                  onClick={toggleCurrency}
                  aria-pressed={showUsd}
                  aria-label={`Switch to ${showUsd ? symbol : 'USD'} display`}
                >
                  <span className="fwum-toggle-track currency">
                    <span className={`fwum-toggle-thumb ${showUsd ? 'active' : ''}`} />
                  </span>
                  <span className="fwum-toggle-label">{showUsd ? 'USD' : symbol}</span>
                </button>
              </div>
            </section>

            {/* Network Section */}
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">📡</span> Network
              </h3>

              <div className="fwum-setting-item">
                <div className="fwum-setting-info">
                  <span className="fwum-setting-icon" aria-hidden="true">
                    {isMainnet ? '🌐' : '🧪'}
                  </span>
                  <div className="fwum-setting-text">
                    <strong>{isMainnet ? 'Mainnet' : 'Testnet'}</strong>
                    <p>{activeNetwork?.name || (isMainnet ? 'Polygon' : 'Polygon Amoy')}</p>
                  </div>
                </div>
                <button
                  className="fwum-toggle-btn"
                  onClick={handleToggleNetwork}
                  aria-pressed={isMainnet}
                  aria-label={`Switch to ${isMainnet ? 'Testnet' : 'Mainnet'}`}
                  disabled={isSwitching}
                >
                  <span className="fwum-toggle-track data">
                    <span className={`fwum-toggle-thumb ${isMainnet ? 'active' : ''}`} />
                  </span>
                  <span className="fwum-toggle-label">{isMainnet ? 'Mainnet' : 'Testnet'}</span>
                </button>
              </div>
            </section>

            {/* Wallet Section */}
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">👛</span> Wallet Connection
              </h3>
              <div className="fwum-wallet-status-card">
                <div className="fwum-wallet-connected">
                  <span className="fwum-wallet-status-icon connected" aria-hidden="true">✓</span>
                  <div className="fwum-wallet-status-info">
                    <strong>Connected</strong>
                    <span className="fwum-wallet-address">{shortenAddress(address)}</span>
                  </div>
                </div>
                <button 
                  onClick={handleDisconnect}
                  className="fwum-disconnect-settings-btn"
                >
                  Disconnect
                </button>
              </div>
            </section>
          </div>
        )}

        {/* Search Tab */}
        {activeTab === 'search' && (
          <div id="panel-search" role="tabpanel" className="fwum-panel">
            <section className="fwum-section">
              <h3 className="fwum-section-title">
                <span aria-hidden="true">🔍</span> Search Markets
              </h3>
              <form onSubmit={handleSearchSubmit} className="fwum-search-form">
                <div className="fwum-search-input-group">
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search for markets..."
                    className="fwum-search-input"
                    aria-label="Search markets"
                  />
                  <button type="submit" className="fwum-search-btn">
                    <span aria-hidden="true">🔍</span>
                    Search
                  </button>
                </div>
              </form>

              {preferences.recentSearches?.length > 0 && (
                <div className="fwum-recent-searches">
                  <h4>Recent Searches</h4>
                  <ul className="fwum-search-list">
                    {preferences.recentSearches.slice(0, 5).map((search, index) => (
                      <li key={index}>
                        <button
                          onClick={() => setSearchQuery(search)}
                          className="fwum-search-item"
                        >
                          <span aria-hidden="true">🕐</span>
                          {search}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="fwum-search-help">
                <span className="fwum-help-icon" aria-hidden="true">💡</span>
                <p>Search for prediction markets by title, category, or description.</p>
              </div>
            </section>
          </div>
        )}

        {/* Trade Tab */}
        {activeTab === 'trade' && (
          <div id="panel-trade" role="tabpanel" className="fwum-panel fwum-panel-swap">
            <TradePanel />
          </div>
        )}

        {/* Launch Tab */}
        {activeTab === 'launch' && (
          <div id="panel-launch" role="tabpanel" className="fwum-panel">
            <section className="fwum-section fwum-launch-section">
              <div className="fwum-launch-content">
                <div className="fwum-launch-icon" aria-hidden="true">🚀</div>
                <h3>Launch a New Market</h3>
                <p className="fwum-launch-description">
                  Create and launch your own prediction market. Define the question, 
                  set the parameters, and let the community predict the outcome.
                </p>
                <button 
                  onClick={handleLaunchMarket}
                  className="fwum-launch-btn"
                >
                  <span aria-hidden="true">✨</span>
                  Create New Market
                </button>
                
                <div className="fwum-launch-requirements">
                  <h4>
                    <span aria-hidden="true">📋</span> Requirements
                  </h4>
                  <ul>
                    <li>
                      <span aria-hidden="true">✓</span>
                      Connected wallet with sufficient funds
                    </li>
                    <li>
                      <span aria-hidden="true">✓</span>
                      Clear market question and resolution criteria
                    </li>
                    <li>
                      <span aria-hidden="true">✓</span>
                      Initial liquidity for the market
                    </li>
                  </ul>
                </div>

                {hasRole(ROLES.WAGER_PARTICIPANT) && (
                  <div className="fwum-market-maker-badge">
                    <span aria-hidden="true">⭐</span>
                    You have an active Wager Participant membership
                  </div>
                )}
              </div>
            </section>
          </div>
        )}

        {/*
          Build identity (spec 076, FR-029). Shown on every tab, not tucked behind one, because its
          whole purpose is to be readable when someone is asked "what version are you on?".
          An unreleased build says so — it never displays the nearest release (FR-031).
        */}
        <BuildIdentityLine />
      </div>
    </div>
  )
}

function BuildIdentityLine() {
  const { label, sha, released, candidate } = buildIdentity()
  const description = released
    ? candidate
      ? 'Release candidate — pre-production build'
      : 'Released build'
    : 'Unreleased build — not a published release'

  return (
    <div className="fwum-build-identity" data-testid="build-identity">
      <span className="fwum-build-label">Version</span>
      <span className="fwum-build-value" title={`${description} (commit ${sha})`}>
        {label}
      </span>
      {!released && (
        <span className="fwum-build-note">not a published release</span>
      )}
      <span className="sr-only">{description}</span>
    </div>
  )
}

export default FairWinsUserModal
