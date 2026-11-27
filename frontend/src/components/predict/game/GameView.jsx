/**
 * GameView (spec 115) — the game beside its market: scoreboard, then (football, when a play source answered)
 * the field and the last plays. It owns the sentences about WHERE each part came from.
 *
 *  - the page draws NOTHING until a game answer exists and NOTHING when the gateway module is off or absent
 *    (FR-013): no placeholder, no sentence;
 *  - `detail.state`: `read` → field + plays; `unreadable` → one sentence naming the play source, no play
 *    fields; `not-covered` / `not-matched` / `off` / none → the scoreboard alone, no apology (FR-007);
 *  - FR-008 (amended): where the play source is read its figures are shown; when the venue's own feed says
 *    something different (`agree:false`) one line says what it shows and when it last changed. A venue-sourced
 *    reading is never live;
 *  - wherever play detail shows, one sentence says it can be behind the broadcast and the market (FR-012).
 * Reads nothing from, and hands nothing to, any ticket / plan / trade module (FR-010).
 */
import { useMemo } from 'react'
import { useGameReading } from '../../../hooks/useGameReading'
import { sidesOf, teamLabel, playsName, venueFeedName, isFightGame } from '../../../lib/sports/describe'
import { detailAgeMs, fromListed, reclassify, TRUST_BOUNDS } from '../../../lib/sports/gameReading'
import { describeAge } from '../../../lib/markets/priceReading'
import GameScoreboard from './GameScoreboard'
import FightView from './FightView'
import FootballField from './FootballField'
import PlayList from './PlayList'
import './GameView.css'

const hasSituation = (s) => s && typeof s === 'object'
const OUT_OF_DATE_MS = TRUST_BOUNDS.plays.delayedMs // past the play source's own `delayed` bound the detail is called out of date

/** What the venue's feed said, in words, built from ITS figures only (score unparsed text when it has no sides). */
function venueSays(venue, sides) {
  if (venue.score && sides.kind === 'homeAway') {
    const a = teamLabel(sides.away) ?? 'the away team'
    const h = teamLabel(sides.home) ?? 'the home team'
    return `shows ${a} ${venue.score.away}, ${h} ${venue.score.home}`
  }
  if (venue.scoreText) return `shows ${venue.scoreText}`
  return 'shows something different'
}

/** Presentational: everything it shows is in its props, so every state is testable without a poller. */
export function GameViewBody({ game, reading, detail, sources, serverNow, receivedAt, now }) {
  const clock = { serverNow, receivedAt, now }
  const sides = sidesOf(game)
  const homeAway = sides.kind === 'homeAway'
  const names = { home: homeAway ? teamLabel(sides.home) : null, away: homeAway ? teamLabel(sides.away) : null }
  const codes = {
    home: homeAway ? sides.home?.code ?? null : null,
    away: homeAway ? sides.away?.code ?? null : null,
  }

  const venueUnreadable = sources?.venue?.state === 'unreadable'
  const detailState = detail?.state ?? null
  const detailRead = detailState === 'read'
  const situation = detailRead && hasSituation(detail.situation) ? detail.situation : null
  // The field needs a home/away it can orient by; without one only the text line could be honest, and the
  // text line is built from the same facts — so no field, no half-truth.
  const drawField = Boolean(situation) && homeAway
  const plays = detailRead && Array.isArray(detail.plays) ? detail.plays : []
  const showsDetail = drawField || plays.length > 0
  const venue = reading?.source === 'plays' && reading.agree === false ? reading.venue : null
  const venueAge = venue && venue.changedAt != null ? detailAgeMs(venue.changedAt, serverNow, receivedAt, now) : null
  const age = detailRead ? detailAgeMs(detail.confirmedAt, serverNow, receivedAt, now) : null

  return (
    <section className="game-view" aria-labelledby="game-view-title" data-testid="game-view">
      <h3 id="game-view-title">Game</h3>
      <GameScoreboard game={game} reading={reading} sources={sources} clock={clock} />
      {venue && (
        <p className="game-note" data-testid="game-disagree">
          {`${sources?.venue?.label ? `${sources.venue.label}'s own game feed` : "The venue's own game feed"} still ${venueSays(venue, sides)}${
            Number.isFinite(venueAge) && Math.round(venueAge / 1000) >= 1 ? ` (last changed ${describeAge(venueAge)} ago)` : ''
          }.`}
        </p>
      )}
      {venueUnreadable && (
        <p className="game-note" role="status">
          {`${venueFeedName(sources)[0].toUpperCase()}${venueFeedName(sources).slice(1)} could not be read just now, so the score above may be out of date.`}
        </p>
      )}
      {detailState === 'unreadable' && (
        <p className="game-note" role="status">
          {`Play detail could not be read from ${playsName(sources)}, so no field or plays are shown.`}
        </p>
      )}
      {showsDetail && (
        <div className="game-detail">
          {drawField && <FootballField situation={situation} names={names} codes={codes} />}
          <PlayList plays={plays} />
          <p className="game-note">
            Play detail can be behind the broadcast and behind the market.
            {Number.isFinite(age) && Math.round(age / 1000) >= 1 ? ` It was last confirmed ${describeAge(age)} ago${age > OUT_OF_DATE_MS ? ' and is out of date' : ''}.` : ''}
          </p>
        </div>
      )}
    </section>
  )
}

/**
 * A fight league gets the fight view INSTEAD of the scoreboard (a fight has no field and no score), and with
 * the fight route absent it gets NOTHING — never a scoreboard built from fighter names. The two views are
 * separate components so only one ever mounts, and only one's poller ever runs.
 */
export default function GameView({ game, listingStamp = null }) {
  if (isFightGame(game)) return <FightView game={game} />
  return <ScoreboardGameView game={game} listingStamp={listingStamp} />
}

function ScoreboardGameView({ game, listingStamp }) {
  const state = useGameReading(game)
  // Until the game route answers with a source, the listing's own words stand in — as a VENUE reading, aged
  // from the listing's confirmation (never live; nothing at all when that age cannot be measured).
  const listed = useMemo(() => (game?.listed ? fromListed(game.listed, listingStamp, state.now) : null), [game, listingStamp, state.now])
  if (!game || state.phase === 'absent') return null
  const answered = state.phase === 'ready' && state.reading && state.reading.state !== 'unknown'
  if (answered) {
    return (
      <GameViewBody
        game={game}
        reading={state.reading}
        detail={state.detail}
        sources={state.sources}
        serverNow={state.serverNow}
        receivedAt={state.receivedAt}
        now={state.now}
      />
    )
  }
  const stand = listed ? reclassify(listed, state.now) : null
  if (stand && stand.state !== 'unknown') {
    return <GameViewBody game={game} reading={stand} detail={null} sources={null} serverNow={null} receivedAt={null} now={state.now} />
  }
  // Answered but nobody spoke for the game, and no listing words: the scoreboard says so. Still loading: nothing.
  if (state.phase === 'ready' && state.reading) {
    return <GameViewBody game={game} reading={state.reading} detail={state.detail} sources={state.sources} serverNow={state.serverNow} receivedAt={state.receivedAt} now={state.now} />
  }
  return null
}
