/**
 * Per-chain configuration for the FairWins app.
 *
 * Single source of truth for chain metadata, contract addresses, stablecoin
 * info, DEX deployments, explorer URLs, and per-chain capabilities. Other
 * config (wagmi.js, contracts.js, blockExplorer.js, dex.js) derives from
 * this map.
 *
 * Supported chains:
 *   - Polygon Mainnet (137) — PRIMARY / production default. Canonical Uniswap
 *     V3 deployment; live v2 wager contracts.
 *   - Polygon Amoy (80002) — testnet. Co-locates with Polymarket's CTF for
 *     settle-by-reference; community Uniswap V3 contracts may be plugged in via
 *     VITE_AMOY_UNISWAP_* env vars.
 *   - Ethereum Classic (61) + Mordor (63) — ETCswap V3 swap surface + ClearPath
 *     (specs 033 / 042).
 *   - Ethereum family (spec 048) — value networks for select + portfolio +
 *     send/receive: Ethereum Mainnet (1, also ClearPath + Uniswap swap/liquidity
 *     as of spec 067), Hoodi (560048) and Sepolia (11155111) testnets. No wager
 *     infra is deployed here; that capability self-discloses as unavailable
 *     (honest-state).
 *   - Arbitrum One (42161), Base (8453), Optimism (10) — spec 067 bridge +
 *     liquidity networks, first-class for select/portfolio/send-receive. Each
 *     carries an Across SpokePool and a Uniswap V3 deployment.
 *   - Hardhat (1337) — local dev.
 *
 * Spec 067 note: `capabilities.dex` (in-app swapping) is an EXPLICIT allow-list
 * (SWAP_CHAIN_IDS) and `capabilities.liquidity` is derived separately. Adding
 * `dex` addresses to a network no longer switches swapping on by itself — see
 * the SWAP_CHAIN_IDS comment.
 *
 * Passkey note (spec 041): every EVM network here declares a `passkey` block and
 * derives `capabilities.passkeyAccounts` from it, because every one of them was
 * probed and can host the ERC-4337 account stack. Declaring the block enables
 * ops, not members: the capability stays false until a bundler URL is set, and UI
 * surfaces gate on `config/passkeySupport.js#isPasskeySupported`, which ALSO
 * requires the account factory to be deployed on that chain.
 *
 * The user-facing Testnet/Mainnet toggle switches between 80002 (testnet) and
 * 137 (mainnet) via wagmi.switchChain; every network with `selectable: true`
 * is also individually switchable from the My Account → Network tab.
 */

// Note: We intentionally do NOT import from ./contracts here — contracts.js
// imports from this file (indirectly, via NETWORK_CONFIG-style lookups) and a
// hard import would create a cycle.

// Staking (spec 065). Per-network like earn — only chains with a real,
// deposits-open provider get a block. `staking.js` imports nothing from here,
// so there is no cycle. Launch: chain 1 only.
import { ethereumStakingConfig } from './staking'

// PRIMARY_CHAIN_ID is the app's home/default network (used as the default chain
// when VITE_NETWORK_ID is unset and as the wallet auto-switch target for
// unsupported chains). TESTNET_CHAIN_ID is the testnet side of the user-facing
// Testnet/Mainnet toggle — kept separate so "primary" can be mainnet without
// collapsing the toggle pair.
const PRIMARY_CHAIN_ID = 137
const MAINNET_CHAIN_ID = 137
const TESTNET_CHAIN_ID = 80002

// Earn / lending integration (spec 050). Declared per network — only chains
// where Morpho vaults AND the Morpho data API are live get a block; everywhere
// else the earn capability self-discloses off (honest-state, no mock vaults).
// The Merkl Distributor is Merkl's canonical claim contract, deployed at the
// same address on every chain it supports; it is config-fixed here and never
// derived from user input or API responses.
// See specs/050-earn-lending-rewards/contracts/earn-config.md.
const MERKL_DISTRIBUTOR = '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae'
// Collectibles (spec 055): the read-only, OpenSea-backed NFT portfolio is available ONLY on
// chains OpenSea serves AND we ship (Ethereum mainnet + Polygon). Everywhere else the capability
// is false and the Collectibles tab + portfolio line hide entirely (FR-007 soft-fail).
const COLLECTIBLES_CHAIN_IDS = new Set([1, 137])
// Predict (spec 057): Polymarket prediction-market trading is available ONLY on Polygon (137) —
// Polymarket runs nowhere else. Everywhere else the capability is false and the Predict tab hides
// entirely (FR-018 soft-fail), mirroring COLLECTIBLES_CHAIN_IDS.
const PREDICT_CHAIN_IDS = new Set([137])

const earnConfig = () => ({
  provider: { name: 'Morpho', url: 'https://app.morpho.org' },
  merklDistributor: MERKL_DISTRIBUTOR,
  legacyRewardsUrl: 'https://rewards-legacy.morpho.org/',
})

/*
 * Full-E2E seam, identical in guard and reasoning to the one in config/contracts.js: the tier's
 * local hardhat node boots AS chainId 80002 so the local chain is the app's membership home, and
 * `import.meta.env.DEV &&` makes this whole branch dead code in any production bundle.
 *
 * Why Earn needs one. `FeeRouter.depositToVaultWithFee` is the only path that CHARGES a platform
 * fee on chain, and Earn ▸ Lend is its only member surface — so the spec-060 invariant "a member
 * is never charged above the rate they were shown" can only be settled from chain state on a
 * network where Earn exists. Real Amoy has no Morpho and never will; the local impersonation has
 * a FeeRouter and a MockERC4626Vault (scripts/deploy/deploy-local-earn-vault.js), which is what
 * this flag describes. Nothing else about the section changes: the vault LIST still comes from
 * the Morpho API, which the spec stubs, so a build with the flag set and no stub shows the same
 * honest "unavailable" state it would on any other chain.
 */
const E2E_AMOY_LOCAL =
  Boolean(import.meta.env?.DEV) && import.meta.env?.VITE_E2E_AMOY_LOCAL === '1'

// In-app token swapping (spec 033 / 067 FR-016a). An EXPLICIT allow-list, not
// `Boolean(this.dex)`.
//
// Why explicit: `capabilities.dex` gates the Trade surface, the portfolio asset
// sheet's Swap action, and DEX spot pricing. Deriving it from the presence of
// `dex` addresses means adding those addresses for a DIFFERENT reason — spec
// 067 needs `positionManager` for liquidity supply — silently switches token
// swapping on as a side effect. That is exactly how Ethereum ended up
// swap-less: it had no `dex` block, so the capability was false by accident of
// configuration rather than by decision (research R4a).
//
// Liquidity supply is a SEPARATE capability derived from `dex.positionManager`
// plus a deployed `liquidityRouter`, so the two can move independently: a
// network may have pools worth supplying before FairWins exposes swapping
// there, or the reverse.
//
// Membership here is a POLICY gate, not a claim that the network is ready: the
// capability also requires real `dex` config, because ETC/Mordor/Amoy build
// theirs from env vars and yield null when unset.
//
// The 80002 entry is the LOCAL E2E IMPERSONATION ONLY, and is the same seam `earn` and the staking
// config already use on this network (`E2E_AMOY_LOCAL`, above). It is compile-time — a shipped
// build has `import.meta.env.DEV` false, the branch is dead code, and real Polygon Amoy stays
// swap-less exactly as it is today. It exists because admission rule 2 of the e2e policy says a
// flow in which a member signs something that costs them money must have on-chain coverage, the
// on-chain tier impersonates Amoy, and a member swapping is spending. Membership of this set is
// still not sufficient on its own: Amoy's `dex` block is built from VITE_AMOY_UNISWAP_* and stays
// null unless something supplies them — locally, `scripts/deploy/deploy-local-swap.js`.
const SWAP_CHAIN_IDS = new Set([1, 10, 61, 63, 137, 8453, 42161, ...(E2E_AMOY_LOCAL ? [80002] : [])])

