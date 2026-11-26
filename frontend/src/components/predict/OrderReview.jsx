/**
 * OrderReview (spec 114 slice 5, FR-018/FR-020/FR-021) — the step between "I entered an amount" and "I sign".
 * Nothing has been signed when this is on screen. It repeats the figures of the frozen plan, names the PRICE
 * LIMIT the signature will carry and says what that limit guarantees, says what happens to whatever is not
 * filled, and states in one sentence who holds what (custody is unchanged).
 *
 * Every number here is the plan's (`reviewed`), and the pay figure is the order's real maker amount, so what
 * is shown is what is signed. The fee lines come from `computeCostForPlan`: the builder fee is its own line,
 * the venue's fee is disclosed in words, and a zero fee draws no line.
 */
import { forwardRef } from 'react'
import { feeDisclosureText, firstTradeText, WRONG_NETWORK_TEXT, NETWORK_FEE_TEXT, CUSTODY_TEXT } from '../../lib/predict/disclosures'
import { formatUsd, formatUsdExact, formatShareCount, formatPriceCents } from '../../lib/predict/format'
import { nearCertainty, depthStatement } from '../../lib/predict/ticketStatements'

const BUSY_LABEL = { enabling: 'Enabling…', signing: 'Signing…', submitting: 'Submitting…' }

const OrderReview = forwardRef(function OrderReview(
  { reviewed, quote, ceiling, outcomeName, state, notice, signerKind, onWrongNetwork, tradingEnabled, builderBps, onEdit, onSign },
  headingRef,
) {
  if (!reviewed) return null
  const buy = reviewed.side === 'buy'
  const resting = reviewed.kind === 'resting'
  const busy = state === 'enabling' || state === 'signing' || state === 'submitting'
  const limit = formatPriceCents(reviewed.limitPrice, buy ? 'up' : 'down')
  const exact = (v) => (resting ? formatUsdExact(v) : formatUsd(v, 'up'))
  const risk = nearCertainty(reviewed, quote, ceiling)
  const depth = depthStatement(reviewed)

  return (
    <div className="order-ticket-step order-review">
      <h4 className="order-ticket-step-title" tabIndex={-1} ref={headingRef}>
        Review your order
      </h4>
      <p className="order-ticket-lede">Nothing has been signed yet.</p>

      {state === 'moved' && notice?.code === 'moved' && (
        <p className="order-ticket-alert" role="alert">
          The price moved after you reviewed it, so nothing was signed. The figures below are the new ones — look them
          over before you sign.
        </p>
      )}

      <dl className="order-ticket-figures">
        {buy ? (
          <>
            <div>
              <dt>You pay at most</dt>
              <dd data-testid="review-pay">{exact(reviewed.payAtMost)}</dd>
            </div>
            {quote?.feeLines.map((f) => (
              <div key={f.label} className="order-ticket-fee-line">
                <dt>{f.label}</dt>
                <dd>+{formatUsd(f.amount, 'up')}</dd>
              </div>
            ))}
            <div className="order-ticket-total">
              <dt>The most you can lose</dt>
              <dd data-testid="review-max-loss">{formatUsd(ceiling?.totalCostUnits ?? quote?.totalCostUnits, 'up')}</dd>
            </div>
            <div>
              <dt>You get about</dt>
              <dd>
                {formatShareCount(reviewed.shares)} {outcomeName} shares
              </dd>
            </div>
            <div>
              <dt>If you are right</dt>
              <dd>{formatUsd(reviewed.payoutIfRight, 'down')}</dd>
            </div>
            <div>
              <dt>If you are wrong</dt>
              <dd>$0.00</dd>
            </div>
          </>
        ) : (
          <>
            <div>
              <dt>You sell up to</dt>
              <dd data-testid="review-pay">
                {formatShareCount(reviewed.sellShares ?? reviewed.shares)} {outcomeName} shares
              </dd>
            </div>
            <div>
              <dt>Sale value before fees</dt>
              <dd>{formatUsd(reviewed.proceeds, 'down')}</dd>
            </div>
            {quote?.feeLines.map((f) => (
              <div key={f.label} className="order-ticket-fee-line">
                <dt>{f.label}</dt>
                <dd>−{formatUsd(f.amount, 'up')}</dd>
              </div>
            ))}
            <div className="order-ticket-total">
              <dt>You receive about (before Polymarket’s fee)</dt>
              <dd>{formatUsd(quote?.netProceedsUnits, 'down')}</dd>
            </div>
          </>
        )}
        <div>
          <dt>{buy ? 'Average price' : 'Average price you get'}</dt>
          <dd>{formatPriceCents(reviewed.averagePrice, 'nearest')}</dd>
        </div>
      </dl>

      {reviewed.partial && (
        <p className="order-ticket-note" role="status">
          This order is for {buy ? formatUsd(reviewed.partial.fillable, 'down') : `${formatShareCount(reviewed.partial.fillable)} shares`}{' '}
          — the part of what you entered that has {buy ? 'an offer' : 'a bid'} at the prices shown.
        </p>
      )}
      {depth && <p className="order-ticket-note">{depth}</p>}
      {risk && <p className="order-ticket-note order-ticket-risk">{risk}</p>}

      <div className="order-ticket-limit">
        {resting ? (
          <>
            <p>
              <strong>Your price: {limit}.</strong> This order rests on Polymarket’s book until it is filled or you cancel
              it, and it may never fill. Nothing is charged for the part that has not filled.
            </p>
            {reviewed.crossesBook && (
              <p>
                That price is already {buy ? 'on offer' : 'bid'}, so this will fill at once at the best prices instead of
                resting — and the builder fee applies to that fill.
              </p>
            )}
          </>
        ) : (
          <p>
            <strong>Price limit: {limit}.</strong> This order cannot fill {buy ? 'above' : 'below'} {limit} a share.
            Whatever is not filled is cancelled and not charged.
          </p>
        )}
      </div>

      <p className="order-ticket-note">{NETWORK_FEE_TEXT}</p>
      <p className="order-ticket-note">{CUSTODY_TEXT}</p>
      <p className="order-ticket-note">{feeDisclosureText(builderBps)}</p>
      {onWrongNetwork && (
        <p className="order-ticket-warn" role="status">
          {WRONG_NETWORK_TEXT}
        </p>
      )}
      {!tradingEnabled && !busy && <p className="order-ticket-note">{firstTradeText(signerKind)}</p>}

      <div className="order-ticket-actions">
        <button type="button" className="order-ticket-secondary" onClick={onEdit} disabled={busy}>
          Edit
        </button>
        <button type="button" className="order-ticket-primary" onClick={onSign} disabled={busy}>
          {busy ? BUSY_LABEL[state] : resting ? 'Sign and place order (no gas)' : `Sign ${buy ? 'buy' : 'sell'} (no gas)`}
        </button>
      </div>
    </div>
  )
})

export default OrderReview
