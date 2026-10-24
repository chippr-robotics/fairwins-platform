import { useMemo } from 'react'
import { useWalletChainId } from './useWalletChainId'
import { getNetwork, getCurrentChainId } from '../config/networks'

/**
 * Hook returning chain-aware token symbols, decimals, and per-chain
 * capabilities. Use this anywhere the UI would otherwise hardcode a token
 * symbol — on the Polygon pair the native is POL and the stable is USDC.
 *
 * Capabilities flow through here so screens can decide whether to gate
 * features (e.g. Polymarket-pegged side bets only render on chains where
 * Polymarket's CTF lives).
 *
 * The returned object is memoized on the chain id: consumers put it (and
 * lists derived from it, e.g. useSelectableAssets options) in dependency
 * arrays, and a fresh object every render turns those into every-render
 * effects (issue #1027 — the Bridge quote loop).
 */
export function useChainTokens() {
  const wagmiChainId = useWalletChainId()
  const chainId = wagmiChainId || getCurrentChainId()

  return useMemo(() => {
    const n = getNetwork(chainId)
    return {
      chainId,
      networkName: n?.name || '',
      isPrimary: Boolean(n?.isPrimary),
      isTestnet: Boolean(n?.isTestnet),
      capabilities: n?.capabilities || {},
      native: n?.nativeCurrency?.symbol || '',
      nativeName: n?.nativeCurrency?.name || '',
      nativeDecimals: n?.nativeCurrency?.decimals || 18,
      stable: n?.stablecoin?.symbol || 'STABLE',
      stableName: n?.stablecoin?.name || '',
      stableAddress: n?.stablecoin?.address || null,
      stableDecimals: n?.stablecoin?.decimals || 6,
    }
  }, [chainId])
}

export default useChainTokens