/*
 * Full-E2E staking wiring (specs 065 + 066), behind the same DEV-only seam as `earn` above.
 *
 * Real Polygon Amoy has no Lido, no sPOL and no Polygon StakeManager, so a shipped build
 * resolves `staking` to null here exactly as it always did and the Stake area names the
 * networks where staking really exists. The local impersonation points at the contracts/mocks
 * stand-ins that `scripts/deploy/deploy-staking-router.js` deploys on a local node, which is
 * what lets the stake, unstake and operator-control flows run against a chain.
 *
 * NONCE-DERIVED, like the router addresses in contracts.js — they come from the same deploy.
 *
 * `aprApi` and `stakingApi` are deliberately NULL. Both are public third-party endpoints whose
 * only job is decoration; a local run must not depend on them, and both callers already treat
 * an unreadable source as "no decoration" rather than as an error.
 */
const localStakingConfig = () => ({
  liquid: [
    {
      kind: 'lido',
      provider: { name: 'Lido', url: 'https://stake.lido.fi' },
      asset: { symbol: 'ETH', decimals: 18 },
      lstSymbol: 'wstETH',
      referral: '0x0000000000000000000000000000000000000000',
      contracts: {
        steth: '0x82e01223d51Eb87e16A03E24687EDF0F294da6f1',
        wsteth: '0x2bdCC0de6bE1f7D2ee689a0342D76F52E8EFABa3',
        withdrawalQueue: '0x0000000000000000000000000000000000000000',
      },
      aprApi: null,
      unbonding: { kind: 'queue', instantExit: false },
    },
    {
      kind: 'spol',
      provider: { name: 'sPOL (Polygon)', url: 'https://staking.polygon.technology/lst' },
      asset: { symbol: 'POL', decimals: 18, address: '0x7969c5eD335650692Bc04293B07F5BF2e7A673C0' },
      lstSymbol: 'sPOL',
      referral: null,
      contracts: {
        token: '0x7bc06c482DEAd17c0e297aFbC32f6e63d3846650',
        controller: '0xc351628EB244ec633d5f21fBD6621e1a683B1181',
      },
      aprApi: null,
      unbonding: { kind: 'checkpoints', instantExit: true },
    },
  ],
  delegated: {
    provider: { name: 'Polygon PoS', url: 'https://staking.polygon.technology' },
    asset: { symbol: 'POL', decimals: 18, address: '0x7969c5eD335650692Bc04293B07F5BF2e7A673C0' },
    stakeManager: '0xFD471836031dc5108809D173A067e8486B9047A3',
    stakingApi: null,
    validators: [
      {
        validatorId: 1,
        name: 'E2E Validator',
        validatorShare: '0xcbEAF3BDe82155F56486Fb5a1072cb8baAf547cc',
      },
    ],
  },
})

// Cross-chain bridge + liquidity supply (spec 067).
//
// `bridge` is a BUILD-TIME DISPLAY FALLBACK only (FR-051): the authoritative
// SpokePool/HubPool addresses, route availability, limits, and pause state are
// read from the on-chain BridgeRouter/LiquidityRouter at runtime. A network with
// no `bridge` block has no Across deployment and the Bridge surface hides there
// honestly (FR-006c) — ETC/Mordor have neither protocol.
//
// `hubPool` is non-null on Ethereum ONLY: Across's HubPool is an L1 contract by
// design, so bridge-liquidity supply is Ethereum-only while trading liquidity
// spans every Uniswap network (research R8). Do not "fix" this by copying the
// address elsewhere — there is no HubPool on an L2.
const bridgeConfig = (spokePool, hubPool = null) => ({ spokePool, hubPool })

// Uniswap V3 deployment per network (spec 067, research R4b).
//
// ⚠️ Addresses are NOT identical across chains. Uniswap's own docs warn
// integrators not to assume they are, and BASE genuinely differs (its factory
// and position manager live at different addresses than the set Ethereum,
// Polygon, Arbitrum and Optimism share). Every address here was verified to
// carry bytecode on its own chain; `scripts/ops/verify-protocol-addresses.js`
// re-checks that in CI/ops. Never copy an address from one chain to another.
const CANONICAL_UNISWAP = {
  factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  swapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
}

