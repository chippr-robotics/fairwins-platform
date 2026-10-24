/**
 * Verifiable on-chain USD prices for portfolio assets (spec 044 v1.2, FR-022).
 *
 * Resolution ladder per underlying symbol (ETH, BTC, POL, ETC, LINK, …):
 *   1. Chainlink AggregatorV3 feed (config/priceFeeds.js) — rejected when the
 *      answer is non-positive or older than FEED_MAX_AGE_SECONDS.
 *   2. DEX pool spot: the asset's representative ERC-20 vs the network's
 *      stablecoin on that chain's configured Uniswap-V3-style DEX, from the
 *      pool's slot0 sqrtPriceX96 (stablecoin at par $1).
 *
 * Stablecoins are valued at par elsewhere and never priced here. A symbol
 * with no resolvable source is simply absent from the result — the caller
 * renders it unpriced rather than inventing a value.
 */
import { readContract } from '../chains/readContract'
import { AGGREGATOR_V3_ABI } from '../../abis/AggregatorV3'
import { UNISWAP_V3_FACTORY_ABI, UNISWAP_V3_POOL_ABI } from '../../abis/UniswapV3PoolReader'
import { CHAINLINK_FEEDS, FEED_MAX_AGE_SECONDS, DEX_SPOT_FEE_TIERS } from '../../config/priceFeeds'
import { NETWORKS } from '../../config/networks'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
// sqrtPriceX96 is a uint160 — far beyond Number.MAX_SAFE_INTEGER — so the
// squaring happens in BigInt and only the final scaled ratio is converted.
// RATIO_SCALE keeps 27 significant decimal digits through the conversion;
// raw ratios below 1e-27 (no real pool) round to 0 and are rejected.
const Q192 = 1n << 192n
const RATIO_SCALE = 10n ** 27n

export function underlyingSymbolOf(asset) {
  return (asset.baselineSymbol || asset.symbol || '').toUpperCase()
}

async function readChainlinkUsd(chainId, feedAddress, nowSeconds) {
  const view = (functionName) =>
    readContract(chainId, { address: feedAddress, abi: AGGREGATOR_V3_ABI, functionName })
  const [roundData, decimals] = await Promise.all([view('latestRoundData'), view('decimals')])
  const answer = roundData[1]
  const updatedAt = Number(roundData[3])
  if (answer <= 0n) throw new Error('non-positive feed answer')
  if (nowSeconds - updatedAt > FEED_MAX_AGE_SECONDS) throw new Error('stale feed answer')
  return Number(answer) / 10 ** Number(decimals)
}

/**
 * Spot price of `token` in the stablecoin (≈USD), from the most liquid
 * existing pool across the probed fee tiers. Returns null when no pool
 * exists or the pool is empty.
 */
async function readDexSpotUsd(chainId, dex, token, stable) {
  for (const fee of DEX_SPOT_FEE_TIERS) {
    let poolAddress
    try {
      poolAddress = await readContract(chainId, {
        address: dex.factory,
        abi: UNISWAP_V3_FACTORY_ABI,
        functionName: 'getPool',
        args: [token.address, stable.address, fee],
      })
    } catch {
      continue
    }
    if (!poolAddress || poolAddress === ZERO_ADDRESS) continue
    try {
      const poolView = (functionName) =>
        readContract(chainId, { address: poolAddress, abi: UNISWAP_V3_POOL_ABI, functionName })
      const [slot0, token0, liquidity] = await Promise.all([
        poolView('slot0'),
        poolView('token0'),
        poolView('liquidity'),
      ])
      if (liquidity === 0n) continue
      const sqrtPriceX96 = BigInt(slot0[0])
      if (sqrtPriceX96 === 0n) continue
      // rawRatio = raw token1 per raw token0 = sqrtPriceX96² / 2¹⁹². Human
      // price of our token in the stablecoin:
      // token0 → rawRatio·10^(dTok−dStable); token1 → (1/rawRatio)·10^(dTok−dStable).
      const rawRatio = Number((sqrtPriceX96 * sqrtPriceX96 * RATIO_SCALE) / Q192) / 1e27
      if (rawRatio === 0) continue
      const tokenIsToken0 = token0.toLowerCase() === token.address.toLowerCase()
      const price =
        (tokenIsToken0 ? rawRatio : 1 / rawRatio) * 10 ** (token.decimals - stable.decimals)
      if (Number.isFinite(price) && price > 0) return price
    } catch {
      continue
    }
  }
  return null
}

