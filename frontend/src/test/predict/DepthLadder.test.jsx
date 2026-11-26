/**
 * DepthLadder (spec 114, FR-007) — a real table, asks above bids, five levels a side; an empty side says
 * so in words (never a zero row); a non-live book says "as of N s ago", and an unknown one draws nothing.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import DepthLadder from '../../components/predict/DepthLadder'
import { mkReading } from '../helpers/readings'

const level = (price, size) => [price, size]
const ASKS = [level('0.94', '220072.89'), level('0.95', '5120'), level('0.96', '40'), level('0.97', '12.5'), level('0.98', '3'), level('0.99', '9')]
const BIDS = [level('0.93', '284698.76'), level('0.92', '5120'), level('0.91', '40'), level('0.9', '7'), level('0.89', '2'), level('0.88', '1')]
const rowsOf = (tbodyIndex) => Array.from(document.querySelectorAll('tbody')[tbodyIndex].querySelectorAll('tr'))

describe('DepthLadder', () => {
  it('is a real table with a caption, asks above bids, the nearest five each', () => {
    render(<DepthLadder reading={mkReading('live', '0.935', { asks: ASKS, bids: BIDS })} label="25 bps increase, Yes" />)
    const table = screen.getByRole('table')
    expect(within(table).getByText(/Depth for 25 bps increase, Yes/)).toBeInTheDocument()
    const asks = rowsOf(0)
    const bids = rowsOf(1)
    expect(asks).toHaveLength(5)
    expect(bids).toHaveLength(5)
    // Asks run furthest-first so the best ask sits against the best bid.
    expect(asks.map((r) => r.children[1].textContent)).toEqual(['98¢', '97¢', '96¢', '95¢', '94¢'])
    expect(bids.map((r) => r.children[1].textContent)).toEqual(['93¢', '92¢', '91¢', '90¢', '89¢'])
    expect(asks[4].children[2].textContent).toBe('220.1K')
    expect(bids[3].children[2].textContent).toBe('7')
    expect(asks.every((r) => r.children[0].textContent === 'Ask')).toBe(true)
    expect(bids.every((r) => r.children[0].textContent === 'Bid')).toBe(true)
    // Asks are above bids in the document.
    const all = Array.from(document.querySelectorAll('tbody tr'))
    expect(all.indexOf(asks[0])).toBeLessThan(all.indexOf(bids[0]))
  })

  it('shows no age note when live', () => {
    render(<DepthLadder reading={mkReading('live')} />)
    expect(screen.queryByText(/as of/i)).toBeNull()
  })

  it('says "Nothing on offer" for an empty ask side and "No bids" for an empty bid side — never a zero row', () => {
    const { unmount } = render(<DepthLadder reading={mkReading('live', '0.5', { asks: [], bids: BIDS })} />)
    expect(screen.getByText('Nothing on offer')).toBeInTheDocument()
    expect(screen.queryByText('No bids')).toBeNull()
    expect(rowsOf(1)).toHaveLength(5)
    unmount()
    render(<DepthLadder reading={mkReading('live', '0.5', { asks: ASKS, bids: [] })} />)
    expect(screen.getByText('No bids')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/\b0¢|\b0\b shares/)
  })

  it('says both when the whole book is empty (a real state)', () => {
    render(<DepthLadder reading={mkReading('live', '0.5', { asks: [], bids: [] })} />)
    expect(screen.getByText('Nothing on offer')).toBeInTheDocument()
    expect(screen.getByText('No bids')).toBeInTheDocument()
  })

  it('a delayed book says so with its age in words — it is not merely dimmed', () => {
    render(<DepthLadder reading={mkReading('delayed', '0.5', { ageMs: 12_000 })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Delayed — as of 12 s ago, not live/)
    expect(document.querySelector('.event-depth--stale')).not.toBeNull()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('a last-known book says so with its age', () => {
    render(<DepthLadder reading={mkReading('last-known', '0.5', { ageMs: 120_000 })} />)
    expect(screen.getByRole('status')).toHaveTextContent(/Last known — as of 2 min ago/)
  })

  it('an unknown reading says depth is unavailable and draws no table', () => {
    const { unmount } = render(<DepthLadder reading={mkReading('unknown')} />)
    expect(screen.getByText('Depth is unavailable right now.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
    unmount()
    render(<DepthLadder reading={undefined} />)
    expect(screen.getByText('Depth is unavailable right now.')).toBeInTheDocument()
  })

  it('shows fine ticks without rounding them away', () => {
    render(<DepthLadder reading={mkReading('live', '0.935', { asks: [level('0.935', '10')], bids: [level('0.934', '10')] })} />)
    expect(screen.getByText('93.5¢')).toBeInTheDocument()
    expect(screen.getByText('93.4¢')).toBeInTheDocument()
  })

  it('has no axe violations, live or stale', async () => {
    const { container, rerender } = render(<DepthLadder reading={mkReading('live', '0.5', { asks: ASKS, bids: BIDS })} label="x" />)
    expect(await axe(container)).toHaveNoViolations()
    rerender(<DepthLadder reading={mkReading('delayed', '0.5', { asks: ASKS, bids: BIDS })} label="x" />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
