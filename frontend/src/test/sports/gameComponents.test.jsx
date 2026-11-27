/**
 * The game view's parts (spec 115): scoreboard, field, plays and the composed body — every state, absent
 * fields, `teams` without home/away, the source sentences, and axe.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { axe } from 'vitest-axe'
import GameScoreboard from '../../components/predict/game/GameScoreboard'
import FootballField from '../../components/predict/game/FootballField'
import PlayList from '../../components/predict/game/PlayList'
import GameTrustChip from '../../components/predict/game/GameTrustChip'
import { GameViewBody } from '../../components/predict/game/GameView'
import { fromRow, unknown } from '../../lib/sports/gameReading'
import { LISTING, TEAMS_LISTING, SERVER_NOW, SOURCES, row, venueRow, situation, plays, detail } from '../fixtures/sportsGames'

const rd = (over = {}, ageMs = 2000) => fromRow(row({ confirmedAt: SERVER_NOW - ageMs, ...over }), SERVER_NOW, performance.now())
const NAMES = { home: 'Cowboys', away: 'Eagles' }

describe('GameScoreboard', () => {
  it('in progress: both teams, the score, period, clock and a Live chip', () => {
    render(<GameScoreboard game={LISTING} reading={rd()} />)
    expect(screen.getByText('Cowboys')).toBeInTheDocument()
    expect(screen.getByText('Eagles')).toBeInTheDocument()
    expect(screen.getByText('28')).toBeInTheDocument()
    expect(screen.getByText('10')).toBeInTheDocument()
    expect(screen.getByTestId('game-status')).toHaveTextContent('In progress · Q3 · 10:39')
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('Game information is live')
  })

  it('not started: says so with the start time and draws no score', () => {
    render(<GameScoreboard game={LISTING} reading={rd({ status: 'scheduled', score: { home: 0, away: 0 }, period: null, clock: null })} />)
    expect(screen.getByTestId('game-status')).toHaveTextContent(/^Not started · starts /)
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('ended: final score, "Ended", and the market settles separately — never "resolved"', () => {
    render(<GameScoreboard game={LISTING} reading={rd({ status: 'ended', clock: null, period: 'Final' })} />)
    expect(screen.getByTestId('game-status')).toHaveTextContent('Ended · Final')
    expect(screen.getByText(/The market settles separately/)).toBeInTheDocument()
    expect(screen.queryByText(/resolved/i)).toBeNull()
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('up to date')
    expect(screen.getByTestId('game-trust-chip')).not.toHaveTextContent(/\blive\b/i)
  })

  it('never says Live on an old reading: delayed and last-known carry their age', () => {
    const { rerender } = render(<GameScoreboard game={LISTING} reading={rd({}, 45_000)} />)
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('Game information is delayed')
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent(/Delayed · 4[5-6] s/)
    rerender(<GameScoreboard game={LISTING} reading={rd({}, 300_000)} />)
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent(/Last known · 5 min/)
    expect(screen.getByTestId('game-trust-chip')).not.toHaveTextContent('is live')
  })

  it('unknown reading: no score, no status, a sentence and an Unavailable chip', () => {
    render(<GameScoreboard game={LISTING} reading={unknown('no-timestamp')} />)
    expect(screen.getByTestId('game-status')).toHaveTextContent('Game information is not available right now')
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('unavailable')
  })

  it('a reported 0–0 in progress is shown as 0–0 (a reported zero is not an absent figure)', () => {
    render(<GameScoreboard game={LISTING} reading={rd({ score: { home: 0, away: 0 } })} />)
    expect(screen.getAllByText('0')).toHaveLength(2)
  })

  it('a null score is dashes, never zeros', () => {
    render(<GameScoreboard game={LISTING} reading={rd({ score: null })} />)
    expect(screen.queryByText('0')).toBeNull()
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('a non-integer score is the venue\'s own text, unparsed', () => {
    render(<GameScoreboard game={LISTING} reading={rd({ score: null, scoreText: '6-4, 3-2 (set 3)' })} />)
    expect(screen.getByTestId('game-score-text')).toHaveTextContent('Score: 6-4, 3-2 (set 3)')
    // The text IS the score: a dash beside each team as well would read as "no score" next to a score.
    expect(screen.queryByText('—')).not.toBeInTheDocument()
  })

  it('an unrecognised status is shown as the venue\'s words', () => {
    render(<GameScoreboard game={LISTING} reading={rd({ status: 'Delayed - Weather', clock: null })} />)
    expect(screen.getByTestId('game-status')).toHaveTextContent('Delayed - Weather · Q3')
  })

  it('teams without home/away: never says home or away, and attributes no score to a side', () => {
    const { container } = render(<GameScoreboard game={TEAMS_LISTING} reading={rd()} />)
    expect(screen.getByText('Eagles')).toBeInTheDocument()
    expect(screen.getByText('Cowboys')).toBeInTheDocument()
    expect(screen.queryByText('28')).toBeNull()
    expect(screen.queryByText('10')).toBeNull()
    const text = container.textContent
    expect(text).not.toMatch(/\bHome\b/)
    expect(text).not.toMatch(/\bAway\b/)
    expect(text).toMatch(/does not say which team is at home/) // the sentence may name the fact it cannot state
  })

  it('a listing with a team missing its name falls back to its code, then to a plain sentence', () => {
    render(<GameScoreboard game={{ gameId: 1, home: { name: null, code: 'DAL' }, away: { name: null, code: null } }} reading={rd()} />)
    expect(screen.getByText('DAL')).toBeInTheDocument()
    expect(screen.getByText('Team not named')).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<GameScoreboard game={LISTING} reading={rd()} />)
    expect((await axe(container)).violations).toEqual([])
  })
})

describe('GameTrustChip', () => {
  it('words carry the state; the ticking text is aria-hidden', () => {
    const { container } = render(<GameTrustChip reading={rd({}, 40_000)} />)
    expect(container.querySelector('[aria-hidden="true"]:not(.predict-trust-dot)')).toHaveTextContent(/Delayed · 4[0-1] s/)
  })
})

describe('FootballField', () => {
  it('draws the field as aria-hidden and carries the same facts as text', () => {
    const { container } = render(<FootballField situation={situation()} names={NAMES} codes={{ home: 'DAL', away: 'PHI' }} />)
    const svg = container.querySelector('svg.game-field-svg')
    expect(svg).toHaveAttribute('aria-hidden', 'true')
    expect(svg.querySelector('.game-field-ball')).not.toBeNull()
    expect(svg.querySelector('.game-field-gain')).not.toBeNull() // diamond, a different SHAPE from the round ball
    expect(svg.querySelector('.game-field-ball').tagName).toBe('circle')
    expect(svg.querySelector('.game-field-gain').tagName).toBe('polygon')
    expect(svg.querySelector('.game-field-arrow')).not.toBeNull()
    const t = screen.getByTestId('game-field-text').textContent
    expect(t).toContain('4th & 18 at DAL 37')
    expect(t).toContain('Cowboys have the ball')
    expect(t).toContain('Line to gain')
    expect(screen.getByText('Line to gain')).toBeInTheDocument() // legend names each marker in words
    expect(screen.getByText('Ball')).toBeInTheDocument()
  })

  it('places the ball on the home-goal-line axis and points an away drive the other way', () => {
    const home = render(<FootballField situation={situation({ yardLine: 20, possession: 'home' })} names={NAMES} />).container
    const away = render(<FootballField situation={situation({ yardLine: 20, possession: 'away' })} names={NAMES} />).container
    expect(home.querySelector('.game-field-ball').getAttribute('cx')).toBe(String(100 + 20 * 10))
    const xs = (c) => c.querySelector('.game-field-arrow').getAttribute('points').split(' ').map((p) => Number(p.split(',')[0]))
    expect(Math.min(...xs(home))).toBeGreaterThan(300)
    expect(Math.max(...xs(away))).toBeLessThan(300)
  })

  it('draws no ball without a yard line, and no diamond without a line to gain; the text still says what is known', () => {
    const { container } = render(<FootballField situation={situation({ yardLine: null, lineToGain: null })} names={NAMES} />)
    expect(container.querySelector('svg')).toBeNull()
    expect(screen.getByTestId('game-field-text')).toHaveTextContent('Cowboys have the ball')
    const r2 = render(<FootballField situation={situation({ lineToGain: null })} names={NAMES} />).container
    expect(r2.querySelector('.game-field-gain')).toBeNull()
    expect(r2.querySelector('.game-field-ball')).not.toBeNull()
  })

  it('refuses an out-of-range yard line or line to gain (goal to go is text, not a marker off the field)', () => {
    const c1 = render(<FootballField situation={situation({ yardLine: 140 })} names={NAMES} />).container
    expect(c1.querySelector('svg')).toBeNull()
    const c2 = render(<FootballField situation={situation({ lineToGain: 108 })} names={NAMES} />).container
    expect(c2.querySelector('.game-field-gain')).toBeNull()
  })

  it('a ball at the goal line (0) is drawn: zero is a real yard line, not an absent one', () => {
    const { container } = render(<FootballField situation={situation({ yardLine: 0 })} names={NAMES} />)
    expect(container.querySelector('.game-field-ball').getAttribute('cx')).toBe('100')
  })

  it('has no axe violations', async () => {
    const { container } = render(<FootballField situation={situation()} names={NAMES} />)
    expect((await axe(container)).violations).toEqual([])
  })
})

describe('PlayList', () => {
  it('lists plays in the order given (newest first) with period and clock, marking scoring in words', () => {
    render(<PlayList plays={plays()} />)
    const items = within(screen.getByTestId('game-plays')).getAllByRole('listitem')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('Q3 10:44')
    expect(items[1]).toHaveTextContent('Scored: Jake Elliott 42 yard field goal is GOOD.')
    expect(items[0]).not.toHaveTextContent('Scored:')
  })

  it('shows at most 12 and invents none; nothing at all for none', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, period: 'Q1', clock: '1:00', text: `play ${i}`, scoring: false }))
    render(<PlayList plays={many} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(12)
    const { container } = render(<PlayList plays={[]} />)
    expect(container).toBeEmptyDOMElement()
    expect(render(<PlayList plays={null} />).container).toBeEmptyDOMElement()
  })

  it('a play with no period/clock/text shows dashes and plain words, not blanks or zeros', () => {
    render(<PlayList plays={[{ id: 'x', period: null, clock: null, text: null, scoring: false }]} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.getByText('No description reported')).toBeInTheDocument()
  })
})

describe('GameViewBody — source sentences', () => {
  const base = { game: LISTING, serverNow: SERVER_NOW, receivedAt: 0, now: 0, sources: { venue: { state: 'read' }, plays: { state: 'read' } } }
  const body = (over = {}) => render(<GameViewBody {...base} reading={rd()} detail={detail()} {...over} />)

  it('detail read: scoreboard, field, plays and the one behind-the-broadcast sentence', () => {
    body()
    expect(screen.getByTestId('game-field')).toBeInTheDocument()
    expect(screen.getByTestId('game-plays')).toBeInTheDocument()
    expect(screen.getByText(/can be behind the broadcast and behind the market/)).toBeInTheDocument()
    expect(screen.queryByText(/may be behind the score/)).toBeNull()
  })

  it('the old "play detail may be behind the score" line is gone (it was the wrong way round)', () => {
    body({ reading: rd({ agree: false, venue: { score: { home: 21, away: 10 }, changedAt: SERVER_NOW - 120_000 } }) })
    expect(screen.queryByText(/may be behind the score/i)).toBeNull()
  })

  describe('disagreement (amended FR-008)', () => {
    const venue = { score: { home: 21, away: 10 }, changedAt: SERVER_NOW - 120_000 }
    it('plays-sourced, agree:false, venue present: one line says what the venue\'s feed shows and when it changed', () => {
      body({ reading: rd({ agree: false, venue }), sources: SOURCES })
      expect(screen.getByTestId('game-disagree').textContent).toBe(
        "Polymarket's own game feed still shows Eagles 10, Cowboys 21 (last changed 2 min ago).",
      )
      expect(screen.getByText('28')).toBeInTheDocument() // the play source's score is the one shown
    })
    it('uses the venue\'s scoreText unparsed when it has no attributable score, and a neutral name without a label', () => {
      body({ reading: rd({ agree: false, venue: { scoreText: '10-21', changedAt: null } }) })
      expect(screen.getByTestId('game-disagree').textContent).toBe("The venue's own game feed still shows 10-21.")
    })
    it('says only that it differs when the venue gave neither', () => {
      body({ reading: rd({ agree: false, venue: { changedAt: null } }) })
      expect(screen.getByTestId('game-disagree').textContent).toMatch(/still shows something different\.$/)
    })
    it('no line when they agree, when only one source spoke, or when the venue block is absent', () => {
      body({ reading: rd({ agree: true, venue }) })
      expect(screen.queryByTestId('game-disagree')).toBeNull()
      body({ reading: rd({ agree: null, venue: null }) })
      expect(screen.queryByTestId('game-disagree')).toBeNull()
      body({ reading: rd({ agree: false, venue: null }) })
      expect(screen.queryByTestId('game-disagree')).toBeNull()
    })
    it('never on a venue-sourced reading (it has nothing to disagree with)', () => {
      body({ reading: rd({ source: 'venue', agree: false, venue }) })
      expect(screen.queryByTestId('game-disagree')).toBeNull()
    })
  })

  describe('venue-sourced reading', () => {
    const v = (over = {}, age = 5000) => rd({ ...venueRow(), confirmedAt: SERVER_NOW - age, ...over })
    it('is Delayed (never Live) with one line naming the feed from the envelope, its cadence and when it changed', () => {
      body({ reading: v(), detail: null, sources: SOURCES })
      expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('Game information is delayed')
      expect(screen.getByTestId('game-trust-chip')).not.toHaveTextContent('is live')
      expect(screen.getByTestId('game-source').textContent).toBe(
        "Score from Polymarket's game feed, which updates about once a minute. Last changed 40 s ago.",
      )
    })
    it('falls back to neutral words when the envelope names no source', () => {
      body({ reading: v(), detail: null, sources: null })
      expect(screen.getByTestId('game-source').textContent).toMatch(/^Score from the venue's feed, which updates about once a minute\./)
    })
    it('is Last known past 75 s', () => {
      body({ reading: v({}, 90_000), detail: null, sources: SOURCES })
      expect(screen.getByTestId('game-trust-chip')).toHaveTextContent('last known')
    })
    it('a plays-sourced reading names its source from the envelope, neutrally when absent', () => {
      body({ sources: SOURCES })
      expect(screen.getByTestId('game-source').textContent).toBe('From ESPN.')
      document.body.innerHTML = ''
      body({ sources: null })
      expect(screen.getByTestId('game-source').textContent).toBe('From the play-by-play source.')
    })
    it('contains no hardcoded vendor name: with no labels the page never says ESPN or Polymarket', () => {
      const { container } = body({ sources: null, detail: { state: 'unreadable', situation: null, plays: [] } })
      expect(container.textContent).not.toMatch(/ESPN|Polymarket/)
    })
  })

  it('detail unreadable: names the source, shows NO play fields and no behind-the-broadcast sentence', () => {
    body({ detail: { state: 'unreadable', confirmedAt: null, situation: situation(), plays: plays() }, sources: SOURCES })
    expect(screen.getByText('Play detail could not be read from ESPN, so no field or plays are shown.')).toBeInTheDocument()
    expect(screen.queryByTestId('game-field')).toBeNull()
    expect(screen.queryByTestId('game-plays')).toBeNull()
    expect(screen.queryByText(/behind the broadcast/)).toBeNull()
    expect(screen.getByText('Cowboys')).toBeInTheDocument() // the scoreboard is unaffected
  })

  it.each(['not-covered', 'not-matched', 'off'])('detail %s: the scoreboard alone, no apology', (state) => {
    const { container } = body({ detail: { state, situation: null, plays: [] } })
    expect(screen.getByTestId('game-status')).toBeInTheDocument()
    expect(container.querySelector('.game-detail')).toBeNull()
    expect(container.querySelectorAll('.game-note')).toHaveLength(0)
  })

  it('no detail at all (the list shape): scoreboard alone', () => {
    const { container } = body({ detail: null })
    expect(container.querySelector('.game-detail')).toBeNull()
  })

  it('the venue feed unreadable is named in a sentence', () => {
    body({ sources: { venue: { state: 'unreadable', reason: 'closed', label: 'Polymarket' }, plays: { state: 'off' } } })
    expect(screen.getByText(/Polymarket's game feed could not be read/)).toBeInTheDocument()
  })

  it('teams without home/away still shows the row\'s scoreText, as the venue\'s own text', () => {
    render(<GameScoreboard game={TEAMS_LISTING} reading={rd({ score: null, scoreText: '10-28' })} />)
    expect(screen.getByTestId('game-score-text')).toHaveTextContent('Score: 10-28')
    expect(screen.queryByText(/does not say which team/)).toBeNull()
  })

  it('teams without home/away: the field is not drawn (it cannot be oriented) but plays still show', () => {
    body({ game: TEAMS_LISTING })
    expect(screen.queryByTestId('game-field')).toBeNull()
    expect(screen.getByTestId('game-plays')).toBeInTheDocument()
  })

  it('plays only, no situation (between plays): plays show and no field', () => {
    body({ detail: detail({ situation: null }) })
    expect(screen.queryByTestId('game-field')).toBeNull()
    expect(screen.getByTestId('game-plays')).toBeInTheDocument()
  })

  it('states the age of an old play detail', () => {
    body({ detail: detail({ confirmedAt: SERVER_NOW - 300_000 }) })
    expect(screen.getByText(/last confirmed 5 min ago and is out of date/)).toBeInTheDocument()
  })

  it('has no axe violations with everything shown', async () => {
    const { container } = body()
    expect((await axe(container)).violations).toEqual([])
  })
})

describe('GameTrustChip — a venue reading', () => {
  it('says Delayed without an age: its confirmation is the connection\'s heartbeat, not a measure of how late the score is', () => {
    render(<GameTrustChip reading={rd({ source: 'venue', changedAt: SERVER_NOW - 41_000 }, 6000)} />)
    const chip = screen.getByTestId('game-trust-chip')
    expect(chip).toHaveTextContent('Game information is delayed')
    expect(chip.textContent).not.toMatch(/\d/)
  })

  it('a play-source reading that is delayed still shows its age', () => {
    render(<GameTrustChip reading={rd({}, 40_000)} />)
    expect(screen.getByTestId('game-trust-chip').textContent).toMatch(/Delayed · 40 s/)
  })
})

