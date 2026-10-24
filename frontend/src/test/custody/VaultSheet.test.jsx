// Spec 102 (FR-004) — the vault sheet's own contract: three views as a keyboard-navigable tablist,
// the initial view honoured on every (re)open, and a vault that vanished from the live list closing
// the sheet. The views keep their own suites and are stubbed here.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { axe } from 'vitest-axe'

vi.mock('../../components/ui/BlockiesAvatar', () => ({
  default: () => <div data-testid="blockies" />,
}))
vi.mock('../../components/custody/VaultQueueView', () => ({
  default: ({ group }) => <div data-testid="queue-view">queue for {group.label}</div>,
}))
vi.mock('../../components/custody/VaultStyleView', () => ({
  default: () => <div data-testid="style-view">style</div>,
}))
vi.mock('../../components/custody/VaultDetailsView', () => ({
  default: ({ onVaultsChanged }) => (
    <button type="button" data-testid="details-view" onClick={() => onVaultsChanged?.()}>
      details
    </button>
  ),
}))

let custodyCtx
vi.mock('../../hooks/useCustodyVaults', () => ({ useCustodyVaults: () => custodyCtx }))

import VaultSheet from '../../components/custody/VaultSheet'

const A = '0xAaAa000000000000000000000000000000000001'
const group = (over = {}) => ({
  key: A.toLowerCase(),
  address: A,
  label: 'Treasury',
  instances: [{ chainId: 137, isSafe: true }, { chainId: 63, isSafe: true }],
  chainIds: [137, 63],
  networkLine: '2 networks',
  ...over,
})

beforeEach(() => {
  custodyCtx = { groups: [group()], loading: false, refresh: vi.fn() }
})

describe('VaultSheet', () => {
  it('renders nothing when closed, and the identity header + Queue when open', () => {
    const { rerender } = render(<VaultSheet open={false} address={A} onClose={vi.fn()} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    rerender(<VaultSheet open address={A} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Treasury' })).toBeInTheDocument()
    expect(screen.getByTestId('vault-sheet-networks')).toHaveTextContent(/2 networks · testnet included/)
    expect(screen.getByTestId('vault-panel-queue')).toBeInTheDocument()
    expect(screen.getByTestId('queue-view')).toHaveTextContent('queue for Treasury')
  })

  it('switches panels from the tabs, mounting exactly one tabpanel', () => {
    render(<VaultSheet open address={A} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('vault-tab-style'))
    expect(screen.getByTestId('vault-panel-style')).toBeInTheDocument()
    expect(screen.queryByTestId('vault-panel-queue')).not.toBeInTheDocument()
    expect(screen.getByTestId('vault-tab-style')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('vault-tab-queue')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'vault-tab-style')
  })

  it('moves between tabs with the arrow keys, Home and End (roving tabindex)', () => {
    render(<VaultSheet open address={A} onClose={vi.fn()} />)
    const queue = screen.getByTestId('vault-tab-queue')
    expect(queue).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('vault-tab-style')).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(queue, { key: 'ArrowRight' })
    expect(screen.getByTestId('vault-panel-style')).toBeInTheDocument()
    expect(screen.getByTestId('vault-tab-style')).toHaveAttribute('tabindex', '0')
    expect(document.activeElement).toBe(screen.getByTestId('vault-tab-style'))

    fireEvent.keyDown(screen.getByTestId('vault-tab-style'), { key: 'End' })
    expect(screen.getByTestId('vault-panel-details')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('vault-tab-details'), { key: 'ArrowRight' })
    expect(screen.getByTestId('vault-panel-queue')).toBeInTheDocument() // wraps

    fireEvent.keyDown(screen.getByTestId('vault-tab-queue'), { key: 'ArrowLeft' })
    expect(screen.getByTestId('vault-panel-details')).toBeInTheDocument() // wraps backwards

    fireEvent.keyDown(screen.getByTestId('vault-tab-details'), { key: 'Home' })
    expect(screen.getByTestId('vault-panel-queue')).toBeInTheDocument()
  })

  it('honours initialView on open and again on reopen, forgetting the last view', () => {
    const { rerender } = render(<VaultSheet open address={A} initialView="details" onClose={vi.fn()} />)
    expect(screen.getByTestId('vault-panel-details')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('vault-tab-style'))
    expect(screen.getByTestId('vault-panel-style')).toBeInTheDocument()

    rerender(<VaultSheet open={false} address={A} initialView="details" onClose={vi.fn()} />)
    rerender(<VaultSheet open address={A} initialView="queue" onClose={vi.fn()} />)
    expect(screen.getByTestId('vault-panel-queue')).toBeInTheDocument()
  })

  it('closes when its vault vanishes from the live list, and never while the list is still loading', async () => {
    const onClose = vi.fn()
    const { rerender } = render(<VaultSheet open address={A} onClose={onClose} />)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    custodyCtx = { groups: [], loading: true, refresh: vi.fn() }
    rerender(<VaultSheet open address={A} onClose={onClose} />)
    expect(onClose).not.toHaveBeenCalled()

    custodyCtx = { groups: [], loading: false, refresh: vi.fn() }
    rerender(<VaultSheet open address={A} onClose={onClose} />)
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('resolves the group case-insensitively and forwards list changes to the host', () => {
    const onVaultsChanged = vi.fn()
    render(<VaultSheet open address={A.toLowerCase()} initialView="details" onClose={vi.fn()} onVaultsChanged={onVaultsChanged} />)
    fireEvent.click(screen.getByTestId('details-view'))
    expect(custodyCtx.refresh).toHaveBeenCalled()
    expect(onVaultsChanged).toHaveBeenCalled()
  })

  it('has no axe violations', async () => {
    const { container } = render(<VaultSheet open address={A} onClose={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
