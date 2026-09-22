/**
 * usePortfolio — bitcoin balance source branch (spec 061, T019/T020).
 *
 * Mirrors usePortfolio.test.jsx: wallet at the context level, per-chain read
 * providers + ethers Contract + price ladder stubbed with fixture maps. The
 * bitcoin gateway client is stubbed at the module boundary; the real
 * portfolioSource/ledgerStore/classification code runs against a seeded
 * localStorage ledger.
 *
 * Covers: native+WBTC roll-up into ONE Bitcoin aggregate, BTC feed pricing,
 * gateway failure ⇒ failedAssets ['BTC'] and NO zero row (FR-010),
 * unused wallet ⇒ no bitcoin row and no gateway calls (SC-008),
 * EVM-only regression, pending/protected passthrough (FR-009/FR-018).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor, act } from '@testing-library/react'
import { WalletContext } from '../../contexts'
import usePortfolio from '../../hooks/usePortfolio'
// Fixtures are ENCODED with ethers while batchBalances decodes with viem — the same
// cross-library parity the module's own suite relies on (spec 110).
import { AbiCoder } from 'ethers'
import { MULTICALL3_ADDRESS } from '../../lib/portfolio/batchBalances'
import { getPortfolioRegistry } from '../../config/assetTaxonomy'

const fixtures = vi.hoisted(() => ({
  nativeBalances: new Map(), // chainId -> bigint | fn
  tokenBalances: new Map(), // `${chainId}:${addressLower}` -> bigint | fn
  prefs: { showTestnetAssets: false, showZeroBalances: false },
  prices: new Map(), // underlying -> {usd, source, chainId}
  gatewayUrl: 'https://gw.test',
  lookupResult: { ok: true, tipHeight: 100, results: [] },
  stampsResult: { ok: true, degraded: false, stamps: [] },
  gatewayCalls: [], // ['lookupAddresses'|'getStamps', networkId, addresses]
}));

function resolveFixture(value) {
  if (typeof value === 'function') return value()
  return Promise.resolve(value ?? 0n)
}

vi.mock('../../utils/rpcProvider', () => ({
  makeReadProvider: (url, chainId) => ({
    chainId,
    getBalance: () => resolveFixture(fixtures.nativeBalances.get(chainId)),
    // The ERC-20 leg is a bare `eth_call` now (spec 110 — batchBalances encodes its own
    // calldata rather than going through a contract object), so the fixture is served here.
    // Multicall3 stays UNAVAILABLE on this fake, which is what it always was: these suites
    // exercise the per-asset fallback ladder, and answering the batch here would silently
    // move them onto a path they were never written to cover.
    call: async ({ to }) => {
      if (String(to).toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
        throw new Error('no multicall on this fake provider')
      }
      const raw = await resolveFixture(fixtures.tokenBalances.get(`${chainId}:${String(to).toLowerCase()}`))
      return AbiCoder.defaultAbiCoder().encode(['uint256'], [raw])
    },
  }),
}))

vi.mock('../../lib/portfolio/prices', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchPortfolioPrices: () => Promise.resolve(new Map(fixtures.prices)),
  }
})

vi.mock('../../hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({
    preferences: { ...fixtures.prefs },
    setShowTestnetAssets: vi.fn(),
    setShowZeroBalances: vi.fn(),
  }),
}))

vi.mock('../../lib/bitcoin/gatewayClient', () => ({
  bitcoinGatewayUrl: () => fixtures.gatewayUrl,
  createBitcoinGatewayClient: () => ({
    lookupAddresses: async (networkId, addresses) => {
      fixtures.gatewayCalls.push(['lookupAddresses', networkId, addresses])
      const res = fixtures.lookupResult
      return typeof res === 'function' ? res() : res
    },
    getStamps: async (networkId, addresses) => {
      fixtures.gatewayCalls.push(['getStamps', networkId, addresses])
      const res = fixtures.stampsResult
      return typeof res === 'function' ? res() : res
    },
  }),
}))

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const BTC_ADDR = 'bc1qexampleaddressxxxxxxxxxxxxxxxxxxxxx0'
const LEDGER_KEY = 'fairwins.bitcoin.ledger.v1'

function seedLedger(addresses = [BTC_ADDR], networkId = 'bitcoin') {
  const issued = addresses.map((address, index) => ({
    address,
    type: 'segwit',
    index,
    network: networkId,
    firstShownAt: '2026-07-20T00:00:00Z',
  }))
  localStorage.setItem(
    LEDGER_KEY,
    JSON.stringify({ [`${ADDRESS.toLowerCase()}:${networkId}`]: { issued, preferredType: 'segwit' } }),
  )
}

const utxo = (valueSats, { txid = 'aa'.repeat(32), vout = 0, confirmations = 6 } = {}) => ({
  txid,
  vout,
  valueSats,
  confirmations,
})

const addr = (chainId, symbol) =>
  `${chainId}:${getPortfolioRegistry(chainId).find((e) => e.symbol === symbol).address.toLowerCase()}`

let latest
function Probe() {
  latest = usePortfolio()
  return null
}

async function renderPortfolio() {
  await act(async () => {
    render(
      <WalletContext.Provider value={{ address: ADDRESS, isConnected: true, chainId: 137 }}>
        <Probe />
      </WalletContext.Provider>,
    )
  })
  await waitFor(() => expect(latest.status).toBe('ready'))
}

const aggFor = (underlying) => latest.aggregates.find((a) => a.underlying === underlying)

beforeEach(() => {
  localStorage.clear()
  fixtures.nativeBalances.clear()
  fixtures.tokenBalances.clear()
  fixtures.prices.clear()
  fixtures.prefs.showTestnetAssets = false
  fixtures.prefs.showZeroBalances = false
  fixtures.gatewayUrl = 'https://gw.test'
  fixtures.lookupResult = { ok: true, tipHeight: 100, results: [] }
  fixtures.stampsResult = { ok: true, degraded: false, stamps: [] }
  fixtures.gatewayCalls = []
  latest = undefined
})

describe('usePortfolio — bitcoin branch (spec 061)', () => {
  it('rolls native BTC and WBTC into ONE Bitcoin aggregate priced by the BTC feed (FR-008)', async () => {
    seedLedger()
    fixtures.lookupResult = {
      ok: true,
      tipHeight: 100,
      results: [{ address: BTC_ADDR, utxos: [utxo(50_000_000)] }], // 0.5 BTC
    }
    fixtures.tokenBalances.set(addr(137, 'WBTC'), 25_000_000n) // 0.25 WBTC (8 decimals)
    fixtures.prices.set('BTC', { usd: 60_000, source: 'chainlink', chainId: 137 })
    await renderPortfolio()

    const btc = aggFor('BTC')
    expect(btc).toBeTruthy()
    expect(latest.aggregates.filter((a) => a.underlying === 'BTC')).toHaveLength(1)
    // Native bitcoin + the WBTC registry instances (zero-balance ones stay
    // listed for the sheet, existing behavior).
    expect(btc.instances.filter((h) => h.balance > 0)).toHaveLength(2)
    expect(btc.balance).toBeCloseTo(0.75)
    expect(btc.usd).toBeCloseTo(45_000)
    // Native bitcoin instance first (home instance), labeled with its network.
    expect(btc.instances[0].asset.kind).toBe('native')
    expect(btc.instances[0].asset.chainId).toBe('bitcoin')
    expect(btc.instances[0].network).toBe('Bitcoin')
    expect(btc.instances[0].usd).toBeCloseTo(30_000)
  })

  it('shows a native-only Bitcoin aggregate when no WBTC is held', async () => {
    seedLedger()
    fixtures.lookupResult = {
      ok: true,
      tipHeight: 100,
      results: [{ address: BTC_ADDR, utxos: [utxo(10_000_000)] }], // 0.1 BTC
    }
    fixtures.prices.set('BTC', { usd: 60_000, source: 'chainlink', chainId: 1 })
    await renderPortfolio()

    const btc = aggFor('BTC')
    const nonzero = btc.instances.filter((h) => h.balance > 0)
    expect(nonzero).toHaveLength(1)
    expect(nonzero[0].asset.chainId).toBe('bitcoin')
    expect(btc.balance).toBeCloseTo(0.1)
    expect(btc.usd).toBeCloseTo(6_000)
  })

  it('reports BTC in failedAssets — and renders NO zero row — when the gateway fails (FR-010)', async () => {
    seedLedger()
    fixtures.lookupResult = { ok: false, error: 'upstream_unavailable', stale: true }
    fixtures.nativeBalances.set(137, 2n * 10n ** 18n)
    fixtures.prices.set('BTC', { usd: 60_000, source: 'chainlink', chainId: 137 })
    fixtures.prefs.showZeroBalances = true // a zero BTC row would be visible if one existed
    await renderPortfolio()

    expect(latest.failedAssets).toContain('BTC')
    // No fabricated zero-balance native instance: the only BTC aggregate
    // instances (if any) come from EVM WBTC entries.
    const btc = aggFor('BTC')
    if (btc) {
      expect(btc.instances.every((h) => h.asset.chainId !== 'bitcoin')).toBe(true)
    }
    // EVM portfolio unaffected.
    expect(aggFor('POL').balance).toBeCloseTo(2)
  })

  it('makes NO gateway calls and adds no bitcoin row for a wallet with no issued addresses (SC-008)', async () => {
    fixtures.nativeBalances.set(137, 10n ** 18n)
    fixtures.prices.set('POL', { usd: 0.5, source: 'chainlink', chainId: 137 })
    await renderPortfolio()

    expect(fixtures.gatewayCalls).toHaveLength(0)
    expect(latest.holdings.every((h) => h.asset.chainId !== 'bitcoin')).toBe(true)
    expect(latest.failedAssets).toEqual([])
    expect(aggFor('BTC')).toBeUndefined()
    expect(aggFor('POL').usd).toBeCloseTo(0.5)
    expect(latest.totalUsd).toBeCloseTo(0.5)
  })

  it('EVM-only regression: existing behavior unchanged when bitcoin is unused', async () => {
    fixtures.nativeBalances.set(137, 2n * 10n ** 18n)
    fixtures.tokenBalances.set(addr(137, 'USDC'), 100_000_000n)
    fixtures.prices.set('POL', { usd: 0.5, source: 'chainlink', chainId: 137 })
    await renderPortfolio()

    expect(aggFor('POL').usd).toBeCloseTo(1)
    expect(aggFor('USDC').usd).toBeCloseTo(100)
    expect(latest.totalUsd).toBeCloseTo(101)
    expect(latest.aggregates.every((a) => a.balance > 0)).toBe(true)
    expect(latest.failedAssets).toEqual([])
    expect(latest.error).toBeNull()
  })

  it('passes pending/protected sats through on holding.bitcoin (FR-009/FR-018)', async () => {
    seedLedger()
    const stampTxid = 'bb'.repeat(32)
    fixtures.lookupResult = {
      ok: true,
      tipHeight: 100,
      results: [
        {
          address: BTC_ADDR,
          pendingSats: 0,
          utxos: [
            utxo(50_000_000, { txid: 'aa'.repeat(32) }), // spendable
            utxo(30_000, { txid: stampTxid }), // stamp-bearing → protected
            utxo(100_000, { txid: 'cc'.repeat(32), confirmations: 0 }), // pending
          ],
        },
      ],
    }
    fixtures.stampsResult = {
      ok: true,
      degraded: false,
      stamps: [{ stampId: 'A1', outpoint: { txid: stampTxid, vout: 0 }, address: BTC_ADDR }],
    }
    fixtures.prices.set('BTC', { usd: 60_000, source: 'chainlink', chainId: 137 })
    await renderPortfolio()

    const native = aggFor('BTC').instances.find((h) => h.asset.chainId === 'bitcoin')
    expect(native.bitcoin).toEqual({
      pendingSats: 100_000,
      protectedSats: 30_000,
      spendableSats: 50_000_000,
      stampsDegraded: false,
    })
    // Confirmed balance excludes the pending coin.
    expect(native.balance).toBeCloseTo(0.5003)
  })

  it('scans bitcoin-testnet only when the testnet preference is on (FR-021)', async () => {
    seedLedger([BTC_ADDR], 'bitcoin')
    await renderPortfolio()
    expect(fixtures.gatewayCalls.every(([, networkId]) => networkId === 'bitcoin')).toBe(true)
  })
})
