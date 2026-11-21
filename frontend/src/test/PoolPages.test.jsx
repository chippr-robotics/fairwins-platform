import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ethers } from 'ethers'
import { saveProposedMatrix } from '../lib/pools/proposalStore'
import { payoutMatrixHash } from '../lib/pools/payout'

// PoolPage (spec 034, address-based): the routed pool-management view — live state + the member's
// address-derived alias (no signature, no reveal/restore) + the state-driven actions (creator
// close/cancel, member approve w/ progress, refund, resolved). The create/join entry flows are the
// GroupPoolModal bottom-sheet (see GroupPoolModal.test.jsx).

vi.mock('../hooks/useWalletManagement', () => ({ useWallet: vi.fn() }))
vi.mock('../hooks/usePools', () => ({ usePools: vi.fn() }))

import { useWallet } from '../hooks/useWalletManagement'
import { usePools } from '../hooks/usePools'
import PoolPage from '../pages/PoolPage'

const openSummary = {
  address: '0x00000000000000000000000000000000000000aa',
  state: 0, stateLabel: 'JoiningOpen', buyInFormatted: '10.0', tokenSymbol: 'USDC',
  memberCount: 2, maxMembers: 5, slotsRemaining: 3, thresholdPct: 60,
}

function base(overrides = {}) {
  return {
    status: 'idle', error: null,
    createPool: vi.fn(), resolvePhrase: vi.fn(), getPoolSummary: vi.fn(), joinPool: vi.fn(),
    getMembers: vi.fn().mockResolvedValue([]),
    getMyNickname: vi.fn().mockResolvedValue({ label: 'Prismatic Fox', suffix: '7b' }),
    // On-chain matrix reader (PRIMARY source). Default: no logs → PoolPage falls back to the paste/store.
    fetchProposedMatrix: vi.fn().mockResolvedValue(null),
    closeJoining: vi.fn().mockResolvedValue('0xtx'), cancelPool: vi.fn().mockResolvedValue('0xtx'),
    proposeOutcome: vi.fn(), vote: vi.fn().mockResolvedValue('0xtx'), claimWinnings: vi.fn(),
    refund: vi.fn().mockResolvedValue('0xtx'),
    ...overrides,
  }
}
function renderPoolAt(summary) {
  return render(
    <MemoryRouter initialEntries={[`/pools/${summary.address}`]}>
      <Routes>
        <Route path="/pools/:address" element={<PoolPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('PoolPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    useWallet.mockReturnValue({ account: '0x1111111111111111111111111111111111111111', isConnected: true })
  })

  it('renders live on-chain state with a human status label (not the raw enum name)', async () => {
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(openSummary) }))
    renderPoolAt(openSummary)
    const state = await screen.findByTestId('pool-state')
    expect(state).toHaveTextContent('Open')
    expect(state).not.toHaveTextContent('JoiningOpen')
  })

  it('auto-shows a joined member’s alias derived from their address (no click, no signature)', async () => {
    const sum = { ...openSummary, hasJoined: true }
    const getMyNickname = vi.fn().mockResolvedValue({ label: 'Prismatic Fox', suffix: '7b' })
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(sum), getMyNickname }))
    renderPoolAt(sum)
    expect(await screen.findByTestId('my-nickname')).toHaveTextContent('Prismatic Fox')
    expect(screen.queryByRole('button', { name: /reveal my nickname/i })).toBeNull()
    await waitFor(() => expect(getMyNickname).toHaveBeenCalledWith(sum.address))
  })

  it('lets a not-yet-joined viewer (including the creator) join while joining is open', async () => {
    const joinPool = vi.fn().mockResolvedValue({ txHash: '0xtx' })
    const sum = { ...openSummary, isCreator: true, hasJoined: false, state: 0, slotsRemaining: 3 }
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(sum), joinPool }))
    renderPoolAt(sum)
    fireEvent.click(await screen.findByTestId('join-pool'))
    await waitFor(() => expect(joinPool).toHaveBeenCalledWith(sum.address))
  })

  it('collapses the pool details into an expandable summary (default collapsed)', async () => {
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(openSummary) }))
    renderPoolAt(openSummary)
    const details = await screen.findByTestId('pool-summary')
    expect(details.tagName).toBe('DETAILS')
    expect(details.open).toBe(false)
  })

  it('shows no identity section to a viewer who has not joined (e.g. a creator outside the pool)', async () => {
    const sum = { ...openSummary, isCreator: true, hasJoined: false }
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(sum) }))
    renderPoolAt(sum)
    await screen.findByTestId('pool-state')
    expect(screen.queryByRole('button', { name: /reveal my nickname/i })).toBeNull()
    expect(screen.queryByTestId('my-nickname')).toBeNull()
  })

  it('the creator sees close/cancel while joining is open', async () => {
    const closeJoining = vi.fn().mockResolvedValue('0xtx')
    const sum = { ...openSummary, isCreator: true }
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(sum), closeJoining }))
    renderPoolAt(sum)
    fireEvent.click(await screen.findByTestId('close-joining'))
    await waitFor(() => expect(closeJoining).toHaveBeenCalledWith(sum.address))
    expect(screen.getByTestId('cancel-pool')).toBeInTheDocument()
  })

  // The approval is bound to the payout ON SCREEN (the residual of #1667). These three tests are the
  // page's half of that: what it hands the hook, what it refuses to offer, and what it does when the
  // hook says no. `SHOWN` is a real matrix so the id asserted below is a real hash of it, computed by
  // the same helper the contract's proposalId is defined by — not a placeholder the page could echo.
  const SHOWN = [
    { winner: '0x1111111111111111111111111111111111111111', amount: 15000000n },
    { winner: '0x2222222222222222222222222222222222222222', amount: 5000000n },
  ]
  const votingSummary = (over = {}) => ({
    ...openSummary, state: 1, stateLabel: 'JoiningClosed', withinResolutionWindow: true,
    currentProposalId: payoutMatrixHash(SHOWN), hasJoined: true, approvalCount: 1, requiredApprovals: 2,
    ...over,
  })

  it('a joined member approves the payout the page is showing (with progress)', async () => {
    const vote = vi.fn().mockResolvedValue('0xtx')
    const sum = votingSummary()
    usePools.mockReturnValue(base({
      getPoolSummary: vi.fn().mockResolvedValue(sum),
      fetchProposedMatrix: vi.fn().mockResolvedValue(SHOWN),
      vote,
    }))
    renderPoolAt(sum)
    expect(await screen.findByTestId('approval-progress')).toHaveTextContent('1 / 2')
    await waitFor(() => expect(screen.getByTestId('approve-outcome')).toBeEnabled())
    fireEvent.click(screen.getByTestId('approve-outcome'))
    await waitFor(() => expect(vote).toHaveBeenCalledTimes(1))
    const [pool, reviewedId, onProgress] = vote.mock.calls[0]
    expect(pool).toBe(sum.address)
    expect(reviewedId).toBe(payoutMatrixHash(SHOWN))
    expect(typeof onProgress).toBe('function')
  })

  it('binds the approval to the matrix on screen even when the summary names a different proposal', async () => {
    // The creator revised the payout: the chain's id has moved on, the page still shows the old
    // matrix. The id handed to the hook must be the hash of what is DISPLAYED — handing over the
    // summary's (or a fresh read's) id is exactly the bug: it approves a payout nobody was shown.
    const vote = vi.fn().mockResolvedValue('0xtx')
    const sum = votingSummary({ currentProposalId: `0x${'ab'.repeat(32)}` })
    usePools.mockReturnValue(base({
      getPoolSummary: vi.fn().mockResolvedValue(sum),
      fetchProposedMatrix: vi.fn().mockResolvedValue(SHOWN),
      vote,
    }))
    renderPoolAt(sum)
    await waitFor(() => expect(screen.getByTestId('approve-outcome')).toBeEnabled())
    fireEvent.click(screen.getByTestId('approve-outcome'))
    await waitFor(() => expect(vote).toHaveBeenCalledTimes(1))
    expect(vote.mock.calls[0][1]).toBe(payoutMatrixHash(SHOWN))
    expect(vote.mock.calls[0][1]).not.toBe(sum.currentProposalId)
  })

  it('does not offer approval while no payout is on screen', async () => {
    const vote = vi.fn().mockResolvedValue('0xtx')
    const sum = votingSummary()
    const fetchProposedMatrix = vi.fn().mockResolvedValue(null)
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(sum), fetchProposedMatrix, vote }))
    renderPoolAt(sum)
    expect(await screen.findByTestId('approval-progress')).toBeInTheDocument()
    await waitFor(() => expect(fetchProposedMatrix).toHaveBeenCalled())
    // The lookup has ANSWERED with nothing: now, and only now, the page may say so.
    expect(await screen.findByTestId('approve-needs-payout')).toBeInTheDocument()
    expect(screen.queryByTestId('approve-loading-payout')).not.toBeInTheDocument()
    expect(screen.getByTestId('approve-outcome')).toBeDisabled()
    fireEvent.click(screen.getByTestId('approve-outcome'))
    expect(vote).not.toHaveBeenCalled()
  })

  it('says it is still loading — not that the payout could not be shown — while the lookup is in flight', async () => {
    const vote = vi.fn().mockResolvedValue('0xtx')
    const sum = votingSummary()
    let answer
    const fetchProposedMatrix = vi.fn(() => new Promise((resolve) => { answer = resolve }))
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(sum), fetchProposedMatrix, vote }))
    renderPoolAt(sum)
    expect(await screen.findByTestId('approve-loading-payout')).toBeInTheDocument()
    expect(screen.queryByTestId('approve-needs-payout')).not.toBeInTheDocument()
    expect(screen.getByTestId('approve-outcome')).toBeDisabled()
    // The lookup answers with the matrix: both hints go, and approval is offered.
    answer(SHOWN)
    await waitFor(() => expect(screen.getByTestId('approve-outcome')).toBeEnabled())
    expect(screen.queryByTestId('approve-loading-payout')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approve-needs-payout')).not.toBeInTheDocument()
  })

  it('re-reads the pool and says why when an approval is refused', async () => {
    const vote = vi.fn().mockRejectedValue(new Error('The proposed payout changed after you reviewed it.'))
    const sum = votingSummary()
    const getPoolSummary = vi.fn().mockResolvedValue(sum)
    usePools.mockReturnValue(base({ getPoolSummary, fetchProposedMatrix: vi.fn().mockResolvedValue(SHOWN), vote }))
    renderPoolAt(sum)
    await waitFor(() => expect(screen.getByTestId('approve-outcome')).toBeEnabled())
    const readsBefore = getPoolSummary.mock.calls.length
    fireEvent.click(screen.getByTestId('approve-outcome'))
    await waitFor(() => expect(vote).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getPoolSummary.mock.calls.length).toBeGreaterThan(readsBefore))
    expect(await screen.findByText(/payout changed after you reviewed it/i)).toBeInTheDocument()
  })

  it('a refund-eligible member can recover the buy-in', async () => {
    const refund = vi.fn().mockResolvedValue('0xtx')
    const sum = { ...openSummary, state: 1, stateLabel: 'JoiningClosed', refundEligible: true }
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(sum), refund }))
    renderPoolAt(sum)
    fireEvent.click(await screen.findByTestId('refund'))
    await waitFor(() => expect(refund).toHaveBeenCalledWith(sum.address))
  })

  it('a resolved pool surfaces the resolved state', async () => {
    const sum = { ...openSummary, state: 2, stateLabel: 'Resolved' }
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(sum) }))
    renderPoolAt(sum)
    expect(await screen.findByTestId('pool-resolved')).toBeInTheDocument()
  })

  // ── On-chain payout matrix (OutcomeProposed) is the PRIMARY source; the pasted/stored copy is fallback ──
  const ACCOUNT = '0x1111111111111111111111111111111111111111'
  const OTHER = '0x2222222222222222222222222222222222222222'
  const resolvedSummary = {
    ...openSummary, state: 2, stateLabel: 'Resolved', hasJoined: true,
    tokenDecimals: 6, buyIn: ethers.parseUnits('10', 6), frozenDenominator: 2,
  }

  it('reads the proposed payout from the chain so a winner sees their share without a pasted code', async () => {
    const fetchProposedMatrix = vi.fn().mockResolvedValue([
      { winner: ACCOUNT, amount: 10000000n },
      { winner: OTHER, amount: 10000000n },
    ])
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(resolvedSummary), fetchProposedMatrix }))
    renderPoolAt(resolvedSummary)
    // The share is derived from the on-chain matrix alone — nothing was pasted/stored.
    expect(await screen.findByTestId('claim-amount')).toHaveTextContent('10.0 USDC')
    await waitFor(() => expect(fetchProposedMatrix).toHaveBeenCalledWith(resolvedSummary.address))
  })

  it('prefers the on-chain matrix over a stale pasted/stored copy', async () => {
    // Stored copy would give the winner 5; the chain says 10 — the chain must win.
    saveProposedMatrix(openSummary.address, '0xstored', [
      { winner: ACCOUNT, amount: 5000000n },
      { winner: OTHER, amount: 15000000n },
    ])
    const fetchProposedMatrix = vi.fn().mockResolvedValue([
      { winner: ACCOUNT, amount: 10000000n },
      { winner: OTHER, amount: 10000000n },
    ])
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(resolvedSummary), fetchProposedMatrix }))
    renderPoolAt(resolvedSummary)
    expect(await screen.findByTestId('claim-amount')).toHaveTextContent('10.0 USDC')
  })

  it('falls back to the pasted/stored matrix when the on-chain log query yields nothing', async () => {
    saveProposedMatrix(openSummary.address, '0xstored', [
      { winner: ACCOUNT, amount: 7000000n },
      { winner: OTHER, amount: 13000000n },
    ])
    // RPC without log support → null; PoolPage must still show the winner's share from the stored copy.
    const fetchProposedMatrix = vi.fn().mockResolvedValue(null)
    usePools.mockReturnValue(base({ getPoolSummary: vi.fn().mockResolvedValue(resolvedSummary), fetchProposedMatrix }))
    renderPoolAt(resolvedSummary)
    expect(await screen.findByTestId('claim-amount')).toHaveTextContent('7.0 USDC')
    await waitFor(() => expect(fetchProposedMatrix).toHaveBeenCalledWith(resolvedSummary.address))
  })
})
