import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MyMarketsModal from '../components/fairwins/MyMarketsModal'
import { WalletContext, ThemeContext, UIContext, FriendMarketsContext } from '../contexts'
import { BrowserRouter } from 'react-router-dom'

// Identity-stable wager-activity context stub (spec 012). The modal consumes
// useWagerActivityOptional; a stable object keeps its effects from looping.
const wagerActivityCtx = vi.hoisted(() => ({
  entries: [],
  unreadCount: 0,
  isPolling: false,
  lastPolledAt: null,
  markEntryRead: vi.fn(),
  markWagerRead: vi.fn(),
  markAllRead: vi.fn(),
  actionNeededByWagerId: {},
  actionNeededCount: 0,
  refresh: vi.fn()
}))

vi.mock('../hooks/useWagerActivity', () => ({
  useWagerActivity: () => wagerActivityCtx,
  useWagerActivityOptional: () => wagerActivityCtx
}))

// Mock hooks
vi.mock('../hooks', () => ({
  useWallet: vi.fn(() => ({
    isConnected: true,
    account: '0x1234567890123456789012345678901234567890'
  })),
  useWeb3: vi.fn(() => ({
    signer: {},
    isCorrectNetwork: true,
    switchNetwork: vi.fn()
  })),
  useMyWagers: vi.fn(() => ({
    items: [],
    sort: 'createdAt',
    filter: {},
    setSort: vi.fn(),
    setFilter: vi.fn(),
    loadMore: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    isLoading: false,
    error: null,
    hasMore: false,
    totalKnown: 0
  })),
  useLazyIpfsEnvelope: vi.fn((markets) => ({
    markets: markets || [],
    fetchEnvelope: vi.fn().mockResolvedValue(null),
    isMarketFetching: vi.fn().mockReturnValue(false),
    needsFetch: vi.fn().mockReturnValue(false),
    clearEnvelope: vi.fn()
  }))
}))

vi.mock('../hooks/useEncryption', () => ({
  useLazyMarketDecryption: vi.fn((markets) => ({
    markets: (markets || []).map(m => ({
      ...m,
      encryptionStatus: 'not_encrypted',
      isPrivate: false,
      canView: true
    })),
    decryptMarket: vi.fn().mockResolvedValue({}),
    isMarketDecrypting: vi.fn().mockReturnValue(false),
    isAnyDecrypting: false,
    clearCache: vi.fn()
  }))
}))

import { useWallet, useWeb3 } from '../hooks'
import { useLazyMarketDecryption } from '../hooks/useEncryption'

