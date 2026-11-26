/**
 * PredictPanel (spec 057 US1, reworked by spec 114 US1) — the Finance → Predict tab: browse Polymarket
 * EVENTS by category, sort and search, and open a market to buy or sell outcome shares through FairWins'
 * builder code.
 *
 * Soft-fail + honest state: hidden entirely on unsupported networks (the tab never renders this panel
 * off Polygon, FR-018); a degraded upstream shows an explicit unavailable state with the Polymarket link
 * still offered (never stranded, FR-017). Trading lives in the market detail sheet → TradeConfirm, where
 * the builder fee is disclosed honestly; this slice only changes how a market is FOUND.
 *
 * Category, sort and search live in the address (`cat`, `sort`, `q`; FR-003) so a view can be returned to
 * or shared. List prices come from the venue's event listing refreshed every 15 s, so on this source they
 * are DELAYED BY CONSTRUCTION: the list reading is classified from the gateway's server clock and held
 * out of `live` (`demoted`), so the chip reads "Delayed · N s" and ages to "Last known" if refreshes stop.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import EmptyState from '../account/EmptyState'
import { usePredictEvents } from '../../hooks/usePredictEvents'
import { classify } from '../../lib/markets/priceReading'
import { monotonicNow } from '../../lib/markets/serverClock'
import {
  PREDICT_CATEGORIES,
  PREDICT_SORTS,
  DEFAULT_SORT,
  isCategoryId,
  isSortId,
} from '../../lib/predict/categories'
import { marketFromRow } from '../../lib/predict/eventAdapters'
import EventCard from './EventCard'
import TrustChip from './TrustChip'
import MarketDetailSheet from './MarketDetailSheet'
import PositionsList from './PositionsList'
import OpenOrdersList from './OpenOrdersList'
import './PredictPanel.css'

const POLYMARKET_URL = 'https://polymarket.com'
const SEARCH_NOTE_ID = 'predict-search-note'

/**
 * The list's trust, derived from the gateway's server-clock stamp. `demoted: true` is the cap: the event
 * listing is a 15 s poll, so it can never be `live`. Owns its own one-second tick so the state ages into
 * "Last known" on screen even when no refresh arrives.
 */
function ListTrustChip({ stamp, stale }) {
  const [now, setNow] = useState(() => monotonicNow())
  useEffect(() => {
    const id = setInterval(() => setNow(monotonicNow()), 1000)
    return () => clearInterval(id)
  }, [])
  const reading = useMemo(
    () => classify({ price: 'event-list', stamp, stale, demoted: true }, now),
    [stamp, stale, now],
  )
  return <TrustChip reading={reading} />
}

