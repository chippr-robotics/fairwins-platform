import PropTypes from 'prop-types'
import { formatAmount } from '../../lib/funding/progress'
import { REFUND_REASON_TEXT } from '../../lib/funding/fundingContracts'

const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '')

function when(ts) {
  if (!ts) return ''
  try {
    return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return ''
  }
}

function sentence(entry, decimals, symbol, account) {
  const isMe = account && entry.actor && entry.actor.toLowerCase() === String(account).toLowerCase()
  const who = isMe ? 'You' : entry.alias || shortAddr(entry.actor)
  switch (entry.kind) {
    case 'contribute':
      return `${who} contributed ${formatAmount(entry.amount, decimals)} ${symbol}`
    case 'close':
      return `${isMe ? 'You' : 'The organizer'} closed the pool and collected ${formatAmount(entry.amount, decimals)} ${symbol}`
    case 'vote':
      return `${who} voted to refund (${entry.votes} of ${entry.needed})`
    case 'refunding':
      return `Refunding started — ${entry.reason ? REFUND_REASON_TEXT[entry.reason] : 'refunds are open'}`
    case 'refund':
      return `${who} collected ${formatAmount(entry.amount, decimals)} ${symbol} back`
    default:
      return ''
  }
}

/**
 * FundingActivityFeed (spec 103, FR-009) — the shared, chain-derived activity list. Three honest
 * states: loading, unreadable (sentence + live retry), and the list (or its empty sentence).
 */
export default function FundingActivityFeed({ entries, status, onRetry, tokenDecimals, tokenSymbol, account }) {
  return (
    <section className="fp-feed" aria-label="Activity" data-testid="funding-feed">
      <h2 className="fp-h2">Activity</h2>
      {status === 'loading' && <p className="fp-muted" role="status">Loading activity…</p>}
      {status === 'error' && (
        <div className="fp-notice fp-notice--warn" role="alert">
          <span>Could not load the activity feed from this network.</span>
          <button type="button" className="fp-link" onClick={onRetry} data-testid="feed-retry">Retry</button>
        </div>
      )}
      {status === 'ready' && entries.length === 0 && (
        <p className="fp-muted" data-testid="feed-empty">No contributions yet. Share the link to get things started.</p>
      )}
      {status === 'ready' && entries.length > 0 && (
        <ol className="fp-feed-list">
          {entries.map((e) => (
            <li key={`${e.txHash}-${e.logIndex}`} className={`fp-feed-item fp-feed-item--${e.kind}`} data-testid="feed-entry">
              <span className={`fp-feed-dot fp-feed-dot--${e.kind}`} aria-hidden="true" />
              <span className="fp-feed-text">{sentence(e, tokenDecimals, tokenSymbol, account)}</span>
              <time className="fp-feed-when" dateTime={e.timestamp ? new Date(e.timestamp * 1000).toISOString() : undefined}>
                {when(e.timestamp)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

FundingActivityFeed.propTypes = {
  entries: PropTypes.array,
  status: PropTypes.oneOf(['loading', 'error', 'ready']).isRequired,
  onRetry: PropTypes.func,
  tokenDecimals: PropTypes.number,
  tokenSymbol: PropTypes.string,
  account: PropTypes.string,
}
FundingActivityFeed.defaultProps = { entries: [], tokenDecimals: 6, tokenSymbol: 'USDC', onRetry: () => {}, account: null }
