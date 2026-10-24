import { useState } from 'react'
import { useSwitchChain } from 'wagmi'
import { useNavigate } from 'react-router-dom'
import { getSelectableNetworks, getNetwork } from '../../config/networks'
import { getNetworkFeatures } from '../../config/networkCapabilities'
import {
  BITCOIN_NETWORKS,
  getActiveBitcoinNetworkId,
  isBitcoinNetworkId,
} from '../../config/bitcoinNetworks'
import { useRpcEndpoints } from '../../hooks/useRpcEndpoints'
import { useWalletChainId } from '../../hooks/useWalletChainId'
import NetworkEndpointForm from './NetworkEndpointForm'
import './NetworkPanel.css'

/**
 * Bitcoin capability tags (spec 061, FR-020) — resolved from the non-EVM
 * registry's `capabilities`, the single source of truth for what Bitcoin
 * supports. `collect: 'stamps-only'` is truthy: the Stamps section without
 * OpenSea integration.
 */
const BITCOIN_FEATURE_TAGS = [
  { key: 'portfolio', label: 'Portfolio', description: 'Native BTC balance in the portfolio.' },
  { key: 'send', label: 'Send', description: 'Send BTC to any standard Bitcoin address.' },
  { key: 'receive', label: 'Receive', description: 'Receive BTC via rotating addresses.' },
  { key: 'collect', label: 'Stamps collectibles', description: 'Bitcoin Stamps shown in Collect (no OpenSea integration).' },
  { key: 'wagers', label: 'P2P Wagers', description: 'Create and settle peer-to-peer wagers.' },
  { key: 'pools', label: 'Wager Pools', description: 'Group wager pools.' },
  { key: 'membership', label: 'Memberships', description: 'On-chain membership tiers and access roles.' },
  { key: 'gasless', label: 'Gasless', description: 'Fee-sponsored transactions. Bitcoin sends always pay the network fee.' },
  { key: 'swap', label: 'Token Swap', description: 'In-app token swaps.' },
  { key: 'earn', label: 'Earn', description: 'In-app lending and yield.' },
  { key: 'predict', label: 'Predict', description: 'Polymarket prediction-market trading.' },
]

/**
 * Bitcoin network card (spec 061 T033, first-class since release 1.14.0 task 13).
 *
 * Bitcoin is a non-EVM network: there is NO wagmi chain switch for it
 * (network-registry rule 2), and its string id must never reach an EVM seam.
 * The card for the app's current testnet/mainnet mode (`actionable`) carries a
 * "Use <network>" action that deep-links to the Bitcoin wallet surface —
 * Transfer, where the BTC asset's send/receive/balance live — which is exactly
 * how the Bitcoin surfaces have always activated (per feature, never by
 * mutating a global chain id). The pair's other side renders display-only so
 * only ONE Bitcoin network is ever offered (constitution III: the active
 * Bitcoin network mirrors the EVM testnet/mainnet mode, FR-021). Capability
 * tags state truthfully what is and is not supported (FR-020).
 */
function BitcoinNetworkCard({ net, actionable = false, onOpen }) {
  return (
    <li className={`network-card ${actionable ? '' : 'network-card-display-only'}`}>
      <div className="network-card-header">
        <div className="network-card-title">
          <span className="network-name">{net.name}</span>
          <span className={`network-kind ${net.isTestnet ? 'testnet' : 'mainnet'}`}>
            {net.isTestnet ? 'Testnet' : 'Mainnet'}
          </span>
        </div>
        {actionable ? (
          <button
            type="button"
            className="network-switch-btn"
            onClick={onOpen}
            aria-label={`Use ${net.name}`}
          >
            {`Use ${net.name}`}
          </button>
        ) : (
          <span className="network-active-badge network-display-only-badge">No wallet switch</span>
        )}
      </div>

      <ul className="network-feature-tags">
        {BITCOIN_FEATURE_TAGS.map((feature) => {
          const supported = Boolean(net.capabilities?.[feature.key])
          return (
            <li
              key={feature.key}
              className={`network-tag ${supported ? 'available' : 'unavailable'}`}
              title={`${feature.description} ${supported ? '(Supported)' : '(Not supported on Bitcoin)'}`}
            >
              <span className="network-tag-icon" aria-hidden="true">
                {supported ? '✓' : '—'}
              </span>
              <span className="network-tag-label">{feature.label}</span>
            </li>
          )
        })}
      </ul>

      <dl className="network-docs">
        <div className="network-doc-row">
          <dt>Native currency</dt>
          <dd>BTC (Bitcoin)</dd>
        </div>
        {net.explorer?.baseUrl && (
          <div className="network-doc-row">
            <dt>Explorer</dt>
            <dd>
              <a href={net.explorer.baseUrl} target="_blank" rel="noopener noreferrer">
                {net.explorer.name || 'Block explorer'}
              </a>
            </dd>
          </div>
        )}
        <div className="network-doc-row">
          <dt>Wallet</dt>
          <dd>Requires a FairWins passkey on a PRF-capable device.</dd>
        </div>
      </dl>

      <p className="network-display-only-note">
        {actionable
          ? 'Bitcoin has no wallet network switch — "Use" opens the wallet\'s Transfer surface, ' +
            'where Bitcoin send, receive and balances live. Members always pay the Bitcoin network fee.'
          : 'Bitcoin has no wallet network switch — it activates per feature (portfolio, send, ' +
            'receive). Members always pay the Bitcoin network fee.'}
      </p>
    </li>
  )
}

