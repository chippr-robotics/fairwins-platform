import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { setWalletChain } from './helpers/walletChain'
import Dashboard from '../components/fairwins/Dashboard'
import { UserPreferencesContext, WalletContext, FriendMarketsContext, UIContext, DexContext } from '../contexts'
import { OPEN_RESOLUTION_TYPES } from '../hooks/useOpenChallengeCreate'

/** Renders the live URL, so a test can assert what a component's own navigate() left behind. */
function LocationProbe() {
  const { pathname, search } = useLocation()
  return <span data-testid="loc">{`${pathname}${search}`}</span>
}

// Stub the create modal to record the props each QuickActions card opens it with,
// so we can assert the button → flow wiring (participant / oracle / all) without
// rendering the heavy modal internals.
vi.mock('../components/fairwins/FriendMarketsModal', () => ({
  default: ({ isOpen, initialType, resolutionCategory }) => isOpen ? (
    <div
      data-testid="friend-modal"
      data-initial-type={initialType}
      data-resolution-category={resolutionCategory}
    />
  ) : null,
}))

// Stub the consolidated Open Challenge modal (spec 052/053 folds oracle settlement into it) so we can
// assert the Dashboard card wiring — which resolution path it opens on, and which market a ticker
// pick pre-selects — without the picker/create internals (covered by the CreateChallengePanel /
// OpenChallengeModal tests).
vi.mock('../components/fairwins/OpenChallengeModal', () => ({
  default: ({ isOpen, initialResolutionType, initialMarket }) => isOpen ? (
    <div
      data-testid="open-challenge-modal"
      data-initial-resolution={initialResolutionType ?? ''}
      data-initial-market={initialMarket?.conditionId || ''}
    />
  ) : null,
}))

vi.mock('../components/fairwins/UnifiedLookupModal', () => ({
  default: ({ isOpen, initialPhrase, autoResolve }) => isOpen ? (
    <div data-testid="unified-modal" data-phrase={initialPhrase} data-auto={String(autoResolve)} />
  ) : null,
}))

vi.mock('../components/fairwins/PolymarketTickerCrawler', () => ({
  default: ({ onSelectMarket }) => (
    <button type="button" onClick={() => onSelectMarket?.({ conditionId: '0xticker' })}>
      Ticker: Will event happen?
    </button>
  ),
}))

