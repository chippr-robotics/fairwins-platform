/**
 * BridgeQuoteCard (spec 067, US1 — T079/T080) — the single honest quote a member reads
 * before signing a bridge.
 *
 * Purely presentational, in the register of the Earn/Stake fact lists: it renders the
 * `BridgeQuote` built by `lib/bridge/acrossQuotes.js` and derives nothing. Every figure
 * shown here came from Across or from the fee split — this component never adds, infers,
 * or rounds a cost into existence.
 *
 * The rules it exists to keep:
 *   - FR-007: the amount that will ARRIVE, then every cost on its OWN labelled line with
 *     an InfoTip, then the total, then an arrival estimate. A line whose figure the
 *     upstream did not give us reads "Not available" — never 0.00 (a fabricated zero is
 *     the exact dishonesty this feature must not ship).
 *   - FR-008: the quote's validity window is visible, and once it elapses the card says
 *     so and offers a refresh. The confirm control is the CALLER's, gated on the same
 *     `stale` flag it passes in, so there is one source of truth for staleness.
 *   - FR-012: a destination network the member has no gas coin on is disclosed here,
 *     before signature, and ONLY when the balance was actually read as zero
 *     (`destinationGasWarning === true`). Unknown stays silent rather than warning about
 *     a state we did not observe. v1's route cannot deliver destination gas as part of
 *     the transfer — `bridgeWithFee` takes no such parameter — so there is no option to
 *     present, and the copy says what the member must do instead.
 *   - FR-014: Across is named on the quote itself, not only in the small print.
 */
import { useId } from 'react'
import { formatUnits } from '../../lib/evm/units'
import InfoTip from '../ui/InfoTip'
import { BRIDGE_SETTLEMENT, BRIDGE_TIPS, BRIDGE_UNAVAILABLE } from '../../lib/bridge/bridgeCopy'
import { bpsToPercent } from '../../lib/fees/feeQuote'
import './Bridge.css'

/** Base units → a readable amount. `null` decimals means we cannot format it honestly. */
function fmtAmount(raw, decimals, symbol) {
  if (raw == null || decimals == null) return null
  const value = Number(formatUnits(BigInt(raw), decimals))
  return `${value.toLocaleString('en-US', { maximumFractionDigits: Math.min(6, decimals) })} ${symbol}`
}

/**
 * Across's own estimate, in plain words. Null (no estimate) says so rather than
 * inventing a duration — an arrival time is a promise, and we only repeat one we were
 * given.
 */
function arrivalLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Not available'
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(seconds / 3600)
  return `about ${hours} hour${hours === 1 ? '' : 's'}`
}

/** Whole seconds left in the validity window, for the countdown next to the refresh. */
const secondsLeft = (ms) => Math.max(0, Math.ceil((Number(ms) || 0) / 1000))

export default function BridgeQuoteCard({
  quote,
  symbol,
  decimals,
  stale = false,
  msRemaining = 0,
  onRefresh,
  refreshing = false,
  destinationNetworkName = null,
  destinationNativeSymbol = null,
}) {
  const titleId = useId()
  if (!quote) return null

  const places = decimals ?? quote.decimals ?? null
  const unit = symbol || quote.tokenSymbol || ''
  const received = fmtAmount(quote.outputAmount, places, unit)
  const total = fmtAmount(quote.totalCostRaw, places, unit)

  return (
    <section className="bridge-quote" aria-labelledby={titleId}>
      <h4 id={titleId} className="bridge-quote-title">
        What this transfer costs
      </h4>

      <dl className="bridge-quote-headline">
        <div>
          <dt>
            Amount received{destinationNetworkName ? ` on ${destinationNetworkName}` : ''}
            <InfoTip label="About the amount received" className="earn-info">
              {BRIDGE_TIPS.amountReceived}
            </InfoTip>
          </dt>
          <dd className="bridge-quote-received">{received ?? 'Not available'}</dd>
        </div>
        <div>
          <dt>
            Estimated arrival
            <InfoTip label="About the arrival estimate" className="earn-info">
              {BRIDGE_TIPS.arrival}
            </InfoTip>
          </dt>
          <dd>{arrivalLabel(quote.estimatedFillSeconds)}</dd>
        </div>
      </dl>

      {/* FR-007 — one labelled line per cost. The platform-fee line only exists when a
          fee is actually charged (FR-029), so a zero rate reads byte-identically to a
          build with no fee configured. */}
      <dl className="bridge-quote-lines">
        {quote.lines.map((line) => {
          const amount = fmtAmount(line.amountRaw, places, unit)
          const rate =
            line.id === 'platformFee' && quote.platformFeeBps > 0
              ? ` (${bpsToPercent(quote.platformFeeBps)})`
              : ''
          return (
            <div key={line.id}>
              <dt>
                {line.label}
                {rate}
                <InfoTip label={`About the ${line.label.toLowerCase()}`} className="earn-info">
                  {BRIDGE_TIPS[line.tipKey]}
                </InfoTip>
              </dt>
              <dd>
                {line.available && amount ? (
                  amount
                ) : (
                  <span className="bridge-unknown">Not available</span>
                )}
              </dd>
            </div>
          )
        })}
        <div className="bridge-quote-total">
          <dt>
            Total cost
            <InfoTip label="About the total cost" className="earn-info">
              {BRIDGE_TIPS.totalCost}
            </InfoTip>
          </dt>
          <dd>{total ?? 'Not available'}</dd>
        </div>
      </dl>

      {/* An incomplete breakdown is stated, not smoothed over: the headline figures are
          still exactly what the protocol quoted, and saying which part is missing is
          what keeps them trustworthy. */}
      {!quote.itemized && (
        <p className="bridge-note" role="note">
          {BRIDGE_SETTLEMENT.protocol} did not return a full breakdown for this route, so one
          of the cost lines above is unavailable. The amount you receive and the total cost
          are exactly what it quoted — we have not filled the gap with an estimate.
        </p>
      )}

      {/* FR-012 — disclosed before signature, and only on an observed zero balance. */}
      {quote.destinationGasWarning === true && (
        <p className="bridge-gas-warning" role="note">
          {BRIDGE_TIPS.destinationGasWarning}
          {destinationNativeSymbol && destinationNetworkName
            ? ` That coin is ${destinationNativeSymbol} on ${destinationNetworkName}, and this route cannot deliver it with your transfer — you will need to bridge or receive a small amount of it separately.`
            : ' This route cannot deliver that coin with your transfer, so you will need a small amount of it separately.'}
        </p>
      )}

      {/* FR-008 — the window is visible, and expiry is a stated state with a way out. */}
      <div className="bridge-quote-validity">
        {stale ? (
          <p className="bridge-quote-stale" role="alert">
            {BRIDGE_UNAVAILABLE.quoteStale}
          </p>
        ) : (
          <p className="bridge-quote-fresh" role="status">
            This quote is good for another {secondsLeft(msRemaining)} seconds.
            <InfoTip label="Why quotes expire" className="earn-info">
              {BRIDGE_TIPS.quoteValidity}
            </InfoTip>
          </p>
        )}
        {typeof onRefresh === 'function' && (
          <button
            type="button"
            className="earn-btn secondary"
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh quote'}
          </button>
        )}
      </div>

      {/* FR-014 — the third party that settles this, named on the quote itself. */}
      <p className="bridge-attribution" role="note">
        {BRIDGE_SETTLEMENT.attribution} ·{' '}
        <a href={BRIDGE_SETTLEMENT.url} target="_blank" rel="noopener noreferrer">
          About {BRIDGE_SETTLEMENT.protocol} ↗
        </a>
      </p>
    </section>
  )
}
