/**
 * EventPage (spec 114, US2 + US3) — one event on its own address (`?tab=predict&event=<slug>`): every outcome
 * with its probability, how it moved, how much is on offer, and exactly what decides the result.
 *
 * Honest by construction:
 *  - a probability is shown through a PriceReading and its state is said in words (FR-010); a row whose
 *    reading has no price falls back to the event listing's price, CLASSIFIED (never live) and marked so;
 *  - the page chip is the LEAST trusting state among the subscribed readings, so one stale outcome is never
 *    hidden behind nine live ones;
 *  - the page subscribes to at most TEN tokens in total (the gateway's poller batches ten to a request and
 *    reads are quota'd): the Yes token of the first eight rows plus the selected row's own two;
 *  - markets that are not mutually exclusive are never drawn as shares of one whole — no total, no
 *    rescaling, and the page says they are independent (FR-008);
 *  - a closed or resolved event says so, names the winner when the venue gave one, and offers NO order
 *    control (FR-009);
 *  - titles, descriptions and resolution sources are TEXT; a source is a link only when it is `https:`.
 * Trading is not built here: Yes/No hands (event, row) to `onOpenRow` (the fixed-price sheet) — or, when the
 * caller has the amount-first ticket (`onOpenTicket`), (event, row, the outcome pressed) to that.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { usePredictEvent } from '../../hooks/usePredictEvent'
import { useMarketReadings } from '../../hooks/useMarketReadings'
import { classify } from '../../lib/markets/priceReading'
import { monotonicNow } from '../../lib/markets/serverClock'
import { categoryLabel } from '../../lib/predict/categories'
import { formatPercent, formatCents, formatVolume, formatClosingDate, formatInPlay } from '../../lib/predict/format'
import {
  MAX_CHART_SERIES,
  primaryOutcome,
  counterOutcome,
  rankRows,
  readingKey,
  subscriptionKeys,
  leastTrusting,
  stateWords,
  safeHttpsUrl,
} from '../../lib/predict/eventPage'
import TrustChip from './TrustChip'
import DepthLadder from './DepthLadder'
import './EventPage.css'

const PriceHistoryChart = lazy(() => import('./PriceHistoryChart'))

const polymarketUrl = (slug) => `https://polymarket.com/event/${encodeURIComponent(slug)}`

function BackButton({ onBack }) {
  return (
    <button type="button" className="event-page-back" onClick={onBack}>
      <span aria-hidden="true">←</span>Back to markets
    </button>
  )
}

export default function EventPage({ slug, onBack, onOpenRow, onOpenTicket, paused = false }) {
  const { status, event, stamp, stale, retry } = usePredictEvent(slug)
  const articleRef = useRef(null)
  useEffect(() => {
    // Land on the page, not wherever the list left focus (WCAG 2.4.3).
    articleRef.current?.focus({ preventScroll: true })
  }, [slug])

  const [selection, setSelection] = useState({ id: null, side: 'primary' })
  const [now, setNow] = useState(() => monotonicNow())
  useEffect(() => {
    if (status !== 'ready') return undefined
    const id = setInterval(() => setNow(monotonicNow()), 1000)
    return () => clearInterval(id)
  }, [status])

  const rows = useMemo(() => rankRows(event?.markets), [event])
  const open = event?.status === 'open'
  const selectedRow = rows.find((r) => r.conditionId === selection.id) ?? rows[0] ?? null
  const side = selection.id === selectedRow?.conditionId ? selection.side : 'primary'

  // One subscription list, ≤ 10 keys by construction (see subscriptionKeys). Nothing is read for an event
  // the venue has closed: there is no book to confirm.
  // While a ticket for a position (a token this page may not hold) is open the page stands down, so the
  // ticket's one key is the only read: the ten-key budget holds in total, not just for the page.
  const keys = useMemo(() => (open && !paused ? subscriptionKeys(rows, selectedRow) : []), [open, paused, rows, selectedRow])
  const readings = useMarketReadings(keys)

  if (status === 'loading') {
    return (
      <article className="event-page" aria-label="Event" tabIndex={-1} ref={articleRef}>
        <BackButton onBack={onBack} />
        <p className="event-page-note" role="status">
          Loading event…
        </p>
      </article>
    )
  }
  if (status === 'not-found' || status === 'degraded' || !event) {
    return (
      <article className="event-page" aria-label="Event" tabIndex={-1} ref={articleRef}>
        <BackButton onBack={onBack} />
        <div className="event-page-note" role="status">
          <p>
            {status === 'not-found'
              ? 'We could not find this event. It may have ended or the link may be wrong.'
              : 'Could not load this event right now. Your funds are safe — this only affects display.'}
          </p>
          <div className="event-page-actions">
            {status !== 'not-found' && (
              <button type="button" className="event-page-link-button" onClick={retry}>
                Try again
              </button>
            )}
            <a href={polymarketUrl(slug)} target="_blank" rel="noopener noreferrer">
              View on Polymarket ↗
            </a>
          </div>
        </div>
      </article>
    )
  }

  const single = rows.length <= 1
  const listing = (price) => classify({ price, stamp, stale, demoted: true }, now)
  // The reading a token's number is drawn from: the feed's when it has a price, else the event listing's,
  // which is classified from its own age and can never be live.
  const effective = (tokenId, listingPrice) => {
    const r = tokenId != null ? readings.get(readingKey(tokenId)) : null
    return r && r.state !== 'unknown' && r.price != null ? r : listing(listingPrice)
  }
  const rowReading = (row) => {
    const p = primaryOutcome(row)
    return effective(p?.tokenId, row.displayPrice)
  }
  const rowLabel = (row) => (single ? primaryOutcome(row)?.name ?? 'Outcome' : row.label)

  const subscribedRows = open ? rows.slice(0, 8) : []
  const subscribedReadings = subscribedRows.map(rowReading)
  const selectedPrimary = primaryOutcome(selectedRow)
  const selectedCounter = counterOutcome(selectedRow)
  if (open && selectedRow) {
    subscribedReadings.push(effective(selectedCounter?.tokenId, selectedCounter?.price ?? null))
    if (!subscribedRows.includes(selectedRow)) subscribedReadings.push(rowReading(selectedRow))
  }
  const pageReading = open ? leastTrusting(subscribedReadings) : null

  // Chart series: the Yes token of the four most likely rows, or — for one market with several outcomes —
  // the outcomes themselves. Never more than MAX_CHART_SERIES; the rest are named in text.
  let seriesSource
  let totalSeries
  if (rows.length === 1 && (rows[0].outcomes?.length ?? 0) > 2) {
    totalSeries = rows[0].outcomes.length
    seriesSource = rows[0].outcomes.slice(0, MAX_CHART_SERIES).map((o) => ({
      id: `${rows[0].conditionId}:${o.tokenId}`,
      label: o.name,
      tokenId: o.tokenId,
      reading: effective(o.tokenId, o.price),
    }))
  } else {
    totalSeries = rows.length
    seriesSource = rows
      .slice(0, MAX_CHART_SERIES)
      .filter((r) => primaryOutcome(r)?.tokenId != null)
      .map((r) => ({ id: r.conditionId, label: rowLabel(r), tokenId: primaryOutcome(r).tokenId, reading: rowReading(r) }))
  }
  const series = seriesSource.map((s) => ({
    ...s,
    // A live tail only from a LIVE reading; a listing price or a stale book never extends the line.
    liveTail: s.reading.state === 'live' && Number.isFinite(s.reading.confirmedAt) ? { t: s.reading.confirmedAt / 1000, p: s.reading.price } : null,
  }))

  const ladderOutcome = side === 'counter' ? selectedCounter : selectedPrimary
  const ladderReading = ladderOutcome ? readings.get(readingKey(ladderOutcome.tokenId)) : null
  const category = categoryLabel(event.category)
  const volume = formatVolume(event.volume)
  const closes = formatClosingDate(event.endDate)
  const inPlay = formatInPlay(event.live)
  const sourceHref = safeHttpsUrl(event.resolutionSource)
  const independent = event.mutuallyExclusive === false && rows.length > 1

  return (
    <article className="event-page" aria-labelledby="event-page-title" tabIndex={-1} ref={articleRef}>
      <BackButton onBack={onBack} />

      <header className="event-page-header">
        <div className="event-page-kicker">
          {category && <span className="event-page-category">{category}</span>}
          {inPlay && open && <span className="event-page-live">{inPlay}</span>}
        </div>
        <div className="event-page-titlerow">
          <h2 id="event-page-title">{event.title}</h2>
          {pageReading && <TrustChip reading={pageReading} />}
        </div>
        {(volume || closes) && (
          <p className="event-page-meta">
            {volume && <span>{volume} traded</span>}
            {closes && <span>closes {closes}</span>}
          </p>
        )}
        {event.status === 'closed' && (
          <p className="event-page-status" role="status">
            This market has closed. Trading has ended; prices shown are the last the venue listed.
          </p>
        )}
        {event.status === 'resolved' && (
          <p className="event-page-status" role="status">
            This market has resolved. Trading has ended.
          </p>
        )}
        {event.status === 'unknown' && (
          <p className="event-page-status" role="status">
            The venue did not say whether this market is open, so no orders are offered here.
          </p>
        )}
        {stale && (
          <p className="event-page-status" role="status">
            The market data source is temporarily unreachable — showing the last answer we confirmed.
          </p>
        )}
      </header>

      <section className="event-page-section" aria-labelledby="event-page-outcomes">
        <h3 id="event-page-outcomes">Outcomes</h3>
        {independent && (
          <p className="event-page-note">
            These markets are independent of one another — their probabilities are not shares of one whole and are not adjusted to add up.
          </p>
        )}
        <ul className="event-page-rows">
          {rows.map((row) => {
            const reading = rowReading(row)
            const words = open ? stateWords(reading) : null
            const label = rowLabel(row)
            const selected = row === selectedRow
            const [first, second] = row.outcomes || []
            const winner = event.status === 'resolved' ? row.winner : undefined
            return (
              <li key={row.conditionId} className={'event-page-row' + (selected ? ' is-selected' : '')}>
                <button
                  type="button"
                  className="event-page-select"
                  aria-pressed={selected}
                  onClick={() => setSelection({ id: row.conditionId, side: 'primary' })}
                >
                  <span className="event-page-row-label">{label}</span>{' '}
                  <span className="event-page-row-prob">
                    {event.status === 'resolved' ? (
                      <span className="event-page-winner">
                        {winner ? `Resolved: ${winner}` : 'Result not stated by the venue'}
                      </span>
                    ) : (
                      <>
                        <span className="event-page-pct">{formatPercent(reading.price)}</span>
                        <span className="sr-only"> chance</span>
                      </>
                    )}
                  </span>{' '}
                  {words && <span className="event-page-state">{words}</span>}
                  {open && !words && <span className="sr-only">Live</span>}
                </button>
                {open && row.tradable && (
                  <span className="event-page-row-actions">
                    {[first, second].map((o, i) =>
                      o ? (
                        <button
                          key={o.tokenId ?? i}
                          type="button"
                          className={'event-page-side ' + (i === 0 ? 'event-page-side--yes' : 'event-page-side--no')}
                          disabled={o.price == null}
                          aria-haspopup="dialog"
                          aria-label={o.name + ' ' + formatCents(o.price) + (o.price == null ? ' (price unavailable)' : '') + ', ' + label}
                          onClick={() => {
                            if (!onOpenTicket) return onOpenRow(event, row)
                            // Select the row first: its two tokens are then among the page's ten, and the ticket
                            // subscribes to exactly those — so opening a ticket adds no key to the poll.
                            setSelection({ id: row.conditionId, side: 'primary' })
                            return onOpenTicket(event, row, o)
                          }}
                        >
                          {o.name} {formatCents(o.price)}
                        </button>
                      ) : null,
                    )}
                  </span>
                )}
                {open && !row.tradable && <span className="event-page-closed-row">Not open for orders</span>}
              </li>
            )
          })}
        </ul>
        {open && (
          <p className="event-page-note">
            Button prices come from the event listing, refreshed every 15 seconds, and can lag the probability shown.
          </p>
        )}
      </section>

      <section className="event-page-section" aria-labelledby="event-page-chart">
        <h3 id="event-page-chart">Probability over time</h3>
        {series.length === 0 ? (
          <p className="event-page-note">No price history is available for this event.</p>
        ) : (
          <Suspense fallback={<p className="event-page-note">Loading chart…</p>}>
            <PriceHistoryChart
              series={series}
              moreCount={Math.max(0, totalSeries - MAX_CHART_SERIES)}
              highlightId={selectedRow?.conditionId ?? null}
            />
          </Suspense>
        )}
      </section>

      {open && selectedRow && ladderOutcome && (
        <section className="event-page-section" aria-labelledby="event-page-depth">
          <h3 id="event-page-depth">Depth — {rowLabel(selectedRow)}</h3>
          {selectedCounter && (
            <div className="event-page-sides" role="group" aria-label="Book side">
              {[
                ['primary', selectedPrimary],
                ['counter', selectedCounter],
              ].map(([id, o]) => (
                <button
                  key={id}
                  type="button"
                  className="event-page-sidebtn"
                  aria-pressed={side === id}
                  onClick={() => setSelection({ id: selectedRow.conditionId, side: id })}
                >
                  {o.name}
                </button>
              ))}
            </div>
          )}
          <DepthLadder reading={ladderReading} label={`${rowLabel(selectedRow)}, ${ladderOutcome.name}`} />
        </section>
      )}

      <section className="event-page-section" aria-labelledby="event-page-rules">
        <h3 id="event-page-rules">How this resolves</h3>
        {event.description ? (
          <p className="event-page-description">{event.description}</p>
        ) : (
          <p className="event-page-note">The venue did not give resolution rules for this event.</p>
        )}
        <p className="event-page-source">
          <span className="event-page-source-label">Resolution source: </span>
          {event.resolutionSource ? (
            sourceHref ? (
              <a href={sourceHref} target="_blank" rel="noopener noreferrer">
                {event.resolutionSource}
              </a>
            ) : (
              <span>{event.resolutionSource}</span>
            )
          ) : (
            <span>not named by the venue</span>
          )}
        </p>
        <p className="event-page-source">
          <a href={polymarketUrl(event.slug)} target="_blank" rel="noopener noreferrer">
            Read the full rules on Polymarket ↗
          </a>
        </p>
      </section>
    </article>
  )
}
