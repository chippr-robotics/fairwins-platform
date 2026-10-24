import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUnits } from '../lib/evm/units'
import { useWallet } from './useWalletManagement'
import { makeReadProvider } from '../utils/rpcProvider'
import { useEndpointsRevision } from './useRpcEndpoints'
import { NETWORKS } from '../config/networks'
import { getPortfolioRegistry } from '../config/assetTaxonomy'
import { readBalancesSettled } from '../lib/portfolio/batchBalances'

/**
 * Read the CONNECTED chain's transferable balances (native + curated ERC-20s, no NFTs) for an arbitrary
 * account address. This lets the Transfer form source its asset list + balances from whichever "From"
 * account is active — in particular a custody vault, which lives on the connected chain and is not part of
 * the connected wallet's cross-chain portfolio scan (usePortfolio). Returns holdings shaped like a
 * usePortfolio holding ({ asset, balance, network }), so callers treat vault and personal sources
 * identically. Honest-state: a balance read that fails drops that asset rather than rendering a false zero.
 *
 * Pass `accountAddress = null` (e.g. when operating personally) to disable the reads and get an empty list.
 */
export function useAccountAssets(accountAddress) {
  const { chainId } = useWallet()
  const numericChainId = Number(chainId)

  const registry = useMemo(
    () => getPortfolioRegistry(numericChainId).filter((a) => a.kind === 'native' || a.kind === 'erc20'),
    [numericChainId],
  )
  const endpointRevision = useEndpointsRevision()
  // Rebuilt when the member repoints this network (spec 069).
  const provider = useMemo(() => {
    const net = NETWORKS[numericChainId]
    return net?.rpcUrl ? makeReadProvider(net.rpcUrl, numericChainId) : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericChainId, endpointRevision])

  const [holdings, setHoldings] = useState([])

  // Compute (never sets state) so the effect below can set state off the synchronous path.
  const compute = useCallback(async () => {
    if (!accountAddress || !provider || registry.length === 0) return []
    // One Multicall3 round trip for the whole chain instead of one request per asset (#1459);
    // results align with the registry by index, and a failed read still drops the asset rather
    // than rendering a false zero.
    const settled = await readBalancesSettled(
      registry,
      new Map([[numericChainId, provider]]),
      accountAddress,
    )
    return settled
      .map((res, i) => ({ res, asset: registry[i] }))
      .filter(({ res }) => res.status === 'fulfilled')
      .map(({ res, asset }) => ({
        asset,
        balance: Number(formatUnits(res.value, asset.decimals)),
        network: NETWORKS[asset.chainId]?.name || String(asset.chainId),
      }))
  }, [accountAddress, provider, registry, numericChainId])

  useEffect(() => {
    let active = true
    compute().then((h) => { if (active) setHoldings(h) })
    return () => { active = false }
  }, [compute])

  const refresh = useCallback(() => {
    compute().then((h) => setHoldings(h))
  }, [compute])

  return useMemo(() => ({ holdings, refresh }), [holdings, refresh])
}

export default useAccountAssets
