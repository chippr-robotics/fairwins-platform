/**
 * useEarnSend (spec 050) — network-transparent transaction sending for the
 * Earn section. Vaults and rewards span every earn-enabled network (like the
 * portfolio), so the member never manages networks by hand: when a
 * transaction targets a different chain than the active one, the switch
 * happens automatically as part of submitting — no separate "switch network"
 * step to confirm in the app. (A browser wallet may still show its own
 * switch prompt; that surface belongs to the wallet, not us.)
 *
 * After switching we wait for the session to settle on the target chain —
 * and, for classic wallets, for the signer to be rebuilt — before handing the
 * batch to WalletContext.sendCalls, which reads the ACTIVE chain. A ref to
 * the latest wallet snapshot avoids acting on a stale closure mid-switch.
 *
 * ── ACTING ACCOUNTS ARE REFUSED, NOT SILENTLY IGNORED (spec 088 FR-001/FR-002) ───────
 * Every write here goes out on the CONNECTED wallet's own rail: `sendOnChain` ends at
 * `WalletContext.sendCalls`, which signs with whatever the wallet is holding, and the
 * network-switch above is a wagmi `switchChainAsync` on that SAME connected wallet — not the
 * acting-account seam (`submitAsActiveAccount`), which does not switch networks and binds
 * whatever signer it fetches to the wallet's CURRENT chain at ceremony time (spec 088 FR-005).
 * Every Earn surface here (vaults, staking, supply/bridge-LP, rewards) is defined by a target
 * that may be on a chain the wallet is not currently on, exactly the shape BridgeView already
 * refuses for the same reason. So `sendOnChain` refuses outright while the switcher shows a
 * vault, a recovered, a hardware, or any other non-personal account — belt and braces behind
 * whatever the calling surface's own UI does — rather than let a network-switching mid-flow
 * signature go out under the connected wallet while an acting label is showing. See
 * `frontend/src/components/wallet/BridgeView.jsx` for the withheld-surface half of this pattern.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef } from 'react'
import { useSwitchChain } from 'wagmi'
import { useWallet } from './useWalletManagement'
import { useEffectiveAccount } from './useEffectiveAccount'
import { NETWORKS } from '../config/networks'
import { settleWalletOn } from '../lib/chains/submitOn'

/** Strict chain name — never `getNetwork()`, which would name the default network for an unknown id. */
const chainName = (id) => NETWORKS[Number(id)]?.name || `Chain ${Number(id)}`

/**
 * Spec 088 FR-001/FR-002 — the refusal a member gets while acting as any non-personal
 * account and attempting an Earn write. Names the account, says plainly that this rail can
 * only move the connected wallet's own assets, and gives the one action that changes that.
 * Mirrors `BridgeView.actingRefusal` (the withheld-surface half of the same pattern) — kept
 * here too so a caller that reaches `sendOnChain` directly (skipping its own UI gate) still
 * gets an honest, member-facing reason rather than an opaque wallet error.
 *
 * @param {{ type: string, label: string|null }} acting
 * @returns {string}
 */
export function earnActingRefusal(acting) {
  const named =
    acting.label ||
    (acting.type === 'vault'
      ? 'a vault'
      : acting.type === 'hardware'
        ? 'a hardware account'
        : acting.type === 'legacy' || acting.type === 'derived'
          ? 'a recovered account'
          : 'another account')
  return `You are acting as ${named}. This can only move assets held by the wallet connected to this app, so it is not offered here — showing it would let you start a transfer of your connected wallet's money under ${named}'s name. Switch back to acting as yourself to continue. Nothing has been moved.`
}

export function useEarnSend() {
  const wallet = useWallet() || {}
  const { switchChainAsync } = useSwitchChain()
  const acting = useEffectiveAccount()
  const isPasskey = wallet.loginMethod === 'passkey'

  // Always-current wallet snapshot — the switch spans renders, so the send
  // must use post-switch values, not the ones captured at tap time.
  const latestRef = useRef({})
  useEffect(() => {
    latestRef.current = {
      chainId: wallet.chainId,
      signer: wallet.signer,
      sendCalls: wallet.sendCalls,
    }
  })

  /**
   * Whether this session can transact on `chainId` at all. Passkey smart
   * accounts need that chain's ERC-4337 rail (bundler) configured; classic
   * wallets can transact anywhere they can switch to.
   */
  const canTransactOn = useCallback(
    (chainId) => !isPasskey || Boolean(NETWORKS[chainId]?.passkey),
    [isPasskey],
  )

  /**
   * Member-facing reason when canTransactOn is false.
   */
  const cannotTransactReason = useCallback(
    (chainId) =>
      `Passkey accounts can't send transactions on ${NETWORKS[chainId]?.name || 'this network'} yet — connect a browser wallet to use it.`,
    [],
  )

  /**
   * Send `calls` on `targetChainId`, switching networks first when needed.
   * `onState` receives { step: 'switching' | 'sending' }. Resolves with the
   * sendCalls result. Throws with member-facing messages on failure.
   */
  const sendOnChain = useCallback(
    async (targetChainId, calls, { onState } = {}) => {
      // Spec 088 FR-001/FR-002 — belt and braces behind whatever the calling surface's own UI
      // does: this rail signs with the CONNECTED wallet and switches networks on it directly, so
      // it must never run while the switcher shows another account. See the module header.
      if (acting.isActingAccount) throw new Error(earnActingRefusal(acting))
      const target = Number(targetChainId)
      if (!canTransactOn(target)) throw new Error(cannotTransactReason(target))

      if (Number(latestRef.current.chainId) !== target) {
        onState?.({ step: 'switching' })
        // The loop is the shared one (spec 110 T026) — it switches, then waits for the session to
        // settle on the target chain, and for a classic wallet for the chain-scoped signer to be
        // rebuilt before sendCalls can route the batch correctly. Its refusal is STRONGER than the
        // one this hook used to write: "Could not switch to Ethereum — approve the network change
        // and try again" named neither the chain the wallet was actually on nor the fact that
        // nothing had been signed, which are the two things a member needs to know.
        await settleWalletOn(target, {
          readWallet: () => latestRef.current,
          switchNetwork: (id) => switchChainAsync({ chainId: id }),
          chainName,
          needsSigner: !isPasskey,
        })
      }

      const send = latestRef.current.sendCalls
      if (typeof send !== 'function') {
        throw new Error('This session cannot send transactions right now — please reconnect and try again.')
      }
      onState?.({ step: 'sending' })
      return send(calls)
    },
    [acting, canTransactOn, cannotTransactReason, isPasskey, switchChainAsync],
  )

  return {
    sendOnChain,
    canTransactOn,
    cannotTransactReason,
    isPasskey,
    // Spec 088 — exposed so a surface can withhold itself up front (the BridgeView template)
    // instead of waiting for the submit-time throw above.
    isActingAccount: acting.isActingAccount,
    actingAccount: acting,
  }
}

export default useEarnSend
