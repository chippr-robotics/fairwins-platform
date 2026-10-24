/**
 * Scope + write-gate logic for operator views (spec 071 US4). Non-component exports live here so
 * `scopeControls.jsx` can export components only (react-refresh).
 *
 * The rules these encode were each a real defect before they were a rule — see scopeControls.jsx.
 */
import { useState, useCallback } from 'react'
import { networkName } from '../../lib/chains/estate'

/**
 * The chain an operator view is scoped to.
 *
 * Defaults to the wallet's chain when that chain is in the view's roster, otherwise the first
 * entry — the behaviour BridgeTab already had. Crucially it is seeded ONCE and never re-derived
 * from `walletChainId` afterwards, which is what FR-016 requires: a wallet network change must
 * change only whether writes are available, never what the operator is looking at.
 */
export function useScopedChain(networks, walletChainId) {
  const [scopeChainId, setScopeChainId] = useState(
    () =>
      (networks.some((n) => Number(n.chainId) === Number(walletChainId))
        ? Number(walletChainId)
        : networks[0]?.chainId) ?? null,
  )
  // Exposed as a stable callback so a view can offer "jump to my wallet's network" explicitly.
  const scopeToWallet = useCallback(() => setScopeChainId(Number(walletChainId)), [walletChainId])
  return { scopeChainId, setScopeChainId, scopeToWallet }
}

/**
 * Why a specific write control is unavailable, in words — or null when it is available.
 *
 * The four cases are deliberately distinct, because they call for four different actions:
 *
 *   not deployed  → nothing to act on here. Pick another network.
 *   wrong network → switch the wallet. The control WILL work.
 *   role not held → you cannot do this here, and switching will not help.
 *   unconfirmed   → we could not ask. The control stays OFFERED and says so, because the
 *                   contract is the real gate — withdrawing a killswitch because an RPC timed
 *                   out tells an operator who holds it that there isn't one (spec 067 FR-044).
 */
export function writeGateReason({ deployed, onWalletChain, held, readable, scopeChainId }) {
  if (deployed === false) return `Not deployed on ${networkName(scopeChainId)} — nothing to change here.`
  if (!onWalletChain) return `Switch your wallet to ${networkName(scopeChainId)} to make this change.`
  if (readable === false) return `Authority could not be confirmed on ${networkName(scopeChainId)} — the contract will still refuse anything you do not hold.`
  if (held === false) return `You do not hold this role on ${networkName(scopeChainId)}.`
  return null
}

/** Whether the control should be offered at all, given the same inputs. */
export function writeAllowed({ deployed, onWalletChain, held, readable }) {
  if (deployed === false) return false
  if (!onWalletChain) return false
  // Unconfirmed authority stays permissive; only a definite "no" withholds the control.
  if (readable === false) return true
  return held !== false
}

/**
 * FR-019: turn an authority read of ONE contract on ONE chain into a write gate — with words.
 *
 * ── WHY AN APP-WIDE FLAG CANNOT STAND IN HERE ──────────────────────────────────────────────
 * `useAdminAccess().flags.isAdmin` / `.isRoleManager` are ESTATE-WIDE: true when the role is
 * held on ANY cohort chain, against a candidate list that is not necessarily the contract a
 * given control writes to. Offering Grant/Revoke on that plus a wallet-chain match tells an
 * operator they hold authority the contract will then refuse — the belief FR-019 exists to
 * prevent. So the question is put to the contract that will enforce it (`readAuthority` in
 * `lib/chains/estate.js`), and only its answer decides.
 *
 * Four inputs, four different answers — none of them interchangeable:
 *
 *   pending       → nobody has asked yet. `fallback` (the estate-wide flag) stands in for one
 *                   round-trip so an operator who DOES hold the role is not shown a dead button
 *                   while the read is in flight. Same stand-in StakingTab/FeesTab already use.
 *   not deployed  → there is no contract here to hold a role on, so there is no authority
 *                   verdict to give. The caller's own deployment guard already refuses this in
 *                   words at click time; this gate must not silently become a second, different
 *                   refusal for the same fact.
 *   unconfirmed   → the question could not be PUT (RPC timeout, no read connection). That is
 *                   not a "no". The control stays OFFERED and says so: withdrawing it because
 *                   an endpoint blinked tells an operator who holds the role that they do not.
 *   definite no   → the chain answered, and the answer was no. THIS is the only state that
 *                   withholds, and it says who lacks what, on which contract, on which chain.
 *
 * @param {object} opts
 * @param {object|null} opts.authority  a `readAuthority` result, or null while it is in flight
 * @param {string[]} opts.roles         role keys that would satisfy this control (ORed)
 * @param {boolean} opts.fallback       estate-wide stand-in, used ONLY while pending/undeployed
 * @param {number}  opts.chainId        the chain the write signs on — named in every message
 * @param {string}  opts.contractLabel  the contract that will enforce it, named in every message
 * @param {string}  opts.roleLabel      the on-chain role name, named in the refusal
 * @param {string}  opts.accountLabel   who was asked about, named in the refusal
 * @returns {{allowed: boolean, reason: string|null, unconfirmed: boolean, pending: boolean,
 *            answered: boolean}}
 */
export function contractAuthorityGate({
  authority,
  roles = [],
  fallback = false,
  chainId,
  contractLabel = 'this contract',
  roleLabel = 'the required role',
  accountLabel = 'This account',
}) {
  const base = { allowed: false, reason: null, unconfirmed: false, pending: false, answered: false }

  if (!authority) return { ...base, allowed: Boolean(fallback), pending: true }
  // No contract ⇒ no verdict. The caller's deployment guard owns this case.
  if (authority.deployed === false) return { ...base, allowed: Boolean(fallback) }

  if (!authority.readable) {
    return {
      ...base,
      allowed: true,
      unconfirmed: true,
      reason:
        `Your authority could not be confirmed on the ${contractLabel} on ${networkName(chainId)} — ` +
        'the control stays available because that contract is the real gate, and it will refuse ' +
        'anything you do not hold.',
    }
  }

  if (roles.some((role) => Boolean(authority.roles?.[role]))) {
    return { ...base, allowed: true, answered: true }
  }

  return {
    ...base,
    answered: true,
    reason:
      `${accountLabel} does not hold ${roleLabel} on the ${contractLabel} on ${networkName(chainId)}, ` +
      'so this control is withheld — that contract would reject it.',
  }
}

