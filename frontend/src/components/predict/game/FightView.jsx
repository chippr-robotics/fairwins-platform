/**
 * FightView (spec 115 slice 3) — a fight beside its market: the two fighters, weight class, scheduled rounds,
 * status, and while it is on the round and clock; the source's per-round figures as tables; the result.
 *
 * Information beside the market, like the game view: nothing to press that changes anything, no comparison,
 * no "leading", no call to action (FR-010/011/018). Names only — no corners, photos or flags.
 *
 *  - nothing is drawn until the fight route answers, and NOTHING when it is off, absent or paused (FR-013,
 *    FR-020) — never a scoreboard built from fighter names;
 *  - each of `card` / `figures` that is `unreadable` is named (label from the envelope) and its fields are
 *    absent; `not-matched` / `not-covered` / `off` show what there is, with no apology;
 *  - the venue's word is attributed (it has been seen to say "Canceled" for a fight that was fought), and when
 *    the leading source and the venue disagree one line says so;
 *  - wherever figures show: they are the source's own counts and can be behind the broadcast and the market.
 */
import { useFightReading } from '../../../hooks/useFightReading'
import { listingFighters } from '../../../lib/sports/fightFeed'
import { formatStart } from '../../../lib/sports/describe'
import { detailAgeMs } from '../../../lib/sports/gameReading'
import { describeAge } from '../../../lib/markets/priceReading'
import GameTrustChip from './GameTrustChip'
import FightFigures from './FightFigures'
import FightResult from './FightResult'
import './GameView.css'

const sourceName = (sources, key, fallback) => sources?.[key]?.label || fallback
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

function statusLine(r, game) {
  const bits = []
  if (r.status === 'scheduled') {
    const start = formatStart(game?.startTime)
    bits.push(start ? `Not started · starts ${start}` : 'Not started')
  } else if (r.status === 'in-progress') {
    bits.push('In progress')
    if (r.round != null) bits.push(r.scheduledRounds ? `Round ${r.round} of ${r.scheduledRounds}` : `Round ${r.round}`)
    if (r.clock) bits.push(r.clock)
  } else if (r.status === 'ended') bits.push('Ended')
  else if (r.status === 'cancelled') bits.push('Listed as cancelled')
  else if (r.status === 'other') bits.push(r.statusText)
  else bits.push('Status not reported')
  return bits.join(' · ')
}

function sourceLine(r, sources, clock) {
  if (r.source === 'venue') {
    const feed = sources?.venue?.label ? `${sources.venue.label}'s feed` : "the venue's feed"
    const base = `From ${feed}, which updates about once a minute.`
    const age = r.changedAt != null && clock ? detailAgeMs(r.changedAt, clock.serverNow, clock.receivedAt, clock.now) : null
    return Number.isFinite(age) && Math.round(age / 1000) >= 1 ? `${base} Last changed ${describeAge(age)} ago.` : base
  }
  if (r.source === 'figures') return `From ${sourceName(sources, 'figures', 'the fight-statistics source')}.`
  return `From ${sourceName(sources, 'card', 'the fight-card source')}.`
}

const STATUS_WORDS = { scheduled: 'not started', 'in-progress': 'in progress', ended: 'ended', cancelled: 'cancelled' }

/** One line when the venue's word differs from the leading source's; null when they agree or it has no word. */
function disagreement(r, sources, clock) {
  const v = r.venue
  if (!v || !v.status || v.status === r.status) return null
  const feed = sources?.venue?.label ? `${sources.venue.label}'s feed` : "The venue's feed"
  const words = STATUS_WORDS[v.status] ?? v.statusText
  if (!words) return null
  const age = v.changedAt != null && clock ? detailAgeMs(v.changedAt, clock.serverNow, clock.receivedAt, clock.now) : null
  const when = Number.isFinite(age) && Math.round(age / 1000) >= 1 ? ` (last changed ${describeAge(age)} ago)` : ''
  return `${cap(feed)} lists this fight as ${words}${when}, which differs from the source above.`
}

/** Presentational: everything shown is in its props, so every state is testable without a poller. */
export function FightViewBody({ game, reading, sources, serverNow, receivedAt, now }) {
  const clock = { serverNow, receivedAt, now }
  const known = reading && reading.state !== 'unknown'
  const listing = listingFighters(game)
  const names = known ? reading.fighters.map((f, i) => f.name ?? listing[i] ?? null) : listing
  const unread = (key) => sources?.[key]?.state === 'unreadable'
  const hasFigures = known && (reading.rounds || reading.overall)
  const ended = known && reading.status === 'ended'
  const disagree = known ? disagreement(reading, sources, clock) : null
  const detailBits = known ? [reading.weightClass, reading.scheduledRounds ? `${reading.scheduledRounds} rounds` : null].filter(Boolean) : []

  return (
    <section className="game-view fight-view" aria-labelledby="fight-view-title" data-testid="fight-view">
      <h3 id="fight-view-title">Fight</h3>
      <div className="game-scoreboard">
        <div className="game-scoreboard-head">
          <p className="game-status" data-testid="fight-status">
            {known ? statusLine(reading, game) : 'Fight information is not available right now'}
          </p>
          {reading && <GameTrustChip reading={reading} ended={ended} noun="Fight" />}
        </div>
        {known && (
          <p className="game-source" data-testid="fight-source">
            {sourceLine(reading, sources, clock)}
          </p>
        )}
        <p className="fight-names" data-testid="fight-names">
          <span className="fight-name">{names[0] ?? 'Fighter not named'}</span>{' '}
          <span className="fight-vs">vs</span>{' '}
          <span className="fight-name">{names[1] ?? 'Fighter not named'}</span>
        </p>
        {detailBits.length > 0 && <p className="game-note" data-testid="fight-meta">{detailBits.join(' · ')}</p>}
      </div>

      {unread('card') && (
        <p className="game-note" role="status">
          {`Fight details could not be read from ${sourceName(sources, 'card', 'the fight-card source')}, so the round and clock may be missing.`}
        </p>
      )}
      {unread('figures') && (
        <p className="game-note" role="status">
          {`Round figures could not be read from ${sourceName(sources, 'figures', 'the fight-statistics source')}, so none are shown.`}
        </p>
      )}
      {unread('venue') && (
        <p className="game-note" role="status">
          {`${cap(sources?.venue?.label ? `${sources.venue.label}'s feed` : "the venue's feed")} could not be read just now.`}
        </p>
      )}
      {disagree && (
        <p className="game-note" data-testid="fight-disagree">
          {disagree}
        </p>
      )}

      {known && reading.result && <FightResult result={reading.result} names={names} sources={sources} />}

      {hasFigures && (
        <div className="game-detail">
          <FightFigures names={names} rounds={reading.rounds} overall={reading.overall} scheduledRounds={reading.scheduledRounds} />
          <p className="game-note">These are the source's own counts. They can be behind the broadcast and behind the market.</p>
        </div>
      )}
    </section>
  )
}

export default function FightView({ game }) {
  const state = useFightReading(game)
  if (!game || state.phase !== 'ready' || !state.reading) return null
  return (
    <FightViewBody
      game={game}
      reading={state.reading}
      sources={state.sources}
      serverNow={state.serverNow}
      receivedAt={state.receivedAt}
      now={state.now}
    />
  )
}
