// Spec 102 (US3, FR-005…FR-008, FR-019) — the Queue view: network pills per row, a partial total
// that NAMES the unread chain, switch-then-act with the rebound hook, a stated refusal, a view-only
// row, and the per-chain read status list.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { axe } from 'vitest-axe'

let walletCtx
let queueCtx
let proposalsCtx
vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))
vi.mock('../../hooks/useVaultQueueAcrossChains', () => ({ useVaultQueueAcrossChains: () => queueCtx }))
vi.mock('../../hooks/useVaultProposals', () => ({ useVaultProposals: (vault) => proposalsCtx(vault) }))
// Recipient names resolve the way every address does (spec 054); the book is faked per address.
let names = {}
vi.mock('../../hooks/useOpponentName', () => ({
  useOpponentName: (address) => names[String(address).toLowerCase()] || { displayName: 'Quiet Otter', source: 'generated', address },
}))

import VaultQueueView from '../../components/custody/VaultQueueView'

const ME = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const VAULT = '0x9999999999999999999999999999999999999999'
const H1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const H2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

const inst = (chainId, over = {}) => ({ address: VAULT, chainId, isSafe: true, owner: true, owners: [ME, OTHER], threshold: 2, ...over })
const polygon = inst(137)
const base = inst(8453)

const proposal = (chainId, safeTxHash, over = {}) => ({
  safeTxHash,
  chainId,
  to: OTHER,
  value: '0',
  data: '0x',
  nonce: 3,
  status: 'pending',
  approvals: 1,
  approvers: [OTHER],
  threshold: 2,
  blockNumber: 100,
  ...over,
})

const group = (walletChainId, over = {}) => {
  const instances = [polygon, base]
  return {
    key: VAULT,
    address: VAULT,
    label: 'Ops',
    instances,
    readable: instances,
    chainIds: [137, 8453],
    connectedInstance: instances.find((i) => i.chainId === Number(walletChainId)) || null,
    ...over,
  }
}

let approve
let execute
let cancel
let refresh

beforeEach(() => {
  approve = vi.fn().mockResolvedValue(undefined)
  execute = vi.fn().mockResolvedValue(undefined)
  cancel = vi.fn().mockResolvedValue(undefined)
  refresh = vi.fn().mockResolvedValue(undefined)
  walletCtx = { chainId: 137, address: ME, switchNetwork: vi.fn().mockResolvedValue(undefined) }
  proposalsCtx = () => ({ approve, execute, cancel, queue: [], history: [] })
  queueCtx = {
    byChain: {
      137: { state: 'read', proposals: [proposal(137, H1)], partial: false, owner: true },
      8453: { state: 'read', proposals: [proposal(8453, H2)], partial: false, owner: true },
    },
    rows: [proposal(137, H1), proposal(8453, H2)],
    pending: 2,
    missing: [],
    partial: false,
    loading: false,
    refresh,
  }
})

