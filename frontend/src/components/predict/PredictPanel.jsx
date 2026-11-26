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
 * Category, quick filter (`topic` / `live`), sort and search live in the address (`cat`, `topic`, `live`,
 * `sort`, `q`; FR-003) so a view can be returned to or shared. Category, topic and live are MUTUALLY
 * EXCLUSIVE — choosing one clears the other two in the same URL update (the gateway answers 400
 * `invalid_filter` otherwise). List prices come from the venue's event listing refreshed every 15 s, so on this source they
 * are DELAYED BY CONSTRUCTION: the list reading is classified from the gateway's server clock and held
 * out of `live` (`demoted`), so the chip reads "Delayed · N s" and ages to "Last known" if refreshes stop.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import EmptyState from '../account/EmptyState'
import { usePredictEvents } from '../../hooks/usePredictEvents'
import { useAddressText } from '../../hooks/useAddressText'
import { usePredictDiscover } from '../../hooks/usePredictDiscover'
import { classify } from '../../lib/markets/priceReading'
import { ageMs, monotonicNow } from '../../lib/markets/serverClock'
import {
  PREDICT_CATEGORIES,
  PREDICT_SORTS,
  DEFAULT_SORT,
  isCategoryId,
  isSortId,
} from '../../lib/predict/categories'
import { marketFromRow } from '../../lib/predict/eventAdapters'
import EventCard from './EventCard'
import EventPage from './EventPage'
import TrustChip from './TrustChip'
import MarketDetailSheet from './MarketDetailSheet'
import PositionsList from './PositionsList'
import OpenOrdersList from './OpenOrdersList'
import './PredictPanel.css'

const POLYMARKET_URL = 'https://polymarket.com'
const SEARCH_NOTE_ID = 'predict-search-note'
// How old a /discover answer may be and still be offered as quick filters (see QuickFilters).
export const DISCOVER_MAX_AGE_MS = 5 * 60 * 1000
const LIVE_NOTE_ID = 'predict-live-note'
// A venue tag slug as the gateway accepts it for `topic` (mixed case is real).
const TOPIC_RE = /^[A-Za-z0-9-]{1,64}$/
// An event slug as the gateway accepts it for `/events/:slug`.
const EVENT_RE = /^[a-z0-9-]{1,160}$/

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

/**
 * The quick-filter row (spec 114 FR-002a–c): an "In play" chip with its count, then one chip per topic.
 *
 * It is OPTIONAL and never shown from a reading the app cannot vouch for: the discover answer is classified
 * from the gateway's server clock (`demoted`, so never live) and a `last-known` or `unknown` reading draws
 * nothing (FR-002b). A filter that is already in the address is ALWAYS drawn as an active chip even when
 * discover cannot name it (a shared link, an older answer), so the member can see and clear what is
 * narrowing the list. Navigation, not recommendation: chips come in the gateway's order, never reordered.
 */
