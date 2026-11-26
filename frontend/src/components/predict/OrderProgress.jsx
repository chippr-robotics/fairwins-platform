/**
 * OrderProgress (spec 114 slice 6, FR-023 and FR-024) — where each of the member's orders is, after signing.
 *
 * Everything on screen is the venue's word or the chain's, never ours:
 *  - "Matched" is Polymarket's; "settled" is the chain's. The app reads Polymarket, not the chain, for a
 *    matched order, so the steps stop at matched and say settlement happens on chain — `settled` appears only
 *    if something that did read the chain says so.
 *  - An order whose answer never arrived is "not confirmed yet", NEVER a failure, and nothing on this component
 *    offers to send it again — it says not to, and that the app is looking it up.
 *  - No figure is invented: a fill the venue has not reported is simply not shown.
 *
 * Accessibility: each order's state sentence is its own live region (`role="status"`, polite) so a change is
 * announced without the member acting; an ending that needs attention (nothing placed, rejected, failed) is
 * `role="alert"`. The steps are an ordered list and the current one is marked in TEXT ("Current step"), not by
 * colour alone.
 */
import { useId } from 'react'
import { describeOrder, stateSentence } from '../../lib/predict/orderWords'
import { isTerminal } from '../../lib/predict/orderProgress'
import './OrderProgress.css'

const POLYMARKET_URL = 'https://polymarket.com'
const MAX_SHOWN = 6

/** The path of an order that is still on its way, in the words a member would use. */
const STEPS = [
  ['sent', 'Sent to Polymarket'],
  ['resting', 'Waiting on the order book'],
  ['partial', 'Partly matched'],
  ['matched', 'Matched by Polymarket'],
  ['settled', 'Settled on chain'],
]
const ENDINGS = { cancelled: 'Cancelled', expired: 'Expired', rejected: 'Refused', 'not-delivered': 'Not placed', failed: 'Settlement failed' }
const ATTENTION = new Set(['rejected', 'not-delivered', 'failed'])

function Steps({ record }) {
  const reached = STEPS.findIndex(([s]) => s === record.state)
  // A matched order stands at "Matched"; "Settled on chain" is shown as what comes next, because it is.
  const items = record.state === 'unconfirmed' ? [['unconfirmed', 'Sent — not confirmed']] : STEPS
  return (
    <ol className="order-progress-steps">
      {items.map(([s, label], i) => {
        const here = record.state === 'unconfirmed' ? true : i === reached
        const done = record.state !== 'unconfirmed' && reached > i
        return (
          <li key={s} className="order-progress-step" data-here={here || undefined} data-done={done || undefined} aria-current={here ? 'step' : undefined}>
            {label}
            <span className="order-progress-step-mark">{here ? ' (current step)' : done ? ' (done)' : ''}</span>
          </li>
        )
      })}
    </ol>
  )
}

function Row({ record, onDismiss }) {
  const sentence = stateSentence(record)
  const ended = ENDINGS[record.state]
  const attention = ATTENTION.has(record.state)
  const onPath = STEPS.some(([s]) => s === record.state) || record.state === 'unconfirmed' || record.state === 'signed'
  const showLink = record.state === 'unconfirmed' || record.state === 'not-delivered'
  return (
    <li className="order-progress-order" data-state={record.state}>
      <p className="order-progress-title">{describeOrder(record)}</p>
      {onPath ? <Steps record={record} /> : ended ? <p className="order-progress-ending">{ended}</p> : null}
      <p className="order-progress-sentence" role={attention ? 'alert' : 'status'}>
        {sentence}
      </p>
      {showLink && (
        <a className="order-progress-link" href={POLYMARKET_URL} target="_blank" rel="noopener noreferrer">
          Check on Polymarket ↗
        </a>
      )}
      {isTerminal(record.state) && onDismiss && (
        <button type="button" className="order-progress-dismiss" onClick={() => onDismiss(record.orderId)}>
          Dismiss
        </button>
      )}
    </li>
  )
}

/**
 * @param {{ orders: object[], locked?: boolean, unreadable?: boolean, onDismiss?: (orderId: string) => void }} props
 *   `orders` — records from usePredictOrders. `locked` — tracked orders but no trading session to ask the venue
 *   with. `unreadable` — the last round could not read Polymarket (nothing changed because of it).
 */
export default function OrderProgress({ orders = [], locked = false, unreadable = false, onDismiss }) {
  const titleId = useId()
  if (!orders.length) return null
  const shown = orders.slice(0, MAX_SHOWN)
  return (
    <section className="order-progress" aria-labelledby={titleId}>
      <h4 id={titleId}>Your orders in progress</h4>
      {locked && (
        <p className="order-progress-note" role="status">
          Sign in to trading to see where your orders are. This list does not ask for a signature itself.
        </p>
      )}
      {!locked && unreadable && (
        <p className="order-progress-note" role="status">
          Couldn&apos;t reach Polymarket just now. What is shown is the last thing it reported; it will keep trying.
        </p>
      )}
      <ul className="order-progress-list">
        {shown.map((r) => (
          <Row key={r.orderId} record={r} onDismiss={onDismiss} />
        ))}
      </ul>
      {orders.length > shown.length && <p className="order-progress-note">{orders.length - shown.length} older orders are not shown.</p>}
    </section>
  )
}
