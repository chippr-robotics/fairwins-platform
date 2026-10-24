/**
 * RestrictionTag (Spec 021) — accessible sanctions/compliance status tag.
 *
 * Conveys status with an icon AND text (never colour alone) per WCAG 2.1 AA (FR-023).
 *
 * It speaks TWO vocabularies, on purpose. The legacy per-chain statuses
 * (`restricted`/`uncertain`/`loading`/`clear`) are what `useAddressScreening` returns, and there
 * `clear` still renders nothing — that hook cannot distinguish "the guard said yes" from "I could
 * not ask", so a green tag on its say-so would be a claim it is not entitled to make.
 *
 * The four estate VERDICTS (issue #1458) render always, including `screened`: that sweep asked
 * every list on every cohort chain and only says clear when all of them answered, so silence
 * would throw away the one fact a member came to the address book for. A verdict tag is the same
 * word the pill uses on the address fields, so the two surfaces cannot disagree.
 */

import { VERDICT_LABELS, VERDICTS } from '../../lib/screening/verdict'
import './RestrictionTag.css'

function WarningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
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

// Estate verdict → (tone class, icon). Tone reuses the legacy classes so both vocabularies land
// on one set of opaque status fills (spec 090 rule 3).
const VERDICT_TONE = {
  [VERDICTS.FLAGGED]: 'restricted',
  [VERDICTS.PARTIAL]: 'uncertain',
  [VERDICTS.UNSCREENED]: 'uncertain',
  [VERDICTS.SCREENED]: 'clear',
}

export default function RestrictionTag({ status }) {
  const tone = VERDICT_TONE[status]
  if (tone) {
    const Icon = tone === 'restricted' ? WarningIcon : tone === 'clear' ? CheckIcon : QuestionIcon
    return (
      <span className={`ab-tag ab-tag-${tone}`} role="status">
        <Icon />
        <span>{VERDICT_LABELS[status]}</span>
      </span>
    )
  }
  if (status === 'restricted') {
    return (
      <span className="ab-tag ab-tag-restricted" role="status">
        <WarningIcon />
        <span>Restricted</span>
      </span>
    )
  }
  if (status === 'uncertain') {
    return (
      <span className="ab-tag ab-tag-uncertain" role="status">
        <QuestionIcon />
        <span>Unscreened</span>
      </span>
    )
  }
  if (status === 'loading') {
    // role="status" is not decoration: `aria-label` is PROHIBITED on a span with no
    // role, so without it the label is dropped and axe reports a serious
    // aria-prohibited-attr. The three tags above are already status tags; this one
    // is a status too. Surfaced by the MS-07 a11y scan (issue #1550).
    return (
      <span className="ab-tag ab-tag-loading" role="status" aria-label="Screening address">
        <span aria-hidden="true">…</span>
      </span>
    )
  }
  return null
}
