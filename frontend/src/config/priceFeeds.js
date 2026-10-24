/**
 * Verifiable on-chain price sources for the portfolio (spec 044 v1.2, FR-022).
 *
 * Layered per underlying asset symbol:
 *   1. Chainlink AggregatorV3 feeds — decentralized oracle network, the
 *      highest-trust source. Canonical Polygon mainnet feed addresses from
 *      https://docs.chain.link/data-feeds/price-feeds/addresses (network:
 *      Polygon). Override per feed via env if a feed migrates.
 *   2. DEX pool spot — Uniswap V3 (or ETCswap V3) pool of the asset vs the
 *      network's configured stablecoin, read from slot0 (see
 *      lib/portfolio/prices.js). Used where no Chainlink feed exists
 *      (e.g. the ETC family).
 *
 * Stablecoins are valued at par $1 (app-wide convention) and are not listed
 * here. Assets with neither source stay honestly unpriced.
 */

// chainId → underlying symbol → AggregatorV3 address (all */USD, 8 decimals).
export const CHAINLINK_FEEDS = {
  1: {
    // Canonical Ethereum mainnet feeds (spec 048). Ethereum mainnet has no in-app
    // `dex` config, so the DEX-spot fallback cannot run there — these feeds are the
    // required price source for native ETH and WETH (WETH resolves via the ETH
    // underlying; WBTC resolves via the BTC underlying). Stablecoins (USDC/USDT/DAI/
    // PYUSD/FIDD) value at par $1 and are not listed. GRT and MORPHO have no
    // established mainnet USD feed at add-time and stay honestly unpriced there.
    ETH: import.meta.env?.VITE_FEED_MAINNET_ETH_USD || '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419',
    BTC: import.meta.env?.VITE_FEED_MAINNET_BTC_USD || '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c',
    LINK: import.meta.env?.VITE_FEED_MAINNET_LINK_USD || '0x2c1d072e956AFFC0D435Cb7AC38EF18d24d9127c',
    UNI: import.meta.env?.VITE_FEED_MAINNET_UNI_USD || '0x553303d460EE0afB37EdFf9be42922D8FF63220e',
    AAVE: import.meta.env?.VITE_FEED_MAINNET_AAVE_USD || '0x547a514d5e3769680Ce22B2361c10Ea13619e8a9',
    BAT: import.meta.env?.VITE_FEED_MAINNET_BAT_USD || '0x9441D7556e7820B5cA42082cfa99487D56AcA958',
    ENS: import.meta.env?.VITE_FEED_MAINNET_ENS_USD || '0x5C00128d4d1c2F4f652C267d7bcdD7aC99C16E16',
  },
  137: {
    // POL/USD. This is the aggregator Chainlink originally listed as MATIC/USD;
    // since Polygon's MATIC → POL migration it serves the POL price at the SAME
    // address, so only the symbol key moved (the portfolio's Polygon native
    // underlying is POL now and must resolve here). Legacy env override name
    // still honoured so an existing deployment's pin keeps working.
    POL:
      import.meta.env?.VITE_FEED_POLYGON_POL_USD ||
      import.meta.env?.VITE_FEED_POLYGON_MATIC_USD ||
      '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0',
    ETH: import.meta.env?.VITE_FEED_POLYGON_ETH_USD || '0xF9680D99D6C9589e2a93a78A04A279e509205945',
    BTC: import.meta.env?.VITE_FEED_POLYGON_BTC_USD || '0xc907E116054Ad103354f2D350FD2514433D57F6f',
    LINK: import.meta.env?.VITE_FEED_POLYGON_LINK_USD || '0xd9FFdb71EbE7496cC440152d43986Aae0AB76665',
  },
}

// A feed answer older than this is treated as unavailable rather than
// presented as current (honest-state rule).
export const FEED_MAX_AGE_SECONDS = 24 * 60 * 60

// Uniswap V3 fee tiers probed (most-liquid-first) when resolving a DEX spot
// pool for an asset vs the network stablecoin.
export const DEX_SPOT_FEE_TIERS = [500, 3000, 10000]
