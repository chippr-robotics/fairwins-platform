import { useState } from 'react'
import PropTypes from 'prop-types'
import { useNavigate } from 'react-router-dom'
import AmountKeypad from '../ui/AmountKeypad'
import PillSelect from '../ui/PillSelect'
import InfoTip from '../ui/InfoTip'
import FundingShareView from './FundingShareView'
import { useFundingPools } from '../../hooks/useFundingPools'
import { WINDOW_CHOICES, DEFAULT_WINDOW_ID, PURPOSE_MAX, validateCreate } from '../../lib/funding/progress'
import './funding.css'

/**
 * FundingPoolCreatePanel (spec 103, US1) — the Pool kind of the Request view. Purpose, goal (number pad),
 * contribution window, one primary action; then the share view. The one-time request form beside it is
 * untouched (FR-001).
 */
export default function FundingPoolCreatePanel({ isConnected, onConnect, onOpenMyPools, tokenSymbol = 'USDC' }) {
  const { createPool, status, error, available } = useFundingPools()
  const navigate = useNavigate()
  const [purpose, setPurpose] = useState('')
  const [goal, setGoal] = useState('')
  const [windowId, setWindowId] = useState(DEFAULT_WINDOW_ID)
  const [result, setResult] = useState(null)
  const [formError, setFormError] = useState(null)

  const creating = status === 'creating'
  const validation = validateCreate({ purpose, goal })
  const purposeBytes = new TextEncoder().encode(purpose).length
  const canCreate = !validation && isConnected && !creating && available()

  const onSubmit = async (e) => {
    e.preventDefault()
    setFormError(null)
    if (validation) { setFormError(validation); return }
    try {
      // The decimal string goes through untouched: `Number()` would round a long decimal and can render
      // as scientific notation, which parseUnits refuses. `validateCreate` already vetted it.
      const res = await createPool({ purpose, goal: String(goal).trim(), windowId })
      setResult(res)
    } catch {
      /* surfaced via hook error */
    }
  }

  if (result) {
    return (
      <div className="fm-success fp-create" data-testid="funding-created">
        <div className="fm-success-icon" aria-hidden="true">&#127881;</div>
        <h3>Pool created</h3>
        <p className="fm-success-desc">
          Send the link — anyone who opens it sees “{purpose.trim()}”, the goal and how far along it is, and can chip in.
        </p>
        {result.pool ? (
          <FundingShareView phrase={result.phrase} address={result.pool} />
        ) : (
          <div className="fp-notice fp-notice--warn" role="alert">
            The pool was submitted but its receipt has not landed yet. Open My Pools in a moment — it will be listed there.
          </div>
        )}
        <div className="fm-success-actions">
          {result.pool && (
            <button type="button" className="fm-btn-primary fm-success-done" data-testid="open-my-pool" onClick={() => navigate(`/fund/${result.pool}`)}>
              Open my pool
            </button>
          )}
          <button type="button" className="fm-btn-secondary" onClick={() => { setResult(null); setPurpose(''); setGoal('') }}>
            Start another
          </button>
        </div>
      </div>
    )
  }

  return (
    <form className="fm-form fm-pay-form fp-create" onSubmit={onSubmit} data-testid="funding-create-form">
      <div className="fm-pay-hero">
        <AmountKeypad
          value={goal}
          onChange={(v) => { setGoal(v); setFormError(null) }}
          prefix="$"
          token={tokenSymbol}
          disabled={creating}
          ariaLabel="Goal amount"
          id="funding-goal"
        />
      </div>

      <div className="fm-pay-details">
        <div className="fp-field">
          <label htmlFor="funding-purpose">What is it for? <span className="fm-required">*</span></label>
          <input
            id="funding-purpose"
            type="text"
            maxLength={PURPOSE_MAX}
            placeholder="e.g. Dana's surprise party"
            value={purpose}
            onChange={(e) => { setPurpose(e.target.value); setFormError(null) }}
            disabled={creating}
            required
          />
          <span className="fp-counter" aria-live="polite">{purposeBytes}/{PURPOSE_MAX}</span>
        </div>

        <div className="fp-field">
          <PillSelect
            label={<>Open for contributions <span className="fm-required">*</span></>}
            options={WINDOW_CHOICES.map((c) => ({ value: c.id, label: c.label }))}
            value={windowId}
            onChange={setWindowId}
            disabled={creating}
            info={(
              <InfoTip label="About the contribution window">
                People can chip in until then. You can close and collect at any time — before or after — and you have 30 more days
                after it to do so; if you never close, everyone can take their money back.
              </InfoTip>
            )}
          />
        </div>

        <p className="fm-pay-acting-note fp-public-note" role="note">
          <span>The purpose and goal are public on-chain and shown to anyone with the link — don’t put private details in them.</span>
        </p>
      </div>

      {!available() && isConnected && (
        <div className="fm-error-banner" role="alert" data-testid="funding-unavailable">
          Funding pools are not available on this network yet. Switch to a network where they are deployed.
        </div>
      )}
      {(formError || error) && <div className="fm-error-banner" role="alert" data-testid="funding-error">{formError || error}</div>}

      <div className="fm-success-actions">
        {!isConnected ? (
          <button type="button" className="fm-btn-primary" onClick={onConnect}>Connect wallet</button>
        ) : (
          <button type="submit" className="fm-btn-primary" data-testid="funding-create" disabled={!canCreate}>
            {creating ? 'Creating…' : 'Create pool'}
          </button>
        )}
        <button type="button" className="fm-btn-secondary" data-testid="my-pools-open" onClick={onOpenMyPools}>
          My Pools
        </button>
      </div>
    </form>
  )
}

FundingPoolCreatePanel.propTypes = {
  isConnected: PropTypes.bool,
  onConnect: PropTypes.func,
  onOpenMyPools: PropTypes.func,
  tokenSymbol: PropTypes.string,
}
