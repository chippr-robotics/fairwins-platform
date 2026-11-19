/**
 * PerpsPositions (spec 082 US2, extended by spec 083 US1/US2) — the connected account's open
 * positions per venue.
 *
 * Self-hides when there is nothing to say (disconnected / unsupported / idle) — the Predict
 * PositionsList convention. Per-venue honesty: an unreadable venue is disclosed by name while the
 * others render; an account with no positions gets a quiet empty state, not an error.
 *
 * MANAGEMENT IS PER-VENUE NOW, AND THAT IS THE POINT OF THIS FILE'S CHANGE. Phase 0 stated
 * globally that "positions are managed on the venue — there are no in-app controls". That sentence
 * was true then and is false now for **Gains and GMX** (FR-002/FR-003): a row on those venues opens
 * the PositionSheet, where a member closes, reduces and protects the position with their own
 * wallet. It remains true for **Hyperliquid**, which stays read-only this release (FR-021) — its L1
 * actions need a browser-held agent key even to close, so there is no in-app control to offer and a
 * disabled one would be the dishonest outcome. The statement is therefore rendered per venue, from
 * the venues actually on screen, rather than asserted once over all of them.
 *
 * THE VENUE LINK-OUT STAYS ON EVERY ROW, always, as the secondary action. It is the never-stranded
 * path: it is present when the management feature is off, when a venue is one this build cannot
 * manage, and when the app cannot transact at all. Nothing here may ever be the only way out.
 *
 * The management gate lives in ONE place — the caller (`PerpsView`) — and arrives as
 * `canManage(position)`. This component asks the question and never answers it: a second copy of
 * that predicate is how a control ends up offered where the calldata path does not exist.
 */
import InfoTip from '../ui/InfoTip'
import PerpsVenueBadge from './PerpsVenueBadge'
import { tradeLinkFor } from '../../lib/perps/linkouts'
import { formatUsd, formatSignedUsd, formatPairPrice, formatLeverage } from '../../lib/perps/format'
import { PERPS_TIPS } from '../../lib/perps/perpsCopy'
import { PERP_VENUES } from '../../config/perps'

