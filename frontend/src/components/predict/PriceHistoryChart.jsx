/**
 * PriceHistoryChart (spec 114, FR-006) — probability over time for the event's leading outcomes.
 *
 *  - at most FOUR series (the Yes token of the four most likely rows, or a single market's outcomes);
 *    when there are more, a line of text says "+N more outcomes not charted";
 *  - series differ by colour token AND dash pattern, and the legend is real text carrying each outcome's
 *    CURRENT value and, when that value is not live, its state — so the chart is never the only place a
 *    number lives. The drawing itself is `role="img"` with a label that summarises every charted value;
 *  - ranges 1H/1D/1W/1M/MAX are `aria-pressed` buttons (default 1D);
 *  - a live tail (the current reading) is appended ONLY when that reading is `live`; missing history is a
 *    gap in the line, never interpolated; loading, empty and unreadable each say so in words.
 * recharts is loaded lazily so the browse view does not pay for it.
 */
import { lazy, Suspense, useMemo, useState } from 'react'
import { usePriceHistories } from '../../hooks/usePriceHistory'
import { formatPercent } from '../../lib/predict/format'
import { RANGES, DEFAULT_RANGE, SERIES_STYLES, buildSeriesData, stateWords } from '../../lib/predict/eventPage'
import './PriceHistoryChart.css'

const Canvas = lazy(() => import('./PriceHistoryCanvas'))

function Swatch({ styleId, dash }) {
  return (
    <svg className={`event-chart-swatch event-chart-s${styleId}`} width="28" height="10" viewBox="0 0 28 10" aria-hidden="true" focusable="false">
      <line x1="1" y1="5" x2="27" y2="5" stroke="currentColor" strokeWidth="3" strokeDasharray={dash || undefined} />
    </svg>
  )
}

/**
 * `series`: [{ id, label, tokenId, reading }] — `reading` is the outcome's current EFFECTIVE reading (a feed
 * reading, or the listing price classified as delayed); `liveTail` is set only for a live feed reading.
 * `moreCount`: how many outcomes exist beyond the charted ones.
 */
export default function PriceHistoryChart({ series, moreCount = 0, highlightId = null }) {
  const [rangeId, setRangeId] = useState(DEFAULT_RANGE)
  const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[1]
  const charted = series.slice(0, SERIES_STYLES.length)
  const { byToken, retry } = usePriceHistories(
    charted.map((s) => s.tokenId),
    rangeId,
  )

  const entries = charted.map((s, i) => ({ s, style: SERIES_STYLES[i], history: byToken[String(s.tokenId)] }))
  const loading = entries.some((e) => !e.history || e.history.status === 'loading')
  const failed = entries.filter((e) => e.history?.status === 'error')
  const allFailed = entries.length > 0 && failed.length === entries.length
  const readyEntries = entries.filter((e) => e.history?.status === 'ready')
  const anyPoints = readyEntries.some((e) => e.history.points.length > 0)

  // Re-derive the drawable data only when what it is built from changed — the page above re-renders
  // every second to age its readings, and recharts should not recompute for that.
  const dataSig = JSON.stringify([
    rangeId,
    readyEntries.map((e) => [e.s.id, e.history.points.length, e.history.points.at(-1)?.t ?? null, e.s.liveTail?.t ?? null, e.s.liveTail?.p ?? null]),
  ])
  const lines = useMemo(
    () =>
      readyEntries.map((e) => ({
        id: e.s.id,
        styleId: e.style.id,
        dash: e.style.dash,
        data: buildSeriesData(e.history.points, range.stepSec, e.s.liveTail ?? null),
      })),
    // `dataSig` stands for everything read above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataSig],
  )

  const summary = charted
    .map((s) => {
      const words = stateWords(s.reading)
      return `${s.label} ${formatPercent(s.reading?.price)}${words ? ` (${words.toLowerCase()})` : ''}`
    })
    .join('; ')
  const chartLabel = `Probability history, last ${range.label}. ${summary}.`

  return (
    <div className="event-chart">
      <div className="event-chart-ranges" role="group" aria-label="Chart range">
        {RANGES.map((r) => (
          <button key={r.id} type="button" className="event-chart-range" aria-pressed={r.id === rangeId} onClick={() => setRangeId(r.id)}>
            {r.label}
          </button>
        ))}
      </div>

      {allFailed ? (
        <div className="event-chart-note" role="status">
          <p>Price history could not be loaded right now.</p>
          <button type="button" className="event-chart-retry" onClick={retry}>
            Try again
          </button>
        </div>
      ) : loading && !anyPoints ? (
        <p className="event-chart-note" role="status">
          Loading price history…
        </p>
      ) : !anyPoints ? (
        <p className="event-chart-note" role="status">
          No price history yet
        </p>
      ) : (
        <div className="event-chart-plot" role="img" aria-label={chartLabel}>
          <Suspense fallback={<p className="event-chart-note">Loading chart…</p>}>
            <Canvas lines={lines} rangeId={rangeId} highlightId={highlightId} />
          </Suspense>
        </div>
      )}

      {failed.length > 0 && !allFailed && (
        <p className="event-chart-note" role="status">
          History could not be loaded for {failed.map((e) => e.s.label).join(', ')}.{' '}
          <button type="button" className="event-chart-retry" onClick={retry}>
            Try again
          </button>
        </p>
      )}

      <ul className="event-chart-legend" aria-label="Charted outcomes">
        {entries.map(({ s, style }) => {
          const words = stateWords(s.reading)
          return (
            <li key={s.id} className={'event-chart-legend-item' + (s.id === highlightId ? ' is-selected' : '')}>
              <Swatch styleId={style.id} dash={style.dash} />
              <span className="event-chart-legend-label">{s.label}</span>
              <span className="event-chart-legend-value">{formatPercent(s.reading?.price)}</span>
              {words && <span className="event-chart-legend-state">{words}</span>}
            </li>
          )
        })}
      </ul>
      {moreCount > 0 && <p className="event-chart-more">+{moreCount} more {moreCount === 1 ? 'outcome' : 'outcomes'} not charted</p>}
    </div>
  )
}
