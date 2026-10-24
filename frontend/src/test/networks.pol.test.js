/**
 * MATIC → POL migration (release 1.14.0, task 6).
 *
 * Polygon migrated its native gas token: chain 137's native currency is POL
 * (wrapped form: WPOL) and Amoy's testnet gas token followed. The CONTRACT
 * ADDRESSES did not move — the canonical wrapper at
 * 0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270 was renamed on-chain
 * (WMATIC → WPOL), and the Chainlink feed at
 * 0xAB594600376Ec9fD91F8e885dADF0CE036862dE0 now serves POL/USD. These tests
 * pin the rebrand: symbols move, addresses stay, and non-Polygon chains keep
 * their own symbols.
 */
import { describe, it, expect } from 'vitest'
import { NETWORKS } from '../config/networks'
import { getWrappedNative } from '../config/wrappedNative'
import { CHAINLINK_FEEDS } from '../config/priceFeeds'
import { getPortfolioRegistry } from '../config/assetTaxonomy'

describe('Polygon native currency is POL (MATIC rebrand)', () => {
  it('names chain 137’s native currency POL', () => {
    expect(NETWORKS[137].nativeCurrency.symbol).toBe('POL')
    expect(NETWORKS[137].nativeCurrency.name).toBe('POL')
    expect(NETWORKS[137].nativeCurrency.decimals).toBe(18)
  })

  it('names Polygon Amoy (80002)’s native currency POL too', () => {
    expect(NETWORKS[80002].nativeCurrency.symbol).toBe('POL')
    expect(NETWORKS[80002].nativeCurrency.name).toBe('POL')
  })

  it('leaves every non-Polygon chain’s symbol alone', () => {
    expect(NETWORKS[1].nativeCurrency.symbol).toBe('ETH')
    expect(NETWORKS[61].nativeCurrency.symbol).toBe('ETC')
    expect(NETWORKS[63].nativeCurrency.symbol).toBe('ETC')
    expect(NETWORKS[10].nativeCurrency.symbol).toBe('ETH')
    expect(NETWORKS[8453].nativeCurrency.symbol).toBe('ETH')
    expect(NETWORKS[42161].nativeCurrency.symbol).toBe('ETH')
  })

  it('resolves the wrapped native on 137 as WPOL at the UNCHANGED address', () => {
    const wrapped = getWrappedNative(137)
    expect(wrapped.symbol).toBe('WPOL')
    expect(wrapped.name).toBe('Wrapped POL')
    // The rebrand renamed the token, not the contract.
    expect(wrapped.address).toBe('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270')
    expect(wrapped.decimals).toBe(18)
  })

  it('keys the Polygon native price feed under POL at the unchanged feed address', () => {
    // The Chainlink "MATIC/USD" aggregator on Polygon serves POL/USD since the
    // migration; the address stays, the symbol key moves so POL underlyings
    // resolve a price.
    expect(CHAINLINK_FEEDS[137].POL).toBe('0xAB594600376Ec9fD91F8e885dADF0CE036862dE0')
    expect(CHAINLINK_FEEDS[137].MATIC).toBeUndefined()
  })

  it('scans the Polygon portfolio with a POL native underlying and a WPOL wrapped form', () => {
    const registry = getPortfolioRegistry(137)
    const native = registry.find((e) => e.kind === 'native')
    expect(native.symbol).toBe('POL')
    expect(native.baselineSymbol).toBe('POL')
    // POL sits on the SEC commodity baseline exactly as MATIC did.
    expect(native.categoryId).toBe('digital-commodities')

    const wrapped = registry.find((e) => e.symbol === 'WPOL')
    expect(wrapped).toBeTruthy()
    expect(wrapped.address).toBe('0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270')
    expect(wrapped.baselineSymbol).toBe('POL')
  })
})