/**
 * NetworkPanel
 *
 * Network settings, reached from the account button beside Settings (spec 069 — it used
 * to be a Tools section, which no longer fits: FairWins reads every supported network at
 * once, so "which network am I on" is a per-transaction detail, not a place you go).
 *
 * The panel does two things:
 *
 *   1. Documents each network and its capabilities, and offers a wallet switch. The switch
 *      is deliberately framed as optional — assets carry their own chainId and reads fan out
 *      across chains regardless of the connected one, so a member only needs to switch when
 *      they SEND on a network their wallet is not currently on (and the sending surfaces
 *      prompt for that themselves).
 *   2. Lets the member own the route: their own RPC endpoint, a failover behind it, and any
 *      API key their provider needs, per network (`NetworkEndpointForm`). Every read in the
 *      app resolves through those settings (lib/network/rpcEndpoints).
 */
function NetworkPanel() {
  // The wallet's own chain (issue #1030). With `useChainId()` this list badged a network the
  // member was NOT on as "Connected" — and, worse, hid that network's "Switch" button, which is
  // the one control that would have got them there.
  const chainId = useWalletChainId()
  const { switchChain, isPending, variables, error } = useSwitchChain()
  const navigate = useNavigate()
  const networks = getSelectableNetworks()
  // The one Bitcoin network this build/mode may offer (task 13): the active
  // Bitcoin network mirrors the app's EVM testnet/mainnet mode (spec 061
  // FR-021 — the exact seam useBitcoinWallet resolves with), which at rest is
  // the build's cohort. Never both sides of the pair (constitution III).
  const activeBitcoinId = getActiveBitcoinNetworkId(Boolean(getNetwork(chainId)?.isTestnet))
  const openBitcoin = (id) => {
    // Type guard at the boundary: a Bitcoin string id activates its own
    // surface by navigation and must never fall through to wagmi switchChain.
    if (!isBitcoinNetworkId(id)) return
    navigate('/wallet?tab=paytransfer')
  }
  const pendingChainId = isPending ? variables?.chainId : null
  const { entryFor, describe, save, reset, probe, reloadRecommended } = useRpcEndpoints()
  const [editingChainId, setEditingChainId] = useState(null)

  return (
    <div className="network-settings" role="tabpanel">
      <div className="section">
        <h3>Network</h3>
        {/* The tags and the endpoint rows below explain themselves; what a member cannot see from
            the list is the one surprising fact — that they rarely need to switch at all. */}
        <p className="section-description">
          Your assets carry their own network, so you only need to switch when sending on one your
          wallet is not already on.
        </p>

        {reloadRecommended && (
          <p className="network-reload-note" role="status">
            Endpoint changes apply to new lookups right away. Reload the app so wallet
            transactions use them too.
          </p>
        )}

        {error && (
          <div className="key-error" role="alert">
            {error.shortMessage || error.message || 'Failed to switch network.'}
          </div>
        )}

        <ul className="network-card-list">
          {networks.map((net) => {
            const isActive = net.chainId === chainId
            const features = getNetworkFeatures(net.chainId)
            const switching = pendingChainId === net.chainId
            // Both are read during render, so a save (which re-renders through the store
            // subscription) immediately re-describes the route.
            const route = describe(net.chainId)
            const entry = entryFor(net.chainId)
            const editing = editingChainId === net.chainId
            return (
              <li
                key={net.chainId}
                className={`network-card ${isActive ? 'active' : ''}`}
              >
                <div className="network-card-header">
                  <div className="network-card-title">
                    <span className="network-name">{net.name}</span>
                    <span
                      className={`network-kind ${net.isTestnet ? 'testnet' : 'mainnet'}`}
                    >
                      {net.isTestnet ? 'Testnet' : 'Mainnet'}
                    </span>
                  </div>
                  {isActive ? (
                    <span className="network-active-badge">Connected</span>
                  ) : (
                    <button
                      type="button"
                      className="network-switch-btn"
                      onClick={() => switchChain({ chainId: net.chainId })}
                      disabled={isPending}
                      aria-label={`Switch to ${net.name}`}
                    >
                      {switching ? 'Switching…' : 'Switch'}
                    </button>
                  )}
                </div>

                <ul className="network-feature-tags">
                  {features.map((feature) => (
                    <li
                      key={feature.key}
                      className={`network-tag ${feature.deployed ? 'available' : 'unavailable'}`}
                      title={`${feature.description} ${feature.deployed ? '(Deployed)' : '(Not deployed)'}`}
                    >
                      <span className="network-tag-icon" aria-hidden="true">
                        {feature.deployed ? '✓' : '—'}
                      </span>
                      <span className="network-tag-label">{feature.label}</span>
                    </li>
                  ))}
                </ul>

                <dl className="network-docs">
                  <div className="network-doc-row">
                    <dt>Native currency</dt>
                    <dd>
                      {net.nativeCurrency?.symbol}
                      {net.nativeCurrency?.name ? ` (${net.nativeCurrency.name})` : ''}
                    </dd>
                  </div>
                  {net.stablecoin && (
                    <div className="network-doc-row">
                      <dt>Stablecoin</dt>
                      <dd>
                        {net.stablecoin.name} ({net.stablecoin.symbol})
                      </dd>
                    </div>
                  )}
                  {net.explorer?.baseUrl && (
                    <div className="network-doc-row">
                      <dt>Explorer</dt>
                      <dd>
                        <a
                          href={net.explorer.baseUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {net.explorer.name || 'Block explorer'}
                        </a>
                      </dd>
                    </div>
                  )}
                  {net.isTestnet && net.resources?.faucet && (
                    <div className="network-doc-row">
                      <dt>Faucet</dt>
                      <dd>
                        <a
                          href={net.resources.faucet}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {`Get test ${net.nativeCurrency?.symbol || 'tokens'}`}
                        </a>
                      </dd>
                    </div>
                  )}
                  {net.capabilities?.dex && net.dexProvider?.url && (
                    <div className="network-doc-row">
                      <dt>Swap</dt>
                      <dd>
                        <a
                          href={net.dexProvider.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {`Open ${net.dexProvider.name} ↗`}
                        </a>
                      </dd>
                    </div>
                  )}
                </dl>

                {/* Endpoint row: which route this network's reads actually take, always
                    redacted (a provider URL routinely carries the API key in its path). */}
                <div className="network-endpoint-row">
                  <div className="network-endpoint-summary">
                    <span className={`network-endpoint-source ${route.source}`}>
                      {route.source === 'member' ? 'Your endpoint' : 'App default'}
                    </span>
                    <span className="network-endpoint-url">{route.primary || 'No endpoint configured'}</span>
                    {route.failover && (
                      <span className="network-endpoint-failover">failover {route.failover}</span>
                    )}
                    {route.hasAuth && <span className="network-endpoint-auth-badge">API key</span>}
                  </div>
                  <button
                    type="button"
                    className="network-endpoint-edit-btn"
                    onClick={() => setEditingChainId(editing ? null : net.chainId)}
                    aria-expanded={editing}
                    aria-label={`${editing ? 'Close' : 'Edit'} ${net.name} endpoints`}
                  >
                    {editing ? 'Close' : 'Edit endpoints'}
                  </button>
                </div>

                {editing && (
                  <NetworkEndpointForm
                    network={net}
                    entry={entry}
                    onSave={(next) => save(net.chainId, next)}
                    onReset={() => reset(net.chainId)}
                    onProbe={(next) => probe(net.chainId, next)}
                    onCancel={() => setEditingChainId(null)}
                  />
                )}
              </li>
            )
          })}
          {/* Non-EVM networks (spec 061 + task 13). The EVM list always includes
              testnets and the Bitcoin pair mirrors that for documentation — but
              only the side matching the app's current testnet/mainnet mode is
              offered for use; the other stays display-only. */}
          {Object.values(BITCOIN_NETWORKS)
            .sort((a, b) => Number(a.isTestnet) - Number(b.isTestnet))
            .map((net) => (
              <BitcoinNetworkCard
                key={net.id}
                net={net}
                actionable={net.id === activeBitcoinId}
                onOpen={() => openBitcoin(net.id)}
              />
            ))}
        </ul>
      </div>
    </div>
  )
}

export default NetworkPanel