// Passkey smart-account submission config (spec 041, data-model
// "SubmissionRoute"). Parses a comma-separated ERC-4337 bundler URL list
// (ordered: self-hosted alto first, public fallbacks). Empty/unset → null so
// the passkey capability flips off and the login surface hides the option
// honestly (FR-004) instead of offering a dead path. sponsorPaymasterUrl is the
// optional FairWins-sponsored paymaster endpoint (spec 050 → the relay-gateway's
// /v1/paymaster); null → UserOp fees fall back to the account's native balance and
// the confirm UI discloses the native fee honestly (never a false "sponsored").
//
// EVERY EVM network below now declares a passkey block, because every one of them
// was probed and can host the stack — `scripts/ops/verify-passkey-support.js`
// verifies, on-chain and by bytecode hash, that the Arachnid CREATE2 proxy and
// EntryPoint v0.6 are present (they are, on all ten). Declaring the block is NOT a
// claim that passkeys work there: it is the switch that lets ops turn a network on
// by deploying the factory and setting one env var, with no code change. Until
// both happen the capability stays false and every passkey surface hides.
//
// `capabilities.passkeyAccounts` is therefore the CONFIG half of the answer only.
// The full gate — bundler configured AND the account stack deployed on that chain
// — lives in `config/passkeySupport.js#isPasskeySupported`, which is what UI
// surfaces must consult. A bundler URL alone would advertise passkey login on a
// chain with no factory, where account creation reverts.
const passkeyConfig = (urlsEnv, sponsorEnv) => {
  const bundlerUrls = (urlsEnv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (bundlerUrls.length === 0) return null
  return { bundlerUrls, sponsorPaymasterUrl: sponsorEnv || null }
}

const NETWORKS = {
  80002: {
    chainId: 80002,
    name: 'Polygon Amoy',
    isTestnet: true,
    isPrimary: false,
    // Surfaced in the My Account → Network tab as a user-switchable network.
    selectable: true,
    // POL since Polygon's MATIC → POL migration (the testnet gas token followed
    // mainnet's rebrand). Same coin, same decimals — only the ticker moved.
    nativeCurrency: { decimals: 18, name: 'POL', symbol: 'POL' },
    // publicnode, not Polygon's own `rpc-amoy.polygon.technology`: the official endpoint
    // stopped answering browser reads for the testnet staging build (issue #1458 QA round —
    // every Amoy screening source came back unreadable while the same calls succeed here),
    // and it is the odd one out anyway, since Polygon mainnet, Sepolia and Hoodi all default
    // to publicnode already. A member can still point `network_endpoints` anywhere (spec 069).
    rpcUrl: import.meta.env?.VITE_RPC_URL_AMOY || 'https://polygon-amoy-bor-rpc.publicnode.com',
    explorer: { name: 'Polygonscan', baseUrl: 'https://amoy.polygonscan.com' },
    // The Graph endpoint that indexes this chain's WagerRegistry. When present,
    // the wager list/reports read from the subgraph; when null (see Mordor),
    // the app falls back to direct RPC reads via RegistrySource. Override with
    // VITE_SUBGRAPH_URL_AMOY.
    subgraphUrl:
      import.meta.env?.VITE_SUBGRAPH_URL_AMOY ||
      'https://api.studio.thegraph.com/query/1755381/fairwins-amoy/v0.3.0',
    // USDC on Amoy. Defaults to the Circle faucet USDC deployed alongside
    // our contracts (same as paymentToken in contracts.js). Override via
    // VITE_AMOY_USDC if a different token is needed.
    stablecoin: {
      address: import.meta.env?.VITE_AMOY_USDC || '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      symbol: 'USDC',
      // Decimals follow the address override: the full-E2E tier points VITE_AMOY_USDC at the
      // local 18-dec mock (the node impersonates Amoy — see dev:e2e), and an address override
      // with the real token's 6 hardcoded beside it makes every amount computation wrong by
      // 10^12 — stakes become dust that still clears on-chain, which is worse than failing.
      // Unset, this is exactly the literal 6 it always was.
      name: 'USD Coin',
      decimals: Number(import.meta.env?.VITE_AMOY_USDC_DECIMALS) || 6,
      // EIP-712 domain version for the EIP-3009 payment leg (spec 035 FR-020):
      // native Circle USDC signs under version '2' (bridged USDC.e would be '1').
      domainVersion: '2',
    },
    // Uniswap V3 has no canonical deployment on Polygon Amoy. Community
    // deployments exist; supply them via VITE_AMOY_UNISWAP_* env vars to
    // enable swaps on testnet. When any required address is missing the DEX
    // capability flips off and the swap UI is hidden.
    dex: (() => {
      const factory = import.meta.env?.VITE_AMOY_UNISWAP_FACTORY
      const router = import.meta.env?.VITE_AMOY_UNISWAP_SWAP_ROUTER
      const quoter = import.meta.env?.VITE_AMOY_UNISWAP_QUOTER
      const positionManager = import.meta.env?.VITE_AMOY_UNISWAP_POSITION_MANAGER
      const wnative = import.meta.env?.VITE_AMOY_WMATIC
      if (!factory || !router || !quoter || !wnative) return null
      return {
        factory,
        swapRouter: router,
        quoter,
        positionManager: positionManager || null,
        wnative,
      }
    })(),
    contracts: {}, // populated by sync:frontend-contracts after deploy
    polymarket: {
      ctf: import.meta.env?.VITE_AMOY_POLYMARKET_CTF || null,
      // Gamma API endpoint for Polymarket event search. Polymarket runs the
      // same Gamma instance for testnet listings.
      gammaApiUrl: import.meta.env?.VITE_POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com',
    },
    // DEX provider identity — non-ETC networks route through Uniswap (Spec 033).
    dexProvider: {
      name: 'Uniswap',
      url: 'https://app.uniswap.org/swap',
    },
    // Earn ▸ Lend exists here ONLY in the local full-E2E impersonation (see E2E_AMOY_LOCAL
    // above) — real Polygon Amoy has no Morpho deployment, and a shipped build resolves this
    // to null exactly as it always did.
    earn: E2E_AMOY_LOCAL ? earnConfig() : null,
    // Same seam, same reason (specs 065 + 066) — see `localStakingConfig` above.
    staking: E2E_AMOY_LOCAL ? localStakingConfig() : null,
    /*
     * Same seam, same reason (spec 067): Across is not deployed on real Polygon Amoy, so a shipped
     * build resolves this to null and the Bridge surface hides here exactly as it does today. The
     * local impersonation points at the contracts/mocks SpokePool that
     * `scripts/deploy/deploy-bridge-liquidity.js` deploys, so the bridge flows can be driven end to
     * end against a chain.
     *
     * NONCE-DERIVED, like the router addresses in contracts.js — it comes from the same targeted
     * deploy. No HubPool: bridge-liquidity supply is Ethereum-only (the HubPool is an L1 contract),
     * and pretending otherwise here would offer a supply route that cannot exist.
     */
    bridge: E2E_AMOY_LOCAL
      ? bridgeConfig('0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00')
      : null,
    // Passkey smart accounts (spec 041) — Amoy is the passkey validation
    // network: RIP-7212 P-256 precompile live, canonical EntryPoint v0.6.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_AMOY,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_AMOY
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: true,
        // Swap needs BOTH the policy gate (SWAP_CHAIN_IDS) AND real router config.
        // The allow-list alone is not enough: ETC/Mordor/Amoy build `dex` from env
        // vars and yield null when unset, so a list-only check would advertise a
        // Trade surface with no router behind it. See SWAP_CHAIN_IDS (R4a).
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        // Liquidity supply (spec 067) is independent of swapping.
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: true,
        passkeyAccounts: Boolean(this.passkey),
        // ClearPath DAO governance (spec 042) — network-agnostic; runs wherever a read RPC exists,
        // independent of whether an ExternalDAORegistry is deployed (registry-optional).
        clearpath: true,
      }
    },
  },
  63: {
    chainId: 63,
    name: 'Ethereum Classic Mordor',
    isTestnet: true,
    isPrimary: false,
    // Surfaced in the My Account → Network tab as a user-switchable network.
    selectable: true,
    nativeCurrency: { decimals: 18, name: 'Ethereum Classic', symbol: 'ETC' },
    rpcUrl: import.meta.env?.VITE_RPC_URL_MORDOR || 'https://rpc.mordor.etccooperative.org',
    explorer: { name: 'Blockscout', baseUrl: 'https://etc-mordor.blockscout.com' },
    // No hosted Graph indexer supports Ethereum Classic / Mordor, so there is no
    // subgraph for this chain. The app reads wagers directly from the
    // WagerRegistry over RPC (RegistrySource). Set VITE_SUBGRAPH_URL_MORDOR only
    // if a self-hosted indexer (Goldsky/Ponder/Envio) is stood up later.
    subgraphUrl: import.meta.env?.VITE_SUBGRAPH_URL_MORDOR || null,
    // Classic USD (USC) — Ethereum Classic's fiat-backed stablecoin (Brale-issued),
    // reused as-is (never a mock). Verify the canonical Mordor address + decimals
    // on-chain before relying on it (Spec 015, T001). Override via VITE_MORDOR_USC.
    stablecoin: {
      address: import.meta.env?.VITE_MORDOR_USC || '0xDE093684c796204224BC081f937aa059D903c52a',
      symbol: 'USC',
      name: 'Classic USD',
      decimals: 6,
      // USC has no EIP-3009 receiveWithAuthorization — null disables payment-class
      // gasless intents on this chain (self-submit only; spec 035 FR-020).
      domainVersion: null,
    },
    // ETCswap (Uniswap V3 fork on Ethereum Classic). Supply all addresses via
    // VITE_MORDOR_ETCSWAP_* + VITE_MORDOR_WETC to enable in-app swaps on Mordor.
    // When any required address is missing the DEX capability flips off and the
    // swap UI is hidden (no mock DEX) — Spec 015 FR-011.
    dex: (() => {
      const factory = import.meta.env?.VITE_MORDOR_ETCSWAP_FACTORY
      const router = import.meta.env?.VITE_MORDOR_ETCSWAP_SWAP_ROUTER
      const quoter = import.meta.env?.VITE_MORDOR_ETCSWAP_QUOTER
      const positionManager = import.meta.env?.VITE_MORDOR_ETCSWAP_POSITION_MANAGER
      const wnative = import.meta.env?.VITE_MORDOR_WETC
      if (!factory || !router || !quoter || !wnative) return null
      return {
        factory,
        swapRouter: router,
        quoter,
        positionManager: positionManager || null,
        wnative,
      }
    })(),
    contracts: {}, // populated by sync:frontend-contracts after deploy
    polymarket: null, // no Polymarket on Ethereum Classic
    // Per-network documentation links for the Network tab (not derivable from the
    // fields above). Faucet URL is verified in Spec 015 T003 — set VITE_MORDOR_FAUCET
    // (or update the default) once confirmed; the card hides the row when empty.
    resources: {
      faucet: import.meta.env?.VITE_MORDOR_FAUCET || '',
    },
    // DEX provider identity — the ETC family routes through ETCswap (Spec 033).
    // Declared at the network level so the swap UI can name the provider even
    // when `dex` is env-unconfigured (keeps the disabled-state message honest).
    dexProvider: {
      name: 'ETCswap',
      url: import.meta.env?.VITE_MORDOR_ETCSWAP_URL || 'https://etcswap.org',
    },
    // Passkey smart accounts (spec 041). The old "deferred ETC increment" note
    // said Mordor had no canonical EntryPoint; that is no longer true —
    // `verify-passkey-support.js` finds EntryPoint v0.6 and the Arachnid CREATE2
    // proxy here, byte-identical to Polygon's. What Mordor genuinely lacks is the
    // RIP-7212 precompile, so P-256 verification falls back to WebAuthnSol's
    // inlined FCL Solidity path: correct, but materially more gas per UserOp.
    // Budget for that before pointing a sponsoring paymaster at this chain.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_MORDOR,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_MORDOR
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        // Swap needs BOTH the policy gate (SWAP_CHAIN_IDS) AND real router config.
        // The allow-list alone is not enough: ETC/Mordor/Amoy build `dex` from env
        // vars and yield null when unset, so a list-only check would advertise a
        // Trade surface with no router behind it. See SWAP_CHAIN_IDS (R4a).
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        // Liquidity supply (spec 067) is independent of swapping.
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: true,
        passkeyAccounts: Boolean(this.passkey),
        // ClearPath DAO governance (spec 042) — Olympia lives on the ETC family; registry-optional.
        clearpath: true,
      }
    },
  },
  61: {
    chainId: 61,
    name: 'Ethereum Classic',
    isTestnet: false,
    isPrimary: false,
    // Surfaced in the My Account → Network tab as a user-switchable network.
    selectable: true,
    nativeCurrency: { decimals: 18, name: 'Ethereum Classic', symbol: 'ETC' },
    // `etc.rivet.link` was the default here until it stopped resolving entirely
    // (NXDOMAIN — the host is gone, not down), which cost every ETC read a failed DNS
    // lookup before the failover leg could answer. etcdesktop was already the verified
    // failover and is promoted in its place: it answers eth_chainId with `0x3d` and a
    // correct `access-control-allow-origin` on both the preflight and the real request.
    rpcUrl: import.meta.env?.VITE_RPC_URL_ETC || 'https://etc.etcdesktop.com',
    // NO BUILD DEFAULT FAILOVER, deliberately — and this is a smaller loss than it looks:
    // rivet was the only other default, and it was already dead, so ETC has in practice
    // been running on one endpoint for as long as that host has been gone. Shipping a
    // second URL is only redundancy if it works, and every other public ETC RPC checked
    // (geth-at.etc-network.info, etccooperative, rivet.cloud) either sends no
    // `access-control-allow-origin` — unusable from a browser at any price — or was
    // already rate-limiting. A URL that cannot answer is not a failover; it is a
    // guaranteed wasted round-trip on the way to the one that can. Ops can point
    // VITE_RPC_URL_ETC_FAILOVER at a keyed endpoint, and a member can set their own
    // (spec 069), the moment one is available.
    rpcFailoverUrl: import.meta.env?.VITE_RPC_URL_ETC_FAILOVER || null,
    explorer: { name: 'Blockscout', baseUrl: 'https://etc.blockscout.com' },
    // No hosted Graph indexer supports Ethereum Classic, so wager reads go
    // straight to the WagerRegistry over RPC (RegistrySource). ETC mainnet is
    // wager-legacy (read-only); Spec 033 enables only the swap surface here.
    subgraphUrl: import.meta.env?.VITE_SUBGRAPH_URL_ETC || null,
    // Classic USD (USC) — the same Brale-issued token deployed at a deterministic
    // address on ETC mainnet and Mordor; verified on etc.blockscout.com
    // (Spec 033 research R2). Override via VITE_ETC_USC.
    stablecoin: {
      address: import.meta.env?.VITE_ETC_USC || '0xDE093684c796204224BC081f937aa059D903c52a',
      symbol: 'USC',
      name: 'Classic USD',
      decimals: 6,
      // USC has no EIP-3009 receiveWithAuthorization — null disables payment-class
      // gasless intents on this chain (self-submit only; spec 035 FR-020).
      domainVersion: null,
    },
    // ETCswap V3 (a Uniswap V3 deployment on Ethereum Classic). Addresses are the
    // on-chain-verified canonical deployment (Spec 033 research R1); override via
    // VITE_ETC_ETCSWAP_* + VITE_ETC_WETC. Gated like every chain: if an override
    // blanks a required address the DEX flips off — no mock DEX.
    dex: (() => {
      const factory = import.meta.env?.VITE_ETC_ETCSWAP_FACTORY || '0x2624E907BcC04f93C8f29d7C7149a8700Ceb8cDC'
      const router = import.meta.env?.VITE_ETC_ETCSWAP_SWAP_ROUTER || '0xEd88EDD995b00956097bF90d39C9341BBde324d1'
      const quoter = import.meta.env?.VITE_ETC_ETCSWAP_QUOTER || '0x4d8c163400CB87Cbe1bae76dBf36A09FED85d39B'
      const positionManager = import.meta.env?.VITE_ETC_ETCSWAP_POSITION_MANAGER || '0x3CEDe6562D6626A04d7502CC35720901999AB699'
      const wnative = import.meta.env?.VITE_ETC_WETC || '0x1953cab0E5bFa6D4a9BaD6E05fD46C1CC6527a5a'
      if (!factory || !router || !quoter || !wnative) return null
      return {
        factory,
        swapRouter: router,
        quoter,
        positionManager: positionManager || null,
        wnative,
      }
    })(),
    contracts: {}, // ETC mainnet has no v2 wager deployment (wager-legacy)
    polymarket: null, // no Polymarket on Ethereum Classic
    // DEX provider identity — the ETC family routes through ETCswap (Spec 033).
    dexProvider: {
      name: 'ETCswap',
      url: import.meta.env?.VITE_ETC_ETCSWAP_URL || 'https://v3.etcswap.org',
    },
    // Passkey smart accounts (spec 041) — EntryPoint v0.6 + the Arachnid CREATE2
    // proxy are both live on ETC (verified by bytecode hash); no RIP-7212
    // precompile, so the FCL Solidity fallback carries P-256 verification. See
    // the Mordor entry for the gas caveat.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_ETC,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_ETC
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        // Swap needs BOTH the policy gate (SWAP_CHAIN_IDS) AND real router config.
        // The allow-list alone is not enough: ETC/Mordor/Amoy build `dex` from env
        // vars and yield null when unset, so a list-only check would advertise a
        // Trade surface with no router behind it. See SWAP_CHAIN_IDS (R4a).
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        // Liquidity supply (spec 067) is independent of swapping.
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: true,
        passkeyAccounts: Boolean(this.passkey),
        // ClearPath DAO governance (spec 042) — Olympia lives on the ETC family; registry-optional.
        clearpath: true,
      }
    },
  },
  137: {
    chainId: 137,
    name: 'Polygon',
    isTestnet: false,
    isPrimary: true,
    // Surfaced in the My Account → Network tab as a user-switchable network.
    selectable: true,
    // POL since Polygon's MATIC → POL migration. The rebrand renamed the coin,
    // not any contract: addresses (WPOL wrapper, price feeds) are unchanged.
    nativeCurrency: { decimals: 18, name: 'POL', symbol: 'POL' },
    rpcUrl: import.meta.env?.VITE_RPC_URL_POLYGON || 'https://polygon-bor-rpc.publicnode.com',
    // Build-level failover (spec 069 precedent: ETC's rpcFailoverUrl, ~L477). A distinct public
    // provider so redundancy is real even before ops set VITE_RPC_URL_POLYGON — and critically, once
    // ops DO point VITE_RPC_URL_POLYGON at a deploy-time-keyed QuickNode endpoint (any `VITE_` var
    // ships public in the client bundle per spec 097 — never a reason to withhold the failover), a
    // keyed primary going dark degrades to this route instead of leaving the chain unreadable.
    // Mirrors the relay-gateway's own Polygon pair (services/relay-gateway/src/config/chains.js:
    // publicnode primary, drpc.org secondary). Override via VITE_RPC_URL_POLYGON_FAILOVER.
    rpcFailoverUrl: import.meta.env?.VITE_RPC_URL_POLYGON_FAILOVER || 'https://polygon.drpc.org',
    explorer: { name: 'Polygonscan', baseUrl: 'https://polygonscan.com' },
    // The Graph endpoint indexing Polygon. Override with VITE_SUBGRAPH_URL_POLYGON.
    //
    // v0.3.0 (2026-08-01) replaced v0.2.0, which indexed the ABANDONED pre-UUPS
    // WagerRegistry and therefore answered every wager query with an empty list —
    // HTTP 200, no errors, healthy, minutes behind head — while members had live
    // wagers. v0.3.0 indexes the live contracts and adds vouchers, redemptions,
    // pools and token/holder/activity. Pin the version rather than tracking
    // `/version/latest`: a freshly deployed version answers with PARTIAL data while
    // it back-fills, which is the same silent wrongness v0.2.0 was.
    subgraphUrl:
      import.meta.env?.VITE_SUBGRAPH_URL_POLYGON ||
      'https://api.studio.thegraph.com/query/1755381/fairwins-polygon/v0.3.0',
    // Native USDC on Polygon (Circle-issued, USDC.e is the bridged variant
    // and is not used here). Decimals=6.
    stablecoin: {
      address: import.meta.env?.VITE_POLYGON_USDC || '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      // EIP-712 domain version for the EIP-3009 payment leg (spec 035 FR-020):
      // native Circle USDC signs under version '2' (bridged USDC.e would be '1').
      domainVersion: '2',
    },
    // Canonical Uniswap V3 deployment on Polygon Mainnet.
    // https://docs.uniswap.org/contracts/v3/reference/deployments
    dex: {
      factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      swapRouter: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
      quoter: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      positionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      wnative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // WPOL (the contract formerly branded WMATIC — same address)
    },
    contracts: {},
    polymarket: {
      ctf: import.meta.env?.VITE_POLYGON_POLYMARKET_CTF || '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
      gammaApiUrl: import.meta.env?.VITE_POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com',
    },
    // DEX provider identity — non-ETC networks route through Uniswap (Spec 033).
    dexProvider: {
      name: 'Uniswap',
      url: 'https://app.uniswap.org/swap?chain=polygon',
    },
    // Across SpokePool (spec 067). No HubPool — bridge-liquidity supply is
    // Ethereum-only because Across's HubPool is an L1 contract.
    bridge: bridgeConfig('0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096'),
    // Earn / lending (spec 050): Morpho vaults + data API are live on Polygon PoS.
    earn: earnConfig(),
    // Passkey smart accounts (spec 041) — production network: RIP-7212
    // precompile live since the Napoli upgrade, canonical EntryPoint v0.6.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_POLYGON,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_POLYGON
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: true,
        // Swap needs BOTH the policy gate (SWAP_CHAIN_IDS) AND real router config.
        // The allow-list alone is not enough: ETC/Mordor/Amoy build `dex` from env
        // vars and yield null when unset, so a list-only check would advertise a
        // Trade surface with no router behind it. See SWAP_CHAIN_IDS (R4a).
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        // Liquidity supply (spec 067) is independent of swapping.
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: true,
        passkeyAccounts: Boolean(this.passkey),
        // ClearPath DAO governance (spec 042) — network-agnostic; runs wherever a read RPC exists,
        // independent of whether an ExternalDAORegistry is deployed (registry-optional).
        clearpath: true,
      }
    },
  },
  // ── Spec 067 bridge/supply networks ──────────────────────────────────────
  // Arbitrum, Base and Optimism are added as FIRST-CLASS value networks
  // (FR-006b), not bridge-only stubs: selectable, in the portfolio, and usable
  // for send/receive. Bridging a member's assets to a network the app could not
  // then display or spend would be worse than not offering the route at all.
  // All three carry both an Across SpokePool and a Uniswap V3 deployment, which
  // is why they were chosen over the rest of Across's ~17 chains.
  42161: {
    chainId: 42161,
    name: 'Arbitrum One',
    isTestnet: false,
    isPrimary: false,
    selectable: true,
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrl: import.meta.env?.VITE_RPC_URL_ARBITRUM || 'https://arbitrum-one-rpc.publicnode.com',
    // Build-level failover — see the Polygon entry above for the full rationale. Override via
    // VITE_RPC_URL_ARBITRUM_FAILOVER.
    rpcFailoverUrl: import.meta.env?.VITE_RPC_URL_ARBITRUM_FAILOVER || 'https://arbitrum.drpc.org',
    explorer: { name: 'Arbiscan', baseUrl: 'https://arbiscan.io' },
    // No FairWins wager subgraph on this network.
    subgraphUrl: null,
    // Native Circle USDC on Arbitrum One (not USDC.e, the bridged variant).
    stablecoin: {
      address: import.meta.env?.VITE_ARBITRUM_USDC || '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      domainVersion: '2',
    },
    dex: { ...CANONICAL_UNISWAP, wnative: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
    dexProvider: { name: 'Uniswap', url: 'https://app.uniswap.org/swap?chain=arbitrum' },
    bridge: bridgeConfig('0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A'),
    earn: null,
    contracts: {},
    polymarket: null,
    // Passkey smart accounts (spec 041) — EntryPoint v0.6, the Arachnid CREATE2
    // proxy, and the RIP-7212 P-256 precompile are all live on Arbitrum One.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_ARBITRUM,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_ARBITRUM
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: false,
        passkeyAccounts: Boolean(this.passkey),
        clearpath: true,
      }
    },
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    isTestnet: false,
    isPrimary: false,
    selectable: true,
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrl: import.meta.env?.VITE_RPC_URL_BASE || 'https://base-rpc.publicnode.com',
    // Build-level failover — see the Polygon entry above for the full rationale. Override via
    // VITE_RPC_URL_BASE_FAILOVER.
    rpcFailoverUrl: import.meta.env?.VITE_RPC_URL_BASE_FAILOVER || 'https://base.drpc.org',
    explorer: { name: 'Basescan', baseUrl: 'https://basescan.org' },
    subgraphUrl: null,
    stablecoin: {
      address: import.meta.env?.VITE_BASE_USDC || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      domainVersion: '2',
    },
    // ⚠️ Base does NOT share the canonical Uniswap addresses (research R4b) —
    // these are Base's own factory/positionManager/quoter/router. Spreading
    // CANONICAL_UNISWAP here would point the router at a non-contract.
    dex: {
      factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
      quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      positionManager: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
      wnative: '0x4200000000000000000000000000000000000006',
    },
    dexProvider: { name: 'Uniswap', url: 'https://app.uniswap.org/swap?chain=base' },
    bridge: bridgeConfig('0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64'),
    earn: null,
    contracts: {},
    polymarket: null,
    // Passkey smart accounts (spec 041) — EntryPoint v0.6, the Arachnid CREATE2
    // proxy, and the RIP-7212 P-256 precompile are all live on Base.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_BASE,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_BASE
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: false,
        passkeyAccounts: Boolean(this.passkey),
        clearpath: true,
      }
    },
  },
  10: {
    chainId: 10,
    name: 'Optimism',
    isTestnet: false,
    isPrimary: false,
    selectable: true,
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrl: import.meta.env?.VITE_RPC_URL_OPTIMISM || 'https://optimism-rpc.publicnode.com',
    // Build-level failover — see the Polygon entry above for the full rationale. Override via
    // VITE_RPC_URL_OPTIMISM_FAILOVER.
    rpcFailoverUrl: import.meta.env?.VITE_RPC_URL_OPTIMISM_FAILOVER || 'https://optimism.drpc.org',
    explorer: { name: 'Etherscan', baseUrl: 'https://optimistic.etherscan.io' },
    subgraphUrl: null,
    stablecoin: {
      address: import.meta.env?.VITE_OPTIMISM_USDC || '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      domainVersion: '2',
    },
    dex: { ...CANONICAL_UNISWAP, wnative: '0x4200000000000000000000000000000000000006' },
    dexProvider: { name: 'Uniswap', url: 'https://app.uniswap.org/swap?chain=optimism' },
    bridge: bridgeConfig('0x6f26Bf09B1C792e3228e5467807a900A503c0281'),
    earn: null,
    contracts: {},
    polymarket: null,
    // Passkey smart accounts (spec 041) — EntryPoint v0.6, the Arachnid CREATE2
    // proxy, and the RIP-7212 P-256 precompile are all live on Optimism.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_OPTIMISM,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_OPTIMISM
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: false,
        passkeyAccounts: Boolean(this.passkey),
        clearpath: true,
      }
    },
  },
  1: {
    chainId: 1,
    name: 'Ethereum',
    isTestnet: false,
    isPrimary: false,
    // Surfaced in the My Account → Network tab as a user-switchable network.
    selectable: true,
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    // Ethereum mainnet is a first-class VALUE network (spec 048): members can select it, view
    // their ETH + curated-token holdings in the portfolio, and send/receive on it — alongside the
    // ClearPath DAO governance (ENS/Uniswap/…) enabled since spec 042. No wager/DEX/passkey infra
    // is deployed here, and each of those features self-discloses as unavailable rather than
    // pretending to work (honest-state; FR-005/FR-015). Passkey (smart-account) submission is not
    // enabled on the Ethereum family in this cut — a passkey member transacts via a linked wallet
    // and may still select the network for view-only use (FR-003a).
    rpcUrl: import.meta.env?.VITE_RPC_URL_MAINNET || 'https://ethereum-rpc.publicnode.com',
    // Build-level failover — see the Polygon entry (networks.js ~L561) for the full rationale.
    // Override via VITE_RPC_URL_MAINNET_FAILOVER.
    rpcFailoverUrl: import.meta.env?.VITE_RPC_URL_MAINNET_FAILOVER || 'https://eth.drpc.org',
    explorer: { name: 'Etherscan', baseUrl: 'https://etherscan.io' },
    // No wager subgraph for this network. ClearPath reads a DAO's own data subgraph-first (per-DAO,
    // see config/clearpath/daoSubgraphs.js) then falls back to a bounded on-chain scan.
    subgraphUrl: null,
    // Native Circle USDC on Ethereum mainnet — the network stablecoin for send/receive and a
    // portfolio holding (valued at par $1); also read for tracked-DAO treasury balances. The app
    // is non-custodial — no wager escrow uses it here. Override via VITE_MAINNET_USDC.
    stablecoin: {
      address: import.meta.env?.VITE_MAINNET_USDC || '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      domainVersion: '2',
    },
    // Canonical Uniswap V3 on Ethereum mainnet. Spec 067 enables BOTH in-app
    // swapping and liquidity supply here, superseding spec 048's ClearPath-only
    // cut (which reflected the absence of a `dex` block, not a decision).
    dex: { ...CANONICAL_UNISWAP, wnative: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
    dexProvider: { name: 'Uniswap', url: 'https://app.uniswap.org/swap?chain=mainnet' },
    // Across: SpokePool for bridging + the HubPool for bridge-liquidity supply.
    // Ethereum is the ONLY network with a HubPool — it is an L1 contract.
    bridge: bridgeConfig(
      '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
      '0xc186fA914353c44b2E33eBE05f21846F1048bEda'
    ),
    // Earn / lending (spec 050): Morpho's home chain — vaults + data API live.
    earn: earnConfig(),
    // Staking (spec 065): Lido (liquid ETH), sPOL (liquid POL), and Polygon
    // validator delegation (POL) all mint/execute on Ethereum L1. Launch chain.
    staking: ethereumStakingConfig(),
    contracts: {}, // no wager/membership deployment — ClearPath needs none (registry-optional)
    polymarket: null,
    // Passkey smart accounts (spec 041). Ethereum carries EntryPoint v0.6, the
    // Arachnid CREATE2 proxy, and a P-256 precompile at 0x100, so nothing about
    // the chain blocks the stack — the earlier "not enabled in this cut" note
    // described our own rollout, not a constraint. L1 gas makes this the most
    // expensive network to sponsor; enable it deliberately.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_MAINNET,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_MAINNET
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        // Swap needs BOTH the policy gate (SWAP_CHAIN_IDS) AND real router config.
        // The allow-list alone is not enough: ETC/Mordor/Amoy build `dex` from env
        // vars and yield null when unset, so a list-only check would advertise a
        // Trade surface with no router behind it. See SWAP_CHAIN_IDS (R4a).
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        // Liquidity supply (spec 067) is independent of swapping.
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: false,
        passkeyAccounts: Boolean(this.passkey),
        // The single enabled capability: ClearPath DAO governance (ENS, Uniswap, …).
        clearpath: true,
      }
    },
  },
  11155111: {
    chainId: 11155111,
    name: 'Sepolia',
    isTestnet: true,
    isPrimary: false,
    // User-selectable Ethereum testnet (spec 048): offered in the network switcher for
    // select + send/receive, and scanned for the cross-chain portfolio (testnet holdings
    // gated behind the "show testnet assets" preference). No app feature (wager/DEX/passkey)
    // is deployed here, so every such capability self-discloses off (honest-state).
    selectable: true,
    nativeCurrency: { decimals: 18, name: 'Sepolia Ether', symbol: 'ETH' },
    rpcUrl: import.meta.env?.VITE_RPC_URL_SEPOLIA || 'https://ethereum-sepolia-rpc.publicnode.com',
    explorer: { name: 'Etherscan', baseUrl: 'https://sepolia.etherscan.io' },
    subgraphUrl: null,
    // Circle's canonical faucet USDC on Sepolia. Override via VITE_SEPOLIA_USDC.
    stablecoin: {
      address: import.meta.env?.VITE_SEPOLIA_USDC || '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      domainVersion: '2',
    },
    dex: null,
    contracts: {},
    polymarket: null,
    /*
     * DEV-ONLY, and a DESTINATION only (spec 067 + issue #1265).
     *
     * A shipped build resolves this to null: Across has no production deployment we
     * curate here, so Bridge self-discloses off on Sepolia exactly as it does today.
     *
     * The local impersonation exists because #1265 made `bridgeNetworks()` cohort-bounded,
     * which is right — a testnet build must never be offered a mainnet destination — but
     * left the full E2E tier with a roster of exactly ONE network (Amoy, via the seam
     * below at 80002). A bridge needs somewhere to go: with one network in the roster the
     * destination selector is correctly empty, no quote is ever requested, and BL-03 —
     * the assertion that Across records the MEMBER as depositor, which is why
     * `IBridgeRouter` has no rescue function — cannot run at all.
     *
     * So Sepolia is the second in-cohort network the local tier bridges TO. It shares
     * Amoy's mock SpokePool address deliberately: a DESTINATION's spoke pool is never
     * called — `depositV3` is sent to the ORIGIN chain's pool, and the destination chain
     * reaches this build only as route metadata the mock records verbatim. Nothing is
     * read on Sepolia by these flows. Giving it a distinct fake address would imply a
     * second deployed contract that does not exist.
     */
    bridge: E2E_AMOY_LOCAL
      ? bridgeConfig('0x5eb3Bc0a489C5A8288765d2336659EbCA68FCd00')
      : null,
    // Passkey smart accounts (spec 041) — Sepolia carries EntryPoint v0.6, the
    // Arachnid CREATE2 proxy, and a P-256 precompile, which makes it the
    // free-to-fund rehearsal network for the Ethereum-family rollout.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_SEPOLIA,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_SEPOLIA
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        // Swap needs BOTH the policy gate (SWAP_CHAIN_IDS) AND real router config.
        // The allow-list alone is not enough: ETC/Mordor/Amoy build `dex` from env
        // vars and yield null when unset, so a list-only check would advertise a
        // Trade surface with no router behind it. See SWAP_CHAIN_IDS (R4a).
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        // Liquidity supply (spec 067) is independent of swapping.
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: false,
        passkeyAccounts: Boolean(this.passkey),
        clearpath: false,
      }
    },
  },
  560048: {
    chainId: 560048,
    name: 'Hoodi',
    isTestnet: true,
    isPrimary: false,
    // User-selectable Ethereum testnet (spec 048) — Ethereum's long-lived proof-of-stake
    // testnet. Offered in the network switcher for select + send/receive and scanned for the
    // portfolio (testnet holdings gated behind the "show testnet assets" preference). No app
    // feature (wager/DEX/passkey) is deployed here, so every such capability self-discloses off.
    selectable: true,
    nativeCurrency: { decimals: 18, name: 'Hoodi Ether', symbol: 'ETH' },
    rpcUrl: import.meta.env?.VITE_RPC_URL_HOODI || 'https://ethereum-hoodi-rpc.publicnode.com',
    explorer: { name: 'Etherscan', baseUrl: 'https://hoodi.etherscan.io' },
    subgraphUrl: null,
    // No canonical Hoodi faucet stablecoin is verified yet, so the stablecoin stays null unless
    // VITE_HOODI_USDC is supplied — no invented address (honest-state). With no stablecoin, Hoodi
    // send offers native ETH only and the portfolio shows native (+ any real curated token).
    stablecoin: (() => {
      const address = import.meta.env?.VITE_HOODI_USDC
      if (!address) return null
      return { address, symbol: 'USDC', name: 'USD Coin', decimals: 6, domainVersion: '2' }
    })(),
    dex: null,
    contracts: {},
    polymarket: null,
    // Passkey smart accounts (spec 041) — Hoodi carries EntryPoint v0.6, the
    // Arachnid CREATE2 proxy, and a P-256 precompile.
    passkey: passkeyConfig(
      import.meta.env?.VITE_BUNDLER_URLS_HOODI,
      import.meta.env?.VITE_SPONSOR_PAYMASTER_HOODI
    ),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        // Swap needs BOTH the policy gate (SWAP_CHAIN_IDS) AND real router config.
        // The allow-list alone is not enough: ETC/Mordor/Amoy build `dex` from env
        // vars and yield null when unset, so a list-only check would advertise a
        // Trade surface with no router behind it. See SWAP_CHAIN_IDS (R4a).
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        // Liquidity supply (spec 067) is independent of swapping.
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: false,
        passkeyAccounts: Boolean(this.passkey),
        clearpath: false,
      }
    },
  },
  1337: {
    chainId: 1337,
    name: 'Hardhat',
    isTestnet: true,
    isPrimary: false,
    // Local dev only — not offered in the user-facing network switcher.
    selectable: false,
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrl: 'http://127.0.0.1:8545',
    explorer: { name: 'Local', baseUrl: '' },
    // Local dev has no subgraph — reads go straight to the local node over RPC.
    subgraphUrl: null,
    stablecoin: null,
    dex: null,
    contracts: {},
    polymarket: null,
    // Local dev/e2e: point VITE_BUNDLER_URLS_LOCAL at a local bundler (alto
    // against the hardhat node) to exercise passkey flows in Cypress.
    passkey: passkeyConfig(import.meta.env?.VITE_BUNDLER_URLS_LOCAL, null),
    get capabilities() {
      return {
        collectibles: COLLECTIBLES_CHAIN_IDS.has(this.chainId),
        predict: PREDICT_CHAIN_IDS.has(this.chainId),
        polymarketSidebets: false,
        // Swap needs BOTH the policy gate (SWAP_CHAIN_IDS) AND real router config.
        // The allow-list alone is not enough: ETC/Mordor/Amoy build `dex` from env
        // vars and yield null when unset, so a list-only check would advertise a
        // Trade surface with no router behind it. See SWAP_CHAIN_IDS (R4a).
        dex: SWAP_CHAIN_IDS.has(this.chainId) && Boolean(this.dex),
        // Liquidity supply (spec 067) is independent of swapping.
        liquidity: Boolean(this.dex?.positionManager),
        bridge: Boolean(this.bridge?.spokePool),
        earn: Boolean(this.earn),
        staking: Boolean(this.staking),
        friendMarkets: true,
        passkeyAccounts: Boolean(this.passkey),
        // Local Hardhat sandbox is not a ClearPath governance network.
        clearpath: false,
      }
    },
  },
}

