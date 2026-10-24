import { useState, useRef, useCallback, useMemo } from 'react'
import { purchaseRoleWithStablecoin, checkApprovalNeeded, checkApprovalNeededForAddress, resolveMembershipIntentParams } from '../utils/blockchainService'
import { ensureKeyRegistered } from '../utils/keyRegistryService'
import { useGaslessWrite } from '../lib/relay/useGaslessWrite'

/**
 * Spec 022 — Membership Purchase Progress Indicator.
 *
 * Step state machine that drives the dedicated "Processing" view of
 * PremiumPurchaseModal. It surfaces the real wallet interactions of a membership
 * purchase as discrete, labeled steps with live state, and supports safe recovery:
 *
 *   approve (optional) -> pay -> sign -> register
 *
 * - The approve step is OMITTED when the member already has sufficient allowance
 *   (FR-009), determined by a read-only pre-flight (`checkApprovalNeeded`).
 * - approve/pay are surfaced via the `onProgress` callback of
 *   `purchaseRoleWithStablecoin`; sign/register are orchestrated here.
 * - sign/register are non-blocking: the membership is already active once `pay`
 *   confirms, so a key-step failure offers Retry AND Continue anyway (FR-010).
 * - Retry resumes from the failed step without re-running the payment (FR-008).
 *
 * This hook changes NO purchase mechanics (FR-001a); it only observes and
 * sequences the existing calls.
 *
 * ── Spec 098 — purchasing AS THE ACTING ACCOUNT ────────────────────────────────
 * `MembershipManager.purchaseTier` credits `msg.sender` and takes no beneficiary, so a membership
 * lands on the acting account if and only if the ACTING account signs. The caller therefore hands
 * the flow a BINDING (`params.acting`) plus exactly one rail:
 *
 *   params.proposePurchase  → vault rail: one threshold-gated Safe proposal. Terminal state is
 *                             `proposed`, never `succeeded` — nothing has been paid yet, so onPaid
 *                             never fires and the key steps are skipped (a Safe cannot sign,
 *                             spec 084).
 *   params.getActingSigner  → classic acting rail: the spec-088 ceremony broker hands back the
 *                             acting account's signer at CONFIRM time. It is resolved ONCE per run
 *                             (cached for the whole flow), address-checked against the binding, and
 *                             is what signs approve+pay, the relayed intent, the key derivation and
 *                             the key registration.
 *   params.batchPurchase    → passkey rail (spec 041), personal-only; unchanged.
 *   (none)                  → classic personal rail; unchanged.
 *
 * The binding is immutable for the life of a run: `invalidateIdentity(reason)` fails the flow and
 * permanently blocks retry, so no later step can execute under a NEW identity (FR-013).
 */

const STEP_DEFS = {
  approve: { id: 'approve', label: 'Approve USDC spending', detail: 'Authorize the membership contract to collect your USDC — no funds move yet.', kind: 'transaction', blocking: true },
  propose: { id: 'propose', label: 'Propose the purchase to your vault', detail: 'Create one threshold-gated proposal for the approval and the purchase together — nothing is charged until your vault executes it.', kind: 'transaction', blocking: true },
  pay: { id: 'pay', label: 'Pay for membership', detail: 'Send your USDC and receive the membership.', kind: 'transaction', blocking: true },
  sign: { id: 'sign', label: 'Sign to set up private wagers', detail: 'Sign a message to derive your encryption key — no funds move, no gas.', kind: 'signature', blocking: false },
  register: { id: 'register', label: 'Register your encryption key', detail: 'Publish your encryption key so others can send you private wagers.', kind: 'transaction', blocking: false },
}

/*
 * Issue #1368 — a vault whose policy guard denies delegatecall cannot execute a MultiSend, so the
 * approval and the purchase are proposed SEPARATELY (at consecutive nonces). The propose step must
 * say so: "the approval and the purchase together" is a false statement about that run.
 */
