import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import FundingActivityFeed from '../../components/funding/FundingActivityFeed'

const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const entries = [
  { kind: 'refund', actor: OTHER, alias: 'Brave Otter', amount: 5_000_000n, blockNumber: 9, logIndex: 0, txHash: '0xa', timestamp: 1_700_000_000 },
  { kind: 'refunding', actor: null, alias: null, reason: 'organizer', blockNumber: 8, logIndex: 0, txHash: '0xb', timestamp: 1_700_000_000 },
  { kind: 'vote', actor: ME, alias: 'Quiet Fox', votes: 1, needed: 2, blockNumber: 7, logIndex: 0, txHash: '0xc', timestamp: null },
  { kind: 'contribute', actor: ME, alias: 'Quiet Fox', amount: 12_500_000n, blockNumber: 6, logIndex: 1, txHash: '0xd', timestamp: 1_699_999_000 },
  { kind: 'close', actor: OTHER, alias: 'Brave Otter', amount: 0n, blockNumber: 5, logIndex: 0, txHash: '0xe', timestamp: 1_699_998_000 },
]

describe('FundingActivityFeed (FR-009)', () => {
  it('renders every entry as a sentence, naming the viewer as "You"', () => {
    render(<FundingActivityFeed entries={entries} status="ready" account={ME} tokenDecimals={6} tokenSymbol="USDC" />)
    const rows = screen.getAllByTestId('feed-entry').map((el) => el.textContent)
    expect(rows[0]).toContain('Brave Otter collected 5 USDC back')
    expect(rows[1]).toContain('Refunding started — The organizer chose to refund everyone.')
    expect(rows[2]).toContain('You voted to refund (1 of 2)')
    expect(rows[3]).toContain('You contributed 12.5 USDC')
    expect(rows[4]).toContain('The organizer closed the pool and collected 0 USDC')
  })

  it('has an honest empty state and an unreadable state with a live retry', () => {
    const onRetry = vi.fn()
    const { rerender } = render(<FundingActivityFeed entries={[]} status="ready" />)
    expect(screen.getByTestId('feed-empty')).toHaveTextContent('No contributions yet')
    rerender(<FundingActivityFeed entries={[]} status="error" onRetry={onRetry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the activity feed')
    fireEvent.click(screen.getByTestId('feed-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
    rerender(<FundingActivityFeed entries={[]} status="loading" />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading activity')
  })
})
