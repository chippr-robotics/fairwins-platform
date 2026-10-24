/**
 * Visual capture harness for the Perps view (spec 082) and its management surfaces (spec 083) —
 * the "actor" half of the actor-critic screenshot loop: it renders the real view in a real browser
 * and writes PNGs for a reviewer (human or agent) to critique against the style kit; fixes land in
 * the perps CSS and the loop repeats until the shots are clean. Final shots live in
 * `specs/082-perps-trade-view/screenshots/` and `specs/083-perps-position-management/screenshots/`.
 *
 * Self-contained upstream: the script starts a tiny STUB relay-gateway on 127.0.0.1:9797 serving
 * fixture /v1/perps/* responses, so no real gateway or venue is touched. Since spec 083 the same
 * server also answers JSON-RPC on `/rpc/<chainId>` — the management surfaces read the VENUES
 * DIRECTLY (GMX's Reader and DataStore, the Gains diamond), and a shot of a refusal is not a shot
 * of the design. Those endpoints reach the app through the spec-069 member override, seeded into
 * `fw_global_prefs.network_endpoints` before first paint; nothing else may leave the machine (a
 * catch-all route aborts every non-loopback request, so a shot can never depend on the internet).
 *
 * TWO GROUPS, TWO DEV SERVERS — because `VITE_PERPS_MANAGE_ENABLED` is folded in at build time and
 * with it OFF the Perps view must be exactly what spec 082 shipped:
 *
 *   # spec 082, read-only. The flag is absent, which is its default and its shipped state.
 *   VITE_RELAYER_URL=http://127.0.0.1:9797 npm run dev --workspace frontend -- --port 5199
 *   mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && \
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright   # once (or use a global install)
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-perps.mjs http://127.0.0.1:5199 082
 *
 *   # spec 083, position management. The flag MUST be on for this group.
 *   VITE_RELAYER_URL=http://127.0.0.1:9797 VITE_PERPS_MANAGE_ENABLED=true \
 *     npm run dev --workspace frontend -- --port 5199
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-perps.mjs http://127.0.0.1:5199 manage
 *
 * The group argument is not a convenience: each group ASSERTS the flag state it was named for (a
 * manage shot fails if no management control renders, an 082 shot fails if one does), because a
 * screenshot filed under the wrong flag is a claim about the product that is not true.
 *
 * Playwright is resolved from wherever the operator installed it, NEVER from a workspace
 * manifest — spec 075 documents why a screenshot harness does not justify lockfile exposure
 * (see capture-nav-drawer.mjs). Chromium ships at /opt/pw-browsers; CHROMIUM_PATH overrides, and
 * PLAYWRIGHT_BROWSERS_PATH points the search elsewhere (e.g. ~/.cache/ms-playwright).
 *
 * `ethers` and the app's own venue ABI modules ARE imported: they are already in the workspace, and
 * the fixture answers `eth_call` with returndata the app decodes with those same fragments. Encoding
 * a venue tuple by hand here is exactly how a fixture drifts from the contract it pretends to be.
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { AbiCoder, Interface, getAddress, keccak256 } from 'ethers'

import { GAINS_DIAMOND_ABI } from '../../frontend/src/abis/perps/gainsDiamond.js'
import { GMX_DATA_STORE_ABI } from '../../frontend/src/abis/perps/gmxDataStore.js'
import { GMX_READER_ABI } from '../../frontend/src/abis/perps/gmxReader.js'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const BASE = process.argv[2] || 'http://127.0.0.1:5199'
const GROUP = (process.argv[3] || '082').toLowerCase()
const STUB_PORT = 9797
const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`
const OUT_082 = resolve(process.cwd(), 'specs/082-perps-trade-view/screenshots')
const OUT_083 = resolve(process.cwd(), 'specs/083-perps-position-management/screenshots')

/**
 * The pre-installed Chromium; the launcher's own default would want a download.
 *
 * Both Playwright bundle layouts are accepted (`chrome-linux/` on the /opt/pw-browsers image,
 * `chrome-linux64/` on a recent `npx playwright install`) so the harness runs on either without an
 * env var. CHROMIUM_PATH still wins, and nothing here installs anything.
 */
function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  const dir = readdirSync(root).find((name) => /^chromium-\d+$/.test(name))
  if (!dir) return undefined
  const candidates = [join(root, dir, 'chrome-linux', 'chrome'), join(root, dir, 'chrome-linux64', 'chrome')]
  return candidates.find((path) => existsSync(path)) ?? candidates[0]
}

// ---- fixture gateway ----------------------------------------------------------------------------

const PAIRS = [
  ['BTC/USD', 'gains', 137, 118432.5, 0.0000072, 8_400_000, 150, null],
  ['ETH/USD', 'gains', 42161, 4180.25, -0.0000031, 5_100_000, 150, null],
  ['SOL/USD', 'gains', 8453, 212.4, 0.0000119, 1_950_000, 100, null],
  ['EUR/USD', 'gains', 42161, 1.0841, 0.0000008, 3_200_000, 1000, null],
  ['BTC/USD', 'gmx', 42161, 118431.0, 0.0000049, 82_000_000, null, null, 'WBTC.b-USDC'],
  ['ETH/USD', 'gmx', 42161, 4180.4, -0.0000021, 64_500_000, null, null, 'WETH-USDC'],
  ['LINK/USD', 'gmx', 42161, 31.85, 0.0000094, 6_800_000, null, null, 'LINK-USDC'],
  ['BTC/USD', 'hyperliquid', null, 118433.5, 0.0000125, 1_920_000_000, 40, 2_310_525_977],
  ['ETH/USD', 'hyperliquid', null, 4180.1, -0.0000063, 890_000_000, 25, 1_150_000_000],
  ['SOL/USD', 'hyperliquid', null, 212.5, 0.0000381, 310_000_000, 20, 640_000_000],
  ['DOGE/USD', 'hyperliquid', null, 0.31842, 0.0000125, 96_000_000, 10, 120_000_000],
].map(([symbol, venue, chainId, price, fundingRate, oi, maxLeverage, vol, variant], i) => ({
  id: `${venue}:${chainId ?? 'l1'}:${symbol}:${i}`,
  venue,
  chainId,
  symbol,
  base: symbol.split('/')[0],
  quote: symbol.split('/')[1],
  variant: variant ?? null,
  price,
  fundingRate,
  fundingIntervalHours: 1,
  openInterestUsd: oi,
  maxLeverage,
  volume24hUsd: vol,
}))

