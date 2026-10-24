import { useState } from 'react'
import { isAddress } from 'viem'
import { formatUnits } from '../../lib/evm/units'
import { useOracleConditions } from '../../hooks/useOracleConditions'
import InfoTip from '../ui/InfoTip'

const KIND_LABELS = {
  datafeed:  'Chainlink Data Feed',
  functions: 'Chainlink Functions',
  uma:       'UMA Optimistic Oracle',
}

const KIND_HELP = {
  datafeed:  'Conditions are price-feed predicates pre-registered by an admin (e.g. "ETH/USD > $3000 by 2026-12-31"). Pick one — the wager settles automatically when the deadline passes and the feed crosses the threshold.',
  functions: 'Conditions are Chainlink Functions requests pre-registered by an admin. The DON runs the request after the wager is accepted and reports a boolean outcome.',
  uma:       'Conditions are UMA Optimistic Oracle assertions pre-registered by an admin. Anyone can later post the bond, assert the outcome, and after the liveness window the wager settles.',
}

function shortBytes32(b32) {
  if (!b32 || typeof b32 !== 'string') return ''
  return `${b32.slice(0, 10)}…${b32.slice(-6)}`
}

function isBytes32Hex(s) {
  return /^0x[a-fA-F0-9]{64}$/.test((s || '').trim())
}

function formatTimestamp(secs) {
  if (!secs || secs <= 0) return '—'
  try {
    const d = new Date(Number(secs) * 1000)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch { return '—' }
}

function formatThreshold(bi, decimals = 8) {
  if (bi === undefined || bi === null) return ''
  try {
    return formatUnits(bi, decimals)
  } catch { return String(bi) }
}

/**
 * OracleConditionPicker
 *
 * Drop-in input for the create-wager modal when the resolution type is one of
 * the three oracle-extensible kinds (ChainlinkDataFeed / ChainlinkFunctions /
 * UMA). Lists admin-pre-registered conditions for the adapter so the user
 * picks instead of pasting a raw bytes32. Falls back to a paste-in textbox
 * when no conditions are registered yet OR when the user explicitly opts into
 * manual entry (advanced users debugging or hand-rolling).
 *
 * Props:
 *   kind            'datafeed' | 'functions' | 'uma'
 *   adapterAddress  Adapter contract address (0x...). Falsy ⇒ render an
 *                   error hint that the adapter isn't deployed on this chain.
 *   value           Currently-selected conditionId (bytes32 hex).
 *   onChange(id)    Called when the user picks or pastes a new conditionId.
 *                   `id` is always the trimmed bytes32 hex string (or '' to clear).
 *   error           Optional validation message to display under the picker.
 *   disabled        Disables every interactive element (e.g. while submitting).
 */
function OracleConditionPicker({ kind, adapterAddress, value, onChange, error, disabled = false }) {
  const [manualMode, setManualMode] = useState(false)
  const [pasteValue, setPasteValue] = useState('')

  const { conditions, loading, error: loadError, refresh } = useOracleConditions(adapterAddress, kind)

  if (!adapterAddress || !isAddress(adapterAddress)) {
    return (
      <div className="fm-oracle-picker fm-oracle-picker--unavailable">
        <span className="fm-error">
          {KIND_LABELS[kind] || 'This oracle'} is not deployed on this network.
          Switch chains or pick a different resolution type.
        </span>
      </div>
    )
  }

  const handleSelect = (id) => onChange?.(id)

  const handlePaste = () => {
    const trimmed = (pasteValue || '').trim()
    if (!isBytes32Hex(trimmed)) {
      // Surface inline; the parent modal also re-validates.
      onChange?.(trimmed) // pass through so parent shows its own error
      return
    }
    onChange?.(trimmed)
  }

  return (
    <div className="fm-oracle-picker" data-kind={kind}>
      <InfoTip label="About this oracle condition" className="fm-oracle-picker-help">{KIND_HELP[kind]}</InfoTip>

      {!manualMode && (
        <div className="fm-oracle-picker-list" role="listbox" aria-label="Registered conditions">
          {loading && <div className="fm-oracle-picker-row fm-oracle-picker-row--idle">Loading registered conditions…</div>}
          {!loading && loadError && (
            <div className="fm-oracle-picker-row fm-oracle-picker-row--error">
              <strong>Couldn&apos;t read conditions from chain.</strong> {loadError}
              <button type="button" className="fm-oracle-picker-btn" onClick={refresh} disabled={disabled}>Retry</button>
            </div>
          )}
          {!loading && !loadError && conditions.length === 0 && (
            <div className="fm-oracle-picker-row fm-oracle-picker-row--empty">
              No conditions registered on this adapter yet. Ask an admin to register one in
              <code> /admin → Oracle Adapters</code>, then refresh.
              <button type="button" className="fm-oracle-picker-btn" onClick={refresh} disabled={disabled}>Refresh</button>
            </div>
          )}
          {conditions.map((c) => {
            const selected = value && value.toLowerCase() === c.conditionId.toLowerCase()
            const stale = c.isResolved
            return (
              <button
                key={c.conditionId}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled || stale}
                className={`fm-oracle-picker-row ${selected ? 'is-selected' : ''} ${stale ? 'is-stale' : ''}`}
                onClick={() => handleSelect(c.conditionId)}
                data-testid={`oracle-condition-${c.conditionId}`}
              >
                <div className="fm-oracle-picker-row-head">
                  <code>{shortBytes32(c.conditionId)}</code>
                  {stale && <span className="fm-oracle-picker-badge">resolved — cannot reuse</span>}
                </div>
                {kind === 'datafeed' && c.feed && (
                  <div className="fm-oracle-picker-row-meta">
                    Feed <code>{c.feed.slice(0, 6)}…{c.feed.slice(-4)}</code> {c.opLabel} {formatThreshold(c.threshold)} · settles after {formatTimestamp(c.deadline)}
                  </div>
                )}
                {kind === 'uma' && c.description && (
                  <div className="fm-oracle-picker-row-meta">&ldquo;{c.description}&rdquo;</div>
                )}
                {kind === 'functions' && (
                  <div className="fm-oracle-picker-row-meta">Chainlink Functions request (admin-registered)</div>
                )}
              </button>
            )
          })}
        </div>
      )}

      <div className="fm-oracle-picker-manual-toggle">
        <label className="fm-toggle-label">
          <input
            type="checkbox"
            checked={manualMode}
            onChange={(e) => setManualMode(e.target.checked)}
            disabled={disabled}
          />
          <span>Paste conditionId manually</span>
        </label>
      </div>

      {manualMode && (
        <div className="fm-oracle-picker-manual">
          <label>
            conditionId (bytes32)
            <input
              type="text"
              placeholder="0x + 64 hex chars"
              value={pasteValue}
              onChange={(e) => setPasteValue(e.target.value)}
              disabled={disabled}
            />
          </label>
          <button
            type="button"
            className="fm-oracle-picker-btn primary"
            onClick={handlePaste}
            disabled={disabled || !pasteValue.trim()}
          >Use this conditionId</button>
          {value && (
            <div className="fm-oracle-picker-current">
              Current selection: <code>{shortBytes32(value)}</code>
            </div>
          )}
        </div>
      )}

      {value && !manualMode && (
        <div className="fm-oracle-picker-current">
          Selected: <code>{shortBytes32(value)}</code>{' '}
          <button
            type="button"
            className="fm-oracle-picker-clear"
            onClick={() => handleSelect('')}
            disabled={disabled}
          >Clear</button>
        </div>
      )}

      {error && <span className="fm-error">{error}</span>}
    </div>
  )
}

export default OracleConditionPicker