export default function PredictPanel() {
  const [params, setParams] = useSearchParams()
  const urlCat = params.get('cat') || ''
  const urlSort = params.get('sort') || ''
  const urlQ = params.get('q') || ''
  const category = isCategoryId(urlCat) ? urlCat : ''
  const sort = isSortId(urlSort) ? urlSort : DEFAULT_SORT

  const [text, setText] = useState(urlQ)
  useEffect(() => {
    // Back/forward or an external link changed the address: follow it.
    setText((t) => (t === urlQ ? t : urlQ))
  }, [urlQ])

  const searching = text.trim() !== ''
  const { status, events, hasMore, loadMore, loadingMore, stale, stamp, directions, legacy, retry } = usePredictEvents({
    category,
    sort,
    q: text,
  })
  const [openMarket, setOpenMarket] = useState(null)

  // Write one or more of our params, omitting any at its default and preserving every other param.
  const update = useCallback(
    (changes, { replace = false } = {}) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(changes)) {
            if (value === '' || value == null) next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace },
      )
    },
    [setParams],
  )

  const onSearch = (value) => {
    setText(value)
    update({ q: value.trim() === '' ? '' : value }, { replace: true })
  }
  const onCategory = (id) => update({ cat: id })
  const onSort = (id) => update({ sort: id === DEFAULT_SORT ? '' : id })
  const clearFilters = () => {
    setText('')
    update({ q: '', cat: '' })
  }
  const openRow = useCallback((event, row) => setOpenMarket(marketFromRow(event, row)), [])

  const filtered = searching || category !== ''
  const showTrust = status === 'ready' || status === 'empty'

  return (
    <section className="predict-panel" aria-label="Predict">
      <div className="predict-panel-header">
        {/* No intro paragraph. The list says what this is, and the builder fee is disclosed where it
            can be stated as a NUMBER — its own line in `TradeConfirm`, before the signature (spec 057). */}
        <h3>Predict</h3>
        {showTrust && <ListTrustChip stamp={stamp} stale={stale} />}
      </div>

      <label className="predict-search">
        <span className="sr-only">Search markets</span>
        <input
          type="search"
          placeholder="Search markets…"
          value={text}
          onChange={(e) => onSearch(e.target.value)}
          aria-label="Search markets"
        />
      </label>

      {!legacy && (
      <div className="predict-controls">
        <div className="predict-chips" role="group" aria-label="Category">
          <button
            type="button"
            className="predict-chip"
            aria-pressed={category === ''}
            disabled={searching}
            aria-describedby={searching ? SEARCH_NOTE_ID : undefined}
            onClick={() => onCategory('')}
          >
            All
          </button>
          {PREDICT_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className="predict-chip"
              aria-pressed={category === c.id}
              disabled={searching}
              aria-describedby={searching ? SEARCH_NOTE_ID : undefined}
              onClick={() => onCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <label className="predict-sort">
          <span>Sort by</span>
          <select
            value={sort}
            disabled={searching}
            aria-describedby={searching ? SEARCH_NOTE_ID : undefined}
            onChange={(e) => onSort(e.target.value)}
          >
            {PREDICT_SORTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      )}

      {searching && !legacy && (
        <p id={SEARCH_NOTE_ID} className="predict-search-note">
          Searching all categories — category and sort are not applied while you search.
        </p>
      )}

      {stale && showTrust && (
        <p className="predict-stale-banner" role="status">
          The market data source is temporarily unreachable — showing the last answer we confirmed.
        </p>
      )}

      {status === 'loading' ? (
        <p className="predict-loading" role="status">
          Loading markets…
        </p>
      ) : status === 'degraded' ? (
        <div className="predict-degraded" role="status">
          <p>Market data is temporarily unavailable. Your funds are safe — this only affects display.</p>
          <div className="predict-degraded-actions">
            <button type="button" onClick={retry}>
              Try again
            </button>
            <a href={POLYMARKET_URL} target="_blank" rel="noopener noreferrer">
              Open Polymarket ↗
            </a>
          </div>
        </div>
      ) : status === 'empty' ? (
        <EmptyState
          title="No markets found"
          message={
            searching
              ? 'No markets match your search. Try a different term.'
              : category
                ? 'No markets are listed in this category right now.'
                : 'No markets are available right now.'
          }
          ctaLabel={filtered ? 'Clear search and category' : 'Open Polymarket'}
          onCta={filtered ? clearFilters : () => window.open(POLYMARKET_URL, '_blank', 'noopener,noreferrer')}
        />
      ) : (
        <>
          <ul className="predict-grid">
            {events.map((ev) => (
              <EventCard key={ev.slug} event={ev} directions={directions} onOpen={openRow} />
            ))}
          </ul>
          {hasMore && (
            <button type="button" className="predict-load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}

      {/* Your positions (US2) + open orders (US3) — each self-hides when disconnected/unsupported/empty. */}
      <PositionsList />
      <OpenOrdersList />

      <MarketDetailSheet
        key={openMarket ? openMarket.conditionId : 'closed'}
        market={openMarket}
        onClose={() => setOpenMarket(null)}
      />
    </section>
  )
}
