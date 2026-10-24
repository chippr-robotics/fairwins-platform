/**
 * Asset taxonomy registry (spec 044) — classification config tests.
 * Pure config: no chain reads, no context mocking needed.
 */
import { describe, it, expect } from 'vitest'
import {
  TAXONOMY_CATEGORIES,
  CLASSIFICATION_SOURCES,
  SEC_COMMODITY_BASELINE,
  getPortfolioRegistry,
  getPortfolioChainIds,
  getTaxonomyCategory,
} from '../../config/assetTaxonomy'
import { listSupportedChainIds, NETWORKS } from '../../config/networks'

const REGULATORY_IDS = [
  'digital-commodities',
  'digital-securities',
  'payment-stablecoins',
  'digital-tools',
  'digital-collectibles',
]

describe('TAXONOMY_CATEGORIES', () => {
  it('defines the five regulatory categories plus unclassified, in display order', () => {
    expect(TAXONOMY_CATEGORIES.map((c) => c.id)).toEqual([...REGULATORY_IDS, 'unclassified'])
    const orders = TAXONOMY_CATEGORIES.map((c) => c.order)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    expect(TAXONOMY_CATEGORIES.at(-1).id).toBe('unclassified')
  })

  it('gives every category a member-facing description and label', () => {
    for (const cat of TAXONOMY_CATEGORIES) {
      expect(cat.label).toBeTruthy()
      expect(cat.description.length).toBeGreaterThan(40)
    }
  })

  it('getTaxonomyCategory falls back to unclassified for unknown ids', () => {
    expect(getTaxonomyCategory('digital-tools').id).toBe('digital-tools')
    expect(getTaxonomyCategory('nonsense').id).toBe('unclassified')
    expect(getTaxonomyCategory(undefined).id).toBe('unclassified')
  })
})

describe('getPortfolioChainIds', () => {
  it('scans mainnets only by default (incl. the spec-067 bridge networks)', () => {
    // Optimism (10), Base (8453) and Arbitrum (42161) join as first-class value
    // networks in spec 067 (FR-006b) — a member must be able to SEE what they
    // bridged, so portfolio inclusion is part of offering the route at all.
    expect(new Set(getPortfolioChainIds())).toEqual(new Set([1, 10, 61, 137, 8453, 42161]))
  })

  it('adds Sepolia, Hoodi, Amoy, and Mordor when testnets are enabled', () => {
    // Hoodi (560048) joins the Ethereum family testnets (spec 048).
    expect(new Set(getPortfolioChainIds({ includeTestnets: true }))).toEqual(
      new Set([1, 10, 61, 137, 8453, 42161, 11155111, 560048, 80002, 63]),
    )
  })

  it('orders mainnets before testnets and never includes local sandboxes', () => {
    const ids = getPortfolioChainIds({ includeTestnets: true })
    expect(ids).not.toContain(1337)
    const testnetFlags = ids.map((id) => Boolean(NETWORKS[id].isTestnet))
    expect(testnetFlags.indexOf(true)).toBeGreaterThanOrEqual(testnetFlags.lastIndexOf(false))
  })
})

