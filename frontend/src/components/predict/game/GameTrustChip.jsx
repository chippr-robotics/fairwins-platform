/**
 * GameTrustChip (spec 115) — how current a game's state is, in words. Same classes and the same rules as the
 * price TrustChip (the WORDS carry the state, the dot is decoration, the ticking age is aria-hidden) with
 * game copy: a game is not a "price". An ended game's confirmation is "Up to date" rather than "Live" — a
 * finished game is not live, however recently its final score was confirmed.
 */
import { describeAge } from '../../../lib/markets/priceReading'
import '../TrustChip.css'

const copyFor = (noun) => ({
  live: { label: 'Live', sr: `${noun} information is live`, showAge: false },
  delayed: { label: 'Delayed', sr: `${noun} information is delayed`, showAge: true },
  'last-known': { label: 'Last known', sr: `Showing the last known ${noun.toLowerCase()} information`, showAge: true },
  unknown: { label: 'Unavailable', sr: `${noun} information is unavailable`, showAge: false },
})

/** `noun` is "Game" (default) or "Fight": the words follow what the chip is about. */
export default function GameTrustChip({ reading, ended = false, noun = 'Game' }) {
  const COPY = copyFor(noun)
  const ENDED_LIVE = { label: 'Up to date', sr: `${noun} information is up to date`, showAge: false }
  const key = COPY[reading?.state] ? reading.state : 'unknown'
  // A finished game or fight does not go stale the way a running one does: a final confirmed inside its
  // source's bounds is "Up to date" whether or not that source can ever be live. ("Delayed · 3 s" beside a
  // final result read as if the result itself were late.) Past the bounds it is still "Last known".
  const endedCurrent = ended && (key === 'live' || key === 'delayed')
  const copy = endedCurrent ? ENDED_LIVE : COPY[key]
  const tone = endedCurrent ? 'live' : key
  const age = reading?.ageMs?.()
  // A venue reading's confirmation is its CONNECTION's (a heartbeat seconds ago); "Delayed · 6 s" would read
  // as "the score is 6 s late", which nobody measured. The scoreboard's own line says when it last changed.
  const venueDelayed = key === 'delayed' && reading?.source === 'venue'
  const ageText = copy.showAge && !venueDelayed && Number.isFinite(age) && Math.round(age / 1000) >= 1 ? describeAge(age) : null
  return (
    <span className={`predict-trust-chip predict-trust-chip--${tone}`} role="status" data-testid="game-trust-chip">
      <span className="predict-trust-dot" aria-hidden="true" />
      <span className="predict-trust-sr">{copy.sr}</span>
      <span aria-hidden="true">
        {copy.label}
        {ageText ? ` · ${ageText}` : ''}
      </span>
    </span>
  )
}