// The ERC-20 stand-in used to price an underlying on a DEX chain: the
// wrapped native for the chain's own gas asset, else a registry token whose
// underlying matches (e.g. WETH pricing ETH).
function dexCandidateFor(underlying, chainId, registryEntries) {
  return registryEntries.find(
    (e) =>
      e.chainId === chainId &&
      e.kind === 'erc20' &&
      e.categoryId !== 'payment-stablecoins' &&
      underlyingSymbolOf(e) === underlying,
  )
}

/**
 * Resolve USD prices for every non-stablecoin underlying in the registry.
 *
 * @param {Map<number, object>} providers - the readable-chain roster; only its KEYS are used
 *   (spec 110 Phase 1 — reads route through the chain seam; the values are legacy providers
 *   callers still construct during the transition)
 * @param {Array} registryEntries - combined per-chain registry entries in scope
 * @param {number} [nowSeconds] - clock for feed staleness checks (testable)
 * @returns {Promise<Map<string, {usd: number, source: string, chainId: number}>>}
 */
export async function fetchPortfolioPrices(providers, registryEntries, nowSeconds = Math.floor(Date.now() / 1000)) {
  const prices = new Map()
  const underlyings = new Set(
    registryEntries
      .filter((e) => e.categoryId !== 'payment-stablecoins' && e.kind !== 'nft')
      .map((e) => underlyingSymbolOf(e))
      .filter(Boolean),
  )

  // 1. Chainlink feeds (highest trust), all fetched concurrently.
  const feedJobs = []
  for (const [chainIdKey, feeds] of Object.entries(CHAINLINK_FEEDS)) {
    const chainId = Number(chainIdKey)
    if (!providers.has(chainId)) continue
    for (const [symbol, feedAddress] of Object.entries(feeds)) {
      if (!underlyings.has(symbol) || prices.has(symbol)) continue
      feedJobs.push(
        readChainlinkUsd(chainId, feedAddress, nowSeconds)
          .then((usd) => ({ symbol, usd, chainId }))
          .catch(() => null),
      )
    }
  }
  for (const result of await Promise.all(feedJobs)) {
    if (result && !prices.has(result.symbol)) {
      prices.set(result.symbol, { usd: result.usd, source: 'chainlink', chainId: result.chainId })
    }
  }

  // 2. DEX pool spot for whatever is still unpriced, chain by chain.
  for (const underlying of underlyings) {
    if (prices.has(underlying)) continue
    for (const chainIdKey of providers.keys()) {
      const chainId = Number(chainIdKey)
      const net = NETWORKS[chainId]
      if (!net?.dex || !net?.stablecoin?.address) continue
      const candidate = dexCandidateFor(underlying, chainId, registryEntries)
      if (!candidate) continue
      try {
        const usd = await readDexSpotUsd(chainId, net.dex, candidate, net.stablecoin)
        if (usd != null) {
          prices.set(underlying, { usd, source: 'dex', chainId })
          break
        }
      } catch {
        /* try the next chain */
      }
    }
  }

  return prices
}

// Member-facing names for price provenance (shown in the asset sheet).
export function priceSourceLabel(entry) {
  if (!entry) return null
  const network = NETWORKS[entry.chainId]?.name || `chain ${entry.chainId}`
  if (entry.source === 'chainlink') return `Chainlink oracle (${network})`
  if (entry.source === 'dex') return `DEX pool spot (${network})`
  return null
}
