import { useCallback, useEffect, useRef, useState } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { getNetwork, getCurrentChainId } from '../config/networks'
import { normaliseGammaMarket } from './usePolymarketSearch'
import logger from '../utils/logger'

const DEFAULT_GAMMA_BASE = 'https://gamma-api.polymarket.com'
const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000'

function apiBaseFor(chainId) {
  const network = getNetwork(chainId)
  const base = network?.polymarket?.gammaApiUrl || DEFAULT_GAMMA_BASE
  return base.replace(/\/$/, '')
}

/** A usable condition id: non-empty and not the zero hash (non-oracle wagers store zero). */
function isRealConditionId(conditionId) {
  if (!conditionId) return false
  const s = String(conditionId)
  return s !== ZERO_HASH && /^0x[0-9a-fA-F]+$/.test(s)
}

/**
 * Fetch a single Polymarket market by condition id from the Gamma API (spec 041, FR-014).
 * Used by the claimant view for live odds/status and by the create flow for a freshness
 * re-check. One fetch per (conditionId, chainId) mount plus manual refresh() — no polling.
 *
 * Never throws into render: failures land in `error` and the caller shows the disclosed
 * "live market info unavailable" state (the bound challenge terms never depend on this).
 */
export function usePolymarketMarket(conditionId, { enabled = true } = {}) {
  const wagmiChainId = useWalletChainId()
  const chainId = wagmiChainId || getCurrentChainId()
  const apiBase = apiBaseFor(chainId)

  const active = enabled && isRealConditionId(conditionId)

  const [market, setMarket] = useState(null)
  const [isLoading, setIsLoading] = useState(active)
  const [error, setError] = useState(null)
  const abortRef = useRef(null)

  const fetchMarket = useCallback(async () => {
    if (!active) {
      setMarket(null)
      setIsLoading(false)
      setError(null)
      return
    }
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setIsLoading(true)
    setError(null)
    try {
      const url = `${apiBase}/markets?condition_ids=${encodeURIComponent(String(conditionId))}&limit=1`
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal })
      if (!res.ok) throw new Error(`Market lookup failed (${res.status})`)
      const data = await res.json()
      const raw = Array.isArray(data) ? data[0] : Array.isArray(data?.data) ? data.data[0] : null
      if (!raw) throw new Error('Market not found')
      setMarket(normaliseGammaMarket(raw))
    } catch (err) {
      if (err?.name === 'AbortError') return
      logger.warn?.('[usePolymarketMarket] failed:', err)
      setMarket(null)
      setError(err?.message || 'Live market info unavailable')
    } finally {
      if (!controller.signal.aborted) setIsLoading(false)
    }
  }, [active, apiBase, conditionId])

  useEffect(() => {
    fetchMarket()
    return () => { if (abortRef.current) abortRef.current.abort() }
  }, [fetchMarket])

  return { market, isLoading, error, refresh: fetchMarket }
}

export default usePolymarketMarket
