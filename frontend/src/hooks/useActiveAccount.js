// Spec 043 (US3) — expose the active identity and a single submit() that every money-moving surface can call.
// In personal mode submit sends via the connected signer; in vault mode it creates a threshold-gated proposal.
//
// Spec 088 — recovered and hardware identities are ADDRESS-ONLY until value moves: submit()
// fetches the acting signer on demand through the custody broker (the globally-mounted ceremony
// host renders the unlock / device-connect dialog right then). A cached signer bound to a network
// the wallet has since left is DROPPED and re-requested — the fresh ceremony binds to the current
// chain — instead of failing the send with a "switch back" error.
//
// Spec 088 FR-002 (audit) — submit() has NO fall-through for an unhandled acting kind. Any mode
// that is not 'personal' and has no branch of its own is REFUSED, never sent with the CONNECTED
// wallet's signer under somebody else's label.
//
// Spec 102 (D6, FR-014) — a vault-mode submit whose wallet is on another chain SWITCHES FIRST
// (`useEarnSend.sendOnChain` precedent): `switchNetwork` is awaited and rejects on refusal, then
// the send waits for the wallet snapshot to settle on the vault's chain (and, for a classic wallet,
// for the chain-scoped signer to be rebuilt) before the proposal is created with the SETTLED
// signer/provider — never the one captured at tap time. A refusal is a stated error naming both
// chains, and nothing is signed. The auto-switch adds a wallet prompt; it never removes one.
//
// Spec 110 T026 — the settle loop is no longer this hook's own; it is the shared
// `lib/chains/submitOn.js#settleWalletOn`, which three hooks had each copied and then drifted apart
// on (20s here and in useEarnSend, 30s in useVaultDeployment). submit() also forwards an optional
// `payload.chainId` so a personal, recovered or hardware send NAMES the chain it lands on instead
// of inheriting whatever the signer happens to be bound to.

import { useCallback, useContext, useEffect, useRef } from 'react'
import { useWallet } from './useWalletManagement'
import { CustodyContext } from '../contexts/CustodyContext'
import { getSafeContracts } from '../config/safeContracts'
import { getContractAddressForChain } from '../config/contracts'
import { NETWORKS } from '../config/networks'
import { submitAsActiveAccount } from '../lib/custody/submitAsActiveAccount'
import { settleWalletOn } from '../lib/chains/submitOn'

const PERSONAL = { mode: 'personal' }
const NOOP = () => {}
const NO_BROKER = () => Promise.reject(new Error('No signing ceremony is available here.'))

/** Strict chain name — never `getNetwork()`, which would name the default network for an unknown id. */
const chainName = (id) => NETWORKS[Number(id)]?.name || `Chain ${Number(id)}`

