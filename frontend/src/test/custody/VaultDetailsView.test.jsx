// Spec 102 (US5, FR-010…FR-012, FR-015) — the Details view: owner cross-reference incl. "You" and
// the inline add-to-address-book, one article per network with the policy block, the acting-account
// radiogroup, the probe, and the remove-on-every-network confirm path.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { axe } from 'vitest-axe'

vi.mock('../../components/ui/BlockiesAvatar', () => ({
  default: () => <div data-testid="blockies" />,
}))

let walletCtx
let custodyCtx
let switcherCtx
let activeCtx
let names
let addContact

vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))
vi.mock('../../hooks/useCustodyVaults', () => ({ useCustodyVaults: () => custodyCtx }))
vi.mock('../../hooks/useVaultProposals', () => ({ useVaultProposals: () => ({ propose: vi.fn(), queue: [] }) }))
vi.mock('../../hooks/useAccountSwitcher', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, useAccountSwitcher: () => switcherCtx }
})
vi.mock('../../hooks/useActiveAccount', () => ({ useActiveAccount: () => activeCtx }))
vi.mock('../../hooks/useOpponentName', () => ({
  useOpponentName: (address) => names[String(address).toLowerCase()] || { displayName: 'quiet-otter', source: 'generated', address },
}))
vi.mock('../../hooks/useAddressBook', () => ({ useAddressBook: () => ({ addContact }) }))

// The policy libs are stubbed (tests run on a network without the engine) — PolicyPanel has its own suites.
vi.mock('../../lib/custody/policy', () => ({
  getPolicyStatus: vi.fn(async () => 'unsupported'),
  readPolicy: vi.fn(async () => null),
  describeRules: () => [],
  validatePolicyConfig: () => {},
  buildPolicyChangeTx: vi.fn(),
  buildSetGuardTx: vi.fn(),
  NATIVE_ASSET: '0x0000000000000000000000000000000000000000',
  shortAddress: (a) => String(a),
}))
vi.mock('../../lib/custody/policyV2', () => ({ isPolicyV2Supported: () => false }))
vi.mock('../../components/custody/createflow/createFlowModel', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod, creationChainIds: () => [137, 8453, 10] }
})
let creationRecord = null
vi.mock('../../lib/custody/vaultCreationRecords', () => ({
  getCreationRecord: () => creationRecord,
}))
let deploymentCtx
vi.mock('../../hooks/useVaultDeployment', () => ({ default: () => deploymentCtx }))

import VaultDetailsView from '../../components/custody/VaultDetailsView'

const ME = '0x1111111111111111111111111111111111111111'
const ALICE = '0x2222222222222222222222222222222222222222'
const STRANGER = '0x3333333333333333333333333333333333333333'
const VAULT = '0x9999999999999999999999999999999999999999'

const inst = (chainId, over = {}) => ({
  address: VAULT,
  chainId,
  chainName: chainId === 137 ? 'Polygon' : 'Base',
  isSafe: true,
  reachable: true,
  owner: true,
  owners: [ME, ALICE, STRANGER],
  threshold: 2,
  version: '1.4.1',
  ...over,
})

const group = (over = {}) => {
  const instances = [inst(137), inst(8453, { owners: [ME, ALICE] })]
  return {
    key: VAULT,
    address: VAULT,
    label: 'Ops',
    instances,
    readable: instances,
    chainIds: [137, 8453],
    owners: [ME, ALICE, STRANGER],
    connectedInstance: instances[0],
    ...over,
  }
}

beforeEach(() => {
  walletCtx = { chainId: 137, address: ME, switchNetwork: vi.fn().mockResolvedValue(undefined) }
  custodyCtx = {
    probeVault: vi.fn().mockResolvedValue({ added: [10], unreachable: [{ chainId: 42161, error: 'timeout' }] }),
    forgetVault: vi.fn().mockResolvedValue(undefined),
  }
  switcherCtx = {
    accounts: [
      { id: 'personal', kind: 'personal', address: ME, label: 'Personal wallet' },
      { id: `vault:${VAULT}`, kind: 'vault', address: VAULT, chainIds: [137, 8453], label: 'Ops' },
      { id: 'legacy:0xabc', kind: 'legacy', address: '0xabcabcabcabcabcabcabcabcabcabcabcabcabca', label: 'Old wallet' },
    ],
    currentId: 'personal',
    choose: vi.fn(),
  }
  activeCtx = { identity: { mode: 'personal' }, operateAsPersonal: vi.fn() }
  creationRecord = null
  deploymentCtx = { byChain: {}, start: vi.fn().mockResolvedValue({ address: VAULT }), railFor: () => ({ available: true }) }
  names = {
    [ALICE.toLowerCase()]: { displayName: 'Alice', source: 'addressBook', address: ALICE },
  }
  addContact = vi.fn((draft) => ({ id: 'c1', nickname: draft.nickname, addresses: draft.addresses }))
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true })
})

