import { useTheme } from '../../hooks/useTheme'
import { usePrice } from '../../contexts/PriceContext'
import { useChainTokens } from '../../hooks/useChainTokens'
import './SettingsModal.css'

/**
 * SettingsModal component
 * Modal for user settings including theme toggle, currency toggle, and wallet management
 */
export default function SettingsModal({ isOpen, onClose, onConnect, onDisconnect, isConnected, account }) {
  const { mode, toggleMode, isDark } = useTheme()
  const { showUsd, toggleCurrency } = usePrice()
  const { native: nativeSymbol } = useChainTokens()
  const symbol = nativeSymbol || 'POL'

  if (!isOpen) return null

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  const handleConnectClick = async () => {
    if (onConnect) {
      await onConnect()
    }
  }

  const handleDisconnectClick = () => {
    if (onDisconnect) {
      onDisconnect()
    }
    onClose()
  }

  const shortenAddress = (address) => {
    if (!address) return ''
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`
  }

  return (
    <div 
      className="settings-modal-overlay" 
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div className="settings-modal-content">
        <div className="settings-modal-header">
          <h2 id="settings-modal-title">Settings</h2>
          <button
            className="settings-modal-close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        <div className="settings-modal-body">
          {/* Theme Section */}
          <div className="settings-section">
            <h3>Appearance</h3>
            <div className="setting-item">
              <div className="setting-label">
                <span className="setting-icon" aria-hidden="true">
                  {isDark ? '🌙' : '☀️'}
                </span>
                <div>
                  <strong>Theme</strong>
                  <p className="setting-description">
                    Switch between light and dark mode
                  </p>
                </div>
              </div>
              <button
                className="setting-toggle"
                onClick={toggleMode}
                aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
                aria-pressed={isDark}
              >
                <span className="toggle-track">
                  <span className={`toggle-thumb ${isDark ? 'active' : ''}`} />
                </span>
                <span className="toggle-label">{mode === 'dark' ? 'Dark' : 'Light'}</span>
              </button>
            </div>
          </div>

          {/* Currency Section */}
          <div className="settings-section">
            <h3>Display Currency</h3>
            <div className="setting-item">
              <div className="setting-label">
                <span className="setting-icon" aria-hidden="true">
                  {showUsd ? '💵' : '⚡'}
                </span>
                <div>
                  <strong>Currency</strong>
                  <p className="setting-description">
                    Toggle between USD and {symbol} display
                  </p>
                </div>
              </div>
              <button
                className="setting-toggle"
                onClick={toggleCurrency}
                aria-label={`Switch to ${showUsd ? symbol : 'USD'} display`}
                aria-pressed={showUsd}
              >
                <span className="toggle-track">
                  <span className={`toggle-thumb ${showUsd ? 'active' : ''}`} />
                </span>
                <span className="toggle-label">{showUsd ? 'USD' : symbol}</span>
              </button>
            </div>
          </div>

          {/* Wallet Section */}
          <div className="settings-section">
            <h3>Wallet</h3>
            {isConnected ? (
              <div className="setting-item wallet-status">
                <div className="setting-label">
                  <span className="setting-icon status-connected" aria-hidden="true">
                    ✓
                  </span>
                  <div>
                    <strong>Connected</strong>
                    <p className="setting-description">
                      {shortenAddress(account)}
                    </p>
                  </div>
                </div>
                <button
                  className="disconnect-wallet-btn"
                  onClick={handleDisconnectClick}
                  aria-label="Disconnect wallet"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <div className="setting-item wallet-status">
                <div className="setting-label">
                  <span className="setting-icon" aria-hidden="true">
                    👛
                  </span>
                  <div>
                    <strong>Not Connected</strong>
                    <p className="setting-description">
                      Connect your wallet to trade
                    </p>
                  </div>
                </div>
                <button
                  className="connect-wallet-btn"
                  onClick={handleConnectClick}
                  aria-label="Connect wallet"
                >
                  Connect
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
