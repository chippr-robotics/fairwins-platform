import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useWallet, useWalletNetwork } from '../hooks'
import { useFundingPools } from '../hooks/useFundingPools'
import { parseFundingRef } from '../lib/funding/deepLink'
import { timeLeft } from '../lib/funding/progress'
import { isFundingAvailable } from '../lib/funding/fundingContracts'
import FundingProgress from '../components/funding/FundingProgress'
import RefundStatusBar from '../components/funding/RefundStatusBar'
import FundingActivityFeed from '../components/funding/FundingActivityFeed'
import ContributeControl from '../components/funding/ContributeControl'
import FundingShareView from '../components/funding/FundingShareView'
import '../components/funding/funding.css'

const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '')

/**
 * FundingPoolPage (spec 103) — /fund/:ref, where ref is the four words (hyphen-joined) or the address.
 * Everything shown is a chain read; the four page states are resolving / unreadable / not-found / loaded.
 * Exactly one primary action per state and role (contracts/frontend-surfaces.md).
 */
export default function FundingPoolPage() {
  const { ref } = useParams()
  const { isConnected, address: connectedAddress, openConnectModal } = useWallet()
  const net = useWalletNetwork()
  const pools = useFundingPools()
  const { resolveRef, getSummary, getActivity, contribute, closePool, cancelPool, voteRefund, claimRefund, pokeDeadline, status } = pools

  const [poolAddress, setPoolAddress] = useState(null)
  const [pageState, setPageState] = useState('resolving') // resolving | not-found | unreadable | loaded
  const [error, setError] = useState(null)
  const [summary, setSummary] = useState(null)
  const [feed, setFeed] = useState({ status: 'loading', entries: [] })
  const [notice, setNotice] = useState(null)
  const [confirm, setConfirm] = useState(null) // 'close' | 'cancel' | 'vote' | null
  const [nonce, setNonce] = useState(0)
  // "Now" is sampled per read, not per render (a re-render must not move deadlines), and comes from the
  // chain once a read has landed.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  const parsed = useMemo(() => parseFundingRef(ref), [ref])

  // Resolve the ref → address (words are tried in every language).
  useEffect(() => {
    let alive = true
    setPageState('resolving')
    setError(null)
    if (!parsed) { setPageState('not-found'); return undefined }
    resolveRef(parsed)
      .then((addr) => {
        if (!alive) return
        if (!addr) setPageState('not-found')
        else setPoolAddress(addr)
      })
      .catch((e) => {
        if (!alive) return
        setError(e?.shortMessage || e?.message || String(e))
        setPageState('unreadable')
      })
    return () => { alive = false }
  }, [parsed, resolveRef, nonce])

  const loadFeed = useCallback(async (createdBlock) => {
    if (!poolAddress) return
    setFeed((f) => ({ ...f, status: 'loading' }))
    try {
      const entries = await getActivity(poolAddress, createdBlock)
      setFeed({ status: 'ready', entries })
    } catch {
      setFeed((f) => ({ status: 'error', entries: f.entries }))
    }
  }, [poolAddress, getActivity])

  // One read cycle: the summary (state reads), then the feed (the clone's log). Both are async, so the
  // effect body itself sets nothing.
  const loadSummary = useCallback(async () => {
    if (!poolAddress) return
    try {
      const s = await getSummary(poolAddress)
      // The summary's `now` is the chain's clock (see `chainNow`), the one the contract enforces against.
      setNow(Number(s.now) || Math.floor(Date.now() / 1000))
      setSummary(s)
      setPageState('loaded')
      setError(null)
      loadFeed(s.createdBlock)
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e)
      // An address with no pool code answers empty data: that is "not a pool here", not an outage.
      if (e?.code === 'BAD_DATA' || /could not decode result data/i.test(msg)) {
        setPageState('not-found')
        return
      }
      setError(msg)
      setPageState('unreadable')
    }
  }, [poolAddress, getSummary, loadFeed])

  useEffect(() => { loadSummary() }, [loadSummary, connectedAddress])

  const reload = useCallback(async () => { await loadSummary() }, [loadSummary])

  const run = async (fn) => {
    setNotice(null)
    setConfirm(null)
    try {
      await fn()
      await reload()
    } catch (e) {
      setNotice(e?.shortMessage || e?.message || String(e))
      throw e
    }
  }

  const busy = status !== 'idle' && status !== 'error'
  const walletChainId = net?.chainId != null ? Number(net.chainId) : null
  const wrongNetwork = summary && walletChainId != null && Number(summary.chainId) !== walletChainId

  if (pageState === 'resolving') {
    return (
      <main className="page fp-page" aria-labelledby="fp-h">
        <h1 id="fp-h" className="fp-h1">Pool</h1>
        <p className="fp-muted" role="status">Looking up this pool…</p>
      </main>
    )
  }
  if (pageState === 'not-found') {
    return (
      <main className="page fp-page" aria-labelledby="fp-h">
        <h1 id="fp-h" className="fp-h1">Pool not found</h1>
        <p className="fp-muted" data-testid="funding-not-found">
          {parsed
            ? isFundingAvailable(walletChainId) || walletChainId == null
              ? 'These words (or this address) don’t match a funding pool on this network. Check the link, or switch to the network the pool lives on.'
              : 'Funding pools are not deployed on the network your wallet is on. Switch networks and try again.'
            : 'That link is not a pool link.'}
        </p>
      </main>
    )
  }
  if (pageState === 'unreadable' || !summary) {
    return (
      <main className="page fp-page" aria-labelledby="fp-h">
        <h1 id="fp-h" className="fp-h1">Pool</h1>
        <div className="fp-notice fp-notice--error" role="alert" data-testid="funding-unreadable">
          <span>Could not read this pool from the network{error ? ` — ${error}` : ''}.</span>
          <button type="button" className="fp-link" onClick={() => (poolAddress ? loadSummary() : setNonce((n) => n + 1))} data-testid="funding-retry">Retry</button>
        </div>
      </main>
    )
  }

  const s = summary
  const me = s.me
  const stateChipClass = s.state === 1 ? ' fp-chip--closed' : s.state === 2 ? ' fp-chip--warn' : ''

  return (
    <main className="page fp-page" aria-labelledby="fp-h">
      <header className="fp-head">
        <h1 id="fp-h" className="fp-h1" data-testid="funding-purpose">{s.purpose}</h1>
        <div className="fp-head-meta">
          <span className={`fp-chip${stateChipClass}`} data-testid="funding-state">{s.stateLabel}</span>
          <span>Organized by {s.isOrganizer ? 'you' : s.organizerAlias} · {shortAddr(s.organizer)}</span>
        </div>
      </header>

      <FundingProgress summary={s} now={now} />

      {wrongNetwork && (
        <div className="fp-notice fp-notice--warn" role="alert" data-testid="funding-wrong-network">
          <span>This pool lives on network {s.chainId}; your wallet is on {walletChainId}. Switch networks to act on it.</span>
        </div>
      )}

      {notice && <div className="fp-notice fp-notice--error" role="alert" data-testid="funding-notice">{notice}</div>}

      {/* ── Open: contribute / organizer controls / vote ─────────────────────── */}
      {s.state === 0 && (
        <section className="fp-actions" aria-label="Actions">
          {s.isOrganizer && !wrongNetwork && confirm == null && (
            <div className="fp-actions-row">
              <button type="button" className="fm-btn-primary" data-testid="close-pool" disabled={busy} onClick={() => setConfirm('close')}>
                Close &amp; collect {s.raisedFormatted} {s.tokenSymbol}
              </button>
              <button type="button" className="fm-btn-secondary" data-testid="cancel-pool" disabled={busy} onClick={() => setConfirm('cancel')}>
                Refund everyone
              </button>
            </div>
          )}

          {confirm === 'close' && (
            <div className="fp-confirm" data-testid="confirm-close">
              <div className="fp-confirm-amount">{s.raisedFormatted} {s.tokenSymbol}</div>
              <div className="fp-confirm-row"><span className="k">Goes to</span><span>Your account · {shortAddr(s.organizer)}</span></div>
              <div className="fp-confirm-row"><span className="k">From</span><span>{s.contributorCount} contributor{s.contributorCount === 1 ? '' : 's'}</span></div>
              {!s.goalMet && <div className="fp-confirm-row"><span className="k">Goal</span><span>{s.goalFormatted} {s.tokenSymbol} — not yet met, and that’s allowed</span></div>}
              {s.totalRaised === 0n && <p className="fp-confirm-note">Nothing has been contributed; closing collects nothing and ends the pool.</p>}
              <p className="fp-confirm-note">This is final: no more contributions, votes or refunds after this.</p>
              <div className="fp-actions-row">
                <button type="button" className="fm-btn-primary" data-testid="confirm-close-go" disabled={busy} onClick={() => run(() => closePool(s.address)).catch(() => {})}>
                  {status === 'closing' ? 'Closing…' : 'Close & collect'}
                </button>
                <button type="button" className="fm-btn-secondary" onClick={() => setConfirm(null)}>Back</button>
              </div>
            </div>
          )}

          {confirm === 'cancel' && (
            <div className="fp-confirm" data-testid="confirm-cancel">
              <div className="fp-confirm-amount">{s.raisedFormatted} {s.tokenSymbol}</div>
              <p className="fp-confirm-note">Every contributor gets exactly what they put in, collected by each of them. This is final.</p>
              <div className="fp-actions-row">
                <button type="button" className="fm-btn-primary" data-testid="confirm-cancel-go" disabled={busy} onClick={() => run(() => cancelPool(s.address)).catch(() => {})}>
                  {status === 'cancelling' ? 'Refunding…' : 'Refund everyone'}
                </button>
                <button type="button" className="fm-btn-secondary" onClick={() => setConfirm(null)}>Back</button>
              </div>
            </div>
          )}

          {s.contributionOpen ? (
            !wrongNetwork && (
              <ContributeControl
                summary={s}
                busy={status === 'contributing'}
                isConnected={isConnected}
                onConnect={() => openConnectModal?.()}
                onContribute={(amount) => run(() => contribute(s.address, amount, s))}
              />
            )
          ) : (
            <p className="fp-muted" data-testid="contributions-closed">
              Contributions closed. {s.isOrganizer ? 'You can still close and collect' : 'The organizer can still close and collect'} for{' '}
              {timeLeft(s.settleDeadline, now, 'a little longer')}; after that, refunds open for everyone.
            </p>
          )}

          {me.hasContributed && !wrongNetwork && confirm == null && (
            me.voted ? (
              <p className="fp-muted" data-testid="voted">You voted to refund.</p>
            ) : (
              <button type="button" className="fm-btn-secondary" data-testid="vote-refund" disabled={busy} onClick={() => setConfirm('vote')}>
                Vote to refund everyone
              </button>
            )
          )}
          {confirm === 'vote' && (
            <div className="fp-confirm" data-testid="confirm-vote">
              <p className="fp-confirm-note">
                When more than half of the contributors have voted, the pool refunds and everyone collects their own contribution. The organizer can still close and collect until then.
              </p>
              <div className="fp-actions-row">
                <button type="button" className="fm-btn-primary" data-testid="confirm-vote-go" disabled={busy} onClick={() => run(() => voteRefund(s.address)).catch(() => {})}>
                  {status === 'voting' ? 'Voting…' : 'Cast my vote'}
                </button>
                <button type="button" className="fm-btn-secondary" onClick={() => setConfirm(null)}>Back</button>
              </div>
            </div>
          )}

          {s.canPokeDeadline && !wrongNetwork && (
            <button type="button" className="fm-btn-secondary" data-testid="poke-deadline" disabled={busy} onClick={() => run(() => pokeDeadline(s.address)).catch(() => {})}>
              {status === 'poking' ? 'Starting refunds…' : 'Start refunds (deadline passed)'}
            </button>
          )}
        </section>
      )}

      {/* ── Closed ─────────────────────────────────────────────────────────────── */}
      {s.state === 1 && (
        <p className="fp-muted" data-testid="funding-closed">
          {s.totalRaised > 0n
            ? `Closed — ${s.raisedFormatted} ${s.tokenSymbol} was collected by ${s.isOrganizer ? 'you' : 'the organizer'}.`
            : 'Closed with nothing contributed.'}
        </p>
      )}

      {/* ── Refunding ──────────────────────────────────────────────────────────── */}
      {s.state === 2 && me.canClaimRefund && !wrongNetwork && (
        <button type="button" className="fm-btn-primary fp-primary" data-testid="claim-refund" disabled={busy} onClick={() => run(() => claimRefund(s.address)).catch(() => {})}>
          {status === 'refunding' ? 'Collecting…' : `Collect my ${me.contributedFormatted} ${s.tokenSymbol} back`}
        </button>
      )}

      <RefundStatusBar summary={s} />

      <FundingShareView phrase={s.phrase} address={s.address} compact title="Share" />

      <FundingActivityFeed
        entries={feed.entries}
        status={feed.status}
        onRetry={() => loadFeed(s.createdBlock)}
        tokenDecimals={s.tokenDecimals}
        tokenSymbol={s.tokenSymbol}
        account={connectedAddress}
      />
    </main>
  )
}
