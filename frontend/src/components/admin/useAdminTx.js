/**
 * useAdminTx (spec 093) — the shared admin write runner, extracted verbatim
 * from the monolithic AdminPanel's `runTx`.
 *
 * RESOLVES `true` on success and `false` on any failure — including a rejected
 * wallet prompt — never `undefined` and never a rejection. Callers that send a
 * SEQUENCE need that: the spec-067 bulk route toggles promised "a failed or
 * rejected signature stops the rest", and with a signal-free result the loop
 * could not observe a revert, so rejecting the first prompt still queued the
 * remaining four.
 *
 * `onSuccess` replaces the monolith's hard-wired `fetchContractState()`:
 * each app passes its own refresh so a write refreshes the state it changed.
 *
 * `errorAbi` is per CALL, not per hook (issue #1267). One `runTx` is shared by
 * apps that write to DIFFERENT contracts — Compliance drives both the deny list
 * and the mini-app registry through this hook — so an ABI fixed at the hook
 * would decode one contract's revert with another's fragments and could name
 * the wrong error on a selector collision. The caller that knows which contract
 * it is writing to is the one that supplies the fragments.
 */
import { useCallback, useState } from 'react'
import { useWeb3 } from '../../hooks/useWeb3'
import { useNotification } from '../../hooks/useUI'
import { errorParser } from '../../lib/evm/revertParser'
import { describeRevert, extractRevert } from '../../lib/chain/revertError'

/**
 * What to tell the operator about a failed write.
 *
 * A revert ethers itself decoded, or one a caller already turned into a sentence, is left exactly
 * as it was — those already read well, and rewriting them would change every admin surface's
 * wording. The gap this closes is the write path through an injected wallet, where the revert
 * arrives as raw `error.data` that ethers never lifts into `.revert`: `shortMessage` is then the
 * useless "execution reverted (unknown custom error)" even though the caller's own ABI names it.
 */
function describeFailure(err, errorAbi) {
  const fallback = err?.shortMessage || err?.message || 'The transaction failed.'
  if (!errorAbi || err?.revert?.name || err?.errorName) return fallback
  try {
    const named = describeRevert(extractRevert(err, errorParser(errorAbi)))
    return named ? `Refused on-chain: ${named}` : fallback
  } catch {
    // A malformed ABI must never cost the operator the message they would otherwise have had.
    return fallback
  }
}

export function useAdminTx({ onSuccess } = {}) {
  const { signer } = useWeb3()
  const { showNotification } = useNotification()
  const [pendingTx, setPendingTx] = useState(false)

  const runTx = useCallback(
    async (fn, successMsg, { errorAbi = null } = {}) => {
      if (!signer) {
        showNotification('Connect your wallet first', 'error')
        return false
      }
      setPendingTx(true)
      try {
        const tx = await fn()
        await tx.wait()
        showNotification(successMsg, 'success')
        onSuccess?.()
        return true
      } catch (err) {
        console.error(err)
        showNotification(describeFailure(err, errorAbi), 'error')
        return false
      } finally {
        setPendingTx(false)
      }
    },
    [signer, showNotification, onSuccess],
  )

  return { runTx, pendingTx }
}