export { NETWORKS, PRIMARY_CHAIN_ID, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID }

/* ---------------------------------------------------------------------------
   Environment cohort + membership reference chain (spec 071)
   --------------------------------------------------------------------------- */

/**
 * Whether this build reads the testnet estate or the mainnet one.
 *
 * Constitution III forbids network-scoped data leaking across the testnet/mainnet
 * boundary, so "read every chain" has to mean "every chain THIS BUILD MAY READ".
 * The split is total — every NETWORKS entry carries `isTestnet` — so no chain is
 * unclassified and none can fall into both.
 */
function buildIsTestnet() {
  return Boolean(NETWORKS[getCurrentChainId()]?.isTestnet ?? NETWORKS[PRIMARY_CHAIN_ID]?.isTestnet)
}

/**
 * The single chain that is the authority for membership in this build (spec 071 FR-001/FR-002).
 *
 * DERIVED from the mainnet/testnet pair above rather than declared again: a second literal
 * `137` in the codebase is a divergence waiting to happen, and a hardcoded one would silently
 * read MAINNET membership in a testnet build.
 *
 * Not runtime-configurable, deliberately. This is a payment destination as well as a read
 * target (FR-006) — a wrong value sends a member's USDC to a chain where their membership
 * will never be read.
 */
export function membershipChainId() {
  return buildIsTestnet() ? TESTNET_CHAIN_ID : MAINNET_CHAIN_ID
}

