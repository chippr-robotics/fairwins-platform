import { useState, useEffect, useCallback } from 'react'
import logger from '../utils/logger'

/**
 * Hook to fetch and manage POL/USD exchange rate.
 *
 * The Polygon pair (137 / Amoy 80002) is the app's home network, so the
 * native token tracked here is POL (Polygon's gas token since the MATIC → POL
 * migration). Uses CoinGecko's public API; falls back to
 * VITE_POL_USD_FALLBACK (legacy VITE_MATIC_USD_FALLBACK still honoured, else
 * 0.5) when the request fails.
 */
function usePriceConversion() {
  const [nativeUsdRate, setNativeUsdRate] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showUsd, setShowUsd] = useState(true)
  const [lastUpdate, setLastUpdate] = useState(null)

  const fetchNativePrice = useCallback(async () => {
    if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') {
      setNativeUsdRate(0.5)
      setLoading(false)
      setLastUpdate(new Date())
      return
    }

    try {
      setLoading(true)
      setError(null)

      // POL's CoinGecko ID is 'polygon-ecosystem-token' ('matic-network' is
      // the deprecated pre-migration token and no longer tracks the gas coin).
      const response = await fetch(
        'https://api.coingecko.com/api/v3/simple/price?ids=polygon-ecosystem-token&vs_currencies=usd',
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        }
      )

      if (!response.ok) {
        throw new Error(`Failed to fetch price: ${response.status}`)
      }

      const data = await response.json()

      if (data['polygon-ecosystem-token'] && data['polygon-ecosystem-token'].usd) {
        setNativeUsdRate(data['polygon-ecosystem-token'].usd)
        setLastUpdate(new Date())
      } else {
        throw new Error('Invalid response format')
      }
    } catch (err) {
      logger.error('Error fetching POL price:', err)
      setError(err.message)
      const fallbackRate =
        import.meta.env.VITE_POL_USD_FALLBACK || import.meta.env.VITE_MATIC_USD_FALLBACK || 0.5
      setNativeUsdRate(fallbackRate)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchNativePrice()
    // Refresh every 5 minutes to stay polite with the public CoinGecko API.
    const interval = setInterval(fetchNativePrice, 300000)
    return () => clearInterval(interval)
  }, [fetchNativePrice])

  const toggleCurrency = useCallback(() => {
    setShowUsd((prev) => !prev)
  }, [])

  const convertToUsd = useCallback((nativeAmount) => {
    if (!nativeUsdRate || nativeAmount == null) return 0
    return parseFloat(nativeAmount) * nativeUsdRate
  }, [nativeUsdRate])

  const formatPrice = useCallback((nativeAmount, options = {}) => {
    const {
      showBoth = false,
      decimals = 2,
      compact = false,
      symbol = 'POL',
    } = options

    const amount = parseFloat(nativeAmount) || 0
    const usdAmount = convertToUsd(amount)

    const formatUsd = (value) => {
      if (compact && value >= 1000000) {
        return `$${(value / 1000000).toFixed(2)}M`
      }
      if (compact && value >= 1000) {
        return `$${(value / 1000).toFixed(1)}K`
      }
      return `$${value.toFixed(decimals)}`
    }

    const formatNative = (value) => {
      if (compact && value >= 1000) {
        return `${(value / 1000).toFixed(1)}K ${symbol}`
      }
      return `${value.toFixed(decimals)} ${symbol}`
    }

    if (showBoth) {
      if (showUsd) {
        return `${formatUsd(usdAmount)} (${formatNative(amount)})`
      } else {
        return `${formatNative(amount)} (${formatUsd(usdAmount)})`
      }
    } else {
      return showUsd ? formatUsd(usdAmount) : formatNative(amount)
    }
  }, [convertToUsd, showUsd])

  return {
    // Back-compat alias: many callers still destructure `etcUsdRate`.
    etcUsdRate: nativeUsdRate,
    nativeUsdRate,
    loading,
    error,
    showUsd,
    toggleCurrency,
    convertToUsd,
    formatPrice,
    lastUpdate,
    refreshPrice: fetchNativePrice
  }
}

export default usePriceConversion
