import { useState } from 'react'
import PropTypes from 'prop-types'
import { useNavigate } from 'react-router-dom'
import ActionSheet from '../account/ActionSheet'
import FundingProgress from './FundingProgress'
import { useMyFundingPools } from '../../hooks/useMyFundingPools'
import { useFundingPools } from '../../hooks/useFundingPools'
import { parseFundingRef } from '../../lib/funding/deepLink'
import './funding.css'

const ROLE_LABEL = { organizer: 'Organizer', contributor: 'Contributor', both: 'Organizer · contributor' }
const ACTION_LABEL = { collect: 'Collect refund', close: 'Close & collect', contribute: 'Contribute', vote: 'Vote to refund', poke: 'Start refunds', share: 'Share' }

/**
 * MyFundingPoolsSheet (spec 103, US6 / FR-022) — the "My Pools" bottom sheet, built on the shared
 * ActionSheet (focus trap, Escape, backdrop, mobile rise). Lists the pools this device organized or
 * contributed to, grouped Active / Finished, each with its one next action; a find field at the top
 * opens a pool by its four words or its link. Unreadable rows are shown as unreadable, never dropped.
 */
export default function MyFundingPoolsSheet({ open, onClose, onStartPool }) {
  const navigate = useNavigate()
  const { items, loading, refresh } = useMyFundingPools({ enabled: open })
  const { resolveRef } = useFundingPools()
  const [find, setFind] = useState('')
  const [findError, setFindError] = useState(null)
  const [finding, setFinding] = useState(false)

  const go = (address) => { onClose(); navigate(`/fund/${address}`) }

  const onFind = async (e) => {
    e.preventDefault()
    setFindError(null)
    const ref = parseFundingRef(find)
    if (!ref) { setFindError('Enter the four words or paste the pool link.'); return }
    setFinding(true)
    try {
      const addr = await resolveRef(ref)
      if (!addr) { setFindError('Those words don’t match a pool on this network.'); return }
      go(addr)
    } catch (err) {
      setFindError(err?.shortMessage || err?.message || 'Could not look that up right now.')
    } finally {
      setFinding(false)
    }
  }

  const active = items.filter((it) => it.bucket === 'active')
  const finished = items.filter((it) => it.bucket === 'finished')

  const renderRow = (it) => (
    <li key={it.address} className="fp-sheet-row" data-testid="my-pools-row" data-state={it.readable ? it.state : 'unreadable'}>
      <div className="fp-sheet-row-head">
        <button type="button" className="fp-sheet-row-title" onClick={() => go(it.address)} aria-label={`Open ${it.readable ? it.purpose : 'pool'}`}>
          {it.readable ? it.purpose : `Pool ${it.address.slice(0, 6)}…${it.address.slice(-4)}`}
        </button>
        {it.readable ? (
          <span className={`fp-chip${it.state === 1 ? ' fp-chip--closed' : it.state === 2 ? ' fp-chip--warn' : ''}`}>{it.stateLabel}</span>
        ) : (
          <span className="fp-chip fp-chip--warn">Could not read</span>
        )}
      </div>
      {it.readable && (
        <>
          <FundingProgress summary={{ ...it, goalMet: it.progressPct >= 100 }} compact />
          <div className="fp-sheet-row-meta">
            <span>{ROLE_LABEL[it.role] || 'Contributor'}</span>
          </div>
          {it.nextAction && (
            <button type="button" className="fm-btn-secondary fp-sheet-row-action" onClick={() => go(it.address)} data-testid={`my-pools-action-${it.nextAction}`}>
              {ACTION_LABEL[it.nextAction]}
            </button>
          )}
        </>
      )}
      {!it.readable && (
        <div className="fp-sheet-row-meta">
          <span>This pool could not be read from the network.</span>
          <button type="button" className="fp-link" onClick={refresh}>Retry</button>
        </div>
      )}
    </li>
  )

  return (
    <ActionSheet open={open} onClose={onClose} title="My Pools" className="fp-sheet">
      <form className="fp-sheet-find" onSubmit={onFind}>
        <label className="sr-only" htmlFor="my-pools-find">Four words or a pool link</label>
        <input
          id="my-pools-find"
          type="text"
          placeholder="Four words or a pool link"
          value={find}
          onChange={(e) => { setFind(e.target.value); setFindError(null) }}
          data-testid="my-pools-find"
          autoComplete="off"
        />
        <button type="submit" className="fm-btn-secondary" disabled={finding || !find.trim()} data-testid="my-pools-find-go">
          {finding ? 'Looking…' : 'Open'}
        </button>
      </form>
      {findError && <div className="fp-notice fp-notice--warn" role="alert" data-testid="my-pools-find-error">{findError}</div>}

      {loading && items.length === 0 && <p className="fp-muted" role="status">Loading your pools…</p>}

      {!loading && items.length === 0 && (
        <div className="fp-sheet-empty" data-testid="my-pools-empty">
          <p className="fp-muted">You haven’t organized or contributed to a pool on this device yet.</p>
          <button type="button" className="fm-btn-primary" onClick={() => { onClose(); onStartPool?.() }}>Start a pool</button>
        </div>
      )}

      {active.length > 0 && (
        <section className="fp-sheet-section" aria-label="Active pools">
          <h4 className="fp-h2">Active</h4>
          <ul className="fp-sheet-list">{active.map(renderRow)}</ul>
        </section>
      )}
      {finished.length > 0 && (
        <section className="fp-sheet-section" aria-label="Finished pools">
          <h4 className="fp-h2">Finished</h4>
          <ul className="fp-sheet-list">{finished.map(renderRow)}</ul>
        </section>
      )}
    </ActionSheet>
  )
}

MyFundingPoolsSheet.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  onStartPool: PropTypes.func,
}