const SOURCES_HEALTHY = {
  gains: { status: 'read', chains: [42161, 8453, 137], stale: false },
  gmx: { status: 'read', chains: [42161], stale: false },
  hyperliquid: { status: 'read', chains: [], stale: false },
}
const SOURCES_DEGRADED = {
  ...SOURCES_HEALTHY,
  gmx: { status: 'degraded', chains: [], stale: false },
}

const CONFIG_BODY = {
  attribution: {
    gains: { referrer: '0x2222222222222222222222222222222222222222' },
    gmx: { refCode: 'fairwins' },
    hyperliquid: { builderAddress: '0x3333333333333333333333333333333333333333' },
  },
  hyperliquidBuilderFee: { bps: 5, capBps: 10, source: 'chain' },
}

/** The spec-082 positions payload, exactly as phase 0 captured it (no venueRef, no pendingOrders). */
const POSITIONS_082 = {
  positions: [
    {
      id: 'gains:42161:7',
      venue: 'gains',
      chainId: 42161,
      symbol: 'BTC/USD',
      direction: 'long',
      sizeUsd: 1000,
      collateralUsd: 100,
      entryPrice: 117210.5,
      leverage: 10,
      unrealizedPnlUsd: null,
    },
    {
      id: 'hyperliquid:ETH:short',
      venue: 'hyperliquid',
      chainId: null,
      symbol: 'ETH/USD',
      direction: 'short',
      sizeUsd: 4500,
      collateralUsd: 450,
      entryPrice: 4232.1,
      leverage: 10,
      unrealizedPnlUsd: 55.8,
    },
  ],
  sources: { gains: { status: 'read', chains: [42161] }, hyperliquid: { status: 'read', chains: [] } },
}

/* ------------------------------------------------------------------------------------------- *
 * Spec 083 fixture — the CURRENT producer shape
 *
 * Every field below exists in `services/relay-gateway/src/perps/normalize.js`, in that module's own
 * shape and units: `venueRef` with its two NAMED index spaces (`tradeIndex` / `pendingOrderIndex`,
 * never a bare `index`), `pairIndex` + `minLeverage` + `collaterals` on a Gains pair, `market` +
 * `collaterals` on a GMX one, and `pendingOrders` beside `positions` in the positions payload. A
 * field the producer does not emit is not invented here: a Gains position carries no
 * `unrealizedPnlUsd` and no `liquidationPrice`, so the sheet renders '—' for them, and that dash IS
 * the design under review. A fixture that fills them in would review a product that does not exist.
 *
 * The numbers are a member's, not a demo's: 0.37 ETH at 12.4×, $124.73 of collateral, an entry a
 * little away from the mark. Round numbers hide exactly the alignment and truncation defects these
 * screenshots exist to find.
 * ------------------------------------------------------------------------------------------- */

const USDC_ARBITRUM = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
const WETH_ARBITRUM = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const DAI_ARBITRUM = '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

/** GMX's own market tokens on Arbitrum — the address the feed publishes and a position names. */
const GMX_MARKET_ETH = '0x70d95587d40A2caf56bd97485aB3Eec10Bee6336' // ETH/USD [WETH-USDC]
const GMX_MARKET_BTC = '0x47c031236e19d024b42f8AE6780E44A573170703' // BTC/USD [WBTC.b-USDC]
const GMX_MARKET_LINK = '0x7f1fa204bb700853D36994DA19F830b6Ad18455C' // LINK/USD [LINK-USDC]

/** Gains' 1-based collateral indices, with the venue's own USD price for each. */
const GAINS_COLLATERALS = {
  42161: [
    { symbol: 'DAI', address: DAI_ARBITRUM, decimals: 18, collateralIndex: 1, usdPrice: 0.9997 },
    { symbol: 'WETH', address: WETH_ARBITRUM, decimals: 18, collateralIndex: 2, usdPrice: 4180.25 },
    { symbol: 'USDC', address: USDC_ARBITRUM, decimals: 6, collateralIndex: 3, usdPrice: 0.9999 },
  ],
  137: [{ symbol: 'USDC', address: USDC_POLYGON, decimals: 6, collateralIndex: 3, usdPrice: 0.9999 }],
  8453: [{ symbol: 'USDC', address: USDC_BASE, decimals: 6, collateralIndex: 3, usdPrice: 1.0001 }],
}

/** GMX's accepted collateral for a market is the market's own long/short token pair. */
const GMX_COLLATERALS = [
  { symbol: 'WETH', address: WETH_ARBITRUM, decimals: 18, collateralIndex: null, usdPrice: 4180.4 },
  { symbol: 'USDC', address: USDC_ARBITRUM, decimals: 6, collateralIndex: null, usdPrice: 0.9999 },
]

