// Release 1.14.0 — the vault ActionSheet: one door to the four things a member does with a
// multisig, each view mounting the component that already owns that flow.
//
// What is asserted here is the SHEET's own contract — which actions it offers, which it closes and
// why, and that each view is wired to the vault in scope. The flows themselves keep their own
// suites (CreateVaultFlow, LoadVaultForm, ProposeTransactionForm, ProposalQueue).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { axe } from 'vitest-axe'

// Platform address inputs are stubbed (repo convention) so this stays a unit test of the sheet.
vi.mock('../../components/ui/AddressInput', () => ({
  default: ({ id, value, onChange, placeholder, disabled }) => (
    <input id={id} value={value} onChange={onChange} placeholder={placeholder} disabled={disabled} />
  ),
}))
vi.mock('../../components/ui/AddressBookButton', () => ({ default: () => null }))
vi.mock('../../components/ui/QRScanner', () => ({ default: () => null }))

let walletCtx = { address: '0x1111111111111111111111111111111111111111', chainId: 63, switchNetwork: vi.fn() }
vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))
vi.mock('../../hooks/useVaultProposals', () => ({ useVaultProposals: () => null }))
// The guided creation flow keeps its own suite (createflow); the sheet only mounts it.
vi.mock('../../components/custody/createflow/CreateVaultFlow', () => ({
  default: () => <div data-testid="create-flow-stub" aria-label="Create a vault" />,
}))

import VaultActionSheet from '../../components/custody/VaultActionSheet'
import { unavailableReason } from '../../lib/custody/vaultActions'

const OWNER = '0x1111111111111111111111111111111111111111'
const CO_OWNER = '0x2222222222222222222222222222222222222222'
const VAULT_ADDR = '0x9999999999999999999999999999999999999999'
const CHAIN = 63 // Mordor — a real custody chain with the ordered policy engine

const vaultOnChain = (over = {}) => ({
  address: VAULT_ADDR,
  chainId: CHAIN,
  chainName: 'Mordor',
  label: 'Ops vault',
  isSafe: true,
  owner: true,
  onVaultChain: true,
  owners: [OWNER, CO_OWNER],
  threshold: 2,
  ...over,
})

const emptyProposals = (over = {}) => ({
  queue: [],
  history: [],
  loading: false,
  error: null,
  partial: false,
  propose: vi.fn().mockResolvedValue(undefined),
  approve: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  ...over,
})

function renderSheet(props = {}) {
  return render(
    <VaultActionSheet
      open
      onClose={vi.fn()}
      chainId={CHAIN}
      connectedAddress={OWNER}
      canCreateHere
      onCreate={vi.fn()}
      onPreview={vi.fn()}
      onLoad={vi.fn()}
      vault={vaultOnChain()}
      proposals={emptyProposals()}
      {...props}
    />,
  )
}

beforeEach(() => {
  walletCtx = { address: OWNER, chainId: CHAIN, switchNetwork: vi.fn() }
})

