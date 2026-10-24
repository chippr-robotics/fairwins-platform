import PropTypes from 'prop-types'
import { timeLeft } from '../../lib/funding/progress'

/**
 * FundingProgress (spec 103, FR-010) — the goal bar. `role="progressbar"` with the capped percentage
 * as the value and a full sentence as `aria-valuetext`, so a screen reader hears "40 of 120 USDC
 * raised (33%)" rather than a bare number. Never renders a number it was not given: an absent
 * summary is the caller's loading/unreadable state, not this component's.
 */
export default function FundingProgress({ summary, now, compact = false }) {
  const pct = Math.round(summary.progressPct)
  const text = `${summary.raisedFormatted} of ${summary.goalFormatted} ${summary.tokenSymbol} raised (${pct}%)`
  const contributorsText = summary.contributorCount === 1 ? '1 contributor' : `${summary.contributorCount} contributors`
  const whenText =
    summary.state === 0
      ? timeLeft(summary.contributeDeadline, now, 'contributions closed')
      : summary.stateLabel
  return (
    <div className={`fp-progress${compact ? ' fp-progress--compact' : ''}`} data-testid="funding-progress">
      <div className="fp-progress-head">
        <span className="fp-progress-raised">
          <strong data-testid="funding-raised">{summary.raisedFormatted}</strong>
          <span className="fp-progress-of"> of {summary.goalFormatted} {summary.tokenSymbol}</span>
        </span>
        {summary.goalMet ? (
          <span className="fp-chip fp-chip--success" data-testid="funding-goal-met">Goal met</span>
        ) : (
          <span className="fp-progress-pct" data-testid="funding-pct">{pct}%</span>
        )}
      </div>
      <div
        className="fp-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={text}
        aria-label="Progress toward the goal"
      >
        <div className="fp-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      {!compact && (
        <div className="fp-progress-meta">
          <span data-testid="funding-contributors">{contributorsText}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="funding-when">{whenText}</span>
        </div>
      )}
    </div>
  )
}

FundingProgress.propTypes = {
  summary: PropTypes.shape({
    progressPct: PropTypes.number.isRequired,
    raisedFormatted: PropTypes.string.isRequired,
    goalFormatted: PropTypes.string.isRequired,
    tokenSymbol: PropTypes.string.isRequired,
    goalMet: PropTypes.bool,
    contributorCount: PropTypes.number,
    contributeDeadline: PropTypes.number,
    state: PropTypes.number,
    stateLabel: PropTypes.string,
  }).isRequired,
  now: PropTypes.number,
  compact: PropTypes.bool,
}