const MANAGE_PAIRS = [
  {
    id: 'gains:42161:ETH/USD',
    venue: 'gains',
    chainId: 42161,
    symbol: 'ETH/USD',
    base: 'ETH',
    quote: 'USD',
    group: 'crypto',
    price: 4180.25,
    fundingRate: -0.0000031,
    fundingIntervalHours: 1,
    openInterestUsd: 5_114_382,
    maxLeverage: 150,
    volume24hUsd: null,
    pairIndex: 1,
    minLeverage: 2,
    collaterals: GAINS_COLLATERALS[42161],
  },
  {
    id: 'gains:137:BTC/USD',
    venue: 'gains',
    chainId: 137,
    symbol: 'BTC/USD',
    base: 'BTC',
    quote: 'USD',
    group: 'crypto',
    price: 118_432.5,
    fundingRate: 0.0000072,
    fundingIntervalHours: 1,
    openInterestUsd: 8_412_907,
    maxLeverage: 150,
    volume24hUsd: null,
    pairIndex: 0,
    minLeverage: 2,
    collaterals: GAINS_COLLATERALS[137],
  },
  {
    id: 'gains:8453:SOL/USD',
    venue: 'gains',
    chainId: 8453,
    symbol: 'SOL/USD',
    base: 'SOL',
    quote: 'USD',
    group: 'crypto',
    price: 212.43,
    fundingRate: 0.0000119,
    fundingIntervalHours: 1,
    openInterestUsd: 1_948_236,
    maxLeverage: 100,
    volume24hUsd: null,
    pairIndex: 17,
    minLeverage: 2,
    collaterals: GAINS_COLLATERALS[8453],
  },
  {
    id: 'gains:42161:EUR/USD',
    venue: 'gains',
    chainId: 42161,
    symbol: 'EUR/USD',
    base: 'EUR',
    quote: 'USD',
    group: 'forex',
    price: 1.0841,
    fundingRate: 0.0000008,
    fundingIntervalHours: 1,
    openInterestUsd: 3_207_411,
    maxLeverage: 1000,
    volume24hUsd: null,
    pairIndex: 21,
    minLeverage: 5,
    collaterals: GAINS_COLLATERALS[42161],
  },
  {
    id: `gmx:42161:ETH/USD:${GMX_MARKET_ETH}`,
    venue: 'gmx',
    chainId: 42161,
    symbol: 'ETH/USD',
    base: 'ETH',
    quote: 'USD',
    variant: 'WETH-USDC',
    price: 4180.4,
    fundingRate: -0.0000021,
    fundingIntervalHours: 1,
    openInterestUsd: 64_517_882,
    maxLeverage: null,
    volume24hUsd: null,
    market: GMX_MARKET_ETH,
    collaterals: GMX_COLLATERALS,
  },
  {
    id: `gmx:42161:BTC/USD:${GMX_MARKET_BTC}`,
    venue: 'gmx',
    chainId: 42161,
    symbol: 'BTC/USD',
    base: 'BTC',
    quote: 'USD',
    variant: 'WBTC.b-USDC',
    price: 118_431.0,
    fundingRate: 0.0000049,
    fundingIntervalHours: 1,
    openInterestUsd: 82_046_119,
    maxLeverage: null,
    volume24hUsd: null,
    market: GMX_MARKET_BTC,
    collaterals: GMX_COLLATERALS,
  },
  {
    id: `gmx:42161:LINK/USD:${GMX_MARKET_LINK}`,
    venue: 'gmx',
    chainId: 42161,
    symbol: 'LINK/USD',
    base: 'LINK',
    quote: 'USD',
    variant: 'LINK-USDC',
    price: 31.85,
    fundingRate: 0.0000094,
    fundingIntervalHours: 1,
    openInterestUsd: 6_812_004,
    maxLeverage: null,
    volume24hUsd: null,
    market: GMX_MARKET_LINK,
    collaterals: GMX_COLLATERALS,
  },
  ...PAIRS.filter((p) => p.venue === 'hyperliquid'),
]

/** The member's Gains trade #214 on Arbitrum: 0.37 ETH long at 12.4×, no protection stored yet. */
const GAINS_ETH_LONG = {
  chainId: 42161,
  tradeIndex: 214,
  pairIndex: 1,
  collateralIndex: 3,
  collateralAmount: 124_730_000n, // 124.73 USDC, in USDC's own 6 decimals
  leverage: 12_400, // 12.4× at the venue's 1e3 scale
  long: true,
  openPrice: 41_023_700_000_000n, // 4,102.37 at the venue's 1e10 price scale
  tp: 0n, // nothing stored — the sheet suggests, and says that it is suggesting
  sl: 0n,
}

/** Trade #38 on Polygon: a BTC short with a stop the member already set at the venue. */
const GAINS_BTC_SHORT = {
  chainId: 137,
  tradeIndex: 38,
  pairIndex: 0,
  collateralIndex: 3,
  collateralAmount: 812_450_000n, // 812.45 USDC
  leverage: 6_800, // 6.8×
  long: false,
  openPrice: 1_192_841_000_000_000n, // 119,284.10
  tp: 1_098_500_000_000_000n, // 109,850.00
  sl: 1_241_200_000_000_000n, // 124,120.00
}

const GAINS_TRADES = [GAINS_ETH_LONG, GAINS_BTC_SHORT]

const MANAGE_POSITIONS = {
  positions: [
    {
      id: 'gains:42161:214',
      venue: 'gains',
      chainId: 42161,
      symbol: 'ETH/USD',
      direction: 'long',
      sizeUsd: 1546.65,
      collateralUsd: 124.73,
      entryPrice: 4102.37,
      leverage: 12.4,
      unrealizedPnlUsd: null, // the Gains backend does not report P&L on this read
      venueRef: {
        venue: 'gains',
        chainId: 42161,
        tradeIndex: 214,
        pairIndex: 1,
        collateralIndex: 3,
        collateralToken: USDC_ARBITRUM,
        collateralDecimals: 6,
        collateralPrecision: '1000000',
      },
    },
    {
      id: 'gains:137:38',
      venue: 'gains',
      chainId: 137,
      symbol: 'BTC/USD',
      direction: 'short',
      sizeUsd: 5524.66,
      collateralUsd: 812.45,
      entryPrice: 119_284.1,
      leverage: 6.8,
      unrealizedPnlUsd: null,
      venueRef: {
        venue: 'gains',
        chainId: 137,
        tradeIndex: 38,
        pairIndex: 0,
        collateralIndex: 3,
        collateralToken: USDC_POLYGON,
        collateralDecimals: 6,
        collateralPrecision: '1000000',
      },
    },
    {
      // Hyperliquid stays READ-ONLY this release (FR-021) — the row is here so the shot shows the
      // per-venue sentence beside a venue that IS manageable, which is the honesty this list turns on.
      id: 'hyperliquid:ETH:short',
      venue: 'hyperliquid',
      chainId: null,
      symbol: 'ETH/USD',
      direction: 'short',
      sizeUsd: 8412.38,
      collateralUsd: 1121.65,
      entryPrice: 4233.09,
      leverage: 7.5,
      unrealizedPnlUsd: 41.87,
    },
  ],
  /* Two orders the venue is still holding. The first is PAST its timeout — collateral in limbo, the
   * one surface that exists because a member's money is sitting somewhere they cannot see it — and
   * the second is inside the window, so the same list also shows the calm case it degrades from. */
  pendingOrders: [
    {
      id: 'gains:42161:pending:1187',
      venue: 'gains',
      chainId: 42161,
      symbol: 'ETH/USD',
      direction: 'long',
      orderType: 0, // MARKET_OPEN
      orderTypeName: 'MARKET_OPEN',
      createdBlock: 0, // filled from the chain head below — it must be older than the timeout
      timeoutBlocks: 200,
      requestedCollateralUsd: 248.6,
      requestedLeverage: 7.5,
      requestedSizeUsd: 1864.5,
      requestedPrice: 4177.91,
      venueRef: {
        venue: 'gains',
        chainId: 42161,
        pendingOrderIndex: 1187,
        // MARKET_OPEN has no trade behind it yet, and the venue zeroes `Trade.index` on the way in —
        // publishing that 0 would hand out a handle to the member's trade #0 (normalize.js).
        tradeIndex: null,
        pairIndex: 1,
        collateralIndex: 3,
        collateralToken: USDC_ARBITRUM,
        collateralDecimals: 6,
        collateralPrecision: '1000000',
      },
    },
    {
      id: 'gains:42161:pending:1192',
      venue: 'gains',
      chainId: 42161,
      symbol: 'ETH/USD',
      direction: 'long',
      orderType: 1, // MARKET_CLOSE
      orderTypeName: 'MARKET_CLOSE',
      createdBlock: 0,
      timeoutBlocks: 200,
      requestedCollateralUsd: 124.73,
      requestedLeverage: 12.4,
      requestedSizeUsd: 1546.65,
      requestedPrice: 4180.06,
      venueRef: {
        venue: 'gains',
        chainId: 42161,
        pendingOrderIndex: 1192,
        tradeIndex: 214,
        pairIndex: 1,
        collateralIndex: 3,
        collateralToken: USDC_ARBITRUM,
        collateralDecimals: 6,
        collateralPrecision: '1000000',
      },
    },
  ],
  sources: {
    gains: {
      status: 'read',
      chains: [42161, 8453, 137],
      // The pending-order facet's OWN readiness signal — `status` above is the positions facet.
      pendingOrderChains: [42161, 8453, 137],
      stale: false,
    },
    hyperliquid: { status: 'read', chains: [], stale: false },
  },
}