describe('VaultQueueView', () => {
  it('tags every row with its network and totals across networks (FR-006)', () => {
    render(<VaultQueueView group={group(137)} />)
    const rows = screen.getAllByTestId('vault-queue-row')
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.getAttribute('data-chain-id'))).toEqual(['137', '8453'])
    expect(within(rows[0]).getByText('Polygon')).toHaveClass('ab-net-pill')
    expect(within(rows[1]).getByText('Base')).toHaveClass('ab-net-pill')
    expect(screen.getByTestId('vault-queue-summary')).toHaveTextContent('2 pending across 2 networks')
    expect(screen.getByTestId('vault-queue-summary')).toHaveAttribute('data-partial', 'false')
    // Per-chain read status, one line per network.
    const chains = screen.getAllByTestId('vault-queue-chain')
    expect(chains).toHaveLength(2)
    expect(chains[0]).toHaveTextContent('Polygon: 1 pending')
    expect(chains[0]).toHaveAttribute('data-state', 'read')
  })

  it('re-reads every network on Refresh, so a settled queue is never mistaken for a stale one', () => {
    /*
     * The queue reads when it opens and does not poll, so a proposal the chain accepted a moment
     * later is not on screen. Refresh is offered whatever each chain's state is — this is about
     * time passing, not about a bad read — and asks for ALL of them, not one.
     */
    render(<VaultQueueView group={group(137)} />)
    fireEvent.click(screen.getByTestId('vault-queue-refresh'))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(refresh.mock.calls[0][0]).toBeUndefined()
  })

  it('labels the total partial and NAMES an unreadable chain, with a Retry (FR-019)', () => {
    queueCtx = {
      ...queueCtx,
      byChain: {
        137: { state: 'read', proposals: [proposal(137, H1)], partial: false, owner: true },
        8453: { state: 'unreadable', proposals: [], error: 'rpc down', owner: false },
      },
      rows: [proposal(137, H1)],
      missing: [8453],
      partial: true,
    }
    render(<VaultQueueView group={group(137)} />)
    const summary = screen.getByTestId('vault-queue-summary')
    expect(summary).toHaveAttribute('data-partial', 'true')
    expect(summary).toHaveTextContent(/Base not read/)
    const baseLine = screen.getAllByTestId('vault-queue-chain').find((li) => li.getAttribute('data-chain-id') === '8453')
    expect(baseLine).toHaveAttribute('data-state', 'unreadable')
    expect(baseLine).toHaveTextContent(/Base: could not be read/)
    fireEvent.click(within(baseLine).getByRole('button', { name: /retry/i }))
    expect(refresh).toHaveBeenCalledWith(8453)
    // Only the readable chain's rows exist.
    expect(screen.getAllByTestId('vault-queue-row')).toHaveLength(1)
  })

  it('states not-configured and not-supported chains, never as "none pending"', () => {
    const g = group(137, { chainIds: [137, 63, 999] })
    queueCtx = {
      ...queueCtx,
      byChain: {
        137: { state: 'read', proposals: [], partial: false, owner: true },
        63: { state: 'not-configured', proposals: [] },
        999: { state: 'not-supported', proposals: [] },
      },
      rows: [],
      missing: [63, 999],
      partial: true,
    }
    render(<VaultQueueView group={g} />)
    const chains = screen.getAllByTestId('vault-queue-chain')
    expect(chains[0]).toHaveTextContent('Polygon: none pending')
    expect(chains[1]).toHaveTextContent(/Ethereum Classic Mordor: proposal history is not configured on this network/)
    expect(chains[2]).toHaveTextContent('Chain 999: not supported in this build')
    expect(screen.getByTestId('vault-queue-empty')).toHaveTextContent(/nothing waiting for a signature/i)
  })

  it('never shows a spinner-only state: while reading it says how many networks', () => {
    queueCtx = { ...queueCtx, byChain: { 137: { state: 'loading', proposals: [] }, 8453: { state: 'loading', proposals: [] } }, rows: [], loading: true }
    render(<VaultQueueView group={group(137)} />)
    expect(screen.getByTestId('vault-queue-summary')).toHaveTextContent('Reading 2 networks…')
    queueCtx = { ...queueCtx, byChain: {}, rows: [], loading: false }
    render(<VaultQueueView group={group(137)} />)
    // First paint before the hook commits: still "reading", not "nothing could be read".
    expect(screen.getAllByTestId('vault-queue-summary')[1]).toHaveTextContent(/Reading 2 networks/)
  })

  it('acts immediately on a row on the connected chain', async () => {
    render(<VaultQueueView group={group(137)} />)
    const row = screen.getAllByTestId('vault-queue-row')[0]
    fireEvent.click(within(row).getByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith(H1))
    expect(walletCtx.switchNetwork).not.toHaveBeenCalled()
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(137))
  })

  it('switches the wallet first for a row on another chain, then acts ONCE with the rebound hook (FR-007)', async () => {
    const { rerender } = render(<VaultQueueView group={group(137)} />)
    const baseRow = screen.getAllByTestId('vault-queue-row')[1]
    fireEvent.click(within(baseRow).getByRole('button', { name: /^approve$/i }))
    await waitFor(() => expect(walletCtx.switchNetwork).toHaveBeenCalledWith(8453))
    // The wallet accepted but has not re-bound yet: nothing signed.
    expect(approve).not.toHaveBeenCalled()

    // Wallet lands on Base; the hook re-binds to the Base instance.
    const rebound = vi.fn().mockResolvedValue(undefined)
    walletCtx = { ...walletCtx, chainId: 8453 }
    proposalsCtx = (vault) => ({ approve: vault?.chainId === 8453 ? rebound : approve, execute, cancel, queue: [], history: [] })
    rerender(<VaultQueueView group={group(8453)} />)
    await waitFor(() => expect(rebound).toHaveBeenCalledWith(H2))
    expect(rebound).toHaveBeenCalledTimes(1)
    expect(approve).not.toHaveBeenCalled()
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(8453))

    // A later re-render does not replay the action.
    rerender(<VaultQueueView group={group(8453)} />)
    expect(rebound).toHaveBeenCalledTimes(1)
  })

  it('states a refused switch per row, naming both chains, and signs nothing', async () => {
    walletCtx = { ...walletCtx, switchNetwork: vi.fn().mockRejectedValue(new Error('User rejected')) }
    render(<VaultQueueView group={group(137)} />)
    const baseRow = screen.getAllByTestId('vault-queue-row')[1]
    fireEvent.click(within(baseRow).getByRole('button', { name: /^approve$/i }))
    const alert = await within(baseRow).findByRole('alert')
    expect(alert).toHaveTextContent('Approval not sent — this proposal is on Base, and the wallet stayed on Polygon.')
    expect(approve).not.toHaveBeenCalled()
    expect(screen.getAllByTestId('vault-queue-row')).toHaveLength(2)
  })

  it('renders a row read-only where the member is not an owner on THAT chain (FR-008)', () => {
    queueCtx.byChain[8453] = { ...queueCtx.byChain[8453], owner: false }
    render(<VaultQueueView group={group(137)} />)
    const [polygonRow, baseRow] = screen.getAllByTestId('vault-queue-row')
    expect(within(polygonRow).getByRole('button', { name: /^approve$/i })).toBeInTheDocument()
    expect(within(baseRow).queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument()
    expect(within(baseRow).getByTestId('vault-queue-viewonly')).toHaveTextContent('view-only on Base')
  })

  it('offers Execute for a ready proposal and marks one the member already approved', () => {
    queueCtx.byChain[137].proposals = [proposal(137, H1, { status: 'ready', approvals: 2, approvers: [ME, OTHER] })]
    queueCtx.rows = [...queueCtx.byChain[137].proposals, proposal(8453, H2, { approvers: [ME] })]
    render(<VaultQueueView group={group(137)} />)
    const [readyRow, approvedRow] = screen.getAllByTestId('vault-queue-row')
    fireEvent.click(within(readyRow).getByRole('button', { name: /^execute$/i }))
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ safeTxHash: H1 }))
    expect(within(approvedRow).getByRole('button', { name: /^approved$/i })).toBeDisabled()
  })

  it('has no axe violations', async () => {
    const { container } = render(<VaultQueueView group={group(137)} />)
    expect(await axe(container)).toHaveNoViolations()
  })

  it('names a recipient from the address book, and keeps the address as the fact beside it', async () => {
    const to = String(queueCtx.rows[0].to).toLowerCase()
    names = { [to]: { displayName: 'Alice', source: 'addressBook', address: queueCtx.rows[0].to } }
    render(<VaultQueueView group={group(137)} />)
    const line = screen.getAllByTestId('vault-queue-to')[0]
    expect(line).toHaveAttribute('data-source', 'addressBook')
    expect(line).toHaveTextContent('Alice')
    // A generated two-word name is not a name the member gave: the full address stays.
    const generated = screen.getAllByTestId('vault-queue-to').find((el) => el.dataset.source === 'generated')
    if (generated) expect(generated.textContent).not.toContain('Quiet Otter')
    // The full address is never lost: it rides on the element for copy/hover and the accessible name.
    expect(line).toHaveAttribute('title', queueCtx.rows[0].to)
  })
})

