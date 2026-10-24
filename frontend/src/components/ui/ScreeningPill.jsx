/**
 * ScreeningPill — the one-word answer to "is this address flagged anywhere?", with the receipts
 * one tap away (spec 021 amendment, issue #1458).
 *
 * Four verdicts plus loading, every one carried by an icon AND a word (never colour alone):
 *
 *   Screened clear   green   every configured source on every cohort chain answered, all clear
 *   Flagged          red     at least one list says yes — named in the details
 *   Partly screened  amber   nothing flagged, but a source did not answer; NOT a clean bill
 *   Unscreened       amber   no source answered at all
 *   Screening…       muted   the sweep is running
 *
 * The pill is a button: expanding it lists every source that was asked, per network, with its
 * answer or the reason it gave none, and names the networks that have no source at all. A
 * member who wants to know WHY it is green can see exactly which lists said so; a member who
 * sees amber can see which one is missing. Nothing here enforces anything.
 */
import { useId, useState } from 'react'
import { NETWORKS } from '../../config/networks'
import { READ, VERDICTS, VERDICT_LABELS } from '../../lib/screening/verdict'
import './ScreeningPill.css'

const networkName = (chainId) => NETWORKS[chainId]?.name || `Chain ${chainId}`

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
function WarningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}
function QuestionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

const ICONS = {
  [VERDICTS.SCREENED]: CheckIcon,
  [VERDICTS.FLAGGED]: WarningIcon,
  [VERDICTS.PARTIAL]: QuestionIcon,
  [VERDICTS.UNSCREENED]: QuestionIcon,
}

function rowText(r) {
  if (r.status === READ) {
    if (r.flagged) return `Flagged — ${r.detail || 'listed'}`
    return 'Clear'
  }
  return `Could not read — ${r.reason || 'no answer'}`
}

/**
 * @param {object} props
 * @param {import('../../lib/screening/screenEstate').EstateScreeningResult|null} props.result
 * @param {boolean} [props.loading]
 * @param {number} [props.chainId]  the network the surrounding flow acts on; its rows are marked
 */
export default function ScreeningPill({ result, loading = false, chainId = null }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()

  if (loading || !result) {
    return (
      <span className="screen-pill screen-pill-loading" role="status" aria-live="polite">
        <span aria-hidden="true">…</span>
        <span>Screening…</span>
      </span>
    )
  }

  const verdict = result.verdict
  const Icon = ICONS[verdict] || QuestionIcon
  const label = VERDICT_LABELS[verdict] || 'Unscreened'

  // Group rows by network, the order the cohort listed them (mainnets first).
  const byChain = new Map()
  for (const id of result.chainIds) byChain.set(id, [])
  for (const r of result.readings) {
    if (!byChain.has(r.chainId)) byChain.set(r.chainId, [])
    byChain.get(r.chainId).push(r)
  }

  return (
    <div className="screen-pill-wrap">
      <button
        type="button"
        className={`screen-pill screen-pill-${verdict}`}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((o) => !o)}
        data-verdict={verdict}
      >
        <Icon />
        <span>{label}</span>
      </button>
      {/*
        The list scrolls internally once the estate has more sources than fit (see the CSS), and a
        region that scrolls must be reachable by keyboard — otherwise its lower rows exist only for
        a mouse. `tabIndex` makes it a stop that arrow keys can scroll, and the label says what the
        stop is. It stays a plain list — an explicit role here would take the `list` role away from
        a `<ul>` full of `<li>`, which is both wrong and what the tests read it by.
      */}
      {open && (
        <ul id={detailsId} className="screen-pill-details" tabIndex={0} aria-label="Screening sources">
          {[...byChain.entries()].map(([id, rows]) => {
            const here = chainId != null && Number(chainId) === Number(id)
            const name = `${networkName(id)}${here ? ' (this network)' : ''}`
            if (!rows.length) {
              return (
                <li key={id} className="screen-pill-row screen-pill-row-uncovered">
                  <span className="screen-pill-net">{name}</span>
                  <span className="screen-pill-answer">No screening source on this network</span>
                </li>
              )
            }
            return rows.map((r) => (
              <li
                key={r.id}
                className={`screen-pill-row screen-pill-row-${r.status}${r.status === READ && r.flagged ? ' screen-pill-row-flagged' : ''}`}
              >
                <span className="screen-pill-net">{name}</span>
                <span className="screen-pill-source">{r.label}</span>
                <span className="screen-pill-answer">{rowText(r)}</span>
              </li>
            ))
          })}
        </ul>
      )}
    </div>
  )
}
