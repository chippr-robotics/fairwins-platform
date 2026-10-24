/**
 * VaultActionSheet (release 1.14.0) — the four things a member does with a multisig vault, behind
 * one bottom sheet instead of scattered across the Protect card.
 *
 *   Create vault          → CreateVaultFlow     (spec 105 guided multichain flow)
 *   Load a vault          → LoadVaultForm       (spec 068 cross-chain search)
 *   Propose a transaction → ProposeTransactionForm (spec 043 US2 / 049 FR-012 pre-flight)
 *   Approve or execute    → VaultProposalsPanel (spec 043 US2 queue + governance)
 *
 * It re-implements NONE of them: every view mounts the component that already owns that flow, with
 * the same callbacks CustodyPanel passed inline before. What the sheet adds is a single door and an
 * honest closed one — an action a member cannot take right now is offered DISABLED with the reason
 * stated, never hidden (a missing control reads as a broken app) and never live-but-failing.
 *
 * Multi-chain rules (spec 068) hold inside the sheet exactly as they do outside it: a vault carries
 * its own `chainId`, and `propose` re-checks the wallet's chain at SUBMIT time — the wallet can
 * switch networks while this sheet is open, and a custody action must never be submitted to a chain
 * other than the vault's own. (The approve/execute view delegates to VaultProposalsPanel, which
 * carries that same check for its own actions.)
 */

import { useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import ActionSheet from '../account/ActionSheet'
import CreateVaultFlow from './createflow/CreateVaultFlow'
import LoadVaultForm from './LoadVaultForm'
import ProposeTransactionForm from './ProposeTransactionForm'
import VaultProposalsPanel from './VaultProposalsPanel'
import {
  VAULT_ACTIONS,
  VAULT_ACTION_TITLES,
  unavailableReason,
  vaultChainLabel,
} from '../../lib/custody/vaultActions'
import './VaultActionSheet.css'

export default function VaultActionSheet({
  open,
  onClose,
  initialAction = null,
  chainId,
  connectedAddress,
  canCreateHere = false,
  onCreated,
  onLoad,
  vault = null,
  proposals = null,
}) {
  const [action, setAction] = useState(initialAction)
  // Each opening starts where the caller asked; closing forgets, so the sheet never reopens on a
  // half-finished form the member walked away from. Adjusted during render (React's documented
  // "derive state from props" pattern) rather than in an effect — an effect would paint the stale
  // view for one frame, which on a form is a member typing into something about to be replaced.
  const [seen, setSeen] = useState({ open, initialAction })
  if (seen.open !== open || seen.initialAction !== initialAction) {
    setSeen({ open, initialAction })
    if (open) setAction(initialAction)
  }

  // The sheet's panel scrolls (max-height 85vh); switching views must not inherit the previous
  // view's scroll offset, or a form opens with its top clipped under the header.
  const bodyRef = useRef(null)
  useEffect(() => {
    const panel = bodyRef.current?.closest('.action-sheet')
    if (panel) panel.scrollTop = 0
  }, [action])

  const ctx = { canCreateHere, chainId, vault }
  const close = () => {
    onClose?.()
  }

  /*
   * Spec 068 FR-004 at SUBMIT time. The render-time gate above can be stale by the time the member
   * presses the button — this is the check that actually binds.
   */
  const proposeOnVaultChain = async (payload) => {
    if (!vault) throw new Error('No vault is selected.')
    if (Number(chainId) !== Number(vault.chainId)) {
      throw new Error(
        `This vault is on ${vaultChainLabel(vault.chainId)} but your wallet is on ${vaultChainLabel(chainId)}. Switch networks and try again.`,
      )
    }
    return proposals?.propose(payload)
  }

  const body = () => {
    if (action === 'create') {
      // Spec 105 — the guided four-sheet flow deploys across the member's chosen networks itself
      // (useVaultDeployment); the sheet only needs to know when a vault landed so the list refreshes.
      return (
        <CreateVaultFlow
          connectedAddress={connectedAddress}
          chainId={chainId}
          onCreated={onCreated}
          onDone={close}
        />
      )
    }
    if (action === 'load') {
      return <LoadVaultForm onLoad={onLoad} chainId={chainId} onDone={close} />
    }
    if (action === 'propose') {
      return <ProposeTransactionForm vault={vault} onPropose={proposeOnVaultChain} onDone={close} />
    }
    if (action === 'approve') {
      return <VaultProposalsPanel vault={vault} proposals={proposals} />
    }
    return (
      <div className="vault-action-sheet__options">
        {VAULT_ACTIONS.map((opt) => {
          const reason = unavailableReason(opt.id, ctx)
          return (
            <button
              key={opt.id}
              type="button"
              className="vault-action-sheet__option"
              data-testid={opt.testId}
              disabled={Boolean(reason)}
              onClick={() => setAction(opt.id)}
            >
              <span className="vault-action-sheet__option-label">{opt.label}</span>
              <span className="vault-action-sheet__option-desc">{reason || opt.description}</span>
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <ActionSheet
      open={open}
      onClose={close}
      title={VAULT_ACTION_TITLES[action] || 'Vault actions'}
      className="vault-action-sheet"
    >
      {action && (
        <button
          type="button"
          className="vault-action-sheet__back"
          data-testid="vault-action-back"
          onClick={() => setAction(null)}
        >
          ← All vault actions
        </button>
      )}
      {action && vault && (action === 'propose' || action === 'approve') && (
        <p className="vault-action-sheet__scope" role="status" data-testid="vault-action-scope">
          {vault.label || 'Unnamed vault'} on {vaultChainLabel(vault.chainId)}
        </p>
      )}
      <div ref={bodyRef} className="vault-action-sheet__body">{body()}</div>
    </ActionSheet>
  )
}

VaultActionSheet.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func.isRequired,
  /** Action to land on when the sheet opens; null shows the chooser. */
  initialAction: PropTypes.oneOf([null, 'create', 'load', 'propose', 'approve']),
  /** The CONNECTED chain, not the vault's — the two are compared, never conflated. */
  chainId: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
  connectedAddress: PropTypes.string,
  canCreateHere: PropTypes.bool,
  onCreated: PropTypes.func,
  onPreview: PropTypes.func,
  onLoad: PropTypes.func,
  /** The vault currently open in the list, enriched by useCustodyVaults. */
  vault: PropTypes.object,
  /** The shared useVaultProposals instance for that vault. */
  proposals: PropTypes.object,
}
