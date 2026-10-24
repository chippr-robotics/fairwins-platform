/**
 * ScreeningStatusBar — the scan, as a shape instead of a paragraph (issue #1458 QA round).
 *
 * One segment per screening source that was asked, coloured by what it answered: clear, flagged,
 * or could-not-be-read. A member reading an address field wants to know "is this checked, and did
 * anything object?" — a bar answers that in a glance, where the sentence it replaces made them
 * read the names of four contracts to find out.
 *
 * It is deliberately NOT the whole message. Colour alone is never the fact here (WCAG 1.4.1):
 * the pill beside it carries the verdict in words, the summary line carries the counts, and the
 * pill's expansion names every source with its answer. The bar is `role="img"` with the summary
 * as its label, so a screen reader gets that one sentence rather than a run of empty spans.
 *
 * While the sweep runs it shows the number of sources this build WILL ask, as pending segments —
 * the count is a synchronous fact about configuration, not a guess about the answers.
 */
import { useMemo } from 'react'
import { READ } from '../../lib/screening/verdict'
import { screeningChainIds, screeningSourcesFor } from '../../lib/screening/sources'
import './ScreeningStatusBar.css'

/** How many sources this build would ask about any address. Configuration, not a prediction. */
function plannedSourceCount() {
  try {
    return screeningChainIds().reduce((n, id) => n + screeningSourcesFor(id).length, 0)
  } catch {
    return 0
  }
}

function segmentState(reading) {
  if (reading.status !== READ) return 'unreadable'
  return reading.flagged ? 'flagged' : 'clear'
}

/**
 * @param {object} props
 * @param {import('../../lib/screening/screenEstate').EstateScreeningResult|null} props.result
 * @param {boolean} [props.loading]
 * @param {string} [props.label]  the summary sentence, used as the bar's accessible name
 */
export default function ScreeningStatusBar({ result, loading = false, label = '' }) {
  const pending = useMemo(() => (loading ? plannedSourceCount() : 0), [loading])

  if (loading || !result) {
    if (!pending) return null
    return (
      <span className="screen-bar" role="img" aria-label={label || `Screening ${pending} lists…`}>
        {Array.from({ length: pending }, (_, i) => (
          <span key={i} className="screen-bar-seg screen-bar-seg-pending" />
        ))}
      </span>
    )
  }

  const readings = result.readings || []
  if (!readings.length) return null

  return (
    <span className="screen-bar" role="img" aria-label={label}>
      {readings.map((r) => (
        <span
          key={r.id}
          className={`screen-bar-seg screen-bar-seg-${segmentState(r)}`}
          // A pointer user gets the same per-source fact the expansion spells out.
          title={`${r.label}: ${
            r.status === READ ? (r.flagged ? 'flagged' : 'clear') : `could not be read — ${r.reason || 'no answer'}`
          }`}
        />
      ))}
    </span>
  )
}
