/**
 * GameScoreboard (spec 115, US1) — both teams, the score, the period and clock, the status and how current it
 * is. Information beside the market; it feeds nothing to a ticket and offers nothing to press (FR-010/011).
 *
 * Honest by construction:
 *  - a figure the reading does not carry is a dash or absent, never 0 (an `unknown` reading carries none);
 *  - a score that is not two integers is the venue's own `scoreText`, shown as given, never parsed;
 *  - when the listing did not say which team is home, nothing here says "home" or "away" — and, because the
 *    gateway's score is keyed home/away, no score is drawn against teams it cannot be tied to;
 *  - "Ended" is the GAME's state. The market settles separately, and the page says so in one sentence.
 */
import { sidesOf, teamLabel, formatStart } from '../../../lib/sports/describe'
import GameTrustChip from './GameTrustChip'

const DASH = '—'

function Team({ name, score, tag }) {
  return (
    <div className="game-team">
      <span className="game-team-name">
        {name ?? 'Team not named'}
        {tag && <span className="game-team-tag"> {tag}</span>}
      </span>
      <span className="game-team-score">{score ?? DASH}</span>
    </div>
  )
}

function statusLine(reading, game) {
  const status = reading?.status
  if (status === 'scheduled') {
    const start = formatStart(game?.startTime)
    return start ? `Not started · starts ${start}` : 'Not started'
  }
  if (status === 'in-progress') {
    return ['In progress', reading.period, reading.clock].filter(Boolean).join(' · ')
  }
  if (status === 'ended') return reading.period ? `Ended · ${reading.period}` : 'Ended'
  if (status === 'other') return [reading.statusText, reading.period, reading.clock].filter(Boolean).join(' · ')
  return 'Status not reported'
}

export default function GameScoreboard({ game, reading }) {
  const sides = sidesOf(game)
  const known = reading && reading.state !== 'unknown'
  const hasScoreboardScore = known && reading.score != null && reading.status !== 'scheduled'
  const ended = known && reading.status === 'ended'

  let teams
  if (sides.kind === 'homeAway') {
    teams = [
      <Team key="away" name={teamLabel(sides.away)} score={hasScoreboardScore ? reading.score.away : null} tag="Away" />,
      <Team key="home" name={teamLabel(sides.home)} score={hasScoreboardScore ? reading.score.home : null} tag="Home" />,
    ]
  } else if (sides.kind === 'teams') {
    teams = sides.teams.map((t, i) => <Team key={i} name={teamLabel(t)} score={null} />)
  } else {
    teams = <p className="game-note">The venue did not name the teams.</p>
  }

  return (
    <div className="game-scoreboard" role="group" aria-label="Scoreboard">
      <div className="game-scoreboard-head">
        <p className="game-status" data-testid="game-status">
          {known ? statusLine(reading, game) : 'Game information is not available right now'}
        </p>
        {reading && <GameTrustChip reading={reading} ended={ended} />}
      </div>
      <div className="game-teams">{teams}</div>
      {known && reading.score == null && reading.scoreText && reading.status !== 'scheduled' && (
        <p className="game-score-text" data-testid="game-score-text">
          Score: {reading.scoreText}
        </p>
      )}
      {sides.kind === 'teams' && known && reading.score != null && (
        <p className="game-note">The listing does not say which team is at home, so no score is attributed to a side here.</p>
      )}
      {ended && <p className="game-note">The game has ended. The market settles separately, on the venue's own resolution.</p>}
    </div>
  )
}
