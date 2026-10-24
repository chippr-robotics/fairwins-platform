import { useEffect, useMemo, useRef } from 'react'
import { useWeb3 } from '../../hooks/useWeb3'
import { getContractAddressForChain } from '../../config/contracts'
import { NETWORKS } from '../../config/networks'
import { settleWalletOn } from '../chains/submitOn'
import { signIntent } from './intentClient'
import { INTENT_ACTIONS } from './intentTypes'
import { useIntentAction } from './useIntentAction'

/** Strict chain name — never `getNetwork()`, which would name the default network for an unknown id. */
const chainName = (id) => NETWORKS[Number(id)]?.name || `Chain ${Number(id)}`

/**
 * useGaslessWrite — the one-line seam every call site uses to route an on-chain write through the
 * gasless relayer WITH a transparent self-submit fallback (spec 035/036 never-stranded rule; the
 * actual state machine lives in {@link useIntentAction}). It resolves the signer + chainId from the
 * wallet context and the EIP-712 verifying contract from the action's `verifier`, so a caller supplies
 * only two things: how to shape the intent params from the run() arguments, and how to self-submit the
 * equivalent wallet transaction.
 *
 * Chain behaviour is automatic and safe:
 *   - relayer URL unset, or the chain absent from the relayer's `/status` → self-submit (probeHealth).
 *   - payment-class action on a chain whose stablecoin lacks EIP-3009 (Mordor/ETC) → `signIntent`
 *     throws PaymentUnsupportedOnChain BEFORE any wallet prompt → self-submit.
 * So wiring a call site here never changes its behaviour on chains the relayer doesn't (yet) serve —
 * it stays a plain self-submit — and lights up gasless only where the relayer is live.
 *
 * ── THE TARGET CHAIN IS AN ARGUMENT (spec 110 T027) ──────────────────────────────────────────
 * `cfg.chainId` names the chain the write lands on. It drives ALL THREE of the things that used to
 * come from wherever the wallet happened to be: the EIP-712 domain, the verifying contract looked
 * up for the action, and which relayer is probed. Getting a domain from the ambient chain is the
 * worst of the three — a correctly-typed intent under the wrong domain is not an error, it is a
 * VALID signature over something nobody will honour (issue #1038 is the same failure by a different
 * route), and no assertion about the params can see it.
 *
 * The intent rail does not need the wallet to be anywhere: the signature names its own chain. The
 * SELF-SUBMIT fallback does, because a wallet broadcasts on the network it is on — so when a target
 * chain was named and the wallet is elsewhere, the fallback settles the wallet FIRST (the shared
 * T026 loop) and refuses, naming both chains, rather than broadcasting on the wrong one. That is
 * the point of the split: the happy path prompts for nothing, and the path that must prompt does.
 *
 * KNOWN, UNVERIFIED, and owed a test in T029: some injected wallets validate a typed-data domain's
 * chainId against their own selected chain and refuse to sign a mismatch. Where that happens the
 * refusal lands as a signature failure and falls through to self-submit above (which does settle),
 * so nothing is signed on the wrong chain either way — but it means "no prompt on the intent rail"
 * is proven for the app-held rails and ASSUMED for injected ones. Do not restate it as settled.
 *
 * @param {string} action - an INTENT_ACTIONS key (e.g. 'cancelOpen', 'claimPayout', 'redeemVoucher').
 * @param {object} cfg
 * @param {number} [cfg.chainId] - spec 110 T027: the chain this write lands on. Omit and the
 *   wallet's current chain is used, exactly as before — a soft gate, because every call site
 *   predates this argument and T028 is what closes them. Naming it is what makes the intent rail
 *   multichain; leaving it out is what it always was.
 * @param {(...runArgs: any[]) => object} [cfg.params] - maps run() args → the intent struct params,
 *   minus the fields signIntent auto-fills (actor/nonce/validAfter/validBefore/paymentNonce). Omit for
 *   a no-param action. Receives the exact args passed to `run(...)`.
 * @param {(...runArgs: any[]) => {value: bigint|string}} [cfg.payment] - payment-class only: the USDC
 *   amount to authorize (ReceiveWithAuthorization value). Ignored for signer-attributed actions.
 * @param {(...runArgs: any[]) => Promise<object|string>} cfg.selfSubmit - MANDATORY: the existing
 *   wallet write, resolving with the mined receipt (or its hash). Receives the same run() args.
 * @param {(entry: object) => void} [cfg.onActivity] - spec-031 ActivityEntry sink (optional).
 * @param {object|(() => object|null|undefined)} [cfg.signer] - spec 098 FR-007: sign the intent (and
 *   its stapled EIP-3009 authorization) as an account OTHER than the connected wallet — the acting
 *   account. Pass the signer itself, or a GETTER resolved at run time so a deferred ceremony (spec
 *   088) can supply it after render. The override is authoritative: a getter returning `null` signs
 *   with nothing rather than quietly falling back to the connected wallet — which is exactly the
 *   substitution this seam exists to prevent. `undefined` means "no override" (the personal path).
 * @param {string} [cfg.targetContract] - override the EIP-712 verifying contract. Defaults to the
 *   action verifier's address via getContractAddressForChain; pass this when the call site already
 *   holds the exact proxy address (so the relayed target can never diverge from the self-submit one).
 * @param {object} [cfg.rest] - forwarded to useIntentAction (pollIntervalMs, maxPollMs, invalidateNonce).
 * @returns {ReturnType<typeof useIntentAction>} { status, intent, result, error, run, invalidate,
 *   selfSubmitNow, reset }
 */
