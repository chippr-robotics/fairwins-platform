// Spec 105 US1 sheet 4 — one card, one address, a badge per live network, and every fact still
// pending said plainly (FR-011): a network still confirming, rules awaiting co-owner approval, a
// failed network with its reason. Nothing here implies finality the chain has not reached.

import PropTypes from 'prop-types'
import NetworkPill from '../../ui/NetworkPill'
import { chainDisplayName } from '../../../lib/custody/chainName'
import { DEPLOY_STATUS, RULES_STATUS } from '../../../lib/custody/vaultDeployment'

export default function DoneSheet({ address, selected, byChain, label, onClose }) {
  const live = selected.filter((id) => {
    const s = byChain[id]?.status
    return s === DEPLOY_STATUS.LIVE || s === DEPLOY_STATUS.ALREADY_LIVE
  })
  const pending = []
  for (const id of selected) {
    const entry = byChain[id] || {}
    const name = chainDisplayName(id)
    if (entry.status === DEPLOY_STATUS.CONFIRMING || entry.status === DEPLOY_STATUS.DEPLOYING) {
      pending.push(`${name} is still confirming.`)
    } else if (entry.status === DEPLOY_STATUS.FAILED) {
      pending.push(`${name} did not deploy${entry.reason ? ` — ${entry.reason}` : ''}. You can retry from the vault's details.`)
    }
    if (entry.rulesStatus === RULES_STATUS.AWAITING_APPROVAL) {
      pending.push(`Rules on ${name} are queued and take effect once your co-owners approve them.`)
    } else if (entry.rulesStatus === RULES_STATUS.INSTALL_FAILED) {
      pending.push(`Rules on ${name} are not installed yet${entry.reason ? ` — ${entry.reason}` : ''}.`)
    }
  }

  return (
    <div className="create-flow__step" data-testid="create-step-done">
      <p className="create-flow__kicker">Your vault is ready</p>
      <div className="create-flow__done-card">
        {label ? <p className="create-flow__done-label">{label}</p> : null}
        <code className="create-flow__done-address">{address}</code>
        <div className="create-flow__done-badges">
          {live.map((id) => (
            <NetworkPill key={id} chainId={Number(id)} name={chainDisplayName(id)} />
          ))}
          {live.length === 0 && <span className="custody-hint">No network is live yet.</span>}
        </div>
      </div>
      {pending.length > 0 && (
        <ul className="create-flow__pending" aria-label="Still pending">
          {pending.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}
      <div className="create-flow__nav">
        <button type="button" className="create-flow__primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

DoneSheet.propTypes = {
  address: PropTypes.string,
  selected: PropTypes.arrayOf(PropTypes.number).isRequired,
  byChain: PropTypes.object.isRequired,
  label: PropTypes.string,
  onClose: PropTypes.func.isRequired,
}
