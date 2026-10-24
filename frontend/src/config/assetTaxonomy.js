/**
 * Asset Taxonomy Registry (spec 044) — SEC/CFTC-aligned classification of the
 * assets the Portfolio section scans for the connected account.
 *
 * Layered classification, industry-standard for wallet taxonomy filters:
 *   1. `sec-baseline`     — hardcoded baseline derived from the SEC's public
 *                           commodity classifications (major L1/L2 assets);
 *                           applies to native coins and their canonical
 *                           wrapped forms.
 *   2. `curated-registry` — bundled, per-network curated token entries
 *                           (Tokenlists-style data reduced to what the app
 *                           supports), mapped to a category by known issuer
 *                           status / contract behavior.
 *   3. `app-config`       — assets the app already knows from its own config
 *                           and sync artifacts (per-network stablecoin,
 *                           wrapped native, MembershipVoucher credential).
 *
 * Precedence on conflicts: sec-baseline > curated-registry > app-config
 * (FR-006). The registry is pure config — no chain reads — and strictly
 * per-network: entries never leak across chains (FR-007, constitution III).
 *
 * Discovery is registry-driven: the portfolio only scans assets listed here,
 * and the UI discloses that limitation (FR-013). Classifications are
 * informational, not legal or investment advice.
 */
import { NETWORKS } from './networks'
import { getContractAddressForChain } from './contracts'
import { getBitcoinNetwork } from './bitcoinNetworks'
import { getWrappedNative } from './wrappedNative'

// The five app-aligned regulatory categories (FR-004) plus the honest
// `unclassified` fallback (FR-012). Order is display order.
export const TAXONOMY_CATEGORIES = [
  {
    id: 'digital-commodities',
    label: 'Digital Commodities',
    order: 1,
    description:
      'Crypto assets intrinsically linked to, and deriving value from, the programmatic ' +
      'operation of an already functional decentralized system and general supply/demand ' +
      'dynamics — not the active managerial efforts of a core team. The SEC categorized ' +
      'major layer-1 and layer-2 assets here (e.g. Bitcoin, Ether, Solana, XRP).',
  },
  {
    id: 'digital-securities',
    label: 'Digital Securities',
    order: 2,
    description:
      'Tokens that represent an on-chain format of traditional financial instruments ' +
      '(equity, debt, or structured investments) or possess the economic characteristics ' +
      'of an investment contract. Fully subject to standard securities registration and ' +
      'compliance obligations.',
  },
  {
    id: 'payment-stablecoins',
    label: 'Payment Stablecoins',
    order: 3,
    description:
      'Stablecoins issued by an approved issuer under the scope of federal banking ' +
      'guidelines (such as the GENIUS Act framework), structurally isolated from being ' +
      'treated as securities when utilized as transactional payment instruments.',
  },
  {
    id: 'digital-tools',
    label: 'Digital Tools',
    order: 4,
    description:
      'Utility tokens that carry no intrinsic economic yield or capital-raising function ' +
      'but perform a distinct, practical function on an application or protocol — identity ' +
      'badges, name-service domains, or network credentials.',
  },
  {
    id: 'digital-collectibles',
    label: 'Digital Collectibles',
    order: 5,
    description:
      'Assets intended for collection, consumer use, or artistic media rights — typically ' +
      'non-fungible tokens representing artwork, music, and in-game items, provided they ' +
      'carry no profit-sharing characteristics.',
  },
  {
    id: 'unclassified',
    label: 'Unclassified',
    order: 6,
    description:
      'Assets the app knows about but cannot map to a regulatory category. Shown here ' +
      'rather than hidden, so the portfolio never silently omits a holding.',
  },
]

// Classification sources, highest precedence first (FR-006).
export const CLASSIFICATION_SOURCES = ['sec-baseline', 'curated-registry', 'app-config']