const PROPOSE_DETAIL_BY_SHAPE = {
  split: 'Create two threshold-gated proposals — the USDC approval, then the purchase — queued in order. Nothing is charged until your vault executes them.',
  single: "Create one threshold-gated proposal for the purchase — the vault's USDC approval already covers this price. Nothing is charged until your vault executes it.",
}

const makeStep = (id, { proposalShape = null } = {}) => ({
  ...STEP_DEFS[id],
  ...(id === 'propose' && PROPOSE_DETAIL_BY_SHAPE[proposalShape]
    ? { detail: PROPOSE_DETAIL_BY_SHAPE[proposalShape] }
    : null),
  state: 'pending',
  failureReason: null,
  txHash: null,
})

/**
 * @param {object} [deps] - injectable for tests; defaults to the real services.
 */
export function usePurchaseFlow(deps = {}) {
  const purchaseFn = deps.purchaseRoleWithStablecoin || purchaseRoleWithStablecoin
  const approvalCheckFn = deps.checkApprovalNeeded || checkApprovalNeeded
  const approvalForAddressFn = deps.checkApprovalNeededForAddress || checkApprovalNeededForAddress
  const registerKeyFn = deps.ensureKeyRegistered || ensureKeyRegistered

  const [steps, setSteps] = useState([])
  const [status, setStatus] = useState('idle') // idle | running | succeeded | proposed | failed
  const [keyRegOutcome, setKeyRegOutcome] = useState(null) // null | success | skipped | failed | unavailable

  const paramsRef = useRef(null)
  const [purchaseReceipt, setPurchaseReceipt] = useState(null)
  const publicKeyRef = useRef(null)
  // Spec 098: the acting signer for THIS run (one ceremony serves every step), and the reason the
  // run's bound identity was invalidated — set once, it permanently blocks retry.
  const actingSignerRef = useRef(null)
  const invalidatedRef = useRef(null)

  const updateStep = useCallback((id, patch) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }, [])

  // Map approve/pay events from the service onto step state.
  const handleProgress = useCallback((evt) => {
    const { step, phase, txHash } = evt || {}
    if (!step || phase === 'skipped') return
    if (phase === 'start') updateStep(step, { state: 'active', failureReason: null })
    else if (phase === 'sent') updateStep(step, { state: 'confirming', txHash })
    else if (phase === 'confirmed') updateStep(step, { state: 'completed', txHash })
  }, [updateStep])

  // Gasless seam (specs 035 + 036): relay the payment when a relayer is live, else self-submit via the
  // existing approve+pay service call (never-stranded). The EIP-3009 `value` is the exact price the
  // contract pulls (resolveMembershipIntentParams). Self-submit reads live params from paramsRef and
  // reuses handleProgress so approve/pay step events fire identically on the fallback path.
  //
  // Spec 098 FR-007/FR-008: BOTH legs of the pay step read the acting signer from the same ref, so
  // relayed and self-submitted purchases are signed by the same account. `actingSigner()` returns
  // `undefined` on the personal path, which the seam reads as "no override" — the connected wallet
  // signs, exactly as before.
  const actingSigner = () => actingSignerRef.current ?? undefined
  const signerForRun = () => actingSignerRef.current ?? paramsRef.current?.signer
  const selfSubmitPurchase = () => purchaseFn(
    signerForRun(), paramsRef.current.roleName, paramsRef.current.priceUSD,
    paramsRef.current.tier, paramsRef.current.action, paramsRef.current.termsHash, handleProgress,
  )
  const purchaseTx = useGaslessWrite('purchaseTier', {
    signer: actingSigner,
    params: (ip) => ({ role: ip.roleHash, tier: ip.validTier, acceptedTermsHash: ip.acceptedTermsHash }),
    payment: (ip) => ({ value: ip.price }),
    selfSubmit: selfSubmitPurchase,
  })
  const upgradeTx = useGaslessWrite('upgradeTier', {
    signer: actingSigner,
    params: (ip) => ({ role: ip.roleHash, tier: ip.validTier, acceptedTermsHash: ip.acceptedTermsHash }),
    payment: (ip) => ({ value: ip.price }),
    selfSubmit: selfSubmitPurchase,
  })
  const extendTx = useGaslessWrite('extendMembership', {
    signer: actingSigner,
    params: (ip) => ({ role: ip.roleHash }),
    payment: (ip) => ({ value: ip.price }),
    selfSubmit: selfSubmitPurchase,
  })

  // Mark the in-flight (or next pending) step as failed and attribute the reason.
  const markFailed = useCallback((reason) => {
    setSteps((prev) => {
      let idx = prev.findIndex((s) => s.state === 'active' || s.state === 'confirming')
      if (idx === -1) idx = prev.findIndex((s) => s.state === 'pending')
      if (idx === -1) return prev
      return prev.map((s, i) => (i === idx ? { ...s, state: 'failed', failureReason: reason } : s))
    })
  }, [])

  /**
   * Spec 098 FR-004 — get the ACTING account's signer for this run, running the deferred ceremony
   * (unlock passphrase / connect device) only on the first call. The address is verified against
   * the binding: a ceremony that hands back a different account must never sign a purchase whose
   * screen names another one (SC-003).
   */
  const ensureActingSigner = useCallback(async () => {
    const p = paramsRef.current
    if (actingSignerRef.current) return actingSignerRef.current
    const signer = await p.getActingSigner()
    if (!signer) throw new Error('No signer was returned for the acting account, so nothing has been signed.')
    let signerAddress = null
    try { signerAddress = await signer.getAddress() } catch { /* reported below */ }
    const expected = p.acting?.address
    if (expected && String(signerAddress).toLowerCase() !== String(expected).toLowerCase()) {
      throw new Error(
        `The signing ceremony returned ${signerAddress || 'an unknown account'}, not the acting account ` +
        `${expected}. Nothing has been signed — a membership is credited to whoever signs, so it must be ` +
        'the account this purchase names.',
      )
    }
    actingSignerRef.current = signer
    return signer
  }, [])

  /**
   * Run the flow from a given segment: 'purchase' (approve+pay, or the vault proposal), 'sign', or
   * 'register'. Used for both the initial run and resume-after-failure.
   */
  const runSegments = useCallback(async (fromSegment) => {
    const p = paramsRef.current
    if (!p) return
    if (invalidatedRef.current) {
      markFailed(invalidatedRef.current)
      setStatus('failed')
      return
    }
    setStatus('running')
    try {
      // One ceremony serves the whole run — including a retry that resumes at 'sign' or 'register'.
      if (p.acting && typeof p.getActingSigner === 'function') await ensureActingSigner()

      if (fromSegment === 'purchase' && p.proposePurchase) {
        // ── Vault rail (FR-005) ──────────────────────────────────────────────────────────────
        // A Safe has no key, so the purchase becomes ONE threshold-gated proposal. Nothing is paid
        // here: the terminal state is `proposed`, onPaid never fires, and the key steps are skipped
        // because a vault cannot sign a key-derivation message (spec 084 refuses it by design).
        updateStep('propose', { state: 'active', failureReason: null })
        const proposal = await p.proposePurchase()
        updateStep('propose', { state: 'completed', txHash: proposal?.safeTxHash ?? null })
        setPurchaseReceipt(proposal)
        updateStep('sign', { state: 'skipped', failureReason: 'A vault has no signing key, so encrypted features are unavailable for this account.' })
        updateStep('register', { state: 'skipped', failureReason: 'Encrypted features unavailable for this account' })
        setKeyRegOutcome('unavailable')
        setStatus('proposed')
        return
      }

      if (fromSegment === 'purchase') {
        // Passkey smart accounts (spec 041, FR-016) batch approve+purchase into ONE biometric
        // confirmation via the 4337 bundler — a single 'pay' step, no approve step. Everyone else
        // routes the pay through the spec-035/036 gasless seam: relay when a relayer is live, else
        // self-submit approve+pay (resolveMembershipIntentParams gives the exact price the contract
        // pulls). Same on-chain result either way.
        let receipt
        if (p.batchPurchase) {
          updateStep('pay', { state: 'active', failureReason: null })
          receipt = await p.batchPurchase()
          updateStep('pay', { state: 'completed', txHash: receipt?.txHash })
        } else {
          // The ACTING signer resolves the intent params too: its address decides the upgrade
          // basis (and therefore the price), which is a different answer for a different account.
          const ip = await resolveMembershipIntentParams(signerForRun(), p.roleName, p.tier, p.action, p.termsHash)
          const tx = p.action === 'upgrade' ? upgradeTx : (p.action === 'extend' ? extendTx : purchaseTx)
          const result = await tx.run(ip)
          if (result?.error) throw result.error
          receipt = result
        }
        setPurchaseReceipt(receipt)
        // Defensively ensure approve (if present) + pay show completed.
        setSteps((prev) => prev.map((s) =>
          (s.id === 'approve' || s.id === 'pay') && s.state !== 'completed'
            ? { ...s, state: 'completed' }
            : s,
        ))
        // Membership is now active — fire side effects exactly once.
        try { await p.onPaid?.(receipt) } catch (e) { console.warn('[usePurchaseFlow] onPaid failed:', e?.message) }
      }

      if (fromSegment === 'purchase' || fromSegment === 'sign') {
        updateStep('sign', { state: 'active', failureReason: null })
        try {
          // FR-012: the key steps follow the PURCHASER. On an acting rail the derivation is
          // offered through the same acting signer, so the key published against the acting
          // address is one that account can actually use.
          const keys = await p.ensureInitialized(actingSignerRef.current ?? undefined)
          if (!keys?.publicKey) throw new Error('Could not derive encryption keys')
          publicKeyRef.current = keys.publicKey
          updateStep('sign', { state: 'completed' })
        } catch (err) {
          // Device-dependent degradation (spec 041, clarification Q1): a
          // passkey/authenticator without deterministic key material keeps the
          // membership fully valid — only encrypted features gate off, and the
          // UI says so explicitly instead of failing the whole purchase.
          if (err?.name === 'EncryptionUnavailable') {
            updateStep('sign', { state: 'skipped', failureReason: err.message })
            updateStep('register', { state: 'skipped', failureReason: 'Encrypted features unavailable on this device' })
            setKeyRegOutcome('unavailable')
            setStatus('succeeded')
            return
          }
          throw err
        }
      }

      // register — passkey sessions have no ethers signer, so they supply a
      // `registerKey(publicKey)` closure that publishes the key through sendCalls
      // (one WebAuthn ceremony); EOA wallets keep the signer-based service call.
      updateStep('register', { state: 'active', failureReason: null })
      const wasNew = typeof p.registerKey === 'function'
        ? await p.registerKey(publicKeyRef.current)
        // `p.account` is the PURCHASER's address (the acting account on an acting rail), and
        // the acting signer is what proves control of it.
        : await registerKeyFn(signerForRun(), p.account, publicKeyRef.current)
      updateStep('register', { state: 'completed' })
      setKeyRegOutcome(wasNew ? 'success' : 'skipped')
      setStatus('succeeded')
    } catch (err) {
      markFailed(err?.message || 'Step failed')
      setStatus('failed')
    }
  }, [registerKeyFn, updateStep, markFailed, ensureActingSigner, purchaseTx, upgradeTx, extendTx])

  /**
   * Begin a fresh purchase flow. Builds the step list (omitting approval when not
   * needed) and runs it end to end.
   */
  const start = useCallback(async (params) => {
    paramsRef.current = params
    setPurchaseReceipt(null)
    publicKeyRef.current = null
    setKeyRegOutcome(null)
    // A fresh run binds a fresh identity: no signer carried over, no stale invalidation.
    actingSignerRef.current = null
    invalidatedRef.current = null
    setStatus('running')

    // Vault rail: the approve leg lives INSIDE the proposed batch, so there is no separate
    // approve step to show — the whole purchase is one proposal.
    if (params.proposePurchase) {
      setSteps(['propose', 'sign', 'register'].map((id) => makeStep(id, { proposalShape: params.proposalShape })))
      await runSegments('purchase')
      return
    }

    // Passkey batch path never shows a separate approve step (FR-016).
    // FR-002: on an acting rail the allowance belongs to the ACTING account, so the pre-flight is
    // an ADDRESS read — a signer-implicit one would answer for the connected wallet and could hide
    // an approve step the acting account genuinely needs.
    const approvalNeeded = params.batchPurchase
      ? false
      : params.acting
        ? await approvalForAddressFn(
            params.account, params.roleName, params.priceUSD, params.tier, params.action,
            { chainId: params.chainId },
          )
        : await approvalCheckFn(
            params.signer, params.roleName, params.priceUSD, params.tier, params.action,
          )
    const ids = approvalNeeded ? ['approve', 'pay', 'sign', 'register'] : ['pay', 'sign', 'register']
    setSteps(ids.map(makeStep))

    await runSegments('purchase')
  }, [approvalCheckFn, approvalForAddressFn, runSegments])

  /** Resume from the first failed step without repeating completed paid steps. */
  const retry = useCallback(async () => {
    // FR-013: once the bound identity is gone, no later step may run — not under the old account
    // (whose ceremony was cancelled) and certainly not under the new one.
    if (invalidatedRef.current) return
    const failedIdx = steps.findIndex((s) => s.state === 'failed')
    if (failedIdx === -1) return
    const failedId = steps[failedIdx].id
    // Reset the failed step and everything after it back to pending.
    setSteps((prev) => prev.map((s, i) =>
      i >= failedIdx ? { ...s, state: 'pending', failureReason: null } : s,
    ))
    const segment = (failedId === 'approve' || failedId === 'pay' || failedId === 'propose')
      ? 'purchase'
      : (failedId === 'sign' ? 'sign' : 'register')
    await runSegments(segment)
  }, [steps, runSegments])

  /**
   * Spec 098 FR-013 — the acting selection (or the connected account) changed while this run was in
   * flight. The run's identity was bound at confirm time and cannot be re-resolved: fail it, name
   * the account it was bound to, and refuse every later step permanently. A payment that already
   * confirmed stays truthfully attributed to the bound address — `purchaseReceipt` is untouched.
   */
  const invalidateIdentity = useCallback((reason) => {
    if (invalidatedRef.current) return
    invalidatedRef.current = reason || 'The acting account changed while this purchase was in flight.'
    actingSignerRef.current = null
    markFailed(invalidatedRef.current)
    setStatus('failed')
  }, [markFailed])

  /**
   * Accept a non-blocking key-step failure and finish as success. Valid only when
   * the outstanding failure is a non-blocking (sign/register) step (FR-010).
   */
  const continueAnyway = useCallback(() => {
    const failed = steps.find((s) => s.state === 'failed')
    if (!failed || failed.blocking) return
    setKeyRegOutcome('failed')
    setStatus('succeeded')
  }, [steps])

  const reset = useCallback(() => {
    paramsRef.current = null
    setPurchaseReceipt(null)
    publicKeyRef.current = null
    actingSignerRef.current = null
    invalidatedRef.current = null
    setSteps([])
    setStatus('idle')
    setKeyRegOutcome(null)
  }, [])

  // Derived selectors (data-model.md).
  const total = steps.length
  const completedCount = useMemo(() => steps.filter((s) => s.state === 'completed').length, [steps])
  const activeIndex = useMemo(() => {
    const i = steps.findIndex((s) => s.state === 'active' || s.state === 'confirming' || s.state === 'failed')
    return i === -1 ? null : i
  }, [steps])
  const progressFraction = total > 0 ? completedCount / total : 0
  const activeStep = activeIndex == null ? null : steps[activeIndex]
  const canContinueAnyway = useMemo(
    () => status === 'failed' && steps.some((s) => s.state === 'failed' && !s.blocking),
    [status, steps],
  )

  return {
    steps,
    status,
    total,
    completedCount,
    activeIndex,
    activeStep,
    progressFraction,
    keyRegOutcome,
    canContinueAnyway,
    purchaseReceipt,
    start,
    retry,
    continueAnyway,
    invalidateIdentity,
    reset,
  }
}

export default usePurchaseFlow
