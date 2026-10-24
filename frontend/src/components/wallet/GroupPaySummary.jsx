import { describeRail } from '../../lib/payments/groupPay'
import { GROUP_OUTCOME } from '../../hooks/useGroupPay'
import './GroupPay.css'

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

const STATUS_LABEL = {
  [GROUP_OUTCOME.SENT]: 'Sent',
  [GROUP_OUTCOME.PENDING]: 'Submitted',
  [GROUP_OUTCOME.PROPOSED]: 'Proposed',
  [GROUP_OUTCOME.FAILED]: 'Failed',
  [GROUP_OUTCOME.SKIPPED]: 'Skipped',
}

/**
 * The group confirm: what leaves, who gets it, how it is submitted and who pays the fee.
 *
 * Everything here is derived from the rail actually selected — the fee line never says "gasless"
 * unless the batch is genuinely sponsored, and the atomicity line says which of "all or nothing"
 * and "one failure does not stop the rest" is true for THIS submission, because a member's
 * expectation of what a partial failure means is the thing most likely to be wrong.
 */
export function GroupPayBreakdown({ recipients = [], total, symbol = '', networkName, rail, gasless = false, nativeSymbol = '', batchSupport = null }) {
  // Issue #1368 — `batchSupport` is the vault's OWN guard's answer about a MultiSend delegatecall.
  // It changes the submission, fee and outcome lines, so the member reads the shape they will get.
  const d = describeRail(rail, { count: recipients.length, gasless, nativeSymbol, batchSupport })
  return (
    <div className="gp-confirm" data-testid="group-pay-confirm" aria-live="polite">
      <div className="gp-breakdown" data-testid="group-pay-breakdown">
        {recipients.map((r) => (
          <div className="gp-breakdown-row" data-testid="group-pay-breakdown-row" key={r.id}>
            <span className="gp-to">{short(r.address)}</span>
            <span>{r.amount} {symbol}</span>
          </div>
        ))}
      </div>
      <div className="gp-total" data-testid="group-pay-total">
        <span>Total</span>
        <span>{total} {symbol}</span>
      </div>
      <div className="pay-confirm-row"><span className="k">Network</span><span className="v">{networkName}</span></div>
      <div className="gp-note" data-testid="group-pay-rail" data-shape={d.shape || undefined}>
        <div>{d.submissionLine}</div>
        <div>{d.feeLine}</div>
        <div>{d.outcomeLine}</div>
      </div>
    </div>
  )
}

/** One line per recipient, after the fact. A failure or a skip is named, never rolled into a total. */
export function GroupPayOutcomes({ outcomes = [], summary, symbol = '', onDone }) {
  const parts = []
  if (summary?.sent) parts.push(`${summary.sent} sent`)
  if (summary?.proposed) parts.push(`${summary.proposed} proposed`)
  if (summary?.pending) parts.push(`${summary.pending} still confirming`)
  if (summary?.failed) parts.push(`${summary.failed} failed`)
  if (summary?.skipped) parts.push(`${summary.skipped} skipped`)

  return (
    <div className="gp-outcomes" data-testid="group-pay-outcomes" aria-live="polite">
      <div className="gp-total" data-testid="group-pay-summary">
        <span>{`${summary?.total ?? outcomes.length} payments`}</span>
        <span>{parts.join(', ')}</span>
      </div>
      {outcomes.map((o) => (
        <div className="gp-outcome" data-testid="group-pay-outcome" key={o.id}>
          <span className="gp-to">{short(o.address)}</span>
          <span>{o.amount} {o.symbol || symbol}</span>
          <span className="gp-outcome-status">{STATUS_LABEL[o.status] || o.status}</span>
          {o.reason && <span className="gp-outcome-reason">{o.reason}</span>}
        </div>
      ))}
      {onDone && (
        <div className="pay-confirm-actions">
          <button type="button" className="fm-btn-primary" onClick={onDone}>Done</button>
        </div>
      )}
    </div>
  )
}

export default GroupPayBreakdown