/**
 * The testnet home of the mini-app registry.
 *
 * NOT `TESTNET_CHAIN_ID`, and this is the one place in the estate where those differ. The
 * `MiniAppRegistry` is deployed to **Polygon and Mordor only** — Amoy is deliberately not a
 * deployment target for spec 073 — so the testnet cohort's registry lives on Mordor.
 *
 * Deriving it from `TESTNET_CHAIN_ID` (Amoy) instead would be the more symmetrical code and the
 * wrong answer: Amoy has no `miniAppRegistry` address, so every testnet build would report the
 * catalog "not deployed" while a real registry sat unread on Mordor. The asymmetry is a fact
 * about where the contract is, and the constant states it rather than hiding it behind a shared
 * literal that no longer means what its name says.
 *
 * Still inside the cohort: Mordor is `isTestnet: true`, so a testnet build reads a testnet
 * registry and constitution III's testnet/mainnet boundary holds.
 */
const MINIAPP_TESTNET_CHAIN_ID = 63

/**
 * The single chain that hosts the mini-app registry for this build (spec 073 FR-025, research R5).
 *
 * One home per cohort, in the `membershipChainId()` shape above — but over its OWN pair, because
 * the registry's testnet deployment is Mordor rather than Amoy (see `MINIAPP_TESTNET_CHAIN_ID`).
 * What must never happen is a hardcoded `137`: the catalog is not a display detail, it decides
 * which packages the host will fetch, verify, and EXECUTE (FR-010/FR-011), and reading approvals
 * from the wrong side of the cohort boundary would run mainnet-curated code against testnet
 * wallets.
 *
 * Deliberately its own function rather than an alias of `membershipChainId()`: the two answer
 * different questions — where membership is sold and read, versus where app curation is
 * governed — and as of the Polygon+Mordor deployment decision they no longer even resolve to the
 * same chain on a testnet build.
 *
 * Not runtime-configurable, deliberately. The registry is the trust boundary for what code the
 * host executes, so a runtime-swappable registry chain would let a misconfiguration (or a
 * tampered preference) point verification at a chain anyone can write to.
 *
 * ── THE ONE EXCEPTION, AND WHY IT DOES NOT WEAKEN THAT ──────────────────────────────────────
 * `E2E_AMOY_LOCAL` redirects this to the local node, and it is NOT a runtime configuration: it is
 * `import.meta.env.DEV && VITE_E2E_AMOY_LOCAL === '1'`, so a production build eliminates the
 * branch entirely and no preference, tampered or otherwise, can reach it. The sentence above is
 * about a *runtime-swappable* registry chain; this is a compile-time one, and it is the same gate
 * that already repoints the ENTIRE 80002 address map to `HARDHAT_CONTRACTS` in config/contracts.js
 * — a strictly larger surface, since that one moves the wager registry and the fee router too.
 *
 * It exists because the rules this registry enforces — `launchable` is the serving decision, an
 * approval is content-committed, screening happens inside `wallet.submit` — are exactly the kind a
 * refactor inverts silently, and none of them can be settled against a chain the test cannot
 * write to. Mordor is a public network: a flow test cannot submit a package there, approve it, and
 * then swap it under the curator. On the local node it can.
 *
 * The cohort boundary still holds, and holds MORE tightly than before: 80002 is `isTestnet: true`,
 * so a testnet build still reads a testnet registry. `src/test/networks.miniapps.test.js` pins the
 * production answers on both sides so this branch cannot drift into a shipped build.
 */
