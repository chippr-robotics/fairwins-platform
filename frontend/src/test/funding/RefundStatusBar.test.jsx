import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import RefundStatusBar from '../../components/funding/RefundStatusBar'

const open = {
  state: 0, refundVotes: 1, refundVotesNeeded: 2, refundedCount: 0, contributorCount: 3, refundReason: null,
  tokenSymbol: 'USDC', me: { hasContributed: true, voted: false, refunded: false, contributedFormatted: '10' },
}

describe('RefundStatusBar (FR-018)', () => {
  it('while open: votes of needed, and the member’s own standing', async () => {
    const { container } = render(<RefundStatusBar summary={open} />)
    expect(screen.getByTestId('refund-count')).toHaveTextContent('1 / 2')
    expect(screen.getByRole('progressbar', { name: /refund votes/i })).toHaveAttribute('aria-valuetext', '1 of 2 votes needed to refund everyone')
    expect(screen.getByTestId('refund-standing')).toHaveTextContent('You have not voted.')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('shows "You voted" once cast, and no standing for a non-contributor', () => {
    const { rerender } = render(<RefundStatusBar summary={{ ...open, me: { ...open.me, voted: true } }} />)
    expect(screen.getByTestId('refund-standing')).toHaveTextContent('You voted to refund.')
    rerender(<RefundStatusBar summary={{ ...open, me: { hasContributed: false, voted: false } }} />)
    expect(screen.queryByTestId('refund-standing')).toBeNull()
  })

  it('with no contributors it says there is nothing to refund', () => {
    render(<RefundStatusBar summary={{ ...open, contributorCount: 0, refundVotesNeeded: 0, refundVotes: 0, me: {} }} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'No contributors yet — nothing to refund')
  })

  it('while refunding: collected of total, the reason, and whether the member has collected', () => {
    const refunding = { ...open, state: 2, refundedCount: 1, refundReason: 'majority' }
    const { rerender } = render(<RefundStatusBar summary={refunding} />)
    expect(screen.getByTestId('refund-count')).toHaveTextContent('1 / 3')
    expect(screen.getByTestId('refund-reason')).toHaveTextContent('A majority of contributors voted to refund.')
    expect(screen.getByTestId('refund-standing')).toHaveTextContent('Your 10 USDC is waiting for you to collect.')
    rerender(<RefundStatusBar summary={{ ...refunding, me: { ...refunding.me, refunded: true } }} />)
    expect(screen.getByTestId('refund-standing')).toHaveTextContent('You have collected your contribution.')
  })

  it('renders nothing for a closed pool', () => {
    const { container } = render(<RefundStatusBar summary={{ ...open, state: 1 }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
