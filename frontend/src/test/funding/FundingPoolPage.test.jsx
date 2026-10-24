import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { axe } from 'vitest-axe'

vi.mock('../../hooks', () => ({
  useWallet: () => ({ isConnected: true, address: walletHolder.address, openConnectModal: vi.fn() }),
  useWalletNetwork: () => ({ chainId: walletHolder.chainId }),
}))
vi.mock('../../hooks/useFundingPools', () => ({ useFundingPools: () => hookHolder.value }))
vi.mock('qrcode.react', () => ({ QRCodeSVG: () => <svg data-testid="qr" /> }))

import FundingPoolPage from '../../pages/FundingPoolPage'

const ORG = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const POOL = '0x5067457698Fd6Fa1C6964e416b3f42713513B3dD'
const walletHolder = { address: ME, chainId: 1337 }
const hookHolder = { value: null }

const NOW = Math.floor(Date.now() / 1000)
function summary(over = {}) {
  return {
    address: POOL, chainId: 1337, organizer: ORG, organizerAlias: 'Brave Otter', isOrganizer: false,
    purpose: "Dana's surprise party", goal: 120_000_000n, goalFormatted: '120', totalRaised: 40_000_000n, raisedFormatted: '40',
    progressPct: 33.33, goalMet: false, tokenAddress: '0xT', tokenSymbol: 'USDC', tokenDecimals: 6,
    contributorCount: 2, refundVotes: 0, refundVotesNeeded: 2, refundedCount: 0, refundReason: null,
    state: 0, stateLabel: 'Open', contributeDeadline: NOW + 86400, settleDeadline: NOW + 30 * 86400, createdBlock: 10, closedAt: 0,
    contributionOpen: true, canClose: false, canCancel: false, canPokeDeadline: false,
    me: { contributed: 0n, contributedFormatted: '0', hasContributed: false, voted: false, refunded: false, canVote: false, canClaimRefund: false },
    wordIndices: [1, 2, 3, 4], phrase: 'river amber tiger kite',
    ...over,
  }
}
function hook(over = {}) {
  return {
    status: 'idle', error: null,
    resolveRef: vi.fn(async (ref) => (ref.address ? ref.address : POOL)),
    getSummary: vi.fn(async () => summary()),
    getActivity: vi.fn(async () => []),
    contribute: vi.fn(async () => ({})), closePool: vi.fn(async () => ({})), cancelPool: vi.fn(async () => ({})),
    voteRefund: vi.fn(async () => ({})), claimRefund: vi.fn(async () => ({})), pokeDeadline: vi.fn(async () => ({})),
    ...over,
  }
}
const renderPage = (ref = POOL) =>
  render(
    <MemoryRouter initialEntries={[`/fund/${ref}`]}>
      <Routes><Route path="/fund/:ref" element={<FundingPoolPage />} /></Routes>
    </MemoryRouter>
  )

