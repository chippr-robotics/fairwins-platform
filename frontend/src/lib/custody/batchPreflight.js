// Issue #1368 — will this vault's guard let a MultiSend through?
//
// Every batch a vault proposes is a `MultiSendCallOnly` DELEGATECALL (`vaultTransaction.js#encodeMultiSend`
// sets operation 1). Both policy guards deny `operation != 0`:
//
//   SafePolicyGuardV2._preCheck   (contracts/custody/SafePolicyGuardV2.sol:432-452)
//   SafePolicyGuard._checkPolicy  (contracts/custody/SafePolicyGuard.sol:268-289)
//
// but each denies it ONLY once the vault has an active policy on that guard — V2 returns
// `exempt` when `_rules[safe].length == 0`, v1 when the vault has no allowlist, no cooldown and no
// configured assets. A vault holding the guard with nothing configured behaves exactly like an
// unguarded Safe, delegatecall included. "Is a guard set" is therefore the WRONG question, and
// answering it would refuse batches for vaults that would have executed them fine.
//
// The right question is asked of the guard itself: preview a delegatecall to the very
// MultiSendCallOnly address the proposal would carry. That read shares `_preCheck` / `_checkPolicy`
// verbatim with enforcement, so there is no client twin here to drift.
//
// THREE states, never two. A guard we could not read is `unknown` — on a money path callers treat
// that like a denial (propose the per-action shape, which every guard evaluates normally) but they
// must SAY "could not confirm", because an RPC timeout is not a policy.

import { getAddress, zeroAddress } from 'viem'
import { getSafeContracts } from '../../config/safeContracts'
import { getPolicyEngineAddresses, previewPolicy, readVaultGuard } from './policy'
import { getPolicyEngineV2Addresses, previewPolicyV2 } from './policyV2'

/** Safe operation enum value for a delegatecall — what MultiSend rides on. */
export const DELEGATECALL = 1

export const BATCH_SUPPORT = Object.freeze({
  OK: 'batch-ok',
  DENIED: 'batch-denied',
  UNKNOWN: 'unknown',
})

const DENIED_REASON = "This vault's policy does not allow batched transactions."
const UNKNOWN_REASON = "Could not confirm the vault's policy allows a batch."

const ok = (engine) => ({ support: BATCH_SUPPORT.OK, reason: null, detail: null, engine })
const denied = (engine, detail) => ({ support: BATCH_SUPPORT.DENIED, reason: DENIED_REASON, detail: detail || null, engine })
const unknown = (engine, detail) => ({ support: BATCH_SUPPORT.UNKNOWN, reason: UNKNOWN_REASON, detail: detail || null, engine })

const sameAddress = (a, b) => Boolean(a) && Boolean(b) && String(a).toLowerCase() === String(b).toLowerCase()

/**
 * Would a MultiSend batch from this vault survive its own guard?
 *
 * @param {string|null} vaultAddress
 * @param {number|string|null} chainId
 * @param {object} [provider] optional read provider (defaults to the chain's own)
 * @returns {Promise<{support:string, reason:string|null, detail:string|null, engine:string|null}>}
 *   engine: 'none' | 'v1' | 'v2' | 'foreign' | null
 */
export async function previewBatchSupport(vaultAddress, chainId, provider) {
  if (!vaultAddress || chainId == null) return unknown(null)

  // The probe must name the address the proposal would actually delegatecall into. Both guards
  // exempt `to == safe` and `to == guard` BEFORE the operation check, so probing either of those
  // would answer "allowed" for a vault that denies every real batch.
  const multiSend = getSafeContracts(chainId)?.multiSendCallOnly
  if (!multiSend) return unknown(null, 'Custody is not configured on this network.')

  let guard
  try {
    guard = await readVaultGuard(vaultAddress, chainId)
  } catch {
    return unknown(null, 'The vault’s guard slot could not be read.')
  }
  if (!guard || guard === zeroAddress) return ok('none')

  const payload = { to: getAddress(multiSend), value: 0n, data: '0x', operation: DELEGATECALL }

  const v2 = getPolicyEngineV2Addresses(chainId)
  if (v2 && sameAddress(guard, v2.guard)) {
    try {
      const res = await previewPolicyV2(vaultAddress, chainId, payload, { provider })
      return res.ok ? ok('v2') : denied('v2', res.reason?.message)
    } catch {
      return unknown('v2', 'The vault’s policy could not be read.')
    }
  }

  const v1 = getPolicyEngineAddresses(chainId)
  if (v1 && sameAddress(guard, v1.guard)) {
    try {
      const res = await previewPolicy(vaultAddress, chainId, payload)
      return res.ok ? ok('v1') : denied('v1', res.violation?.message)
    } catch {
      return unknown('v1', 'The vault’s policy could not be read.')
    }
  }

  // Somebody else's guard. It may well allow delegatecall — we have no way to know, and guessing
  // "allowed" is exactly the dishonest proposal this seam exists to prevent.
  return unknown('foreign', 'This vault uses a policy guard this app does not recognise.')
}

/** True when the caller must fall back to the per-action shape (a denial, or an unconfirmed read). */
export function mustSplitBatch(support) {
  return support === BATCH_SUPPORT.DENIED || support === BATCH_SUPPORT.UNKNOWN
}

export default previewBatchSupport
