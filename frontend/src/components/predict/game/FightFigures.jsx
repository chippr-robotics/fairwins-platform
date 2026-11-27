/**
 * FightFigures (spec 115 slice 3, FR-018) — the source's own figures, per fighter per round, as plain numbers
 * side by side in a real table: a caption, the figure as the row header, each fighter as a column header.
 *
 * Nothing is derived. No total, no percentage, no bar, no highlight of the larger number, no "leading". A
 * figure the source did not report is a dash with the accessible text "not reported" — never 0 — while a
 * reported 0 shows 0. A landed/attempted pair reads "12 of 30"; control time is m:ss.
 */
import { useState } from 'react'
import { controlTime } from '../../../lib/sports/describe'

const DASH = '—'

function Missing() {
  return (
    <>
      <span aria-hidden="true">{DASH}</span>
      <span className="sr-only">not reported</span>
    </>
  )
}

const plain = (n) => (n == null ? <Missing /> : n)

function ofPair(landed, attempted) {
  if (landed == null && attempted == null) return <Missing />
  if (landed != null && attempted != null) return `${landed} of ${attempted}`
  // One half reported: say which, never fill the other with a number.
  return landed != null ? (
    <>
      <span aria-hidden="true">{landed} of {DASH}</span>
      <span className="sr-only">{landed} of not reported</span>
    </>
  ) : (
    <>
      <span aria-hidden="true">{DASH} of {attempted}</span>
      <span className="sr-only">not reported of {attempted}</span>
    </>
  )
}

const ROWS = [
  ['Knockdowns', (f) => plain(f.knockdowns)],
  ['Significant strikes', (f) => ofPair(f.sigStrikesLanded, f.sigStrikesAttempted)],
  ['Total strikes', (f) => ofPair(f.totalStrikesLanded, f.totalStrikesAttempted)],
  ['Head strikes', (f) => ofPair(f.headStrikesLanded, f.headStrikesAttempted)],
  ['Body strikes', (f) => ofPair(f.bodyStrikesLanded, f.bodyStrikesAttempted)],
  ['Leg strikes', (f) => ofPair(f.legStrikesLanded, f.legStrikesAttempted)],
  ['Takedowns', (f) => ofPair(f.takedownsLanded, f.takedownsAttempted)],
  ['Reversals', (f) => plain(f.reversals)],
  ['Submission attempts', (f) => plain(f.submissionsAttempted)],
  ['Control time', (f) => {
    const t = controlTime(f.controlSeconds)
    return t == null ? <Missing /> : t
  }],
]

const label = (name) => name ?? 'Fighter not named'

/** One table: `figures` is [fighter 0's, fighter 1's], in the order of `names`. */
export function FigureTable({ caption, names, figures }) {
  return (
    <table className="fight-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Figure</th>
          <th scope="col" className="fight-num">{label(names[0])}</th>
          <th scope="col" className="fight-num">{label(names[1])}</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map(([name, cell]) => (
          <tr key={name}>
            <th scope="row">{name}</th>
            <td className="fight-num">{cell(figures[0])}</td>
            <td className="fight-num">{cell(figures[1])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The whole-fight table (only when the source gave one) and one table per round, in the source's order. The
 * first table is always shown; the rest are behind one button and UNMOUNTED while closed, so a hidden table
 * is neither in the page nor in the tab order.
 */
export default function FightFigures({ names, rounds, overall, scheduledRounds }) {
  const [open, setOpen] = useState(false)
  const tables = []
  if (overall) tables.push({ key: 'overall', caption: 'Overall, the whole fight', figures: overall })
  const list = Array.isArray(rounds) ? rounds : []
  // Newest round first: it is what a member opening this mid-fight is asking about.
  for (const r of [...list].reverse()) {
    tables.push({
      key: `r${r.round}`,
      caption: scheduledRounds ? `Round ${r.round} of ${scheduledRounds}` : `Round ${r.round}`,
      figures: r.figures,
    })
  }
  if (tables.length === 0) return null
  const [first, ...rest] = tables
  return (
    <div className="fight-figures" data-testid="fight-figures">
      <FigureTable caption={first.caption} names={names} figures={first.figures} />
      {rest.length > 0 && (
        <>
          <button type="button" className="fight-more" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Show fewer tables' : `Show ${rest.length} more ${rest.length === 1 ? 'table' : 'tables'}`}
          </button>
          {open && rest.map((t) => <FigureTable key={t.key} caption={t.caption} names={names} figures={t.figures} />)}
        </>
      )}
    </div>
  )
}
