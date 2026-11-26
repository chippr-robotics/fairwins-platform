/**
 * OpenOrdersList (spec 057 US3) — the connected wallet's open (unfilled) CLOB orders, each cancellable
 * via a gas-free cancel through usePredictTrade. On cancel the list refreshes. The list refreshes on its own while
 * the tab is visible (no Refresh button); a failed background refresh keeps the last list and says so.
 */
import { usePredictOpenOrders } from '../../hooks/usePredictPortfolio'
import { usePredictTrade } from '../../hooks/usePredictTrade'
import './OpenOrdersList.css'

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

      {status === 'degraded' ? (
        <p className="predict-orders-status" role="status">
          Order data is temporarily unavailable.
        </p>
      ) : (
        <ul className="predict-orders-list">
          {orders.map((o) => (
            <li key={o.orderId} className="predict-order">
              <span className="predict-order-side" data-side={o.side}>
                {o.side}
              </span>
              <span className="predict-order-detail">
                {o.remaining}/{o.size} @ {o.price ?? '—'}
              </span>
              <button type="button" className="predict-order-cancel" disabled={busy} onClick={() => onCancel(o)}>
                {busy ? 'Cancelling…' : 'Cancel'}
              </button>
            </li>
          ))}
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
