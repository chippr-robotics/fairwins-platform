/** Mounting (spec 115 slice 3): a fight league gets the FightView INSTEAD of the scoreboard; the fight route
 *  absent renders NOTHING (never a scoreboard built from fighter names); each view's absence leaves the other asking. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { setWalletChain } from '../helpers/walletChain'
import EventPage from '../../components/predict/EventPage'
import { __resetPriceHistoryCache } from '../../hooks/usePriceHistory'
import * as client from '../../lib/predict/predictClient'
import { fetchGame } from '../../lib/sports/gameFeed'
import { fetchFight } from '../../lib/sports/fightFeed'
import { detailBody } from '../fixtures/predictEvents'
import { LISTING, row, SERVER_NOW } from '../fixtures/sportsGames'
import { fight, FIGHT_LISTING, SOURCES, DECISION } from '../fixtures/sportsFights'

vi.mock('../../lib/markets/feed', () => ({ subscribe: () => () => {} }))
vi.mock('recharts', async () => {
  const React = await import('react')
  const h = React.createElement
  return { ResponsiveContainer: ({ children }) => h('div', null, children), LineChart: ({ children }) => h('div', null, children), XAxis: () => null, YAxis: () => null, Line: () => null }
})
vi.mock('../../lib/predict/predictClient', () => ({ predictAvailable: vi.fn(() => true), fetchEvent: vi.fn(), fetchHistory: vi.fn() }))
vi.mock('../../lib/sports/gameFeed', async () => ({ ...(await vi.importActual('../../lib/sports/gameFeed')), fetchGame: vi.fn() }))
vi.mock('../../lib/sports/fightFeed', async () => ({ ...(await vi.importActual('../../lib/sports/fightFeed')), fetchFight: vi.fn() }))

const okFight = (f) => ({ kind: 'ok', fight: f, serverNow: SERVER_NOW, sources: SOURCES })
const mount = async (game) => {
  client.fetchEvent.mockResolvedValue(detailBody({ game }))
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

describe('a fight league on the event page', () => {
  it('shows the fight view ABOVE the outcomes, asks the FIGHT route and never the game route', async () => {
    fetchFight.mockResolvedValue(okFight(fight({ status: 'ended', source: 'figures', result: DECISION, round: 5, clock: '5:00' })))
    await mount(FIGHT_LISTING)
    const view = await screen.findByTestId('fight-view')
    expect(screen.queryByTestId('game-view')).toBeNull()
    expect(screen.queryByText('Scoreboard')).toBeNull()
    expect(fetchGame).not.toHaveBeenCalled()
    expect(fetchFight).toHaveBeenCalled()
    expect(fetchFight.mock.calls[0][0]).toBe(13140)
    expect(view.compareDocumentPosition(document.getElementById('event-page-outcomes')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('fight-result')).toHaveTextContent('Ciryl Gane won')
  })

  it('with the fight route absent it renders NOTHING — no scoreboard from fighter names, no placeholder', async () => {
    fetchFight.mockResolvedValue({ kind: 'absent' })
    await mount(FIGHT_LISTING)
    expect(screen.queryByTestId('fight-view')).toBeNull()
    expect(screen.queryByTestId('game-view')).toBeNull()
    expect(document.querySelector('.game-view')).toBeNull()
    expect(screen.queryByText('Ciryl Gane')).toBeNull()
    expect(fetchGame).not.toHaveBeenCalled()
    expect(fetchFight).toHaveBeenCalledTimes(1)
  })

  it('before the first answer nothing is drawn (the listing\'s words are not a fight reading)', async () => {
    fetchFight.mockImplementation(() => new Promise(() => {}))
    await mount(FIGHT_LISTING)
    expect(screen.queryByTestId('fight-view')).toBeNull()
    expect(screen.queryByTestId('game-view')).toBeNull()
  })

  it('a non-fight league is untouched: the scoreboard, the game route, never the fight route', async () => {
    fetchGame.mockResolvedValue({ kind: 'ok', row: row(), serverNow: SERVER_NOW, sources: SOURCES, detail: null })
    await mount(LISTING)
    expect(await screen.findByTestId('game-view')).toBeInTheDocument()
    expect(fetchFight).not.toHaveBeenCalled()
  })

  it('an event with no game asks neither', async () => {
    await mount(null)
    expect(fetchGame).not.toHaveBeenCalled()
    expect(fetchFight).not.toHaveBeenCalled()
  })
})