describe('MyMarketsModal', () => {
  const mockOnClose = vi.fn()

  const defaultWalletContext = {
    roles: [],
    rolesLoading: false,
    blockchainSynced: true,
    hasRole: vi.fn(() => false),
    hasAnyRole: vi.fn(() => false),
    hasAllRoles: vi.fn(() => false),
    grantRole: vi.fn(),
    revokeRole: vi.fn(),
    refreshRoles: vi.fn(),
    address: '0x1234567890123456789012345678901234567890',
    account: '0x1234567890123456789012345678901234567890',
    isConnected: true,
    provider: null,
    signer: null
  }

  const defaultThemeContext = {
    theme: 'dark',
    toggleTheme: vi.fn(),
    setTheme: vi.fn()
  }

  const defaultUIContext = {
    showModal: vi.fn(),
    hideModal: vi.fn(),
    modal: null
  }

  const defaultFriendMarketsContext = {
    friendMarkets: [],
    loading: false,
    refresh: vi.fn(),
    addMarket: vi.fn(),
    setFriendMarkets: vi.fn(),
    dismissedIds: new Set(),
    dismissMarket: vi.fn(),
    dismissMarkets: vi.fn(),
    restoreMarket: vi.fn(),
    isDismissed: vi.fn(() => false),
  }

  const renderWithProviders = (component, options = {}) => {
    const {
      walletContext = defaultWalletContext,
      themeContext = defaultThemeContext,
      uiContext = defaultUIContext,
      friendMarketsContext = defaultFriendMarketsContext
    } = options

    return render(
      <BrowserRouter>
        <ThemeContext.Provider value={themeContext}>
          <WalletContext.Provider value={walletContext}>
            <FriendMarketsContext.Provider value={friendMarketsContext}>
              <UIContext.Provider value={uiContext}>
                {component}
              </UIContext.Provider>
            </FriendMarketsContext.Provider>
          </WalletContext.Provider>
        </ThemeContext.Provider>
      </BrowserRouter>
    )
  }

  // My Wagers renders the table at every viewport; matchMedia no longer picks a
  // view. Force it "narrow" so the tests exercise the phone case — the one that
  // used to hide the resolution flow behind an expandable card.
  const setNarrowViewport = () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: /max-width/.test(query),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset session-scoped UI prefs so test order can't leak them.
    try { sessionStorage.clear() } catch { /* no-op */ }
    setNarrowViewport()
    // Mock window.ethereum to avoid provider creation errors
    global.window.ethereum = undefined
    useWallet.mockReturnValue({
      isConnected: true,
      account: '0x1234567890123456789012345678901234567890'
    })
    useWeb3.mockReturnValue({
      signer: {},
      isCorrectNetwork: true,
      switchNetwork: vi.fn()
    })
  })

  describe('Modal Visibility', () => {
    it('should not render when isOpen is false', () => {
      renderWithProviders(
        <MyMarketsModal isOpen={false} onClose={mockOnClose} />
      )

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('should render when isOpen is true', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      expect(screen.getByRole('dialog')).toBeInTheDocument()
    })

    it('should have correct ARIA attributes', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      expect(dialog).toHaveAttribute('aria-labelledby', 'my-markets-modal-title')
    })
  })

  describe('Header', () => {
    it('should display title', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      expect(screen.getByText('My Wagers')).toBeInTheDocument()
    })

    it('should display subtitle', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      expect(screen.getByText(/Manage your wagers and positions/)).toBeInTheDocument()
    })

    it('no longer renders the redundant network pill (spec 040 US7)', async () => {
      const { container } = renderWithProviders(
        <MyMarketsModal isOpen={true} onClose={mockOnClose} />
      )
      // The pill is gone; the network name still lives in the subtitle.
      expect(container.querySelector('.mm-network-tag')).toBeNull()
      expect(screen.getByText(/Manage your wagers and positions/)).toBeInTheDocument()
    })

    it('should have close button', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      expect(screen.getByRole('button', { name: /close modal/i })).toBeInTheDocument()
    })

    it('should call onClose when close button is clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      const closeBtn = screen.getByRole('button', { name: /close modal/i })
      await user.click(closeBtn)

      expect(mockOnClose).toHaveBeenCalled()
    })
  })

  describe('Tab Navigation', () => {
    it('should display three tabs', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /participating/i })).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
        expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument()
      })
    })

    it('should have Participating tab selected by default', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        const participatingTab = screen.getByRole('tab', { name: /participating/i })
        expect(participatingTab).toHaveAttribute('aria-selected', 'true')
      })
    })

    it('should switch to Created tab when clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
      })

      const createdTab = screen.getByRole('tab', { name: /created/i })
      await user.click(createdTab)

      expect(createdTab).toHaveAttribute('aria-selected', 'true')
    })

    it('should switch to History tab when clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument()
      })

      const historyTab = screen.getByRole('tab', { name: /history/i })
      await user.click(historyTab)

      expect(historyTab).toHaveAttribute('aria-selected', 'true')
    })
  })

  describe('Filter Bar', () => {
    it('should display sort dropdown in place of the old type filter', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        const sortSelect = screen.getByText('Sort:').nextElementSibling
        expect(sortSelect).toBeInTheDocument()
        expect(sortSelect.tagName).toBe('SELECT')
      })

      // The redundant friend-only "Type" filter is gone.
      expect(screen.queryByText('Type:')).not.toBeInTheDocument()
    })

    it('offers recency, end-time and stake sort options', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByText('Sort:')).toBeInTheDocument()
      })

      const sortSelect = screen.getByText('Sort:').nextElementSibling
      const optionValues = Array.from(sortSelect.options).map((o) => o.value)
      expect(optionValues).toEqual(['newest', 'endingSoon', 'stakeHighToLow'])
    })

    it('no longer shows a manual refresh button (auto-refresh, spec 019)', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByText('Sort:')).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument()
    })

    it('drops the Expired and Disputed status options (spec 040 US6)', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => expect(screen.getByText('Status:')).toBeInTheDocument())
      const statusSelect = screen.getByText('Status:').nextElementSibling
      const optionValues = Array.from(statusSelect.options).map((o) => o.value)
      expect(optionValues).toEqual([
        'all', 'pending_acceptance', 'active', 'pending_resolution', 'resolved',
      ])
      expect(optionValues).not.toContain('expired')
      expect(optionValues).not.toContain('disputed')
    })
  })

  describe('Empty States', () => {
    it('should show empty state for Participating tab with no positions', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByText('No Active Positions')).toBeInTheDocument()
      })
    })

    it('should show empty state for Created tab with no markets', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
      })

      const createdTab = screen.getByRole('tab', { name: /created/i })
      await user.click(createdTab)

      await waitFor(() => {
        expect(screen.getByText('No Wagers Created')).toBeInTheDocument()
      })
    })

    it('should show empty state for History tab with no resolved markets', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument()
      })

      const historyTab = screen.getByRole('tab', { name: /history/i })
      await user.click(historyTab)

      await waitFor(() => {
        expect(screen.getByText('No Wager History')).toBeInTheDocument()
      })
    })
  })

  describe('Wallet Not Connected', () => {
    it('should show connect wallet message when not connected', async () => {
      useWallet.mockReturnValue({
        isConnected: false,
        account: null
      })

      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        // When not connected, should show the connect wallet message immediately (no loading)
        expect(screen.getByText('Connect Your Wallet')).toBeInTheDocument()
        expect(screen.queryByText('Loading your markets...')).not.toBeInTheDocument()
      })
    })
  })

  describe('With Markets Data', () => {
    const mockMarkets = [
      {
        id: '1',
        description: 'Test Wager 1',
        creator: '0x1234567890123456789012345678901234567890',
        tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400 * 7),
        status: 'active',
        marketType: 'friend'
      },
      {
        id: '2',
        description: 'Test Wager 2',
        creator: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        participants: ['0x1234567890123456789012345678901234567890'],
        tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400 * 14),
        status: 'active',
        marketType: 'friend'
      }
    ]

    it('should display markets user has created in Created tab', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={mockMarkets} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
      })

      const createdTab = screen.getByRole('tab', { name: /created/i })
      await user.click(createdTab)

      await waitFor(() => {
        expect(screen.getByText('Test Wager 1')).toBeInTheDocument()
      })
    })

    it('should display markets user is participating in', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={mockMarkets} />
        )
      })

      await waitFor(() => {
        expect(screen.getByText('Test Wager 2')).toBeInTheDocument()
      })
    })

    it('should hide expired pending offers from the default list', async () => {
      const expiredMarket = {
        id: '99',
        description: 'Expired Offer',
        creator: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
        participants: ['0x1234567890123456789012345678901234567890'],
        status: 'pending_acceptance',
        acceptanceDeadline: Date.now() - 60 * 60 * 1000,
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        marketType: 'friend'
      }

      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[expiredMarket]} />
        )
      })

      // Default Participating tab + 'all' status filter → expired offer hidden
      expect(screen.queryByText('Expired Offer')).not.toBeInTheDocument()
      expect(screen.getByText(/No Active Positions/i)).toBeInTheDocument()
    })

    // The standalone "Expired" status filter stays removed (spec 040 US6), but an
    // expired offer must still be REACHABLE: it is only expired in this UI — on
    // chain it is still Open with the creator's stake escrowed, and "Reclaim &
    // Clear" is how the creator asks for that stake back. Removing the option
    // without a replacement left that row in no view at all (#1297).
    it('reaches a creator expired offer under the Pending Acceptance filter, with Reclaim & Clear', async () => {
      const user = userEvent.setup()
      const myExpiredOffer = {
        id: '101',
        description: 'Nobody Took This',
        creator: '0x1234567890123456789012345678901234567890', // the connected account
        participants: [],
        status: 'pending_acceptance',
        acceptanceDeadline: Date.now() - 60 * 60 * 1000,
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        marketType: 'friend'
      }

      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[myExpiredOffer]} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
      })
      await user.click(screen.getByRole('tab', { name: /created/i }))

      // Default 'all' status filter still keeps expired offers out of the way.
      expect(screen.queryByText('Nobody Took This')).not.toBeInTheDocument()

      // ...and selecting "Pending Acceptance" brings it back, because that is
      // what it still is on chain.
      const statusSelect = screen.getByText('Status:').nextElementSibling
      await act(async () => {
        await user.selectOptions(statusSelect, 'pending_acceptance')
      })

      await waitFor(() => {
        expect(screen.getByText('Nobody Took This')).toBeInTheDocument()
      })
      expect(screen.getByRole('button', { name: 'Reclaim & Clear' })).toBeInTheDocument()
    })

    // Bulk "Clear all expired" only hides rows — it never reclaims — and
    // dismissal is one-way here, so it must never offer to sweep away the
    // creator's own escrowed offer along with its Reclaim & Clear (#1297).
    it('does not offer bulk clear-all over the member own expired offers', async () => {
      const user = userEvent.setup()
      const myExpiredOffer = {
        id: '102',
        description: 'Mine, Expired',
        creator: '0x1234567890123456789012345678901234567890',
        participants: [],
        status: 'pending_acceptance',
        acceptanceDeadline: Date.now() - 60 * 60 * 1000,
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        marketType: 'friend'
      }

      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[myExpiredOffer]} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
      })
      await user.click(screen.getByRole('tab', { name: /created/i }))

      const statusSelect = screen.getByText('Status:').nextElementSibling
      await act(async () => {
        await user.selectOptions(statusSelect, 'pending_acceptance')
      })

      await waitFor(() => {
        expect(screen.getByText('Mine, Expired')).toBeInTheDocument()
      })
      expect(screen.queryByRole('button', { name: /clear all expired/i })).not.toBeInTheDocument()
    })

    // The route a member actually takes: the activity feed's "reclaim your
    // stake" entry opens this modal with the wager id, which resets the status
    // filter to "all" — the one view that hides expired offers. A wager asked
    // for BY ID has to survive that filter, or the feed lands the creator on an
    // empty list (#1297).
    it('opens an expired offer asked for by id, even under the default filter', async () => {
      const myExpiredOffer = {
        id: '103',
        description: 'Reached From The Feed',
        creator: '0x1234567890123456789012345678901234567890',
        participants: [],
        status: 'pending_acceptance',
        acceptanceDeadline: Date.now() - 60 * 60 * 1000,
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        marketType: 'friend'
      }

      await act(async () => {
        renderWithProviders(
          <MyMarketsModal
            isOpen={true}
            onClose={mockOnClose}
            friendMarkets={[myExpiredOffer]}
            initialSelectedMarketId="103"
          />
        )
      })

      // The detail view, not the empty state — and it carries the reclaim.
      // Query the heading specifically: the detail view renders the title twice
      // (the <h3> and the description block), so a bare getByText is ambiguous.
      await waitFor(() => {
        expect(
          screen.getByRole('heading', { name: 'Reached From The Feed' })
        ).toBeInTheDocument()
      })
      expect(screen.queryByText(/No Active Positions/i)).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: /claim refund/i })).toBeInTheDocument()
    })

    // "Reclaim & Clear" moves money before it hides the row, and dismissal is
    // one-way here. If the reclaim cannot even be attempted, the row must stay
    // put and say why — a dismissal would look identical to a refund that
    // worked and take the only route to the stake with it (#1297).
    it('does not dismiss the creator row when the reclaim cannot be submitted', async () => {
      const user = userEvent.setup()
      const dismissMarket = vi.fn()
      useWeb3.mockReturnValue({
        signer: null,
        isCorrectNetwork: true,
        switchNetwork: vi.fn()
      })
      const myExpiredOffer = {
        id: '104',
        description: 'No Signer Here',
        creator: '0x1234567890123456789012345678901234567890',
        participants: [],
        status: 'pending_acceptance',
        acceptanceDeadline: Date.now() - 60 * 60 * 1000,
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        marketType: 'friend'
      }

      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[myExpiredOffer]} />,
          { friendMarketsContext: { ...defaultFriendMarketsContext, dismissMarket } }
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
      })
      await user.click(screen.getByRole('tab', { name: /created/i }))

      const statusSelect = screen.getByText('Status:').nextElementSibling
      await act(async () => {
        await user.selectOptions(statusSelect, 'pending_acceptance')
      })

      await waitFor(() => {
        expect(screen.getByText('No Signer Here')).toBeInTheDocument()
      })
      await act(async () => {
        await user.click(screen.getByRole('button', { name: 'Reclaim & Clear' }))
      })

      expect(dismissMarket).not.toHaveBeenCalled()
      expect(await screen.findByRole('alert')).toHaveTextContent(/connect your wallet/i)
      expect(screen.getByText('No Signer Here')).toBeInTheDocument()
    })

  })

  describe('Keyboard Navigation', () => {
    it('should close modal on Escape key', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument()
      })

      await user.keyboard('{Escape}')

      expect(mockOnClose).toHaveBeenCalled()
    })
  })

  describe('Backdrop Click', () => {
    it('should close modal when backdrop is clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('dialog')).toBeInTheDocument()
      })

      // The backdrop is the element with class 'my-markets-modal-backdrop'
      const backdrop = document.querySelector('.my-markets-modal-backdrop')
      // Click on backdrop directly (not the modal content)
      await user.click(backdrop)

      expect(mockOnClose).toHaveBeenCalled()
    })

    it('should not close modal when modal content is clicked', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        expect(screen.getByText('My Wagers')).toBeInTheDocument()
      })

      const title = screen.getByText('My Wagers')
      await user.click(title)

      expect(mockOnClose).not.toHaveBeenCalled()
    })
  })

  describe('Friend Markets Integration', () => {
    const mockFriendMarkets = [
      {
        id: 'friend-1',
        description: 'Friend bet on game',
        creator: '0x1234567890123456789012345678901234567890',
        endDate: new Date(Date.now() + 86400000 * 7).toISOString(),
        status: 'active',
        stakeAmount: '10',
        participants: ['0x1234567890123456789012345678901234567890', '0xABCDEF1234567890ABCDEF1234567890ABCDEF12']
      }
    ]

    it('should display friend markets in Created tab when user is creator', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal
            isOpen={true}
            onClose={mockOnClose}
            friendMarkets={mockFriendMarkets}
          />
        )
      })

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
      })

      const createdTab = screen.getByRole('tab', { name: /created/i })
      await user.click(createdTab)

      await waitFor(() => {
        expect(screen.getByText('Friend bet on game')).toBeInTheDocument()
      })
    })
  })

  describe('FR-010 graceful degradation (terms unavailable)', () => {
    const me = '0x1234567890123456789012345678901234567890'

    // The helper installs a persistent useLazyMarketDecryption.mockReturnValue;
    // restore the default mapping impl after each test so it doesn't leak into
    // sibling describes (e.g. Draw US3, which relies on the default mock).
    afterEach(() => {
      useLazyMarketDecryption.mockImplementation((markets) => ({
        markets: (markets || []).map((m) => ({ ...m, encryptionStatus: 'not_encrypted', isPrivate: false, canView: true })),
        decryptMarket: vi.fn().mockResolvedValue({}),
        isMarketDecrypting: vi.fn().mockReturnValue(false),
        isAnyDecrypting: false,
        clearCache: vi.fn(),
      }))
    })

    // Render the modal so that decryptableMarkets yields a single encrypted,
    // user-created wager whose decryption has failed, then open its detail view.
    const openFailedEncryptedDetail = async (failure) => {
      const market = {
        id: '42', description: 'Encrypted Wager Forty Two', creator: me,
        participants: [me], status: 'active', marketType: 'friend',
        tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400),
        isEncrypted: true, decryptedMetadata: null, ...failure,
      }
      useLazyMarketDecryption.mockReturnValue({
        markets: [market],
        decryptMarket: vi.fn().mockResolvedValue({}),
        isMarketDecrypting: vi.fn().mockReturnValue(false),
        isAnyDecrypting: false,
        clearCache: vi.fn(),
      })
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(<MyMarketsModal isOpen={true} onClose={mockOnClose} />)
      })
      const createdTab = screen.getByRole('tab', { name: /created/i })
      await user.click(createdTab)
      const row = await screen.findByText('Encrypted Wager Forty Two')
      await user.click(row)
      return user
    }

    it('shows a "terms unavailable" state with a retry when decryption fails', async () => {
      await openFailedEncryptedDetail({ decryptionError: 'Signature rejected' })
      expect(await screen.findByText(/terms unavailable/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
      // Not the silent stuck "Decrypt Wager Details" button.
      expect(screen.queryByRole('button', { name: /decrypt wager details/i })).not.toBeInTheDocument()
    })

    it('shows the same state when the IPFS envelope is unavailable', async () => {
      await openFailedEncryptedDetail({ ipfsEnvelopeError: 'Gateway timeout' })
      expect(await screen.findByText(/terms unavailable/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    })

    // spec 018 FR-002. This lived on the expandable card; with one table view the
    // decrypted terms and their conceal control live in the detail view.
    it('lets the user hide and re-show decrypted private terms in the detail view', async () => {
      const market = {
        id: '43', description: 'Encrypted Wager Forty Three', creator: me,
        participants: [me], status: 'active', marketType: 'friend',
        tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400),
        isEncrypted: true, decryptedMetadata: { terms: 'Lakers win outright' },
      }
      useLazyMarketDecryption.mockReturnValue({
        markets: [market],
        decryptMarket: vi.fn().mockResolvedValue({}),
        isMarketDecrypting: vi.fn().mockReturnValue(false),
        isAnyDecrypting: false,
        clearCache: vi.fn(),
      })
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(<MyMarketsModal isOpen={true} onClose={mockOnClose} />)
      })
      await user.click(screen.getByRole('tab', { name: /created/i }))
      await user.click(await screen.findByText('Encrypted Wager Forty Three'))

      // Decrypted terms are visible…
      expect(await screen.findByText('Lakers win outright')).toBeInTheDocument()
      // …conceal them…
      await user.click(screen.getByRole('button', { name: /^hide$/i }))
      expect(screen.queryByText('Lakers win outright')).not.toBeInTheDocument()
      // …and show them again (no re-decryption).
      await user.click(screen.getByRole('button', { name: /^show$/i }))
      expect(screen.getByText('Lakers win outright')).toBeInTheDocument()
    })

    // Feed navigation swaps the selected wager while the detail view stays
    // mounted. Every piece of that view's state is per-wager, so it must not
    // survive the swap: concealed terms here, and the withdraw/refund receipts.
    it('does not carry concealed terms from one wager onto the next', async () => {
      const encrypted = (id, terms) => ({
        id, description: `Encrypted Wager ${id}`, creator: me,
        participants: [me], status: 'active', marketType: 'friend',
        tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400),
        isEncrypted: true, decryptedMetadata: { terms },
      })
      useLazyMarketDecryption.mockReturnValue({
        markets: [encrypted('44', 'Terms of forty four'), encrypted('45', 'Terms of forty five')],
        decryptMarket: vi.fn().mockResolvedValue({}),
        isMarketDecrypting: vi.fn().mockReturnValue(false),
        isAnyDecrypting: false,
        clearCache: vi.fn(),
      })

      const user = userEvent.setup()
      let view
      await act(async () => {
        view = renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose} initialSelectedMarketId="44" />
        )
      })

      // Conceal wager 44's terms.
      expect(await screen.findByText('Terms of forty four')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /^hide$/i }))
      expect(screen.queryByText('Terms of forty four')).not.toBeInTheDocument()

      // Navigate straight to wager 45 — its terms start visible.
      await act(async () => {
        view.rerender(
          <BrowserRouter>
            <ThemeContext.Provider value={defaultThemeContext}>
              <WalletContext.Provider value={defaultWalletContext}>
                <FriendMarketsContext.Provider value={defaultFriendMarketsContext}>
                  <UIContext.Provider value={defaultUIContext}>
                    <MyMarketsModal isOpen onClose={mockOnClose} initialSelectedMarketId="45" />
                  </UIContext.Provider>
                </FriendMarketsContext.Provider>
              </WalletContext.Provider>
            </ThemeContext.Provider>
          </BrowserRouter>
        )
      })

      expect(await screen.findByText('Terms of forty five')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^hide$/i })).toBeInTheDocument()
    })
  })

  describe('Draw resolution (US3)', () => {
    const me = '0x1234567890123456789012345678901234567890'
    const other = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'
    // tradingEndTime in the past (ms) so the resolve window is open and the
    // Resolve button renders (no resolveDeadlineTime → deadline gate skipped).
    const pastEnd = Date.now() - 86_400_000

    it('shows a distinct "Draw" status for a drawn wager in History', async () => {
      const user = userEvent.setup()
      const drawn = {
        id: '7', description: 'Drawn Wager', creator: me, participants: [me, other],
        status: 'draw', marketType: 'friend',
        endDate: new Date(Date.now() - 3_600_000).toISOString(),
      }
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[drawn]} />
        )
      })

      const historyTab = screen.getByRole('tab', { name: /history/i })
      await user.click(historyTab)

      await waitFor(() => {
        expect(screen.getByText('Drawn Wager')).toBeInTheDocument()
      })
      // The status badge reads "Draw" (distinct text — not "Refunded"/"Resolved").
      expect(screen.getAllByText('Draw').length).toBeGreaterThan(0)
      expect(screen.queryByText('Refunded')).not.toBeInTheDocument()
    })

    it('offers a labeled Draw option in the resolution modal for an authorized resolver', async () => {
      const user = userEvent.setup()
      const active = {
        id: '8', description: 'Either Bet', creator: me, opponent: other,
        participants: [me, other], resolutionType: 0, status: 'active',
        marketType: 'friend', tradingEndTime: pastEnd,
      }
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[active]} />
        )
      })

      const createdTab = screen.getByRole('tab', { name: /created/i })
      await user.click(createdTab)

      // The Resolve control sits in the row itself — no expand, no rotate.
      await screen.findByText('Either Bet')
      const resolveBtn = await screen.findByRole('button', { name: /^resolve$/i })
      await user.click(resolveBtn)

      // Modal opens; the Draw option is presented alongside the winner options.
      expect(await screen.findByText(/Draw — both parties refunded/i)).toBeInTheDocument()
      // Winner options are also present for an Either resolver.
      expect(screen.getByText('Creator wins')).toBeInTheDocument()
    })

    it('does not offer a manual Draw for an oracle-resolved (Polymarket) wager', async () => {
      const user = userEvent.setup()
      const oracleWager = {
        id: '9', description: 'Polymarket Bet', creator: me, opponent: other,
        participants: [me, other], resolutionType: 4, status: 'active',
        marketType: 'friend', tradingEndTime: pastEnd,
      }
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[oracleWager]} />
        )
      })

      const createdTab = screen.getByRole('tab', { name: /created/i })
      await user.click(createdTab)

      await waitFor(() => {
        expect(screen.getByText('Polymarket Bet')).toBeInTheDocument()
      })
      // Oracle wagers resolve automatically — no manual Resolve/Draw control.
      expect(screen.queryByRole('button', { name: /^resolve$/i })).not.toBeInTheDocument()
      expect(screen.queryByText(/Draw — both parties refunded/i)).not.toBeInTheDocument()
    })
  })

  describe('Arbitrating tab (005)', () => {
    const me = '0x1234567890123456789012345678901234567890'
    const creator = '0xAAaAAAAaaAAaaAaAAaaaAaAaAAAAaAAaAaaaAAaA'
    const opponent = '0xBBbBBBBbbBBbbBbBBbbbBbBbBBBBbBBbBbbbBBbB'

    it('shows an "Arbitrating" tab listing wagers where the wallet is the arbitrator', async () => {
      const user = userEvent.setup()
      const arbWager = {
        id: '77', description: 'Arbitrated Wager', creator, participants: [creator, opponent],
        arbitrator: me, status: 'active', marketType: 'friend',
        tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400),
      }
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[arbWager]} />
        )
      })

      const arbTab = await screen.findByRole('tab', { name: /arbitrating/i })
      await user.click(arbTab)
      await waitFor(() => {
        expect(screen.getByText('Arbitrated Wager')).toBeInTheDocument()
      })
    })

    it('does not show the Arbitrating tab when the wallet arbitrates nothing', async () => {
      const ownWager = {
        id: '78', description: 'My Own Wager', creator: me, participants: [me, opponent],
        status: 'active', marketType: 'friend',
        tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400),
      }
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} friendMarkets={[ownWager]} />
        )
      })
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /created/i })).toBeInTheDocument()
      })
      expect(screen.queryByRole('tab', { name: /arbitrating/i })).not.toBeInTheDocument()
    })
  })

  describe('Claim winnings (winner pull payout)', () => {
    const me = '0x1234567890123456789012345678901234567890'
    const other = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'

    const resolvedWon = (overrides = {}) => ({
      id: '42', description: 'Won Wager', creator: me, opponent: other,
      participants: [me, other], status: 'resolved', marketType: 'friend',
      winner: me, paid: false,
      endDate: new Date(Date.now() - 3_600_000).toISOString(),
      ...overrides
    })

    const openHistory = async (user) => {
      const historyTab = screen.getByRole('tab', { name: /history/i })
      await user.click(historyTab)
    }

    it('shows a real Claim button for the winner of a resolved, unpaid wager', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose} friendMarkets={[resolvedWon()]} />
        )
      })
      await openHistory(user)

      await waitFor(() => expect(screen.getByText('Won Wager')).toBeInTheDocument())
      // The Claim button is in the row — reachable without opening anything.
      expect(await screen.findByRole('button', { name: /^claim$/i })).toBeInTheDocument()
    })

    it('claims in place instead of opening the detail view (regression: claim opened the detail)', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose} friendMarkets={[resolvedWon()]} />
        )
      })
      await openHistory(user)

      await screen.findByText('Won Wager')
      const claimBtn = await screen.findByRole('button', { name: /^claim$/i })
      await act(async () => {
        await user.click(claimBtn)
      })

      // The click must NOT navigate into the detail view — that was the bug.
      expect(screen.queryByText('Back to list')).not.toBeInTheDocument()
      // Still on the list (the row title is rendered in the table, not the detail header).
      expect(screen.getByText('Won Wager')).toBeInTheDocument()
    })

    it('shows the Claim Winnings button in the detail view opened from the table row', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose} friendMarkets={[resolvedWon()]} />
        )
      })
      await openHistory(user)

      // The full detail is reached by clicking a table row.
      await user.click(await screen.findByText('Won Wager'))

      expect(await screen.findByText('Back to list')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /claim winnings/i })).toBeInTheDocument()
    })

    it('does not show a Claim button to the losing side', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose}
            friendMarkets={[resolvedWon({ winner: other })]} />
        )
      })
      await openHistory(user)

      await waitFor(() => expect(screen.getByText('Won Wager')).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: /^claim$/i })).not.toBeInTheDocument()
    })

    it('does not show a Claim button once the payout has been paid', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose}
            friendMarkets={[resolvedWon({ paid: true })]} />
        )
      })
      await openHistory(user)

      await waitFor(() => expect(screen.getByText('Won Wager')).toBeInTheDocument())
      expect(screen.queryByRole('button', { name: /^claim$/i })).not.toBeInTheDocument()
    })
  })

  describe('Accessibility', () => {
    it('should have proper tab roles', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      await waitFor(() => {
        const tablist = screen.getByRole('tablist')
        expect(tablist).toBeInTheDocument()

        const tabs = screen.getAllByRole('tab')
        expect(tabs).toHaveLength(3)
      })
    })

    it('should have proper tabpanel role after loading', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen={true} onClose={mockOnClose} />
        )
      })

      // Wait for loading to complete
      await waitFor(() => {
        const tabpanel = screen.queryByRole('tabpanel')
        expect(tabpanel).toBeInTheDocument()
      })
    })
  })

  describe('Single table view at every viewport', () => {
    const me = '0x1234567890123456789012345678901234567890'
    const other = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12'
    const aWager = {
      id: 'v1', description: 'Toggle Wager', creator: other,
      participants: [me], status: 'active', marketType: 'friend',
      tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400),
    }

    it('renders the table on a narrow viewport, with no view/density/refresh toggles', async () => {
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose} friendMarkets={[aWager]} />
        )
      })
      await waitFor(() => expect(screen.getByText('Toggle Wager')).toBeInTheDocument())
      expect(screen.getByRole('table')).toBeInTheDocument()
      // Nothing to choose: no grid/table switch, no density control, no refresh.
      expect(screen.queryByRole('button', { name: /^grid$/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^table$/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /compact|comfortable/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /refresh/i })).not.toBeInTheDocument()
    })

    it('renders the table on a wide viewport too', async () => {
      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: /min-width/.test(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }))
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose} friendMarkets={[aWager]} />
        )
      })
      await waitFor(() => expect(screen.getByText('Toggle Wager')).toBeInTheDocument())
      expect(screen.getByRole('table')).toBeInTheDocument()
    })

    // The bug this replaced the card grid for: on a phone the resolution flow
    // was only reachable by expanding a card, and the card never exposed it —
    // members had to rotate to landscape to get the table.
    it('reaches the resolution flow from a row on a narrow viewport (no rotation)', async () => {
      const user = userEvent.setup()
      const resolvable = {
        id: 'v2', description: 'Phone Resolve', creator: me, opponent: other,
        participants: [me, other], resolutionType: 0, status: 'active',
        marketType: 'friend',
        tradingEndTime: Date.now() - 60 * 60 * 1000,
      }
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal isOpen onClose={mockOnClose} friendMarkets={[resolvable]} />
        )
      })

      await user.click(screen.getByRole('tab', { name: /created/i }))
      await screen.findByText('Phone Resolve')

      const resolveBtn = await screen.findByRole('button', { name: /^resolve$/i })
      await user.click(resolveBtn)
      expect(await screen.findByText(/Draw — both parties refunded/i)).toBeInTheDocument()
    })

    it('auto-refreshes the list on an interval while open (FR-003/004)', async () => {
      vi.useFakeTimers()
      const refresh = vi.fn()
      try {
        await act(async () => {
          renderWithProviders(
            <MyMarketsModal isOpen onClose={mockOnClose} />,
            { friendMarketsContext: { ...defaultFriendMarketsContext, refresh } }
          )
        })
        expect(refresh).not.toHaveBeenCalled()
        // After the poll interval the list pulls fresh data on its own.
        await act(async () => { vi.advanceTimersByTime(30000) })
        expect(refresh).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  /*
   * THE LIST IS THE ESTATE (spec 110 T040).
   *
   * The context reads every cohort chain, and the modal used to filter that back down to the
   * wallet's chain — which silently undid the feature: a member still watched their wagers
   * disappear when they switched networks, which is the behaviour T040 exists to end.
   *
   * The whole existing suite passed through that filter without noticing, because `useWallet`
   * is mocked here with NO `chainId` and the filter's own guard read
   * `m.chainId == null || !chainId || m.chainId === chainId` — with `chainId` undefined every
   * wager fell through the `!chainId` arm. So these tests pin the wallet to a REAL chain that
   * is not the wagers' chain. A fixture that leaves `chainId` undefined cannot fail this way
   * and is why the defect reached CI.
   */
  describe('Estate-wide list (spec 110 T040)', () => {
    const MEMBER = '0x1234567890123456789012345678901234567890'

    const wagerOn = (chainId, id, description) => ({
      id,
      uniqueId: `${chainId}-0xREG-${id}`,
      chainId,
      contractAddress: '0xREG',
      description,
      creator: MEMBER,
      participants: [MEMBER, '0x00000000000000000000000000000000000000aa'],
      tradingEndTime: BigInt(Math.floor(Date.now() / 1000) + 86400 * 7),
      status: 'active',
      marketType: 'friend',
    })

    beforeEach(() => {
      // The wallet sits on Polygon; every wager below is somewhere else.
      useWallet.mockReturnValue({ isConnected: true, account: MEMBER, chainId: 137 })
    })

    it('shows a wager held on a chain the wallet is not connected to', async () => {
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal
            isOpen={true}
            onClose={mockOnClose}
            friendMarkets={[wagerOn(8453, '1', 'Wager on Base')]}
          />
        )
      })

      await user.click(screen.getByRole('tab', { name: /created/i }))
      expect(await screen.findByText('Wager on Base')).toBeInTheDocument()
    })

    it('keeps both wagers when two chains issue the same wager id', async () => {
      // `id` is a per-registry counter, so wager #5 on Base and wager #5 on Arbitrum are two
      // different wagers. Deduping on `marketType-id` — which was correct while the list could
      // only hold one chain — drops one of them outright.
      const user = userEvent.setup()
      await act(async () => {
        renderWithProviders(
          <MyMarketsModal
            isOpen={true}
            onClose={mockOnClose}
            friendMarkets={[
              wagerOn(8453, '5', 'Wager five on Base'),
              wagerOn(42161, '5', 'Wager five on Arbitrum'),
            ]}
          />
        )
      })

      await user.click(screen.getByRole('tab', { name: /created/i }))
      expect(await screen.findByText('Wager five on Base')).toBeInTheDocument()
      expect(await screen.findByText('Wager five on Arbitrum')).toBeInTheDocument()
    })
  })
})
