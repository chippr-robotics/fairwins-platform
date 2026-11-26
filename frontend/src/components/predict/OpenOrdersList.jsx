/**
 * OpenOrdersList (spec 057 US3) — the connected wallet's open (unfilled) CLOB orders, each cancellable
 * via a gas-free cancel through usePredictTrade. On cancel the list refreshes. The list refreshes on its own while
 * the tab is visible (no Refresh button); a failed background refresh keeps the last list and says so.
 */
import { usePredictOpenOrders } from '../../hooks/usePredictPortfolio'
import { usePredictTrade } from '../../hooks/usePredictTrade'
import { asDecimal, toMicro, fromMicro } from '../../lib/predict/orderProgress'
import './OpenOrdersList.css'

/**
 * What the venue's own order object says, in the words this row uses. The SDK returns `id`, `original_size` and
 * `size_matched`; an already-normalised `{ orderId, size, remaining }` is read as it is. A figure the venue did not
 * state is null and prints as "—", never as a guessed 0.
 */
function describeOpenOrder(o) {
  const size = asDecimal(o?.size ?? o?.original_size)
  let remaining = asDecimal(o?.remaining)
  if (remaining == null && size != null) {
    const matched = toMicro(asDecimal(o?.size_matched) ?? '')
    const total = toMicro(size)
    if (matched != null && total != null && matched <= total) remaining = fromMicro(total - matched)
  }
  return { id: o?.orderId ?? o?.id ?? null, size, remaining, price: asDecimal(o?.price) ?? null }
}

export default function OpenOrdersList() {
  const { status, orders, refresh, stale } = usePredictOpenOrders()
  const trade = usePredictTrade()
  const busy = trade.status === 'submitting'

  // Hidden entirely when unsupported/disconnected — the parent panel handles those states.
  if (status === 'unsupported' || status === 'disconnected') return null
  // Nothing to show for the empty/loading-with-no-orders case keeps the panel quiet.
  if (status === 'empty' || status === 'loading') return null

  const onCancel = async (order) => {
    const res = await trade.cancel(order)
    if (res) refresh()
  }

  return (
    <section className="predict-orders" aria-label="Open orders">
      <div className="predict-orders-header">
        <h4>Open orders</h4>
      </div>
      {stale && (
        <p className="predict-orders-status" role="status">
          Couldn&apos;t refresh your open orders just now. This is the last list we read.
        </p>
      )}

      {status === 'locked' ? (
        // Reading open orders needs the member's trading session, and this list never asks for a signature
        // just to read. A heading with nothing under it said neither "none" nor "not read".
        <p className="predict-orders-status" role="status">
          Sign in to trading to see your open orders. This list does not ask for a signature itself.
        </p>
      ) : status === 'degraded' ? (
        <p className="predict-orders-status" role="status">
          Order data is temporarily unavailable.
        </p>
      ) : (
        <ul className="predict-orders-list">
          {orders.map((raw) => {
            const o = describeOpenOrder(raw)
            return (
            <li key={o.id} className="predict-order">
              <span className="predict-order-side" data-side={raw.side}>
                {raw.side}
              </span>
              <span className="predict-order-detail">
                {o.remaining ?? '—'}/{o.size ?? '—'} @ {o.price ?? '—'}
              </span>
              <button type="button" className="predict-order-cancel" disabled={busy} onClick={() => onCancel(raw)}>
                {busy ? 'Cancelling…' : 'Cancel'}
              </button>
            </li>
            )
          })}
        </ul>
      )}

      {trade.status === 'error' && (
        <p className="predict-orders-status" role="alert">
          {trade.reason}
        </p>
      )}
    </section>
  )
}
