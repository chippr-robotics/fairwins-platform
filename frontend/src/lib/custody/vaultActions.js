// Release 1.14.0 — what the Protect vault ActionSheet offers, and why an option is closed.
//
// Pure and separate from the component on purpose: this is the availability rule for four
// state-changing custody surfaces, and it should be readable (and testable) without rendering a
// modal. The sheet renders whatever this returns.
//
// The rule the whole file exists to keep: an action a member cannot take right now is offered
// DISABLED with the reason stated, never withdrawn. A control that has vanished reads as a broken
// app; a control that says "this vault is on Mordor, switch networks to act on it" reads as the
// truth. Spec 068's multi-chain custody makes this the common case, not an edge one.

import { NETWORKS } from '../../config/networks'

export const VAULT_ACTIONS = [
  {
    id: 'create',
    testId: 'vault-action-create',
    label: 'Create vault',
    description: 'Deploy a new Safe multisig: choose its owners, how many must approve, and its policy.',
  },
  {
    id: 'load',
    testId: 'vault-action-load',
    label: 'Load a vault',
    description: 'Add a Safe that already exists by address — every custody network is searched.',
  },
  {
    id: 'propose',
    testId: 'vault-action-propose',
    label: 'Propose a transaction',
    description: 'Draft a transfer from the selected vault for its owners to approve.',
  },
  {
    id: 'approve',
    testId: 'vault-action-approve',
    label: 'Approve or execute',
    description: 'Sign off on what is waiting, and run anything that has enough approvals.',
  },
]

export const VAULT_ACTION_TITLES = {
  create: 'Create vault',
  load: 'Load a vault',
  propose: 'Propose a transaction',
  approve: 'Approve or execute',
}

/**
 * A chain's name. STRICT lookup — `getNetwork()` falls back to the default network for an unknown
 * id, and a custody surface that names the wrong chain is exactly the confusion Protect exists to
 * prevent.
 */
export function vaultChainLabel(chainId) {
  return NETWORKS[Number(chainId)]?.name || `chain ${chainId}`
}

/**
 * Why an action cannot be taken right now, or null when it can.
 *
 * @param {'create'|'load'|'propose'|'approve'} action
 * @param {object} ctx
 * @param {boolean} ctx.canCreateHere  Safe is deployed on the CONNECTED chain
 * @param {number|string} ctx.chainId  the CONNECTED chain (never the vault's — the two are compared)
 * @param {object|null} ctx.vault      the vault currently open in the list, enriched on chain
 */
export function unavailableReason(action, { chainId, vault }) {
  if (action === 'create' || action === 'load') {
    // Spec 105 — creation and loading are CHAIN-ABSTRACTED: the guided flow deploys to the
    // networks the member picks (switching the wallet when a signature needs it) and loading
    // searches every custody network. The connected chain no longer gates either door.
    return null
  }
  if (!vault) return 'Open a vault in the list below first.'
  // An unreachable chain is reported as unreachable. Rendering it as "no such vault" would turn an
  // outage into a claim about the member's estate.
  if (vault.reachable === false) {
    return `${vaultChainLabel(vault.chainId)} could not be reached, so this vault cannot be acted on.`
  }
  if (!vault.isSafe) return 'That address could not be read as a Safe.'
  if (Number(chainId) !== Number(vault.chainId)) {
    return `This vault is on ${vaultChainLabel(vault.chainId)}. Switch networks to act on it.`
  }
  // A view-only member can still watch the queue; only proposing needs ownership.
  if (action === 'propose' && !vault.owner) {
    return 'You are not an owner of this vault, so you can only view it.'
  }
  return null
}
