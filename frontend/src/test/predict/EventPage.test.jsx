/**
 * EventPage (spec 114, US2 + US3) — the event on its own address: outcomes ranked most likely first, a page
 * chip that is the LEAST trusting state among the subscribed readings, never more than ten subscribed tokens,
 * independent markets never framed as a whole, closed/resolved events with no order control, text-only rules
 * with an https-only source link, and honest not-found / degraded states.
 *
 * The market-data seam is replaced by a recording stand-in so a test can push a reading of any age to any key
 * and see how many tokens the page holds at once. recharts is a stand-in too (jsdom has no layout).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { setWalletChain } from '../helpers/walletChain'
import { mkReading } from '../helpers/readings'
import EventPage from '../../components/predict/EventPage'
import { __resetPriceHistoryCache } from '../../hooks/usePriceHistory'
import * as client from '../../lib/predict/predictClient'
import { detailBody, mkRows, mkRow } from '../fixtures/predictEvents'

const feed = vi.hoisted(() => ({ subs: new Set(), calls: [], peak: 0 }))
vi.mock('../../lib/markets/feed', () => ({
  subscribe: (keys, cb) => {
    const sub = { keys: new Set(keys), cb }
    feed.subs.add(sub)
    feed.calls.push([...keys])
    const held = new Set()
    feed.subs.forEach((s) => s.keys.forEach((k) => held.add(k)))
    feed.peak = Math.max(feed.peak, held.size)
    return () => feed.subs.delete(sub)
  },
}))
vi.mock('recharts', async () => {
  const React = await import('react')
  const h = React.createElement
  return {
    ResponsiveContainer: ({ children }) => h('div', null, children),
    LineChart: ({ children }) => h('div', null, children),
    XAxis: () => null,
    YAxis: () => null,
    Line: (p) => h('i', { 'data-testid': 'line', 'data-dash': p.strokeDasharray ?? '' }),
  }
})
vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchEvent: vi.fn(),
  fetchHistory: vi.fn(),
}))

// The page subscribes in an effect after it renders, so wait for the key to be held before pushing to it.
const push = async (key, reading) => {
  await waitFor(() => expect(heldKeys().has(key)).toBe(true))
  act(() => {
    feed.subs.forEach((s) => {
      if (s.keys.has(key)) s.cb(new Map([[key, reading]]))
    })
  })
}
const heldKeys = () => {
  const held = new Set()
  feed.subs.forEach((s) => s.keys.forEach((k) => held.add(k)))
  return held
}
const chip = () => document.querySelector('.predict-trust-chip')?.textContent ?? ''
const apiError = (status, code) => Object.assign(new Error(code), { status, code })

const renderPage = (over = {}, props = {}) => {
  client.fetchEvent.mockResolvedValue(detailBody(over))
  const onBack = vi.fn()
  const onOpenRow = vi.fn()
  const utils = render(<EventPage slug="fed-decision-in-december" onBack={onBack} onOpenRow={onOpenRow} {...props} />)
  return { ...utils, onBack, onOpenRow }
}
const ready = () => screen.findByRole('heading', { level: 2, name: 'Fed Decision in December?' })

beforeEach(() => {
  vi.clearAllMocks()
  feed.subs.clear()
  feed.calls.length = 0
  feed.peak = 0
  __resetPriceHistoryCache()
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
  client.fetchHistory.mockResolvedValue({ points: [{ t: 1000, p: '0.5' }], confirmedAt: 'x', serverNow: 'x', stale: false })
})

describe('EventPage — header and outcomes', () => {
  it('renders category, title, volume, closing date and every outcome, most likely first', async () => {
    renderPage({ markets: mkRows(3) }) // fixture rows rise with their index: Row 2 is the most likely
    await ready()
    expect(screen.getByText('Economy')).toBeInTheDocument()
    expect(screen.getByText('$61.6M traded')).toBeInTheDocument()
    expect(screen.getByText('closes Dec 10, 2030')).toBeInTheDocument()
    const labels = Array.from(document.querySelectorAll('.event-page-row-label')).map((n) => n.textContent)
    expect(labels).toEqual(['Row 2', 'Row 1', 'Row 0'])
    expect(document.querySelectorAll('.event-page-pct')[0].textContent).toBe('75%')
  })

  it('shows each market\'s own traded volume beside its outcome; unstated or absent prints nothing, never $0', async () => {
    const absent = mkRow({ conditionId: '0xabs', label: 'Absent' })
    delete absent.volume
    renderPage({
      markets: [
        mkRow({ conditionId: '0xv1', label: 'Stated', volume: '9348387.921928', volume24h: '120.5' }),
        mkRow({ conditionId: '0xv2', label: 'Zero', volume: '0', volume24h: '0' }),
        mkRow({ conditionId: '0xv3', label: 'Unstated', volume: null, volume24h: null }),
        absent,
      ],
    })
    await ready()
    const rows = Array.from(document.querySelectorAll('.event-page-row'))
    const vol = (label) => rows.find((r) => r.textContent.includes(label)).querySelector('.event-page-row-volume')?.textContent ?? null
    expect(vol('Stated')).toBe('$9.3M traded')
    expect(vol('Zero')).toBe('$0 traded') // a stated zero is a stated zero
    expect(vol('Unstated')).toBeNull()
    expect(vol('Absent')).toBeNull()
  })

  it('shows the venue\'s in-play words for an event in play, as plain text', async () => {
    renderPage({ live: { score: '91-101', period: 'Q4', elapsed: '06:47' } })
    await ready()
    expect(document.querySelector('.event-page-live')).toHaveTextContent('In play · 91-101 · Q4')
    expect(document.body.textContent).not.toMatch(/06:47/)
  })

  it('shows an unknown headline price as "—", never 0%', async () => {
    renderPage({ markets: [mkRow({ conditionId: '0xa', label: 'A', displayPrice: null, outcomes: [{ name: 'Yes', tokenId: 'y0', price: null }, { name: 'No', tokenId: 'n0', price: null }] }), ...mkRows(1)] })
    await ready()
    const pcts = Array.from(document.querySelectorAll('.event-page-pct')).map((n) => n.textContent)
    expect(pcts).toContain('—')
    expect(document.body.textContent).not.toMatch(/\b0%/)
  })

  it('opens the existing sheet path from Yes and No, handing over the event and that row', async () => {
    const { onOpenRow } = renderPage({ markets: mkRows(3) })
    await ready()
    fireEvent.click(screen.getAllByRole('button', { name: /^Yes 75¢, Row 2/ })[0])
    expect(onOpenRow).toHaveBeenCalledTimes(1)
    expect(onOpenRow.mock.calls[0][0].slug).toBe('fed-decision-in-december')
    expect(onOpenRow.mock.calls[0][1].conditionId).toBe('0xr2')
    fireEvent.click(screen.getAllByRole('button', { name: /^No 25¢, Row 2/ })[0])
    expect(onOpenRow).toHaveBeenCalledTimes(2)
    expect(onOpenRow.mock.calls[1][1].conditionId).toBe('0xr2')
  })

  it('disables a side with no price and offers no order for a row that is not tradable', async () => {
    renderPage({
      markets: [
        mkRow({ conditionId: '0xa', label: 'A', outcomes: [{ name: 'Yes', tokenId: 'y0', price: '0.9' }, { name: 'No', tokenId: 'n0', price: null }] }),
        mkRow({ conditionId: '0xb', label: 'B', tradable: false, displayPrice: '0.2' }),
      ],
    })
    await ready()
    expect(screen.getByRole('button', { name: /^No — \(price unavailable\), A/ })).toBeDisabled()
    expect(screen.getByText('Not open for orders')).toBeInTheDocument()
  })

  it('a row is selectable (aria-pressed), the first by default', async () => {
    renderPage({ markets: mkRows(3) })
    await ready()
    const select = screen.getAllByRole('button', { pressed: true })
    expect(select.some((b) => /Row 2/.test(b.textContent))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: /^Row 0/ }))
    expect(screen.getByRole('button', { name: /^Row 0/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^Row 2/ })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('heading', { name: 'Depth — Row 0' })).toBeInTheDocument()
  })

  it('Back to markets calls onBack', async () => {
    const { onBack } = renderPage()
    await ready()
    fireEvent.click(screen.getByRole('button', { name: /Back to markets/ }))
    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('EventPage — the ten-token cap', () => {
  it('subscribes to nine tokens by default: the first eight Yes tokens plus the selected row\'s No', async () => {
    renderPage({ markets: mkRows(14) })
    await ready()
    await waitFor(() => expect(heldKeys().size).toBe(9))
    // Rank is by price, so the eight most likely rows are Row 13 … Row 6.
    expect([...heldKeys()].sort()).toEqual(
      [...[13, 12, 11, 10, 9, 8, 7, 6].map((i) => `polymarket:y${i}`), 'polymarket:n13'].sort(),
    )
  })

  it('never holds more than ten tokens at once, however many rows there are or which one is selected', async () => {
    renderPage({ markets: mkRows(40) })
    await ready()
    for (const i of [0, 5, 20, 39, 8, 9, 33]) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Row ${i}\\b`) }))
      await waitFor(() => expect(heldKeys().has(`polymarket:n${i}`)).toBe(true))
      expect(heldKeys().size).toBeLessThanOrEqual(10)
    }
    expect(feed.peak).toBeLessThanOrEqual(10)
    expect(feed.calls.length).toBeGreaterThan(1)
    feed.calls.forEach((keys) => expect(keys.length).toBeLessThanOrEqual(10))
    // A selected row beyond the eighth takes the last two slots: exactly ten.
    fireEvent.click(screen.getByRole('button', { name: /^Row 3\b/ }))
    await waitFor(() => expect(heldKeys().size).toBe(10))
    expect(heldKeys().has('polymarket:y3') && heldKeys().has('polymarket:n3')).toBe(true)
  })

  it('unsubscribes everything when it unmounts', async () => {
    const { unmount } = renderPage({ markets: mkRows(5) })
    await ready()
    await waitFor(() => expect(heldKeys().size).toBeGreaterThan(0))
    unmount()
    expect(heldKeys().size).toBe(0)
  })

  it('subscribes to nothing for a closed or resolved event', async () => {
    renderPage({ status: 'closed', markets: mkRows(3) })
    await ready()
    expect(feed.calls).toEqual([])
  })
})

describe('EventPage — trust', () => {
  it('rows beyond the eighth show the listing price marked delayed, and no live word', async () => {
    renderPage({ markets: mkRows(10) })
    await ready()
    const row0 = screen.getByRole('button', { name: /^Row 0\b/ })
    expect(row0).toHaveTextContent(/Delayed · \d+ s/)
    expect(row0).toHaveTextContent('9%')
    expect(heldKeys().has('polymarket:y0')).toBe(false)
  })

  it('draws the probability from the reading when it has a price, else falls back to the listing as delayed', async () => {
    renderPage({ markets: mkRows(3) })
    await ready()
    const top = screen.getByRole('button', { name: /^Row 2\b/ })
    expect(top).toHaveTextContent('75%')
    expect(top).toHaveTextContent(/Delayed/) // nothing from the feed yet: the listing, classified, never live
    await push('polymarket:y2', mkReading('live', '0.81'))
    expect(top).toHaveTextContent('81%')
    expect(top).not.toHaveTextContent(/Delayed|Last known/)
    await push('polymarket:y2', mkReading('delayed', '0.8', { ageMs: 12_000 }))
    expect(top).toHaveTextContent('80%')
    expect(top).toHaveTextContent(/Delayed · 12 s/)
  })

  it('the page chip is the LEAST trusting state among the subscribed readings', async () => {
    renderPage({ markets: mkRows(10) })
    await ready()
    await waitFor(() => expect(heldKeys().size).toBe(9))
    const subscribed = [...heldKeys()]
    // Nine live readings: the chip says Live.
    for (const k of subscribed) await push(k, mkReading('live', '0.5'))
    await waitFor(() => expect(chip()).toMatch(/Live/))
    // One delayed outcome among nine live ones is not hidden.
    await push('polymarket:y5', mkReading('delayed', '0.5', { ageMs: 15_000 }))
    await waitFor(() => expect(chip()).toMatch(/Delayed · 1\d s/))
    expect(chip()).not.toMatch(/^Live|Live$/)
    // One last-known outweighs the delayed one.
    await push('polymarket:y6', mkReading('last-known', '0.5', { ageMs: 90_000 }))
    await waitFor(() => expect(chip()).toMatch(/Last known/))
    // Recovery: it returns to Live only when every one is live again.
    await push('polymarket:y6', mkReading('live', '0.5'))
    await push('polymarket:y5', mkReading('live', '0.5'))
    await waitFor(() => expect(chip()).toMatch(/Live/))
  })

  it('the selected row\'s No book counts toward the chip', async () => {
    renderPage({ markets: mkRows(2) })
    await ready()
    await waitFor(() => expect(heldKeys().size).toBe(3))
    for (const k of heldKeys()) await push(k, mkReading('live', '0.5'))
    await waitFor(() => expect(chip()).toMatch(/Live/))
    await push('polymarket:n1', mkReading('last-known', '0.5', { ageMs: 90_000 }))
    await waitFor(() => expect(chip()).toMatch(/Last known/))
  })

  it('never says Live before any reading has arrived', async () => {
    renderPage({ markets: mkRows(3) })
    await ready()
    expect(chip()).toMatch(/Delayed/)
    expect(chip()).not.toMatch(/Live/)
  })

  it('shows depth for the selected outcome from its reading, dimmed with words when not live, and a No toggle', async () => {
    renderPage({ markets: mkRows(3) })
    await ready()
    expect(screen.getByText('Depth is unavailable right now.')).toBeInTheDocument()
    await push('polymarket:y2', mkReading('live', '0.75', { asks: [['0.76', '500']], bids: [['0.74', '300'], ['0.73', '10']] }))
    const table = await screen.findByRole('table')
    expect(within(table).getByText('76¢')).toBeInTheDocument()
    expect(within(table).getByText('74¢')).toBeInTheDocument()
    await push('polymarket:y2', mkReading('delayed', '0.75', { ageMs: 12_000, asks: [['0.76', '500']], bids: [['0.74', '300']] }))
    expect(screen.getByText(/as of 12 s ago, not live/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'No' }))
    expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Depth is unavailable right now.')).toBeInTheDocument()
    await push('polymarket:n2', mkReading('live', '0.25', { asks: [['0.26', '40']], bids: [] }))
    expect(await screen.findByText('No bids')).toBeInTheDocument()
    expect(screen.getByText('26¢')).toBeInTheDocument()
  })
})

describe('EventPage — independent and exclusive markets', () => {
  it('does not present independent markets as shares of one whole, and does not rescale them', async () => {
    const markets = [mkRow({ conditionId: '0xa', label: 'A', displayPrice: '0.7' }), mkRow({ conditionId: '0xb', label: 'B', displayPrice: '0.6' })]
    renderPage({ mutuallyExclusive: false, markets })
    await ready()
    expect(screen.getByText(/independent of one another/)).toBeInTheDocument()
    expect(Array.from(document.querySelectorAll('.event-page-pct')).map((n) => n.textContent)).toEqual(['70%', '60%'])
    expect(document.body.textContent).not.toMatch(/total|100%|130%/i)
    expect(document.querySelector('progress, meter, [class*="bar"]')).toBeNull()
  })

  it('exclusive markets are not rescaled or totalled either, and carry no independence note', async () => {
    const markets = [mkRow({ conditionId: '0xa', label: 'A', displayPrice: '0.7' }), mkRow({ conditionId: '0xb', label: 'B', displayPrice: '0.5' })]
    renderPage({ mutuallyExclusive: true, markets })
    await ready()
    expect(screen.queryByText(/independent of one another/)).toBeNull()
    expect(Array.from(document.querySelectorAll('.event-page-pct')).map((n) => n.textContent)).toEqual(['70%', '50%'])
    expect(document.body.textContent).not.toMatch(/total|100%|120%/i)
  })
})

describe('EventPage — closed and resolved', () => {
  it('a resolved event says so, names the winner per row, and offers no order control or chip', async () => {
    const markets = [
      mkRow({ conditionId: '0xa', label: '25 bps cut', winner: 'Yes', displayPrice: '1' }),
      mkRow({ conditionId: '0xb', label: 'No change', winner: 'No', displayPrice: '0' }),
      mkRow({ conditionId: '0xc', label: 'Unstated', winner: null, displayPrice: '0.5' }),
    ]
    renderPage({ status: 'resolved', markets })
    await ready()
    expect(screen.getByText(/This market has resolved/)).toBeInTheDocument()
    expect(screen.getByText('Resolved: Yes')).toBeInTheDocument()
    expect(screen.getByText('Resolved: No')).toBeInTheDocument()
    expect(screen.getByText('Result not stated by the venue')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Yes|No) \d+¢/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^(Buy|Sell|Trade)/i })).toBeNull()
    expect(document.querySelector('.event-page-row-actions')).toBeNull()
    expect(document.querySelector('.predict-trust-chip')).toBeNull()
    expect(screen.queryByText(/Depth/)).toBeNull()
  })

  it('a closed event says so and offers no order control', async () => {
    renderPage({ status: 'closed' })
    await ready()
    expect(screen.getByText(/This market has closed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Yes|No) \d+¢/ })).toBeNull()
    expect(document.querySelector('.predict-trust-chip')).toBeNull()
  })

  it('an event whose status the venue did not give offers no order control and says why', async () => {
    renderPage({ status: undefined })
    await ready()
    expect(screen.getByText(/did not say whether this market is open/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^(Yes|No) \d+¢/ })).toBeNull()
  })
})

describe('EventPage — how this resolves (text only)', () => {
  it('links an https resolution source with rel=noopener noreferrer in a new tab', async () => {
    renderPage({ resolutionSource: 'https://www.federalreserve.gov/monetarypolicy.htm' })
    await ready()
    const link = screen.getByRole('link', { name: 'https://www.federalreserve.gov/monetarypolicy.htm' })
    expect(link).toHaveAttribute('href', 'https://www.federalreserve.gov/monetarypolicy.htm')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it.each([
    ['http://example.com/page'],
    ['javascript:alert(1)'],
    ['Associated Press'],
    ['www.example.com'],
  ])('renders %p as plain text, not a link', async (source) => {
    renderPage({ resolutionSource: source })
    await ready()
    expect(screen.getByText(source)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: source })).toBeNull()
    expect(document.querySelector('a[href^="javascript"]')).toBeNull()
  })

  it('says so when the venue named no source or gave no rules', async () => {
    renderPage({ resolutionSource: null, description: '' })
    await ready()
    expect(screen.getByText('not named by the venue')).toBeInTheDocument()
    expect(screen.getByText('The venue did not give resolution rules for this event.')).toBeInTheDocument()
  })

  it('renders a description containing markup as TEXT — no element, no image', async () => {
    const evil = 'Rules <img src=x onerror=alert(1)> and <script>alert(2)</script> <b>bold</b>'
    renderPage({ description: evil, title: 'T <i>x</i>' })
    await screen.findByRole('heading', { level: 2 })
    expect(screen.getByText(evil)).toBeInTheDocument()
    expect(document.querySelector('.event-page-description *')).toBeNull()
    expect(document.querySelector('.event-page img, .event-page script, .event-page b')).toBeNull()
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('T <i>x</i>')
  })
})

describe('EventPage — chart', () => {
  it('charts at most four series and says how many are not', async () => {
    renderPage({ markets: mkRows(7) })
    await ready()
    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(4))
    expect(screen.getByText('+3 more outcomes not charted')).toBeInTheDocument()
    // The four most likely rows' Yes tokens: y6 y5 y4 y3.
    expect(client.fetchHistory.mock.calls.map((c) => c[1]).sort()).toEqual(['y3', 'y4', 'y5', 'y6'])
  })

  it('charts the outcomes of a single market that has several', async () => {
    const row = mkRow({
      conditionId: '0xm',
      label: 'Who wins?',
      outcomes: ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) => ({ name: n, tokenId: `o${i}`, price: '0.16' })),
    })
    renderPage({ markets: [row] })
    await ready()
    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(4))
    expect(screen.getByText('+2 more outcomes not charted')).toBeInTheDocument()
  })
})

describe('EventPage — states', () => {
  it('says it is loading, with a way back', () => {
    client.fetchEvent.mockReturnValue(new Promise(() => {}))
    render(<EventPage slug="x" onBack={vi.fn()} onOpenRow={vi.fn()} />)
    expect(screen.getByText('Loading event…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Back to markets/ })).toBeInTheDocument()
  })

  it('not-found: says so, with Back and no retry', async () => {
    client.fetchEvent.mockRejectedValue(apiError(404, 'not_found'))
    const onBack = vi.fn()
    render(<EventPage slug="gone" onBack={onBack} onOpenRow={vi.fn()} />)
    expect(await screen.findByText(/could not find this event/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Back to markets/ }))
    expect(onBack).toHaveBeenCalled()
  })

  it('a gateway without the route and an outage are both the honest "could not load" state, with retry and a way out', async () => {
    client.fetchEvent.mockRejectedValueOnce(apiError(404, 'http_404')).mockResolvedValueOnce(detailBody())
    render(<EventPage slug="x" onBack={vi.fn()} onOpenRow={vi.fn()} />)
    expect(await screen.findByText(/Could not load this event right now/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View on Polymarket/ })).toHaveAttribute('href', 'https://polymarket.com/event/x')
    expect(screen.getByRole('button', { name: /Back to markets/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await ready()
  })

  it('says when the data source is unreachable and the answer is old', async () => {
    client.fetchEvent.mockResolvedValue(detailBody({}, { stale: true }))
    render(<EventPage slug="x" onBack={vi.fn()} onOpenRow={vi.fn()} />)
    await ready()
    expect(screen.getByText(/temporarily unreachable/)).toBeInTheDocument()
  })
})

describe('EventPage — accessibility', () => {
  it('has no axe violations (open, with a chart and a depth table)', async () => {
    const { container } = renderPage({ markets: mkRows(5), mutuallyExclusive: false })
    await ready()
    await push('polymarket:y4', mkReading('live', '0.83', { asks: [['0.84', '500']], bids: [['0.82', '300']] }))
    await waitFor(() => expect(screen.getAllByTestId('line').length).toBeGreaterThan(0))
    expect(await axe(container)).toHaveNoViolations()
  })

  it('has no axe violations when resolved', async () => {
    const { container } = renderPage({ status: 'resolved', markets: [mkRow({ winner: 'Yes' })] })
    await ready()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('moves focus to the page when it opens', async () => {
    renderPage()
    await ready()
    expect(document.activeElement).toBe(document.querySelector('.event-page'))
  })
})

describe('EventPage — the amount-first ticket entry (spec 114 slice 5)', () => {
  it('with onOpenTicket, Yes/No hands the pressed OUTCOME and selects that row (its two tokens are then among the ten)', async () => {
    const onOpenTicket = vi.fn()
    const { onOpenRow } = renderPage({ markets: mkRows(12) }, { onOpenTicket })
    await ready()
    const last = [...document.querySelectorAll('.event-page-row')].at(-1)
    fireEvent.click(within(last).getAllByRole('button', { name: /^No / })[0])
    expect(onOpenRow).not.toHaveBeenCalled()
    expect(onOpenTicket).toHaveBeenCalledTimes(1)
    const [event, row, outcome] = onOpenTicket.mock.calls[0]
    expect(event.slug).toBe('fed-decision-in-december')
    expect(outcome.name).toBe('No')
    expect(row.outcomes[1]).toBe(outcome)
    await waitFor(() => expect(last).toHaveClass('is-selected'))
    // The page's own subscription now holds this row's two tokens, within the ten-key budget.
    await waitFor(() => expect(heldKeys().has(`polymarket:${row.outcomes[0].tokenId}`)).toBe(true))
    expect(heldKeys().has(`polymarket:${outcome.tokenId}`)).toBe(true)
    expect(heldKeys().size).toBeLessThanOrEqual(10)
    expect(feed.peak).toBeLessThanOrEqual(10)
  })

  it('paused: the page reads NOTHING (a ticket elsewhere is the only subscriber), and resumes when unpaused', async () => {
    client.fetchEvent.mockResolvedValue(detailBody({ markets: mkRows(3) }))
    const { rerender } = render(<EventPage slug="fed-decision-in-december" onBack={vi.fn()} onOpenRow={vi.fn()} />)
    await ready()
    await waitFor(() => expect(heldKeys().size).toBeGreaterThan(0))
    rerender(<EventPage slug="fed-decision-in-december" onBack={vi.fn()} onOpenRow={vi.fn()} paused />)
    await waitFor(() => expect(heldKeys().size).toBe(0))
    rerender(<EventPage slug="fed-decision-in-december" onBack={vi.fn()} onOpenRow={vi.fn()} />)
    await waitFor(() => expect(heldKeys().size).toBeGreaterThan(0))
  })
})