function QuickFilters({ discover, topic, live, searching, onTopic, onLive }) {
  const [now, setNow] = useState(() => monotonicNow())
  useEffect(() => {
    const id = setInterval(() => setNow(monotonicNow()), 1000)
    return () => clearInterval(id)
  }, [])
  // Quick filters summarise a DAY of trading, so they are judged on their own bound and not on the
  // price bounds: the gateway caches them for a minute and the client asks once a minute, so a
  // perfectly healthy answer is routinely one to two minutes old, and a 30 s price bound hid the
  // row for most of every cycle. Past the bound, or when the age cannot be known, the row is not
  // drawn at all (FR-002b) — the list works without it.
  const trusted = useMemo(() => {
    if (discover.status !== 'ready') return false
    const age = ageMs(discover.stamp, now)
    return age != null && age <= DISCOVER_MAX_AGE_MS
  }, [discover, now])

  const liveInfo = trusted ? discover.live : null
  const showLive = (liveInfo && liveInfo.count > 0) || live
  const topics = trusted && Array.isArray(discover.topics) ? discover.topics.map((t) => ({ slug: t.slug, label: t.label })) : []
  if (topic && !topics.some((t) => t.slug === topic)) topics.unshift({ slug: topic, label: topic })
  if (!showLive && topics.length === 0) return null

  const described = searching ? SEARCH_NOTE_ID : undefined
  const liveLabel =
    liveInfo && liveInfo.count > 0 ? `In play · ${liveInfo.count}${liveInfo.more ? '+' : ''}` : 'In play'
  return (
    <div className="predict-chips predict-quick" role="group" aria-label="Active now">
      {showLive && (
        <button
          type="button"
          className="predict-chip"
          aria-pressed={live}
          disabled={searching}
          aria-describedby={described}
          onClick={onLive}
        >
          {liveLabel}
        </button>
      )}
      {topics.map((t) => (
        <button
          key={t.slug}
          type="button"
          className="predict-chip"
          aria-pressed={topic === t.slug}
          disabled={searching}
          aria-describedby={described}
          onClick={() => onTopic(t.slug)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/**
 * The browse list: search, quick filters, category chips, sort and the event cards. Its own component so
 * that opening an event page UNMOUNTS it — a cold open of `?event=<slug>` must not wait on, or pay for,
 * the list's requests, and a page the member is not looking at does not poll.
 */
function PredictList({ params, update, openRow, openEvent }) {
  const urlCat = params.get('cat') || ''
  const urlSort = params.get('sort') || ''
  const urlQ = params.get('q') || ''
  // One filter at a time. The handlers below keep the address to one, but a hand-edited or old link can carry
  // several, and the gateway refuses that — so the strongest wins here: in play, then topic, then category.
  const live = params.get('live') === '1'
  const urlTopic = params.get('topic') || ''
  const topic = !live && TOPIC_RE.test(urlTopic) ? urlTopic : ''
  const category = !live && !topic && isCategoryId(urlCat) ? urlCat : ''
  const sort = isSortId(urlSort) ? urlSort : DEFAULT_SORT

  // The field follows the address when it changes from outside (Back, a shared link) and never
  // lets its own older writes overwrite newer typing — see useAddressText for the race.
  const [text, writeText] = useAddressText(urlQ)

  const searching = text.trim() !== ''
  const { status, events, hasMore, loadMore, loadingMore, stale, stamp, directions, legacy, retry } = usePredictEvents({
    category,
    sort,
    q: text,
    topic,
    live,
  })
  const discover = usePredictDiscover()

  const onSearch = (value) => {
    const q = value.trim() === '' ? '' : value
    writeText(value, q)
    update({ q }, { replace: true })
  }
  const onCategory = (id) => update({ cat: id, topic: '', live: '' })
  const onTopic = (slug) => update({ topic: topic === slug ? '' : slug, cat: '', live: '' })
  const onLive = () => update({ live: live ? '' : '1', cat: '', topic: '' })
  const onSort = (id) => update({ sort: id === DEFAULT_SORT ? '' : id })
  const clearFilters = () => {
    writeText('', '')
    update({ q: '', cat: '', topic: '', live: '' })
  }

  const filtered = searching || category !== '' || topic !== '' || live
  const showTrust = status === 'ready' || status === 'empty'

  return (
    <>
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
        <QuickFilters
          discover={discover}
          topic={topic}
          live={live}
          searching={searching}
          onTopic={onTopic}
          onLive={onLive}
        />
      )}

      {!legacy && (
      <div className="predict-controls">
        <div className="predict-chips" role="group" aria-label="Category">
          <button
            type="button"
            className="predict-chip"
            aria-pressed={category === '' && topic === '' && !live}
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
            disabled={searching || live}
            aria-describedby={searching ? SEARCH_NOTE_ID : live ? LIVE_NOTE_ID : undefined}
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
          Searching all categories — category, quick filters and sort are not applied while you search.
        </p>
      )}
      {live && !searching && !legacy && (
        <p id={LIVE_NOTE_ID} className="predict-search-note">
          Events in play are listed by trading over the last day, so sort is not applied.
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
              : live
                ? 'No events are in play right now.'
                : topic
                  ? 'No markets are listed under this topic right now.'
                  : category
                    ? 'No markets are listed in this category right now.'
                    : 'No markets are available right now.'
          }
          ctaLabel={filtered ? (!searching && (topic || live) ? 'Clear filter' : 'Clear search and category') : 'Open Polymarket'}
          onCta={filtered ? clearFilters : () => window.open(POLYMARKET_URL, '_blank', 'noopener,noreferrer')}
        />
      ) : (
        <>
          <ul className="predict-grid">
            {events.map((ev) => (
              <EventCard
                key={ev.slug}
                event={ev}
                directions={directions}
                onOpen={openRow}
                // A gateway with no event route has no event page to open: the title keeps opening the sheet.
                onOpenEvent={legacy ? undefined : openEvent}
              />
            ))}
          </ul>
          {hasMore && (
            <button type="button" className="predict-load-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      )}

    </>
  )
}

export default function PredictPanel() {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const urlEvent = params.get('event') || ''
  const eventSlug = EVENT_RE.test(urlEvent) ? urlEvent : ''
  const [openMarket, setOpenMarket] = useState(null)

  // Write one or more of our params, omitting any at its default and preserving every other param.
  const update = useCallback(
    (changes, { replace = false, state } = {}) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(changes)) {
            if (value === '' || value == null) next.delete(key)
            else next.set(key, value)
          }
          return next
        },
        { replace, ...(state !== undefined ? { state } : {}) },
      )
    },
    [setParams],
  )

  const openRow = useCallback((event, row) => setOpenMarket(marketFromRow(event, row)), [])
  // Opening PUSHES (so the browser's Back returns to the list, filters intact — every list param is kept),
  // and marks the entry so the page's own Back control can pop rather than push a second list entry.
  const openEvent = useCallback((event) => update({ event: event.slug }, { state: { predictBack: true } }), [update])
  const closeEvent = useCallback(() => {
    if (location.state?.predictBack) navigate(-1)
    else update({ event: '' }, { replace: true })
  }, [location.state, navigate, update])

  return (
    <section className="predict-panel" aria-label="Predict">
      {eventSlug ? (
        <EventPage key={eventSlug} slug={eventSlug} onBack={closeEvent} onOpenRow={openRow} />
      ) : (
        <PredictList params={params} update={update} openRow={openRow} openEvent={openEvent} />
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
