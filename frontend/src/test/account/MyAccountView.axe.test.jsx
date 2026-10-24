import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../components/ui/BlockiesAvatar', () => ({ default: () => <div data-testid="avatar" /> }))
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
vi.mock('../../hooks/useEffectiveAccount', () => ({
  useEffectiveAccount: () => ({
    type: 'personal',
    address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    label: null,
    isActingAccount: false,
    connectedAddress: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    chainId: null,
  }),
}))
// Carousel data — the account switcher seam, mocked whole (both export shapes,
// plus the named helpers the carousel imports from the same module).
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
vi.mock('../../components/account/LegacyUnlockDialog', () => ({ default: () => null }))
vi.mock('../../components/wallet/PortfolioPanel', () => ({
  default: () => <div data-testid="portfolio-panel" />,
}))
vi.mock('../../hooks/usePortfolio', () => {
  const usePortfolio = () => ({
    status: 'ready',
    isLoading: false,
    error: null,
    holdings: [],
    aggregates: [],
    categories: [],
    totalUsd: 42.5,
    failedAssets: [],
    priceMap: new Map(),
    showTestnetAssets: false,
    showZeroBalances: false,
    lastUpdated: Date.now(),
    refresh: vi.fn(),
  })
  return { default: usePortfolio, usePortfolio }
})

const stats = {
  summary: {
    netPnlUsd: 1200, winRate: 0.6, wins: 6, losses: 4,
    totalWageredUsd: 5000, activeWagers: 3, atStakeUsd: 250, walletBalanceUsd: 800,
  },
  series: {
    range: '30D',
    points: [
      { timestamp: 1_000_000, cumulativeUsd: -100, deltaUsd: -100, kind: 'deposit' },
      { timestamp: 2_000_000, cumulativeUsd: 150, deltaUsd: 250, kind: 'payout' },
    ],
    isEmpty: false, isLowData: false, endValueUsd: 150,
  },
  setRange: vi.fn(),
  breakdowns: {
    byStatus: [{ status: 'active', count: 3, active: true }, { status: 'resolved', count: 7, active: false }],
    byToken: [{ tokenAddress: '0xusdc', symbol: 'USDC', count: 10, ownStakeUsd: 5000 }],
    byOracle: [{ resolutionType: 1, label: 'Polymarket', count: 10 }],
  },
  // Spec 092: a merged two-network record with a named partial disclosure, so
  // the axe gate covers the network badges, the network filter control, and
  // the partial notices on every view.
  activity: [
    {
      entryId: 'oc:80002:wt:0xabc-1-payout', chainId: 80002, class: 'wager', kind: 'payout',
      direction: 'in', status: 'settled', tokenSymbol: 'USDC', amount: 190, valueUsd: 190,
      valuationStatus: 'valued', timestamp: Date.now() - 60_000, timestampProvenance: 'chain',
      txHash: '0x' + 'ab'.repeat(32), refs: { wagerId: '1' },
    },
    {
      entryId: 'oc:63:wt:0xdef-9-deposit', chainId: 63, class: 'wager', kind: 'deposit',
      direction: 'out', status: 'settled', tokenSymbol: 'CUSD', amount: 40, valueUsd: 40,
      valuationStatus: 'valued', timestamp: Date.now() - 120_000, timestampProvenance: 'chain',
      txHash: '0x' + 'cd'.repeat(32), refs: { wagerId: '9' },
    },
  ],
  staleClasses: [],
  prunedByChain: [],
  partialChains: ['Ethereum Classic'],
  networkStates: [
    { chainId: 80002, state: 'read', entryCount: 1 },
    { chainId: 63, state: 'read', entryCount: 1 },
    { chainId: 61, state: 'unreachable', reason: 'rpc down', entryCount: 0 },
  ],
  isConnected: true, chainId: 80002,
  isLoading: false, isEmpty: false, error: null,
  freshness: { summary: { lastUpdated: Date.now(), status: 'fresh' } },
  refresh: vi.fn(),
}

vi.mock('../../hooks/useAccountStats', () => ({ useAccountStats: () => stats }))

// Import after mocks are registered.
const { default: MyAccountView } = await import('../../components/account/MyAccountView')

function renderView(route = '/wallet?tab=account') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <MyAccountView />
    </MemoryRouter>,
  )
}

describe('MyAccountView accessibility (spec 074 SC-005, ports the spec 020 FR-018 gate)', () => {
  it('has no axe violations on the default (Portfolio) view', async () => {
    const { container } = renderView()
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no axe violations on the Activity view', async () => {
    const { container } = renderView('/wallet?tab=account&view=activity')
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no axe violations on the Stats view', async () => {
    const { container } = renderView('/wallet?tab=account&view=stats')
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('range selector buttons stay keyboard-focusable controls (Stats view)', async () => {
    const { getAllByRole } = renderView('/wallet?tab=account&view=stats')
    const buttons = getAllByRole('button', { name: /^(7D|30D|90D|All)$/ })
    expect(buttons.length).toBe(4)
  })
})
