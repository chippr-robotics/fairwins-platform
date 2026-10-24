/**
 * lib/portfolio/prices (spec 044 v1.2, FR-022) — on-chain price ladder tests.
 * The chain read seam (spec 110 Phase 1) is stubbed with an address-keyed fixture registry.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchPortfolioPrices, priceSourceLabel, underlyingSymbolOf } from '../../lib/portfolio/prices'
import { CHAINLINK_FEEDS } from '../../config/priceFeeds'
import { getPortfolioRegistry } from '../../config/assetTaxonomy'
import { NETWORKS } from '../../config/networks'

// addressLower -> methods object. Semicolon required: vitest's hoisting
// transform concatenates this with the vi.mock call below.
const contracts = vi.hoisted(() => new Map());

vi.mock('../../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (_chainId, { address, functionName, args = [] }) => {
      const fixture = contracts.get(String(address).toLowerCase())
      if (!fixture || typeof fixture[functionName] !== 'function') {
        throw new Error('no fixture')
      }
      return fixture[functionName](...args)
    },
  }
})

const NOW = 1_800_000_000
const Q96 = 2 ** 96

function feedFixture(priceUsd, { updatedAt = NOW - 60, decimals = 8 } = {}) {
  const answer = BigInt(Math.round(priceUsd * 10 ** decimals))
  return {
    latestRoundData: () => Promise.resolve([1n, answer, 0n, BigInt(updatedAt), 1n]),
    decimals: () => Promise.resolve(BigInt(decimals)),
  }
}

function setFeed(chainId, symbol, fixture) {
  contracts.set(CHAINLINK_FEEDS[chainId][symbol].toLowerCase(), fixture)
}

// ETC-family DEX fixture: WETC/USC pool on chain 61 (canonical dex config in
// networks.js). token0 = WETC (18 dec), token1 = USC (6 dec).
const ETC_DEX = NETWORKS[61].dex
const WETC = ETC_DEX.wnative.toLowerCase()
const USC = NETWORKS[61].stablecoin.address.toLowerCase()
const POOL_ADDRESS = '0x00000000000000000000000000000000000000AA'

function setEtcPool(priceUsdPerWetc, { wetcIsToken0 = true } = {}) {
  const rawRatio = wetcIsToken0
    ? priceUsdPerWetc * 10 ** (6 - 18) // token1(USC raw) per token0(WETC raw)
    : (1 / priceUsdPerWetc) * 10 ** (18 - 6)
  const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(rawRatio) * Q96))
  contracts.set(ETC_DEX.factory.toLowerCase(), {
    getPool: (a, b, fee) =>
      Promise.resolve(fee === 500 ? '0x0000000000000000000000000000000000000000' : POOL_ADDRESS),
  })
  contracts.set(POOL_ADDRESS.toLowerCase(), {
    slot0: () => Promise.resolve([sqrtPriceX96, 0n]),
    token0: () => Promise.resolve(wetcIsToken0 ? WETC : USC),
    liquidity: () => Promise.resolve(10n ** 18n),
  })
}

const registry = [...getPortfolioRegistry(137), ...getPortfolioRegistry(61), ...getPortfolioRegistry(1)]
const providers = new Map([
  [137, { chainId: 137 }],
  [61, { chainId: 61 }],
  [1, { chainId: 1 }],
])

beforeEach(() => {
  contracts.clear()
})

describe('underlyingSymbolOf', () => {
  it('maps wrapped forms to their underlying and plain tokens to themselves', () => {
    expect(underlyingSymbolOf({ symbol: 'WETH', baselineSymbol: 'ETH' })).toBe('ETH')
    expect(underlyingSymbolOf({ symbol: 'LINK' })).toBe('LINK')
  })
})

describe('fetchPortfolioPrices', () => {
  it('prices baseline assets from Chainlink feeds (highest trust)', async () => {
    setFeed(137, 'POL', feedFixture(0.52))
    setFeed(137, 'ETH', feedFixture(2358.22))
    setFeed(137, 'BTC', feedFixture(64000))
    setFeed(137, 'LINK', feedFixture(14.5))

    const prices = await fetchPortfolioPrices(providers, registry, NOW)
    expect(prices.get('POL')).toMatchObject({ usd: 0.52, source: 'chainlink', chainId: 137 })
    expect(prices.get('ETH').usd).toBeCloseTo(2358.22)
    expect(prices.get('BTC').usd).toBeCloseTo(64000)
    expect(prices.get('LINK').usd).toBeCloseTo(14.5)
  })

  it('never prices stablecoins or collectibles', async () => {
    setFeed(137, 'POL', feedFixture(0.52))
    const prices = await fetchPortfolioPrices(providers, registry, NOW)
    for (const symbol of ['USDC', 'USDT', 'USC', 'FWMV']) {
      expect(prices.has(symbol)).toBe(false)
    }
  })

  it('rejects stale feed answers instead of presenting them as current', async () => {
    setFeed(137, 'ETH', feedFixture(2358.22, { updatedAt: NOW - 25 * 60 * 60 }))
    const prices = await fetchPortfolioPrices(providers, registry, NOW)
    expect(prices.has('ETH')).toBe(false)
  })

  it('rejects non-positive feed answers', async () => {
    setFeed(137, 'BTC', feedFixture(-1))
    const prices = await fetchPortfolioPrices(providers, registry, NOW)
    expect(prices.has('BTC')).toBe(false)
  })

  it('falls back to DEX pool spot where no feed exists (ETC via WETC/USC)', async () => {
    setEtcPool(15)
    const prices = await fetchPortfolioPrices(providers, registry, NOW)
    const etc = prices.get('ETC')
    expect(etc.source).toBe('dex')
    expect(etc.chainId).toBe(61)
    expect(etc.usd).toBeCloseTo(15, 1)
  })

  it('handles the stablecoin being token0 in the pool (inverse ratio)', async () => {
    setEtcPool(15, { wetcIsToken0: false })
    const prices = await fetchPortfolioPrices(providers, registry, NOW)
    expect(prices.get('ETC').usd).toBeCloseTo(15, 1)
  })

  it('keeps precision for full-magnitude sqrtPriceX96 values (uint160 ≫ 2^53)', async () => {
    // USC as token0 with a high WETC price ⇒ sqrtPriceX96 ≈ 1.8e33, far
    // beyond Number.MAX_SAFE_INTEGER — the BigInt path must stay accurate.
    setEtcPool(2000, { wetcIsToken0: false })
    const prices = await fetchPortfolioPrices(providers, registry, NOW)
    const usd = prices.get('ETC').usd
    expect(Math.abs(usd - 2000) / 2000).toBeLessThan(1e-6)
  })

  it('leaves assets unpriced when neither source resolves', async () => {
    const prices = await fetchPortfolioPrices(providers, registry, NOW)
    expect(prices.size).toBe(0)
  })
})

describe('priceSourceLabel', () => {
  it('names the source and network for provenance display', () => {
    expect(priceSourceLabel({ source: 'chainlink', chainId: 137 })).toBe('Chainlink oracle (Polygon)')
    expect(priceSourceLabel({ source: 'dex', chainId: 61 })).toBe('DEX pool spot (Ethereum Classic)')
    expect(priceSourceLabel(null)).toBeNull()
  })
})
