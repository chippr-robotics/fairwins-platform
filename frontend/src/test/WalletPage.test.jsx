import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import WalletPage from '../pages/WalletPage'
import { WalletContext, UIContext } from '../contexts'
import { LEGAL_LINKS } from '../constants/legalLinks'

// Spec 011 — Account tab entry point for the address QR modal
// (contracts/address-qr-ui-contract.md, W1–W2). Wallet state is mocked at the
// context level per repo convention — never raw wagmi hooks.

// Stub heavy children that are irrelevant to the entry-point contract.
vi.mock('../components/fairwins/TradePanel', () => ({
  default: () => <div data-testid="trade-panel" />,
}))
vi.mock('../components/ui/PremiumPurchaseModal', () => ({
  default: () => <div data-testid="premium-modal" />,
}))
vi.mock('../components/ui/BlockiesAvatar', () => ({
  default: () => <div data-testid="blockies-avatar" />,
}))
vi.mock('../hooks/useEncryption', () => ({
  useEncryption: () => ({
    isInitialized: false,
    isInitializing: false,
    ensureInitialized: vi.fn(),
  }),
}))
vi.mock('../hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({
    preferences: { polymarketCategories: [] },
    setPolymarketCategories: vi.fn(),
  }),
}))
vi.mock('../hooks/useChainTokens', () => ({
  useChainTokens: () => ({ capabilities: {} }),
}))
// Spec 020 — the Account tab now renders the stats dashboard. Mock its data
// hook so this entry-point test stays network-free; the dashboard still renders
// the preserved wallet utilities (address + Show QR + Disconnect).
vi.mock('../hooks/useAccountStats', () => ({
  useAccountStats: () => ({
    summary: null,
    series: { range: '30D', points: [], isEmpty: true, isLowData: true, endValueUsd: 0 },
    setRange: vi.fn(),
    breakdowns: null,
    activity: [],
    isConnected: true,
    isSupportedNetwork: true,
    chainId: 137,
    isLoading: false,
    isEmpty: true,
    error: null,
    freshness: { summary: { lastUpdated: null, status: 'fresh' } },
    refresh: vi.fn(),
  }),
}))
vi.mock('../utils/keyRegistryService', () => ({
  hasRegisteredKey: vi.fn().mockResolvedValue(false),
  ensureKeyRegistered: vi.fn(),
}))
// Spec 074 — the Account tab body renders the unified view (card carousel +
// Portfolio/Activity/Stats). Mock the portfolio seams (the default view) and
// the switcher seam so this entry-point test stays free of the multi-chain
// scans and custody/legacy async loads behind them.
vi.mock('../components/wallet/PortfolioPanel', () => ({
  default: () => <div data-testid="portfolio-panel" />,
}))
vi.mock('../hooks/usePortfolio', () => {
  const usePortfolio = () => ({
    status: 'ready',
    isLoading: false,
    error: null,
    holdings: [],
    aggregates: [],
    categories: [],
    totalUsd: 0,
    failedAssets: [],
    priceMap: new Map(),
    showTestnetAssets: false,
    showZeroBalances: false,
    lastUpdated: null,
    refresh: vi.fn(),
  })
  return { default: usePortfolio, usePortfolio }
})
vi.mock('../hooks/useAccountSwitcher', () => {
  const useAccountSwitcher = () => ({
    accounts: [
      {
        id: 'personal',
        kind: 'personal',
        // Literal (not the ADDRESS const): vi.mock factories run before the
        // test file body, so file-scope consts are still in their TDZ here.
        address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        label: 'Personal wallet',
      },
    ],
    currentId: 'personal',
    choose: vi.fn(),
    unlockEntry: null,
    setUnlockEntry: vi.fn(),
    onUnlocked: vi.fn(),
    hasChoices: false,
  })
  return {
    useAccountSwitcher,
    default: useAccountSwitcher,
    ACCOUNT_KIND_TAG: { vault: 'Multisig', legacy: 'Recovered' },
    shortAccountAddr: (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''),
  }
})

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

const connectedWalletContext = {
  address: ADDRESS,
  isConnected: true,
  connectors: [],
  provider: null,
  signer: null,
  chainId: 137,
  connectWallet: vi.fn(),
  disconnectWallet: vi.fn(),
  roles: [],
  rolesLoading: false,
  blockchainSynced: true,
  refreshRoles: vi.fn(),
  hasRole: vi.fn().mockReturnValue(false),
  hasAnyRole: vi.fn().mockReturnValue(false),
  hasAllRoles: vi.fn().mockReturnValue(false),
  grantRole: vi.fn(),
  revokeRole: vi.fn(),
}

const disconnectedWalletContext = {
  ...connectedWalletContext,
  address: undefined,
  isConnected: false,
}

const uiContext = {
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
  clearError: vi.fn(),
}