// ---- the venues, as the stub answers them -------------------------------------------------------

/** Mirrors `frontend/src/config/perps.js` — the addresses the app will call. */
const GAINS_DIAMOND_BY_CHAIN = {
  42161: '0xFF162c694eAA571f685030649814282eA457f169',
  8453: '0x6cD5aC19a07518A8092eEFfDA4f1174C72704eeb',
  137: '0x209A9A01980377916851af2cA075C2b170452018',
}
const GMX = {
  exchangeRouter: '0x7dE39FF2e232A2203196788d37e234cF8F1b83f1',
  router: '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6',
  reader: '0xfA26cBb46e2614609406de08CA1Dc7f70a684184',
  dataStore: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
}
const PERPS_UI_FEE_RECEIVER = '0x52502d049571C7893447b86c4d8B38e6184bF6e1'

/**
 * Per-chain chain state. The heads are what makes the stuck order stuck: `usePerpsOrders` proves a
 * timeout from createdBlock + timeoutBlocks vs the CHAIN's own head, and refuses to offer recovery
 * on anything less (a countdown from a guessed head would be a fabricated number).
 */
const CHAINS = {
  42161: { head: 402_318_744, gasPrice: 12_500_000n, timeoutBlocks: 200 },
  137: { head: 78_214_905, gasPrice: 32_400_000_000n, timeoutBlocks: 30 },
  8453: { head: 41_022_137, gasPrice: 4_310_000n, timeoutBlocks: 30 },
}

// The stuck order is 1,236 blocks past its 200-block timeout; the calm one has 153 blocks to go.
MANAGE_POSITIONS.pendingOrders[0].createdBlock = CHAINS[42161].head - 1_236
MANAGE_POSITIONS.pendingOrders[1].createdBlock = CHAINS[42161].head - 47

/** What the member holds, per token. A token absent here reads back 0 and is not offered at all. */
const BALANCES = {
  [USDC_ARBITRUM.toLowerCase()]: 4_812_370_000n, // 4,812.37 USDC
  [WETH_ARBITRUM.toLowerCase()]: 314_000_000_000_000_000n, // 0.314 WETH
  [USDC_POLYGON.toLowerCase()]: 1_204_880_000n,
  [USDC_BASE.toLowerCase()]: 96_140_000n,
}

const ABI_CODER = AbiCoder.defaultAbiCoder()
const dataStoreKey = (name) => keccak256(ABI_CODER.encode(['string'], [name]))
const uiFeeFactorKey = (account) =>
  keccak256(ABI_CODER.encode(['bytes32', 'address'], [dataStoreKey('UI_FEE_FACTOR'), getAddress(account)]))

/**
 * GMX's DataStore, as it actually answered on Arbitrum on 2026-08-12 (block 493,775,585) — the
 * values transcribed in `lib/perps/venues/gmx.js`'s own header, plus the FairWins receiver's UI-fee
 * factor of 5e26 (5 bps) that the spec-083 ops transaction set. The keeper fee IS a disclosed line
 * on the exit sheet, so this read has to answer or the shot shows a refusal instead of the design.
 */
const DATA_STORE = new Map([
  [dataStoreKey('ESTIMATED_GAS_FEE_BASE_AMOUNT_V2_1'), 207_024n],
  [dataStoreKey('ESTIMATED_GAS_FEE_PER_ORACLE_PRICE'), 525_368n],
  [dataStoreKey('ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR'), 1_584_563_439_287_042_000_000_000_000_000n],
  [dataStoreKey('INCREASE_ORDER_GAS_LIMIT'), 3_000_000n],
  [dataStoreKey('DECREASE_ORDER_GAS_LIMIT'), 3_000_000n],
  [dataStoreKey('SINGLE_SWAP_GAS_LIMIT'), 1_000_000n],
  [dataStoreKey('MAX_UI_FEE_FACTOR'), 10n ** 27n],
  [uiFeeFactorKey(PERPS_UI_FEE_RECEIVER), 5n * 10n ** 26n], // 5 bps
])

const GAINS_IFACE = new Interface(GAINS_DIAMOND_ABI)
const READER_IFACE = new Interface(GMX_READER_ABI)
const DATA_STORE_IFACE = new Interface(GMX_DATA_STORE_ABI)
const ERC20_IFACE = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
])

/** `ITradingStorage.Trade`, in the ABI's own field order. */
function gainsTradeTuple(trade, trader) {
  return [
    trader,
    trade.tradeIndex,
    trade.pairIndex,
    trade.leverage,
    trade.long,
    true, // isOpen
    trade.collateralIndex,
    0, // tradeType 0 = an open market position
    trade.collateralAmount,
    trade.openPrice,
    trade.tp,
    trade.sl,
    false, // isCounterTrade
    0n, // positionSizeToken — the venue overwrites it
    0, // __placeholder
  ]
}

/**
 * The member's one GMX position: a $3,284.51 ETH short in the WETH-USDC market.
 *
 * The Reader names a MARKET ADDRESS and nothing else — no entry, no leverage, no P&L — so the row
 * renders '—' for all of those, and the sheet prices it by matching this market against the pairs
 * feed already on screen. That is the shipped behaviour and it is what the shot must show.
 */
