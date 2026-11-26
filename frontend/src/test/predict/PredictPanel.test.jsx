/**
 * PredictPanel (spec 057 US1, reworked by spec 114 US1) — the event browse list. Verifies one card per
 * event, category/sort/search living in the address (and restoring from it), the list's trust chip never
 * saying "Live", the honest empty/degraded states, and that a Yes/No button still opens the existing
 * detail sheet for the adapted market.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { axe } from 'vitest-axe'
import { setWalletChain } from '../helpers/walletChain'
import PredictPanel from '../../components/predict/PredictPanel'
import * as client from '../../lib/predict/predictClient'
import { setBooksRouteMissing, __resetRouteSupportForTests } from '../../lib/markets/routeSupport'
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
// The event page reads books through the market-data seam; here it is a no-op (EventPage.test.jsx drives it).
const feed = vi.hoisted(() => ({ calls: [] }))
vi.mock('../../lib/markets/feed', () => ({
  subscribe: (keys) => {
    feed.calls.push([...keys])
    return () => {}
  },
}))
// recharts has no layout in jsdom; the page's chart is covered in PriceHistoryChart.test.jsx and Cypress.
vi.mock('recharts', async () => {
  const React = await import('react')
  return { ResponsiveContainer: ({ children }) => React.createElement('div', null, children), LineChart: ({ children }) => React.createElement('div', null, children), XAxis: () => null, YAxis: () => null, Line: () => null }
})
// TradeConfirm (rendered inside the detail sheet) pulls the trade hook — stub it out.
vi.mock('../../hooks/usePredictTrade', () => ({
  usePredictTrade: () => ({ status: 'idle', loadFee: vi.fn(), preview: vi.fn(), submit: vi.fn(), fee: null, onWrongNetwork: false, canTrade: true }),
}))

const page = (events, over = {}) => ({ events, next: null, ...envelope(), ...over })

function Where() {
  const { search } = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="where">{search}</output>
      <button type="button" onClick={() => navigate(-1)}>
        browser back
      </button>
    </>
  )
}
const renderAt = (url = '/wallet?tab=predict') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <PredictPanel />
      <Where />
    </MemoryRouter>,
  )
const where = () => screen.getByTestId('where').textContent
// Let a resolved discover promise land before asserting that something is ABSENT (else it passes vacuously).
const settled = () => act(async () => { await new Promise((r) => setTimeout(r, 25)) })
const chipText = () => document.querySelector('.predict-trust-chip')?.textContent ?? ''

beforeEach(() => {
  vi.clearAllMocks()
  __resetRouteSupportForTests()
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
  client.fetchEvents.mockResolvedValue(page([FED, RAIN]))
  // By default no quick filters: the row is optional and absent unless a test supplies discover.
  client.fetchDiscover.mockRejectedValue(Object.assign(new Error('not found'), { status: 404, code: 'http_404' }))
  client.fetchEvent.mockResolvedValue(detailBody({ markets: mkRows(3) }))
  client.fetchHistory.mockResolvedValue({ points: [], confirmedAt: envelope().confirmedAt, serverNow: envelope().serverNow, stale: false })
  feed.calls.length = 0
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

  it('a Yes/No button opens the amount-first TICKET for the outcome pressed (live readings available)', async () => {
    renderAt()
    await screen.findByText('Fed Decision in December?')
    fireEvent.click(screen.getAllByRole('button', { name: /^Yes 94¢, 25 bps increase/ })[0])
    const dialog = screen.getByRole('dialog', { name: 'Buy Yes — Fed Decision in December? — 25 bps increase' })
    expect(dialog).toHaveClass('order-ticket')
    expect(document.querySelector('.market-detail')).toBeNull() // not the fixed-price sheet
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: /^No 6¢?, 25 bps increase|^No \d+¢, 25 bps increase/ })[0])
    expect(screen.getByRole('dialog', { name: /^Buy No — Fed Decision in December\? — 25 bps increase/ })).toBeInTheDocument()
  })

  it('LEGACY: on a gateway with no event route a Yes button still opens the existing detail sheet (FR-029)', async () => {
    client.fetchEvents.mockRejectedValue(Object.assign(new Error('not found'), { status: 404, code: 'http_404' }))
    client.fetchMarkets.mockResolvedValue({
      markets: [{ conditionId: '0xold', question: 'An older market?', slug: 'an-older-market', outcomes: [{ name: 'Yes', tokenId: '1', price: '0.4' }, { name: 'No', tokenId: '2', price: '0.6' }], volume: null, endDate: null, negRisk: false, tradable: true }],
      next: null,
      fetchedAt: envelope().confirmedAt,
      stale: false,
    })
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: /^Yes 40¢/ }))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('market-detail')
    expect(within(dialog).getByText('An older market?')).toBeInTheDocument()
    expect(within(dialog).getAllByRole('button', { name: 'Buy' }).length).toBeGreaterThan(0)
  })

  it('NO BOOKS ROUTE: when the market-data seam has learned the gateway cannot serve books, Yes opens the existing sheet', async () => {
    renderAt()
    await screen.findByText('Fed Decision in December?')
    act(() => setBooksRouteMissing(true))
    fireEvent.click(screen.getAllByRole('button', { name: /^Yes 94¢, 25 bps increase/ })[0])
    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveClass('market-detail')
    expect(within(dialog).getByText('Fed Decision in December? — 25 bps increase')).toBeInTheDocument()
  })

  it('a market that is not open for orders still opens the sheet, which says why in words', async () => {
    client.fetchEvents.mockResolvedValue(page([{ ...RAIN, markets: [{ ...RAIN.markets[0], tradable: false }] }]))
    renderAt()
    await screen.findByText('Will it rain in London tomorrow?')
    // A closed row's buttons still render; the sheet is what explains.
    const yes = screen.getAllByRole('button', { name: /^Yes / })[0]
    fireEvent.click(yes)
    expect(screen.getByRole('dialog')).toHaveClass('market-detail')
    expect(screen.getByText(/isn't open for trading/)).toBeInTheDocument()
  })

  it('opens the EVENT PAGE from the title (not the sheet), and a legacy gateway keeps the old behaviour', async () => {
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: 'Will it rain in London tomorrow?' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(where()).toContain('event=rain-london')
    expect(await screen.findByRole('heading', { level: 2, name: 'Fed Decision in December?' })).toBeInTheDocument()
    expect(client.fetchEvent).toHaveBeenCalledWith(137, 'rain-london')
  })

  it('on a gateway with no event route, the title still opens the first tradable row in the sheet', async () => {
    client.fetchEvents.mockRejectedValue(Object.assign(new Error('not found'), { status: 404, code: 'http_404' }))
    client.fetchMarkets.mockResolvedValue({
      markets: [{ conditionId: '0xold', question: 'An older market?', slug: 'an-older-market', outcomes: [{ name: 'Yes', tokenId: '1', price: '0.4' }, { name: 'No', tokenId: '2', price: '0.6' }], volume: null, endDate: null, negRisk: false, tradable: true }],
      next: null,
      fetchedAt: envelope().confirmedAt,
      stale: false,
    })
    renderAt()
    fireEvent.click(await screen.findByRole('button', { name: 'An older market?' }))
    expect(within(screen.getByRole('dialog')).getByText('An older market?')).toBeInTheDocument()
    expect(where()).not.toContain('event=')
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

  it('shows the quick-filter row only when discover has something to say', async () => {
    renderAt()
    await screen.findByText('Fed Decision in December?')
    await settled()
    expect(client.fetchDiscover).toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Active now' })).toBeNull()
  })
})

describe('PredictPanel — quick filters (spec 114 FR-002a–c)', () => {
  const TOPICS = [
    { slug: 'basketball', label: 'Basketball', events: 11, volume24h: '10546858.02' },
    { slug: 'NFL-playoffs', label: 'NFL', events: 3, volume24h: '8402870.58' },
  ]
  const discoverBody = (over = {}) => ({ live: { count: 14, events: [] }, topics: TOPICS, ...envelope(), ...over })
  const row = () => screen.findByRole('group', { name: 'Active now' })

  beforeEach(() => {
    client.fetchDiscover.mockResolvedValue(discoverBody())
  })

  it('draws "In play · 14" then one chip per topic, directly under search and above the categories', async () => {
    renderAt()
    const group = await row()
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['In play · 14', 'Basketball', 'NFL'])
    buttons.forEach((b) => expect(b).toHaveAttribute('aria-pressed', 'false'))
    const search = screen.getByLabelText('Search markets')
    const category = screen.getByRole('group', { name: 'Category' })
    expect(search.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(group.compareDocumentPosition(category) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('says "50+" when the gateway says there are more', async () => {
    client.fetchDiscover.mockResolvedValue(discoverBody({ live: { count: 50, more: true, events: [] } }))
    renderAt()
    expect(within(await row()).getByRole('button', { name: 'In play · 50+' })).toBeInTheDocument()
  })

  it('omits the In play chip when nothing is in play, or its half is unreadable, and keeps the topics', async () => {
    client.fetchDiscover.mockResolvedValue(discoverBody({ live: { count: 0, events: [] } }))
    const { unmount } = renderAt()
    const group = await row()
    expect(within(group).queryByRole('button', { name: /In play/ })).toBeNull()
    expect(within(group).getByRole('button', { name: 'Basketball' })).toBeInTheDocument()
    unmount()
    client.fetchDiscover.mockResolvedValue(discoverBody({ live: null }))
    renderAt()
    expect(within(await row()).queryByRole('button', { name: /In play/ })).toBeNull()
  })

  it('omits the whole row when both halves are empty or unreadable', async () => {
    client.fetchDiscover.mockResolvedValue(discoverBody({ live: { count: 0, events: [] }, topics: [] }))
    renderAt()
    await screen.findByText('Fed Decision in December?')
    await settled()
    expect(client.fetchDiscover).toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Active now' })).toBeNull()
  })

  it('a topic chip sends topic, writes topic= and clears cat= in the same update', async () => {
    renderAt('/wallet?tab=predict&cat=crypto')
    const group = await row()
    fireEvent.click(within(group).getByRole('button', { name: 'NFL' }))
    await waitFor(() => expect(client.fetchEvents).toHaveBeenLastCalledWith(137, expect.objectContaining({ topic: 'NFL-playoffs', category: '', live: false })))
    expect(where()).toContain('topic=NFL-playoffs')
    expect(where()).not.toContain('cat=')
    expect(within(group).getByRole('button', { name: 'NFL' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('In play, a topic and a category are mutually exclusive in the address', async () => {
    renderAt('/wallet?tab=predict')
    const group = await row()
    fireEvent.click(within(group).getByRole('button', { name: 'In play · 14' }))
    await waitFor(() => expect(where()).toContain('live=1'))
    await waitFor(() => expect(client.fetchEvents).toHaveBeenLastCalledWith(137, expect.objectContaining({ live: true, topic: '', category: '' })))

    fireEvent.click(within(group).getByRole('button', { name: 'Basketball' }))
    await waitFor(() => expect(where()).toContain('topic=basketball'))
    expect(where()).not.toContain('live=')

    fireEvent.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'Sports' }))
    await waitFor(() => expect(where()).toContain('cat=sports'))
    expect(where()).not.toContain('topic=')
    expect(where()).not.toContain('live=')
  })

  it('pressing an active quick filter again clears it', async () => {
    renderAt('/wallet?tab=predict&topic=basketball')
    const group = await row()
    const chip = within(group).getByRole('button', { name: 'Basketball' })
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(chip)
    await waitFor(() => expect(where()).not.toContain('topic='))
    expect(where()).toContain('tab=predict')
    fireEvent.click(within(group).getByRole('button', { name: 'In play · 14' }))
    await waitFor(() => expect(where()).toContain('live=1'))
    fireEvent.click(within(group).getByRole('button', { name: 'In play · 14' }))
    await waitFor(() => expect(where()).not.toContain('live='))
  })

  it('"All" clears a quick filter as well as a category', async () => {
    renderAt('/wallet?tab=predict&live=1')
    await row()
    fireEvent.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'All' }))
    await waitFor(() => expect(where()).not.toContain('live='))
  })

  it('a topic in the address that discover does not list is still shown, active and clearable', async () => {
    renderAt('/wallet?tab=predict&topic=Some-Shared-Topic')
    const group = await row()
    const chip = within(group).getByRole('button', { name: 'Some-Shared-Topic' })
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(client.fetchEvents).toHaveBeenCalledWith(137, expect.objectContaining({ topic: 'Some-Shared-Topic' })))
    fireEvent.click(chip)
    await waitFor(() => expect(where()).not.toContain('topic='))
  })

  it('keeps an active filter visible and clearable even when discover is absent', async () => {
    client.fetchDiscover.mockRejectedValue(Object.assign(new Error('nf'), { status: 404, code: 'http_404' }))
    renderAt('/wallet?tab=predict&topic=nba')
    const chip = await screen.findByRole('button', { name: 'nba' })
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /In play/ })).toBeNull()
  })

  it('ignores a malformed topic in the address', async () => {
    renderAt('/wallet?tab=predict&topic=a%20b%3Cscript%3E')
    await screen.findByText('Fed Decision in December?')
    expect(client.fetchEvents).toHaveBeenCalledWith(137, expect.objectContaining({ topic: '' }))
  })

  it('lets live win over topic and topic over category when an address carries several', async () => {
    renderAt('/wallet?tab=predict&cat=crypto&topic=nba&live=1')
    await waitFor(() => expect(client.fetchEvents).toHaveBeenCalledWith(137, expect.objectContaining({ live: true, topic: '', category: '' })))
  })

  it('disables the chips while searching, pointing at the existing note', async () => {
    renderAt('/wallet?tab=predict&q=rain')
    const group = await row()
    const note = screen.getByText(/Searching all categories/)
    within(group).getAllByRole('button').forEach((b) => {
      expect(b).toBeDisabled()
      expect(b).toHaveAttribute('aria-describedby', note.id)
    })
    await waitFor(() => expect(client.fetchEvents).toHaveBeenCalledWith(137, expect.objectContaining({ q: 'rain', topic: '', live: false })))
  })

  it('is absent on a gateway with no event route, even if discover answers', async () => {
    client.fetchEvents.mockRejectedValue(Object.assign(new Error('not found'), { status: 404, code: 'http_404' }))
    client.fetchMarkets.mockResolvedValue({ markets: [], next: null, fetchedAt: envelope().confirmedAt, stale: false })
    renderAt('/wallet?tab=predict&topic=nba')
    await waitFor(() => expect(client.fetchMarkets).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Category' })).toBeNull())
    expect(screen.queryByRole('group', { name: 'Active now' })).toBeNull()
  })

  it('draws nothing from a discover answer older than its own bound (FR-002b)', async () => {
    // Ten minutes old on the gateway's clock; the bound is five.
    client.fetchDiscover.mockResolvedValue(
      discoverBody({ confirmedAt: '2026-11-26T02:00:00.000Z', serverNow: '2026-11-26T02:10:00.000Z' }),
    )
    renderAt()
    await screen.findByText('Fed Decision in December?')
    await settled()
    expect(client.fetchDiscover).toHaveBeenCalled()
    expect(screen.queryByRole('group', { name: 'Active now' })).toBeNull()
  })

  it('draws the row from an answer two minutes old: the gateway caches for one and the client asks once a minute', async () => {
    // The ordinary case on a healthy gateway. A 30 s price bound hid the row here.
    client.fetchDiscover.mockResolvedValue(
      discoverBody({ confirmedAt: '2026-11-26T02:08:00.000Z', serverNow: '2026-11-26T02:10:00.000Z' }),
    )
    renderAt()
    await screen.findByText('Fed Decision in December?')
    expect(await screen.findByRole('group', { name: 'Active now' })).toBeInTheDocument()
  })

  it('draws nothing when the age of the answer cannot be known', async () => {
    client.fetchDiscover.mockResolvedValue(discoverBody({ confirmedAt: 'not a time', serverNow: undefined }))
    renderAt()
    await screen.findByText('Fed Decision in December?')
    await settled()
    expect(screen.queryByRole('group', { name: 'Active now' })).toBeNull()
  })

  it('a stale flag alone does not hide the row while the answer is inside the bound', async () => {
    client.fetchDiscover.mockResolvedValue(discoverBody({ stale: true, confirmedAt: envelope().serverNow }))
    renderAt()
    await screen.findByText('Fed Decision in December?')
    expect(await screen.findByRole('group', { name: 'Active now' })).toBeInTheDocument()
  })

  it('the empty state clears topic and live as well as category', async () => {
    client.fetchEvents.mockResolvedValue(page([]))
    renderAt('/wallet?tab=predict&topic=nba')
    expect(await screen.findByText('No markets are listed under this topic right now.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    await waitFor(() => expect(where()).not.toContain('topic='))
    expect(where()).toContain('tab=predict')
  })

  it('says an in-play list ignores sort, and disables the sort control', async () => {
    renderAt('/wallet?tab=predict&live=1')
    await screen.findByText('Fed Decision in December?')
    expect(screen.getByLabelText('Sort by')).toBeDisabled()
    expect(screen.getByText(/Events in play are listed by trading over the last day/)).toBeInTheDocument()
  })

  it('has no axe violations with the row present', async () => {
    const { container } = renderAt('/wallet?tab=predict&topic=basketball')
    await row()
    await screen.findByText('Fed Decision in December?')
    expect(await axe(container)).toHaveNoViolations()
  })
})

describe('PredictPanel — the event page (spec 114 slice 4)', () => {
  const SLUG = 'fed-decision-in-december'
  const heading = () => screen.findByRole('heading', { level: 2, name: 'Fed Decision in December?' })

  it('opens cold from its address, without the list having loaded — and without asking for it', async () => {
    renderAt(`/wallet?tab=predict&event=${SLUG}`)
    await heading()
    expect(client.fetchEvent).toHaveBeenCalledWith(137, SLUG)
    expect(client.fetchEvents).not.toHaveBeenCalled()
    expect(client.fetchDiscover).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Search markets')).toBeNull()
    expect(screen.queryByRole('group', { name: 'Category' })).toBeNull()
    expect(document.querySelector('.event-card')).toBeNull()
  })

  it('opening PUSHES the address, keeps the list\'s params, and the browser Back restores the list', async () => {
    renderAt('/wallet?tab=predict&cat=economy&sort=closing')
    fireEvent.click(await screen.findByRole('button', { name: 'Fed Decision in December?' }))
    await heading()
    expect(where()).toContain(`event=${SLUG}`)
    for (const kept of ['tab=predict', 'cat=economy', 'sort=closing']) expect(where()).toContain(kept)

    fireEvent.click(screen.getByRole('button', { name: 'browser back' }))
    await screen.findByLabelText('Search markets')
    expect(where()).not.toContain('event=')
    expect(where()).toContain('cat=economy')
    expect(await screen.findByText('Fed Decision in December?')).toBeInTheDocument()
    expect(screen.getByLabelText('Sort by')).toHaveValue('closing')
    expect(screen.getByRole('button', { name: 'Economy' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('"Back to markets" removes event and restores the list view, keeping a quick filter and a search', async () => {
    renderAt('/wallet?tab=predict&topic=nba')
    fireEvent.click(await screen.findByRole('button', { name: 'Fed Decision in December?' }))
    await heading()
    fireEvent.click(screen.getByRole('button', { name: /Back to markets/ }))
    await screen.findByLabelText('Search markets')
    expect(where()).not.toContain('event=')
    expect(where()).toContain('topic=nba')
    expect(client.fetchEvents).toHaveBeenLastCalledWith(137, expect.objectContaining({ topic: 'nba' }))
  })

  it('"Back to markets" on a cold open replaces the entry (there is no list entry behind it to pop)', async () => {
    renderAt(`/wallet?tab=predict&event=${SLUG}&cat=economy`)
    await heading()
    fireEvent.click(screen.getByRole('button', { name: /Back to markets/ }))
    await screen.findByLabelText('Search markets')
    expect(where()).not.toContain('event=')
    expect(where()).toContain('cat=economy')
  })

  it('a Yes button on the page opens the ONE ticket for the adapted market, and the page selects that row', async () => {
    renderAt(`/wallet?tab=predict&event=${SLUG}`)
    await heading()
    fireEvent.click(screen.getAllByRole('button', { name: /^Yes 75¢, Row 2/ })[0])
    const dialogs = screen.getAllByRole('dialog')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toHaveClass('order-ticket')
    expect(within(dialogs[0]).getByText('Buy Yes — Fed Decision in December? — Row 2')).toBeInTheDocument()
    expect(where()).toContain(`event=${SLUG}`)
    // The page selected the pressed row, so its tokens are already among the page's ten.
    expect(document.querySelectorAll('.event-page-row.is-selected')).toHaveLength(1)
    expect(document.querySelector('.event-page-row.is-selected')).toHaveTextContent('Row 2')
  })

  it('LEGACY counterpart: with no books route a Yes button on the page opens the ONE existing sheet', async () => {
    setBooksRouteMissing(true)
    renderAt(`/wallet?tab=predict&event=${SLUG}`)
    await heading()
    fireEvent.click(screen.getAllByRole('button', { name: /^Yes 75¢, Row 2/ })[0])
    const dialogs = screen.getAllByRole('dialog')
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toHaveClass('market-detail')
    expect(within(dialogs[0]).getByText('Fed Decision in December? — Row 2')).toBeInTheDocument()
  })

  it('an event page with a not-found event offers the way back to the list', async () => {
    client.fetchEvent.mockRejectedValue(Object.assign(new Error('nf'), { status: 404, code: 'not_found' }))
    renderAt('/wallet?tab=predict&event=gone-event')
    expect(await screen.findByText(/could not find this event/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Back to markets/ }))
    expect(await screen.findByText('Fed Decision in December?')).toBeInTheDocument()
  })

  it('ignores an event slug the gateway would refuse and shows the list', async () => {
    renderAt('/wallet?tab=predict&event=Bad%20Slug%21')
    expect(await screen.findByText('Fed Decision in December?')).toBeInTheDocument()
    expect(client.fetchEvent).not.toHaveBeenCalled()
  })

  it('has no axe violations on the event page', async () => {
    const { container } = renderAt(`/wallet?tab=predict&event=${SLUG}`)
    await heading()
    expect(await axe(container)).toHaveNoViolations()
  })
})