describe('getPortfolioRegistry', () => {
  it('returns [] for unknown chain ids (drives the unsupported-network state)', () => {
    expect(getPortfolioRegistry(999999)).toEqual([])
    expect(getPortfolioRegistry(undefined)).toEqual([])
  })

  it.each(listSupportedChainIds())('chain %s: entries are scoped, unique, and valid', (chainId) => {
    const registry = getPortfolioRegistry(chainId)
    expect(registry.length).toBeGreaterThan(0)

    const ids = registry.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)

    for (const entry of registry) {
      // FR-007: every entry carries the queried chain, never another one.
      expect(entry.chainId).toBe(chainId)
      expect(['native', 'erc20', 'nft']).toContain(entry.kind)
      expect(CLASSIFICATION_SOURCES).toContain(entry.source)
      // Every referenced category exists (unclassified included).
      expect(getTaxonomyCategory(entry.categoryId).id).toBe(entry.categoryId)
      if (entry.kind === 'native') {
        expect(entry.address).toBeNull()
      } else {
        expect(entry.address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      }
      if (entry.kind === 'erc20') expect(entry.decimals).toBeGreaterThan(0)
    }
  })

  it.each(listSupportedChainIds())('chain %s: has a native entry', (chainId) => {
    const native = getPortfolioRegistry(chainId).find((e) => e.kind === 'native')
    expect(native).toBeTruthy()
    expect(native.id).toBe('native')
    expect(native.symbol).toBe(NETWORKS[chainId].nativeCurrency.symbol)
  })

  it('classifies baseline natives and wrapped natives as SEC-baseline commodities', () => {
    for (const chainId of [137, 63]) {
      const registry = getPortfolioRegistry(chainId)
      const native = registry.find((e) => e.kind === 'native')
      expect(SEC_COMMODITY_BASELINE).toContain(native.symbol)
      expect(native.categoryId).toBe('digital-commodities')
      expect(native.source).toBe('sec-baseline')
    }
    const wmatic = getPortfolioRegistry(137).find((e) => e.symbol === 'WPOL')
    expect(wmatic.categoryId).toBe('digital-commodities')
    expect(wmatic.source).toBe('sec-baseline')
  })

  it('maps the configured stablecoin to payment-stablecoins via app-config', () => {
    const usdc = getPortfolioRegistry(137).find(
      (e) => e.address?.toLowerCase() === NETWORKS[137].stablecoin.address.toLowerCase(),
    )
    expect(usdc.categoryId).toBe('payment-stablecoins')
    expect(usdc.source).toBe('app-config')

    const usc = getPortfolioRegistry(63).find((e) => e.symbol === 'USC')
    expect(usc.categoryId).toBe('payment-stablecoins')
    expect(usc.source).toBe('app-config')
  })

  it('lists the MembershipVoucher credential as a digital-tools NFT where deployed', () => {
    const voucher = getPortfolioRegistry(137).find((e) => e.kind === 'nft')
    expect(voucher).toBeTruthy()
    expect(voucher.symbol).toBe('FWMV')
    expect(voucher.categoryId).toBe('digital-tools')
    expect(voucher.source).toBe('app-config')
    expect(voucher.decimals).toBeNull()
  })

  it('includes curated Polygon entries with their curated classifications', () => {
    const registry = getPortfolioRegistry(137)
    const bySymbol = Object.fromEntries(registry.map((e) => [e.symbol, e]))
    expect(bySymbol.LINK.categoryId).toBe('digital-tools')
    expect(bySymbol.LINK.source).toBe('curated-registry')
    expect(bySymbol.USDT.categoryId).toBe('payment-stablecoins')
    expect(bySymbol.USDT.source).toBe('curated-registry')
  })

  it('includes the newly curated tokens on mainnet, each with a valid address/decimals', () => {
    const registry = getPortfolioRegistry(1)
    const bySymbol = Object.fromEntries(registry.map((e) => [e.symbol, e]))
    const expected = {
      MORPHO: 'digital-securities',
      GRT: 'digital-tools',
      UNI: 'digital-securities',
      AAVE: 'digital-securities',
      LINK: 'digital-tools',
      ENS: 'digital-tools',
      BAT: 'digital-tools',
      WBTC: 'digital-commodities',
      PYUSD: 'payment-stablecoins',
      FIDD: 'payment-stablecoins',
    }
    for (const [symbol, categoryId] of Object.entries(expected)) {
      expect(bySymbol[symbol], `${symbol} missing from mainnet registry`).toBeTruthy()
      expect(bySymbol[symbol].categoryId).toBe(categoryId)
      expect(bySymbol[symbol].address).toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(bySymbol[symbol].decimals).toBeGreaterThan(0)
    }
    // WBTC wraps the SEC-baseline BTC commodity, so baseline precedence wins.
    expect(bySymbol.WBTC.source).toBe('sec-baseline')
  })

  it('includes the newly curated tokens on Polygon that have an established bridged deployment', () => {
    const registry = getPortfolioRegistry(137)
    const bySymbol = Object.fromEntries(registry.map((e) => [e.symbol, e]))
    for (const symbol of ['GRT', 'BAT', 'UNI', 'AAVE']) {
      expect(bySymbol[symbol], `${symbol} missing from Polygon registry`).toBeTruthy()
      expect(bySymbol[symbol].address).toMatch(/^0x[0-9a-fA-F]{40}$/)
    }
    // No official Polygon deployment of the MORPHO governance token, ENS, PYUSD, or FIDD.
    for (const symbol of ['MORPHO', 'ENS', 'PYUSD', 'FIDD']) {
      expect(bySymbol[symbol]).toBeUndefined()
    }
  })

  it('covers Sepolia: baseline-commodity native ETH plus Circle USDC', () => {
    const registry = getPortfolioRegistry(11155111)
    const native = registry.find((e) => e.kind === 'native')
    expect(native.symbol).toBe('ETH')
    expect(native.categoryId).toBe('digital-commodities')
    expect(native.source).toBe('sec-baseline')
    const usdc = registry.find((e) => e.symbol === 'USDC')
    expect(usdc.categoryId).toBe('payment-stablecoins')
    expect(usdc.source).toBe('app-config')
  })

  it('scans canonical WETH on Ethereum mainnet despite no dex/wmatic config', () => {
    // Chain 1 has dex: null and no wmatic deployment record — the curated
    // layer must still surface the wrapped form of its baseline commodity.
    const weth = getPortfolioRegistry(1).find((e) => e.symbol === 'WETH')
    expect(weth).toBeTruthy()
    expect(weth.categoryId).toBe('digital-commodities')
    expect(weth.source).toBe('sec-baseline')
  })

  it('applies source precedence: SEC baseline outranks curated data (FR-006)', () => {
    // WETH/WBTC ship in the curated layer but wrap baseline commodities —
    // the baseline classification and source must win.
    const registry = getPortfolioRegistry(137)
    for (const symbol of ['WETH', 'WBTC']) {
      const entry = registry.find((e) => e.symbol === symbol)
      expect(entry.categoryId).toBe('digital-commodities')
      expect(entry.source).toBe('sec-baseline')
    }
  })

  it('never leaks Polygon addresses into the ETC-family registries (SC-004)', () => {
    const polygonAddresses = new Set(
      getPortfolioRegistry(137)
        .filter((e) => e.address)
        .map((e) => e.address.toLowerCase()),
    )
    for (const chainId of [63, 61]) {
      for (const entry of getPortfolioRegistry(chainId)) {
        if (!entry.address) continue
        expect(polygonAddresses.has(entry.address.toLowerCase())).toBe(false)
      }
    }
  })
})