export default function PerpsPositions({
  status,
  positions,
  unreadableVenues,
  attribution,
  /** `(position) => boolean` — whether this build offers in-app management for that row. */
  canManage,
  /** `(position) => void` — opens the PositionSheet. Absent ⇒ no in-app control renders at all. */
  onManage,
}) {
  if (status === 'idle') return null

  // Both halves must be true: a handler to call, and a venue/chain this build can actually build
  // calldata for. Either one missing means the row is link-out only — never a dead button.
  const manageable = (p) => typeof onManage === 'function' && Boolean(canManage?.(p))

  const rows = positions ?? []
  const managedVenues = distinctVenues(rows.filter(manageable))
  const readOnlyVenues = distinctVenues(rows.filter((p) => !manageable(p)))

  return (
    <section className="perps-positions" aria-label="Your perp positions">
      <h4 className="perps-positions-title">Your positions</h4>

      {unreadableVenues.length > 0 && (
        <p className="perps-positions-unreadable" role="status">
          {unreadableVenues.map((v) => PERP_VENUES[v]?.label ?? v).join(' and ')} positions could not be
          read just now — other venues are unaffected. Your positions themselves are untouched.
        </p>
      )}

      {status === 'loading' && rows.length === 0 ? (
        <p className="perps-loading" role="status">
          Checking venues for open positions…
        </p>
      ) : status === 'unavailable' ? (
        <p className="perps-positions-unreadable" role="status">
          Positions could not be read just now. Your positions themselves are untouched — try again shortly.
        </p>
      ) : rows.length === 0 ? (
        <p className="perps-positions-empty">No open perp positions found for this account.</p>
      ) : (
        <ul className="perps-positions-list">
          {rows.map((p) => {
            const href = tradeLinkFor(p, attribution)
            const venueLabel = PERP_VENUES[p.venue]?.label ?? p.venue
            return (
              <li key={`${p.venue}:${p.id}`} className="perps-position-row">
                <div className="perps-position-main">
                  <span className={`perps-direction perps-direction-${p.direction}`}>
                    {p.direction === 'long' ? 'Long' : 'Short'}
                  </span>
                  <span className="perps-position-symbol">{p.symbol}</span>
                  {/* GMX lists several markets on one base pair ("BTC/USD [WBTC.b-USDC]" vs
                      "BTC/USD [BTC-USDC]"), so the venue's own variant rides beside the symbol —
                      two positions on the same pair must never render identically. Absent for
                      venues that have no such thing, which is most rows. */}
                  {p.variant && <span className="perps-position-variant">{p.variant}</span>}
                  <PerpsVenueBadge venue={p.venue} chainId={p.chainId} />
                </div>
                <dl className="perps-position-stats">
                  <div>
                    <dt>Size</dt>
                    <dd>{formatUsd(p.sizeUsd)}</dd>
                  </div>
                  <div>
                    <dt>Entry</dt>
                    <dd>{formatPairPrice(p.entryPrice)}</dd>
                  </div>
                  <div>
                    <dt>Leverage</dt>
                    <dd>{formatLeverage(p.leverage)}</dd>
                  </div>
                  <div>
                    <dt>
                      PnL <InfoTip label="About PnL">{PERPS_TIPS.pnl}</InfoTip>
                    </dt>
                    <dd className={p.unrealizedPnlUsd > 0 ? 'perps-pnl-up' : p.unrealizedPnlUsd < 0 ? 'perps-pnl-down' : ''}>
                      {formatSignedUsd(p.unrealizedPnlUsd)}
                    </dd>
                  </div>
                </dl>
                <div className="perps-position-actions">
                  {/* Named for what the sheet actually does. "Manage" beside "Manage on venue" is
                      the kind of a tap-apart ambiguity that costs money on a leveraged position. */}
                  {manageable(p) && (
                    <button
                      type="button"
                      className="perps-position-manage"
                      onClick={() => onManage(p)}
                      aria-label={`Close or protect your ${describe(p)} position on ${venueLabel}`}
                    >
                      Close or protect
                    </button>
                  )}
                  {href && (
                    <a
                      className="perps-trade-link"
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      // WCAG 2.5.3: the accessible name must START with the visible text, or a speech-input user
                      // saying what they see ("click Manage on venue") cannot activate it.
                      aria-label={`Manage on venue: this position on ${venueLabel} (opens in a new tab)`}
                    >
                      Manage on venue ↗
                    </a>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="perps-positions-note">
        {managedVenues.length > 0 && (
          <>
            You can close, reduce and protect your {venueList(managedVenues)} positions here — each
            order is sent from your own wallet.{' '}
          </>
        )}
        {readOnlyVenues.length > 0 && (
          <>
            {venueList(readOnlyVenues)} positions are read-only in FairWins this release — manage
            those on the venue.{' '}
          </>
        )}
        {managedVenues.length === 0 && readOnlyVenues.length === 0 && (
          <>Positions are managed on their venue. </>
        )}
        FairWins never holds your positions.
      </p>

      {/* GMX reports a position's size and side and nothing else its Reader prices — entry price,
          leverage and P&L are FairWins' own arithmetic over the raw position (`lib/perps/
          gmxDerived.js`), so this says so rather than letting them read as GMX's figures. The
          P&L in particular is not GMX's settlement number: it excludes the borrowing and funding
          charges accrued on the position and the price impact of closing. A dash still means the
          value could not be established — never that it is zero. */}
      {rows.some((p) => p.venue === 'gmx') && (
        <p className="perps-positions-note">
          GMX reports each position’s size and side here. Entry price, leverage and P&L are
          calculated by FairWins from that position — the P&L leaves out GMX’s borrowing and funding
          charges and the price impact of closing, so it is not what GMX will settle at, and “—”
          means a value could not be established rather than that it is zero. GMX’s own figures are
          on{' '}
          <a href="https://app.gmx.io" target="_blank" rel="noopener noreferrer">
            GMX ↗
          </a>
          .
        </p>
      )}
    </section>
  )
}

/** The venues present in a set of rows, in first-seen order. Display only. */
function distinctVenues(rows) {
  return [...new Set(rows.map((p) => p.venue).filter(Boolean))]
}

/** "Gains Network and GMX" — an Oxford-less list of venue labels. */
function venueList(venues) {
  const labels = venues.map((v) => PERP_VENUES[v]?.label ?? v)
  if (labels.length <= 1) return labels[0] ?? ''
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

/**
 * "Long BTC/USD (WBTC.b-USDC)" for a screen reader, degrading to whatever the venue actually
 * reported. The variant is spoken too: two GMX markets on one base pair would otherwise give two
 * buttons the same accessible name, and picking between them is what the member is doing.
 */
function describe(p) {
  const side = p.direction === 'long' ? 'Long' : p.direction === 'short' ? 'Short' : ''
  const pair = [p.symbol, p.variant ? `(${p.variant})` : null].filter(Boolean).join(' ')
  return [side, pair].filter(Boolean).join(' ') || 'open'
}