function renderPage(walletContext, route = '/wallet') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <UIContext.Provider value={uiContext}>
        <WalletContext.Provider value={walletContext}>
          <WalletPage />
        </WalletContext.Provider>
      </UIContext.Provider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('WalletPage — address QR entry point', () => {
  // Show QR Code (and pool phrase language) live in the Settings tab's "Wallet"
  // card. Settings is reached from the account button, so the panel is deep-linked
  // here via ?tab=settings rather than an in-page tab. The cards are collapsed by
  // default — jsdom does not enforce `inert`, so each test opens the card it uses
  // rather than relying on collapsed content being reachable.
  const SETTINGS_ROUTE = '/wallet?tab=settings'
  const openWalletCard = () =>
    fireEvent.click(screen.getByRole('button', { name: /^wallet/i }))

  it('shows a "Show QR Code" button in the Settings tab\'s Wallet card when connected (W1)', () => {
    renderPage(connectedWalletContext, SETTINGS_ROUTE)
    openWalletCard()
    expect(
      screen.getByRole('button', { name: /show qr/i })
    ).toBeInTheDocument()
  })

  it('still resolves the legacy ?tab=preferences deep link to the Settings tab', () => {
    const { container } = renderPage(connectedWalletContext, '/wallet?tab=preferences')
    expect(container.querySelector('.settings-section')).toBeTruthy()
    openWalletCard()
    expect(screen.getByRole('button', { name: /show qr/i })).toBeInTheDocument()
  })

  it('opens the address QR modal with the connected address — one interaction (W1 / SC-001)', () => {
    const { container } = renderPage(connectedWalletContext, SETTINGS_ROUTE)
    openWalletCard()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /show qr/i }))

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(container.querySelector('.address-qr svg')).toBeInTheDocument()
    expect(screen.getByText(ADDRESS)).toBeInTheDocument()
  })

  it('keeps the QR modal usable after its card is collapsed again (not inert)', () => {
    renderPage(connectedWalletContext, SETTINGS_ROUTE)
    openWalletCard()
    fireEvent.click(screen.getByRole('button', { name: /show qr/i }))
    // Collapsing the card must not drag the open dialog into an inert subtree.
    openWalletCard()
    const dialog = screen.getByRole('dialog')
    expect(dialog.closest('[inert]')).toBeNull()
  })

  it('closes the modal again via its close button (M3 wiring)', () => {
    renderPage(connectedWalletContext, SETTINGS_ROUTE)
    openWalletCard()
    fireEvent.click(screen.getByRole('button', { name: /show qr/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders the connect prompt with no section content when disconnected (W2 / FR-008)', () => {
    renderPage(disconnectedWalletContext, SETTINGS_ROUTE)
    expect(screen.getByText(/connect your wallet/i)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /show qr/i })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('WalletPage — identity moved to the wallet button', () => {
  // The wallet identity + copy-address affordance was removed from the section
  // panels and now lives on the account button (top right). WalletPage no longer
  // renders a copy-address control.
  it('does not render a copy-address control in the panels', () => {
    renderPage(connectedWalletContext)
    expect(
      screen.queryByRole('button', { name: /copy wallet address/i })
    ).not.toBeInTheDocument()
  })
})

describe('WalletPage — section routing', () => {
  // The in-page section rail/drawer was lifted into the global nav drawer. The
  // page is now a flat host: it reads `?tab=` to pick a panel. Each panel renders
  // its own heading, so there is no duplicate in-page section title, ☰ toggle,
  // backdrop, or footer here.
  it('defaults to the Account section with no ?tab', () => {
    const { container } = renderPage(connectedWalletContext, '/wallet')
    expect(container.querySelector('.profile-section')).toBeTruthy()
    expect(container.querySelector('.membership-section')).toBeFalsy()
  })

  it('deep-links to the Membership section via ?tab=membership', () => {
    const { container } = renderPage(connectedWalletContext, '/wallet?tab=membership')
    expect(container.querySelector('.membership-section')).toBeTruthy()
    // The Membership panel renders its own "Your Roles" / "Membership" headings.
    expect(screen.getByRole('heading', { name: /your roles/i })).toBeInTheDocument()
  })

  it('does not render a duplicate in-page section title', () => {
    const { container } = renderPage(connectedWalletContext, '/wallet?tab=membership')
    expect(container.querySelector('.wallet-portal-current')).toBeFalsy()
    expect(container.querySelector('.wallet-portal-topbar')).toBeFalsy()
  })
})

// Issue #1025 — Terms & Conditions / Risk Disclosure / Privacy Policy / Account
// Moderation moved out of the side nav drawer into Settings, after Install app /
// Software update.
//
// Settings itself is now a list of collapsed cards (the Recovery idiom): the tab
// must scan as headings, and a deep link has to OPEN the card it names rather than
// leave the member on a closed heading.
describe('WalletPage — Settings tab', () => {
  const SETTINGS_ROUTE = '/wallet?tab=settings'

  const cardTitles = (container) =>
    Array.from(container.querySelectorAll('.settings-section .acc__title')).map(
      (el) => el.textContent
    )

  it('renders every settings card collapsed, in order, with no card open', () => {
    const { container } = renderPage(connectedWalletContext, SETTINGS_ROUTE)
    expect(cardTitles(container)).toEqual([
      'Home screen',
      // Menu density (spec 081) — the nav drawer's Comfortable/Compact choice, beside the other
      // "how this app looks" cards rather than buried in the drawer itself.
      'Menu density',
      'Wallet',
      'Portfolio',
      'Privacy',
      'Notifications',
      // Spec 104 — 'Assistant' and 'API access' LEFT this tab for Tools ▸ Assistant. They are
      // agent controls (who answers, on whose money, what may read this account), not "how this
      // app looks", and `?tab=settings#assistant-prefs` / `#api-access` now redirect there. Their
      // absence from this list is the assertion.
      'Markets',
      'Install app',
      'Software update',
      'Legal & policies',
    ])
    const triggers = container.querySelectorAll('.settings-section .acc__trigger')
    expect(triggers.length).toBeGreaterThan(0)
    for (const trigger of triggers) {
      expect(trigger).toHaveAttribute('aria-expanded', 'false')
    }
  })

  it('shows each collapsed card\'s current state in its header', () => {
    const { container } = renderPage(connectedWalletContext, SETTINGS_ROUTE)
    const summaries = Array.from(
      container.querySelectorAll('.settings-section .acc__summary')
    ).map((el) => el.textContent)
    expect(summaries).toContain('Testnet tokens hidden · Zero balances hidden')
    expect(summaries).toContain('All categories')
    // Menu density (spec 081) states its current value in the header like every other card.
    expect(summaries).toContain('Comfortable')
  })

  it('opens one card at a time', () => {
    renderPage(connectedWalletContext, SETTINGS_ROUTE)
    const portfolio = screen.getByRole('button', { name: /^portfolio/i })
    const privacy = screen.getByRole('button', { name: /^privacy/i })

    fireEvent.click(portfolio)
    expect(portfolio).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(privacy)
    expect(privacy).toHaveAttribute('aria-expanded', 'true')
    expect(portfolio).toHaveAttribute('aria-expanded', 'false')
  })

  it('lists all four legal/policy links in the Legal & policies card', () => {
    const { container } = renderPage(connectedWalletContext, SETTINGS_ROUTE)
    fireEvent.click(screen.getByRole('button', { name: /legal & policies/i }))

    // Scoped to the card's own region: the Assistant card (spec 095) also links the Privacy
    // Policy from its data-use disclosure, so a page-wide role query now matches twice.
    const region = container.querySelector('#legal-policies-region')
    expect(region).not.toBeNull()
    for (const { label, href } of LEGAL_LINKS) {
      expect(within(region).getByRole('link', { name: new RegExp(label, 'i') })).toHaveAttribute('href', href)
    }
  })

  it('positions Legal & policies after Install app and Software update', () => {
    const { container } = renderPage(connectedWalletContext, SETTINGS_ROUTE)
    const titles = cardTitles(container)
    expect(titles.indexOf('Install app')).toBeGreaterThanOrEqual(0)
    expect(titles.indexOf('Software update')).toBeGreaterThan(titles.indexOf('Install app'))
    expect(titles.indexOf('Legal & policies')).toBeGreaterThan(titles.indexOf('Software update'))
  })

  it('opens the Software update card when deep-linked with #pwa-update', () => {
    renderPage(connectedWalletContext, '/wallet?tab=settings#pwa-update')
    expect(screen.getByRole('button', { name: /software update/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    // Only the linked card opens — the rest stay tidy.
    expect(screen.getByRole('button', { name: /^privacy/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  it('opens a card whose hash simply names it, resolved from the nav search index', () => {
    // No entry in SETTINGS_HASH_ALIASES — `accordionSectionForHash` resolves it, which is also
    // what the menu search links to. A card added to the index is deep-linkable by that alone.
    renderPage(connectedWalletContext, '/wallet?tab=settings#privacy-prefs')
    expect(screen.getByRole('button', { name: /^privacy/i })).toHaveAttribute('aria-expanded', 'true')
  })

  it('marks each card for the menu search’s arrival flash', () => {
    const { container } = renderPage(connectedWalletContext, SETTINGS_ROUTE)
    expect(container.querySelector('[data-attention="privacy-prefs"]')).toBeInTheDocument()
    expect(container.querySelector('[data-attention="legal-policies"]')).toBeInTheDocument()
  })

  it('opens the Notifications card when deep-linked with #notification-profiles', () => {
    renderPage(connectedWalletContext, '/wallet?tab=settings#notification-profiles')
    expect(screen.getByRole('button', { name: /^notifications/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
})

describe('WalletPage — Recovery tab deep links', () => {
  // Recovery is a stack of collapsed cards for the same reason Settings is, and the menu search
  // links into both. Sending a member to a card and landing them on a closed heading would be the
  // search stopping one step short of the thing it found.
  it('opens the card a hash names', () => {
    renderPage(connectedWalletContext, '/wallet?tab=security#encryption-key')
    expect(screen.getByRole('button', { name: /^encryption key/i })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })

  it('leaves every card collapsed without one', () => {
    renderPage(connectedWalletContext, '/wallet?tab=security')
    expect(screen.getByRole('button', { name: /^encryption key/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })
})