export function useGaslessWrite(action, { chainId: targetChainId, params, payment, selfSubmit, onActivity, signer: signerOverride, targetContract: targetOverride, ...rest } = {}) {
  const { signer, chainId: walletChainId, switchNetwork } = useWeb3()
  const verifier = INTENT_ACTIONS[action]?.verifier
  const chainId = targetChainId != null ? Number(targetChainId) : walletChainId

  // Always-current wallet snapshot — a network switch spans renders, so the fallback below must
  // read post-switch values, not the ones captured when the flow started.
  const latestRef = useRef({})
  useEffect(() => {
    latestRef.current = { chainId: walletChainId, signer }
  })

  /**
   * The self-submit fallback, landed on the named chain. Untouched when no chain was named, so
   * every pre-T027 call site behaves byte-for-byte as it did.
   *
   * `needsSigner` is read from the SESSION, not from `loginMethod`: if there is a key in the
   * browser now, a switch rebuilds it and the fallback must wait for the rebuilt one; if there is
   * not (a passkey session), waiting for a key that will never appear would spin to the deadline
   * and refuse a write that was fine. Same rule as `lib/chains/writeRail.js`.
   */
  const settledSelfSubmit = useMemo(() => {
    // Pass a non-function straight through: `useIntentAction` throws at wiring time when
    // `selfSubmit` is missing (the never-stranded rule), and wrapping would hand it a function and
    // silence that guard until the fallback actually ran.
    if (typeof selfSubmit !== 'function' || targetChainId == null) return selfSubmit
    return async (...runArgs) => {
      await settleWalletOn(Number(targetChainId), {
        readWallet: () => latestRef.current,
        switchNetwork,
        chainName,
        needsSigner: Boolean(latestRef.current.signer),
        subject: 'This transaction',
      })
      return selfSubmit(...runArgs)
    }
  }, [targetChainId, switchNetwork, selfSubmit])

  // Resolved per run, not per render: the acting signer may only exist after the ceremony that
  // confirm time triggers. `undefined` (including a getter that returns it) means no override.
  const resolveSigner = () => {
    if (signerOverride === undefined) return signer
    const override = typeof signerOverride === 'function' ? signerOverride() : signerOverride
    return override === undefined ? signer : override
  }

  // The EIP-712 verifying contract is the action's target proxy (wagerRegistry | membershipManager).
  const targetContract = useMemo(() => {
    if (targetOverride) return targetOverride
    if (chainId == null || !verifier) return null
    try {
      return getContractAddressForChain(verifier, chainId)
    } catch {
      return null // chain not configured for this contract — buildIntent will surface it; probe self-submits first
    }
  }, [targetOverride, verifier, chainId])

  return useIntentAction({
    action,
    chainId,
    buildIntent: (...runArgs) =>
      signIntent({
        signer: resolveSigner(),
        chainId,
        action,
        targetContract,
        params: typeof params === 'function' ? params(...runArgs) : params || {},
        ...(typeof payment === 'function' ? { payment: payment(...runArgs) } : {}),
      }),
    selfSubmit: settledSelfSubmit,
    onActivity,
    ...rest,
  })
}

export default useGaslessWrite
