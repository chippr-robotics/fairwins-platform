/**
 * OpenOrdersList (spec 057 US3) — open orders render and Cancel routes through the trade hook's
 * gas-free cancel, then refreshes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import OpenOrdersList from '../../components/predict/OpenOrdersList'

const ordersState = { current: null }
const cancelSpy = vi.fn().mockResolvedValue({ cancelled: true })
vi.mock('../../hooks/usePredictPortfolio', () => ({
  usePredictOpenOrders: () => ordersState.current,
}))
vi.mock('../../hooks/usePredictTrade', () => ({
  usePredictTrade: () => ({ status: 'idle', cancel: cancelSpy }),
}))

function make(over = {}) {
  return {
    status: 'ready',
    orders: [{ orderId: '0xo1', side: 'BUY', price: '0.5', size: '100', remaining: '40' }],
    refresh: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  ordersState.current = make()
})

describe('OpenOrdersList', () => {
  it('renders open orders and cancels via the trade hook', async () => {
    render(<OpenOrdersList />)
    expect(screen.getByText('BUY')).toBeInTheDocument()
    expect(screen.getByText('40/100 @ 0.5')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(ordersState.current.orders[0]))
    expect(ordersState.current.refresh).toHaveBeenCalled()
  })

  it('is hidden when disconnected or empty', () => {
    ordersState.current = make({ status: 'empty', orders: [] })
    const { container } = render(<OpenOrdersList />)
    expect(container).toBeEmptyDOMElement()
  })

  it('has no Refresh button, and names a failed background refresh', () => {
    render(<OpenOrdersList />)
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull()
    ordersState.current = make({ stale: true })
    render(<OpenOrdersList />)
    expect(screen.getByText(/Couldn.t refresh your open orders just now/)).toBeInTheDocument()
  })
})