// Symbol-level baseline derived from the SEC's public commodity
// classifications (major L1/L2 assets named by the SEC: BTC, ETH, SOL, XRP)
// plus the gas assets of the networks this app runs on (POL and ETC), which
// sit in the same functional-network bucket. MATIC stays listed as POL's
// pre-migration legacy ticker: historical ledger/report entries and the
// still-live MATIC ERC-20 carry it, and its classification is unchanged.
// Wrapped forms inherit the underlying symbol's classification via
// `baselineSymbol`.
export const SEC_COMMODITY_BASELINE = ['BTC', 'ETH', 'SOL', 'XRP', 'MATIC', 'POL', 'ETC']

const BASELINE_SET = new Set(SEC_COMMODITY_BASELINE)

/**
 * Display metadata per underlying asset symbol (spec 044 v1.2). `homeChainId`
 * is the canonical mainnet whose NATIVE coin the symbol is — a native
 * instance on that chain renders its logo without a network badge (FR-026);
 * every other instance (wrapped, bridged, testnet) carries the hosting
 * network's badge. `homeNetwork` is the non-EVM equivalent (spec 061): a
 * string id from bitcoinNetworks.js for underlyings whose home chain is not
 * an EVM network.
 */
export const UNDERLYING_META = {
  ETH: { name: 'Ethereum', homeChainId: 1 },
  BTC: { name: 'Bitcoin', homeChainId: null, homeNetwork: 'bitcoin' },
  // MATIC is POL's legacy ticker (pre-migration Polygon gas token / the old
  // ERC-20) — kept so historical entries and un-migrated balances still render
  // with the Polygon identity. Nothing in current config emits it.
  MATIC: { name: 'Polygon', homeChainId: 137 },
  POL: { name: 'Polygon', homeChainId: 137 },
  ETC: { name: 'Ethereum Classic', homeChainId: 61 },
  SOL: { name: 'Solana', homeChainId: null },
  XRP: { name: 'XRP', homeChainId: null },
  LINK: { name: 'Chainlink', homeChainId: null },
  USDC: { name: 'USD Coin', homeChainId: null },
  USDT: { name: 'Tether USD', homeChainId: null },
  DAI: { name: 'Dai Stablecoin', homeChainId: null },
  USC: { name: 'Classic USD', homeChainId: null },
  FWMV: { name: 'FairWins Membership Voucher', homeChainId: null },
  GRT: { name: 'The Graph', homeChainId: null },
  ENS: { name: 'Ethereum Name Service', homeChainId: null },
  BAT: { name: 'Basic Attention Token', homeChainId: null },
  UNI: { name: 'Uniswap', homeChainId: null },
  AAVE: { name: 'Aave', homeChainId: null },
  MORPHO: { name: 'Morpho', homeChainId: null },
  PYUSD: { name: 'PayPal USD', homeChainId: null },
  FIDD: { name: 'Fidelity Digital Dollar', homeChainId: null },
  // Staking derivatives (spec 065). Liquid staking tokens held as positions.
  WSTETH: { name: 'Lido Wrapped Staked ETH', homeChainId: 1 },
  SPOL: { name: 'Polygon Staked POL', homeChainId: 1 },
}

export function getUnderlyingMeta(symbol) {
  const key = (symbol || '').toUpperCase()
  return UNDERLYING_META[key] || { name: key, homeChainId: null }
}

