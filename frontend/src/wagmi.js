import { createConfig, createConnector, http } from 'wagmi'
import { fallback } from 'viem'
import { arbitrum, base, mainnet, optimism, sepolia } from 'wagmi/chains'
import { injected, walletConnect } from 'wagmi/connectors'
import { passkeyConnector } from './connectors/passkey'
import { resolveRpcEndpoints } from './lib/network/rpcEndpoints'
import { issuedFetchFor } from './lib/network/issuedAccess'
import { tenantBrand } from './config/tenant'

// Define Hoodi — Ethereum's long-lived proof-of-stake testnet (spec 048). Not a
// wagmi/chains built-in, so declared inline like the ETC-family chains. RPC/explorer
// defaults mirror config/networks.js (single-source consistency).
const hoodi = {
  id: 560048,
  name: 'Hoodi',
  nativeCurrency: {
    decimals: 18,
    name: 'Hoodi Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: ['https://ethereum-hoodi-rpc.publicnode.com'] },
    public: { http: ['https://ethereum-hoodi-rpc.publicnode.com'] },
  },
  blockExplorers: {
    default: { name: 'Etherscan', url: 'https://hoodi.etherscan.io' },
  },
  testnet: true,
}

// Define Ethereum Classic mainnet
const ethereumClassic = {
  id: 61,
  name: 'Ethereum Classic',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETC',
  },
  // Chain metadata, not the read route — `transportFor` resolves that through
  // `resolveRpcEndpoints` (spec 069). It still matters: this is the URL a wallet is handed
  // on `wallet_addEthereumChain`. It said `etc.rivet.link`, which no longer resolves at all.
  rpcUrls: {
    default: { http: ['https://etc.etcdesktop.com'] },
    public: { http: ['https://etc.etcdesktop.com'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://etc.blockscout.com' },
  },
  testnet: false,
}

// Define Mordor testnet
const mordor = {
  id: 63,
  name: 'Mordor',
  nativeCurrency: {
    decimals: 18,
    name: 'Mordor Ether',
    symbol: 'METC',
  },
  rpcUrls: {
    default: { http: ['https://rpc.mordor.etccooperative.org'] },
    public: { http: ['https://rpc.mordor.etccooperative.org'] },
  },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://etc-mordor.blockscout.com' },
  },
  testnet: true,
}

// Define Polygon Amoy testnet
const amoy = {
  id: 80002,
  name: 'Polygon Amoy',
  nativeCurrency: {
    decimals: 18,
    name: 'POL',
    symbol: 'POL',
  },
  rpcUrls: {
    // Mirrors config/networks.js (the build default): Polygon's own Amoy endpoint stopped
    // answering browser reads — see the note there (issue #1458 QA round).
    default: { http: ['https://polygon-amoy-bor-rpc.publicnode.com'] },
    public: { http: ['https://polygon-amoy-bor-rpc.publicnode.com'] },
  },
  blockExplorers: {
    default: { name: 'PolygonScan', url: 'https://amoy.polygonscan.com' },
  },
  testnet: true,
}

// Define Polygon mainnet (for Polymarket integration)
const polygon = {
  id: 137,
  name: 'Polygon',
  nativeCurrency: {
    decimals: 18,
    name: 'POL',
    symbol: 'POL',
  },
  rpcUrls: {
    default: { http: ['https://polygon-bor-rpc.publicnode.com'] },
    public: { http: ['https://polygon-bor-rpc.publicnode.com'] },
  },
  blockExplorers: {
    default: { name: 'PolygonScan', url: 'https://polygonscan.com' },
  },
  testnet: false,
}

// Define Hardhat local network (for development)
const hardhat = {
  id: 1337,
  name: 'Hardhat',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'] },
    public: { http: ['http://127.0.0.1:8545'] },
  },
  testnet: true,
}

// Get network ID from environment or default to Polygon mainnet (primary)
const networkId = import.meta.env.VITE_NETWORK_ID
  ? parseInt(import.meta.env.VITE_NETWORK_ID, 10)
  : 137

// Optional global RPC override. Left undefined when VITE_RPC_URL is unset so
// each chain's transport falls back to its own default rpcUrls (a hardcoded
// Amoy default here would otherwise leak into the Polygon transport).
const rpcUrl = import.meta.env.VITE_RPC_URL || undefined

// Get WalletConnect project ID from environment
// Using a fallback demo project ID if none is provided to ensure WalletConnect option is always available
const walletConnectProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'e7a122e5963ecec9bb2ab09e08bca54f'

// Warn if using fallback project ID (only in development)
if (!import.meta.env.VITE_WALLETCONNECT_PROJECT_ID && import.meta.env.DEV) {
  console.warn(
    'WalletConnect: Using fallback project ID. For production, please set VITE_WALLETCONNECT_PROJECT_ID in your .env file. ' +
    'Get your project ID at https://cloud.walletconnect.com'
  )
}

