/**
 * PositionsList (spec 057 US2) — positions render, Sell opens the confirm (SELL mode), and an
 * illiquid position (no bid) disables Sell honestly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import PositionsList from '../../components/predict/PositionsList'

const positionsState = { current: null }
vi.mock('../../hooks/usePredictPortfolio', () => ({
  usePredictPositions: () => positionsState.current,
}))
// TradeConfirm pulls the trade hook — stub it.
vi.mock('../../hooks/usePredictTrade', () => ({
  usePredictTrade: () => ({ status: 'idle', loadFee: vi.fn(), preview: vi.fn(), submit: vi.fn(), fee: null, onWrongNetwork: false, canTrade: true }),
}))

function make(over = {}) {
  return {
    status: 'ready',
    positions: [
      { tokenId: '123', outcome: 'Yes', size: '100', bestBid: { amount: '0.55', currency: 'USDC' } },
      { tokenId: '456', outcome: 'No', size: '20', bestBid: null }, // illiquid
    ],
    refresh: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  positionsState.current = make()
})

describe('PositionsList', () => {
  it('renders positions and opens a SELL confirm for one with a bid', () => {
    render(<PositionsList />)
    expect(screen.getByText('Yes')).toBeInTheDocument()
    const sellButtons = screen.getAllByRole('button', { name: 'Sell' })
    // Second position (no bid) is disabled.
    expect(sellButtons[1]).toBeDisabled()
    fireEvent.click(sellButtons[0])
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('is hidden entirely when disconnected', () => {
    positionsState.current = make({ status: 'disconnected', positions: [] })
    const { container } = render(<PositionsList />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows an empty state when the wallet holds no positions', () => {
    positionsState.current = make({ status: 'empty', positions: [] })
    render(<PositionsList />)
    expect(screen.getByText(/don't hold any/i)).toBeInTheDocument()
  })

  it('has no Refresh button — the list refreshes itself — and says so when a refresh failed', () => {
    render(<PositionsList />)
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull()
    positionsState.current = make({ stale: true })
    render(<PositionsList />)
    expect(screen.getByText(/Couldn.t refresh your positions just now/)).toBeInTheDocument()
  })
})
