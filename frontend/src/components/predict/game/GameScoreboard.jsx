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
import { describeAge } from '../../../lib/markets/priceReading'
import { detailAgeMs } from '../../../lib/sports/gameReading'
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

/** Neutral wording when the envelope names no source: never a hardcoded vendor. */
export const playsName = (sources) => sources?.plays?.label || 'the play-by-play source'
export const venueFeedName = (sources) => (sources?.venue?.label ? `${sources.venue.label}'s game feed` : "the venue's feed")

/** One short line about whose figures these are (and, for the venue's feed, how often it speaks and when it last did). */
function sourceLine(reading, sources, clock) {
  if (reading.source === 'plays') return `From ${playsName(sources)}.`
  if (reading.source !== 'venue') return null
  const base = `Score from ${venueFeedName(sources)}, which updates about once a minute.`
  const age = reading.changedAt != null && clock ? detailAgeMs(reading.changedAt, clock.serverNow, clock.receivedAt, clock.now) : null
  return Number.isFinite(age) && Math.round(age / 1000) >= 1 ? `${base} Last changed ${describeAge(age)} ago.` : base
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

export default function GameScoreboard({ game, reading, sources = null, clock = null }) {
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
      {known && (
        <p className="game-source" data-testid="game-source">
          {sourceLine(reading, sources, clock)}
        </p>
      )}
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
