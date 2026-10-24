import { usePrice } from '../../contexts/PriceContext'
import { useChainTokens } from '../../hooks/useChainTokens'
import './CurrencyToggle.css'

function CurrencyToggle() {
  const { showUsd, toggleCurrency, nativeUsdRate, loading } = usePrice()
  const { native: nativeSymbol } = useChainTokens()
  const symbol = nativeSymbol || 'POL'

  return (
    <button
      className="currency-toggle"
      onClick={toggleCurrency}
      aria-label={`Currently showing prices in ${showUsd ? 'USD' : symbol}. Click to toggle to ${showUsd ? symbol : 'USD'}`}
      title={`Toggle between USD and ${symbol}${nativeUsdRate ? ` (1 ${symbol} = $${nativeUsdRate.toFixed(2)})` : ''}`}
      disabled={loading}
    >
      <span className={`currency-option ${showUsd ? 'active' : ''}`}>USD</span>
      <span className="currency-divider">|</span>
      <span className={`currency-option ${!showUsd ? 'active' : ''}`}>{symbol}</span>
    </button>
  )
}

export default CurrencyToggle