describe('VaultDetailsView', () => {
  it('shows the full address with a Copy control that reports "Copied"', async () => {
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    expect(screen.getByText(VAULT)).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('vault-copy-address'))
    await waitFor(() => expect(screen.getByTestId('vault-copy-address')).toHaveTextContent('Copied'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(VAULT)
  })

  it('renders one compact ROW per network — status + arrangement, switch only where the wallet is elsewhere (spec 105 FR-012)', () => {
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    const rows = screen.getAllByTestId('vault-network')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-chain-id', '137')
    expect(rows[0]).toHaveTextContent(/Live · 2 of 3 · Owner/)
    expect(rows[0]).toHaveTextContent(/wallet here/i)
    expect(within(rows[0]).queryByRole('button', { name: /switch/i })).not.toBeInTheDocument()
    expect(rows[1]).toHaveAttribute('data-chain-id', '8453')
    expect(rows[1]).toHaveTextContent(/2 of 2/)
    // No up-front "shown read-only" banner — the switch is a per-row affordance.
    expect(screen.queryByText(/shown read-only/i)).not.toBeInTheDocument()
    fireEvent.click(within(rows[1]).getByRole('button', { name: /switch/i }))
    expect(walletCtx.switchNetwork).toHaveBeenCalledWith(8453)
    // "Same address on every chain" is stated once, on the address block.
    expect(screen.getByTestId('vault-same-address')).toBeInTheDocument()
  })

  it('names per-network drift on the shared facts instead of averaging or repeating cards (FR-013)', () => {
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    const fact = screen.getByTestId('vault-fact-approvals')
    expect(fact).toHaveTextContent('2 of 3 owners')
    expect(fact).toHaveTextContent(/differs on/i)
    expect(fact).toHaveTextContent(/base/i)
  })

  it('offers Deploy on a missing cohort network only WITH a creation record; states the honest reason without one (FR-015/FR-018)', () => {
    const { unmount } = render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    const missing = screen.getByTestId('vault-network-missing')
    expect(missing).toHaveAttribute('data-chain-id', '10')
    expect(missing).toHaveTextContent(/not deployed/i)
    expect(missing).toHaveTextContent(/creation details, which this app does not hold/i)
    expect(within(missing).queryByRole('button', { name: /deploy/i })).not.toBeInTheDocument()
    unmount()

    creationRecord = { address: VAULT, owners: [ME, ALICE, STRANGER], threshold: 2, saltNonce: '7', presetType: 'complex', rules: null }
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('vault-deploy-10'))
    fireEvent.click(screen.getByTestId('vault-deploy-confirm'))
    expect(deploymentCtx.start).toHaveBeenCalledWith(
      expect.objectContaining({ chainIds: [10], owners: [ME, ALICE, STRANGER], threshold: 2, saltNonce: '7' }),
    )
  })

  it('disclosing original owners gates deploy-later when the live owner set drifted (FR-017)', () => {
    creationRecord = { address: VAULT, owners: [ME, ALICE], threshold: 1, saltNonce: '7', presetType: 'joint', rules: null }
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('vault-deploy-10'))
    const note = screen.getByTestId('vault-deploy-original-owners')
    expect(note).toHaveTextContent(/original arrangement/i)
    expect(note).toHaveTextContent('1 of 2')
  })

  it('an unreachable network stays LISTED as unreadable, and the shared facts name their coverage', () => {
    const g = group()
    g.instances = [g.instances[0], { address: VAULT, chainId: 8453, chainName: 'Base', reachable: false }]
    g.readable = [g.instances[0]]
    render(<VaultDetailsView group={g} onClose={vi.fn()} />)
    const rows = screen.getAllByTestId('vault-network')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toHaveTextContent(/could not be read/i)
    expect(screen.getByTestId('vault-facts-coverage')).toHaveTextContent(/base could not be read/i)
  })

  it('cross-references every owner: "You", the address-book nickname, and a generated name with add-to-book (FR-011)', () => {
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    const rows = screen.getAllByTestId('vault-owner-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveAttribute('data-source', 'you')
    expect(rows[0]).toHaveTextContent('You')
    expect(within(rows[0]).queryByTestId('vault-owner-add-book')).not.toBeInTheDocument()

    expect(rows[1]).toHaveAttribute('data-source', 'addressBook')
    expect(rows[1]).toHaveTextContent('Alice')
    expect(rows[1]).toHaveTextContent('address book')
    expect(within(rows[1]).queryByTestId('vault-owner-add-book')).not.toBeInTheDocument()

    expect(rows[2]).toHaveAttribute('data-source', 'generated')
    expect(rows[2]).toHaveTextContent('quiet-otter')
    expect(within(rows[2]).getByTestId('vault-owner-add-book')).toBeInTheDocument()
  })

  it('adds an owner to the address book on EVERY chain they own the vault on, and the row updates in place', () => {
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    const row = screen.getAllByTestId('vault-owner-row')[2]
    fireEvent.click(within(row).getByTestId('vault-owner-add-book'))
    expect(addContact).toHaveBeenCalledTimes(1)
    expect(addContact.mock.calls[0][0]).toEqual({
      nickname: 'quiet-otter',
      // STRANGER is an owner on Polygon only (the Base instance lists ME + ALICE).
      addresses: [{ address: STRANGER, chainId: 137, notes: '' }],
    })
    expect(row).toHaveAttribute('data-source', 'addressBook')
    expect(within(row).queryByTestId('vault-owner-add-book')).not.toBeInTheDocument()

    // Alice owns on both chains — an add for her would carry both (checked via a fresh generated owner).
    names[ALICE.toLowerCase()] = { displayName: 'brisk-heron', source: 'generated', address: ALICE }
  })

  it('carries every chain in the address-book draft for an owner on all networks', () => {
    names = {}
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    const aliceRow = screen.getAllByTestId('vault-owner-row')[1]
    fireEvent.click(within(aliceRow).getByTestId('vault-owner-add-book'))
    expect(addContact.mock.calls[0][0].addresses).toEqual([
      { address: ALICE, chainId: 137, notes: '' },
      { address: ALICE, chainId: 8453, notes: '' },
    ])
  })

  it('lists every account the member can act as, marks the current one, and chooses on tap (FR-012)', () => {
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    const radios = within(screen.getByRole('radiogroup', { name: /act as/i })).getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(screen.getByTestId('vault-act-as-personal')).toHaveAttribute('aria-checked', 'true')
    const thisVault = screen.getByTestId(`vault-act-as-vault:${VAULT}`)
    expect(thisVault).toHaveAttribute('aria-checked', 'false')
    expect(thisVault).toHaveClass('is-this-vault')
    expect(thisVault).toHaveTextContent('Multisig')
    fireEvent.click(thisVault)
    expect(switcherCtx.choose).toHaveBeenCalledWith(expect.objectContaining({ id: `vault:${VAULT}`, kind: 'vault' }))
    // Choosing the already-current account is a no-op.
    fireEvent.click(screen.getByTestId('vault-act-as-personal'))
    expect(switcherCtx.choose).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/switching is instant and address-only/i)).toBeInTheDocument()
  })

  it('probes the other networks and reports what was added and what could not be checked', async () => {
    const onVaultsChanged = vi.fn()
    render(<VaultDetailsView group={group()} onClose={vi.fn()} onVaultsChanged={onVaultsChanged} />)
    fireEvent.click(screen.getByTestId('vault-probe'))
    expect(custodyCtx.probeVault).toHaveBeenCalledWith(VAULT)
    const result = await screen.findByTestId('vault-probe-result')
    expect(result).toHaveTextContent('Added on Optimism.')
    expect(result).toHaveTextContent(/Not checked on Arbitrum One/)
    expect(onVaultsChanged).toHaveBeenCalled()
  })

  it('removes from Protect on every network only after an inline confirm, then closes (FR-015)', async () => {
    const onClose = vi.fn()
    render(<VaultDetailsView group={group()} onClose={onClose} />)
    fireEvent.click(screen.getByTestId('vault-remove'))
    expect(custodyCtx.forgetVault).not.toHaveBeenCalled()
    expect(screen.getByText(/forgets the vault on Polygon and Base/)).toBeInTheDocument()
    const confirm = screen.getByTestId('vault-remove-confirm')
    expect(confirm).toHaveTextContent('Remove on 2 networks')
    fireEvent.click(confirm)
    await waitFor(() => expect(custodyCtx.forgetVault).toHaveBeenCalledWith(VAULT))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(activeCtx.operateAsPersonal).not.toHaveBeenCalled()
  })

  it('resets the acting identity to personal when the removed vault was the acting account', async () => {
    activeCtx = { identity: { mode: 'vault', vaultAddress: VAULT }, operateAsPersonal: vi.fn() }
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('vault-remove'))
    fireEvent.click(screen.getByTestId('vault-remove-confirm'))
    await waitFor(() => expect(activeCtx.operateAsPersonal).toHaveBeenCalled())
  })

  it('Cancel backs out of the confirm without removing anything', () => {
    render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    fireEvent.click(screen.getByTestId('vault-remove'))
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.getByTestId('vault-remove')).toBeInTheDocument()
    expect(custodyCtx.forgetVault).not.toHaveBeenCalled()
  })

  it('has no axe violations', async () => {
    const { container } = render(<VaultDetailsView group={group()} onClose={vi.fn()} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
