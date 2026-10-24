/**
 * TradeConfirm (spec 057 US1) — the honest confirmation surface for a Predict buy/sell.
 *
 * Shows the live fee breakdown before any signature (FR-003/FR-010): the share price, Polymarket's
 * platform fee, and — crucially — FairWins' BUILDER FEE as its own labelled line, honestly disclosed
 * as a REAL cost (not free, the divergence from Collect's referral). Maker orders show no fee. Never
 * lets the member sign when the fee schedule couldn't be confirmed (FR-010). Modal scaffolding mirrors
 * SellConfirm.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits } from '../../lib/evm/units'
import { usePredictTrade } from '../../hooks/usePredictTrade'
import { bpsToPct } from '../../lib/predict/builderFee'
import { polymarketMarketUrl } from '../../lib/predict/geoblock'
import './TradeConfirm.css'

const POLYMARKET_URL = 'https://polymarket.com'

export default function TradeConfirm({ market, outcome, side = 'BUY', onClose }) {
  const trade = usePredictTrade()
  const [amount, setAmount] = useState('') // number of shares
  const dialogRef = useRef(null)

  useEffect(() => {
    if (outcome?.tokenId) trade.loadFee(outcome.tokenId)
    dialogRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome?.tokenId])

  const params = useMemo(
    () => ({ tokenId: outcome?.tokenId, side, price: outcome?.price || '0', size: amount || '0', isMaker: false }),
    [outcome, side, amount]
  )
  const quote = useMemo(() => (trade.status === 'ready' && Number(amount) > 0 ? trade.preview(params) : null), [trade, params, amount])

  const sizeValid = Number(amount) > 0 && Number(outcome?.price) > 0
  const canSign = trade.status === 'ready' && sizeValid && quote
  const busy = trade.status === 'signing' || trade.status === 'submitting' || trade.status === 'enabling'
  const builderBps = trade.fee?.builderTakerFeeBps ?? 0
  const isBuy = side === 'BUY'

  const titleId = 'trade-confirm-title'
  return (
    <div className="trade-confirm-backdrop">
      <button type="button" className="trade-confirm-scrim" aria-label="Close" onClick={onClose} />
      <div className="trade-confirm" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
        <div className="trade-confirm-header">
          <h3 id={titleId}>
            {isBuy ? 'Buy' : 'Sell'} {outcome?.name} — {market?.question}
          </h3>
          <button type="button" className="trade-confirm-close" onClick={onClose}>
            Close
          </button>
        </div>

        {trade.status === 'checking' && (
          <p className="trade-confirm-status" role="status">
            Confirming the current fees…
          </p>
        )}

        {trade.status === 'blocked' && (
          <div className="trade-confirm-blocked" role="alert">
            <p>{trade.reason}</p>
            {trade.canTrade && outcome?.tokenId && (
              <button type="button" onClick={() => trade.loadFee(outcome.tokenId)}>
                Try again
              </button>
            )}
          </div>
        )}

        {trade.status === 'geoblocked' && (
          <div className="trade-confirm-blocked" role="alert">
            <p>
              Prediction-market trading isn&apos;t available in your region
              {trade.geoInfo?.country ? ` (${trade.geoInfo.country})` : ''}. Polymarket sets this restriction,
              and FairWins respects it. You can still view this market and trade it directly on Polymarket.
            </p>
            <a
              className="trade-confirm-polymarket-link"
              href={polymarketMarketUrl(market)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Trade on Polymarket ↗
            </a>
          </div>
        )}

        {(trade.status === 'ready' || busy) && (
          <>
            {trade.onWrongNetwork && (
              <p className="trade-confirm-warn" role="status">
                You&apos;ll be asked to switch your wallet to Polygon before signing.
              </p>
            )}

            <label className="trade-confirm-field">
              <span>Shares</span>
              <span className="trade-confirm-amount-row">
                <input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label={`Number of ${outcome?.name} shares to ${isBuy ? 'buy' : 'sell'}`}
                  disabled={busy}
                />
                <span className="trade-confirm-price" aria-label="Price per share">
                  @ {outcome?.price} USDC
                </span>
              </span>
            </label>

            {quote && (
              <dl className="trade-confirm-breakdown">
                <div>
                  <dt>{isBuy ? 'Cost' : 'Proceeds'} before fees</dt>
                  <dd>{formatUnits(quote.notionalUnits, 6)} USDC</dd>
                </div>
                {quote.feeLines.map((f) => (
                  <div key={f.label} className={f.label.includes('builder') ? 'trade-confirm-builder-line' : undefined}>
                    <dt>
                      {f.label}
                      {f.estimated ? ' (est.)' : ''}
                    </dt>
                    <dd>
                      {isBuy ? '+' : '−'}
                      {f.amount} {f.currency}
                    </dd>
                  </div>
                ))}
                <div className="trade-confirm-total">
                  <dt>{isBuy ? 'Subtotal (incl. builder fee)' : 'You receive (before Polymarket fee)'}</dt>
                  <dd data-testid="trade-total">
                    {formatUnits(isBuy ? quote.totalCostUnits : quote.netProceedsUnits, 6)} USDC
                  </dd>
                </div>
              </dl>
            )}

            {/* Honest disclosure — the builder fee IS a cost (the divergence from Collect), and
                Polymarket's own taker fee is separate and charged at execution (not fabricated here). */}
            <p className="trade-confirm-fee-note">
              FairWins charges a {bpsToPct(builderBps)} builder fee on this trade, included above.
              Polymarket also charges its own taker fee, set by the market and applied at execution.
            </p>

            {!trade.tradingEnabled && !busy && (
              <p className="trade-confirm-fee-note">
                {trade.signerKind === 'passkey'
                  ? 'First trade only: you’ll confirm one transaction letting Polymarket’s exchange settle your trades (network fee applies unless sponsored), then sign once (no gas) to enable trading on this device.'
                  : 'First trade only: you’ll sign once (no gas) to enable trading on this device, then confirm the order.'}
              </p>
            )}

            <div className="trade-confirm-actions">
              <button type="button" className="trade-confirm-cancel" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="trade-confirm-submit"
                disabled={!canSign || busy}
                onClick={() => trade.submit(params, { negRisk: Boolean(market?.negRisk) })}
              >
                {trade.status === 'enabling'
                  ? 'Enabling…'
                  : busy
                    ? 'Submitting…'
                    : `Sign ${isBuy ? 'buy' : 'sell'} (no gas)`}
              </button>
            </div>
          </>
        )}

        {trade.status === 'done' && (
          <p className="trade-confirm-done" role="status">
            Order submitted. Your position will update once it fills.
          </p>
        )}

        {trade.status === 'error' && (
          <div className="trade-confirm-error" role="alert">
            <p>{trade.reason}</p>
            <a href={market?.polymarketUrl || POLYMARKET_URL} target="_blank" rel="noopener noreferrer">
              Trade on Polymarket instead ↗
            </a>
          </div>
        )}
      </div>
    </div>
  )
}