describe('FundingPoolPage', () => {
  beforeEach(() => { walletHolder.address = ME; walletHolder.chainId = 1337; hookHolder.value = hook() })

  it('shows purpose, state, progress, share row and an empty feed for an open pool (contributor view)', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByTestId('funding-purpose')).toHaveTextContent("Dana's surprise party"))
    expect(screen.getByTestId('funding-state')).toHaveTextContent('Open')
    expect(screen.getByRole('progressbar', { name: /progress toward the goal/i })).toHaveAttribute('aria-valuetext', '40 of 120 USDC raised (33%)')
    expect(screen.getByTestId('contribute-control')).toBeInTheDocument()
    expect(screen.queryByTestId('close-pool')).toBeNull()
    expect(screen.getByTestId('funding-phrase')).toHaveTextContent('river amber tiger kite')
    expect(screen.getByTestId('funding-link')).toHaveTextContent('/fund/river-amber-tiger-kite')
    await waitFor(() => expect(screen.getByTestId('feed-empty')).toBeInTheDocument())
    expect(await axe(container)).toHaveNoViolations()
  })

  it('resolves four words to the pool and contributes the typed amount', async () => {
    renderPage('river-amber-tiger-kite')
    await waitFor(() => expect(screen.getByTestId('funding-purpose')).toBeInTheDocument())
    expect(hookHolder.value.resolveRef).toHaveBeenCalledWith({ words: ['river', 'amber', 'tiger', 'kite'] })
    fireEvent.click(screen.getByRole('button', { name: '2' }))
    fireEvent.click(screen.getByRole('button', { name: '5' }))
    fireEvent.click(screen.getByTestId('contribute'))
    await waitFor(() => expect(hookHolder.value.contribute).toHaveBeenCalledWith(POOL, '25', expect.objectContaining({ address: POOL })))
    expect(hookHolder.value.getSummary).toHaveBeenCalledTimes(2) // reload after the write
  })

  it('organizer: close confirm names amount, destination and finality; the close is final', async () => {
    walletHolder.address = ORG
    hookHolder.value = hook({ getSummary: vi.fn(async () => summary({ isOrganizer: true, canClose: true, canCancel: true })) })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('close-pool')).toHaveTextContent('Close & collect 40 USDC'))
    fireEvent.click(screen.getByTestId('close-pool'))
    const confirm = screen.getByTestId('confirm-close')
    expect(confirm).toHaveTextContent('40 USDC')
    expect(confirm).toHaveTextContent(/Your account/)
    expect(confirm).toHaveTextContent(/not yet met, and that’s allowed/)
    expect(confirm).toHaveTextContent(/This is final/)
    fireEvent.click(screen.getByTestId('confirm-close-go'))
    await waitFor(() => expect(hookHolder.value.closePool).toHaveBeenCalledWith(POOL))
  })

  it('organizer: refund-everyone confirm and cancel', async () => {
    walletHolder.address = ORG
    hookHolder.value = hook({ getSummary: vi.fn(async () => summary({ isOrganizer: true })) })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('cancel-pool')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('cancel-pool'))
    expect(screen.getByTestId('confirm-cancel')).toHaveTextContent(/exactly what they put in/)
    fireEvent.click(screen.getByTestId('confirm-cancel-go'))
    await waitFor(() => expect(hookHolder.value.cancelPool).toHaveBeenCalledWith(POOL))
  })

  it('contributor: vote to refund with a confirm that says the organizer can still close', async () => {
    hookHolder.value = hook({ getSummary: vi.fn(async () => summary({ me: { ...summary().me, hasContributed: true, canVote: true, contributedFormatted: '10' } })) })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('vote-refund')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('vote-refund'))
    expect(screen.getByTestId('confirm-vote')).toHaveTextContent(/organizer can still close/)
    fireEvent.click(screen.getByTestId('confirm-vote-go'))
    await waitFor(() => expect(hookHolder.value.voteRefund).toHaveBeenCalledWith(POOL))
    expect(screen.getByTestId('refund-status')).toHaveTextContent('0 / 2')
  })

  it('refunding: collect my contribution; closed: sentence, no controls', async () => {
    hookHolder.value = hook({ getSummary: vi.fn(async () => summary({ state: 2, stateLabel: 'Refunding', refundReason: 'majority', contributionOpen: false, me: { ...summary().me, hasContributed: true, contributedFormatted: '10', canClaimRefund: true } })) })
    const { unmount } = renderPage()
    await waitFor(() => expect(screen.getByTestId('claim-refund')).toHaveTextContent('Collect my 10 USDC back'))
    expect(screen.getByTestId('refund-reason')).toHaveTextContent(/majority/)
    fireEvent.click(screen.getByTestId('claim-refund'))
    await waitFor(() => expect(hookHolder.value.claimRefund).toHaveBeenCalledWith(POOL))
    unmount()
    hookHolder.value = hook({ getSummary: vi.fn(async () => summary({ state: 1, stateLabel: 'Closed', contributionOpen: false })) })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('funding-closed')).toHaveTextContent('40 USDC was collected by the organizer'))
    expect(screen.queryByTestId('contribute-control')).toBeNull()
    expect(screen.queryByTestId('refund-status')).toBeNull()
  })

  it('past the contribute deadline: no contribute control, an honest sentence; past settle: the poke', async () => {
    hookHolder.value = hook({ getSummary: vi.fn(async () => summary({ contributionOpen: false, contributeDeadline: NOW - 10 })) })
    const { unmount } = renderPage()
    await waitFor(() => expect(screen.getByTestId('contributions-closed')).toHaveTextContent(/Contributions closed/))
    expect(screen.queryByTestId('contribute-control')).toBeNull()
    unmount()
    hookHolder.value = hook({ getSummary: vi.fn(async () => summary({ contributionOpen: false, contributeDeadline: NOW - 100, settleDeadline: NOW - 10, canPokeDeadline: true })) })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('poke-deadline')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('poke-deadline'))
    await waitFor(() => expect(hookHolder.value.pokeDeadline).toHaveBeenCalledWith(POOL))
  })

  it('unreadable pool: sentence + retry (never zeros); unknown words: not found', async () => {
    hookHolder.value = hook({ getSummary: vi.fn().mockRejectedValueOnce(new Error('rpc down')).mockResolvedValue(summary()) })
    const { unmount } = renderPage()
    await waitFor(() => expect(screen.getByTestId('funding-unreadable')).toHaveTextContent(/rpc down/))
    expect(screen.queryByRole('progressbar')).toBeNull()
    fireEvent.click(screen.getByTestId('funding-retry'))
    await waitFor(() => expect(screen.getByTestId('funding-purpose')).toBeInTheDocument())
    unmount()
    hookHolder.value = hook({ resolveRef: vi.fn(async () => null) })
    renderPage('no-such-words-here')
    await waitFor(() => expect(screen.getByTestId('funding-not-found')).toBeInTheDocument())
  })

  it('wrong network: names both networks and withholds every control', async () => {
    walletHolder.chainId = 137
    walletHolder.address = ORG
    hookHolder.value = hook({ getSummary: vi.fn(async () => summary({ isOrganizer: true })) })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('funding-wrong-network')).toHaveTextContent('network 1337; your wallet is on 137'))
    expect(screen.queryByTestId('close-pool')).toBeNull()
    expect(screen.queryByTestId('contribute-control')).toBeNull()
  })

  it('feed: shows entries and an unreadable feed with retry while totals stay honest', async () => {
    hookHolder.value = hook({ getActivity: vi.fn().mockRejectedValueOnce(new Error('no logs')).mockResolvedValue([
      { kind: 'contribute', actor: ME, alias: 'Quiet Fox', amount: 40_000_000n, blockNumber: 12, logIndex: 0, txHash: '0x1', timestamp: NOW },
    ]) })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('feed-retry')).toBeInTheDocument())
    expect(screen.getByTestId('funding-raised')).toHaveTextContent('40')
    fireEvent.click(screen.getByTestId('feed-retry'))
    await waitFor(() => expect(screen.getByTestId('feed-entry')).toHaveTextContent('You contributed 40 USDC'))
  })
})
