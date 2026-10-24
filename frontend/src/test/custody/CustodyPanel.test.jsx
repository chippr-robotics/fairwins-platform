// Spec 043 + 085 — Custody shell renders the three areas as accordion sections (On chain open by
// default), gates On chain creation by Safe availability, serves Off chain hardware accounts, and
// meets WCAG 2.1 AA.
// Spec 102 — On chain lists ONE card per vault address and opens the vault sheet from a card or its
// "⋯"; `?vault=<address>` deep-links to that sheet and the param leaves with it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { axe } from 'vitest-axe'

let walletCtx = { chainId: 63 }
vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))
// The Verify area reads the wallet through useWalletManagement (like useActiveAccount does), so
// the shell now needs both seams mocked — Protect genuinely uses the connected identity.
vi.mock('../../hooks/useWalletManagement', () => ({ useWallet: () => walletCtx }))
vi.mock('../../hooks/useCustody', () => ({
  useCustody: () => ({ active: { mode: 'personal' }, operateAsVault: vi.fn(), operateAsPersonal: vi.fn() }),
}))
vi.mock('../../components/ui/BlockiesAvatar', () => ({
  default: () => <div data-testid="blockies" />,
}))

// The vault list is the hook's `groups` view (spec 102); the shell is tested against a controllable
// estate rather than live reads. The queue reads inside the sheet are stubbed the same way.
let custodyCtx
vi.mock('../../hooks/useCustodyVaults', () => ({ useCustodyVaults: () => custodyCtx }))
vi.mock('../../hooks/useVaultQueueAcrossChains', () => ({
  useVaultQueueAcrossChains: () => ({ byChain: {}, rows: [], pending: 0, missing: [], partial: false, loading: false, refresh: vi.fn() }),
}))

import CustodyPanel from '../../components/custody/CustodyPanel'

const VAULT = '0x9999999999999999999999999999999999999999'
const vaultGroup = () => {
  const instances = [{ address: VAULT, chainId: 63, chainName: 'Ethereum Classic Mordor', isSafe: true, owners: [], threshold: 1, label: 'Ops' }]
  return {
    key: VAULT,
    address: VAULT,
    label: 'Ops',
    instances,
    readable: instances,
    unreachable: [],
    unreadable: [],
    chainIds: [63],
    networkLine: 'Ethereum Classic Mordor',
    threshold: { value: 1, of: 1 },
    thresholdVaries: false,
    owners: [],
    pinnedChainId: 63,
    connectedInstance: instances[0],
  }
}

const emptyCustody = () => ({
  supported: true,
  vaults: [],
  groups: [],
  activeVault: null,
  activeAddress: null,
  selectVault: vi.fn(),
  loading: false,
  error: null,
  refresh: vi.fn(),
  loadByAddress: vi.fn(),
  probeVault: vi.fn(),
  createVault: vi.fn(),
  previewVaultAddress: vi.fn(),
  forget: vi.fn(),
  forgetVault: vi.fn(),
})

beforeEach(() => {
  walletCtx = { chainId: 63 }
  custodyCtx = emptyCustody()
  localStorage.clear()
})

const renderPanel = (route = '/wallet?tab=custody', props = {}) =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <CustodyPanel {...props} />
    </MemoryRouter>,
  )

/** The accordion trigger for a section, by its visible title. */
const trigger = (name) => screen.getByRole('button', { name })