// Curated per-network token entries. Canonical, well-known deployments only —
// the same convention as the canonical Uniswap addresses in networks.js.
// `baselineSymbol` marks a token as the wrapped form of an SEC-baseline
// commodity (upgrades its source to sec-baseline).
const CURATED_REGISTRY = {
  1: [
    {
      // Canonical WETH9 on Ethereum mainnet. Chain 1 has no dex config or
      // wmatic deployment record, so without this curated entry the wrapped
      // form of the chain's own baseline commodity would never be scanned.
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      categoryId: 'digital-commodities',
      baselineSymbol: 'ETH',
    },
    {
      // Lido wstETH (spec 065) — the liquid staking token members hold after
      // staking ETH via Lido. Value-accruing yield derivative.
      address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0',
      symbol: 'wstETH',
      name: 'Lido Wrapped Staked ETH',
      decimals: 18,
      categoryId: 'digital-securities',
    },
    {
      // Polygon sPOL (spec 065) — Polygon's official native liquid staking
      // token, minted on L1 after staking POL. Value-accruing.
      address: '0x3B790d651e950497c7723D47B24E6f61534f7969',
      symbol: 'sPOL',
      name: 'Polygon Staked POL',
      decimals: 18,
      categoryId: 'digital-securities',
    },
    {
      // POL on Ethereum L1 (spec 065) — the staking token for Polygon
      // delegation and sPOL. Verify against VITE_POL_TOKEN_L1 at build time.
      address: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6',
      symbol: 'POL',
      name: 'Polygon',
      decimals: 18,
      categoryId: 'digital-commodities',
    },
    {
      // Tether USD on Ethereum mainnet — transactional stablecoin by known issuer
      // (spec 048). Valued at par $1. USDC arrives via the network `stablecoin`.
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      categoryId: 'payment-stablecoins',
    },
    {
      // Dai on Ethereum mainnet — decentralized stablecoin, valued at par $1 (spec 048).
      address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      categoryId: 'payment-stablecoins',
    },
    {
      // Wrapped Bitcoin on Ethereum mainnet — canonical custodial-wrapped BTC.
      address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
      symbol: 'WBTC',
      name: 'Wrapped BTC',
      decimals: 8,
      categoryId: 'digital-commodities',
      baselineSymbol: 'BTC',
    },
    {
      // Chainlink token on Ethereum mainnet — protocol utility (oracle payment),
      // no yield/capital-raising function.
      address: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
      symbol: 'LINK',
      name: 'ChainLink Token',
      decimals: 18,
      categoryId: 'digital-tools',
    },
    {
      // The Graph — indexing-protocol utility token (query fees/curation), no
      // capital-raising function.
      address: '0xc944E90C64B2c07662A292be6244BDf05Cda44a7',
      symbol: 'GRT',
      name: 'Graph Token',
      decimals: 18,
      categoryId: 'digital-tools',
    },
    {
      // ENS DAO governance token — ties to name-service domain identity, the
      // Digital Tools category's textbook case.
      address: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72',
      symbol: 'ENS',
      name: 'Ethereum Name Service',
      decimals: 18,
      categoryId: 'digital-tools',
    },
    {
      // Basic Attention Token — Brave browser attention/ad utility token.
      address: '0x0D8775F648430679A709E98d2b0Cb6250d2887EF',
      symbol: 'BAT',
      name: 'Basic Attention Token',
      decimals: 18,
      categoryId: 'digital-tools',
    },
    {
      // Uniswap governance token — vote-weight/fee-switch characteristics of
      // an investment contract.
      address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
      symbol: 'UNI',
      name: 'Uniswap',
      decimals: 18,
      categoryId: 'digital-securities',
    },
    {
      // Aave governance token — vote-weight plus a Safety Module staking
      // program; investment-contract characteristics.
      address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9',
      symbol: 'AAVE',
      name: 'Aave Token',
      decimals: 18,
      categoryId: 'digital-securities',
    },
    {
      // Morpho governance token — vote-weight over protocol/fee parameters;
      // investment-contract characteristics. No Polygon deployment of the
      // governance token exists (Morpho's multichain "infrastructure mode"
      // deploys the lending stack, not this token) — mainnet only.
      address: '0x58D97B57BB95320F9a05dC918Aef65434969c2B2',
      symbol: 'MORPHO',
      name: 'Morpho Token',
      decimals: 18,
      categoryId: 'digital-securities',
    },
    {
      // PayPal USD — transactional stablecoin by known issuer (PayPal/Paxos).
      // Ethereum only; not deployed on Polygon.
      address: '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8',
      symbol: 'PYUSD',
      name: 'PayPal USD',
      decimals: 6,
      categoryId: 'payment-stablecoins',
    },
    {
      // Fidelity Digital Dollar — transactional stablecoin by known issuer
      // (Fidelity Digital Assets, launched Feb 2026). Address sourced from
      // Etherscan at add-time; re-verify on-chain before relying on it, the
      // same convention as networks.js's Mordor-address caveat.
      address: '0x7C135549504245B5eAe64fc0E99Fa5ebabb8e35D',
      symbol: 'FIDD',
      name: 'Fidelity Digital Dollar',
      decimals: 18,
      categoryId: 'payment-stablecoins',
    },
  ],
  137: [
    {
      // Canonical Wrapped Ether on Polygon PoS (Polygon canonical bridge).
      address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      categoryId: 'digital-commodities',
      baselineSymbol: 'ETH',
    },
    {
      // Canonical Wrapped BTC on Polygon PoS.
      address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
      symbol: 'WBTC',
      name: 'Wrapped BTC',
      decimals: 8,
      categoryId: 'digital-commodities',
      baselineSymbol: 'BTC',
    },
    {
      // Chainlink token on Polygon PoS — protocol utility (oracle payment),
      // no yield/capital-raising function.
      address: '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
      symbol: 'LINK',
      name: 'ChainLink Token',
      decimals: 18,
      categoryId: 'digital-tools',
    },
    {
      // Tether USD on Polygon PoS — transactional stablecoin by known issuer.
      address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      categoryId: 'payment-stablecoins',
    },
    {
      // The Graph on Polygon PoS (official PoS-bridge child token).
      address: '0xaa35915966E20B94Fb131b8fFfd8799518827c32',
      symbol: 'GRT',
      name: 'Graph Token',
      decimals: 18,
      categoryId: 'digital-tools',
    },
    {
      // Basic Attention Token on Polygon PoS.
      address: '0x3Cef98bb43d732E2F285eE605a8158cDE967D219',
      symbol: 'BAT',
      name: 'Basic Attention Token',
      decimals: 18,
      categoryId: 'digital-tools',
    },
    {
      // Uniswap governance token on Polygon PoS (bridged).
      address: '0xb33eaad8d922b1083446dc23f610c2567fb5180f',
      symbol: 'UNI',
      name: 'Uniswap',
      decimals: 18,
      categoryId: 'digital-securities',
    },
    {
      // Aave governance token on Polygon PoS (bridged).
      address: '0xD6DF932A45C0f255f85145f286eA0b292B21C90B',
      symbol: 'AAVE',
      name: 'Aave Token',
      decimals: 18,
      categoryId: 'digital-securities',
    },
  ],
}