export function miniAppChainId() {
  if (E2E_AMOY_LOCAL) return TESTNET_CHAIN_ID
  return buildIsTestnet() ? MINIAPP_TESTNET_CHAIN_ID : MAINNET_CHAIN_ID
}

/**
 * Every chain this build may read, mainnets-first. The ONLY roster an estate read may use —
 * `listSupportedChainIds()` spans both cohorts and would leak across the boundary.
 */
export function cohortChainIds() {
  const testnet = buildIsTestnet()
  return listSupportedChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => net && Boolean(net.isTestnet) === testnet)
    .sort((a, b) => Number(a.isTestnet) - Number(b.isTestnet))
    .map((net) => net.chainId)
}

/** Whether a chain is in this build's cohort. */
export function isInCohort(chainId) {
  const net = NETWORKS[chainId]
  return Boolean(net) && Boolean(net.isTestnet) === buildIsTestnet()
}

/**
 * Fail loudly rather than resolve a reference chain outside the cohort (contracts/membership-chain.md
 * rule 3). Silently returning an out-of-cohort chain is the failure this whole feature exists to
 * prevent — it would route real membership purchases at a chain the build must not touch.
 */
export function assertReferenceChainInCohort() {
  const id = membershipChainId()
  if (!isInCohort(id)) {
    throw new Error(
      `[networks] membership reference chain ${id} is not in this build's cohort ` +
        `(${buildIsTestnet() ? 'testnet' : 'mainnet'}). Check MAINNET_CHAIN_ID / TESTNET_CHAIN_ID.`,
    )
  }
  return id
}

