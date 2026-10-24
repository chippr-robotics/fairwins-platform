/**
 * TradePanel × token news (spec 109 US2): one card PER LEG so a pair with one covered and one
 * uncovered token renders labelled partial coverage — never a silently completed feed — and the
 * feed is ADVISORY ONLY (FR-006): no news state disables, delays or alters the swap form.
 *
 * The hook stack is the hermetic TradePanel.test.jsx mock set; the news seam
 * (lib/news/newsClient#fetchTokenNews) is mocked per leg, exactly as TokenNewsCard.test.jsx does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

const {
  mockUseDex,
  mockUseWallet,
  mockUseChainTokens,
  mockUseActiveAccount,
  mockUseSwapBalances,
  switchChainAsync,
  mockFetchTokenNews,
} = vi.hoisted(() => ({
  mockUseDex: vi.fn(),
  mockUseWallet: vi.fn(),
  mockUseChainTokens: vi.fn(),
  mockUseActiveAccount: vi.fn(),
  mockUseSwapBalances: vi.fn(),
  switchChainAsync: vi.fn().mockResolvedValue({}),
  mockFetchTokenNews: vi.fn(),
}))

vi.mock('../../hooks/useDex', () => ({ useDex: mockUseDex }))
vi.mock('../../hooks', () => ({ useWallet: mockUseWallet }))
vi.mock('../../hooks/useChainTokens', () => ({ useChainTokens: mockUseChainTokens }))
vi.mock('../../hooks/useActiveAccount', () => ({ useActiveAccount: mockUseActiveAccount }))
vi.mock('../../hooks/useSwapBalances', () => ({ useSwapBalances: mockUseSwapBalances }))
vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync, isPending: false }),
}))
vi.mock('../../lib/news/newsClient', () => ({
  fetchTokenNews: (...args) => mockFetchTokenNews(...args),
}))

import TradePanel from '../../components/fairwins/TradePanel'

// Real Polygon config addresses — the default pair on a 137 wallet is WPOL → USDC.
const WPOL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

const SAMPLE_QUOTE = {
  chainId: 137,
  amountOut: '1.23',
  amountOutWei: 1230000n,
  feeTier: 3000,
  gasEstimate: 0n,
  executionPrice: '1.23',
  executionPriceInverted: '0.813008',
  minimumReceived: '1.22385',
  minimumReceivedWei: 1223850n,
  priceImpactPercent: 0.42,
  tokenInSymbol: 'WPOL',
  tokenOutSymbol: 'USDC',
}

const NEWS_ITEM = {
  id: '1',
  title: 'POL headline from the wire',
  url: 'https://news.example/pol',
  source: { name: 'Example Wire', slug: 'example' },
  publishedAt: new Date(Date.now() - 3600_000).toISOString(),
  sentiment: 0,
}

function polygonDex(overrides = {}) {
  return {
    loading: false,
    quotingPrice: false,
    wrapNative: vi.fn(),
    unwrapNative: vi.fn(),
    swap: vi.fn().mockResolvedValue({}),
    getBestQuoteOn: vi.fn().mockResolvedValue(SAMPLE_QUOTE),
    slippage: 50,
    setSlippage: vi.fn(),
    isDexAvailable: true,
    dexProvider: { name: 'Uniswap', url: 'https://app.uniswap.org/swap?chain=polygon' },
    network: { name: 'Polygon', chainId: 137 },
    tradingAddress: '0x1111222233334444555566667777888899990000',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUseWallet.mockReturnValue({
    isConnected: true,
    chainId: 137,
    address: '0x1111222233334444555566667777888899990000',
  })
  mockUseChainTokens.mockReturnValue({ native: 'POL', stable: 'USDC' })
  mockUseDex.mockReturnValue(polygonDex())
  mockUseActiveAccount.mockReturnValue({
    identity: { mode: 'personal' },
    isVault: false,
    isLegacy: false,
    canActAsVault: false,
    submit: vi.fn(),
    operateAsPersonal: vi.fn(),
    operateAsVault: vi.fn(),
  })
  mockUseSwapBalances.mockReturnValue({
    balances: { [WPOL.toLowerCase()]: '5', [USDC.toLowerCase()]: '100' },
    loading: false,
    refresh: vi.fn(),
  })
})

describe('TradePanel — token news per leg (spec 109 US2)', () => {
  it('renders one card per leg; a mapped and an unmapped leg are labelled separately', async () => {
    // Pay leg (WPOL) is covered; receive leg (USDC) is simulated uncovered — the pair must
    // show labelled partial coverage, not one silently merged feed.
    mockFetchTokenNews.mockImplementation(async ({ address }) => {
      if (address && address.toLowerCase() === WPOL.toLowerCase()) {
        return { state: 'read', items: [NEWS_ITEM], fetchedAt: null, stale: false }
      }
      return { state: 'not-covered' }
    })
    render(<TradePanel />)

    const cards = await waitFor(() => {
      const found = document.querySelectorAll('.trade-news .token-news-card')
      expect(found).toHaveLength(2)
      return found
    })

    // The covered leg carries its items; the uncovered leg carries the honest absence
    // sentence naming ITS asset. Neither statement leaks onto the other card.
    expect(
      within(cards[0]).getByRole('link', { name: NEWS_ITEM.title }),
    ).toHaveAttribute('href', NEWS_ITEM.url)
    expect(within(cards[1]).getByText('No news source covers USDC.')).toBeInTheDocument()
    expect(within(cards[1]).queryByRole('link', { name: NEWS_ITEM.title })).toBeNull()

    // Each leg was asked about on its own identity — never one merged query.
    const asked = mockFetchTokenNews.mock.calls.map(([args]) => args.address)
    expect(asked).toContain(WPOL)
    expect(asked).toContain(USDC)
  })

  it('an unreadable feed never disables or delays the swap form (FR-006)', async () => {
    mockFetchTokenNews.mockResolvedValue({ state: 'unreadable', reason: 'gateway_unreachable' })
    const getBestQuoteOn = vi.fn().mockResolvedValue(SAMPLE_QUOTE)
    mockUseDex.mockReturnValue(polygonDex({ getBestQuoteOn }))
    render(<TradePanel />)

    // Both cards say the feed could not be read…
    expect(await screen.findAllByText('The news feed could not be read right now.')).toHaveLength(2)

    // …while the ticket quotes and offers the order exactly as if news did not exist.
    const payInput = screen.getByLabelText('You pay')
    expect(payInput).not.toBeDisabled()
    fireEvent.change(payInput, { target: { value: '1' } })
    await waitFor(() => expect(getBestQuoteOn).toHaveBeenCalledWith(137, WPOL, USDC, '1'))
    expect(await screen.findByRole('button', { name: /Swap WPOL for USDC/ })).toBeInTheDocument()
  })

  it('news that is off (not-configured) renders no card and leaves the ticket untouched', async () => {
    mockFetchTokenNews.mockResolvedValue({ state: 'not-configured' })
    render(<TradePanel />)

    await waitFor(() => expect(mockFetchTokenNews).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(document.querySelectorAll('.trade-news .token-news-card')).toHaveLength(0),
    )
    expect(screen.getByLabelText('You pay')).not.toBeDisabled()
  })
})