function gmxPositionTuple(account) {
  return [
    [account, GMX_MARKET_ETH, USDC_ARBITRUM],
    [
      3_284_510_000_000_000_000_000_000_000_000_000n, // sizeInUsd, 1e30 → $3,284.51
      785_700_000_000_000_000n, // sizeInTokens, 0.7857 ETH
      412_380_000n, // collateralAmount, 412.38 USDC
      -1_284_000_000_000_000_000_000_000_000n, // pendingImpactAmount (int256, routinely negative)
      0n,
      0n,
      0n,
      0n,
      1_754_953_128n, // increasedAtTime — seconds, not blocks
      0n,
    ],
    [false], // isLong
  ]
}

/** A minimal but complete-enough block: ethers' `getFeeData` reads `baseFeePerGas` off it. */
function blockFor(chainId) {
  const head = CHAINS[chainId].head
  const hex = (n) => `0x${BigInt(n).toString(16)}`
  return {
    number: hex(head),
    hash: `0x${'11'.repeat(32)}`,
    parentHash: `0x${'22'.repeat(32)}`,
    nonce: '0x0000000000000000',
    timestamp: hex(1_754_953_600),
    gasLimit: hex(30_000_000),
    gasUsed: hex(12_487_331),
    baseFeePerGas: hex(CHAINS[chainId].gasPrice),
    miner: '0x0000000000000000000000000000000000000000',
    extraData: '0x',
    difficulty: '0x0',
    transactions: [],
    uncles: [],
  }
}

/** `eth_call` → returndata, dispatched on the address and the selector. Unknown calls revert. */
function ethCall(chainId, params) {
  const to = String(params?.[0]?.to ?? '').toLowerCase()
  const data = String(params?.[0]?.data ?? '0x')

  if (to === GAINS_DIAMOND_BY_CHAIN[chainId]?.toLowerCase()) {
    const parsed = GAINS_IFACE.parseTransaction({ data })
    if (parsed?.name === 'getTradingActivated') return GAINS_IFACE.encodeFunctionResult('getTradingActivated', [0])
    if (parsed?.name === 'getMarketOrdersTimeoutBlocks') {
      return GAINS_IFACE.encodeFunctionResult('getMarketOrdersTimeoutBlocks', [CHAINS[chainId].timeoutBlocks])
    }
    if (parsed?.name === 'getTrade') {
      const [trader, index] = parsed.args
      const trade = GAINS_TRADES.find((t) => t.chainId === chainId && t.tradeIndex === Number(index))
      if (!trade) return null // the venue has no such trade — the app reads that as "not found"
      return GAINS_IFACE.encodeFunctionResult('getTrade', [gainsTradeTuple(trade, trader)])
    }
    if (parsed?.name === 'getTrades') {
      const [trader] = parsed.args
      const rows = GAINS_TRADES.filter((t) => t.chainId === chainId).map((t) => gainsTradeTuple(t, trader))
      return GAINS_IFACE.encodeFunctionResult('getTrades', [rows])
    }
    return null
  }

  if (chainId === 42161 && to === GMX.reader.toLowerCase()) {
    const parsed = READER_IFACE.parseTransaction({ data })
    if (parsed?.name !== 'getAccountPositions') return null
    const account = parsed.args[1]
    // The GMX position belongs to the spec-083 fixture. The spec-082 group describes a member with
    // a Gains and a Hyperliquid position and nothing else, and an empty array is GMX's own answer
    // for an account with no positions — absence, not a failed read.
    const rows = manageMode ? [gmxPositionTuple(account)] : []
    return READER_IFACE.encodeFunctionResult('getAccountPositions', [rows])
  }

  if (chainId === 42161 && to === GMX.dataStore.toLowerCase()) {
    const parsed = DATA_STORE_IFACE.parseTransaction({ data })
    if (parsed?.name !== 'getUint') return null
    // A key this fixture does not know answers 0 — which is exactly what the live store does, and
    // what `readExecutionFee` refuses to treat as "zero gas".
    return DATA_STORE_IFACE.encodeFunctionResult('getUint', [DATA_STORE.get(parsed.args[0]) ?? 0n])
  }

  // ERC-20: the collateral the open sheet offers is the collateral the member actually holds.
  const parsed = (() => {
    try {
      return ERC20_IFACE.parseTransaction({ data })
    } catch {
      return null
    }
  })()
  if (parsed?.name === 'balanceOf') {
    return ERC20_IFACE.encodeFunctionResult('balanceOf', [BALANCES[to] ?? 0n])
  }
  if (parsed?.name === 'allowance') {
    // Nothing approved yet — the first open carries an approval leg, which is the common case.
    return ERC20_IFACE.encodeFunctionResult('allowance', [0n])
  }
  return null
}

/** One JSON-RPC request → its result, or an error object. Never throws. */
function rpcResult(chainId, method, params) {
  const hex = (n) => `0x${BigInt(n).toString(16)}`
  switch (method) {
    case 'eth_chainId':
      return hex(chainId)
    case 'net_version':
      return String(chainId)
    case 'eth_blockNumber':
      return hex(CHAINS[chainId].head)
    case 'eth_getBlockByNumber':
    case 'eth_getBlockByHash':
      return blockFor(chainId)
    case 'eth_gasPrice':
      return hex(CHAINS[chainId].gasPrice)
    case 'eth_maxPriorityFeePerGas':
      return hex(CHAINS[chainId].gasPrice / 10n)
    case 'eth_feeHistory':
      return { oldestBlock: hex(CHAINS[chainId].head - 4), baseFeePerGas: [], gasUsedRatio: [], reward: [] }
    case 'eth_getLogs':
      // No GMX order history for this account in the window — the surface discloses the window
      // itself, which is a real disclosure the shot should carry.
      return []
    case 'eth_getBalance':
      return hex(1_284_000_000_000_000_000n)
    case 'eth_getTransactionCount':
      return '0x11'
    case 'eth_getCode':
      // GMX's ExchangeRouter and Router are checked for CODE — a codeless one means the pinned
      // address is stale and the venue is refused, which is not the state under review here.
      return '0x60806040'
    case 'eth_estimateGas':
      return hex(210_000)
    case 'eth_call': {
      const result = ethCall(chainId, params)
      return result ?? { error: { code: 3, message: 'execution reverted' } }
    }
    default:
      return { error: { code: -32601, message: `stub has no answer for ${method}` } }
  }
}

