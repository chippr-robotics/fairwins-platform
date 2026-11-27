/** The fight view's parts (spec 115 slice 3): every state, tables, absent figures, result, attribution, a11y. */
import { describe, it, expect } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import { axe } from 'vitest-axe'
import { FightViewBody } from '../../components/predict/game/FightView'
import FightFigures from '../../components/predict/game/FightFigures'
import { controlTime } from '../../lib/sports/describe'
import { fromFight } from '../../lib/sports/fightReading'
import { fight, figures, ROUND1, OVERALL, DECISION, KO, SOURCES, SERVER_NOW, FIGHT_LISTING } from '../fixtures/sportsFights'

const rd = (over = {}, receivedAt = performance.now()) => fromFight(fight(over), SERVER_NOW, receivedAt)
const body = (over = {}, props = {}) => render(<FightViewBody game={FIGHT_LISTING} reading={rd(over)} sources={SOURCES} serverNow={SERVER_NOW} receivedAt={performance.now()} now={performance.now()} {...props} />)
const NAMES = ['Ciryl Gane', 'Josh Hokit']

describe('the header', () => {
  it('in progress: both names, weight class, scheduled rounds, round of N and the clock, a Live chip', () => {
    body()
    expect(screen.getByTestId('fight-names')).toHaveTextContent('Ciryl Gane vs Josh Hokit')
    expect(screen.getByTestId('fight-meta')).toHaveTextContent('Heavyweight · 5 rounds')
    expect(screen.getByTestId('fight-status')).toHaveTextContent('In progress · Round 2 of 5 · 3:12')
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('Fight information is live')
    expect(screen.getByTestId('fight-source')).toHaveTextContent('From ESPN.')
  })
  it('names only: no corner, photo, flag or image anywhere', () => {
    const { container } = body()
    expect(container.querySelector('img,picture,svg')).toBeNull()
    expect(container.textContent).not.toMatch(/\b(red|blue) corner\b/i)
  })
  it('scheduled: not started with the start time; no round, no clock, no result, no figures', () => {
    const { container } = body({ status: 'scheduled', round: null, clock: null, rounds: null })
    expect(screen.getByTestId('fight-status')).toHaveTextContent(/^Not started · starts /)
    expect(screen.queryByTestId('fight-result')).toBeNull()
    expect(screen.queryByTestId('fight-figures')).toBeNull()
    expect(container.textContent).not.toMatch(/Round \d/)
  })
  it('missing weight class and rounds print nothing, never "0 rounds"', () => {
    body({ weightClass: null, scheduledRounds: null })
    expect(screen.queryByTestId('fight-meta')).toBeNull()
  })
  it('names a fighter the source did not name from the listing; neither ⇒ a plain phrase, not blanks', () => {
    body({ fighters: [{ name: null }, { name: null }] })
    expect(screen.getByTestId('fight-names')).toHaveTextContent('Ciryl Gane vs Josh Hokit')
    document.body.innerHTML = ''
    body({ fighters: [{ name: null }, { name: null }] }, { game: { gameId: 1, league: 'ufc' } })
    expect(screen.getByTestId('fight-names')).toHaveTextContent('Fighter not named')
  })
  it('an unknown reading: names from the listing, an Unavailable chip, a sentence, nothing else', () => {
    const { container } = body({ source: null })
    expect(screen.getByTestId('fight-status')).toHaveTextContent('not available right now')
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('unavailable')
    expect(container.querySelector('table')).toBeNull()
  })
})

