/**
 * The wrapped-native resolver (config/wrappedNative.js).
 *
 * Wrapping sends a member's coin to whatever address this returns, so the two properties worth
 * pinning are about what it will NOT do:
 *
 *   1. It never invents an address. A chain the app has no wrapped-coin configuration for reports
 *      `null`, and the Wrap view says so — a plausible-looking canonical address nobody here
 *      verified is exactly the kind of guess that loses funds.
 *   2. It agrees with the portfolio. The registry used to derive the wrapped coin itself, from the
 *      same two sources in the same order; both now read this resolver, so a chain can no longer be
 *      wrappable on one surface and absent from the other.
 */
import { describe, it, expect } from 'vitest'
import { getWrappedNative, hasWrappedNative, listWrappableCoins } from '../../config/wrappedNative'
import { NETWORKS, cohortChainIds, isInCohort } from '../../config/networks'
import { getContractAddressForChain } from '../../config/contracts'
import { getPortfolioRegistry } from '../../config/assetTaxonomy'

const POLYGON = 137
const MORDOR = 63
const SEPOLIA = 11155111

describe('getWrappedNative', () => {
  it('resolves the DEX config’s wrapped coin where the network has one', () => {
    const wrapped = getWrappedNative(POLYGON)
    expect(wrapped.address).toBe(NETWORKS[POLYGON].dex.wnative)
    expect(wrapped.chainId).toBe(POLYGON)
    expect(wrapped.decimals).toBe(NETWORKS[POLYGON].nativeCurrency.decimals)
  })

  it('falls back to the synced deployment record when the network has no DEX config', () => {
    // Mordor builds its DEX block from env vars and yields null when they are unset (the test
    // build's state), which is precisely the case the fallback exists for.
    expect(NETWORKS[MORDOR].dex).toBeNull()
    expect(getWrappedNative(MORDOR).address).toBe(getContractAddressForChain('wmatic', MORDOR))
  })

  it('labels the coin from the network’s own native currency', () => {
    const wrapped = getWrappedNative(MORDOR)
    expect(wrapped.symbol).toBe(`W${NETWORKS[MORDOR].nativeCurrency.symbol}`)
    expect(wrapped.name).toBe(`Wrapped ${NETWORKS[MORDOR].nativeCurrency.name}`)
  })

  it('reports null — never a guess — for a network with no configured wrapper', () => {
    expect(NETWORKS[SEPOLIA].dex).toBeNull()
    expect(getContractAddressForChain('wmatic', SEPOLIA)).toBeUndefined()
    expect(getWrappedNative(SEPOLIA)).toBeNull()
    expect(hasWrappedNative(SEPOLIA)).toBe(false)
  })

  it('reports null for an unknown chain instead of throwing', () => {
    expect(getWrappedNative(424242)).toBeNull()
    expect(getWrappedNative(undefined)).toBeNull()
  })
})

describe('the portfolio and the Wrap view see the same token', () => {
  it.each([POLYGON, MORDOR])('chain %i', (chainId) => {
    const wrapped = getWrappedNative(chainId)
    const registryEntry = getPortfolioRegistry(chainId).find(
      (a) => a.address && a.address.toLowerCase() === wrapped.address.toLowerCase(),
    )
    expect(registryEntry).toBeDefined()
    expect(registryEntry.symbol).toBe(wrapped.symbol)
    expect(registryEntry.decimals).toBe(wrapped.decimals)
  })

  it('leaves the registry without a wrapped entry where there is nothing to wrap', () => {
    const symbols = getPortfolioRegistry(SEPOLIA).map((a) => a.symbol)
    expect(symbols).not.toContain(`W${NETWORKS[SEPOLIA].nativeCurrency.symbol}`)
  })
})

describe('listWrappableCoins (spec 108) — the picker’s candidate list', () => {
  it('is exactly the cohort chains whose wrapper the resolver answers for', () => {
    const listed = listWrappableCoins().map((c) => c.chainId)
    const expected = cohortChainIds().filter((id) => hasWrappedNative(id))
    expect(listed.sort()).toEqual(expected.map(Number).sort())
    // A chain with no configured wrapper is ABSENT, never a disabled row: there is no
    // address to disable honestly.
    expect(listed).not.toContain(SEPOLIA)
  })

  it('never crosses the build’s cohort', () => {
    for (const coin of listWrappableCoins()) {
      expect(isInCohort(coin.chainId), `chain ${coin.chainId}`).toBe(true)
    }
  })

  it('carries the resolver’s own wrapped twin verbatim, never a re-derivation', () => {
    for (const coin of listWrappableCoins()) {
      expect(coin.wrapped).toEqual(getWrappedNative(coin.chainId))
      expect(coin.kind).toBe('native')
      expect(coin.symbol).toBe(NETWORKS[coin.chainId].nativeCurrency.symbol)
      expect(coin.networkName).toBe(NETWORKS[coin.chainId].name)
    }
  })

  it('keys are stable and unique', () => {
    const keys = listWrappableCoins().map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const key of keys) expect(key).toMatch(/^native:\d+$/)
  })
})