/**
 * A member who IS an owner but whose session cannot sign on the connected network.
 *
 * Ethereum Classic and Mordor have no bundler, so a keyless passkey session cannot submit there —
 * but the buttons still rendered, and the refusal arrived from inside the batch sender after the
 * tap. The rail is knowable beforehand (lib/chains/writeRail.js), so it is said beforehand.
 */
describe('VaultQueueView — a network this session cannot sign on', () => {
  const RAIL_REASON =
    'Passkey transactions are not available on Ethereum Classic. Connect a wallet that can sign there ' +
    '— a browser wallet, a hardware wallet, or a recovered account — to act on this network.'

  it('states WHY instead of offering an action that would throw', () => {
    proposalsCtx = () => ({
      approve,
      execute,
      cancel,
      queue: [],
      history: [],
      writeRail: { rail: 'passkey', available: false, reason: RAIL_REASON },
    })
    render(<VaultQueueView group={group(137)} />)

    const notice = screen.getAllByTestId('vault-queue-norail')[0]
    expect(notice).toHaveTextContent(/not available on Ethereum Classic/i)
    // The way out, not just the obstacle.
    expect(notice).toHaveTextContent(/hardware wallet/i)
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument()
    // …and it is NOT relabelled "view-only": the member IS an owner, which is a different fact.
    expect(screen.queryByTestId('vault-queue-viewonly')).not.toBeInTheDocument()
  })

  it('offers the actions when a SIGNER can sign there, whatever the login was', () => {
    // The regression that motivated the change: a hardware wallet signs and pays gas on ETC
    // natively, so nothing about a passkey login should withhold these controls.
    proposalsCtx = () => ({
      approve,
      execute,
      cancel,
      queue: [],
      history: [],
      writeRail: { rail: 'signer', available: true, reason: null },
    })
    render(<VaultQueueView group={group(137)} />)

    expect(screen.getAllByRole('button', { name: /^approve$/i }).length).toBeGreaterThan(0)
    expect(screen.queryByTestId('vault-queue-norail')).not.toBeInTheDocument()
  })

  it('keeps behaving as before when a surface supplies no rail at all', () => {
    // Back-compat: the hook is mocked in several suites that predate `writeRail`.
    proposalsCtx = () => ({ approve, execute, cancel, queue: [], history: [] })
    render(<VaultQueueView group={group(137)} />)
    expect(screen.getAllByRole('button', { name: /^approve$/i }).length).toBeGreaterThan(0)
  })

  // ---------------------------------------------------------------------------
  // Spec 105 (US5) — chips, needs-you, decoded rows
  // ---------------------------------------------------------------------------
  it('chips filter the rows without touching the per-chain read disclosure (FR-021)', () => {
    render(<VaultQueueView group={group(137)} />)
    expect(screen.getAllByTestId('vault-queue-row')).toHaveLength(2)
    fireEvent.click(screen.getByTestId('vault-queue-chip-8453'))
    const rows = screen.getAllByTestId('vault-queue-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-chain-id', '8453')
    // The four-state per-chain disclosure is untouched by the chip.
    expect(screen.getAllByTestId('vault-queue-chain')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getAllByTestId('vault-queue-row')).toHaveLength(2)
  })

  it('"Needs you" counts pending items awaiting THIS member and filters to them (FR-023)', () => {
    // H1: not yet approved by ME (needs me). H2: already approved by ME (waits on the other owner).
    queueCtx.byChain[8453].proposals = [proposal(8453, H2, { approvers: [ME] })]
    queueCtx.rows = [proposal(137, H1), proposal(8453, H2, { approvers: [ME] })]
    render(<VaultQueueView group={group(137)} />)
    const chip = screen.getByTestId('vault-queue-chip-needs-you')
    expect(chip).toHaveTextContent('Needs you (1)')
    fireEvent.click(chip)
    const rows = screen.getAllByTestId('vault-queue-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-chain-id', '137')
    expect(within(rows[0]).getByTestId('vault-queue-signed')).toHaveTextContent('1 of 2 signed · needs you')
  })

  it('an approved item says whom it waits on, not "needs you"', () => {
    queueCtx.rows = [proposal(137, H1, { approvers: [ME] })]
    queueCtx.byChain[137].proposals = queueCtx.rows
    render(<VaultQueueView group={group(137)} />)
    expect(screen.getByTestId('vault-queue-signed')).toHaveTextContent(/waiting on other owners/i)
  })

  it('a recognised native send is described in plain language; unknown calldata keeps the raw row (FR-022)', () => {
    queueCtx.rows = [
      proposal(137, H1, { value: '1500000000000000000', data: '0x' }),
      proposal(8453, H2, { data: '0xdeadbeef' }),
    ]
    queueCtx.byChain[137].proposals = [queueCtx.rows[0]]
    queueCtx.byChain[8453].proposals = [queueCtx.rows[1]]
    render(<VaultQueueView group={group(137)} />)
    const titles = screen.getAllByTestId('vault-queue-title')
    expect(titles).toHaveLength(1)
    expect(titles[0]).toHaveTextContent(/Send 1\.5 POL on Polygon/)
    // The undecoded row still renders honestly (hash + recipient), with no guessed title.
    expect(screen.getAllByTestId('vault-queue-row')).toHaveLength(2)
  })

  it('states the honest footer: queued items stay on their own chain', () => {
    render(<VaultQueueView group={group(137)} />)
    expect(screen.getByText(/queued items stay on their own chain/i)).toBeInTheDocument()
  })
})