describe('trust by source', () => {
  it('last known past the bound; delayed in between; never Live on an old reading', () => {
    const { rerender } = body({ confirmedAt: SERVER_NOW - 60_000 })
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('Fight information is delayed')
    rerender(<FightViewBody game={FIGHT_LISTING} reading={rd({ confirmedAt: SERVER_NOW - 300_000 })} sources={SOURCES} serverNow={SERVER_NOW} receivedAt={0} now={0} />)
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('last known fight information')
  })
  it('a figures-sourced fight is Delayed (never Live) and names the UFC source', () => {
    body({ source: 'figures', status: 'ended', confirmedAt: SERVER_NOW - 1000 })
    expect(screen.getByTestId('game-trust-chip')).not.toHaveTextContent('is live')
    expect(screen.getByTestId('fight-source')).toHaveTextContent('From UFC.')
  })
  it('a venue-sourced fight says the feed updates about once a minute and when it last changed; labels come from the envelope', () => {
    body({ source: 'venue', round: null, changedAt: SERVER_NOW - 90_000 })
    expect(screen.getByTestId('fight-source').textContent).toMatch(/^From Polymarket's feed, which updates about once a minute\. Last changed /)
  })
  it('no hardcoded vendor names: with no labels the words are neutral', () => {
    const { container } = body({ source: 'venue', round: null }, { sources: null })
    expect(container.textContent).not.toMatch(/ESPN|Polymarket|UFC/)
    expect(screen.getByTestId('fight-source').textContent).toMatch(/the venue's feed/)
  })
})

describe('figures tables (FR-018)', () => {
  it('a real table: caption, column headers per fighter, row headers per figure', () => {
    body()
    const t = screen.getByRole('table', { name: 'Round 1 of 5' })
    expect(within(t).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Figure', ...NAMES])
    expect(within(t).getByRole('rowheader', { name: 'Significant strikes' })).toBeInTheDocument()
    const row = within(t).getByRole('rowheader', { name: 'Significant strikes' }).closest('tr')
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['41 of 65', '22 of 51'])
  })
  it('control time is m:ss; a reported zero is 0 and 0:00, absent is a dash with "not reported"', () => {
    expect(controlTime(71)).toBe('1:11')
    expect(controlTime(0)).toBe('0:00')
    expect(controlTime(277)).toBe('4:37')
    expect(controlTime(null)).toBeNull()
    const f = [figures({ knockdowns: 0, controlSeconds: 0, sigStrikesLanded: 5, sigStrikesAttempted: null }), figures()]
    render(<FightFigures names={NAMES} rounds={[{ round: 1, figures: f }]} overall={null} scheduledRounds={3} />)
    const rowOf = (n) => screen.getByRole('rowheader', { name: n }).closest('tr')
    expect(within(rowOf('Knockdowns')).getAllByRole('cell')[0]).toHaveTextContent('0')
    expect(within(rowOf('Control time')).getAllByRole('cell')[0]).toHaveTextContent('0:00')
    const miss = within(rowOf('Knockdowns')).getAllByRole('cell')[1]
    expect(miss).toHaveTextContent('not reported')
    expect(miss.querySelector('[aria-hidden="true"]')).toHaveTextContent('—')
    expect(miss.textContent).not.toMatch(/\b0\b/)
    expect(within(rowOf('Significant strikes')).getAllByRole('cell')[0].textContent).toMatch(/5 of.*not reported/)
    expect(within(rowOf('Takedowns')).getAllByRole('cell')[0]).toHaveTextContent('not reported')
  })
  it('derives NOTHING: no total, percentage, accuracy, bar, lead or emphasis', () => {
    const { container } = body({ rounds: [{ round: 1, figures: ROUND1 }, { round: 2, figures: ROUND1 }], overall: OVERALL })
    fireEvent.click(screen.getByRole('button', { name: /more tables/ }))
    const text = container.textContent
    expect(text).not.toMatch(/%/)
    expect(text).not.toMatch(/\b(accuracy|leading|leads|ahead|winning|advantage)\b/i)
    expect(container.querySelector('progress,meter,[role="progressbar"],[class*="bar"],b,strong,mark')).toBeNull()
    // every number shown is one the source gave: nothing like 41+22, 63, etc. is invented
    const cells = Array.from(container.querySelectorAll('td')).map((c) => c.textContent)
    expect(cells).not.toContain('63')
  })
  it('the first table is shown, the rest are UNMOUNTED until asked for, and the button says how many', () => {
    body({ rounds: [{ round: 1, figures: ROUND1 }, { round: 2, figures: ROUND1 }], overall: OVERALL })
    expect(screen.getAllByRole('table')).toHaveLength(1)
    expect(screen.getByRole('table', { name: 'Overall, the whole fight' })).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: 'Show 2 more tables' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(screen.getAllByRole('table')).toHaveLength(3)
    expect(screen.getByRole('table', { name: 'Round 2 of 5' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show fewer tables' })).toHaveAttribute('aria-expanded', 'true')
  })
  it('an Overall table only when the source gave one; without it the latest round leads', () => {
    body({ rounds: [{ round: 1, figures: ROUND1 }, { round: 2, figures: ROUND1 }], overall: null })
    expect(screen.queryByRole('table', { name: /Overall/ })).toBeNull()
    expect(screen.getAllByRole('table')[0]).toHaveAccessibleName('Round 2 of 5')
  })
  it('says the figures are the source\'s own counts and can be behind the broadcast and the market', () => {
    body()
    expect(screen.getByText(/source's own counts\. They can be behind the broadcast and behind the market/)).toBeInTheDocument()
  })
  it('no rounds and no overall: no table and no figures sentence', () => {
    body({ rounds: null, overall: null })
    expect(screen.queryByTestId('fight-figures')).toBeNull()
    expect(screen.queryByText(/source's own counts/)).toBeNull()
  })
})

describe('the result (FR-019)', () => {
  it('a decision: winner, method, round and time, three judges\' scores in a table, the source, and the market sentence', () => {
    body({ status: 'ended', source: 'figures', round: 5, clock: '5:00', result: DECISION })
    const r = screen.getByTestId('fight-result')
    expect(r).toHaveTextContent('Ciryl Gane won')
    expect(r).toHaveTextContent('Decision - Unanimous · Round 5 · 5:00')
    expect(r).toHaveTextContent('Result from UFC.')
    const j = within(r).getByRole('table', { name: "Judges' scores" })
    expect(within(j).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Judge', ...NAMES])
    expect(within(j).getAllByRole('row')).toHaveLength(4)
    expect(within(j).getByRole('rowheader', { name: 'Adrian Castro' }).closest('tr')).toHaveTextContent('4847')
    expect(within(r).getByText(/market settles separately/)).toBeInTheDocument()
    expect(r.textContent).not.toMatch(/resolved/i)
  })
  it('a KO: the winner is the second fighter, no judges table', () => {
    body({ status: 'ended', source: 'figures', round: 1, clock: '0:24', result: KO })
    expect(screen.getByTestId('fight-result')).toHaveTextContent('Josh Hokit won')
    expect(screen.getByTestId('fight-result')).toHaveTextContent('KO/TKO · Round 1 · 0:24')
    expect(screen.queryByTestId('fight-judges')).toBeNull()
  })
  it('a draw and a no contest are stated as the source\'s and name no winner', () => {
    body({ status: 'ended', source: 'figures', result: { ...DECISION, outcome: 'draw', winner: null } })
    expect(screen.getByTestId('fight-result')).toHaveTextContent('Draw')
    expect(screen.getByTestId('fight-result').textContent).not.toMatch(/won/)
    document.body.innerHTML = ''
    body({ status: 'ended', source: 'figures', result: { source: 'figures', outcome: 'no-contest', winner: null, method: 'No Contest', endingRound: 2, endingTime: '1:10', judges: [] } })
    expect(screen.getByTestId('fight-result')).toHaveTextContent('No contest')
    expect(screen.getByTestId('fight-result').textContent).not.toMatch(/won/)
  })
  it('cancelled from the venue is ATTRIBUTED, never stated as fact', () => {
    body({ source: 'venue', status: 'cancelled', round: null, clock: null, result: { source: 'venue', outcome: 'cancelled', winner: null, method: null, endingRound: null, endingTime: null, judges: [] } })
    expect(screen.getByTestId('fight-result')).toHaveTextContent("Polymarket's feed lists this fight as cancelled")
    expect(screen.getByTestId('fight-status')).toHaveTextContent('Listed as cancelled')
    expect(screen.getByTestId('fight-result').textContent).not.toMatch(/Result from/)
  })
  it('a result with no known outcome says so rather than guessing', () => {
    body({ status: 'ended', result: { source: 'card', outcome: null, winner: null, method: null, endingRound: null, endingTime: null, judges: [] } })
    expect(screen.getByTestId('fight-result')).toHaveTextContent('The result was not reported')
  })
  it('a result with a missing method / time prints only what is there', () => {
    body({ status: 'ended', result: { ...KO, method: null, endingTime: null } })
    expect(screen.getByTestId('fight-result')).toHaveTextContent(/won\s*Round 1/)
  })
  it('no result block while the fight has none', () => {
    body()
    expect(screen.queryByTestId('fight-result')).toBeNull()
  })
})

describe('disagreement and source sentences', () => {
  it('the venue says cancelled while the leading source says ended: one attributed line', () => {
    body({ status: 'ended', source: 'figures', result: DECISION, venue: { status: 'cancelled', scoreText: null, clock: null, changedAt: SERVER_NOW - 180_000 } })
    expect(screen.getByTestId('fight-disagree').textContent).toMatch(/^Polymarket's feed lists this fight as cancelled \(last changed 3 min ago\), which differs from the source above\.$/)
    expect(screen.getByTestId('fight-result')).toHaveTextContent('Ciryl Gane won') // the leading source's result stands
  })
  it('no line when they agree, when the venue has no status, or when the venue leads', () => {
    body({ status: 'ended', venue: { status: 'ended', changedAt: 1 } })
    expect(screen.queryByTestId('fight-disagree')).toBeNull()
    body({ venue: { status: null, changedAt: 1 } })
    expect(screen.queryByTestId('fight-disagree')).toBeNull()
    body({ source: 'venue', venue: { status: 'cancelled' } })
    expect(screen.queryByTestId('fight-disagree')).toBeNull()
  })
  it('an unreadable card / figures source is NAMED and its fields are absent', () => {
    body({ rounds: null, overall: null }, { sources: { ...SOURCES, figures: { state: 'unreadable', label: 'UFC', reason: 'upstream_error' }, card: { state: 'unreadable', label: 'ESPN', reason: 'upstream_error' } } })
    expect(screen.getByText(/Fight details could not be read from ESPN/)).toBeInTheDocument()
    expect(screen.getByText('Round figures could not be read from UFC, so none are shown.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
  it.each(['not-matched', 'not-covered', 'off'])('figures %s: what there is, no apology', (state) => {
    const { container } = body({ rounds: null }, { sources: { ...SOURCES, figures: { state, label: 'UFC' } } })
    expect(container.querySelector('p[role="status"]')).toBeNull()
    expect(screen.getByTestId('fight-status')).toBeInTheDocument()
  })
})

describe('a11y', () => {
  it('has no axe violations with figures, result and judges showing', async () => {
    const { container } = body({ status: 'ended', source: 'figures', result: DECISION, overall: OVERALL, rounds: [{ round: 1, figures: ROUND1 }] })
    expect((await axe(container)).violations).toEqual([])
  })
})