// Get app URL for WalletConnect metadata
const resolveAppUrl = () => {
  const envUrl = import.meta.env.VITE_APP_URL

  if (envUrl) {
    return envUrl
  }

  // Silently use window.location.origin in production if VITE_APP_URL is not set
  // Only warn in development mode
  if (import.meta.env.DEV) {
    console.warn('VITE_APP_URL is not set. Using window.location.origin as fallback. Set VITE_APP_URL in .env for production deployments.')
  }

  // In development, fall back to the current origin when available
  if (typeof window !== 'undefined' && window.location && window.location.origin) {
    return window.location.origin
  }

  // As a last resort, return the active tenant's canonical URL (spec 072)
  return tenantBrand().appUrl
}

const appUrl = resolveAppUrl()

/**
 * WalletConnect stand-in for Cypress runs ONLY (`window.Cypress`, never true outside a
 * Cypress-driven browser — production and manual `npm run dev` always get the real connector).
 *
 * wagmi calls `connector.setup()` for every registered connector as soon as `config` is
 * constructed below (`@wagmi/core#createConfig`), not lazily on first use. The real
 * `walletConnect()`'s `setup()` eagerly builds a full `@walletconnect/ethereum-provider`
 * `EthereumProvider` — real SignClient/Core bootstrap (crypto key generation, storage, a relay
 * handshake) — on every single page load, whether or not anyone ever picks WalletConnect. That
 * cost is real regardless of network reachability (confirmed empirically: blocking WalletConnect's
 * hosts via Cypress's `blockHosts` did not shorten it), and it was invisible before
 * @walletconnect/ethereum-provider was an installed dependency, since `getProvider()` failed fast
 * on the unresolved import. Once it resolved, that background bootstrap work competes for the
 * event loop against tests that assert on-screen timing (SC-005's sign-in budget, WAL-05's reload
 * budget), tipping already-tight windows into intermittent CI failures.
 *
 * No spec ever exercises a real WalletConnect connection — the only assertion touching this
 * connector (WAL-02) checks that the option is *listed*, never that it *connects* — so a stub
 * that reports the same id/name/type and never does real work is a safe swap for test runs.
 */
function isCypressRun() {
  return typeof window !== 'undefined' && Boolean(window.Cypress)
}

function inertWalletConnectStub() {
  return createConnector(() => ({
    id: 'walletConnect',
    name: 'WalletConnect',
    type: walletConnect.type,
    async setup() {},
    async connect() {
      throw new Error('WalletConnect is stubbed out under Cypress — no spec connects through it.')
    },
    async disconnect() {},
    async getAccounts() {
      return []
    },
    async getChainId() {
      return networkId
    },
    async isAuthorized() {
      return false
    },
    async getProvider() {
      return null
    },
    onAccountsChanged() {},
    onChainChanged() {},
    onDisconnect() {},
  }))
}

/**
 * Transport for one chain, honouring the member's own endpoint (spec 069).
 *
 * Precedence per chain: the member's endpoint (+ their failover, + the build default behind
 * it) → `VITE_RPC_URL` when this is the env-selected chain → the curated default (+ the
 * chain's own `rpcFailoverUrl`, where NETWORKS declares one). A member endpoint, or an
 * unconfigured chain with a declared build failover, yields a viem `fallback` transport so a
 * rate-limited or down provider hands over instead of taking the wallet's chain with it.
 *
 * These are built ONCE at module load. localStorage is synchronous so that is fine, but it
 * also means a member who repoints a network needs a reload before wallet-signed
 * transactions use the new route — which the Network panel states plainly rather than
 * implying an instant switch.
 */
