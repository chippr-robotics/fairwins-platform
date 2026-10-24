/**
 * MyAccountView (spec 074 US2/US3) — contracts U1–U4, U7, V1–V5, A1:
 * default Activity view, ?view= deep links + fallback, view switching, the
 * carousel on top, wallet utilities below, and the acting-account pass-through
 * into useAccountStats.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'

const useAccountStatsMock = vi.fn()
const usePortfolioMock = vi.fn()
let effectiveAccount

vi.mock('../../hooks/useAccountStats', () => ({
  useAccountStats: (...args) => useAccountStatsMock(...args),
}))
vi.mock('../../hooks/usePortfolio', () => ({
  default: (...args) => usePortfolioMock(...args),
  usePortfolio: (...args) => usePortfolioMock(...args),
}))
vi.mock('../../hooks/useEffectiveAccount', () => ({
  useEffectiveAccount: () => effectiveAccount,
}))
// `useWallet` joins the mock because the view now mounts the FR-021 first-funding
// DeviceLossWarning (issue #1405), which reads the passkey session through
// usePasskeyAccount → useWallet. A classic (non-passkey) session renders nothing.
vi.mock('../../hooks/useWalletManagement', () => ({
  useWalletConnection: () => ({ disconnectWallet: vi.fn() }),
  useWallet: () => ({
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    chainId: 137,
    loginMethod: 'wallet',
    isConnected: true,
    provider: null,
  }),
}))
vi.mock('../../hooks/useAccountSwitcher', () => {
  const useAccountSwitcher = () => ({
    accounts: [
      { id: 'personal', kind: 'personal', address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', label: 'Personal wallet' },
      { id: 'vault:0x8cc5', kind: 'vault', address: '0x8cc5000000000000000000000000000000000000', chainId: 137, label: 'Team vault' },
    ],
    currentId: 'personal',
    choose: vi.fn(),
    unlockEntry: null,
    setUnlockEntry: vi.fn(),
    onUnlocked: vi.fn(),
    hasChoices: true,
  })
  return {
    useAccountSwitcher,
    default: useAccountSwitcher,
    ACCOUNT_KIND_TAG: { vault: 'Multisig', legacy: 'Recovered' },
    shortAccountAddr: (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''),
  }
})
vi.mock('../../components/ui/BlockiesAvatar', () => ({ default: () => <div data-testid="avatar" /> }))
vi.mock('../../components/account/LegacyUnlockDialog', () => ({ default: () => null }))
vi.mock('../../components/wallet/PortfolioPanel', () => ({
  default: () => <div data-testid="portfolio-panel" />,
}))

const baseStats = () => ({
  summary: {
    netPnlUsd: 100, winRate: 0.5, wins: 1, losses: 1,
    totalWageredUsd: 200, activeWagers: 1, atStakeUsd: 10, walletBalanceUsd: 50,
  },
  series: { range: '30D', points: [], isEmpty: true, isLowData: true, endValueUsd: 0 },
  setRange: vi.fn(),
  breakdowns: {
    byStatus: [{ status: 'active', count: 1, active: true }],
    byToken: [{ tokenAddress: '0xusdc', symbol: 'USDC', count: 1, ownStakeUsd: 200 }],
    byOracle: [{ resolutionType: 1, label: 'Polymarket', count: 1 }],
  },
  activity: [
    {
      entryId: 'oc:137:wt:0xabc-1-payout', chainId: 137, class: 'wager', kind: 'payout',
      direction: 'in', status: 'settled', tokenSymbol: 'USDC', amount: 19, valueUsd: 19,
      valuationStatus: 'valued', timestamp: Date.now() - 60_000, timestampProvenance: 'chain',
      txHash: '0x' + 'ab'.repeat(32), refs: { wagerId: '1' },
    },
  ],
  staleClasses: [],
  prunedByChain: [],
  partialChains: [],
  networkStates: [
    { chainId: 137, state: 'read', entryCount: 1 },
    { chainId: 1, state: 'read', entryCount: 0 },
  ],
  isConnected: true, chainId: 137,
  isLoading: false, isEmpty: false, error: null,
  freshness: { summary: { lastUpdated: Date.now(), status: 'fresh' } },
  refresh: vi.fn(),
})

const readyPortfolio = () => ({
  status: 'ready',
  isLoading: false,
  error: null,
  holdings: [],
  aggregates: [],
  categories: [],
  totalUsd: 12.34,
  failedAssets: [],
  priceMap: new Map(),
  showTestnetAssets: false,
  showZeroBalances: false,
  lastUpdated: Date.now(),
  refresh: vi.fn(),
})

const { default: MyAccountView } = await import('../../components/account/MyAccountView')

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>
}

function renderView(route = '/wallet?tab=account') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <MyAccountView />
      <LocationProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useAccountStatsMock.mockImplementation(() => baseStats())
  usePortfolioMock.mockImplementation(() => readyPortfolio())
  effectiveAccount = {
    type: 'personal',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    label: null,
    isActingAccount: false,
    connectedAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    chainId: null,
  }
})

describe('MyAccountView — unified account experience (spec 074)', () => {
  it('defaults to the Portfolio view with the carousel on top (U1, C1, V2)', () => {
    renderView()
    expect(screen.getByRole('listbox', { name: /select the active account/i })).toBeInTheDocument()
    expect(screen.getByRole('tabpanel', { name: 'Portfolio' })).toBeInTheDocument()
    expect(screen.getByTestId('portfolio-panel')).toBeInTheDocument()
    expect(screen.queryByRole('tabpanel', { name: 'Activity' })).not.toBeInTheDocument()
  })

  it('shows the portfolio total on the active card once data is ready (post-launch feedback)', () => {
    renderView()
    expect(screen.getByText(/total balance/i)).toBeInTheDocument()
    expect(screen.getByText('$12.34')).toBeInTheDocument()
  })

  it('never shows a fabricated $0 on the card while the portfolio loads', () => {
    usePortfolioMock.mockImplementation(() => ({ ...readyPortfolio(), status: 'loading', totalUsd: 0 }))
    renderView()
    expect(screen.queryByText(/total balance/i)).not.toBeInTheDocument()
  })

  it('deep-links to the Activity view (U2, V1)', () => {
    renderView('/wallet?tab=account&view=activity')
    expect(screen.getByRole('tabpanel', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.getByText(/recent activity/i)).toBeInTheDocument()
    expect(screen.queryByTestId('portfolio-panel')).not.toBeInTheDocument()
  })

  it('deep-links to the Stats view, which now hosts the breakdowns (U3, V3)', () => {
    renderView('/wallet?tab=account&view=stats')
    expect(screen.getByRole('tabpanel', { name: 'Stats' })).toBeInTheDocument()
    // Summary tiles render (the wallet balance tile is stats-only chrome)
    expect(screen.getByText(/wallet balance/i)).toBeInTheDocument()
    // By status / by token / by resolution moved here from Activity.
    expect(screen.getByText(/by resolution/i)).toBeInTheDocument()
  })

  it('keeps the breakdowns out of the Activity view (post-launch feedback)', () => {
    renderView('/wallet?tab=account&view=activity')
    expect(screen.queryByText(/by resolution/i)).not.toBeInTheDocument()
  })

  it('falls back to the default Portfolio view for an unknown view (U4)', () => {
    renderView('/wallet?tab=account&view=nonsense')
    expect(screen.getByRole('tabpanel', { name: 'Portfolio' })).toBeInTheDocument()
  })

  it('switches views from the tab strip and rewrites ?view= (U7, V5)', () => {
    renderView()
    const tablist = screen.getByRole('tablist', { name: /account views/i })
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }))
    expect(screen.getByRole('tabpanel', { name: 'Activity' })).toBeInTheDocument()
    expect(screen.getByTestId('loc')).toHaveTextContent('view=activity')
    // Back to the default view deletes the param
    fireEvent.click(screen.getByRole('tab', { name: 'Portfolio' }))
    expect(screen.getByTestId('portfolio-panel')).toBeInTheDocument()
    expect(screen.getByTestId('loc')).not.toHaveTextContent('view=')
    expect(tablist).toBeInTheDocument()
  })

  it('renders the wallet utilities below every view (V4)', () => {
    renderView('/wallet?tab=account&view=stats')
    expect(screen.getByRole('button', { name: /disconnect wallet/i })).toBeInTheDocument()
  })

  it('freezes the account selection: carousel + view switcher share the sticky block (post-launch feedback)', () => {
    const { container } = renderView()
    const sticky = container.querySelector('.my-account-sticky')
    expect(sticky).toBeTruthy()
    expect(sticky.querySelector('[role="listbox"]')).toBeTruthy()
    expect(sticky.querySelector('[role="tablist"]')).toBeTruthy()
    // The view panel scrolls with the page — it must NOT be inside the frozen block.
    expect(sticky.querySelector('[role="tabpanel"]')).toBeNull()
  })

  it('passes nothing to useAccountStats in personal mode (A1)', () => {
    renderView()
    expect(useAccountStatsMock).toHaveBeenCalledWith(undefined)
  })

  it('passes the acting address to useAccountStats when acting as another account (A1)', () => {
    effectiveAccount = {
      ...effectiveAccount,
      type: 'vault',
      address: '0x8cc5000000000000000000000000000000000000',
      isActingAccount: true,
    }
    renderView()
    expect(useAccountStatsMock).toHaveBeenCalledWith({
      accountAddress: '0x8cc5000000000000000000000000000000000000',
    })
    // The shared portfolio instance follows the acting account too.
    expect(usePortfolioMock).toHaveBeenCalledWith({
      accountAddress: '0x8cc5000000000000000000000000000000000000',
    })
  })

  it('discloses partial figures by network name on Stats (spec 092)', () => {
    useAccountStatsMock.mockImplementation(() => ({
      ...baseStats(),
      partialChains: ['Ethereum'],
    }))
    renderView('/wallet?tab=account&view=stats')
    expect(screen.getByText(/figures exclude ethereum/i)).toBeInTheDocument()
    // Figures from readable chains still render.
    expect(screen.getByText(/wallet balance/i)).toBeInTheDocument()
  })

  it('all networks unreachable ⇒ honest failure state, never a fabricated empty record (FR-009)', () => {
    useAccountStatsMock.mockImplementation(() => ({
      ...baseStats(),
      activity: [],
      partialChains: ['Polygon', 'Ethereum'],
      error: 'None of your networks could be read right now.',
    }))
    renderView('/wallet?tab=account&view=activity')
    expect(screen.getByText(/your networks could not be read/i)).toBeInTheDocument()
    expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument()
  })

  // Issue #1280: the reported screen was "No activity yet" + "Updated 50s ago"
  // with every RPC answering 503. An empty feed only means "nothing happened"
  // when everything that feeds it answered.
  it('never says "No activity yet" when a network went unread (#1280)', () => {
    useAccountStatsMock.mockImplementation(() => ({
      ...baseStats(),
      activity: [],
      isEmpty: true,
      partialChains: ['Ethereum'],
      freshness: {
        summary: { lastUpdated: Date.now(), status: 'partial' },
        activity: { lastUpdated: Date.now(), status: 'partial' },
      },
    }))
    renderView('/wallet?tab=account&view=activity')
    expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument()
    expect(screen.getByText(/some of your activity could not be read/i)).toBeInTheDocument()
    // A network name is marked as one — never run into the same comma list as
    // a class label like "wager on Polygon".
    expect(screen.getByText(/could not be read: ethereum \(entire network\)/i)).toBeInTheDocument()
    // …and the freshness line does not claim a complete update for it.
    expect(screen.getByText(/partly updated .* some sources unread/i)).toBeInTheDocument()
    expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument()
  })

  it('never says "No activity yet" when an activity class could not be refreshed (#1280)', () => {
    useAccountStatsMock.mockImplementation(() => ({
      ...baseStats(),
      activity: [],
      isEmpty: true,
      staleClasses: ['wager on Polygon'],
    }))
    renderView('/wallet?tab=account&view=activity')
    expect(screen.queryByText(/no activity yet/i)).not.toBeInTheDocument()
    expect(screen.getByText(/wager on polygon/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create a wager/i })).not.toBeInTheDocument()
  })

  it('keeps the honest empty state with the create CTA (V1)', () => {
    useAccountStatsMock.mockImplementation(() => ({
      ...baseStats(),
      isEmpty: true,
    }))
    renderView('/wallet?tab=account&view=activity')
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create a wager/i })).toBeInTheDocument()
  })
})

describe('MyAccountView — imported/acting accounts get useful stats, not a wager pitch', () => {
  const actAsRecovered = () => {
    effectiveAccount = {
      ...effectiveAccount,
      type: 'legacy',
      address: '0x5250000000000000000000000000000000000000',
      label: 'Mordor Hot',
      isActingAccount: true,
    }
  }
  const estatePortfolio = () => ({
    ...readyPortfolio(),
    holdings: [{ network: 'Mordor Testnet', balance: 5000, usd: 11555.68, asset: { id: 'metc' } }],
    categories: [
      { category: { id: 'network-assets', label: 'Network Assets' }, aggregates: [{ balance: 5000 }], subtotalUsd: 11555.68 },
    ],
    totalUsd: 11555.68,
  })

  it('never pitches "Create a wager" at an acting account with no activity', () => {
    actAsRecovered()
    useAccountStatsMock.mockImplementation(() => ({ ...baseStats(), isEmpty: true }))
    renderView('/wallet?tab=account&view=activity')
    expect(screen.getByText(/no activity recorded yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create a wager/i })).not.toBeInTheDocument()
  })

  it('shows the estate breakdown on Stats for an empty acting account instead of a blanket empty state', () => {
    actAsRecovered()
    useAccountStatsMock.mockImplementation(() => ({ ...baseStats(), isEmpty: true }))
    usePortfolioMock.mockImplementation(() => estatePortfolio())
    renderView('/wallet?tab=account&view=stats')
    expect(screen.getByText(/across your estate/i)).toBeInTheDocument()
    expect(screen.getByText('Mordor Testnet')).toBeInTheDocument()
    expect(screen.getByText(/no wager activity for this account/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create a wager/i })).not.toBeInTheDocument()
  })

  it('keeps the create CTA on Stats for an empty PERSONAL account, alongside the estate', () => {
    useAccountStatsMock.mockImplementation(() => ({ ...baseStats(), isEmpty: true }))
    usePortfolioMock.mockImplementation(() => estatePortfolio())
    renderView('/wallet?tab=account&view=stats')
    expect(screen.getByText(/across your estate/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /create a wager/i })).toBeInTheDocument()
  })

  it('renders the estate breakdown beside the wager stats when wager data exists', () => {
    usePortfolioMock.mockImplementation(() => estatePortfolio())
    renderView('/wallet?tab=account&view=stats')
    expect(screen.getByText(/wallet balance/i)).toBeInTheDocument()
    expect(screen.getByText(/across your estate/i)).toBeInTheDocument()
  })

  it('still shows the estate on Stats when every network failed, beside the honest failure note', () => {
    actAsRecovered()
    useAccountStatsMock.mockImplementation(() => ({
      ...baseStats(),
      activity: [],
      partialChains: ['Polygon', 'Ethereum'],
      error: 'None of your networks could be read right now.',
    }))
    usePortfolioMock.mockImplementation(() => estatePortfolio())
    renderView('/wallet?tab=account&view=stats')
    expect(screen.getByText(/across your estate/i)).toBeInTheDocument()
    expect(screen.getByText(/your networks could not be read/i)).toBeInTheDocument()
  })
})