// Checked once at module load: a build whose reference chain sits outside its own cohort is
// broken in a way that must not reach a member, so it stops here rather than quietly routing
// a purchase at the wrong chain.
assertReferenceChainInCohort()

export function getCurrentChainId() {
  const env = import.meta.env?.VITE_NETWORK_ID
  return env ? parseInt(env, 10) : PRIMARY_CHAIN_ID
}

export function getNetwork(chainId) {
  return NETWORKS[chainId] || NETWORKS[getCurrentChainId()] || NETWORKS[PRIMARY_CHAIN_ID]
}

export function isDexAvailable(chainId) {
  return Boolean(getNetwork(chainId)?.dex)
}

/**
 * Every network a swap can actually route on — the `capabilities.dex` gate
 * (policy allow-list AND real router config), mainnets first. Mirrors
 * `getClearPathChainIds()`: the Trade ticket lists pairs from ALL of these
 * regardless of which chain the wallet sits on, because quoting is a read over
 * each chain's own provider. Only the swap itself (a WRITE) needs the wallet to
 * be on the pair's network. Resolved strictly per-chain — never `getNetwork()`,
 * whose fallback would advertise the default network's DEX for a chain that has
 * none.
 */
export function getSwapChainIds() {
  return listSupportedChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => net?.capabilities?.dex)
    .sort((a, b) => Number(a.isTestnet) - Number(b.isTestnet))
    .map((net) => net.chainId)
}

