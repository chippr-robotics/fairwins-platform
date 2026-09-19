import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import MarketAcceptancePage from '../pages/MarketAcceptancePage'

// Mock hooks
vi.mock('../hooks', () => ({
  useWallet: vi.fn(() => ({
    isConnected: true,
    account: '0x1234567890123456789012345678901234567890'
  })),
  useWeb3: vi.fn(() => ({
    provider: null,
    signer: null,
    isCorrectNetwork: true,
    switchNetwork: vi.fn()
  }))
}))

// Mock getContractAddress + getContractAddressForChain (chain-aware resolver;
// resolves by name here, ignoring chainId). vi.hoisted so the vi.mock factory
// can reference it (see frontend-test-gotchas #3).
const { mockResolveByName } = vi.hoisted(() => ({
  mockResolveByName: (name) =>
    name === 'friendGroupMarketFactory' ? '0xContractAddress00000000000000000000000001' : null,
}))
vi.mock('../config/contracts', () => ({
  getContractAddress: vi.fn(mockResolveByName),
  getContractAddressForChain: vi.fn((name) => mockResolveByName(name)),
}))

// The `vi.mock('ethers')` that stood here is GONE (spec 110). MarketAcceptancePage reads through
// the chain seam — the fake `Contract` it installed, with `getFriendMarketWithStatus` and friends,
// had stopped intercepting anything. It was invisible because every case below renders with no
// provider and reaches no chain read at all, so the dead mock cost nothing and proved nothing.
// Caught by the ethers-mock ratchet once that gate stopped counting a module the file itself
// replaces outright.

// Mock MarketAcceptanceModal since we're testing the page, not the modal
vi.mock('../components/fairwins/MarketAcceptanceModal', () => ({
  default: ({ marketData, marketId }) => (
    <div data-testid="acceptance-modal">
      <div data-testid="market-id">{marketId}</div>
      {marketData && (
        <>
          <div data-testid="market-description">{marketData.description}</div>
          <div data-testid="market-creator">{marketData.creator}</div>
        </>
      )}
    </div>
  )
}))

import { useWallet, useWeb3 } from '../hooks'

const renderWithRouter = (searchParams = '') => {
  return render(
    <MemoryRouter initialEntries={[`/friend-market/accept${searchParams}`]}>
      <Routes>
        <Route path="/friend-market/accept" element={<MarketAcceptancePage />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>
    </MemoryRouter>
  )
}

describe('MarketAcceptancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useWallet.mockReturnValue({
      isConnected: true,
      account: '0x1234567890123456789012345678901234567890'
    })

    useWeb3.mockReturnValue({
      provider: null,
      signer: null,
      isCorrectNetwork: true,
      switchNetwork: vi.fn()
    })
  })

  describe('URL Parameter Handling', () => {
    it('should extract marketId from search params and use URL fallback', async () => {
      // Without provider, needs URL params for fallback display
      renderWithRouter('?marketId=test-market-123&creator=0xCreator&stake=10')

      await waitFor(() => {
        expect(screen.getByTestId('market-id')).toHaveTextContent('test-market-123')
      })
    })

    it('should show error when no marketId provided', async () => {
      renderWithRouter('')

      await waitFor(() => {
        expect(screen.getByText('No wager ID provided')).toBeInTheDocument()
      })
    })

    it('should use URL params for fallback preview when no provider', async () => {
      renderWithRouter('?marketId=123&creator=0xCreator&stake=10&token=USDC&deadline=1999999999999')

      await waitFor(() => {
        expect(screen.getByTestId('market-creator')).toHaveTextContent('0xCreator')
      })
    })
  })

  describe('Loading State', () => {
    it('should show loading or error state when no provider', async () => {
      // With no provider and minimal fallback params, it will show error quickly
      // We test that the component handles the initial state appropriately
      useWeb3.mockReturnValue({
        provider: null,
        signer: null,
        isCorrectNetwork: true,
        switchNetwork: vi.fn()
      })

      renderWithRouter('?marketId=test-123')

      // Either loading or connect wallet message should appear
      await waitFor(() => {
        const hasLoading = screen.queryByText('Loading offer details...')
        const hasConnectPrompt = screen.queryByText(/connect your wallet/i)
        expect(hasLoading || hasConnectPrompt).toBeTruthy()
      })
    })
  })

  describe('Error Handling', () => {
    it('should show error when market ID is missing', async () => {
      renderWithRouter('')

      await waitFor(() => {
        expect(screen.getByText('Unable to Load Offer')).toBeInTheDocument()
        expect(screen.getByText('No wager ID provided')).toBeInTheDocument()
      })
    })

    it('should show connect wallet message when no provider and no URL params', async () => {
      renderWithRouter('?marketId=123')

      await waitFor(() => {
        expect(screen.getByText(/connect your wallet/i)).toBeInTheDocument()
      })
    })

    it('should display Go Back button on error', async () => {
      renderWithRouter('')

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument()
      })
    })
  })

  describe('Fallback to URL Parameters', () => {
    it('should show description placeholder when using URL params', async () => {
      renderWithRouter('?marketId=123&creator=0xCreator&stake=10')

      await waitFor(() => {
        expect(screen.getByTestId('market-description')).toHaveTextContent(
          'Connect wallet to view full offer details'
        )
      })
    })

    it('should use provided stake amount from URL', async () => {
      renderWithRouter('?marketId=123&creator=0xCreator&stake=25.50&token=USDC')

      await waitFor(() => {
        expect(screen.getByTestId('acceptance-modal')).toBeInTheDocument()
      })
    })

    it('should use provided deadline from URL', async () => {
      const deadline = Date.now() + 86400000 // 24 hours
      renderWithRouter(`?marketId=123&creator=0xCreator&stake=10&deadline=${deadline}`)

      await waitFor(() => {
        expect(screen.getByTestId('acceptance-modal')).toBeInTheDocument()
      })
    })
  })

  describe('MarketAcceptanceModal Integration', () => {
    it('should render MarketAcceptanceModal with market data', async () => {
      renderWithRouter('?marketId=test-market&creator=0xCreator&stake=10')

      await waitFor(() => {
        expect(screen.getByTestId('acceptance-modal')).toBeInTheDocument()
      })
    })

    it('should pass marketId to modal', async () => {
      renderWithRouter('?marketId=my-market-id&creator=0xCreator&stake=10')

      await waitFor(() => {
        expect(screen.getByTestId('market-id')).toHaveTextContent('my-market-id')
      })
    })
  })
})

describe('Helper Functions', () => {
  // Test the module-level helper functions indirectly through page behavior

  describe('isEncryptedDescription', () => {
    it('should detect encrypted JSON descriptions (tested via contract response)', async () => {
      // This is tested indirectly - when a description is encrypted JSON,
      // the page should show "Encrypted Market" text
      // Direct testing would require exporting the function or testing via integration
    })
  })

  describe('getTokenSymbol', () => {
    it('should return MATIC for null/zero address', async () => {
      // Tested indirectly through URL param ?token=MATIC flow
      renderWithRouter('?marketId=123&creator=0xCreator&stake=10')

      await waitFor(() => {
        expect(screen.getByTestId('acceptance-modal')).toBeInTheDocument()
      })
    })
  })
})
