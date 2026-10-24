/**
 * Tools ▸ Assistant (spec 104) — the tab, and the redirect that keeps the old links alive.
 *
 * Two facts about the MOVE, neither of which the Assistant components can assert about themselves:
 *
 *   1. `/wallet?tab=assistant` renders the agent controls, and Settings no longer does.
 *   2. `?tab=settings#assistant-prefs` and `?tab=settings#api-access` REDIRECT rather than 404.
 *      Those links are in the user guide, the MCP README and members' bookmarks, and the card ids
 *      did not change when the cards moved — so the redirect is derived from the ONE hash→section
 *      seam (`accordionSectionForHash`) rather than a second map that could drift from it. A hash
 *      that still belongs to Settings must NOT be dragged along, which is the third case here.
 *
 * The panel body itself is stubbed: it has its own test file, and this one is about routing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

vi.mock('../../components/assistant/AssistantToolsPanel', () => ({
  default: ({ openSection }) => (
    <div data-testid="assistant-tools-stub" data-open-section={openSection || ''} />
  ),
}))
vi.mock('../../components/fairwins/TradePanel', () => ({ default: () => <div /> }))
vi.mock('../../components/ui/PremiumPurchaseModal', () => ({ default: () => <div /> }))
vi.mock('../../components/ui/BlockiesAvatar', () => ({ default: () => <div /> }))
vi.mock('../../components/wallet/PortfolioPanel', () => ({ default: () => <div /> }))
vi.mock('../../hooks/useEncryption', () => ({
  useEncryption: () => ({ isInitialized: false, isInitializing: false, ensureInitialized: vi.fn() }),
}))
vi.mock('../../hooks/useUserPreferences', () => ({
  useUserPreferences: () => ({ preferences: { polymarketCategories: [] }, setPolymarketCategories: vi.fn() }),
}))
vi.mock('../../hooks/useChainTokens', () => ({ useChainTokens: () => ({ capabilities: {} }) }))
vi.mock('../../hooks/useAccountStats', () => ({
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
vi.mock('../../utils/keyRegistryService', () => ({
  hasRegisteredKey: vi.fn().mockResolvedValue(false),
  ensureKeyRegistered: vi.fn(),
}))
vi.mock('../../hooks/usePortfolio', () => {
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
vi.mock('../../hooks/useAccountSwitcher', () => {
  const useAccountSwitcher = () => ({
    accounts: [
      {
        id: 'personal',
        kind: 'personal',
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

import WalletPage from '../../pages/WalletPage'
import { WalletContext, UIContext } from '../../contexts'

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

const walletContext = {
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

function Where() {
  const location = useLocation()
  return <div data-testid="loc">{`${location.pathname}${location.search}${location.hash}`}</div>
}

function renderPage(route) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <UIContext.Provider value={uiContext}>
        <WalletContext.Provider value={walletContext}>
          <WalletPage />
          <Where />
        </WalletContext.Provider>
      </UIContext.Provider>
    </MemoryRouter>
  )
}

const where = () => screen.getByTestId('loc').textContent

beforeEach(() => {
  localStorage.clear()
})

describe('WalletPage — the Assistant tab', () => {
  it('renders the agent controls at /wallet?tab=assistant', () => {
    renderPage('/wallet?tab=assistant')
    expect(screen.getByTestId('assistant-tools-stub')).toBeInTheDocument()
  })

  it('no longer renders the Assistant or API access cards on Settings', () => {
    const { container } = renderPage('/wallet?tab=settings')
    const titles = Array.from(container.querySelectorAll('.settings-section .acc__title')).map(
      (el) => el.textContent
    )
    expect(titles).not.toContain('Assistant')
    expect(titles).not.toContain('API access')
  })

  it('opens the card a hash names on the new tab', () => {
    renderPage('/wallet?tab=assistant#guttertoken-key')
    expect(screen.getByTestId('assistant-tools-stub')).toHaveAttribute(
      'data-open-section',
      'guttertoken-key'
    )
  })
})

describe('WalletPage — the old Settings deep links redirect', () => {
  it('sends ?tab=settings#assistant-prefs to the Assistant tab, hash intact', () => {
    renderPage('/wallet?tab=settings#assistant-prefs')
    expect(where()).toBe('/wallet?tab=assistant#assistant-prefs')
    expect(screen.getByTestId('assistant-tools-stub')).toHaveAttribute(
      'data-open-section',
      'assistant-prefs'
    )
  })

  it('sends ?tab=settings#api-access to the Assistant tab', () => {
    renderPage('/wallet?tab=settings#api-access')
    expect(where()).toBe('/wallet?tab=assistant#api-access')
    expect(screen.getByTestId('assistant-tools-stub')).toHaveAttribute(
      'data-open-section',
      'api-access'
    )
  })

  it('carries every other query parameter, so the menu search focus marker survives', () => {
    renderPage('/wallet?tab=settings&focus=api-access#api-access')
    expect(where()).toContain('tab=assistant')
    expect(where()).toContain('focus=api-access')
    expect(where()).toContain('#api-access')
  })

  it('leaves a hash that still belongs to Settings exactly where it is', () => {
    const { container } = renderPage('/wallet?tab=settings#markets')
    expect(where()).toBe('/wallet?tab=settings#markets')
    expect(container.querySelector('.settings-section')).toBeTruthy()
  })

  it('redirects the legacy ?tab=preferences alias too — it resolves to settings first', () => {
    renderPage('/wallet?tab=preferences#assistant-prefs')
    expect(where()).toContain('tab=assistant')
  })
})
