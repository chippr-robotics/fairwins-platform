/**
 * OrderTicket (spec 114 slice 5, User Story 4) — say how much, see what it means, then sign.
 *
 * The member types an AMOUNT (dollars to spend; for a sale, shares to sell). From the depth actually on offer
 * the ticket shows the average price, the shares, what they receive if right, the most they can lose, how
 * much of the visible depth the order takes and every fee as its own line — all before any signature, and all
 * from `planForTicket`, which refuses anything that is not a LIVE reading. While the price is not live the
 * ticket says it is waiting for one, shows no figure at all and leaves Review disabled (FR-013).
 *
 * Review is a separate step and cannot be skipped: it names the price LIMIT the signature will carry (the
 * order is fill-and-kill at that limit, so it cannot fill beyond it). On Sign the order is re-planned against
 * the CURRENT reading and, if the reviewed limit no longer reaches the depth, the new figures are shown and
 * nothing is signed (FR-021).
 *
 * Responsible use (FR-028): the amount starts EMPTY, no quick amount is pre-selected, nothing counts down or
 * celebrates, and near certainty is stated as dollars at risk beside dollars to gain.
 *
 * Never stranded (FR-029): when the gateway has no books route no reading can ever be live, so this renders the
 * fixed-price `TradeConfirm` for the same outcome instead — but never while an order is being signed or has
 * just been answered: swapping then would unmount the ticket, let the in-flight order post unseen and offer a
 * fresh confirm for the same outcome.
 *
 * Money (spec 057 FR-011/FR-012): every figure names USDC; the fee lines and the total they add up to are
 * taken from the SAME quote (the signed ceiling), so the column sums; and Polymarket's own fee, which no
 * figure here can include, is named beside every figure it would change unless its rate was read as zero.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useMarketReadings } from '../../hooks/useMarketReadings'
import { usePredictPlanTrade } from '../../hooks/usePredictPlanTrade'
import { readingKey, stateWords } from '../../lib/predict/eventPage'
import { describeAge } from '../../lib/markets/priceReading'
import { booksRouteMissing, subscribeBooksRoute } from '../../lib/markets/routeSupport'
import { centsToPrice } from '../../lib/predict/ticketPlan'
import { nearCertainty, depthStatement, refusalSentence, tickCents, usdc, venueFeeNote, unknownOutcomeText, orderSentText } from '../../lib/predict/ticketStatements'
import { polymarketMarketUrl } from '../../lib/predict/geoblock'
import { feeDisclosureText, restingFeeText, firstTradeText, WRONG_NETWORK_TEXT, NETWORK_FEE_TEXT } from '../../lib/predict/disclosures'
import { formatCents, formatUsd, formatUsdExact, formatShareCount, formatPriceCents, decimalToMicro } from '../../lib/predict/format'
import TrustChip from './TrustChip'
import TradeConfirm from './TradeConfirm'
import OrderReview from './OrderReview'
import './OrderTicket.css'

const POLYMARKET_URL = 'https://polymarket.com'
const QUICK_AMOUNTS = ['10', '25', '50', '100']
const REVIEW_STATES = new Set(['review', 'moved', 'enabling', 'signing', 'submitting'])

/** Re-render once a second while `active`, so an age counts on screen. */
function useSecondTick(active) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return undefined
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [active])
}

/** At most two decimals, digits and one dot only: what is typed is what can be signed. */
function clampAmount(raw) {
  const cleaned = String(raw).replace(/[^\d.]/g, '')
  const dot = cleaned.indexOf('.')
  if (dot === -1) return cleaned.slice(0, 12)
  return (cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '').slice(0, 2)).slice(0, 15)
}