function normalizeAddress(address) {
  return typeof address === 'string' ? address.toLowerCase() : address
}

// Local-only sandboxes are never part of the portfolio scan.
const LOCAL_CHAIN_IDS = new Set([1337])

/**
 * The chains the cross-chain portfolio scans (spec 044 follow-up): every
 * configured network except local sandboxes, mainnets first. Testnets are
 * included only when the member has opted in via the "show testnet assets"
 * preference.
 */
export function getPortfolioChainIds({ includeTestnets = false } = {}) {
  return Object.values(NETWORKS)
    .filter((net) => !LOCAL_CHAIN_IDS.has(net.chainId))
    .filter((net) => includeTestnets || !net.isTestnet)
    .sort((a, b) => Number(a.isTestnet) - Number(b.isTestnet))
    .map((net) => net.chainId)
}

/**
 * The taxonomy category for `categoryId`, falling back to the `unclassified`
 * category (never undefined) so display code can always render a group.
 */
export function getTaxonomyCategory(categoryId) {
  return (
    TAXONOMY_CATEGORIES.find((c) => c.id === categoryId) ||
    TAXONOMY_CATEGORIES.find((c) => c.id === 'unclassified')
  )
}

// Apply the SEC baseline on top of an entry's own classification: a native
// coin or wrapped form whose underlying symbol sits on the baseline is a
// Digital Commodity from the highest-precedence source, whatever the lower
// layers said (FR-006).
function withBaseline(entry) {
  const underlying = (entry.baselineSymbol || entry.symbol || '').toUpperCase()
  if ((entry.kind === 'native' || entry.baselineSymbol) && BASELINE_SET.has(underlying)) {
    return { ...entry, categoryId: 'digital-commodities', source: 'sec-baseline' }
  }
  return entry
}

/**
 * Build the scannable asset registry for one network (FR-005/006/007).
 *
 * Pure function of bundled config — no chain reads, no async. Returns [] for
 * unknown chains, which drives the honest "unavailable on this network" state
 * (FR-014). Every returned entry carries the queried chainId; entries whose
 * address cannot be resolved from config are omitted, never emitted empty.
 */
