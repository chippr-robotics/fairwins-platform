import PropTypes from 'prop-types'
import { REFUND_REASON_TEXT } from '../../lib/funding/fundingContracts'

/**
 * RefundStatusBar (spec 103, FR-018). Two faces of one bar:
 *   Open      → refund votes cast of votes needed (a strict majority of contributors)
 *   Refunding → contributors who have collected of contributors total, plus WHY the pool is refunding
 * Hidden for a Closed pool (nothing to refund). States the member's own standing in words.
 */
export default function RefundStatusBar({ summary }) {
  const { state, me } = summary
  if (state === 1) return null
  const refunding = state === 2
  const value = refunding ? summary.refundedCount : summary.refundVotes
  const max = refunding ? summary.contributorCount : summary.refundVotesNeeded
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  const label = refunding ? 'Refunds collected' : 'Refund votes'
  const text = refunding
    ? `${value} of ${max} contributors have collected their refund`
    : max > 0
      ? `${value} of ${max} votes needed to refund everyone`
      : 'No contributors yet — nothing to refund'
  let standing = null
  if (refunding) {
    if (me?.refunded) standing = 'You have collected your contribution.'
    else if (me?.hasContributed) standing = `Your ${me.contributedFormatted} ${summary.tokenSymbol} is waiting for you to collect.`
    else standing = 'You did not contribute to this pool.'
  } else if (me?.voted) {
    standing = 'You voted to refund.'
  } else if (me?.hasContributed) {
    standing = 'You have not voted.'
  }
  return (
    <section className={`fp-refund${refunding ? ' fp-refund--active' : ''}`} aria-label={label} data-testid="refund-status">
      <div className="fp-refund-head">
        <span className="fp-refund-label">{label}</span>
        {max > 0 && <span className="fp-refund-count" data-testid="refund-count">{value} / {max}</span>}
      </div>
      <div
        className="fp-bar fp-bar--refund"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={text}
        aria-label={label}
      >
        <div className="fp-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="fp-refund-text">{text}</p>
      {refunding && summary.refundReason && (
        <p className="fp-refund-reason" data-testid="refund-reason">{REFUND_REASON_TEXT[summary.refundReason]}</p>
      )}
      {standing && <p className="fp-refund-standing" data-testid="refund-standing">{standing}</p>}
    </section>
  )
}

RefundStatusBar.propTypes = {
  summary: PropTypes.shape({
    state: PropTypes.number.isRequired,
    refundVotes: PropTypes.number,
    refundVotesNeeded: PropTypes.number,
    refundedCount: PropTypes.number,
    contributorCount: PropTypes.number,
    refundReason: PropTypes.string,
    tokenSymbol: PropTypes.string,
    me: PropTypes.object,
  }).isRequired,
}