function TicketBody({ market, outcomes, initialTokenId, mode, position, tickSize, minOrderSize, onClose, onHold }) {
  const buy = mode !== 'sell'
  const side = buy ? 'buy' : 'sell'
  const [tokenId, setTokenId] = useState(initialTokenId ?? outcomes[0]?.tokenId)
  const [typed, setTyped] = useState('') // EMPTY by default: no pre-filled amount (FR-028)
  const [ownOpen, setOwnOpen] = useState(false)
  const [ownCents, setOwnCents] = useState('')

  const keys = outcomes.map((o) => readingKey(o.tokenId))
  const readings = useMarketReadings(keys)
  const outcome = outcomes.find((o) => o.tokenId === tokenId) ?? outcomes[0]
  const reading = readings.get(readingKey(outcome.tokenId))
  const tick = reading?.tickSize ?? tickSize ?? null

  // A price the member named (resting order). An unusable one is passed through as such so the plan REFUSES it in
  // words; it is never silently replaced by the market figures.
  const naming = ownOpen && ownCents.trim() !== ''
  const ownPrice = naming ? (centsToPrice(ownCents) ?? 'unusable') : ''

  const plan = usePredictPlanTrade({
    tokenId: outcome.tokenId,
    reading,
    side,
    typed,
    ownPrice,
    tickSize: tickSize ?? undefined,
    minOrderSize: minOrderSize ?? undefined,
    // Stated by the listing, or left out so the SDK asks the venue for this token — never a guessed `false`.
    negRisk: typeof market?.negRisk === 'boolean' ? market.negRisk : undefined,
    // A public description for the progress tracker; never anything signed.
    label: `${buy ? 'Buy' : 'Sell'} ${outcome.name} — ${market?.question ?? ''}`.trim(),
  })
  const { state, view, quote } = plan

  // ── focus: the dialog on open, then the step's heading when the step changes ──
  const dialogRef = useRef(null)
  const stepRef = useRef(null)
  const inReview = REVIEW_STATES.has(state) && plan.reviewed != null
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])
  const wasReview = useRef(false)
  useEffect(() => {
    if (inReview !== wasReview.current) {
      wasReview.current = inReview
      stepRef.current?.focus()
    }
  }, [inReview])

  const busy = state === 'enabling' || state === 'signing' || state === 'submitting'
  useSecondTick(state === 'waiting-price')
  // While an order is in flight or has just been answered, this ticket must stay mounted (see the header).
  const hold = busy || state === 'done' || state === 'unknown' || state === 'error'
  useLayoutEffect(() => {
    onHold?.(hold)
  }, [hold, onHold])

  const ids = { title: useId(), amount: useId(), own: useId(), msg: useId(), ownMsg: useId() }
  const builderBps = plan.fee?.builderTakerFeeBps ?? 0
  const linkOut = market?.polymarketUrl || polymarketMarketUrl(market) || POLYMARKET_URL
  const title = `${buy ? 'Buy' : 'Sell'} ${outcome.name} — ${market?.question}`

  const onKeyDown = (e) => {
    if (e.key === 'Escape' && !busy) {
      e.stopPropagation()
      onClose()
    }
  }

  const held = position?.size ?? null
  const heldHundredths = held != null && decimalToMicro(String(held)) != null ? decimalToMicro(String(held)) - (decimalToMicro(String(held)) % 10_000n) : null
  const maxShares = heldHundredths != null && heldHundredths > 0n ? `${heldHundredths / 1_000_000n}.${String((heldHundredths % 1_000_000n) / 10_000n).padStart(2, '0')}` : null

  const priceOf = (o) => {
    const r = readings.get(readingKey(o.tokenId))
    return r && r.state !== 'unknown' && r.price != null ? r.price : (o.price ?? null)
  }

  // ── what to say about the amount ──
  let message = null
  if (state === 'planning' || state === 'waiting-price') {
    if (view.status === 'invalid') message = 'Enter an amount like 25 or 25.50.'
    else if (view.status === 'refused') message = refusalSentence(view, { side, tick, ownPrice: naming })
  }

  const figures = state === 'planning' && view.status === 'ok'
  const resting = figures && view.kind === 'resting'
  const ceiling = figures ? plan.ceiling : null
  // A buy's fee lines and its total come from ONE quote — the ceiling, which is what the signature can spend.
  const basis = ceiling ?? quote
  const venueNote = venueFeeNote(plan.fee)
  const risk = figures ? nearCertainty(view, quote, ceiling, plan.fee) : null
  const depth = figures ? depthStatement(view) : null
  const canReview = figures && Boolean(quote)

  const waitingAge = reading?.ageMs?.()
  const waitingText = Number.isFinite(waitingAge)
    ? `Waiting for a current price… The last one was confirmed ${describeAge(waitingAge)} ago.`
    : 'Waiting for a current price…'

  return (
    <div className="order-ticket-backdrop">
      <button type="button" className="order-ticket-scrim" aria-label="Dismiss" tabIndex={-1} onClick={busy ? undefined : onClose} />
      <div
        className="order-ticket"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={onKeyDown}
      >
        <div className="order-ticket-header">
          <h3 id={ids.title}>{title}</h3>
          <button type="button" className="order-ticket-close" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>

        {state === 'checking' && (
          <p className="order-ticket-note" role="status">
            Confirming the current fees…
          </p>
        )}

        {state === 'blocked' && (
          <div className="order-ticket-alert" role="alert">
            <p>{plan.reason}</p>
            {plan.canTrade && (
              <button type="button" className="order-ticket-secondary" onClick={plan.retryFee}>
                Try again
              </button>
            )}
          </div>
        )}

        {state === 'geoblocked' && (
          <div className="order-ticket-alert" role="alert">
            <p>
              Prediction-market trading isn&apos;t available in your region
              {plan.geoInfo?.country ? ` (${plan.geoInfo.country})` : ''}. Polymarket sets this restriction, and
              FairWins respects it. You can still view this market and trade it directly on Polymarket.
            </p>
            <a className="order-ticket-link" href={linkOut} target="_blank" rel="noopener noreferrer">
              Trade on Polymarket ↗
            </a>
          </div>
        )}

        {state === 'error' && (
          <div className="order-ticket-alert" role="alert">
            <p>{plan.reason}</p>
            <div className="order-ticket-actions">
              <button type="button" className="order-ticket-secondary" onClick={plan.edit}>
                Back to the ticket
              </button>
              <a className="order-ticket-link" href={linkOut} target="_blank" rel="noopener noreferrer">
                Trade on Polymarket instead ↗
              </a>
            </div>
          </div>
        )}

        {state === 'unknown' && (
          <div className="order-ticket-alert" role="alert">
            <p>{plan.reason}</p>
            <p>{unknownOutcomeText(buy)}</p>
            <div className="order-ticket-actions">
              <a className="order-ticket-link" href={POLYMARKET_URL} target="_blank" rel="noopener noreferrer">
                Check on Polymarket ↗
              </a>
              <button type="button" className="order-ticket-primary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {state === 'done' && (
          <div className="order-ticket-step">
            <p className="order-ticket-note" role="status">
              {orderSentText(plan.result?.status)}
            </p>
            <div className="order-ticket-actions">
              <button type="button" className="order-ticket-primary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}

        {inReview && (
          <OrderReview
            ref={stepRef}
            reviewed={plan.reviewed}
            quote={plan.reviewedQuote}
            ceiling={plan.reviewedCeiling}
            outcomeName={outcome.name}
            state={state}
            notice={plan.notice}
            signerKind={plan.signerKind}
            onWrongNetwork={plan.onWrongNetwork}
            tradingEnabled={plan.tradingEnabled}
            builderBps={builderBps}
            fee={plan.fee}
            onEdit={plan.edit}
            onSign={plan.confirm}
          />
        )}

        {!inReview && (state === 'idle' || state === 'planning' || state === 'waiting-price') && plan.fee && (
          <div className="order-ticket-step">
            <h4 className="order-ticket-step-title" tabIndex={-1} ref={stepRef}>
              {buy ? 'How much do you want to spend?' : 'How many shares do you want to sell?'}
            </h4>

            {plan.notice?.code === 'not-live' && (
              <p className="order-ticket-alert" role="status">
                The price stopped being current, so the review was closed and nothing was signed.
              </p>
            )}
            {plan.notice?.code === 'moved' && (
              <p className="order-ticket-alert" role="status">
                The price moved after you reviewed it, so nothing was signed. Check the figures and review again.
              </p>
            )}

            {buy && outcomes.length > 1 && (
              <div className="order-ticket-outcomes" role="group" aria-label="Outcome">
                {outcomes.map((o, i) => {
                  const r = readings.get(readingKey(o.tokenId))
                  const words = r && r.state !== 'unknown' && r.state !== 'live' ? stateWords(r) : null
                  return (
                    <button
                      key={o.tokenId}
                      type="button"
                      className={'order-ticket-outcome ' + (i === 0 ? 'order-ticket-outcome--yes' : 'order-ticket-outcome--no')}
                      aria-pressed={o.tokenId === outcome.tokenId}
                      onClick={() => setTokenId(o.tokenId)}
                    >
                      <span aria-hidden="true">{o.tokenId === outcome.tokenId ? '✓ ' : ''}</span>
                      {o.name} {formatCents(priceOf(o))}
                      {words && <span className="order-ticket-outcome-state"> · {words}</span>}
                    </button>
                  )
                })}
              </div>
            )}

            {reading && <TrustChip reading={reading} />}

            <label className="order-ticket-field" htmlFor={ids.amount}>
              <span>{buy ? 'Amount to spend (USDC)' : 'Shares to sell'}</span>
              <span className="order-ticket-input-row">
                {buy && <span aria-hidden="true">$</span>}
                <input
                  id={ids.amount}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={typed}
                  onChange={(e) => setTyped(clampAmount(e.target.value))}
                  aria-describedby={message ? ids.msg : undefined}
                  aria-invalid={message ? 'true' : undefined}
                />
              </span>
            </label>

            {buy ? (
              <div className="order-ticket-chips" role="group" aria-label="Quick amounts">
                {QUICK_AMOUNTS.map((n) => (
                  <button key={n} type="button" className="order-ticket-chip" aria-pressed={typed === n} onClick={() => setTyped(n)}>
                    ${n}
                  </button>
                ))}
              </div>
            ) : (
              <div className="order-ticket-chips">
                {maxShares && (
                  <button type="button" className="order-ticket-chip" onClick={() => setTyped(maxShares)}>
                    Max
                  </button>
                )}
                {held != null && (
                  <span className="order-ticket-note">
                    You hold {formatShareCount(String(held))} shares.
                    {heldHundredths != null && decimalToMicro(String(held)) !== heldHundredths
                      ? ' Shares are sold in hundredths, so the last fraction stays with you.'
                      : ''}
                  </span>
                )}
              </div>
            )}

            {message && (
              <p id={ids.msg} className="order-ticket-note order-ticket-refusal" role="status">
                {message}
              </p>
            )}

            {state === 'waiting-price' && (
              <>
                <p className="order-ticket-alert" role="status">
                  {waitingText}
                </p>
                {/* An outage of the price source must never strand a member (FR-029): the venue itself stays one tap away. */}
                <a className="order-ticket-link" href={linkOut} target="_blank" rel="noopener noreferrer">
                  If this does not clear, trade on Polymarket instead ↗
                </a>
              </>
            )}

            {figures && (
              <dl className="order-ticket-figures" aria-label="What this order means">
                <div>
                  <dt>Average price</dt>
                  <dd data-testid="figure-average">{formatPriceCents(view.averagePrice, 'nearest')}</dd>
                </div>
                <div>
                  <dt>{buy ? 'Shares (about)' : 'Shares to sell'}</dt>
                  <dd data-testid="figure-shares">
                    {buy ? '≈ ' : ''}
                    {formatShareCount(buy ? view.shares : (view.sellShares ?? view.shares))}
                  </dd>
                </div>
                {buy ? (
                  <>
                    <div>
                      <dt>You pay at most, before fees</dt>
                      <dd data-testid="figure-pay">{usdc(resting ? formatUsdExact(view.payAtMost) : formatUsd(view.payAtMost, 'up'))}</dd>
                    </div>
                    {basis?.feeLines.map((f) => (
                      <div key={f.label} className="order-ticket-fee-line">
                        <dt>
                          {f.label}
                          {basis.contingent ? ', if it fills at once' : ''}
                        </dt>
                        <dd>+{usdc(formatUsd(f.amount, 'up'))}</dd>
                      </div>
                    ))}
                    <div>
                      <dt>If you are right, you receive{venueNote}</dt>
                      <dd data-testid="figure-payout">{usdc(formatUsd(view.payoutIfRight, 'down'))}</dd>
                    </div>
                    <div className="order-ticket-total">
                      <dt>The most you can lose{venueNote}</dt>
                      <dd data-testid="figure-max-loss">{usdc(formatUsd(basis?.totalCostUnits, 'up'))}</dd>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <dt>Sale value before fees</dt>
                      <dd>{usdc(formatUsd(view.proceeds, 'down'))}</dd>
                    </div>
                    {quote?.feeLines.map((f) => (
                      <div key={f.label} className="order-ticket-fee-line">
                        <dt>{f.label}</dt>
                        <dd>−{usdc(formatUsd(f.amount, 'up'))}</dd>
                      </div>
                    ))}
                    <div className="order-ticket-total">
                      <dt>You receive about{venueNote}</dt>
                      <dd data-testid="figure-payout">{usdc(formatUsd(quote?.netProceedsUnits, 'down'))}</dd>
                    </div>
                  </>
                )}
              </dl>
            )}

            {figures && view.partial && (
              <p className="order-ticket-note" role="status">
                {buy
                  ? `Only ${usdc(formatUsd(view.partial.fillable, 'down'))} of this can be filled at the prices shown.`
                  : `Only ${formatShareCount(view.partial.fillable)} of these shares can be sold at the prices shown.`}
              </p>
            )}
            {figures && !view.partial && view.rounded && view.kind === 'marketable' && (
              <p className="order-ticket-note">
                Amounts are signed in whole {buy ? 'cents' : 'hundredths of a share'}: this order is for{' '}
                {buy ? usdc(formatUsdExact(view.signed.amount)) : `${formatShareCount(view.signed.amount)} shares`}, not what you typed.
              </p>
            )}
            {depth && <p className="order-ticket-note">{depth}</p>}
            {risk && <p className="order-ticket-note order-ticket-risk">{risk}</p>}
            {resting && (
              <p className="order-ticket-note">
                A price you name rests on Polymarket’s book until it is filled or you cancel it, and it may never fill.
                {view.crossesBook ? ' That price is already available, so it would fill at once instead of resting.' : ''}
              </p>
            )}

            <div className="order-ticket-own">
              <button
                type="button"
                className="order-ticket-link-button"
                aria-expanded={ownOpen}
                aria-controls={ids.own}
                onClick={() => setOwnOpen((v) => !v)}
              >
                {ownOpen ? 'Use the market price instead' : 'Set my own price'}
              </button>
              {ownOpen && (
                <div id={ids.own} className="order-ticket-own-body">
                  <label className="order-ticket-field" htmlFor={ids.own + '-input'}>
                    <span>Your price, in cents{tick ? ` (steps of ${tickCents(tick)})` : ''}</span>
                    <span className="order-ticket-input-row">
                      <input
                        id={ids.own + '-input'}
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        value={ownCents}
                        onChange={(e) => setOwnCents(String(e.target.value).replace(/[^\d.]/g, '').slice(0, 6))}
                      />
                      <span aria-hidden="true">¢</span>
                    </span>
                  </label>
                  <p className="order-ticket-note">
                    The order then rests on the book at that price instead of filling at once, and it may never fill.
                  </p>
                </div>
              )}
            </div>

            <p className="order-ticket-note">{NETWORK_FEE_TEXT}</p>
            <p className="order-ticket-note">
              {resting
                ? restingFeeText({ makerBps: plan.fee?.builderMakerFeeBps, takerBps: builderBps, crosses: view.crossesBook, buy })
                : feeDisclosureText(builderBps)}
            </p>
            {plan.onWrongNetwork && (
              <p className="order-ticket-warn" role="status">
                {WRONG_NETWORK_TEXT}
              </p>
            )}
            {!plan.tradingEnabled && <p className="order-ticket-note">{firstTradeText(plan.signerKind)}</p>}

            <div className="order-ticket-actions">
              <button type="button" className="order-ticket-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="order-ticket-primary" disabled={!canReview} onClick={plan.review}>
                Review order
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function OrderTicket(props) {
  const missing = useSyncExternalStore(subscribeBooksRoute, booksRouteMissing, booksRouteMissing)
  const [held, setHeld] = useState(false)
  const { market, outcomes, initialTokenId, mode, onClose } = props
  if (missing && !held) {
    // No books route ⇒ no reading can ever be live: fall back to the fixed-price confirm (FR-029).
    const o = outcomes.find((x) => x.tokenId === initialTokenId) ?? outcomes[0]
    return <TradeConfirm market={market} outcome={o} side={mode === 'sell' ? 'SELL' : 'BUY'} onClose={onClose} />
  }
  return <TicketBody {...props} onHold={setHeld} />
}
