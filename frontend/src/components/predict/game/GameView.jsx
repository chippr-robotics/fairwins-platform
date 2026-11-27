/**
 * GameView (spec 115) — the game beside its market: scoreboard, then (football, when a play source answered)
 * the field and the last plays. It owns the sentences about WHERE each part came from.
 *
 *  - the page draws NOTHING until a game answer exists and NOTHING when the gateway module is off or absent
 *    (FR-013): no placeholder, no sentence;
 *  - `detail.state`: `read` → field + plays; `unreadable` → one sentence naming the play source, no play
 *    fields; `not-covered` / `not-matched` / `off` / none → the scoreboard alone, no apology (FR-007);
 *  - the venue's score is the one shown; when the play source disagrees (`agree:false` / `behindVenue`) one
 *    line says the play detail may be behind the score (FR-008);
 *  - wherever play detail shows, one sentence says it can be behind the broadcast and the market (FR-012).
 * Reads nothing from, and hands nothing to, any ticket / plan / trade module (FR-010).
 */
import { useGameReading } from '../../../hooks/useGameReading'
import { sidesOf, teamLabel } from '../../../lib/sports/describe'
import { detailAgeMs, DELAYED_MS } from '../../../lib/sports/gameReading'
import { describeAge } from '../../../lib/markets/priceReading'
import GameScoreboard from './GameScoreboard'
import FootballField from './FootballField'
import PlayList from './PlayList'
import './GameView.css'

const hasSituation = (s) => s && typeof s === 'object'

/** Presentational: everything it shows is in its props, so every state is testable without a poller. */
export function GameViewBody({ game, reading, detail, sources, serverNow, receivedAt, now }) {
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
  const behind = detailRead && (detail.behindVenue === true || reading?.agree === false)
  const age = detailRead ? detailAgeMs(detail.confirmedAt, serverNow, receivedAt, now) : null

  return (
    <section className="game-view" aria-labelledby="game-view-title" data-testid="game-view">
      <h3 id="game-view-title">Game</h3>
      <GameScoreboard game={game} reading={reading} />
      {venueUnreadable && (
        <p className="game-note" role="status">
          The venue's game feed could not be read just now, so the score above may be out of date.
        </p>
      )}
      {detailState === 'unreadable' && (
        <p className="game-note" role="status">
          Play detail could not be read from the play-by-play source (ESPN), so no field or plays are shown.
        </p>
      )}
      {showsDetail && (
        <div className="game-detail">
          {behind && <p className="game-note">The play detail may be behind the score above.</p>}
          {drawField && <FootballField situation={situation} names={names} codes={codes} />}
          <PlayList plays={plays} />
          <p className="game-note">
            Play detail can be behind the broadcast and behind the market.
            {Number.isFinite(age) && Math.round(age / 1000) >= 1 ? ` It was last confirmed ${describeAge(age)} ago${age > DELAYED_MS ? ' and is out of date' : ''}.` : ''}
          </p>
        </div>
      )}
    </section>
  )
}

export default function GameView({ game }) {
  const state = useGameReading(game?.gameId ?? null)
  if (!game || state.phase !== 'ready' || !state.reading) return null
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