function rpcResponse(chainId, message) {
  const outcome = rpcResult(chainId, message?.method, message?.params)
  if (outcome && typeof outcome === 'object' && outcome.error) {
    return { jsonrpc: '2.0', id: message?.id ?? null, error: outcome.error }
  }
  return { jsonrpc: '2.0', id: message?.id ?? null, result: outcome }
}

let degradedMode = false
let manageMode = false

function readBody(req) {
  return new Promise((resolveBody) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => resolveBody(raw))
  })
}

function startStubGateway() {
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-headers', '*')
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    res.setHeader('content-type', 'application/json')
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    const url = new URL(req.url, STUB_ORIGIN)

    // JSON-RPC — the venues, reachable only because the member override points here (spec 069).
    const rpcMatch = /^\/rpc\/(\d+)$/.exec(url.pathname)
    if (rpcMatch) {
      const chainId = Number(rpcMatch[1])
      if (!CHAINS[chainId]) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'no stub chain' }))
        return
      }
      const body = await readBody(req)
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: 'bad json' }))
        return
      }
      const answer = Array.isArray(payload)
        ? payload.map((message) => rpcResponse(chainId, message))
        : rpcResponse(chainId, payload)
      res.end(JSON.stringify(answer, (_key, value) => (typeof value === 'bigint' ? `0x${value.toString(16)}` : value)))
      return
    }

    if (url.pathname === '/v1/perps/pairs') {
      const sources = degradedMode ? SOURCES_DEGRADED : SOURCES_HEALTHY
      const all = manageMode ? MANAGE_PAIRS : PAIRS
      const pairs = degradedMode ? all.filter((p) => p.venue !== 'gmx') : all
      res.end(JSON.stringify({ pairs, sources, asOf: new Date().toISOString() }))
    } else if (url.pathname === '/v1/perps/config') {
      res.end(JSON.stringify(CONFIG_BODY))
    } else if (url.pathname === '/v1/perps/positions') {
      res.end(JSON.stringify(manageMode ? MANAGE_POSITIONS : POSITIONS_082))
    } else {
      res.statusCode = 404
      res.end(JSON.stringify({ error: { code: 'not_found', reason: 'stub' } }))
    }
  })
  return new Promise((resolveStart) => server.listen(STUB_PORT, '127.0.0.1', () => resolveStart(server)))
}

// ---- capture ------------------------------------------------------------------------------------

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }

/** The RPC route the member's own settings point at, one entry per chain the venues live on. */
const MEMBER_ENDPOINTS = Object.fromEntries(
  Object.keys(CHAINS).map((chainId) => [
    chainId,
    // A failover that is also ours: without one, `resolveRpcEndpoints` puts the BUILD DEFAULT behind
    // the override, and a shot would then depend on a public endpoint being reachable.
    { url: `${STUB_ORIGIN}/rpc/${chainId}`, failoverUrl: `${STUB_ORIGIN}/rpc/${chainId}?failover=1` },
  ]),
)

/** Every item of the current attestation, acknowledged — for the shots that are not OF that gate. */
const ATTESTATION_RECORD = {
  version: 1,
  items: ['jurisdiction', 'leverage-risk', 'no-circumvention', 'venue-terms'],
  at: '2026-08-12T09:00:00.000Z',
}

/** Opens the market-controls disclosure and waits for the panel to actually mount. */
async function openFilterPanel(page) {
  await page.locator('.perps-filter-toggle').click()
  await page.waitForSelector('.perps-filter-panel', { timeout: 10000 })
}

const SHOTS_082 = [
  { name: 'perps-desktop-light', theme: 'light', viewport: DESKTOP },
  { name: 'perps-desktop-dark', theme: 'dark', viewport: DESKTOP },
  { name: 'perps-mobile-light', theme: 'light', viewport: MOBILE },
  { name: 'perps-mobile-dark', theme: 'dark', viewport: MOBILE },
  { name: 'perps-degraded-venue', theme: 'light', viewport: DESKTOP, degraded: true },

  /* The market controls (issue #1440). These three are VIEWPORT shots, not full-page ones, because
   * what is under review is exactly how much of a phone screen the controls take before the first
   * pair — a full-page shot answers a different question. */
  {
    name: 'perps-filters-open-mobile-light',
    theme: 'light',
    viewport: MOBILE,
    fullPage: false,
    prepare: openFilterPanel,
  },
  {
    name: 'perps-filters-open-mobile-dark',
    theme: 'dark',
    viewport: MOBILE,
    fullPage: false,
    prepare: openFilterPanel,
  },
  {
    /* The state the collapse had to be safe for: a filter is live and the panel is CLOSED. The
     * toggle must name it and the result count must be visible, or the short table is unexplained.
     * Both are asserted here — a shot that merely looks right would pass with neither. */
    name: 'perps-filter-active-collapsed-mobile-light',
    theme: 'light',
    viewport: MOBILE,
    fullPage: false,
    async prepare(page) {
      await openFilterPanel(page)
      await page.locator('.perps-filter-pill', { hasText: 'Hyperliquid' }).click()
      await page.locator('.perps-filter-toggle').click()
      await page.waitForSelector('.perps-filter-panel', { state: 'detached', timeout: 10000 })
      await expectText(page, '.perps-filter-toggle', /hyperliquid/i, 'the live filter, named on the closed control')
      await expectText(page, '.perps-result-count', /showing \d+ of \d+ pairs/i, 'the visible result count')
    },
  },
  {
    /* THE WIDEST SUMMARY THE CONTROL CAN CARRY, on the narrowest viewport: the longest venue label
     * and a non-default sort together. This is the shot that says whether the toolbar degrades by
     * wrapping or by eating the search field. */
    name: 'perps-filter-longest-summary-mobile-light',
    theme: 'light',
    viewport: MOBILE,
    fullPage: false,
    async prepare(page) {
      await openFilterPanel(page)
      await page.locator('.perps-filter-pill', { hasText: 'Gains Network' }).click()
      await page.locator('.perps-sort select').selectOption('funding')
      await page.locator('.perps-filter-toggle').click()
      await page.waitForSelector('.perps-filter-panel', { state: 'detached', timeout: 10000 })
      await expectText(page, '.perps-filter-toggle', /gains network/i, 'the longest venue label')
    },
  },
]

/* The management surfaces. Each scenario is captured in both themes — every one of them differs
 * between light and dark — and the two that a member meets on a phone are captured there too. */
