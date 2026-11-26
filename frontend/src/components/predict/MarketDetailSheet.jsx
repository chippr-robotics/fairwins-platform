/**
 * MarketDetailSheet (spec 057 US1) — pick an outcome + side for a market, then open TradeConfirm.
 * A resolved/closed market shows an honest non-tradable state rather than a buy affordance that would
 * fail (edge case). Modal scaffolding mirrors CollectibleDetailSheet.
 */
import { useRef, useEffect, useState } from 'react'
import TradeConfirm from './TradeConfirm'
import { formatPriceCents } from '../../lib/predict/format'
import './MarketDetailSheet.css'

export default function MarketDetailSheet({ market, onClose }) {
  const dialogRef = useRef(null)
  const [pending, setPending] = useState(null) // { outcome, side }

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  if (!market) return null
  const titleId = 'market-detail-title'

  return (
    <div className="market-detail-backdrop">
      <button type="button" className="market-detail-scrim" aria-label="Close" onClick={onClose} />
      <div className="market-detail" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
        <div className="market-detail-header">
          <h3 id={titleId}>{market.question}</h3>
          <button type="button" className="market-detail-close" onClick={onClose}>
            Close
          </button>
        </div>

        {market.category && <p className="market-detail-category">{market.category}</p>}

        {!market.tradable ? (
          <div className="market-detail-closed" role="status">
            <p>This market isn&apos;t open for trading right now.</p>
            <a href={market.polymarketUrl} target="_blank" rel="noopener noreferrer">
              View on Polymarket ↗
            </a>
          </div>
        ) : (
          <ul className="market-detail-outcomes">
            {market.outcomes.map((o) => (
              <li key={o.tokenId} className="market-detail-outcome">
                <span className="market-detail-outcome-name">{o.name}</span>
                <span className="market-detail-outcome-price">{o.price != null ? formatPriceCents(o.price, 'nearest') : 'no price'}</span>
                <span className="market-detail-outcome-actions">
                  <button
                    type="button"
                    className="market-detail-buy"
                    disabled={o.price == null}
                    onClick={() => setPending({ outcome: o, side: 'BUY' })}
                  >
                    Buy
                  </button>
                  <button
                    type="button"
                    className="market-detail-sell"
                    disabled={o.price == null}
                    onClick={() => setPending({ outcome: o, side: 'SELL' })}
                  >
                    Sell
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {pending && (
        <TradeConfirm market={market} outcome={pending.outcome} side={pending.side} onClose={() => setPending(null)} />
      )}
    </div>
  )
}
