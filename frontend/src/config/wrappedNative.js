/**
 * Wrapped native coin — the network's own canonical WETH9-shaped contract.
 *
 * ONE resolver, because there were already two half-answers to "what is the wrapped
 * form of this chain's coin?": the DEX config's `wnative` (what swapping pairs
 * against) and the synced deployment record's `wmatic` key (what the wager/pool
 * contracts were configured with — despite the name it holds WETC on the Ethereum
 * Classic chains, not a Polygon token). Both point at the same contract wherever
 * both exist, and neither exists everywhere. Anything that needs the wrapped coin —
 * the portfolio registry, the Wrap view — resolves it here so a chain can never be
 * "wrappable" on one surface and absent on another.
 *
 * There is deliberately NO curated fallback table. An address that is not in the
 * app's own configuration is one nobody here verified, and wrapping sends the
 * member's coin to it: an unconfigured chain reports `null` and every surface says
 * so honestly (Constitution III) rather than guessing at a canonical deployment.
 *
 * `symbol`/`name` here are DERIVED labels for a surface that has to render before a
 * chain read returns. They are not authority: a wrapper can be re-branded on-chain
 * (Polygon's was, WMATIC → WPOL — the config now says POL so both agree), so a
 * caller that can read the contract should prefer what the contract says about
 * itself and fall back to these.
 */
import { NETWORKS, cohortChainIds } from './networks'
import { getContractAddressForChain } from './contracts'

/**
 * The wrapped native coin configured for a chain.
 *
 * @param {number} chainId
 * @returns {{ chainId: number, address: string, symbol: string, name: string, decimals: number } | null}
 *   `null` when this network has no wrapped-coin contract in the app's configuration.
 */
export function getWrappedNative(chainId) {
  const net = NETWORKS[chainId]
  if (!net?.nativeCurrency) return null

  const address = net.dex?.wnative || getContractAddressForChain('wmatic', chainId) || null
  if (!address) return null

  return {
    chainId: Number(chainId),
    address,
    symbol: `W${net.nativeCurrency.symbol}`,
    name: `Wrapped ${net.nativeCurrency.name}`,
    // Every WETH9-shaped wrapper mirrors its coin 1:1, and every native coin the app
    // supports is 18-decimal. Read from the config rather than assuming 18 outright so
    // a future non-18 native does not silently mis-scale amounts.
    decimals: net.nativeCurrency.decimals ?? 18,
  }
}

/** Whether this network has a wrapped native coin the app can wrap into. */
export function hasWrappedNative(chainId) {
  return getWrappedNative(chainId) !== null
}

/**
 * Every coin the Wrap surface may offer (spec 108) — one option per cohort chain with a
 * configured wrapper, in SelectableAsset shape (spec 064) so `UniversalAssetSelect`
 * renders it directly.
 *
 * This lives HERE, beside the resolver, on purpose: the file that owns "what is the
 * wrapped form of this chain's coin?" also owns "which coins are offered", so a chain
 * can never be wrappable in the picker and unresolvable at submit. The list is
 * cohort-scoped (`cohortChainIds()`, never `listSupportedChainIds()` — constitution III
 * forbids reads crossing the testnet/mainnet boundary) and a chain with no configured
 * wrapper is ABSENT, not a disabled row: there is no address to disable honestly.
 *
 * @returns {Array<{ key: string, chainId: number, kind: 'native', symbol: string,
 *   name: string, networkName: string, decimals: number,
 *   wrapped: { chainId: number, address: string, symbol: string, name: string, decimals: number } }>}
 */
export function listWrappableCoins() {
  const out = []
  for (const chainId of cohortChainIds()) {
    const wrapped = getWrappedNative(chainId)
    if (!wrapped) continue
    const net = NETWORKS[chainId]
    out.push({
      key: `native:${chainId}`,
      chainId: Number(chainId),
      kind: 'native',
      symbol: net.nativeCurrency.symbol,
      name: net.nativeCurrency.name,
      networkName: net.name,
      decimals: net.nativeCurrency.decimals ?? 18,
      wrapped,
    })
  }
  return out
}

export default getWrappedNative
