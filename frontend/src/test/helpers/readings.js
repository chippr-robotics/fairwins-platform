// PriceReading builders for the Predict event-page tests (spec 114). Ages are on the gateway's clock via the
// stamp, exactly as the feed builds them, so a "delayed" reading here is delayed for the same reason it is
// in the app — not because a test said so.
import { classify } from '../../lib/markets/priceReading'
import { stamp } from '../../lib/markets/serverClock'

const SERVER_NOW = Date.parse('2026-11-26T02:10:00.000Z')
const iso = (ms) => new Date(ms).toISOString()

/** age ≤ 5 s → live, ≤ 30 s → delayed, beyond → last-known (the seam's own bounds). */
export const AGES = { live: 1000, delayed: 12_000, 'last-known': 90_000 }

export function mkReading(state, price = '0.5', { bids, asks, ageMs } = {}) {
  if (state === 'unknown') return classify({ price: null })
  const age = ageMs ?? AGES[state]
  return classify({
    price,
    bids: bids ?? [['0.49', '100']],
    asks: asks ?? [['0.51', '100']],
    stamp: stamp({ confirmedAt: iso(SERVER_NOW - age), serverNow: iso(SERVER_NOW) }),
  })
}
