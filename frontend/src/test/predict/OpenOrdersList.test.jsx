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

  it('reads the venue\'s own order shape (id / original_size / size_matched), and prints "—" for what it did not state', async () => {
    const venue = { id: '0xv1', side: 'BUY', price: '0.4', original_size: '100', size_matched: '60' }
    const bare = { id: '0xv2', side: 'SELL', price: '0.7' }
    ordersState.current = make({ orders: [venue, bare] })
    render(<OpenOrdersList />)
    expect(screen.getByText('40/100 @ 0.4')).toBeInTheDocument()
    expect(screen.getByText('—/— @ 0.7')).toBeInTheDocument() // never a guessed 0
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0])
    await waitFor(() => expect(cancelSpy).toHaveBeenCalledWith(venue)) // cancel still gets the venue's object, id intact
  })

  it('a locked session says how to see the orders, and offers nothing that would sign — never a bare heading', () => {
    ordersState.current = make({ status: 'locked', orders: [] })
    render(<OpenOrdersList />)
    expect(screen.getByRole('status')).toHaveTextContent('Sign in to trading to see your open orders. This list does not ask for a signature itself.')
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('listitem')).toBeNull()
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
