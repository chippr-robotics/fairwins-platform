// Spec 102 (US1, FR-001/FR-002/FR-019) — one compact card per VAULT ADDRESS, the "⋯" outside the
// option, and a meta line that never fabricates a threshold it could not read.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { axe } from 'vitest-axe'

// The card's pending badge is the SAME cross-chain read the sheet's Queue makes (spec 102);
// here it answers from a per-group table so the badge's honesty rules are what is under test.
let queueByKey = {}
vi.mock('../../hooks/useVaultQueueAcrossChains', () => ({
  useVaultQueueAcrossChains: (group) => queueByKey[group.key] || { pending: 0, missing: [], loading: false },
}))

vi.mock('../../components/ui/BlockiesAvatar', () => ({
  default: () => <div data-testid="blockies" />,
}))

import VaultCardList from '../../components/custody/VaultCardList'

const A = '0xAaAa000000000000000000000000000000000001'
const B = '0xBbBb000000000000000000000000000000000002'

const group = (over = {}) => ({
  key: A.toLowerCase(),
  address: A,
  label: 'Treasury',
  instances: [],
  chainIds: [137, 8453],
  readable: [{ chainId: 137 }],
  unreachable: [],
  unreadable: [],
  networkLine: '2 networks',
  threshold: { value: 2, of: 3 },
  thresholdVaries: false,
  owners: [],
  pendingCount: 0,
  ...over,
})

beforeEach(() => {
  queueByKey = {}
})

describe('VaultCardList idle label (spec 102)', () => {
  it('says the card opens the sheet, not that it switches accounts', () => {
    render(<VaultCardList groups={[group({})]} actingAddress={null} onOpen={vi.fn()} />)
    expect(screen.getByText('Tap to open')).toBeInTheDocument()
    expect(screen.queryByText('Tap to use')).not.toBeInTheDocument()
  })
})

describe('VaultCardList', () => {
  it('renders exactly one card per vault group, with its network line and threshold', () => {
    render(
      <VaultCardList
        groups={[group(), group({ key: B.toLowerCase(), address: B, label: 'Family', chainIds: [63], networkLine: 'Ethereum Classic Mordor' })]}
        actingAddress={null}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getAllByRole('option')).toHaveLength(2)
    const card = screen.getByTestId(`vault-card-${A.toLowerCase()}`)
    expect(within(card).getByText('2 networks')).toBeInTheDocument()
    expect(within(card).getByText('2 of 3')).toBeInTheDocument()
    expect(within(card).getByText('Multisig')).toBeInTheDocument()
    expect(screen.getByTestId(`vault-card-${B.toLowerCase()}`)).toHaveTextContent('Ethereum Classic Mordor')
  })

  it('marks only the vault the member is acting as (FR-002)', () => {
    // The acting address is matched case-insensitively.
    render(<VaultCardList groups={[group(), group({ key: B.toLowerCase(), address: B, label: 'Family' })]} actingAddress={A.toUpperCase().replace('0X', '0x')} onOpen={vi.fn()} />)
    const selected = screen.getAllByRole('option').filter((o) => o.getAttribute('aria-selected') === 'true')
    expect(selected).toHaveLength(1)
    expect(selected[0]).toHaveTextContent('Treasury')
  })

  it('says "varies by network" when readable instances disagree', () => {
    render(<VaultCardList groups={[group({ thresholdVaries: true })]} actingAddress={null} onOpen={vi.fn()} />)
    expect(screen.getByText('varies by network')).toBeInTheDocument()
    expect(screen.queryByText('2 of 3')).not.toBeInTheDocument()
  })

  it('names the unreachable network instead of a threshold when nothing could be read (FR-019)', () => {
    render(
      <VaultCardList
        groups={[group({ chainIds: [63], readable: [], unreachable: [63], threshold: null, networkLine: 'Ethereum Classic Mordor' })]}
        actingAddress={null}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByText(/Ethereum Classic Mordor unreachable/)).toBeInTheDocument()
    expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument()
  })

  it('says "unreadable" for a chain that answered but is not a Safe, and never "0 of 0"', () => {
    render(
      <VaultCardList
        groups={[group({ chainIds: [137], readable: [], unreadable: [137], threshold: null, networkLine: 'Polygon' })]}
        actingAddress={null}
        onOpen={vi.fn()}
      />,
    )
    expect(screen.getByText('unreadable')).toBeInTheDocument()
    expect(screen.queryByText(/0 of 0/)).not.toBeInTheDocument()
  })

  it('shows a pending count only when there is one, and marks a count missing a chain', () => {
    const g = group({})
    queueByKey = { [g.key]: { pending: 2, missing: [], loading: false } }
    const { rerender } = render(<VaultCardList groups={[g]} actingAddress={null} onOpen={vi.fn()} />)
    expect(screen.getByText('2 pending')).toBeInTheDocument()
    expect(screen.getByTestId('vault-card-pending')).toHaveAttribute('data-partial', 'false')
    // A chain that could not be read: the count is real but not the whole estate, and says so.
    queueByKey = { [g.key]: { pending: 2, missing: [10], loading: false } }
    rerender(<VaultCardList groups={[g]} actingAddress={null} onOpen={vi.fn()} />)
    expect(screen.getByText('2+ pending')).toBeInTheDocument()
    expect(screen.getByTestId('vault-card-pending')).toHaveAttribute('data-partial', 'true')
    queueByKey = { [g.key]: { pending: 0, missing: [], loading: false } }
    rerender(<VaultCardList groups={[g]} actingAddress={null} onOpen={vi.fn()} />)
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument()
  })

  it('keeps the "⋯" OUTSIDE the option, and both open paths call onOpen on Queue', () => {
    const onOpen = vi.fn()
    render(<VaultCardList groups={[group()]} actingAddress={null} onOpen={onOpen} />)
    const menu = screen.getByTestId(`vault-menu-${A.toLowerCase()}`)
    expect(menu).toHaveAttribute('aria-label', 'Open Treasury vault')
    expect(menu).toHaveAttribute('aria-haspopup', 'dialog')
    expect(menu.closest('[role="option"]')).toBeNull()

    fireEvent.click(menu)
    expect(onOpen).toHaveBeenCalledWith(A, 'queue')
    fireEvent.click(screen.getByRole('option'))
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenLastCalledWith(A, 'queue')
  })

  it('renders the empty state with no groups', () => {
    render(<VaultCardList groups={[]} actingAddress={null} onOpen={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent(/no vaults yet/i)
  })

  it('has no axe violations', async () => {
    const { container } = render(
      <VaultCardList groups={[group({ policyStatus: 'managed', policySummary: '2 rules' })]} actingAddress={A} onOpen={vi.fn()} />,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
