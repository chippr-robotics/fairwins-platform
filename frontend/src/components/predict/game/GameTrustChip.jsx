/**
 * GameTrustChip (spec 115) — how current a game's state is, in words. Same classes and the same rules as the
 * price TrustChip (the WORDS carry the state, the dot is decoration, the ticking age is aria-hidden) with
 * game copy: a game is not a "price". An ended game's confirmation is "Up to date" rather than "Live" — a
 * finished game is not live, however recently its final score was confirmed.
 */
import { describeAge } from '../../../lib/markets/priceReading'
import '../TrustChip.css'

const COPY = {
  live: { label: 'Live', sr: 'Game information is live', showAge: false },
  delayed: { label: 'Delayed', sr: 'Game information is delayed', showAge: true },
  'last-known': { label: 'Last known', sr: 'Showing the last known game information', showAge: true },
  unknown: { label: 'Unavailable', sr: 'Game information is unavailable', showAge: false },
}
const ENDED_LIVE = { label: 'Up to date', sr: 'Game information is up to date', showAge: false }

export default function GameTrustChip({ reading, ended = false }) {
  const key = COPY[reading?.state] ? reading.state : 'unknown'
  const copy = key === 'live' && ended ? ENDED_LIVE : COPY[key]
  const age = reading?.ageMs?.()
  const ageText = copy.showAge && Number.isFinite(age) && Math.round(age / 1000) >= 1 ? describeAge(age) : null
  return (
    <span className={`predict-trust-chip predict-trust-chip--${key}`} role="status" data-testid="game-trust-chip">
      <span className="predict-trust-dot" aria-hidden="true" />
      <span className="predict-trust-sr">{copy.sr}</span>
      <span aria-hidden="true">
        {copy.label}
        {ageText ? ` · ${ageText}` : ''}
      </span>
    </span>
  )
}
