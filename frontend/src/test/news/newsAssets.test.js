/**
 * Asset→news-slug mapping tests (spec 109 FR-004): identity from the canonical registry, null for
 * everything unmapped, Bitcoin string ids never entering EVM seams.
 */
import { describe, it, expect } from 'vitest'
import { newsSlugFor } from '../../config/newsAssets'
import { getPortfolioRegistry } from '../../config/assetTaxonomy'

describe('newsSlugFor', () => {
  it('maps chain natives through the baseline-underlying enum', () => {
    expect(newsSlugFor({ chainId: 137 })).toBe('matic-network')
    expect(newsSlugFor({ chainId: 61 })).toBe('ethereum-classic')
    expect(newsSlugFor({ chainId: 1 })).toBe('ethereum')
  })

  it('maps Bitcoin string network ids directly — no registry, no EVM seam', () => {
    expect(newsSlugFor({ chainId: 'bitcoin' })).toBe('bitcoin')
    expect(newsSlugFor({ chainId: 'bitcoin-testnet' })).toBe('bitcoin')
  })

  it('resolves a curated registry ERC-20 by its canonical record, case-insensitively', () => {
    const usdc = getPortfolioRegistry(137).find((e) => e.symbol === 'USDC')
    // The registry curates USDC on Polygon; if that ever changes this test should notice.
    expect(usdc).toBeTruthy()
    expect(newsSlugFor({ chainId: 137, address: usdc.address })).toBe('usd-coin')
    expect(newsSlugFor({ chainId: 137, address: usdc.address.toUpperCase().replace('0X', '0x') })).toBe('usd-coin')
  })

  it('maps the wrapped native to the SAME underlying as the native coin', () => {
    const wrapped = getPortfolioRegistry(137).find((e) => e.baselineSymbol === 'POL' && e.kind === 'erc20')
    if (wrapped) {
      expect(newsSlugFor({ chainId: 137, address: wrapped.address })).toBe('matic-network')
    }
    expect(newsSlugFor({ chainId: 137, address: 'native' })).toBe('matic-network')
  })

  it('answers null for an address the registry does not know — a lookalike ticker never maps', () => {
    // A random address is not in the registry, whatever its on-chain symbol claims to be.
    expect(newsSlugFor({ chainId: 137, address: '0x' + 'ab'.repeat(20) })).toBeNull()
  })

  it('answers null for unknown chains and malformed input — never a guess', () => {
    expect(newsSlugFor({ chainId: 999999 })).toBeNull()
    expect(newsSlugFor({ chainId: '137' })).toBeNull() // numeric chains are numbers, not strings
    expect(newsSlugFor()).toBeNull()
  })
})