describe('VaultActionSheet', () => {
  it('renders nothing until it is opened', () => {
    renderSheet({ open: false })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens on a chooser offering all four vault actions', () => {
    renderSheet()
    expect(screen.getByRole('dialog', { name: /vault actions/i })).toBeInTheDocument()
    for (const id of ['create', 'load', 'propose', 'approve']) {
      expect(screen.getByTestId(`vault-action-${id}`)).toBeInTheDocument()
      expect(screen.getByTestId(`vault-action-${id}`)).toBeEnabled()
    }
  })

  it('opens straight onto the action the caller asked for, and can go back to the chooser', () => {
    renderSheet({ initialAction: 'create' })
    expect(screen.getByTestId('create-flow-stub')).toBeInTheDocument()
    expect(screen.queryByTestId('vault-action-create')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('vault-action-back'))
    expect(screen.getByTestId('vault-action-create')).toBeInTheDocument()
  })

  it('mounts the guided creation flow (spec 105)', () => {
    renderSheet()
    fireEvent.click(screen.getByTestId('vault-action-create'))
    expect(screen.getByTestId('create-flow-stub')).toBeInTheDocument()
  })

  it('mounts the cross-chain load form', () => {
    renderSheet()
    fireEvent.click(screen.getByTestId('vault-action-load'))
    expect(screen.getByRole('form', { name: /load a vault by address/i })).toBeInTheDocument()
  })

  it('mounts the propose form wired to the selected vault', async () => {
    const proposals = emptyProposals()
    renderSheet({ proposals })
    fireEvent.click(screen.getByTestId('vault-action-propose'))
    expect(screen.getByRole('form', { name: /propose a transfer/i })).toBeInTheDocument()
    // The sheet names the vault in scope, so a member cannot draft against the wrong one.
    expect(screen.getByTestId('vault-action-scope')).toHaveTextContent(/Ops vault on Ethereum Classic Mordor/i)

    fireEvent.change(screen.getByLabelText(/^recipient$/i), { target: { value: CO_OWNER } })
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: '1' } })
    fireEvent.click(screen.getByRole('button', { name: /propose transfer/i }))
    await waitFor(() => expect(proposals.propose).toHaveBeenCalled())
    expect(proposals.propose.mock.calls[0][0]).toMatchObject({ to: CO_OWNER })
  })

  // Spec 068 FR-004 — the wallet can move networks while the sheet is open. The render-time gate
  // would be stale; this is the check that binds, and it must refuse rather than submit.
  it('refuses to propose when the wallet left the vault’s chain after the sheet opened', async () => {
    const proposals = emptyProposals()
    const { rerender } = renderSheet({ proposals })
    fireEvent.click(screen.getByTestId('vault-action-propose'))
    fireEvent.change(screen.getByLabelText(/^recipient$/i), { target: { value: CO_OWNER } })
    fireEvent.change(screen.getByLabelText(/^amount$/i), { target: { value: '1' } })

    rerender(
      <VaultActionSheet
        open
        onClose={vi.fn()}
        chainId={137}
        connectedAddress={OWNER}
        canCreateHere
        onCreate={vi.fn()}
        onPreview={vi.fn()}
        onLoad={vi.fn()}
        vault={vaultOnChain()}
        proposals={proposals}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /propose transfer/i }))
    await waitFor(() => expect(screen.getByText(/switch networks and try again/i)).toBeInTheDocument())
    expect(proposals.propose).not.toHaveBeenCalled()
  })

  it('lists what is waiting for approval, and offers to approve it', () => {
    const proposals = emptyProposals({
      queue: [
        {
          safeTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          to: CO_OWNER,
          value: '1000000000000000000',
          data: '0x',
          nonce: 3,
          status: 'pending',
          approvals: 1,
          approvers: [CO_OWNER],
          threshold: 2,
        },
      ],
    })
    renderSheet({ proposals })
    fireEvent.click(screen.getByTestId('vault-action-approve'))
    expect(screen.getByText(/1\/2 approvals/)).toBeInTheDocument()
    expect(screen.getByText(/1 more needed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeEnabled()
  })

  it('creation and loading stay OPEN whatever chain the wallet is on (spec 105 — chain-abstracted)', () => {
    // The guided flow deploys to the networks the member picks, switching the wallet at signature
    // time, and loading searches every custody network — so the connected chain gates neither door.
    renderSheet({ canCreateHere: false })
    expect(screen.getByTestId('vault-action-create')).toBeEnabled()
    expect(screen.getByTestId('vault-action-load')).toBeEnabled()
  })

  it('says why propose and approve are closed with no vault open', () => {
    renderSheet({ vault: null })
    expect(screen.getByTestId('vault-action-propose')).toBeDisabled()
    expect(screen.getByTestId('vault-action-approve')).toBeDisabled()
    expect(screen.getByTestId('vault-action-propose')).toHaveTextContent(/open a vault in the list below first/i)
    // Creating and loading do not need a vault, so they stay open.
    expect(screen.getByTestId('vault-action-create')).toBeEnabled()
  })

  it('has no axe violations on the chooser', async () => {
    const { container } = renderSheet()
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('unavailableReason', () => {
  const base = { canCreateHere: true, chainId: CHAIN, vault: vaultOnChain() }

  it('allows every action for an owner on the vault’s own chain', () => {
    for (const a of ['create', 'load', 'propose', 'approve']) {
      expect(unavailableReason(a, base)).toBeNull()
    }
  })

  it('names the vault’s chain when the wallet is elsewhere — never a bare id', () => {
    const reason = unavailableReason('approve', { ...base, chainId: 137 })
    expect(reason).toMatch(/Mordor/)
    expect(reason).toMatch(/switch networks/i)
  })

  it('keeps approve open for a view-only member, and closes only propose', () => {
    const ctx = { ...base, vault: vaultOnChain({ owner: false }) }
    expect(unavailableReason('propose', ctx)).toMatch(/not an owner/i)
    expect(unavailableReason('approve', ctx)).toBeNull()
  })

  it('reports an unreachable chain as unreachable, not as a missing vault', () => {
    const ctx = { ...base, vault: vaultOnChain({ reachable: false }) }
    expect(unavailableReason('propose', ctx)).toMatch(/could not be reached/i)
  })
})

describe('scroll reset on view change', () => {
  it("resets the sheet panel's scroll when switching views, so a form never opens clipped", () => {
    renderSheet({ open: true })
    const panel = document.querySelector('.action-sheet')
    expect(panel).toBeTruthy()
    panel.scrollTop = 240
    fireEvent.click(screen.getByTestId('vault-action-create'))
    expect(panel.scrollTop).toBe(0)
  })
})