describe('CustodyPanel', () => {
  it('renders On chain, Verify and Off chain as accordion sections, On chain open', () => {
    renderPanel()
    expect(trigger(/^On chain$/i)).toHaveAttribute('aria-expanded', 'true')
    // Collapsed sections carry their one-line summary in the trigger (spec 085 FR-009).
    expect(trigger(/Verify/i)).toHaveAttribute('aria-expanded', 'false')
    expect(trigger(/Off chain/i)).toHaveAttribute('aria-expanded', 'false')
    // The spec-043 placeholder is gone — Off chain is a live section now.
    expect(screen.queryByText(/coming later/i)).not.toBeInTheDocument()
  })

  it('opens one section at a time (exclusive accordion)', () => {
    renderPanel()
    fireEvent.click(trigger(/Off chain/i))
    expect(trigger(/^Off chain$/i)).toHaveAttribute('aria-expanded', 'true')
    expect(trigger(/On chain/i)).toHaveAttribute('aria-expanded', 'false')
  })

  it('serves the hardware wallet area under Off chain', () => {
    renderPanel()
    fireEvent.click(trigger(/Off chain/i))
    // No wallet connected in this mock → the honest gate, not a dead control.
    expect(screen.getByText(/connect your wallet to add hardware accounts/i)).toBeInTheDocument()
  })

  it('shows the onboarding empty state on a supported network (Mordor 63)', () => {
    walletCtx = { chainId: 63 }
    renderPanel()
    expect(screen.getByText(/no vaults yet/i)).toBeInTheDocument()
  })

  // Spec 068 (FR-005) — an unsupported connected network withdraws vault CREATION only. The vault
  // list keeps rendering, because a member's vaults live on their own chains and must not vanish
  // because the wallet happens to be pointed somewhere else.
  it('keeps the vault door open on ANY connected chain — creation is chain-abstracted (spec 105)', () => {
    walletCtx = { chainId: 1 }
    renderPanel()
    // No "cannot be created here" banner: the guided flow deploys to the networks the member
    // picks, switching the wallet only when a signature needs it.
    expect(screen.queryByText(/cannot be created on this network/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('custody-open-vault-actions')).toBeEnabled()
    expect(screen.getByText(/no vaults yet/i)).toBeInTheDocument()
  })

  // Verify needs no deployment anywhere, so unlike the vault sections it is never withdrawn by the
  // connected network — a member can always check a signature they were handed.
  it('keeps Verify available on a chain with no custody deployment', () => {
    walletCtx = { chainId: 1 }
    renderPanel()
    fireEvent.click(trigger(/Verify/i))
    expect(screen.getByRole('button', { name: /check a signature/i })).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = renderPanel()
    expect(await axe(container)).toHaveNoViolations()
  })
  // ------------------------------------------------------------- release 1.14.0
  // The four vault actions moved behind one bottom sheet. What the panel owes is a single door and
  // an honest one: the sheet must open from here, and it must not pretend a closed action is live.

  it('opens the vault ActionSheet with all four actions', () => {
    renderPanel()
    // Closed by default — the sheet is a door, not a permanent panel.
    expect(screen.queryByTestId('vault-action-create')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('custody-open-vault-actions'))
    expect(screen.getByRole('dialog', { name: /vault actions/i })).toBeInTheDocument()
    for (const id of ['create', 'load', 'propose', 'approve']) {
      expect(screen.getByTestId(`vault-action-${id}`)).toBeInTheDocument()
    }
  })

  it('offers the sheet on an unsupported chain with creation still OPEN (spec 105)', () => {
    walletCtx = { chainId: 1 }
    renderPanel()
    fireEvent.click(screen.getByTestId('custody-open-vault-actions'))
    expect(screen.getByTestId('vault-action-create')).toBeEnabled()
    expect(screen.getByTestId('vault-action-load')).toBeEnabled()
  })

  it('closes propose and approve while no vault is open', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('custody-open-vault-actions'))
    expect(screen.getByTestId('vault-action-propose')).toBeDisabled()
    expect(screen.getByTestId('vault-action-approve')).toBeDisabled()
    expect(screen.getByTestId('vault-action-approve')).toHaveTextContent(/open a vault in the list below first/i)
  })

  it('has no axe violations with the vault sheet open', async () => {
    const { container } = renderPanel()
    fireEvent.click(screen.getByTestId('custody-open-vault-actions'))
    expect(await axe(container)).toHaveNoViolations()
  })

  // ------------------------------------------------------------- spec 102
  it('renders one card per vault group and opens the vault sheet on Queue from the "⋯"', () => {
    custodyCtx = { ...emptyCustody(), groups: [vaultGroup()] }
    renderPanel()
    expect(screen.getByTestId(`vault-card-${VAULT}`)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Ops' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId(`vault-menu-${VAULT}`))
    expect(screen.getByRole('dialog', { name: 'Ops' })).toBeInTheDocument()
    expect(screen.getByTestId('vault-panel-queue')).toBeInTheDocument()
    // Selecting a card selects the vault for the VaultActionSheet's propose/approve too.
    expect(custodyCtx.selectVault).toHaveBeenCalledWith(VAULT)
  })

  it('opens the sheet from the card itself (the option)', () => {
    custodyCtx = { ...emptyCustody(), groups: [vaultGroup()] }
    renderPanel()
    fireEvent.click(screen.getByRole('option'))
    expect(screen.getByRole('dialog', { name: 'Ops' })).toBeInTheDocument()
  })

  it('deep-links to a vault sheet from ?vault=<address> (case-insensitive) and drops the param on close (FR-017)', async () => {
    custodyCtx = { ...emptyCustody(), groups: [vaultGroup()] }
    renderPanel(`/wallet?tab=custody&vault=${VAULT.toUpperCase().replace('0X', '0x')}`)
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Ops' })).toBeInTheDocument())
    expect(screen.getByTestId('vault-panel-queue')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }))
    expect(screen.queryByRole('dialog', { name: 'Ops' })).not.toBeInTheDocument()
    // Closing removed the param, so a re-render does not reopen the sheet.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ops' })).not.toBeInTheDocument())
  })

  it('ignores a ?vault= that matches no group', () => {
    custodyCtx = { ...emptyCustody(), groups: [vaultGroup()] }
    renderPanel('/wallet?tab=custody&vault=0x1234567890123456789012345678901234567890')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
