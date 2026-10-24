import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useWallet, useWalletConnection, useWalletRoles, useNetworkMode } from '../../hooks'
import { useUserPreferences } from '../../hooks/useUserPreferences'
import { useModal } from '../../hooks/useUI'
import { ROLES, ROLE_INFO } from '../../contexts/RoleContext'
import TradePanel from '../fairwins/TradePanel'
import PremiumPurchaseModal from './PremiumPurchaseModal'
import AccountAvatar from '../account/AccountAvatar'
import './UserManagementModal.css'

// eslint-disable-next-line no-unused-vars
function UserManagementModal({ onScanMarket }) {
  const { address, isConnected } = useWallet()
  const { disconnectWallet } = useWalletConnection()
  const { hideModal, showModal } = useModal()
  const { preferences } = useUserPreferences()
  const {
    isMainnet,
    network: activeNetwork,
    switchMode: switchNetworkMode,
    isSwitching: isSwitchingNetwork,
  } = useNetworkMode()
  const { roles, hasRole } = useWalletRoles()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('profile')
  const [searchQuery, setSearchQuery] = useState('')

  // If somehow opened without a connection, just close to avoid empty UI
  if (!isConnected) {
    hideModal()
    return null
  }

  const handleDisconnect = () => {
    disconnectWallet()
    hideModal()
  }

  const handleToggleNetwork = () => {
    switchNetworkMode('toggle')
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

  const shortenAddress = (address) => {
    if (!address) return ''
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`
  }

  return (
    <div className="user-management-modal">
      <div className="modal-header-section">
        <div className="wallet-info-header">
          <AccountAvatar address={address} size={40} className="wallet-avatar" />
          <div className="wallet-address-stack">
            <span className="wallet-address-display">{shortenAddress(address)}</span>
            <span className="wallet-address-full">{address}</span>
          </div>
          <span className={`status-dot ${isConnected ? 'connected' : ''}`} aria-hidden="true"></span>
        </div>
        <button onClick={handleDisconnect} className="disconnect-btn">Disconnect</button>
      </div>

      {/* Tab Navigation */}
      <div className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={activeTab === 'profile'}
          className={`tab ${activeTab === 'profile' ? 'active' : ''}`}
          onClick={() => setActiveTab('profile')}
        >
          Profile
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'search'}
          className={`tab ${activeTab === 'search' ? 'active' : ''}`}
          onClick={() => setActiveTab('search')}
        >
          Search Markets
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'trade'}
          className={`tab ${activeTab === 'trade' ? 'active' : ''}`}
          onClick={() => setActiveTab('trade')}
        >
          Trade
        </button>
        <button
          role="tab"
          aria-selected={activeTab === 'launch'}
          className={`tab ${activeTab === 'launch' ? 'active' : ''}`}
          onClick={() => setActiveTab('launch')}
        >
          Launch Market
        </button>
      </div>

      {/* Tab Content */}
      <div className="tab-content">
        {activeTab === 'profile' && (
          <div className="profile-section" role="tabpanel">
            <div className="section">
              <h3>Wallet</h3>
              <div className="wallet-details">
                <div className="detail-row">
                  <span className="label">Address:</span>
                  <span className="value">{address}</span>
                </div>
              </div>
            </div>

            <div className="section">
              <h3>Preferences</h3>
              <div className="preferences-info">
                <div className="pref-item">
                  <span className="pref-label">Favorite Markets:</span>
                  <span className="pref-value">{preferences.favoriteMarkets.length}</span>
                </div>
                <div className="pref-item">
                  <span className="pref-label">Default Slippage:</span>
                  <span className="pref-value">{preferences.defaultSlippage}%</span>
                </div>
              </div>
            </div>

            <div className="section">
              <h3>Network</h3>
              <div className="network-toggle-section">
                <div className="status-display">
                  <span className={`status-badge ${isMainnet ? 'live' : 'demo'}`}>
                    {isMainnet ? 'Mainnet' : 'Testnet'}
                  </span>
                  <span className="pref-value">{activeNetwork?.name}</span>
                </div>
                <button
                  onClick={handleToggleNetwork}
                  className="toggle-network-btn"
                  disabled={isSwitchingNetwork}
                >
                  {isSwitchingNetwork
                    ? 'Switching…'
                    : `Switch to ${isMainnet ? 'Testnet' : 'Mainnet'}`}
                </button>
                <p className="network-toggle-description">
                  {isMainnet
                    ? <><span aria-hidden="true">🌐</span> Mainnet: Connected to Polygon. Transactions use real funds and gas.</>
                    : <><span aria-hidden="true">🧪</span> Testnet: Connected to Polygon Amoy. Use a faucet for test POL.</>}
                </p>
              </div>
            </div>

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
                  <p>You don't have any special roles yet.</p>
                  <button 
                    onClick={handleOpenPurchaseModal}
                    className="get-roles-btn"
                  >
                    Get Premium Access
                  </button>
                </div>
              )}
            </div>

            {hasRole(ROLES.ADMIN) && (
              <div className="section admin-section">
                <h3>Administration</h3>
                <p className="section-description">
                  Manage roles and permissions for users
                </p>
                <button 
                  onClick={handleNavigateToAdmin}
                  className="admin-panel-btn"
                >
                  Role Management
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'search' && (
          <div className="search-section" role="tabpanel">
            <h3>Search Markets</h3>
            <form onSubmit={handleSearchSubmit} className="search-form">
              <div className="search-input-group">
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search for markets..."
                  className="search-input"
                  aria-label="Search markets"
                />
                <button type="submit" className="search-btn">
                  Search
                </button>
              </div>
            </form>

            {preferences.recentSearches.length > 0 && (
              <div className="recent-searches">
                <h4>Recent Searches</h4>
                <ul className="search-list">
                  {preferences.recentSearches.slice(0, 5).map((search, index) => (
                    <li key={index} className="search-item">
                      <button
                        onClick={() => setSearchQuery(search)}
                        className="search-item-btn"
                      >
                        {search}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="search-help">
              <p>Search for prediction markets by title, category, or description.</p>
            </div>
          </div>
        )}

        {activeTab === 'trade' && (
          <div className="swap-section" role="tabpanel">
            <TradePanel />
          </div>
        )}

        {activeTab === 'launch' && (
          <div className="launch-section" role="tabpanel">
            <h3>Launch a New Market</h3>
            <div className="launch-content">
              <div className="launch-icon" aria-hidden="true">🚀</div>
              <p className="launch-description">
                Create and launch your own prediction market. Define the question, 
                set the parameters, and let the community predict the outcome.
              </p>
              <button 
                onClick={handleLaunchMarket}
                className="launch-market-btn"
              >
                Launch New Market
              </button>
              <div className="launch-help">
                <h4>Requirements:</h4>
                <ul>
                  <li>Connected wallet with sufficient funds</li>
                  <li>Clear market question and resolution criteria</li>
                  <li>Initial liquidity for the market</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default UserManagementModal
