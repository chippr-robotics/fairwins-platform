/**
 * Advisory client-side sanctions screening (Spec 007 — FR-016).
 *
 * This is a UX-only pre-check: it reads the on-chain SanctionsGuard so the UI can warn /
 * block early before a user spends gas. It is NOT the enforcement layer — the on-chain
 * guard in WagerRegistry/MembershipManager (FR-054) is what actually prevents a sanctioned
 * address from proceeding, even if this client check is bypassed.
 *
 * Fail-closed UX: if the guard address isn't configured or the read fails, we return
 * `available: false` so the UI does NOT claim the address is "clear" (it should surface an
 * uncertain/blocked state rather than green-light).
 */

import { SANCTIONS_GUARD_ABI } from '../abis/SanctionsGuard'
import { getContractAddress, getContractAddressForChain } from '../config/contracts'
import { getCurrentChainId } from '../config/networks'
import { readContract } from '../lib/chains/readContract'

/**
 * Screen using an already-constructed guard contract (testable seam).
 * @param {{ isAllowed: (a: string) => Promise<boolean> }} guard
 * @param {string} account
 * @returns {Promise<{ allowed: boolean, available: boolean }>}
 */
export async function screenWithContract(guard, account) {
  try {
    const allowed = await guard.isAllowed(account)
    return { allowed: Boolean(allowed), available: true }
  } catch {
    return { allowed: false, available: false } // fail-closed UX
  }
}

/**
 * Screen an address against the configured on-chain SanctionsGuard, ON A NAMED CHAIN.
 *
 * `chainId` used to be inferred by ASKING THE PROVIDER (`provider.getNetwork()`) — the exact
 * shape spec 110 exists to remove, and the reason is visible right here: the guard address was
 * resolved for whatever chain the transport happened to be on, so the answer silently depended
 * on a connection rather than on the chain the caller meant. The one caller
 * (`useAddressScreening`) already refuses to screen unless the entry's chain IS the connected
 * one, so it has always known the chain; it now says so. Omitting it falls back to the
 * build-time chain, never to a guess taken off the wire.
 *
 * `provider` stays the availability gate it was: no connection, no screen, fail-closed.
 *
 * @param {string} account - wallet address to screen
 * @param {object} provider - a read connection (presence is what matters)
 * @param {number} [chainId] - the chain whose guard should answer
 * @returns {Promise<{ allowed: boolean, available: boolean }>}
 */
export async function screenAddress(account, provider, chainId) {
  const address =
    chainId == null
      ? getContractAddress('sanctionsGuard')
      : getContractAddressForChain('sanctionsGuard', Number(chainId))
  if (!address || !provider) return { allowed: false, available: false } // can't screen -> fail-closed
  const guard = {
    isAllowed: (who) =>
      readContract(Number(chainId ?? getCurrentChainId()), {
        address,
        abi: SANCTIONS_GUARD_ABI,
        functionName: 'isAllowed',
        args: [who],
      }),
  }
  return screenWithContract(guard, account)
}

/**
 * Convenience: true only when the address was successfully screened AND is allowed.
 * An unavailable result is treated as not-clear (fail-closed).
 * @param {{ allowed: boolean, available: boolean }} result
 * @returns {boolean}
 */
export function isClear(result) {
  return Boolean(result && result.available && result.allowed)
}

/**
 * Spec 041 (clarification Q2) — controller screening for passkey accounts.
 * A linked wallet address is screened AT LINK TIME with the same fail-closed
 * semantics as user screening: flagged OR unscreenable ⇒ not clear ⇒ the link
 * is refused. Also used by the periodic account re-screen so a controller
 * that becomes flagged flags the account for gated actions (on-chain guards
 * remain authoritative).
 *
 * @returns {{ clear: boolean, available: boolean }}
 */
export async function screenController(controllerAddress, provider) {
  const result = await screenAddress(controllerAddress, provider)
  return { clear: isClear(result), available: result.available }
}
