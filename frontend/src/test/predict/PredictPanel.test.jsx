/**
 * PredictPanel (spec 057 US1, reworked by spec 114 US1) — the event browse list. Verifies one card per
 * event, category/sort/search living in the address (and restoring from it), the list's trust chip never
 * saying "Live", the honest empty/degraded states, and that a Yes/No button still opens the existing
 * detail sheet for the adapted market.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { axe } from 'vitest-axe'
import { setWalletChain } from '../helpers/walletChain'
import PredictPanel from '../../components/predict/PredictPanel'
import * as client from '../../lib/predict/predictClient'
import { FED, RAIN, envelope } from '../fixtures/predictEvents'

vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchEvents: vi.fn(),
  fetchMarkets: vi.fn(),
  fetchPositions: vi.fn().mockResolvedValue({ positions: [] }),
}))
// TradeConfirm (rendered inside the detail sheet) pulls the trade hook — stub it out.
vi.mock('../../hooks/usePredictTrade', () => ({
  usePredictTrade: () => ({ status: 'idle', loadFee: vi.fn(), preview: vi.fn(), submit: vi.fn(), fee: null, onWrongNetwork: false, canTrade: true }),
}))

const page = (events, over = {}) => ({ events, next: null, ...envelope(), ...over })

function Where() {
  const { search } = useLocation()
  return <output data-testid="where">{search}</output>
}
const renderAt = (url = '/wallet?tab=predict') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <PredictPanel />
      <Where />
    </MemoryRouter>,
  )
const where = () => screen.getByTestId('where').textContent
const chipText = () => document.querySelector('.predict-trust-chip')?.textContent ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
  client.fetchEvents.mockResolvedValue(page([FED, RAIN]))
})

describe('PredictPanel — browse by event', () => {
  it('renders one card per event, a multi-market event with its rows and "+N more"', async () => {
    renderAt()
    expect(await screen.findByText('Fed Decision in December?')).toBeInTheDocument()
    expect(document.querySelectorAll('.event-card')).toHaveLength(2)
    expect(screen.getByText('+2 more')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /refresh/i })).toBeNull()
  })

  it('states the list is DELAYED, never "Live" — even when the gateway just confirmed it', async () => {
    client.fetchEvents.mockResolvedValue(page([FED], { confirmedAt: envelope().serverNow }))
    renderAt()
    await screen.findByText('Fed Decision in December?')
    expect(chipText()).toMatch(/Delayed · \d+ s/)
    expect(chipText()).not.toMatch(/live/i)
  })

  it('ages to "Last known" and says so when the gateway reports stale', async () => {
    client.fetchEvents.mockResolvedValue(
      page([FED], { confirmedAt: '2026-11-26T02:00:00.000Z', serverNow: '2026-11-26T02:10:00.000Z', stale: true }),
    )
    renderAt()
    await screen.findByText('Fed Decision in December?')
    expect(chipText()).toMatch(/Last known · 10 min/)
    expect(screen.getByText(/temporarily unreachable/i)).toBeInTheDocument()
  })

  it('a category chip puts cat in the address, keeps other params, and re-queries', async () => {
    renderAt('/wallet?tab=predict')
    await screen.findByText('Fed Decision in December?')
    const group = screen.getByRole('group', { name: 'Category' })
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(group).getByRole('button', { name: 'Crypto' }))
    await waitFor(() => expect(client.fetchEvents).toHaveBeenLastCalledWith(137, expect.objectContaining({ category: 'crypto' })))
    expect(where()).toContain('tab=predict')
    expect(where()).toContain('cat=crypto')
    expect(within(group).getByRole('button', { name: 'Crypto' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(group).getByRole('button', { name: 'All' }))
    await waitFor(() => expect(where()).not.toContain('cat='))
  })

  it('omits sort at its default and writes it otherwise', async () => {
    renderAt()
    await screen.findByText('Fed Decision in December?')
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'closing' } })
    await waitFor(() => expect(where()).toContain('sort=closing'))
    await waitFor(() => expect(client.fetchEvents).toHaveBeenLastCalledWith(137, expect.objectContaining({ sort: 'closing' })))
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'volume24h' } })
    await waitFor(() => expect(where()).not.toContain('sort='))
  })

  it('restores category and sort from the address on mount', async () => {
    renderAt('/wallet?tab=predict&cat=sports&sort=closing')
    await waitFor(() =>
      expect(client.fetchEvents).toHaveBeenCalledWith(137, expect.objectContaining({ category: 'sports', sort: 'closing' })),
    )
    expect(screen.getByRole('button', { name: 'Sports' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByLabelText('Sort by')).toHaveValue('closing')
  })

  it('restores a search from the address and says it is searching all categories', async () => {
    renderAt('/wallet?tab=predict&cat=sports&q=rain')
    await waitFor(() => expect(client.fetchEvents).toHaveBeenCalledWith(137, expect.objectContaining({ q: 'rain', category: '' })))
    expect(screen.getByLabelText('Search markets')).toHaveValue('rain')
    const note = screen.getByText(/Searching all categories/)
    expect(screen.getByRole('button', { name: 'Crypto' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Crypto' })).toHaveAttribute('aria-describedby', note.id)
    expect(screen.getByLabelText('Sort by')).toBeDisabled()
  })

  it('typing a search writes q (without adding history) and queries after the debounce', async () => {
    renderAt()
    await screen.findByText('Fed Decision in December?')
    client.fetchEvents.mockClear()
    fireEvent.change(screen.getByLabelText('Search markets'), { target: { value: 'fed' } })
    expect(where()).toContain('q=fed')
    expect(client.fetchEvents).not.toHaveBeenCalled()
    await waitFor(() => expect(client.fetchEvents).toHaveBeenCalledWith(137, expect.objectContaining({ q: 'fed' })), { timeout: 2000 })
    expect(client.fetchEvents).toHaveBeenCalledTimes(1)
  })

  it('opens the existing detail sheet with the adapted market from a Yes button', async () => {
    renderAt()
    await screen.findByText('Fed Decision in December?')
    fireEvent.click(screen.getAllByRole('button', { name: /^Yes 94¢, 25 bps increase/ })[0])
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('Fed Decision in December? — 25 bps increase')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('button', { name: 'Buy' }).length).toBeGreaterThan(0)
  })

  it('opens the first tradable row from the title', async () => {
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: 'Will it rain in London tomorrow?' }))
    expect(within(screen.getByRole('dialog')).getByText('Will it rain in London tomorrow?')).toBeInTheDocument()
  })

  it('keeps a never-stranded Polymarket path and a retry when degraded', async () => {
    client.fetchEvents.mockRejectedValue(new Error('down'))
    renderAt()
    expect(await screen.findByRole('link', { name: /Polymarket/i })).toBeInTheDocument()
    client.fetchEvents.mockResolvedValue(page([FED]))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Fed Decision in December?')).toBeInTheDocument()
  })

  it('shows an empty state, and offers to clear a search or category when one is set', async () => {
    client.fetchEvents.mockResolvedValue(page([]))
    renderAt('/wallet?tab=predict&cat=crypto')
    expect(await screen.findByText('No markets found')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and category' }))
    await waitFor(() => expect(where()).not.toContain('cat='))
    expect(where()).toContain('tab=predict')
  })

  it('offers Polymarket (not a clear button) when empty with no filter', async () => {
    client.fetchEvents.mockResolvedValue(page([]))
    renderAt()
    expect(await screen.findByText('No markets found')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Polymarket' })).toBeInTheDocument()
  })

  it('offers Load more when there is a next page', async () => {
    client.fetchEvents.mockResolvedValue(page([FED], { next: '20' }))
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await waitFor(() => expect(client.fetchEvents).toHaveBeenLastCalledWith(137, expect.objectContaining({ next: '20' })))
  })

  it('has an accessible search field and no axe violations', async () => {
    const { container } = renderAt()
    await screen.findByText('Fed Decision in December?')
    expect(screen.getByLabelText(/search markets/i)).toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('on a gateway with no event route: shows the older market list and hides controls that would do nothing', async () => {
    client.fetchEvents.mockRejectedValue(Object.assign(new Error('not found'), { status: 404, code: 'http_404' }))
    client.fetchMarkets.mockResolvedValue({
      markets: [
        {
          conditionId: '0xold',
          question: 'An older market?',
          slug: 'an-older-market',
          outcomes: [{ name: 'Yes', tokenId: '1', price: '0.4' }, { name: 'No', tokenId: '2', price: '0.6' }],
          volume: null,
          endDate: null,
          negRisk: false,
          tradable: true,
        },
      ],
      next: null,
      fetchedAt: envelope().confirmedAt,
      stale: false,
    })
    renderAt('/wallet?tab=predict&cat=economy')
    expect(await screen.findByText('An older market?')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Category' })).toBeNull()
    expect(screen.queryByLabelText(/sort by/i)).toBeNull()
    expect(screen.getByLabelText(/search markets/i)).toBeInTheDocument()
    expect(chipText()).not.toMatch(/live/i)
  })
})
