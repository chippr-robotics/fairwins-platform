/**
 * PositionsList (spec 057 US2) — the connected wallet's Polymarket positions, each closable via a
 * SELL order through TradeConfirm (same builder-code path, honest fees) — or, when the panel passes `onSell`
 * (a gateway with live readings), through the amount-first ticket in sell mode. A position with no live bid
 * shows an explicit "no bid" state rather than a Sell affordance that would fail (illiquid edge case).
 *
 * The list refreshes ON ITS OWN (usePredictPositions polls while the tab is visible; the panel also bumps
 * `refreshSignal` when an order of the member's changes state) — there is no Refresh button. A background
 * refresh that fails keeps the last good list and says it could not be refreshed; it never empties it.
 */
import { useEffect, useRef, useState } from 'react'
import { usePredictPositions } from '../../hooks/usePredictPortfolio'
import TradeConfirm from './TradeConfirm'
import './PositionsList.css'

export default function PositionsList({ onSell, refreshSignal = 0 } = {}) {
  const { status, positions, refresh, stale } = usePredictPositions()
  const [selling, setSelling] = useState(null) // { market, outcome }

  // The panel bumps `refreshSignal` when the amount-first ticket it opened for a position closes, so the list
  // reflects what was sold — the same refresh the fixed-price confirm triggers on close.
  const lastSignal = useRef(refreshSignal)
  useEffect(() => {
    if (lastSignal.current !== refreshSignal) {
      lastSignal.current = refreshSignal
      refresh()
    }
  }, [refreshSignal, refresh])

  // Hidden entirely when unsupported/disconnected — the parent panel handles those states.
  if (status === 'unsupported' || status === 'disconnected') return null

  return (
    <section className="predict-positions" aria-label="Your positions">
      <div className="predict-positions-header">
        <h4>Your positions</h4>
      </div>
      {stale && (
        <p className="predict-positions-status" role="status">
          Couldn&apos;t refresh your positions just now. This is the last list we read; it updates itself when the
          connection returns.
        </p>
      )}

      {status === 'loading' ? (
        <p className="predict-positions-status" role="status">
          Loading your positions…
        </p>
      ) : status === 'degraded' ? (
        <p className="predict-positions-status" role="status">
          Position data is temporarily unavailable. Your positions are safe on-chain.
        </p>
      ) : status === 'empty' ? (
        <p className="predict-positions-status">You don&apos;t hold any Polymarket positions on this network yet.</p>
      ) : (
        <ul className="predict-positions-list">
          {positions.map((p) => {
            const hasBid = p.bestBid?.amount != null
            return (
              <li key={p.tokenId} className="predict-position">
                <span className="predict-position-outcome">{p.outcome || 'Outcome'}</span>
                <span className="predict-position-size">{p.size} shares</span>
                <span className="predict-position-value">
                  {hasBid ? `bid ${p.bestBid.amount} USDC` : 'no bid'}
                </span>
                <button
                  type="button"
                  className="predict-position-sell"
                  disabled={!hasBid}
                  onClick={() =>
                    onSell
                      ? onSell(p)
                      : setSelling({
                          market: { question: `${p.outcome || 'Outcome'} position`, polymarketUrl: 'https://polymarket.com' },
                          outcome: { name: p.outcome || 'Outcome', tokenId: p.tokenId, price: p.bestBid.amount },
                        })
                  }
                >
                  Sell
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {selling && (
        <TradeConfirm
          market={selling.market}
          outcome={selling.outcome}
          side="SELL"
          onClose={() => {
            setSelling(null)
            refresh()
          }}
        />
      )}
    </section>
  )
}