function transportFor(chainId, defaultUrl) {
  const envUrl = networkId === chainId ? rpcUrl : undefined
  const fallbackUrl = envUrl || defaultUrl || undefined
  const route = resolveRpcEndpoints(chainId)

  if (route.source !== 'member' || !route.primary) {
    // Pre-069 behavior when the chain declares no build failover: `http()` with no URL lets
    // viem use the chain's own rpcUrls. Generalized (this task) beyond ETC — every chain whose
    // NETWORKS entry declares `rpcFailoverUrl` now gets it wired in here too, not only through
    // the ethers read path (`utils/rpcProvider.js`), which already honoured it. Without this a
    // member on default settings never saw the failover on wagmi's public client (wallet reads),
    // only on ethers reads — the exact "only ETC is wired for failover" gap.
    const primaryUrl = route.primary?.url || fallbackUrl
    const failoverUrl = route.failover && route.failover.url !== primaryUrl ? route.failover.url : null
    // Issued keyed access on the wagmi rail (spec 107, #1470). Transports are built at module
    // evaluation, before anything can have been minted — so instead of baking a URL that will be
    // stale by first use, the PRIMARY leg gets a per-request fetchFn that consults the issued
    // store on every call: credential live => the request is retargeted to the issued endpoint
    // with the current token attached; otherwise it is exactly fetch to the URL viem resolved.
    // Same properties as the ethers rail's preflight: rotation never rebuilds a transport, and
    // the FAILOVER leg is built plain, so a credential never fans out to a second host and an
    // issued endpoint going dark degrades to the public route mid-request.
    const primary = http(primaryUrl, { fetchFn: issuedFetchFor(chainId) })
    if (failoverUrl) return fallback([primary, http(failoverUrl)])
    return primary
  }

  const options = Object.keys(route.primary.headers).length
    ? { fetchOptions: { headers: route.primary.headers } }
    : undefined
  const transports = [http(route.primary.url, options)]
  if (route.failover) transports.push(http(route.failover.url))
  if (fallbackUrl && fallbackUrl !== route.primary.url && fallbackUrl !== route.failover?.url) {
    transports.push(http(fallbackUrl))
  }
  return fallback(transports)
}

// Define supported chains. Polygon mainnet is first so it is wagmi's own default chain,
// matching the primary network. The app no longer READS that default — `useChainId()` is banned
// (spec 110 Phase 3, #1594) and `useWalletChainId` falls back to the BUILD's `getCurrentChainId()`,
// which differs from `chains[0]` in a testnet build. The Testnet/Mainnet toggle still switches to
// Amoy on demand.
// Exported so config-parity tests can assert every selectable network (config/networks.js)
// is registered here — otherwise switchChain cannot reach it. Polygon stays first (wagmi
// default chain — FR-015).
// Spec 067 adds arbitrum, base and optimism — every `selectable: true` network in
// config/networks.js MUST be registered here or switchChain cannot reach it (there is a
// config-parity test asserting exactly that).
export const chains = [
  polygon,
  amoy,
  ethereumClassic,
  mordor,
  mainnet,
  sepolia,
  hoodi,
  arbitrum,
  base,
  optimism,
  hardhat,
]

// Create wagmi config
export const config = createConfig({
  chains,
  connectors: [
    // Generic injected connector - works with any browser wallet (MetaMask, Coinbase, etc.)
    injected({
      shimDisconnect: true,
    }),
    // WalletConnect is always available for hardware wallet and mobile wallet support.
    // Cypress gets the inert stub above — see its comment for why.
    isCypressRun()
      ? inertWalletConnectStub()
      : walletConnect({
          projectId: walletConnectProjectId,
          metadata: {
            name: tenantBrand().displayName,
            description: tenantBrand().tagline || tenantBrand().displayName,
            url: appUrl,
            icons: [`${appUrl}${tenantBrand().logoMark}`]
          },
          showQrModal: true,
        }),
    // Passkey smart accounts (spec 041) — first-class connector beside the
    // classic wallets; capability-gated per network (FR-001/FR-004).
    passkeyConnector(),
  ],
  transports: {
    [amoy.id]: transportFor(80002, 'https://polygon-amoy-bor-rpc.publicnode.com'),
    [polygon.id]: transportFor(137, 'https://polygon-bor-rpc.publicnode.com'),
    [ethereumClassic.id]: transportFor(61, null),
    [mordor.id]: transportFor(63, 'https://rpc.mordor.etccooperative.org'),
    // Ethereum family (spec 048) — defaults mirror config/networks.js.
    [mainnet.id]: transportFor(1, 'https://ethereum-rpc.publicnode.com'),
    [sepolia.id]: transportFor(11155111, 'https://ethereum-sepolia-rpc.publicnode.com'),
    [hoodi.id]: transportFor(560048, 'https://ethereum-hoodi-rpc.publicnode.com'),
    // Spec 067 bridge/liquidity networks — defaults mirror config/networks.js.
    [arbitrum.id]: transportFor(42161, 'https://arbitrum-one-rpc.publicnode.com'),
    [base.id]: transportFor(8453, 'https://base-rpc.publicnode.com'),
    [optimism.id]: transportFor(10, 'https://optimism-rpc.publicnode.com'),
    [hardhat.id]: http('http://localhost:8545'),
  },
})

// Helper to get expected chain info
export const getExpectedChain = () => {
  switch (networkId) {
    case 137:
      return polygon
    case 80002:
      return amoy
    case 61:
      return ethereumClassic
    case 63:
      return mordor
    case 1:
      return mainnet
    case 11155111:
      return sepolia
    case 560048:
      return hoodi
    case 1337:
      return hardhat
    default:
      return amoy
  }
}

export const EXPECTED_CHAIN_ID = networkId
