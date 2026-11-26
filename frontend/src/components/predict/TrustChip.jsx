/**
 * TrustChip (spec 114) — says how fresh a price is, in words. The leading dot is decoration; the WORDS
 * carry the state (never colour alone). The ticking age is aria-hidden so a screen reader is not told
 * about every second; the accessible name changes only when the STATE changes.
 */
import { useEffect, useState } from 'react'
import { describeAge } from '../../lib/markets/priceReading'
import './TrustChip.css'

const COPY = {
  live: { label: 'Live', sr: 'Prices are live', showAge: false },
  delayed: { label: 'Delayed', sr: 'Prices are delayed', showAge: true },
  'last-known': { label: 'Last known', sr: 'Showing the last known prices', showAge: true },
  unknown: { label: 'Unavailable', sr: 'Prices are unavailable', showAge: false },
}

export default function TrustChip({ reading, state, ageMs }) {
  const resolved = reading?.state ?? state
  const key = COPY[resolved] ? resolved : 'unknown'
  const copy = COPY[key]
  const [, setTick] = useState(0)
  const ticking = Boolean(reading) && copy.showAge
  // Re-render once a second while an age is shown so it counts on screen (aria-hidden, so silent).
  useEffect(() => {
    if (!ticking) return undefined
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [ticking])
  const age = reading ? reading.ageMs?.() : ageMs
  const ageText = copy.showAge && Number.isFinite(age) ? describeAge(age) : null

  return (
    <span className={`predict-trust-chip predict-trust-chip--${key}`} role="status">
      <span className="predict-trust-dot" aria-hidden="true" />
      <span className="predict-trust-sr">{copy.sr}</span>
      <span aria-hidden="true">
        {copy.label}
        {ageText ? ` · ${ageText}` : ''}
      </span>
    </span>
  )
}
