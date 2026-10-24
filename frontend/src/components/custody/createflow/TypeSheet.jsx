// Spec 105 US1 sheet 1 — "choose how it works". Three plain-language presets resolve to owners +
// how many must sign; nobody is asked to invent a bare threshold unless they chose Complex. The
// existing 1-of-1-no-rules refusal is enforced at the flow level (CreateVaultFlow), not here.

import PropTypes from 'prop-types'
import { suggestedThreshold } from '../../../lib/custody/safeVault'
import CustodyAddressField from '../CustodyAddressField'
import { PRESETS } from './createFlowModel'

export default function TypeSheet({
  presetType,
  onPreset,
  owners,
  onOwners,
  chosenThreshold,
  onThreshold,
  connectedAddress,
  chainId,
  label,
  onLabel,
  error,
  onNext,
  onBack,
}) {
  const updateOwner = (i, val) => onOwners(owners.map((o, idx) => (idx === i ? val : o)))
  const addOwner = () => onOwners([...owners, ''])
  const removeOwner = (i) => onOwners(owners.filter((_, idx) => idx !== i))
  const ownerCount = owners.map((o) => o.trim()).filter(Boolean).length
  // Joint is exactly two owners; the other presets grow the list freely.
  const fixedTwo = presetType === 'joint'
  const visibleOwners = fixedTwo ? [...owners, '', ''].slice(0, 2) : owners

  return (
    <div className="create-flow__step" data-testid="create-step-type">
      <p className="create-flow__kicker">Choose how it works</p>
      <div className="create-flow__presets" role="radiogroup" aria-label="Vault type">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={presetType === p.id}
            className={`create-flow__preset${presetType === p.id ? ' is-selected' : ''}`}
            onClick={() => onPreset(p.id)}
          >
            <span className="create-flow__preset-title">{p.title}</span>
            <span className="create-flow__preset-blurb">{p.blurb}</span>
          </button>
        ))}
      </div>

      <fieldset className="create-flow__owners">
        <legend>Owners</legend>
        {visibleOwners.map((owner, i) => (
          <div className="custody-owner-row" key={i}>
            <CustodyAddressField
              id={`create-owner-${i}`}
              label={`Owner ${i + 1} address`}
              srOnlyLabel
              value={owner}
              onChange={(next) => updateOwner(i, next)}
              chainId={chainId}
              selfAddress={i === 0 ? connectedAddress : null}
            />
            {!fixedTwo && owners.length > 1 && (
              <button type="button" onClick={() => removeOwner(i)} aria-label={`Remove owner ${i + 1}`}>
                Remove
              </button>
            )}
          </div>
        ))}
        {!fixedTwo && (
          <button type="button" className="create-flow__add-owner" onClick={addOwner}>
            Add owner
          </button>
        )}
      </fieldset>

      {presetType === 'complex' && (
        <label className="create-flow__threshold">
          Approvals required (threshold)
          <input
            type="number"
            min="1"
            max={Math.max(1, ownerCount)}
            value={chosenThreshold ?? suggestedThreshold(ownerCount)}
            onChange={(e) => onThreshold(Number(e.target.value))}
          />
        </label>
      )}
      {presetType === 'controlled' && ownerCount > 0 && (
        <p className="custody-hint">All {ownerCount} owner{ownerCount === 1 ? '' : 's'} must sign every move.</p>
      )}

      {error && (
        <p className="create-flow__error" role="alert">
          {error}
        </p>
      )}

      <label className="create-flow__label-field" htmlFor="create-vault-label">
        Label (private, on this device)
        <input id="create-vault-label" value={label} onChange={(e) => onLabel(e.target.value)} />
      </label>

      <p className="create-flow__note">You can add owners and change this later.</p>
      <div className="create-flow__nav">
        {onBack && (
          <button type="button" onClick={onBack}>
            Back
          </button>
        )}
        <button type="button" className="create-flow__primary" onClick={onNext}>
          Next: set rules
        </button>
      </div>
    </div>
  )
}

TypeSheet.propTypes = {
  presetType: PropTypes.oneOf(['joint', 'controlled', 'complex']).isRequired,
  onPreset: PropTypes.func.isRequired,
  owners: PropTypes.arrayOf(PropTypes.string).isRequired,
  onOwners: PropTypes.func.isRequired,
  chosenThreshold: PropTypes.number,
  onThreshold: PropTypes.func.isRequired,
  connectedAddress: PropTypes.string,
  chainId: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  label: PropTypes.string,
  onLabel: PropTypes.func,
  error: PropTypes.string,
  onNext: PropTypes.func.isRequired,
  onBack: PropTypes.func,
}
