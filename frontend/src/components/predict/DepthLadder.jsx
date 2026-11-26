/**
 * DepthLadder (spec 114, FR-007) — the size on offer at the nearest prices, both sides, for the SELECTED
 * outcome. A real table: asks above bids, five levels each, price in cents and size in shares.
 *
 * Honest by construction:
 *  - an empty side says "Nothing on offer" (asks) / "No bids" — never a zero row, which would read as a
 *    price of nothing;
 *  - a reading that is not live is shown WITH the words "as of N s ago" and in the secondary text colour —
 *    never just dimmed, because a dimmed number says nothing a member can act on;
 *  - an `unknown` reading (or one that never carried a book) says "Depth is unavailable right now" and
 *    draws no table at all.
 */
import { useEffect, useState } from 'react'
import { describeAge } from '../../lib/markets/priceReading'
import { formatLevelCents, formatShares } from '../../lib/predict/format'
import './DepthLadder.css'

export const LADDER_LEVELS = 5

function Level({ side, level }) {
  const [price, size] = Array.isArray(level) ? level : []
  return (
    <tr>
      <th scope="row">{side}</th>
      <td>{formatLevelCents(price)}</td>
      <td>{formatShares(size)}</td>
    </tr>
  )
}

export default function DepthLadder({ reading, label = 'this outcome' }) {
  const hasBook = Boolean(reading) && reading.state !== 'unknown' && Array.isArray(reading.bids) && Array.isArray(reading.asks)
  const live = hasBook && reading.state === 'live'
  const [, setTick] = useState(0)
  // Re-render once a second while an age is shown, so "as of N s ago" counts on screen.
  useEffect(() => {
    if (!hasBook || live) return undefined
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [hasBook, live])

  if (!hasBook) {
    return (
      <div className="event-depth">
        <p className="event-depth-note" role="status">
          Depth is unavailable right now.
        </p>
      </div>
    )
  }

  const asks = reading.asks.slice(0, LADDER_LEVELS).reverse() // furthest first, so the best ask sits against the best bid
  const bids = reading.bids.slice(0, LADDER_LEVELS)
  const age = reading.ageMs?.()

  return (
    <div className={'event-depth' + (live ? '' : ' event-depth--stale')}>
      {!live && (
        <p className="event-depth-note" role="status">
          {reading.state === 'delayed' ? 'Delayed' : 'Last known'} — as of {Number.isFinite(age) ? describeAge(age) : 'an unknown time'} ago, not live.
        </p>
      )}
      <table className="event-depth-table">
        <caption>Depth for {label}: the nearest {LADDER_LEVELS} asking and bidding prices</caption>
        <thead>
          <tr>
            <th scope="col">Side</th>
            <th scope="col">Price</th>
            <th scope="col">Shares</th>
          </tr>
        </thead>
        <tbody>
          {asks.length === 0 ? (
            <tr>
              <td colSpan={3}>Nothing on offer</td>
            </tr>
          ) : (
            asks.map((l, i) => <Level key={`a${i}`} side="Ask" level={l} />)
          )}
        </tbody>
        <tbody>
          {bids.length === 0 ? (
            <tr>
              <td colSpan={3}>No bids</td>
            </tr>
          ) : (
            bids.map((l, i) => <Level key={`b${i}`} side="Bid" level={l} />)
          )}
        </tbody>
      </table>
    </div>
  )
}
