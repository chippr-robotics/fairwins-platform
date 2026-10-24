// Spec 105 US1 sheet 3 (also the deploy-later surface, FR-015) — pick networks, watch the app
// orchestrate. The selection is the build cohort's custody networks; the predicted address — the
// SAME on every network — renders before any signature (FR-007). Per-network status comes from the
// deployment hook's reducer; a rail that cannot act on a chain is stated in place BEFORE anything
// is attempted, one network failing never touches another, and leaving loses nothing (FR-008/009).

import PropTypes from 'prop-types'
import NetworkPill from '../../ui/NetworkPill'
import { chainDisplayName } from '../../../lib/custody/chainName'
import { DEPLOY_STATUS, RULES_STATUS } from '../../../lib/custody/vaultDeployment'
import { statusLabelFor } from './createFlowModel'

export default function NetworksSheet({
  availableChainIds,
  selected,
  onToggle,
  byChain,
  predictedAddress,
  running,
  started,
  railFor,
  onDeploy,
  onRetry,
  onBack,
  onDone,
  deployLabel = 'Deploy vault',
}) {
  const selectable = !started && !running
  const rows = started ? selected : availableChainIds
  const doneCount = selected.filter((id) => {
    const s = byChain[id]?.status
    return s === DEPLOY_STATUS.LIVE || s === DEPLOY_STATUS.ALREADY_LIVE
  }).length

  return (
    <div className="create-flow__step" data-testid="create-step-networks">
      <p className="create-flow__kicker">{started ? 'Deploying' : 'Pick networks'}</p>
      <p className="custody-hint">Same vault on every network you pick. The app handles the transactions.</p>

      {!started && (
        <div className="create-flow__networks" role="group" aria-label="Networks">
          {availableChainIds.map((id) => {
            const rail = railFor(id)
            const isOn = selected.includes(id)
            return (
              <div key={id} className="create-flow__network-choice">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={isOn}
                  className={`create-flow__network-chip${isOn ? ' is-selected' : ''}`}
                  disabled={!selectable || !rail.available}
                  onClick={() => onToggle(id)}
                  data-testid={`network-chip-${id}`}
                >
                  {chainDisplayName(id)}
                  {isOn ? ' ✓' : ''}
                </button>
                {!rail.available && (
                  <p className="create-flow__rail-reason" role="note">
                    {rail.reason}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {predictedAddress && (
        <div className="create-flow__preview" data-testid="predicted-address">
          <span className="create-flow__preview-label">Vault address — the same on every network</span>
          <code>{predictedAddress}</code>
        </div>
      )}

      {(started || running) && (
        <ul className="create-flow__status-list" aria-label="Deployment status">
          {rows.map((id) => {
            const entry = byChain[id]
            const failed = entry?.status === DEPLOY_STATUS.FAILED || entry?.rulesStatus === RULES_STATUS.INSTALL_FAILED
            return (
              <li key={id} className="create-flow__status-row" data-testid={`deploy-status-${id}`}>
                <NetworkPill chainId={Number(id)} name={chainDisplayName(id)} />
                <span className={`create-flow__status${failed ? ' is-failed' : ''}`}>{statusLabelFor(entry)}</span>
                {entry?.reason && (
                  <span className="create-flow__status-reason" role="alert">
                    {entry.reason}
                  </span>
                )}
                {failed && (
                  <button type="button" onClick={() => onRetry(id)} disabled={running}>
                    Retry
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {started && (
        <p className="custody-hint" role="status">
          {doneCount} of {selected.length} selected network{selected.length === 1 ? '' : 's'} live.
          {running ? ' You can leave — networks already live stay live.' : ''}
        </p>
      )}

      <div className="create-flow__nav">
        {!started && (
          <button type="button" onClick={onBack} disabled={running}>
            Back
          </button>
        )}
        {!started ? (
          <button
            type="button"
            className="create-flow__primary"
            disabled={running || selected.length === 0}
            onClick={onDeploy}
            data-testid="deploy-button"
          >
            {deployLabel}
          </button>
        ) : (
          <button type="button" className="create-flow__primary" onClick={onDone} disabled={running}>
            {running ? 'Deploying…' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  )
}

NetworksSheet.propTypes = {
  availableChainIds: PropTypes.arrayOf(PropTypes.number).isRequired,
  selected: PropTypes.arrayOf(PropTypes.number).isRequired,
  onToggle: PropTypes.func.isRequired,
  byChain: PropTypes.object.isRequired,
  predictedAddress: PropTypes.string,
  running: PropTypes.bool,
  started: PropTypes.bool,
  railFor: PropTypes.func.isRequired,
  onDeploy: PropTypes.func.isRequired,
  onRetry: PropTypes.func.isRequired,
  onBack: PropTypes.func,
  onDone: PropTypes.func.isRequired,
  deployLabel: PropTypes.string,
}
