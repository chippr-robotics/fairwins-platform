/**
 * PriceHistoryChart (spec 114, FR-006) — five ranges (default 1D), at most four series told apart by dash
 * pattern as well as colour, gaps kept as gaps, a live tail only from a live reading, honest loading/empty/
 * unreadable states, and a text alternative. jsdom has no layout, so recharts is replaced by a stand-in that
 * records what it was asked to draw (the chart's own pixels are covered in Cypress).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { setWalletChain } from '../helpers/walletChain'
import PriceHistoryChart from '../../components/predict/PriceHistoryChart'
import { __resetPriceHistoryCache } from '../../hooks/usePriceHistory'
import * as client from '../../lib/predict/predictClient'
import { mkReading } from '../helpers/readings'

vi.mock('recharts', async () => {
  const React = await import('react')
  const h = React.createElement
  return {
    ResponsiveContainer: ({ children }) => h('div', { 'data-testid': 'responsive' }, children),
    LineChart: ({ children }) => h('div', { 'data-testid': 'linechart' }, children),
    XAxis: () => null,
    YAxis: (p) => h('i', { 'data-testid': 'yaxis', 'data-domain': JSON.stringify(p.domain) }),
    Line: (p) =>
      h('i', {
        'data-testid': 'line',
        className: p.className,
        'data-dash': p.strokeDasharray ?? '',
        'data-stroke': p.stroke,
        'data-connect-nulls': String(p.connectNulls),
        'data-animated': String(p.isAnimationActive),
        'data-width': String(p.strokeWidth),
        'data-points': JSON.stringify(p.data),
      }),
  }
})
vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchHistory: vi.fn(),
}))

const body = (points) => ({ points, confirmedAt: 'x', serverNow: 'x', stale: false })
const mkSeries = (n, over = {}) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    label: `Outcome ${i}`,
    tokenId: `tok${i}`,
    reading: mkReading('live', String(0.9 - i * 0.1)),
    liveTail: null,
    ...over,
  }))
const lines = () => screen.findAllByTestId('line')
const pointsOf = (el) => JSON.parse(el.getAttribute('data-points'))

beforeEach(() => {
  vi.clearAllMocks()
  __resetPriceHistoryCache()
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
  client.fetchHistory.mockResolvedValue(body([{ t: 1000, p: '0.5' }, { t: 1300, p: '0.6' }]))
})

describe('PriceHistoryChart', () => {
  it('offers 1H/1D/1W/1M/MAX as aria-pressed buttons, defaulting to 1D, and re-queries on a change', async () => {
    render(<PriceHistoryChart series={mkSeries(1)} />)
    const group = screen.getByRole('group', { name: 'Chart range' })
    const labels = within(group).getAllByRole('button').map((b) => b.textContent)
    expect(labels).toEqual(['1H', '1D', '1W', '1M', 'MAX'])
    expect(within(group).getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: '1W' })).toHaveAttribute('aria-pressed', 'false')
    await lines()
    expect(client.fetchHistory).toHaveBeenCalledWith(137, 'tok0', '1d')
    fireEvent.click(within(group).getByRole('button', { name: '1W' }))
    expect(within(group).getByRole('button', { name: '1W' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(group).getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(client.fetchHistory).toHaveBeenCalledWith(137, 'tok0', '1w'))
    fireEvent.click(within(group).getByRole('button', { name: 'MAX' }))
    await waitFor(() => expect(client.fetchHistory).toHaveBeenCalledWith(137, 'tok0', 'max'))
  })

  it('draws a line per series (at most four), each with its own dash pattern and a stroke from CSS, not a literal', async () => {
    render(<PriceHistoryChart series={mkSeries(4)} />)
    const drawn = await screen.findAllByTestId('line')
    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(4))
    const all = screen.getAllByTestId('line')
    expect(new Set(all.map((l) => l.getAttribute('data-dash'))).size).toBe(4)
    expect(all.map((l) => l.className)).toEqual([
      'event-chart-line event-chart-sa',
      'event-chart-line event-chart-sb',
      'event-chart-line event-chart-sc',
      'event-chart-line event-chart-sd',
    ])
    all.forEach((l) => {
      expect(l.getAttribute('data-stroke')).toBe('currentColor')
      expect(l.getAttribute('data-animated')).toBe('false')
      expect(l.getAttribute('data-connect-nulls')).toBe('false')
    })
    expect(drawn.length).toBeGreaterThan(0)
    expect(screen.getByTestId('yaxis')).toHaveAttribute('data-domain', '[0,1]')
  })

  it('never charts more than four series and says how many outcomes are not charted', async () => {
    render(<PriceHistoryChart series={mkSeries(6)} moreCount={3} />)
    await lines()
    expect(screen.getAllByTestId('line')).toHaveLength(4)
    expect(client.fetchHistory).toHaveBeenCalledTimes(4)
    expect(screen.getByText('+3 more outcomes not charted')).toBeInTheDocument()
  })

  it('says nothing about extra outcomes when all are charted', async () => {
    render(<PriceHistoryChart series={mkSeries(2)} moreCount={0} />)
    await lines()
    expect(screen.queryByText(/not charted/)).toBeNull()
  })

  it('has a text alternative: role="img" with each charted outcome\'s current value, and a real-text legend', async () => {
    render(<PriceHistoryChart series={mkSeries(2)} />)
    const img = await screen.findByRole('img')
    expect(img).toHaveAttribute('aria-label', expect.stringContaining('Probability history, last 1D.'))
    expect(img.getAttribute('aria-label')).toContain('Outcome 0 90%')
    expect(img.getAttribute('aria-label')).toContain('Outcome 1 80%')
    const legend = screen.getByRole('list', { name: 'Charted outcomes' })
    const items = within(legend).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent('Outcome 0')
    expect(items[0]).toHaveTextContent('90%')
    expect(items[1]).toHaveTextContent('80%')
  })

  it('marks a non-live current value in words, in the legend and in the text alternative', async () => {
    const series = mkSeries(1, { reading: mkReading('delayed', '0.5', { ageMs: 12_000 }) })
    render(<PriceHistoryChart series={series} />)
    const img = await screen.findByRole('img')
    expect(img.getAttribute('aria-label')).toMatch(/Outcome 0 50% \(delayed · 12 s\)/)
    expect(screen.getByRole('list', { name: 'Charted outcomes' })).toHaveTextContent('Delayed · 12 s')
  })

  it('shows an unknown current value as "—", never 0%', async () => {
    const series = mkSeries(1, { reading: mkReading('unknown') })
    render(<PriceHistoryChart series={series} />)
    const img = await screen.findByRole('img')
    expect(img.getAttribute('aria-label')).toContain('Outcome 0 —')
    expect(document.body.textContent).not.toMatch(/\b0%/)
  })

  it('keeps a gap as a gap: a null point where history is missing, and never connects nulls', async () => {
    client.fetchHistory.mockResolvedValue(body([{ t: 1000, p: '0.5' }, { t: 1300, p: '0.5' }, { t: 9000, p: '0.7' }]))
    render(<PriceHistoryChart series={mkSeries(1)} />)
    const [line] = await lines()
    expect(pointsOf(line).map((p) => p.p)).toEqual([0.5, 0.5, null, 0.7])
    expect(line).toHaveAttribute('data-connect-nulls', 'false')
  })

  it('appends the live tail ONLY when the reading is live', async () => {
    const tail = { t: 1400, p: '0.62' }
    const { unmount } = render(<PriceHistoryChart series={mkSeries(1, { liveTail: tail })} />)
    const [withTail] = await lines()
    expect(pointsOf(withTail).at(-1)).toEqual({ t: 1_400_000, p: 0.62 })
    unmount()
    render(<PriceHistoryChart series={mkSeries(1, { liveTail: null, reading: mkReading('delayed') })} />)
    const [without] = await lines()
    expect(pointsOf(without).map((p) => p.p)).toEqual([0.5, 0.6])
  })

  it('says "No price history yet" for an honestly empty history, and draws no chart', async () => {
    client.fetchHistory.mockResolvedValue(body([]))
    render(<PriceHistoryChart series={mkSeries(2, { liveTail: { t: 1400, p: '0.62' } })} />)
    expect(await screen.findByText('No price history yet')).toBeInTheDocument()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryAllByTestId('line')).toHaveLength(0)
  })

  it('says it is loading while the history is on its way', async () => {
    client.fetchHistory.mockReturnValue(new Promise(() => {}))
    render(<PriceHistoryChart series={mkSeries(1)} />)
    expect(screen.getByText('Loading price history…')).toBeInTheDocument()
    expect(screen.queryByText('No price history yet')).toBeNull()
  })

  it('says it could not load, offers a retry, and recovers — it is not an empty chart', async () => {
    client.fetchHistory.mockRejectedValueOnce(new Error('down')).mockResolvedValue(body([{ t: 1000, p: '0.5' }]))
    render(<PriceHistoryChart series={mkSeries(1)} />)
    expect(await screen.findByText('Price history could not be loaded right now.')).toBeInTheDocument()
    expect(screen.queryByText('No price history yet')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await lines()
    expect(screen.queryByText(/could not be loaded/)).toBeNull()
  })

  it('names the series whose history failed while drawing the others', async () => {
    client.fetchHistory.mockImplementation(async (_c, id) => {
      if (id === 'tok1') throw new Error('down')
      return body([{ t: 1000, p: '0.5' }])
    })
    render(<PriceHistoryChart series={mkSeries(2)} />)
    await lines()
    expect(await screen.findByText(/History could not be loaded for Outcome 1/)).toBeInTheDocument()
    expect(screen.getAllByTestId('line')).toHaveLength(1)
  })

  it('thickens the selected outcome\'s line', async () => {
    render(<PriceHistoryChart series={mkSeries(2)} highlightId="s1" />)
    await waitFor(() => expect(screen.getAllByTestId('line')).toHaveLength(2))
    const [a, b] = screen.getAllByTestId('line')
    expect(Number(b.getAttribute('data-width'))).toBeGreaterThan(Number(a.getAttribute('data-width')))
  })

  it('has no axe violations', async () => {
    const { container } = render(<PriceHistoryChart series={mkSeries(3)} moreCount={2} />)
    await lines()
    expect(await axe(container)).toHaveNoViolations()
  })
})
