/**
 * Where the order surfaces open from (spec 114 slice 5) and what the market-data seam is asked for.
 *  - live readings available: a card's Yes/No, an event page's Yes/No and Sell on a position all open the ONE
 *    amount-first ticket (sell mode for a position);
 *  - a gateway without the spec-114 routes (legacy list) or without the books route: the fixed-price sheet /
 *    confirm, unchanged — a member can always trade (FR-029);
 *  - the event page's ten-key budget holds IN TOTAL while a ticket is open, from a row or from a position.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, within, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { setWalletChain } from '../helpers/walletChain'
import PredictPanel from '../../components/predict/PredictPanel'
import * as client from '../../lib/predict/predictClient'
import { __resetRouteSupportForTests } from '../../lib/markets/routeSupport'
import { FED, RAIN, envelope, detailBody, mkRows } from '../fixtures/predictEvents'

vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchEvents: vi.fn(),
  fetchDiscover: vi.fn(),
  fetchEvent: vi.fn(),
  fetchHistory: vi.fn(),
  fetchMarkets: vi.fn(),
  fetchPositions: vi.fn().mockResolvedValue({ positions: [] }),
}))

// A feed that behaves like the real seam's reference counting, and remembers the largest set ever held at once.
const feed = vi.hoisted(() => ({ held: new Map(), max: 0 }))
vi.mock('../../lib/markets/feed', () => ({
  subscribe: (keys) => {
    for (const k of keys) feed.held.set(k, (feed.held.get(k) || 0) + 1)
    feed.max = Math.max(feed.max, feed.held.size)
    let done = false
    return () => {
      if (done) return
      done = true
      for (const k of keys) {
        const n = (feed.held.get(k) || 0) - 1
        if (n > 0) feed.held.set(k, n)
        else feed.held.delete(k)
      }
    }
  },
}))
vi.mock('recharts', async () => {
  const React = await import('react')
  return { ResponsiveContainer: ({ children }) => React.createElement('div', null, children), LineChart: ({ children }) => React.createElement('div', null, children), XAxis: () => null, YAxis: () => null, Line: () => null }
})
vi.mock('../../hooks/usePredictTrade', () => ({
  usePredictTrade: () => ({ status: 'idle', loadFee: vi.fn(), preview: vi.fn(), submit: vi.fn(), fee: null, onWrongNetwork: false, canTrade: true }),
}))

const positions = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock('../../hooks/usePredictPortfolio', () => ({
  usePredictPositions: () => ({
    status: 'ready',
    refresh: positions.refresh,
    positions: [{ tokenId: 'pos1', outcome: 'Yes', size: '100.5', negRisk: true, bestBid: { amount: '0.55', currency: 'USDC' } }],
  }),
  usePredictOpenOrders: () => ({ status: 'empty', orders: [], refresh: vi.fn() }),
}))

const page = (events) => ({ events, next: null, ...envelope() })
const renderAt = (url = '/wallet?tab=predict') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <PredictPanel />
    </MemoryRouter>,
  )
const SLUG = 'fed-decision-in-december'
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 10)) })

beforeEach(() => {
  vi.clearAllMocks()
  __resetRouteSupportForTests()
  feed.held.clear()
  feed.max = 0
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
  client.fetchEvents.mockResolvedValue(page([FED, RAIN]))
  client.fetchDiscover.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))
  client.fetchHistory.mockResolvedValue({ points: [], ...envelope() })
})

describe('Sell on a position', () => {
  it('opens the amount-first ticket in SELL mode, reading only that token', async () => {
    renderAt()
    await screen.findByText('Fed Decision in December?')
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
    const dialog = screen.getByRole('dialog', { name: 'Sell Yes — Yes position' })
    expect(dialog).toHaveClass('order-ticket')
    expect([...feed.held.keys()]).toEqual(['polymarket:pos1'])
    expect(within(dialog).queryByRole('group', { name: 'Outcome' })).toBeNull()
  })

  it('closing it refreshes the positions list (what was sold must show)', async () => {
    renderAt()
    await screen.findByText('Fed Decision in December?')
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
    positions.refresh.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await settle()
    expect(positions.refresh).toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('LEGACY gateway: Sell still opens the fixed-price confirm', async () => {
    client.fetchEvents.mockRejectedValue(Object.assign(new Error('not found'), { status: 404, code: 'http_404' }))
    client.fetchMarkets.mockResolvedValue({ markets: [], next: null, fetchedAt: envelope().confirmedAt, stale: false })
    renderAt()
    await settle()
    fireEvent.click(await screen.findByRole('button', { name: 'Sell' }))
    expect(screen.getByRole('dialog').className).toContain('trade-confirm')
    expect(document.querySelector('.order-ticket')).toBeNull()
  })
})

describe('the market-data budget (≤ 10 keys on an event page, in total)', () => {
  const ROWS = mkRows(12) // 12 outcomes: only eight rows' Yes tokens plus the selected row's two are subscribed
  beforeEach(() => {
    client.fetchEvent.mockResolvedValue(detailBody({ markets: ROWS }))
  })

  it('opening a ticket for a row far down the page adds NO key: the page selects that row, the ticket reads its two tokens', async () => {
    renderAt(`/wallet?tab=predict&event=${SLUG}`)
    await screen.findByRole('heading', { level: 2, name: 'Fed Decision in December?' })
    const rows = [...document.querySelectorAll('.event-page-row')]
    expect(rows).toHaveLength(12)
    const last = rows[rows.length - 1]
    fireEvent.click(within(last).getAllByRole('button', { name: /^Yes / })[0])
    expect(screen.getByRole('dialog')).toHaveClass('order-ticket')
    expect(feed.held.size).toBeLessThanOrEqual(10)
    expect(feed.max).toBeLessThanOrEqual(10)
    // and the ticket's two tokens are among them
    const label = last.querySelector('.event-page-row-label').textContent
    const idx = label.replace('Row ', '')
    expect(feed.held.has(`polymarket:y${idx}`)).toBe(true)
    expect(feed.held.has(`polymarket:n${idx}`)).toBe(true)
  })

  it('Sell on a position while the page is open: the page stands down, so the total stays within ten', async () => {
    renderAt(`/wallet?tab=predict&event=${SLUG}`)
    await screen.findByRole('heading', { level: 2, name: 'Fed Decision in December?' })
    expect(feed.held.size).toBe(9) // eight rows' Yes tokens + the first row's No
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
    expect(feed.max).toBeLessThanOrEqual(10)
    expect([...feed.held.keys()]).toEqual(['polymarket:pos1'])
    // Closing the ticket resumes the page's own readings.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await settle()
    expect(feed.held.size).toBe(9)
  })
})
