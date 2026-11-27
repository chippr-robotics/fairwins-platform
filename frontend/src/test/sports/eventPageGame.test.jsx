/**
 * The game view on the Predict event page (spec 115): present only for an event that names a game, above the
 * markets list; absent — with NOTHING in its place — when the gateway module is off (FR-013); and never a
 * request for game data for an event with no game (SC-006). The ticket/trade code is untouched by it (FR-010).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import EventPage from '../../components/predict/EventPage'
import { __resetPriceHistoryCache } from '../../hooks/usePriceHistory'
import * as client from '../../lib/predict/predictClient'
import { fetchGame } from '../../lib/sports/gameFeed'
import { detailBody } from '../fixtures/predictEvents'
import { LISTING, row, detail, SERVER_NOW } from '../fixtures/sportsGames'

vi.mock('../../lib/markets/feed', () => ({ subscribe: () => () => {} }))
vi.mock('recharts', async () => {
  const React = await import('react')
  const h = React.createElement
  return {
    ResponsiveContainer: ({ children }) => h('div', null, children),
    LineChart: ({ children }) => h('div', null, children),
    XAxis: () => null,
    YAxis: () => null,
    Line: () => null,
  }
})
vi.mock('../../lib/predict/predictClient', () => ({
  predictAvailable: vi.fn(() => true),
  fetchEvent: vi.fn(),
  fetchHistory: vi.fn(),
}))
vi.mock('../../lib/sports/gameFeed', async () => ({
  ...(await vi.importActual('../../lib/sports/gameFeed')),
  fetchGame: vi.fn(),
}))

const ok = (r, extra = {}) => ({ kind: 'ok', row: r, serverNow: SERVER_NOW, sources: { venue: { state: 'read' }, plays: { state: 'read' } }, detail: null, ...extra })
const mount = async (over = {}) => {
  client.fetchEvent.mockResolvedValue(detailBody(over))
  render(<EventPage slug="fed-decision-in-december" onBack={() => {}} onOpenRow={() => {}} />)
  await screen.findByRole('heading', { level: 2, name: 'Fed Decision in December?' })
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetPriceHistoryCache()
  setWalletChain(137)
  client.predictAvailable.mockReturnValue(true)
  client.fetchHistory.mockResolvedValue({ points: [{ t: 1000, p: '0.5' }], confirmedAt: 'x', serverNow: 'x', stale: false })
})

describe('EventPage + game view', () => {
  it('an event with a game shows the scoreboard, field and plays ABOVE the outcomes', async () => {
    fetchGame.mockResolvedValue(ok(row(), { detail: detail() }))
    await mount({ game: LISTING })
    const view = await screen.findByTestId('game-view')
    expect(fetchGame).toHaveBeenCalledWith(19618)
    expect(screen.getByTestId('game-field')).toBeInTheDocument()
    expect(screen.getByTestId('game-plays')).toBeInTheDocument()
    const outcomes = document.getElementById('event-page-outcomes')
    expect(view.compareDocumentPosition(outcomes) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('an event with no game (null or absent) draws no game view and asks for no game data', async () => {
    await mount({ game: null })
    expect(screen.queryByTestId('game-view')).toBeNull()
    expect(fetchGame).not.toHaveBeenCalled()
    document.body.innerHTML = ''
    await mount({})
    expect(fetchGame).not.toHaveBeenCalled()
  })

  it('module off (absent): the page is exactly what it was — no placeholder, no sentence', async () => {
    fetchGame.mockResolvedValue({ kind: 'absent' })
    await mount({ game: LISTING })
    expect(fetchGame).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('game-view')).toBeNull()
    expect(document.querySelector('.game-view')).toBeNull()
    expect(screen.queryByText(/game/i, { selector: 'h3, p' })).toBeNull()
    // the rest of the page is intact
    expect(document.getElementById('event-page-outcomes')).not.toBeNull()
  })

  it('before the first answer nothing is drawn either', async () => {
    fetchGame.mockImplementation(() => new Promise(() => {}))
    await mount({ game: LISTING })
    expect(screen.queryByTestId('game-view')).toBeNull()
  })
})