export function getPortfolioRegistry(chainId) {
  const net = NETWORKS[chainId]
  if (!net) return []

  // Assembled lowest-precedence first; later same-address inserts overwrite.
  const byId = new Map()
  const put = (entry) => {
    if (entry.kind !== 'native' && !entry.address) return
    const id = entry.kind === 'native' ? 'native' : normalizeAddress(entry.address)
    byId.set(id, withBaseline({ ...entry, id, chainId, address: entry.address || null }))
  }

  // --- app-config layer ---------------------------------------------------
  // Native coin. All currently supported natives (POL, ETC, ETH) sit on the
  // SEC baseline; withBaseline handles any future non-baseline native by
  // leaving it unclassified rather than guessing (FR-012).
  put({
    kind: 'native',
    symbol: net.nativeCurrency.symbol,
    name: net.nativeCurrency.name,
    decimals: net.nativeCurrency.decimals,
    categoryId: 'unclassified',
    source: 'app-config',
    baselineSymbol: net.nativeCurrency.symbol,
  })

  // Wrapped native — resolved through the shared seam (config/wrappedNative.js), which
  // reads the network's DEX config first and falls back to the synced per-chain
  // deployment record. The Wrap view resolves the same way, so a chain is never
  // wrappable on one surface and missing from the portfolio on another.
  const wrapped = getWrappedNative(chainId)
  if (wrapped) {
    put({
      kind: 'erc20',
      address: wrapped.address,
      symbol: wrapped.symbol,
      name: wrapped.name,
      decimals: wrapped.decimals,
      categoryId: 'unclassified',
      source: 'app-config',
      baselineSymbol: net.nativeCurrency.symbol,
    })
  }

  // The network's configured stablecoin — known issuer status via app config.
  if (net.stablecoin?.address) {
    put({
      kind: 'erc20',
      address: net.stablecoin.address,
      symbol: net.stablecoin.symbol,
      name: net.stablecoin.name,
      decimals: net.stablecoin.decimals,
      categoryId: 'payment-stablecoins',
      source: 'app-config',
    })
  }

  // MembershipVoucher (ERC-721) — an app-issued network credential, the
  // textbook Digital Tools case. Rendered as an item count (FR-011).
  const voucher = getContractAddressForChain('membershipVoucher', chainId)
  if (voucher) {
    put({
      kind: 'nft',
      address: voucher,
      symbol: 'FWMV',
      name: 'FairWins Membership Voucher',
      decimals: null,
      categoryId: 'digital-tools',
      source: 'app-config',
    })
  }

  // --- curated-registry layer (overwrites app-config on the same address) --
  for (const token of CURATED_REGISTRY[chainId] || []) {
    put({ kind: 'erc20', categoryId: 'unclassified', ...token, source: 'curated-registry' })
  }

  return Array.from(byId.values())
}

/**
 * Native-Bitcoin portfolio asset for a non-EVM bitcoin network (spec 061,
 * FR-008). Not part of getPortfolioRegistry — that registry is keyed by EVM
 * chainId and scanned via RPC; the bitcoin balance source in usePortfolio
 * feeds this descriptor instead. It aggregates with WBTC under the single
 * `BTC` underlying via the existing baseline roll-up, and prices through the
 * already-configured BTC/USD feeds (priceFeeds.js, key `BTC`).
 *
 * Returns null for non-bitcoin ids (soft-fail, mirrors getPortfolioRegistry's
 * empty-registry behavior for unknown chains).
 */
export function getBitcoinPortfolioAsset(networkId) {
  const net = getBitcoinNetwork(networkId)
  if (!net) return null
  return {
    id: 'btc-native',
    // String network id in the chainId slot — consumers on the bitcoin path
    // are guarded by isBitcoinNetworkId and never pass this to EVM code.
    chainId: net.id,
    kind: 'native',
    symbol: 'BTC',
    name: net.isTestnet ? 'Bitcoin (Testnet)' : 'Bitcoin',
    decimals: 8,
    categoryId: 'digital-commodities',
    source: 'sec-baseline',
    baselineSymbol: 'BTC',
  }
}