const SCENARIOS = [
  {
    name: 'manage-positions',
    viewports: [DESKTOP, MOBILE],
    attested: true,
    fullPage: true,
    async prepare(page) {
      await page.waitForSelector('.perps-position-manage', { timeout: 20000 })
    },
  },
  {
    name: 'position-sheet-close',
    viewports: [DESKTOP, MOBILE],
    attested: true,
    // The GMX position, because GMX is the venue that charges a keeper fee — the sheet discloses it
    // as its own line, and this is the shot that shows whether that disclosure reads honestly.
    async prepare(page) {
      await openManageSheet(page, 'button.perps-position-manage[aria-label$="on GMX"]')
      await page.waitForSelector('.pps-breakdown', { timeout: 10000 })
      await expectText(page, '.pps-breakdown', /keeper fee/i, 'the GMX keeper-fee line')
    },
  },
  {
    name: 'position-sheet-reduce',
    viewports: [DESKTOP],
    attested: true,
    // The Gains long, part-closed: Gains reduces by lowering the SIZE rather than returning
    // collateral, and the sheet says so — a sentence that only exists below 100%.
    async prepare(page) {
      await openManageSheet(page, 'button.perps-position-manage[aria-label*="Long ETH/USD"]')
      await page.locator('#pps-percent-25').check()
      await page.locator('#pps-close-heading').scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'position-sheet-protect',
    viewports: [DESKTOP],
    attested: true,
    async prepare(page) {
      await openManageSheet(page, 'button.perps-position-manage[aria-label*="Long ETH/USD"]')
      // The venue holds no levels for this trade, so both fields carry the suggestion the sheet
      // derived — the smart default US2 turns on. Wait for it rather than shooting an empty field.
      await page.waitForFunction(() => document.querySelector('#pps-stop')?.value !== '', null, { timeout: 10000 })
      await scrollSheetTo(page, '.perps-position-sheet', '#pps-protect-heading')
    },
  },
  {
    // The defaults themselves: the venue picked with its reason, the direction, the collateral
    // chosen from what the member holds, and the leverage already in the field.
    name: 'open-sheet',
    viewports: [DESKTOP, MOBILE],
    attested: true,
    async prepare(page) {
      await openEntrySheet(page)
      // The amount is the ONE field the sheet cannot pre-fill — it is the member's money. Everything
      // else arrives chosen, which is what this shot judges.
      await page.locator('#pos-amount').fill('312.40')
      await scrollSheetTo(page, '.perps-open-sheet', 0)
    },
  },
  {
    // The same sheet, at the estimate — every figure labelled, and the fee lines (or their honest
    // absence: a zero rate renders no line at all).
    name: 'open-sheet-preview',
    viewports: [DESKTOP],
    attested: true,
    async prepare(page) {
      await openEntrySheet(page)
      await page.locator('#pos-amount').fill('312.40')
      await scrollSheetTo(page, '.perps-open-sheet', '#pos-preview-heading')
    },
  },
  {
    name: 'attestation',
    viewports: [DESKTOP],
    attested: false, // the gate as a member meets it before their first open — nothing pre-ticked
    async prepare(page) {
      await openEntrySheet(page)
      await page.waitForSelector('.perps-attest', { timeout: 10000 })
      await page.locator('.perps-attest').scrollIntoViewIfNeeded()
    },
  },
  {
    name: 'pending-orders-stuck',
    viewports: [DESKTOP, MOBILE],
    attested: true,
    // Element-framed rather than full-page: this section exists because collateral is sitting in
    // limbo, and it has to be judged on its own — it is the one surface that must be unmistakable.
    clip: '.perps-orders',
    async prepare(page) {
      await page.waitForSelector('.perps-orders-recover', { timeout: 20000 })
      await expectText(page, '.perps-orders', /Needs your attention/, 'the stuck-order flag')
    },
  },
]

/**
 * Scroll a sheet's OWN scroll container to a section (or to the top with 0).
 *
 * `scrollIntoViewIfNeeded` is not enough here: a heading one pixel inside the sheet's bottom edge
 * already counts as visible, so the section it names would be shot as a sliver. The sheet is the
 * scroller (`.asset-sheet` is `max-height: 85vh; overflow-y: auto`), so the offset is measured
 * against it rather than the page.
 */
async function scrollSheetTo(page, sheetSelector, target) {
  await page.evaluate(
    ({ sheetSelector: sheet, target: to }) => {
      const container = document.querySelector(sheet)
      if (!container) return
      if (to === 0) {
        container.scrollTop = 0
        return
      }
      const node = document.querySelector(to)
      if (!node) return
      container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top - 12
    },
    { sheetSelector, target },
  )
  await page.waitForTimeout(200)
}

async function openManageSheet(page, selector) {
  await page.waitForSelector(selector, { timeout: 20000 })
  await page.locator(selector).first().click()
  await page.waitForSelector('.perps-position-sheet', { timeout: 10000 })
}

async function openEntrySheet(page) {
  const selector = 'button.perps-open-btn[aria-label="Open a position on ETH/USD at Gains Network"]'
  await page.waitForSelector(selector, { timeout: 20000 })
  await page.locator(selector).click()
  await page.waitForSelector('.perps-open-sheet', { timeout: 10000 })
  // The sheet's venue/collateral defaults settle behind two live reads (venue status, balances).
  await page.waitForSelector('#pos-amount', { timeout: 15000 })
}

/** Fails LOUDLY: a screenshot of a surface that is not the one we named is worse than no shot. */
async function expectText(page, selector, pattern, what) {
  const text = await page.locator(selector).first().innerText()
  if (!pattern.test(text)) throw new Error(`expected ${what} in ${selector}, got:\n${text}`)
}

function expandScenarios() {
  const out = []
  for (const scenario of SCENARIOS) {
    for (const viewport of scenario.viewports) {
      const size = viewport === MOBILE ? 'mobile' : 'desktop'
      for (const theme of ['light', 'dark']) {
        out.push({ ...scenario, name: `perps-${scenario.name}-${size}-${theme}`, theme, viewport })
      }
    }
  }
  return out
}

async function seedPage(page, shot) {
  await page.addInitScript(
    ({ theme, endpoints, attestation }) => {
      // Pre-paint seeding: theme, the spec-007 entry gate, and the dev banner — the shot is of
      // the Perps view, not the gates in front of it.
      window.localStorage.setItem('themeMode', theme)
      window.localStorage.setItem('dev_warning_banner_dismissed', 'true')
      window.localStorage.setItem(
        'fairwins.entryGate.ack.v1',
        JSON.stringify({ at: 1754870400000, termsVersion: 'capture-harness' }),
      )
      // The member's own RPC routes (spec 069) — the ONLY supported way to point the app's reads at
      // the stub. Never a build default rewrite: `makeReadProvider` resolves member-first.
      window.localStorage.setItem('fw_global_prefs', JSON.stringify({ network_endpoints: endpoints }))
      if (attestation) {
        window.localStorage.setItem('fairwins.perps.attestation', JSON.stringify(attestation))
      } else {
        window.localStorage.removeItem('fairwins.perps.attestation')
      }

      // Minimal pre-authorized EIP-1193 + EIP-6963 wallet on Polygon so the wallet-connected
      // Trade content renders (a trimmed port of cypress mockWeb3Provider with preAuthorized).
      const ACCOUNT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
      const provider = {
        isMetaMask: true,
        selectedAddress: ACCOUNT,
        chainId: '0x89',
        _callbacks: {},
        on(event, cb) {
          ;(this._callbacks[event] = this._callbacks[event] || []).push(cb)
        },
        removeListener(event, cb) {
          this._callbacks[event] = (this._callbacks[event] || []).filter((f) => f !== cb)
        },
        request({ method }) {
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return Promise.resolve([ACCOUNT])
            case 'eth_chainId':
              return Promise.resolve('0x89')
            case 'net_version':
              return Promise.resolve('137')
            case 'eth_blockNumber':
              return Promise.resolve('0x1')
            case 'eth_getBalance':
              return Promise.resolve('0xde0b6b3a7640000')
            case 'eth_call':
            case 'eth_estimateGas':
              return Promise.resolve('0x')
            default:
              return Promise.resolve(null)
          }
        },
      }
      window.ethereum = provider
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({
              info: {
                uuid: 'c0ffee00-0000-4000-8000-000000000082',
                name: 'Capture Wallet',
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
                rdns: 'app.fairwins.capture',
              },
              provider,
            }),
          }),
        )
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    {
      theme: shot.theme,
      endpoints: MEMBER_ENDPOINTS,
      attestation: shot.attested ? ATTESTATION_RECORD : null,
    },
  )
}