/**
 * The DEX provider descriptor (`{ name, url }`) for `chainId`, or null when the
 * network has no DEX provider (e.g. local Hardhat). Declared per network so the
 * mapping — ETC family (61, 63) → ETCswap; all others → Uniswap — is explicit
 * and survives an unconfigured `dex`: the swap UI can still name the provider
 * for honest disabled-state copy (Spec 033). Resolution is strictly per-chain so
 * a provider identity never leaks across networks.
 */
export function getDexProvider(chainId) {
  return getNetwork(chainId)?.dexProvider ?? null
}

/**
 * Whether the Earn (lending) section is live on `chainId` (spec 050). True only
 * where a real Morpho deployment + data API exist; everywhere else the Earn UI
 * shows an honest unavailable state naming the enabled networks.
 * Resolved strictly per-chain (no getNetwork fallback) so a chain without an
 * entry never inherits another network's earn support.
 */
export function isEarnAvailable(chainId) {
  const net = chainId != null ? NETWORKS[chainId] : null
  return Boolean(net?.earn)
}

/**
 * The earn config block (`{ provider, merklDistributor, legacyRewardsUrl }`)
 * for `chainId`, or null when earn is not available there.
 */
export function getEarnConfig(chainId) {
  const net = chainId != null ? NETWORKS[chainId] : null
  return net?.earn ?? null
}

/**
 * The networks where Earn is live — used by the honest unavailable-state copy
 * ("Lending is available on Ethereum and Polygon") and by tests.
 */
export function getEarnNetworks() {
  return listSupportedChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => net?.earn)
}

/**
 * Whether staking (spec 065) is available on `chainId` — the presence of a
 * `staking` block. Launch: chain 1 only.
 */
export function isStakingAvailable(chainId) {
  const net = chainId != null ? NETWORKS[chainId] : null
  return Boolean(net?.staking)
}

/**
 * The staking config block (`{ liquid: [...], delegated: {...} }`) for
 * `chainId`, or null when staking is not available there.
 */
export function getStakingConfig(chainId) {
  const net = chainId != null ? NETWORKS[chainId] : null
  return net?.staking ?? null
}

/**
 * The networks where staking is live — used by the honest unavailable-state
 * copy ("Staking is available on Ethereum") and by tests.
 */
export function getStakingNetworks() {
  return listSupportedChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => net?.staking)
}

/**
 * The Graph endpoint that indexes `chainId`, or null when no subgraph is
 * deployed for that network. This is the single source of truth for the
 * "does this chain have an indexer?" decision used to route wager reads
 * between the subgraph and direct RPC (RegistrySource).
 *
 * Resolution is strictly per-chain so a subgraph URL configured for one
 * network can never leak to another (e.g. a Polygon endpoint must not be
 * queried while the wallet is on Mordor).
 */
export function getSubgraphUrl(chainId) {
  const net = chainId != null ? NETWORKS[chainId] : null
  return net?.subgraphUrl || null
}

/**
 * Whether `chainId` is indexed by a subgraph. Networks that return false
 * (e.g. Ethereum Classic Mordor) must be served from RPC reads instead.
 */
export function hasSubgraph(chainId) {
  return Boolean(getSubgraphUrl(chainId))
}

/**
 * Whether a chainId is a supported network.
 */
export function isSupportedChainId(chainId) {
  return Object.prototype.hasOwnProperty.call(NETWORKS, chainId)
}

export function listSupportedChainIds() {
  return Object.keys(NETWORKS).map((id) => parseInt(id, 10))
}

/**
 * Networks offered in the user-facing network switcher (My Account → Network).
 * Mainnets first, then testnets, so the production default surfaces at the top.
 * Future chains opt in by setting `selectable: true` on their NETWORKS entry.
 */
export function getSelectableNetworks() {
  return listSupportedChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => net?.selectable)
    .sort((a, b) => Number(a.isTestnet) - Number(b.isTestnet))
}

/**
 * Every network where ClearPath (DAO governance) is available, mainnets first — mirrors
 * `getPortfolioChainIds()` so the ClearPath panel can list known/tracked DAOs across every
 * capable network in parallel (network-agnostic), independent of which chain the wallet is
 * currently connected to. Only WRITE actions (register/vote/queue/execute) require the wallet
 * to actually be on a given DAO's chain.
 */
export function getClearPathChainIds() {
  return listSupportedChainIds()
    .map((id) => NETWORKS[id])
    .filter((net) => net?.capabilities?.clearpath)
    .sort((a, b) => Number(a.isTestnet) - Number(b.isTestnet))
    .map((net) => net.chainId)
}

/**
 * Pair of (testnet, mainnet) chain IDs used by the Testnet/Mainnet toggle.
 * Surfaced as a helper so UI code doesn't have to know the numeric values.
 */
export const TESTNET_MAINNET_PAIR = {
  testnet: TESTNET_CHAIN_ID,
  mainnet: MAINNET_CHAIN_ID,
}