export function useActiveAccount() {
  // Read the context directly and degrade to personal mode when no CustodyProvider is mounted. Operate-as is
  // an optional overlay (the provider is always present at runtime), so broad consumers like useTransfer and
  // useFriendMarketCreation must not hard-crash when it is absent (e.g. in isolated component tests).
  const custody = useContext(CustodyContext)
  const active = custody?.active ?? PERSONAL
  const legacySigner = custody?.legacySigner ?? null
  const hardwareSigner = custody?.hardwareSigner ?? null
  const operateAsPersonal = custody?.operateAsPersonal ?? NOOP
  const operateAsVault = custody?.operateAsVault ?? NOOP
  const operateAsLegacy = custody?.operateAsLegacy ?? NOOP
  const operateAsHardware = custody?.operateAsHardware ?? NOOP
  const requestActingSigner = custody?.requestActingSigner ?? NO_BROKER
  const dropActingSigner = custody?.dropActingSigner ?? NOOP
  const { chainId, signer, provider, switchNetwork, loginMethod } = useWallet()
  const isPasskey = loginMethod === 'passkey'
  const isVault = active.mode === 'vault'
  const isLegacy = active.mode === 'legacy'
  const isHardware = active.mode === 'hardware'

  // Always-current wallet snapshot — a network switch spans renders, so the vault send must use the
  // post-switch signer/provider, not the ones captured at tap time.
  const latestRef = useRef({})
  useEffect(() => {
    latestRef.current = { chainId, signer, provider }
  })

  /**
   * Spec 088 — get-or-request the ACTING account's signer, running the deferred ceremony (unlock
   * passphrase / connect device) only when one is not already in hand. A cached signer whose chain
   * binding no longer matches the wallet's network is stale: drop it and run a fresh ceremony
   * (which binds to the CURRENT chain) rather than telling the member to switch back.
   *
   * Exposed (spec 098) because a purchase needs the signer ITSELF, not just a {to,value,data} send:
   * the pay leg resolves intent params from it, signs the relayed intent with it, and derives the
   * acting account's encryption key from it. Callers must never hold it beyond the flow run.
   */
  const resolveActingSigner = useCallback(async () => {
    if (active.mode !== 'legacy' && active.mode !== 'hardware') {
      throw new Error('There is no signing ceremony for this account, so nothing has been signed.')
    }
    let acting = active.mode === 'legacy' ? legacySigner : hardwareSigner
    const stale = acting && active.chainId != null && Number(chainId) !== Number(active.chainId)
    if (stale) {
      dropActingSigner()
      acting = null
    }
    if (!acting) acting = await requestActingSigner()
    return acting
  }, [active, chainId, legacySigner, hardwareSigner, requestActingSigner, dropActingSigner])

  /**
   * Spec 102 FR-014 — land the wallet on the vault's chain, then return the SETTLED
   * signer/provider. The loop itself is the shared one (spec 110 T026,
   * `lib/chains/submitOn.js#settleWalletOn`): this hook, `useEarnSend` and `useVaultDeployment`
   * each carried a copy, and the copies had drifted to different timeouts — the same wallet on the
   * same chain got ten more seconds of patience depending on which button was pressed. The only
   * thing that genuinely differed between them was the NOUN the refusal opens with, so that is the
   * only thing still passed in.
   */
  const settleOnVaultChain = useCallback(
    () =>
      settleWalletOn(active.chainId, {
        readWallet: () => latestRef.current,
        switchNetwork,
        chainName,
        // A passkey session has no browser key to wait for; waiting would spin to the deadline.
        needsSigner: !isPasskey,
        subject: 'This proposal',
      }),
    [active.chainId, switchNetwork, isPasskey],
  )

  const submit = useCallback(
    async (payload) => {
      if (active.mode === 'vault') {
        const settled = await settleOnVaultChain()
        return submitAsActiveAccount(payload, {
          mode: 'vault',
          vaultAddress: active.vaultAddress,
          chainId: active.chainId,
          hubAddress: getContractAddressForChain('safeProposalHub', active.chainId),
          safeContracts: getSafeContracts(active.chainId),
          signer: settled.signer,
          provider: settled.provider,
        })
      }
      if (active.mode === 'legacy' || active.mode === 'hardware') {
        // Spec 110 T026 — `payload.chainId` names the chain this send lands on, and the seam
        // refuses if the signer is somewhere else. It matters most HERE: the spec-088 ceremony
        // binds this signer to the wallet's CURRENT chain and deliberately does not switch, so a
        // surface asking for another chain used to get a transaction on the wrong one.
        return submitAsActiveAccount(payload, {
          mode: 'personal',
          chainId: payload.chainId,
          signer: await resolveActingSigner(),
        })
      }
      // Spec 088 FR-002 — every non-personal kind must be handled ABOVE. A mode with no branch
      // here (today: 'derived', the cross-chain identity useEffectiveAccount already resolves)
      // would otherwise fall through to the connected wallet's signer and sign as somebody else
      // under an acting label — silently, which is the single thing this seam exists to prevent.
      // Refuse instead, and name the account so the member knows what to do about it.
      if (active.mode && active.mode !== 'personal') {
        throw new Error(
          `This account cannot send transactions here yet, so nothing has been signed. Switch back to acting as yourself to send from your own account.`,
        )
      }
      return submitAsActiveAccount(payload, { mode: 'personal', chainId: payload.chainId, signer })
    },
    [active, signer, settleOnVaultChain, resolveActingSigner],
  )

  // Whether a vault action can currently be sent: the wallet is on the vault's chain, or a switch
  // to it is possible (spec 102 — the switch happens at submit time, never as a precondition).
  const onVaultChain = isVault && Number(chainId) === Number(active.chainId)
  const canActAsVault = isVault && (onVaultChain || typeof switchNetwork === 'function')
  // The chain a vault proposal will be sent on — for confirm UIs to name before signature.
  const actingVaultChainName = isVault && active.chainId != null ? chainName(active.chainId) : null
  // Spec 088 — a recovered/hardware acting account can always ACT: the signer is obtained on
  // demand by the deferred ceremony, so these no longer gate on a signer already being in hand.
  // (They remain distinct flags because consumers branch per kind.)
  const canActAsLegacy = isLegacy
  const canActAsHardware = isHardware

  return {
    identity: active,
    isVault,
    isLegacy,
    isHardware,
    canActAsVault,
    actingVaultChainName,
    canActAsLegacy,
    canActAsHardware,
    submit,
    resolveActingSigner,
    operateAsPersonal,
    operateAsVault,
    operateAsLegacy,
    operateAsHardware,
  }
}

export default useActiveAccount