describe('Dashboard Component', () => {
  const defaultWalletContext = {
    account: '0x1234567890abcdef1234567890abcdef12345678',
    isConnected: true,
    provider: null,
    signer: null,
    chainId: 63,
    connectWallet: vi.fn(),
    disconnectWallet: vi.fn(),
    switchNetwork: vi.fn(),
    isCorrectNetwork: true,
    networkError: null,
    isConnecting: false,
    balance: '0',
    roles: [],
    rolesLoading: false,
    blockchainSynced: true,
    refreshRoles: vi.fn(),
    hasRole: vi.fn().mockReturnValue(false),
    hasAnyRole: vi.fn().mockReturnValue(false),
    hasAllRoles: vi.fn().mockReturnValue(false),
    grantRole: vi.fn(),
    revokeRole: vi.fn()
  }

  const defaultUIContext = {
    modal: null,
    showModal: vi.fn(),
    hideModal: vi.fn(),
    notification: null,
    showNotification: vi.fn(),
    hideNotification: vi.fn(),
    announcement: null,
    announce: vi.fn(),
    error: null,
    showError: vi.fn(),
    clearError: vi.fn()
  }

  const defaultPreferencesContext = {
    preferences: {
      recentSearches: [],
      favoriteMarkets: [],
      defaultSlippage: 0.5,
    },
    isLoading: false,
    addRecentSearch: vi.fn(),
    clearRecentSearches: vi.fn(),
    toggleFavoriteMarket: vi.fn(),
    setDefaultSlippage: vi.fn(),
    savePreference: vi.fn(),
    clearAllPreferences: vi.fn()
  }

  const defaultFriendMarketsContext = {
    friendMarkets: [],
    loading: false,
    refresh: vi.fn(),
    addMarket: vi.fn(),
    setFriendMarkets: vi.fn()
  }

  // Minimal DexContext stub so child modals that call useDex() (e.g.
  // FriendMarketsModal for chain-aware stake-token options) don't throw
  // when Dashboard mounts them with isOpen=false.
  const defaultDexContext = {
    balances: { native: '0', wnative: '0', stable: '0' },
    balanceHistory: [],
    loading: false,
    quotingPrice: false,
    slippage: 50,
    fetchBalances: vi.fn(),
    wrapNative: vi.fn(),
    unwrapNative: vi.fn(),
    getQuote: vi.fn(),
    swap: vi.fn(),
    setSlippage: vi.fn(),
    tokens: {
      WNATIVE: { address: '0x0', symbol: 'WMATIC', name: 'Wrapped MATIC', decimals: 18, icon: '🌐' },
      STABLE: { address: '0x0', symbol: 'USDC', name: 'USD Coin', decimals: 6, icon: '💵' },
      NATIVE: { address: 'native', symbol: 'MATIC', name: 'MATIC', decimals: 18, icon: '💎' },
    },
    addresses: {
      FACTORY: '0x0', SWAP_ROUTER_02: '0x0', NONFUNGIBLE_TOKEN_POSITION_MANAGER: '0x0',
      QUOTER_V2: '0x0', PERMIT2: '0x0', WNATIVE: '0x0', STABLECOIN: '0x0',
    },
    isDexAvailable: false,
    chainId: 80002,
    network: { chainId: 80002, name: 'Polygon Amoy' },
  }

  const renderWithProviders = (component, options = {}) => {
    const {
      walletContext = defaultWalletContext,
      preferencesContext = defaultPreferencesContext,
      friendMarketsContext = defaultFriendMarketsContext,
      uiContext = defaultUIContext,
      dexContext = defaultDexContext
    } = options

    return render(
      <MemoryRouter>
        <UIContext.Provider value={uiContext}>
          <WalletContext.Provider value={walletContext}>
            <UserPreferencesContext.Provider value={preferencesContext}>
              <FriendMarketsContext.Provider value={friendMarketsContext}>
                <DexContext.Provider value={dexContext}>
                  {component}
                </DexContext.Provider>
              </FriendMarketsContext.Provider>
            </UserPreferencesContext.Provider>
          </WalletContext.Provider>
        </UIContext.Provider>
      </MemoryRouter>
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Default the dashboard onto a Polymarket-enabled chain (Polygon) so the
    // oracle card + ticker render; individual tests override for the
    // no-on-chain-oracle case.
    setWalletChain(137)
  })

  describe('QuickActions button flows', () => {
    // Every card renders now (no per-device show/hide preference), so opening a
    // flow is just render + click.
    const openVia = (cardText) => {
      renderWithProviders(<Dashboard />)
      fireEvent.click(screen.getByText(cardText))
      return screen.getByTestId('friend-modal')
    }

    it('"Friends Decide (1v1)" opens the participant flow', () => {
      const modal = openVia('Friends Decide (1v1)')
      expect(modal).toHaveAttribute('data-initial-type', 'oneVsOne')
      expect(modal).toHaveAttribute('data-resolution-category', 'participant')
    })

    it('"Oracle Settles (1v1)" opens the oracle flow (lands on Polymarket search)', () => {
      const modal = openVia('Oracle Settles (1v1)')
      expect(modal).toHaveAttribute('data-initial-type', 'oneVsOne')
      expect(modal).toHaveAttribute('data-resolution-category', 'oracle')
    })

    it('"Make an Offer" opens the all-resolution flow', () => {
      const modal = openVia('Make an Offer')
      expect(modal).toHaveAttribute('data-initial-type', 'offer')
      expect(modal).toHaveAttribute('data-resolution-category', 'all')
    })

    it('the create modal is closed until a card is clicked', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.queryByTestId('friend-modal')).not.toBeInTheDocument()
    })

    // Spec 011 follow-up: Share Account quick action surfaces the address QR
    // modal (AddressQRModal, contracts M1–M10) in its QUICK variant — a
    // clean, minimally branded QR using the persisted color choice, with no
    // color options and no visible address text.
    it('"Share Account" opens the quick QR view for the connected address', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

      fireEvent.click(screen.getByText('Share Account'))

      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveAttribute('aria-modal', 'true')
      // QR rendered for the exact connected address (account alias of
      // address) — asserted via the contracted accessible name (A1), which
      // embeds the shortened connected address.
      expect(
        screen.getByRole('img', { name: /qr code for your wallet address 0x1234/i })
      ).toBeInTheDocument()
      // Quick variant: no color options, no visible address text.
      expect(screen.queryAllByRole('radio')).toHaveLength(0)
      expect(
        screen.queryByText(defaultWalletContext.account)
      ).not.toBeInTheDocument()
    })

    it('"Share Account" QR uses the color preference saved on the Account page', () => {
      localStorage.setItem('fairwins_qrcolor_v1', 'forest')
      const { container } = renderWithProviders(<Dashboard />)
      fireEvent.click(screen.getByText('Share Account'))

      const html = container.querySelector('.address-qr svg').outerHTML.toUpperCase()
      expect(html).toContain('#14532D')
      localStorage.removeItem('fairwins_qrcolor_v1')
    })

    it('"Share Account" modal closes via its close button', () => {
      renderWithProviders(<Dashboard />)
      fireEvent.click(screen.getByText('Share Account'))
      expect(screen.getByRole('dialog')).toBeInTheDocument()

      fireEvent.click(
        screen.getByRole('button', { name: /close address qr dialog/i })
      )
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })
  })

  describe('Rendering', () => {
    it('should render dashboard header', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.getByText('Quick Actions')).toBeInTheDocument()
    })

    it('should not show redundant connected wallet subtitle', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.queryByText(/Connected:/)).not.toBeInTheDocument()
    })
  })

  describe('Quick Actions', () => {
    it('shows every quick action card (no per-device show/hide preference)', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.getByText('Friends Decide (1v1)')).toBeInTheDocument()
      expect(screen.getByText('Oracle Settles (1v1)')).toBeInTheDocument()
      expect(screen.getByText('Make an Offer')).toBeInTheDocument()
      expect(screen.getByText('Open Challenge')).toBeInTheDocument()
      expect(screen.getByText('Open Oracle Challenge')).toBeInTheDocument()
      expect(screen.getByText('Group Pool')).toBeInTheDocument()
      expect(screen.getByText('Enter Words')).toBeInTheDocument()
      expect(screen.getByText('My Wagers')).toBeInTheDocument()
      expect(screen.getByText('Scan QR Code')).toBeInTheDocument()
      expect(screen.getByText('Share Account')).toBeInTheDocument()
    })

    it('should have quick action descriptions', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.getByText(/share a code — Polymarket settles it automatically/i)).toBeInTheDocument()
      expect(screen.getByText('Enter four words to join a pool or take a challenge')).toBeInTheDocument()
      expect(screen.getByText('View active and past wagers')).toBeInTheDocument()
    })
  })

  describe('Not Connected State', () => {
    it('should show welcome view when not connected', () => {
      renderWithProviders(<Dashboard />, {
        walletContext: { ...defaultWalletContext, isConnected: false, account: null, connectWallet: vi.fn() },
      })
      expect(screen.getByText('Create a wagerwith a friend')).toBeInTheDocument()
      expect(screen.getByText('How it works')).toBeInTheDocument()
      expect(screen.getByText('Resolution methods')).toBeInTheDocument()
    })
  })

  describe('Unified phrase lookup entry (spec 037)', () => {
    const providers = (children, initialEntries) => (
      <MemoryRouter initialEntries={initialEntries}>
        <UIContext.Provider value={defaultUIContext}>
          <WalletContext.Provider value={defaultWalletContext}>
            <UserPreferencesContext.Provider value={defaultPreferencesContext}>
              <FriendMarketsContext.Provider value={defaultFriendMarketsContext}>
                <DexContext.Provider value={defaultDexContext}>
                  {children}
                </DexContext.Provider>
              </FriendMarketsContext.Provider>
            </UserPreferencesContext.Provider>
          </WalletContext.Provider>
        </UIContext.Provider>
      </MemoryRouter>
    )

    it('the "Enter Words" quick action opens the unified lookup (no auto-resolve)', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.queryByTestId('unified-modal')).not.toBeInTheDocument()
      fireEvent.click(screen.getByText('Enter Words'))
      const modal = screen.getByTestId('unified-modal')
      expect(modal).toHaveAttribute('data-auto', 'false')
      expect(modal).toHaveAttribute('data-phrase', '')
    })

    it('a ?oc=take&code= deep link opens the unified lookup prefilled and auto-resolving (FR-013)', () => {
      render(providers(<Dashboard />, ['/app?oc=take&code=river%20tiger%20kite%20zoo']))
      const modal = screen.getByTestId('unified-modal')
      expect(modal).toHaveAttribute('data-phrase', 'river tiger kite zoo')
      expect(modal).toHaveAttribute('data-auto', 'true')
    })

    /*
     * Consuming the code clears it from the URL — it is a secret, and leaving it there re-fires the
     * effect and gets it bookmarked. It used to clear it by navigating to the bare pathname, which
     * was safe only while this surface owned a whole route (`/wagers`). It renders inside
     * `/wallet?tab=paytransfer&view=wagers` now (spec 073), where the query is what selects the
     * section and the view: dropping it wholesale would land the member on the Account tab in the
     * middle of accepting a challenge.
     */
    it('clears the code from the URL but keeps the params that decide where the member is', () => {
      render(providers(
        <><Dashboard /><LocationProbe /></>,
        ['/wallet?tab=paytransfer&view=wagers&oc=take&code=river%20tiger%20kite%20zoo'],
      ))
      // Still consumed.
      expect(screen.getByTestId('unified-modal')).toHaveAttribute('data-phrase', 'river tiger kite zoo')
      // Secret gone, section intact.
      const url = screen.getByTestId('loc').textContent
      expect(url).toBe('/wallet?tab=paytransfer&view=wagers')
      expect(url).not.toMatch(/code=/)
    })
  })

  describe('Quick access cards (always shown)', () => {
    it('renders all cards with no show/hide preference and never an empty state', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.getByText('My Wagers')).toBeInTheDocument()
      expect(screen.getByText('Scan QR Code')).toBeInTheDocument()
      expect(screen.getByText('Share Account')).toBeInTheDocument()
      // The legacy "all cards hidden" empty state is gone.
      expect(screen.queryByText(/all quick access cards are hidden/i)).not.toBeInTheDocument()
    })
  })

  describe('Accessibility', () => {
    it('should have proper heading hierarchy', () => {
      renderWithProviders(<Dashboard />)
      const h1 = screen.getByRole('heading', { level: 1 })
      expect(h1).toHaveTextContent('Quick Actions')
    })

    it('should have accessible quick action buttons', () => {
      renderWithProviders(<Dashboard />)
      const buttons = screen.getAllByRole('button')
      expect(buttons.length).toBeGreaterThan(0)
    })

    it('should not render the legacy how-it-works section', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.queryByText('How P2P Wagers Work')).not.toBeInTheDocument()
    })
  })

  describe('Oracle Open Challenge entry (spec 041 → 052/053 consolidation)', () => {
    it('renders the card with its oracle-settles description', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.getByText('Open Oracle Challenge')).toBeInTheDocument()
      expect(screen.getByText(/share a code — Polymarket settles it automatically/i)).toBeInTheDocument()
    })

    it('clicking the card opens the consolidated Open Challenge modal on its oracle path, empty picker (not the 1v1 flow)', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.queryByTestId('open-challenge-modal')).toBeNull()
      fireEvent.click(screen.getByText('Open Oracle Challenge'))
      const modal = screen.getByTestId('open-challenge-modal')
      expect(modal).toBeInTheDocument()
      // Preselects the oracle (Polymarket) resolution path; opened from the card → no market.
      expect(modal).toHaveAttribute('data-initial-resolution', String(OPEN_RESOLUTION_TYPES.Polymarket))
      expect(modal).toHaveAttribute('data-initial-market', '')
      expect(screen.queryByTestId('friend-modal')).toBeNull()
    })

    it('clicking a ticker market opens the consolidated modal on its oracle path with that market pre-selected', () => {
      renderWithProviders(<Dashboard />)
      expect(screen.queryByTestId('open-challenge-modal')).toBeNull()
      fireEvent.click(screen.getByText('Ticker: Will event happen?'))
      const modal = screen.getByTestId('open-challenge-modal')
      expect(modal).toBeInTheDocument()
      expect(modal).toHaveAttribute('data-initial-resolution', String(OPEN_RESOLUTION_TYPES.Polymarket))
      // The ticker forwards the picked market's conditionId into the modal.
      expect(modal).toHaveAttribute('data-initial-market', '0xticker')
    })

    it('the plain Open Challenge card opens the same modal on its default (non-oracle) path', () => {
      renderWithProviders(<Dashboard />)
      fireEvent.click(screen.getByText('Open Challenge'))
      const modal = screen.getByTestId('open-challenge-modal')
      expect(modal).toBeInTheDocument()
      // No oracle preselect for the plain card.
      expect(modal).toHaveAttribute('data-initial-resolution', '')
    })
  })

  // Networks without an on-chain oracle (no Polymarket) hide the oracle open
  // challenge card while keeping the plain Open Challenge available. The ticker
  // crawler self-hides on the same capability (covered by its own test).
  describe('Networks without an on-chain oracle', () => {
    it('hides the Open Oracle Challenge card', () => {
      setWalletChain(63) // Ethereum Classic Mordor — no Polymarket
      renderWithProviders(<Dashboard />)
      expect(screen.queryByText('Open Oracle Challenge')).toBeNull()
    })

    it('surfaces the plain Open Challenge card (the oracle card is hidden here)', () => {
      setWalletChain(63)
      renderWithProviders(<Dashboard />)
      expect(screen.getByText('Open Challenge')).toBeInTheDocument()
      expect(screen.queryByText('Open Oracle Challenge')).toBeNull()
    })
  })
})
