import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import FundingProgress from '../../components/funding/FundingProgress'

const base = {
  progressPct: 33.33, raisedFormatted: '40', goalFormatted: '120', tokenSymbol: 'USDC', goalMet: false,
  contributorCount: 2, contributeDeadline: 2_000_000, state: 0, stateLabel: 'Open',
}

describe('FundingProgress (FR-010)', () => {
  it('is an accessible progressbar whose value text is a full sentence', async () => {
    const { container } = render(<FundingProgress summary={base} now={1_900_000} />)
    const bar = screen.getByRole('progressbar', { name: /progress toward the goal/i })
    expect(bar).toHaveAttribute('aria-valuenow', '33')
    expect(bar).toHaveAttribute('aria-valuetext', '40 of 120 USDC raised (33%)')
    expect(screen.getByTestId('funding-contributors')).toHaveTextContent('2 contributors')
    expect(screen.getByTestId('funding-when')).toHaveTextContent('1 day left')
    expect(screen.getByTestId('funding-pct')).toHaveTextContent('33%')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('says "Goal met" instead of a percentage once the goal is reached, and caps at 100', () => {
    render(<FundingProgress summary={{ ...base, progressPct: 100, raisedFormatted: '150', goalMet: true, contributorCount: 1 }} />)
    expect(screen.getByTestId('funding-goal-met')).toBeInTheDocument()
    expect(screen.queryByTestId('funding-pct')).toBeNull()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByTestId('funding-contributors')).toHaveTextContent('1 contributor')
  })

  it('reports closed contributions honestly, and the terminal state label after that', () => {
    const { rerender } = render(<FundingProgress summary={base} now={2_000_001} />)
    expect(screen.getByTestId('funding-when')).toHaveTextContent('contributions closed')
    rerender(<FundingProgress summary={{ ...base, state: 2, stateLabel: 'Refunding' }} now={2_000_001} />)
    expect(screen.getByTestId('funding-when')).toHaveTextContent('Refunding')
  })
})