/**
 * Nothing may leave this machine. Every read the app makes is either the dev server or the stub;
 * anything else is aborted so a shot can never quietly depend on a public endpoint being up (and so
 * an offline run fails fast rather than after a provider's forever-retry loop).
 */
async function isolate(context, baseOrigin) {
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(baseOrigin) || url.startsWith(STUB_ORIGIN)) return route.continue()
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
    return route.abort()
  })
}

async function main() {
  if (!['082', 'manage'].includes(GROUP)) {
    throw new Error(`unknown shot group ${JSON.stringify(GROUP)} — use "082" or "manage"`)
  }
  manageMode = GROUP === 'manage'
  const out = manageMode ? OUT_083 : OUT_082
  mkdirSync(out, { recursive: true })
  const baseOrigin = new URL(BASE).origin
  const shots = manageMode ? expandScenarios() : SHOTS_082
  const stub = await startStubGateway()
  const browser = await chromium.launch({ executablePath: chromiumExecutable() })
  try {
    for (const shot of shots) {
      await captureShot(browser, baseOrigin, out, shot)
    }
  } finally {
    await browser.close()
    stub.close()
  }
}

/**
 * One shot, with ONE retry on a transient failure.
 *
 * A dev server under HMR occasionally re-mounts the view mid-wait, and losing a twenty-shot run to
 * that is a bad tool. The retry is deliberately narrow: it rebuilds the context and repeats the
 * same scenario, so a REAL failure (the flag assertion, a missing keeper-fee line) fails twice and
 * still stops the run. It never softens an assertion — a shot is written or the script exits.
 */
async function captureShot(browser, baseOrigin, out, shot) {
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await captureOnce(browser, baseOrigin, out, shot)
      return
    } catch (error) {
      lastError = error
      if (attempt === 0) console.warn(`retrying ${shot.name}: ${error?.message?.split('\n')[0] ?? error}`)
    }
  }
  throw lastError
}

async function captureOnce(browser, baseOrigin, out, shot) {
  degradedMode = Boolean(shot.degraded)
  const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2 })
  try {
    await isolate(context, baseOrigin)
    const page = await context.newPage()
    await seedPage(page, shot)
    {
      // domcontentloaded, not networkidle — the app polls external price feeds that never settle
      // (and are unreachable in a sandboxed run); the selector wait below is the real readiness.
      await page.goto(`${BASE}/wallet?tab=trade&view=perps`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.perps-view', { timeout: 30000 })

      /* THE ONE THING HIDDEN, AND WHY. The spec-031 activity poller reads FairWins' own contracts
       * on every cohort chain; this harness has no chain behind them, so it raises "Couldn't
       * refresh some activity" over the top-right corner. That toast is an artifact of the fixture,
       * not of the surface under review, and it lands on top of the sheets. Nothing else is hidden:
       * every perps surface renders its own refusals inline, so no perps state can be suppressed
       * here by accident. */
      await page.addStyleTag({ content: '.notification[role="alert"] { display: none !important; }' })

      /* THE FLAG ASSERTION. `VITE_PERPS_MANAGE_ENABLED` is folded in at build time, so a run against
       * the wrong dev server would silently file a management screenshot as the read-only surface,
       * or the reverse. Neither is a mistake a reviewer can catch from the PNG. */
      if (manageMode) {
        await page.waitForSelector('.perps-position-manage', { timeout: 20000 })
      } else if (
        // The negative half has to wait for the list to EXIST first, or it passes on a page that
        // simply had not rendered the positions yet — an assertion that cannot fail is not one.
        (await page.waitForSelector('.perps-position-row', { timeout: 20000 })) &&
        (await page.locator('.perps-position-manage').count())
      ) {
        throw new Error(
          'a management control rendered in the spec-082 group — this dev server has ' +
            'VITE_PERPS_MANAGE_ENABLED=true; restart it without the flag',
        )
      }

      if (shot.prepare) await shot.prepare(page)
      // Let fonts/badges settle before the shot.
      await page.waitForTimeout(500)
      const path = join(out, `${shot.name}.png`)
      if (shot.clip) {
        // One section, framed on its own.
        await page.locator(shot.clip).first().screenshot({ path })
      } else {
        // A sheet is a fixed-position modal capped at 85vh: a full-page shot would paint it once
        // over a tall page. Those are captured as the member sees them — the viewport.
        await page.screenshot({ path, fullPage: Boolean(shot.fullPage ?? !manageMode) })
      }
      console.log(`captured ${shot.name}.png`)
    }
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
