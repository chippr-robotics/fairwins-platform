import { useCallback, useEffect, useRef } from 'react'
import { useWeb3 } from './useWeb3'
import { NETWORKS } from '../config/networks'
import { settleWalletOn } from '../lib/chains/submitOn'

/** Strict chain name — never `getNetwork()`, which names the default network for an unknown id. */
const chainName = (id) => NETWORKS[Number(id)]?.name || `Chain ${Number(id)}`

/**
 * Put a wager's action on the wager's OWN chain (spec 110 Phase 4, T040 — issue #1595,
 * acceptance scenarios 1 and 2).
 *
 * ── WHAT THIS REPLACES, AND WHY IT WAS WRONG ───────────────────────────────────────────────────
 * Every action in My Wagers opened with the same six lines:
 *
 *     if (!isCorrectNetwork) {
 *       try { await switchNetwork() }
 *       catch { setError('Please switch to the correct network.'); return }
 *     }
 *
 * `switchNetwork()` takes `targetChainId = PRIMARY_CHAIN_ID`, so calling it with no argument moved
 * the member to **Polygon** — whatever chain the wager was actually on. It never mattered before
 * only because the list was single-chain: the wager could not be from anywhere else, so the wrong
 * target happened to be the right one. T040 makes the list estate-wide, and the coincidence ends
 * there. The registry address was resolved from the ambient chain for the same reason.
 *
 * And "Please switch to the correct network" names neither chain — the member is told to move,
 * not where from or where to. `settleWalletOn` names both and states that nothing was signed.
 *
 * ── THE PASSKEY RAIL IS NOT SWITCHED, DELIBERATELY ─────────────────────────────────────────────
 * `sendCalls({ chainId })` submits a UserOp to the TARGET chain's bundler; the member's wallet
 * network is irrelevant to it (`submitOn`'s rail rules). Sending a passkey member through a chain
 * switch would be a prompt they never had to be asked for — so the target is returned and nothing
 * is moved. Callers pass that target to `sendRegistryCall`.
 */
export function useWagerChain() {
  const { chainId, signer, provider, switchNetwork, loginMethod } = useWeb3()
  const isPasskey = loginMethod === 'passkey'

  // Always-current snapshot: a network switch spans renders, so the settle loop must read the
  // post-switch signer rather than the one captured when the button was pressed.
  const latestRef = useRef({})
  useEffect(() => {
    latestRef.current = { chainId, signer, provider }
  })

  /**
   * The chain a wager lives on. Falls back to the wallet's chain for an untagged entry — a
   * legacy cache written before wagers carried their chain — which is exactly the assumption
   * the whole app used to make, now narrowed to the only case that still needs it.
   */
  const chainOf = useCallback((market) => Number(market?.chainId ?? chainId), [chainId])

  /**
   * Land the action on the wager's chain and return that chain.
   *
   * @throws {import('../lib/chains/submitOn').ChainSwitchRefused} naming both chains, having
   *   signed nothing, when the wallet declines or the switch never settles.
   */
  const settleOnWagerChain = useCallback(
    async (market, subject = 'This transaction') => {
      const target = chainOf(market)
      if (isPasskey) return target
      await settleWalletOn(target, {
        readWallet: () => latestRef.current,
        switchNetwork,
        chainName,
        needsSigner: true,
        subject,
      })
      return target
    },
    [chainOf, isPasskey, switchNetwork],
  )

  return { chainOf, settleOnWagerChain, isPasskey }
}

export default useWagerChain
