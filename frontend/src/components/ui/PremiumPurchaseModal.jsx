import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRoles } from '../../hooks/useRoles'
import { useWeb3 } from '../../hooks/useWeb3'
import { useNotification } from '../../hooks/useUI'
import { useTierPrices } from '../../hooks/useTierPrices'
import { useEncryption } from '../../hooks/useEncryption'
import { recordRolePurchase } from '../../utils/roleStorage'
import { getUserTierOnChain, buildMembershipPurchaseCalls, checkApprovalNeededForAddress } from '../../utils/blockchainService'
import { useEffectiveAccount } from '../../hooks/useEffectiveAccount'
import { useActiveAccount } from '../../hooks/useActiveAccount'
import { getReadProvider } from '../../utils/rpcProvider'
import { mustSplitBatch, previewBatchSupport } from '../../lib/custody/batchPreflight'
import { membershipChainId } from '../../config/networks'
import { networkName } from '../../lib/chains/estate'
import { ensurePasskeyEncryptionKeys } from '../../lib/passkey/encryption'
import { buildRegisterKeyCalls, hasRegisteredKey } from '../../utils/keyRegistryService'
import { readSession } from '../../connectors/passkey'
import { getCurrentDocument } from '../../utils/legalDocs'
import { getContractAddressForChain } from '../../config/contracts'
import { ACCOUNT_MODERATION_PATH } from '../../constants/legalLinks'
import MembershipAttestation from '../compliance/MembershipAttestation'
import DeviceLossWarning from '../wallet/DeviceLossWarning'
import { getTransactionUrl } from '../../config/blockExplorer'
import { usePurchaseFlow } from '../../hooks/usePurchaseFlow'
import PurchaseProgressView from './PurchaseProgressView'
import './PremiumPurchaseModal.css'

/**
 * PremiumPurchaseModal — tier-selection flow for the single paid role
 * (`WAGER_PARTICIPANT`). All tier benefits are framed around peer-to-peer
 * wagers because that is the only thing the new on-chain `Limits` struct
 * gates: `monthlyMarketCreation` and `maxConcurrentMarkets`.
 *
 * Steps:
 *   1. Choose tier
 *   2. Review (with required acknowledgement of pause + freeze powers)
 *   3. Complete
 */

const STEPS = [
  { id: 'tier',     label: 'Choose Tier', icon: '1' },
  { id: 'review',   label: 'Review',      icon: '2' },
  { id: 'complete', label: 'Complete',    icon: '3' },
]

const MEMBERSHIP_TIERS = {
  BRONZE:   { id: 1, name: 'Bronze',   color: '#cd7f32' },
  SILVER:   { id: 2, name: 'Silver',   color: '#c0c0c0' },
  GOLD:     { id: 3, name: 'Gold',     color: '#ffd700' },
  PLATINUM: { id: 4, name: 'Platinum', color: '#e5e4e2' },
}

// UI fallbacks — overridden by on-chain `Limits` from `useTierPrices.getLimits`.
const TIER_FALLBACK_LIMITS = {
  BRONZE:   { monthlyMarketCreation: 15,  maxConcurrentMarkets: 5,  duration: '30 days' },
  SILVER:   { monthlyMarketCreation: 30,  maxConcurrentMarkets: 10, duration: '30 days' },
  GOLD:     { monthlyMarketCreation: 100, maxConcurrentMarkets: 30, duration: '30 days' },
  PLATINUM: { monthlyMarketCreation: 0,   maxConcurrentMarkets: 0,  duration: '30 days' },
}

const ROLE_KEY = 'WAGER_PARTICIPANT'

const ROLE_COPY = {
  icon: '🎲',
  tagline: 'Create and accept peer-to-peer wagers',
  features: [
    'Create 1v1 wagers in USDC or WPOL',
    'Self-resolve, third-party arbitrator, or Polymarket auto-resolve',
    'Share via QR code or direct link',
    'Escrow + refund protection if a counterparty no-shows',
  ],
}

const fmtLimit = (v) => (v === 0 || v === '0' || v === null || v === undefined) ? 'Unlimited' : v

function TierLimits({ tierName, chainLimits }) {
  const fb = TIER_FALLBACK_LIMITS[tierName] || {}
  const monthly = chainLimits?.monthlyMarketCreation ?? fb.monthlyMarketCreation
  const concurrent = chainLimits?.maxConcurrentMarkets ?? fb.maxConcurrentMarkets
  return (
    <div className="ppm-tier-limits">
      <div className="ppm-limit-item">
        <span className="ppm-limit-label">Wagers / month:</span>
        <span className="ppm-limit-value">{fmtLimit(monthly)}</span>
      </div>
      <div className="ppm-limit-item">
        <span className="ppm-limit-label">Open wagers at once:</span>
        <span className="ppm-limit-value">{fmtLimit(concurrent)}</span>
      </div>
    </div>
  )
}

/**
 * @param {object}   props
 * @param {boolean}  props.isOpen
 * @param {function} props.onClose
 * @param {string}   [props.action]  - 'purchase', 'upgrade' or 'extend'. OMIT IT to have the
 *   modal decide from the member's own membership: an entry point that serves both new and
 *   existing members (the Membership tab's "Renew / Upgrade") cannot know which it is, and
 *   guessing 'purchase' is what made #1226 — purchaseTier reverts AlreadyActive() for anyone
 *   who already holds a membership, which is precisely who that control is shown to.
 */
function PremiumPurchaseModal({ isOpen = true, onClose, action }) {
  const { grantRole, loadRoles } = useRoles()
  const {
    account, isConnected, isCorrectNetwork, switchNetwork, chainId,
    loginMethod, sendCalls, provider,
  } = useWeb3()
  const { showNotification } = useNotification()
  // ── WHICH ACCOUNT GETS THE MEMBERSHIP (specs 063 + 088 + 098) ──────────────────────────
  // `MembershipManager.purchaseTier` credits `msg.sender` and takes NO beneficiary, so a
  // membership lands on exactly the address that signed. Spec 098 threads the purchase THROUGH
  // the acting account on every rail it has one for, so the account whose tier this modal shows
  // is the account that signs — and the accounts that genuinely cannot be `msg.sender` on the
  // membership chain keep a refusal that names them and says why (FR-003).
  const {
    address: actingAddress, isActingAccount, label: actingLabel, type: actingType,
    chainId: actingChainId,
  } = useEffectiveAccount()
  const { submit: submitAsActive, resolveActingSigner } = useActiveAccount()
  const membershipAddress = actingAddress || account
  const { getPrice, getLimits, usingFallbackPrices, isTierActive } = useTierPrices()
  const { ensureInitialized } = useEncryption()
  const flow = usePurchaseFlow()
  const navigate = useNavigate()


  // The voucher rail (spec 026) is a parallel way to get the same membership:
  // buy a transferable voucher to gift/resell, or redeem one you hold. It lives
  // on the dedicated /vouchers view; only surface the entry point where the
  // voucher contracts are actually deployed for the connected chain.
  const voucherAvailable = Boolean(
    getContractAddressForChain('membershipVoucher', chainId) &&
    getContractAddressForChain('membershipManager', chainId)
  )

  // ── PURCHASES SETTLE ON THE REFERENCE CHAIN (spec 071 FR-006/FR-007) ────────────────────
  // Membership must be READABLE from one place (FR-003), which is only true if it is also
  // WRITTEN in one place. A purchase that landed elsewhere would create a membership the
  // reference-chain read can never see — the member pays and stays unentitled everywhere.
  //
  // `isCorrectNetwork` is not enough here: it means "any supported chain". The purchase needs
  // one specific chain, disclosed before signature, with the wallet actually on it.

  const ACTING_KIND_LABEL = { vault: 'multisig vault', legacy: 'recovered account', hardware: 'hardware account', derived: 'derived account' }
  const actingAccountName =
    actingLabel || ACTING_KIND_LABEL[actingType] || 'another account'

  const purchaseChainId = membershipChainId()
  const purchaseNetworkName = networkName(purchaseChainId)
  const onPurchaseChain = Number(chainId) === Number(purchaseChainId)

  /*
   * ── WHICH RAIL, AND WHETHER THERE IS ONE (spec 098 FR-003) ─────────────────────────────
   *
   * Identity FIRST, rail second. An acting account is purchase-eligible exactly when it can be
   * `msg.sender` on the membership chain, and each eligible kind has its own way of signing:
   *
   *   personal (incl. passkey)  → today's rails, byte-identical (FR-016)
   *   vault ON the membership chain → one threshold-gated Safe proposal (FR-005)
   *   recovered legacy / hardware   → the spec-088 deferred ceremony's own signer (FR-004)
   *
   * Everything else refuses BEFORE any signature, naming the account and the specific reason —
   * never the spec-088-era blanket "switch back to your personal wallet", which said nothing
   * about which accounts could be helped by switching CHAINS instead, and nothing about the
   * accounts that nothing would unblock.
   *
   * The passkey batch is deliberately not reachable while acting: `sendCalls` executes as the
   * passkey smart account, so using it under an acting label would put both the funds and the
   * tier on the passkey address while the screen named another account (FR-006).
   */
  const purchaseRail = useMemo(() => {
    if (!isActingAccount) {
      return { rail: loginMethod === 'passkey' ? 'passkey' : 'classic', eligible: true, reason: null }
    }
    if (actingType === 'vault') {
      if (actingChainId == null || Number(actingChainId) !== Number(purchaseChainId)) {
        const where = actingChainId == null ? 'another network' : networkName(actingChainId)
        return {
          rail: null,
          eligible: false,
          reason: `Memberships live on ${purchaseNetworkName}, and ${actingAccountName} exists only on ${where} — so a purchase here could never be credited to it. Nothing has been proposed.`,
        }
      }
      return { rail: 'vault', eligible: true, reason: null }
    }
    if (actingType === 'legacy' || actingType === 'hardware') {
      return { rail: 'acting-signer', eligible: true, reason: null }
    }
    return {
      rail: null,
      eligible: false,
      reason: `${actingAccountName} has no sending identity on ${purchaseNetworkName}, and a membership is credited only to the account that sends the transaction — so it cannot be given one. Switching accounts would unblock this; switching networks would not.`,
    }
  }, [isActingAccount, actingType, actingChainId, actingAccountName, loginMethod, purchaseChainId, purchaseNetworkName])

  // FR-010: one place says who is credited, who pays, where it settles, and (vault) that the
  // outcome is a proposal.
  const creditedName = isActingAccount ? actingAccountName : 'your account'
  const payerDescription = purchaseRail.rail === 'vault'
    ? "the vault's own USDC"
    : isActingAccount
      ? `${actingAccountName}'s own USDC`
      : 'your connected wallet'

  const [currentStep, setCurrentStep] = useState(0)
  const [selectedTier, setSelectedTier] = useState('BRONZE')
  const [acknowledged, setAcknowledged] = useState(false)
  const [showProcessing, setShowProcessing] = useState(false)
  const [purchaseResult, setPurchaseResult] = useState(null)
  const [errors, setErrors] = useState({})
  const [keyRegStatus, setKeyRegStatus] = useState(null) // null | 'registering' | 'success' | 'skipped' | 'failed'
  const [keyRegError, setKeyRegError] = useState(null)
  // Spec 098 FR-013: the identity this run was bound to at confirm time.
  const boundIdentityRef = useRef(null)

  // While any wallet interaction is in flight the modal must not be dismissed
  // (FR-012) and the step/footer controls are locked.
  const isBusy = flow.status === 'running'

  const [userCurrentTier, setUserCurrentTier] = useState(0)
  const [isLoadingTier, setIsLoadingTier] = useState(false)
  // FR-004: false ⇒ the reference chain would not answer, so the current tier is UNKNOWN.
  // Purchase is refused in that state rather than guessing (FR-005).
  const [tierReadable, setTierReadable] = useState(true)
  const [tierRetry, setTierRetry] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!membershipAddress) return
    // Clear any tier read from a previously-selected chain so a testnet tier
    // doesn't linger when the wallet switches to mainnet (where the user may
    // have no membership). Re-fetch for the chain the wallet is now on.
    setUserCurrentTier(0)
    setIsLoadingTier(true)
    getUserTierOnChain(membershipAddress, ROLE_KEY, chainId).then(({ tier, readable }) => {
      if (cancelled) return
      // FR-004/FR-005: an unreadable reference chain is NOT tier 0. Offering "upgrade from
      // None" to a member who already holds Platinum — because their RPC blipped — would take
      // their money for a tier they already own.
      setTierReadable(readable !== false)
      if (readable === false) return
      setUserCurrentTier(tier || 0)
      // Default tier select to the lowest available upgrade (or BRONZE for fresh)
      const minTier = (tier || 0) + 1
      if (minTier <= 4) {
        const tierKeys = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM']
        setSelectedTier(tierKeys[minTier - 1])
      }
    }).catch((err) => {
      console.warn('[PremiumPurchaseModal] tier fetch failed:', err)
      if (!cancelled) setTierReadable(false)
    }).finally(() => {
      if (!cancelled) setIsLoadingTier(false)
    })
    return () => { cancelled = true }
  }, [membershipAddress, chainId, tierRetry])

  /*
   * ENTRY MODE — what this modal is for, from the caller or from the member.
   *
   * WalletButton opens it with an explicit 'upgrade' / 'extend' and those are honoured. The
   * Membership tab's combined "Renew / Upgrade" passes nothing, because it serves whichever
   * the member turns out to need; for an existing member that is 'manage', which offers their
   * current tier (renew) alongside the higher ones (upgrade), matching what the button says.
   */
  const entryMode = action || (tierReadable && userCurrentTier > 0 ? 'manage' : 'purchase')
  const isUpgradeFlow = entryMode === 'upgrade'
  const isExtendFlow = entryMode === 'extend'
  const isManageFlow = entryMode === 'manage'
  const allowsSameTier = isExtendFlow || isManageFlow

  /*
   * EXPIRED RENEWAL — an 'extend' entry whose ACTIVE tier reads 0.
   *
   * `getActiveTier` returns 0 for an EXPIRED membership, so the member the Renew CTA exists
   * for (RoleDetailsCard shows it off the raw stored tier, which persists past expiry) arrived
   * here with `userCurrentTier === 0`. The same-tier filter below then offered NOTHING: no tier
   * cards, no explanatory card, Continue disabled — a dead-end for exactly the member who most
   * needs to pay us. On-chain nothing blocks them: `purchaseTier` reverts AlreadyActive only
   * while UNexpired, so an expired member can buy any tier fresh (and `effectiveAction` already
   * resolves tier-0 to 'purchase'). Fall back to the purchase-mode offering and say why.
   * ('manage' can't reach tier 0 — it is only ever derived from `userCurrentTier > 0` — but is
   * included so a future explicit caller gets the same fallback rather than the dead-end.)
   */
  const isExpiredRenewal = allowsSameTier && tierReadable && !isLoadingTier && userCurrentTier === 0

  const availableTiers = useMemo(() => {
    return Object.entries(MEMBERSHIP_TIERS).filter(([tierKey, tier]) => {
      // A tier the CONTRACT will refuse is never offered: `purchaseTier` reverts TierInactive()
      // for `active == false`, and it does so AFTER the member's USDC approval has landed.
      // Only a DEFINITE false hides — `null` (unread) keeps the tier offered so an RPC blip
      // cannot empty the grid, and the contract remains the real gate.
      if (isTierActive(ROLE_KEY, tierKey) === false) return false
      if (allowsSameTier) {
        // Offer the current tier and up — but only while a current tier exists. At an ACTUALLY
        // READ tier 0 (expired renewal) fall back to the full purchase offering; never return
        // an empty list to a member who can legally buy. An UNREADABLE tier is not tier 0
        // (FR-004): keep the pre-existing empty offering so only the retry card renders.
        if (userCurrentTier > 0) return tier.id >= userCurrentTier
        return tierReadable && tier.id > 0
      }
      return tier.id > userCurrentTier
    })
  }, [userCurrentTier, allowsSameTier, tierReadable, isTierActive])

  /*
   * The default selection is BRONZE, which is exactly the tier production had INACTIVE — so a
   * member opened the modal already pointed at a purchase the contract would refuse. If the
   * current selection is not on offer, move to the first tier that is; never price, quote or
   * submit a tier the grid is not showing.
   */
  useEffect(() => {
    if (availableTiers.length === 0) return
    if (availableTiers.some(([tierKey]) => tierKey === selectedTier)) return
    setSelectedTier(availableTiers[0][0])
  }, [availableTiers, selectedTier])

  const selectedTierInfo = MEMBERSHIP_TIERS[selectedTier]

  /*
   * WHICH CONTRACT CALL — decided by the member's CURRENT tier against the one they picked,
   * never by how the modal was opened (#1226).
   *
   * MembershipManager refuses purchaseTier for anyone already active (AlreadyActive, L279), so
   * an entry point that opened in 'purchase' mode sent an existing member down a path that
   * could only revert — after their USDC approval had already landed. upgradeTier and
   * extendTier exist for exactly these two cases.
   *
   * Safe to read `userCurrentTier` here: handleSubmit refuses outright while `tierReadable` is
   * false (FR-005), so this only ever decides on a tier that was actually read. The fallback
   * matters anyway for the disabled-button render path.
   *
   * An EXPIRED member (active tier 0, whatever tier is still stored) resolves to 'purchase' on
   * every selection, deliberately: `purchaseTier` succeeds once expired (AlreadyActive guards
   * only an UNexpired membership) and charges exactly the full tier price shown above, while
   * `upgradeTier` reverts NoActiveMembership on expired and `extendMembership` needs the stored
   * tier this modal never read. Do not route tier-0 through 'extend' or 'upgrade'.
   */
  const effectiveAction = useMemo(() => {
    if (!tierReadable) return action || 'purchase'
    if (userCurrentTier <= 0) return 'purchase'
    if (selectedTierInfo && selectedTierInfo.id > userCurrentTier) return 'upgrade'
    return 'extend'
  }, [action, tierReadable, userCurrentTier, selectedTierInfo])

  const selectedPrice = getPrice(ROLE_KEY, selectedTier)
  const chainLimits = getLimits(ROLE_KEY, selectedTier)

  /*
   * ── Issue #1368 — WHAT SHAPE will the vault proposal be, and why? ───────────────────────────
   *
   * The batched purchase is [approve(exact), purchase] through MultiSendCallOnly, i.e. a
   * DELEGATECALL. Both policy guards deny operation != 0 once a vault has an active policy
   * (`SafePolicyGuardV2._preCheck`), so on a policy-guarded vault that proposal is approved by the
   * signers and then reverts — no funds lost, but a dishonest screen, on exactly the vaults that
   * followed our own starter-policy guidance.
   *
   * Three shapes, resolved ONCE (the same answer the propose closure uses, so the screen cannot
   * describe something other than what is created):
   *
   *   'single' — the vault's live allowance already covers the price, so there is one leg. The
   *              submit seam emits a one-leg batch as a plain CALL, which every guard evaluates
   *              normally. Nothing to split.
   *   'batch'  — the guard allows delegatecall (no policy, or no guard). Unchanged behaviour.
   *   'split'  — the guard denies it, or could not be read. TWO proposals at CONSECUTIVE nonces:
   *              approve at N, purchase at N+1.
   *
   * Why split rather than refuse the purchase outright: the approve is for the EXACT quoted price
   * to one FairWins contract, and consecutive nonces mean the purchase cannot execute before the
   * approve and nothing else can take the slot between them — so the exposure is bounded to the
   * membership price, for as long as the queue takes. Refusing instead would tell members who
   * followed our own hardening guidance that they must LOOSEN their policy to buy a membership,
   * which is a worse outcome than a bounded, disclosed, exact-amount allowance. The residual case
   * — a purchase leg never executed, leaving a standing exact-price allowance — is stated on the
   * confirm screen, and the vault can cancel or revoke it from its own queue.
   */
  const [resolvedVaultShape, setResolvedVaultShape] = useState(null) // null | {shape, batchSupport, legs}
  const vaultShapeRef = useRef({ key: null, promise: null })

  const resolveVaultShape = useCallback(async (acceptedTermsHash) => {
    const tierValue = selectedTierInfo?.id
    const key = `${actingAddress}:${purchaseChainId}:${tierValue}:${effectiveAction}`
    if (vaultShapeRef.current.key !== key) {
      vaultShapeRef.current = {
        key,
        promise: (async () => {
          const readProvider = getReadProvider(purchaseChainId)
          const { calls } = await buildMembershipPurchaseCalls(
            readProvider, actingAddress, ROLE_KEY, tierValue, effectiveAction, acceptedTermsHash,
          )
          // FR-015: the approve leg is omitted when the VAULT's live allowance already covers the
          // quoted price — read for the vault's address, never signer-implicit.
          const needsApprove = await checkApprovalNeededForAddress(
            actingAddress, ROLE_KEY, selectedPrice, tierValue, effectiveAction,
            { provider: readProvider, chainId: purchaseChainId },
          )
          const legs = (needsApprove ? calls : calls.slice(1))
            .map((c) => ({ to: c.target, value: c.value ?? 0n, data: c.data }))
          if (legs.length < 2) return { shape: 'single', batchSupport: null, legs }
          const probe = await previewBatchSupport(actingAddress, purchaseChainId)
          return {
            shape: mustSplitBatch(probe.support) ? 'split' : 'batch',
            batchSupport: probe.support,
            legs,
          }
        })(),
      }
    }
    return vaultShapeRef.current.promise
  }, [actingAddress, purchaseChainId, selectedTierInfo?.id, effectiveAction, selectedPrice])

  // Resolve it for DISPLAY as soon as the vault rail is the one in play, so the shape is on the
  // confirm screen before the member signs rather than discovered afterwards.
  const onVaultRail = purchaseRail.rail === 'vault'
  useEffect(() => {
    if (!onVaultRail || !actingAddress || !selectedTierInfo?.id) return undefined
    let on = true
    const termsHash = getCurrentDocument('terms')?.hash || null
    resolveVaultShape(termsHash)
      .then((res) => { if (on) setResolvedVaultShape(res) })
      .catch(() => { /* the shape stays unstated rather than guessed */ })
    return () => { on = false }
  }, [onVaultRail, actingAddress, selectedTierInfo?.id, resolveVaultShape])
  // Read only on the rail it describes: a shape resolved for a vault the member has since switched
  // away from must never describe a different account's proposal.
  const vaultShape = onVaultRail ? resolvedVaultShape : null

  const validateStep = useCallback((step) => {
    const next = {}
    if (step === 0) {
      if (!selectedTierInfo) next.tier = 'Select a tier to continue'
      else if (!allowsSameTier && selectedTierInfo.id <= userCurrentTier) {
        next.tier = 'Select a tier higher than your current one'
      }
    }
    if (step === 1 && !acknowledged) {
      next.ack = 'Please acknowledge the operator-powers notice to continue'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }, [selectedTierInfo, userCurrentTier, allowsSameTier, acknowledged])

  const handleNext = useCallback(() => {
    if (validateStep(currentStep)) setCurrentStep((s) => Math.min(s + 1, STEPS.length - 1))
  }, [currentStep, validateStep])

  const handleBack = useCallback(() => setCurrentStep((s) => Math.max(s - 1, 0)), [])

  const handleStepClick = useCallback((stepIndex) => {
    if (stepIndex < currentStep) setCurrentStep(stepIndex)
    else if (stepIndex === currentStep + 1 && validateStep(currentStep)) setCurrentStep(stepIndex)
  }, [currentStep, validateStep])

  const handlePurchase = async () => {
    if (!isConnected || !account) {
      showNotification('Please connect your wallet first', 'error')
      return
    }
    // FR-005: refuse while membership is UNKNOWN, and attribute the refusal to the failed read
    // rather than to anything about the member's account.
    if (!tierReadable) {
      showNotification(
        `Cannot purchase yet: your current membership could not be read from ${networkName(membershipChainId())}. Retry the check first.`,
        'error',
      )
      return
    }
    // FR-003: the acting account must be able to be `msg.sender` on the membership chain. When it
    // cannot, refuse here — before anything is signed, sent or proposed — with the reason, rather
    // than substituting the connected wallet (the exact bug class spec 088 FR-002 eliminated).
    if (!purchaseRail.eligible) {
      showNotification(purchaseRail.reason, 'error')
      return
    }
    // FR-006/FR-007: not "a supported network" — THE reference chain, named. Declining the
    // switch must leave no purchase attempted anywhere, which is why this returns rather than
    // falling through to a best-effort send on whatever chain the wallet is on.
    if (!onPurchaseChain) {
      showNotification(
        `Membership purchases settle on ${purchaseNetworkName}. Switch your wallet there to continue.`,
        'error',
      )
      return
    }
    if (!isCorrectNetwork) {
      showNotification('Please switch to the correct network', 'error')
      return
    }
    if (!validateStep(1)) return

    const tierValue = selectedTierInfo.id
    const tierName = selectedTierInfo.name
    const rail = purchaseRail.rail
    showNotification(
      rail === 'passkey'
        ? `Confirm with your passkey to complete your ${tierName} membership (${selectedPrice} USDC)`
        : rail === 'vault'
          ? `Confirm the wallet prompts to propose your ${tierName} membership (${selectedPrice} USDC) to ${actingAccountName}`
          : rail === 'acting-signer'
            ? `Unlock ${actingAccountName} when prompted to complete its ${tierName} membership (${selectedPrice} USDC)`
            : `Confirm the wallet prompts to complete your ${tierName} membership (${selectedPrice} USDC)`,
      'info',
      10000,
    )

    /*
     * FR-013 — bind the identity HERE, at confirm, not at render. Everything the flow does from
     * this point resolves against this binding; if the acting selection (or the connected wallet)
     * changes while the run is in flight, the effect below invalidates it rather than letting a
     * later step re-resolve to whoever is selected by then.
     */
    const acting = isActingAccount
      ? { kind: actingType, address: actingAddress, chainId: actingChainId ?? null, label: actingLabel || null }
      : undefined
    boundIdentityRef.current = {
      address: (membershipAddress || '').toLowerCase(),
      connectedAddress: (account || '').toLowerCase(),
      name: creditedName,
    }

    // Switch to the dedicated Processing view (spec 022) — the step indicator
    // surfaces each wallet interaction in turn.
    setShowProcessing(true)
    try {
      // Spec 007 (FR-039): record the accepted in-force Terms version hash on-chain.
      const acceptedTermsHash = getCurrentDocument('terms')?.hash || null

      // Membership is active the moment payment confirms — run side effects then,
      // before the (non-blocking) key steps. The purchaser is `membershipAddress`, which is the
      // ACTING account on an acting rail: the connected member's own role cache must not be
      // granted a membership somebody else now holds.
      const onPaid = async (receipt) => {
        if (!isActingAccount) {
          grantRole(ROLE_KEY)
          try { await loadRoles() } catch (e) { console.warn('refresh roles failed:', e) }
        }
        recordRolePurchase(membershipAddress, ROLE_KEY, {
          price: selectedPrice,
          currency: 'USDC',
          tier: selectedTier,
          tierValue,
          txHash: receipt?.hash,
          purchasedBy: membershipAddress,
        }, chainId)
        showNotification(
          isActingAccount
            ? `${tierName} membership activated for ${actingAccountName}.`
            : `${tierName} membership activated.`,
          'success', 7000,
        )
      }

      if (rail === 'vault') {
        /*
         * ── VAULT RAIL (FR-005) ──────────────────────────────────────────────────────────────
         * A Safe has no key, so the purchase becomes ONE threshold-gated proposal whose batch is
         * [approve(price)?, purchase] via MultiSendCallOnly. On execution `msg.sender` is the
         * vault, so the membership is credited to it and paid from its USDC.
         *
         * approve and purchase are ONE proposal on purpose: split across two, the gap between
         * them is a live allowance to `membershipManager` controlled by a shared queue. Because
         * MultiSend reverts atomically, a price rise before execution reverts the purchase leg AND
         * the approve — leaving no orphaned allowance.
         */
        const proposePurchase = async () => {
          // The SAME resolution the confirm screen read, so what is created is what was disclosed.
          const { shape, legs } = await resolveVaultShape(acceptedTermsHash)
          if (shape !== 'split') return { ...(await submitAsActive({ batch: legs })), shape }

          /*
           * Issue #1368 — the guard denies delegatecall (or could not be read), so the MultiSend
           * would be approved and then revert. Two proposals instead, at CONSECUTIVE nonces:
           * the purchase sits at N+1 and therefore cannot execute before the approve at N, and no
           * other queued vault transaction can occupy the slot between them. The approve is for
           * the EXACT price, so the window between executions authorises nothing beyond it.
           */
          const first = await submitAsActive(legs[0])
          const second = await submitAsActive(
            first?.nonce != null ? { ...legs[1], nonce: Number(first.nonce) + 1 } : legs[1],
          )
          return { ...second, shape: 'split', proposals: [first, second] }
        }

        await flow.start({
          signer: null,
          account: actingAddress,
          acting,
          chainId: purchaseChainId,
          roleName: ROLE_KEY,
          priceUSD: selectedPrice,
          tier: tierValue,
          action: effectiveAction,
          termsHash: acceptedTermsHash,
          proposePurchase,
          // #1368 — the propose step must describe the shape it is actually creating.
          proposalShape: vaultShape?.shape ?? null,
        })
        return
      }

      if (rail === 'acting-signer') {
        /*
         * ── CLASSIC ACTING RAIL (FR-004) ─────────────────────────────────────────────────────
         * A recovered or hardware account signs for itself. The ceremony (unlock passphrase /
         * connect device) runs at CONFIRM time through the spec-088 broker — never at modal-open
         * or account-switch time — and one ceremony serves the whole flow.
         */
        const getActingSigner = async () => {
          if (typeof resolveActingSigner !== 'function') {
            throw new Error('No signing ceremony is available for this account, so nothing has been signed.')
          }
          return resolveActingSigner()
        }

        /*
         * FR-012 — the key steps follow the PURCHASER. `useEncryption.ensureInitialized` derives
         * (and caches) keys for the CONNECTED account; using it here would publish the operator's
         * key against the acting address. Derive from the acting signer instead, and keep it out
         * of the connected member's key state entirely.
         */
        const ensureInitializedAsActing = async (actingSigner) => {
          if (!actingSigner) throw new Error('No signer for the acting account')
          const { deriveKeyPair } = await import('../../utils/crypto/envelopeEncryption.js')
          const derived = await deriveKeyPair(actingSigner)
          return { publicKey: derived.publicKey }
        }

        await flow.start({
          signer: null,
          account: actingAddress,
          acting,
          chainId: purchaseChainId,
          roleName: ROLE_KEY,
          priceUSD: selectedPrice,
          tier: tierValue,
          action: effectiveAction,
          termsHash: acceptedTermsHash,
          getActingSigner,
          ensureInitialized: ensureInitializedAsActing,
          onPaid,
        })
        return
      }

      if (rail === 'passkey') {
        // Passkey smart account (spec 041, FR-016): approve + purchase are batched into
        // ONE WebAuthn ceremony via the ERC-4337 bundler/relayer (WalletContext.sendCalls) —
        // no browser-wallet prompt and no separate on-chain approval. Reads use the session's
        // RPC provider; the batch carries the exact price the contract pulls.
        const batchPurchase = async () => {
          const { calls } = await buildMembershipPurchaseCalls(
            provider, account, ROLE_KEY, tierValue, effectiveAction, acceptedTermsHash,
          )
          const res = await sendCalls(calls)
          return { hash: res?.txHash, txHash: res?.txHash, route: res?.route }
        }

        // Encryption keys are derived from the WebAuthn PRF master seed (one ceremony),
        // not an EOA signature — same X25519 key the KeyRegistry publishes so envelope
        // interop is identical to the EOA path. A non-PRF authenticator raises
        // EncryptionUnavailable inside, so the flow degrades honestly (clarification Q1):
        // the membership stays fully active, only encrypted features gate off.
        const credentialId = readSession()?.credentialId
        const ensureInitialized = () => ensurePasskeyEncryptionKeys({ account, credentialId })

        // Publish the X25519 key on-chain through sendCalls (one ceremony) — a passkey
        // session has no ethers signer for the KeyRegistry write.
        const registerKey = async (publicKey) => {
          if (await hasRegisteredKey(account, provider)) return false
          const calls = buildRegisterKeyCalls(publicKey, chainId, acceptedTermsHash)
          await sendCalls(calls)
          return true
        }

        await flow.start({
          signer: null,
          account,
          roleName: ROLE_KEY,
          priceUSD: selectedPrice,
          tier: tierValue,
          action: effectiveAction,
          termsHash: acceptedTermsHash,
          batchPurchase,
          ensureInitialized,
          registerKey,
          onPaid,
        })
        return
      }

      // Classic wallet path (EOA connectors): acquire the injected signer and route the
      // purchase through the gasless-or-self-submit seam inside usePurchaseFlow.
      const { ethers } = await import('ethers')
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
      if (!accounts || accounts.length === 0) throw new Error('No wallet account authorised')
      const browserProvider = new ethers.BrowserProvider(window.ethereum)
      const signer = await browserProvider.getSigner()

      await flow.start({
        signer,
        account,
        roleName: ROLE_KEY,
        priceUSD: selectedPrice,
        tier: tierValue,
        action: effectiveAction,
        termsHash: acceptedTermsHash,
        ensureInitialized,
        onPaid,
      })
    } catch (err) {
      // Failure to even acquire a signer (before the flow starts). In-flow failures
      // are handled by the progress view's Retry / Continue actions.
      console.error('[PremiumPurchaseModal] purchase setup failed:', err)
      setPurchaseResult({ success: false, error: err.message })
      showNotification('Purchase failed: ' + err.message, 'error', 7000)
      setShowProcessing(false)
      setCurrentStep(2)
    }
  }

  /*
   * FR-013 — the acting selection (or the connected wallet) changed while a run was in flight.
   * The run is bound to the identity captured at confirm; it cannot be re-pointed at a new one, so
   * fail it and name the account it was bound to. A payment that already confirmed stays honestly
   * attributed to that address — the flow keeps its receipt.
   */
  useEffect(() => {
    const bound = boundIdentityRef.current
    if (!bound || flow.status !== 'running') return
    const nowActing = (membershipAddress || '').toLowerCase()
    const nowConnected = (account || '').toLowerCase()
    if (nowActing === bound.address && nowConnected === bound.connectedAddress) return
    boundIdentityRef.current = null
    flow.invalidateIdentity?.(
      `This purchase was bound to ${bound.name}, and the account changed while it was in flight. ` +
      'Nothing further will be signed, and no step will run under a different account.',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipAddress, account, flow.status])

  // React to the flow reaching a terminal state: success (all steps done, or the member chose
  // "Continue anyway" past a non-blocking key step), or — on the vault rail — PROPOSED, which is
  // deliberately not success: nothing is paid and no membership is active until the vault executes.
  useEffect(() => {
    if (flow.status === 'proposed') {
      setPurchaseResult({
        proposed: true,
        tier: selectedTierInfo?.name,
        safeTxHash: flow.purchaseReceipt?.safeTxHash || null,
      })
      setKeyRegStatus(null)
      setShowProcessing(false)
      setCurrentStep(2)
      return
    }
    if (flow.status !== 'succeeded') return
    setPurchaseResult({ success: true, tier: selectedTierInfo?.name, txHash: flow.purchaseReceipt?.hash })
    setKeyRegStatus(flow.keyRegOutcome) // 'success' | 'skipped' | 'failed'
    if (flow.keyRegOutcome === 'failed') {
      setKeyRegError('Key registration was not completed')
    }
    setShowProcessing(false)
    setCurrentStep(2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.status])

  const resetForm = useCallback(() => {
    setCurrentStep(0)
    setSelectedTier('BRONZE')
    setAcknowledged(false)
    setPurchaseResult(null)
    setErrors({})
    setShowProcessing(false)
    setKeyRegStatus(null)
    setKeyRegError(null)
    boundIdentityRef.current = null
    flow.reset()
  }, [flow])

  const handleClose = useCallback(() => {
    if (!isBusy) {
      resetForm()
      onClose?.()
    }
  }, [isBusy, resetForm, onClose])

  /*
   * FR-021 moment 3 of 3 — MEMBERSHIP PURCHASE (spec 041 US5, issue #1405): the warning's
   * "Add a backup now" lands on the controllers card. It CLOSES the modal on the way out, the
   * same as goToVouchers: this dialog is portalled, so navigating from underneath it would leave
   * a purchase flow floating over the Recovery tab.
   */
  const goToControllers = useCallback(() => {
    if (isBusy) return
    resetForm()
    onClose?.()
    navigate('/wallet?tab=security#controllers')
  }, [isBusy, resetForm, onClose, navigate])

  // Leave the purchase modal and open the dedicated voucher view (buy or redeem).
  const goToVouchers = useCallback((hash = '') => {
    if (isBusy) return
    resetForm()
    onClose?.()
    navigate(`/vouchers${hash}`)
  }, [isBusy, resetForm, onClose, navigate])

  if (!isOpen) return null

  return (
    <div
      className="ppm-overlay"
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ppm-title"
    >
      <div className="ppm-modal" onClick={(e) => e.stopPropagation()}>
        <header className="ppm-header">
          <div className="ppm-header-content">
            <h2 id="ppm-title">
              {isUpgradeFlow
                ? 'Upgrade Membership'
                : isExtendFlow
                  ? (isExpiredRenewal ? 'Renew Membership' : 'Extend Membership')
                  : isManageFlow
                    ? 'Renew or Upgrade Membership'
                    : 'Get Wager Access'}
            </h2>
            <p className="ppm-subtitle">
              {isUpgradeFlow
                ? 'Move to a higher tier for more monthly and concurrent wagers.'
                : isExtendFlow
                  ? (isExpiredRenewal
                      ? 'Your membership has expired — choose a tier to renew for another 30 days.'
                      : 'Add another 30 days at your current tier.')
                  : isManageFlow
                    ? 'Add another 30 days at your current tier, or move up to a higher one.'
                    : 'Purchase the Wager Participant role to create and accept peer-to-peer wagers.'}
            </p>
          </div>
          <button
            className="ppm-close-btn"
            onClick={handleClose}
            disabled={isBusy}
            aria-label="Close modal"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </header>

        <nav className="ppm-steps" aria-label="Purchase steps">
          {STEPS.map((step, index) => {
            const isActive = index === currentStep
            const isCompleted = index < currentStep
            return (
              <button
                key={step.id}
                className={`ppm-step ${isActive ? 'active' : ''} ${isCompleted ? 'completed' : ''}`}
                onClick={() => handleStepClick(index)}
                disabled={isBusy || index > currentStep}
                aria-current={isActive ? 'step' : undefined}
              >
                <span className="ppm-step-icon" aria-hidden="true">
                  {isCompleted ? '✓' : step.icon}
                </span>
                <span className="ppm-step-label">{step.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="ppm-content">
          {/* Processing view (spec 022): dedicated per-wallet-interaction progress,
              shown between Review and Complete. */}
          {showProcessing && (
            <div className="ppm-panel" role="tabpanel">
              <section className="ppm-section">
                <h3 className="ppm-section-title">
                  <span aria-hidden="true">⏳</span> Completing your purchase
                </h3>
                <PurchaseProgressView
                  steps={flow.steps}
                  activeIndex={flow.activeIndex}
                  activeStep={flow.activeStep}
                  status={flow.status}
                  completedCount={flow.completedCount}
                  total={flow.total}
                  progressFraction={flow.progressFraction}
                  canContinueAnyway={flow.canContinueAnyway}
                  onRetry={flow.retry}
                  onContinueAnyway={flow.continueAnyway}
                />
              </section>
            </div>
          )}

          {/* Step 1: Tier */}
          {!showProcessing && currentStep === 0 && (
            <div className="ppm-panel" role="tabpanel">
              <section className="ppm-section">
                <div className="ppm-section-header">
                  <h3 className="ppm-section-title">
                    <span aria-hidden="true">{ROLE_COPY.icon}</span> {ROLE_COPY.tagline}
                  </h3>
                  <ul className="ppm-role-features">
                    {ROLE_COPY.features.map((f, i) => (
                      <li key={i}><span className="ppm-feature-check" aria-hidden="true">✓</span>{f}</li>
                    ))}
                  </ul>
                </div>

                {isLoadingTier && (
                  <div className="ppm-loading-tiers">
                    <div className="ppm-spinner" aria-hidden="true"></div>
                    <p>Checking your current membership tier...</p>
                  </div>
                )}

                {/* FR-004/FR-005: unknown is not "none". Say the read failed, offer a retry, and
                    refuse the purchase — buying "from None" on a blipped read could charge a
                    member for a tier they already hold. */}
                {!isLoadingTier && !tierReadable && (
                  <div className="ppm-info-card ppm-tier-unknown" role="status">
                    <span className="ppm-info-icon" aria-hidden="true">⚠️</span>
                    <div>
                      <strong>Your current membership could not be read.</strong>
                      <p>
                        We could not reach {networkName(membershipChainId())}, where memberships
                        are held, so we cannot tell what you already own. This is a connection
                        problem, not a statement that you have no membership.
                      </p>
                      <button type="button" className="ppm-btn-secondary" onClick={() => setTierRetry((n) => n + 1)}>
                        Retry
                      </button>
                    </div>
                  </div>
                )}

                {/* Expired renewal: the active tier reads 0, so no "Current Membership" card can
                    render — without this the member saw four unexplained tier cards under a
                    "Renew" title. Say what happened and what picking a tier does. */}
                {isExpiredRenewal && (
                  <div className="ppm-info-card ppm-renewal-info" role="status">
                    <span className="ppm-info-icon" aria-hidden="true">ℹ️</span>
                    <div>
                      <strong>Your membership has expired</strong>
                      <p>
                        Choose any tier to renew — your previous tier or a different one. The new
                        30 days start when the purchase confirms.
                      </p>
                    </div>
                  </div>
                )}

                {!isLoadingTier && userCurrentTier > 0 && (
                  <div className="ppm-info-card ppm-current-tier-info">
                    <span className="ppm-info-icon" aria-hidden="true">ℹ️</span>
                    <div>
                      <strong>Current Membership</strong>
                      <p>
                        You currently have{' '}
                        <span
                          className="ppm-tier-badge"
                          style={{ backgroundColor: Object.values(MEMBERSHIP_TIERS)[userCurrentTier - 1]?.color }}
                        >
                          {Object.values(MEMBERSHIP_TIERS)[userCurrentTier - 1]?.name}
                        </span>
                        {allowsSameTier ? '. You can extend at the same tier or upgrade.' : '. You can only upgrade to a higher tier.'}
                      </p>
                    </div>
                  </div>
                )}

                {!isLoadingTier && userCurrentTier >= 4 && !allowsSameTier && (
                  <div className="ppm-warning-card">
                    <span className="ppm-warning-icon" aria-hidden="true">🎉</span>
                    <div className="ppm-warning-content">
                      <strong>Maximum Tier Reached</strong>
                      <p>You're already on Platinum — the highest tier. There's nothing to upgrade to.</p>
                    </div>
                  </div>
                )}

                {/* Every tier the contract has switched off — an empty grid is a real state
                    (nothing is on sale), and it must say so rather than render blank. */}
                {!isLoadingTier && tierReadable && availableTiers.length === 0 && userCurrentTier < 4 && (
                  <div className="ppm-warning-card" role="status">
                    <span className="ppm-warning-icon" aria-hidden="true">🔒</span>
                    <div className="ppm-warning-content">
                      <strong>No memberships are on sale right now</strong>
                      <p>
                        Every tier is currently switched off in the membership contract. Nothing was
                        charged. Please check back later.
                      </p>
                    </div>
                  </div>
                )}

                {!isLoadingTier && availableTiers.length > 0 && (
                  <div className="ppm-tier-grid">
                    {availableTiers.map(([tierKey, tier]) => {
                      const tierPrice = getPrice(ROLE_KEY, tierKey)
                      const tierChainLimits = getLimits(ROLE_KEY, tierKey)
                      const isSelected = selectedTier === tierKey
                      return (
                        <label
                          key={tierKey}
                          className={`ppm-tier-card ${isSelected ? 'selected' : ''}`}
                          style={{ '--tier-color': tier.color }}
                        >
                          <input
                            type="radio"
                            name="tier"
                            value={tierKey}
                            checked={isSelected}
                            onChange={() => setSelectedTier(tierKey)}
                            disabled={isBusy}
                            className="ppm-tier-radio"
                          />
                          <div className="ppm-tier-content">
                            <div className="ppm-tier-header">
                              <span className="ppm-tier-badge" style={{ backgroundColor: tier.color }}>
                                {tier.name}
                              </span>
                              <span className="ppm-tier-price">${tierPrice} USDC</span>
                            </div>
                            <TierLimits tierName={tierKey} chainLimits={tierChainLimits} />
                            <p className="ppm-tier-duration">30 days</p>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}

                {errors.tier && <div className="ppm-error">{errors.tier}</div>}
              </section>

              {/* Voucher rail (spec 026): same membership, bought/redeemed as a
                  transferable token. Shown only where vouchers are deployed. */}
              {voucherAvailable && (
                <section className="ppm-section ppm-voucher-alt">
                  <h3 className="ppm-section-title">
                    <span aria-hidden="true">🎟️</span> Have a voucher — or want to gift access?
                  </h3>
                  <p className="ppm-voucher-alt-text">
                    A voucher is a transferable token that redeems into the same membership. Redeem one you were
                    given, or buy a voucher to gift or resell.
                  </p>
                  <div className="ppm-voucher-alt-actions">
                    <button
                      type="button"
                      className="ppm-btn-secondary"
                      onClick={() => goToVouchers('#vch-redeem-h')}
                      disabled={isBusy}
                    >
                      Redeem a voucher
                    </button>
                    <button
                      type="button"
                      className="ppm-btn-secondary"
                      onClick={() => goToVouchers('#vch-buy-h')}
                      disabled={isBusy}
                    >
                      Buy a giftable voucher
                    </button>
                  </div>
                </section>
              )}
            </div>
          )}

          {/* Step 2: Review */}
          {!showProcessing && currentStep === 1 && (
            <div className="ppm-panel" role="tabpanel">
              <section className="ppm-section">
                <h3 className="ppm-section-title">
                  <span aria-hidden="true">📋</span> Review Your Purchase
                </h3>

                {/* FR-021 moment 3 of 3 — before the member commits money to an account that one
                    lost device would take with it. It warns, it never gates: the purchase button
                    below is untouched, and a member who reads this and continues, continues. */}
                <DeviceLossWarning moment="membership-purchase" onAddController={goToControllers} />

                <div className="ppm-review-card">
                  <h4>Order Summary</h4>
                  {/* FR-001/FR-010: the recipient IS the acting account on an acting rail — the
                      membership is credited to whoever signs, and spec 098 makes that the account
                      named here rather than the connected wallet. */}
                  <div className="ppm-review-recipient">
                    <span className="ppm-review-label">Recipient</span>
                    <span className="ppm-review-value">
                      <span className="ppm-recipient-badge">
                        {isActingAccount ? actingAccountName : 'You'}
                      </span>
                      <code>{membershipAddress?.slice(0, 6)}...{membershipAddress?.slice(-4)}</code>
                    </span>
                  </div>
                  <div className="ppm-review-tier">
                    <span className="ppm-review-label">Membership Tier</span>
                    <span className="ppm-tier-badge" style={{ backgroundColor: selectedTierInfo?.color }}>
                      {selectedTierInfo?.name}
                    </span>
                  </div>
                  <div className="ppm-review-roles">
                    <span className="ppm-review-label">Role</span>
                    <div className="ppm-review-roles-list">
                      <div className="ppm-review-role-item">
                        <div className="ppm-review-role-info">
                          <span className="ppm-review-role-icon" aria-hidden="true">{ROLE_COPY.icon}</span>
                          <div>
                            <span className="ppm-review-role-name">Wager Participant</span>
                            <span className="ppm-review-role-duration">30 days</span>
                          </div>
                        </div>
                        <span className="ppm-review-role-price">${selectedPrice} USDC</span>
                      </div>
                    </div>
                  </div>
                  <div className="ppm-review-pricing">
                    <div className="ppm-review-pricing-row ppm-total">
                      <span>Total</span>
                      <span>${selectedPrice.toFixed(2)} USDC</span>
                    </div>
                    {usingFallbackPrices && (
                      <p className="ppm-price-estimate" role="status">
                        ⚠ Estimated price — live pricing couldn’t be loaded from the
                        membership contract, so this is a fallback estimate. Confirm
                        the exact amount in your wallet before approving.
                      </p>
                    )}
                  </div>

                  <TierLimits tierName={selectedTier} chainLimits={chainLimits} />
                </div>

                <div className="ppm-warning-card">
                  <span className="ppm-warning-icon" aria-hidden="true">⚠️</span>
                  <div className="ppm-warning-content">
                    <strong>Operator powers — please acknowledge</strong>
                    <ul>
                      <li>
                        The protocol can be <strong>paused</strong> by a Guardian-Role holder in
                        response to security incidents. Pausing temporarily blocks all wager
                        creation, acceptance, and settlement.
                      </li>
                      <li>
                        An <strong>Account Moderator</strong> can freeze your account for cause
                        (fraud, abuse, court order, etc.). A frozen account cannot create or accept
                        wagers, or claim payouts or refunds, until unfrozen. See{' '}
                        <a href={ACCOUNT_MODERATION_PATH} target="_blank" rel="noopener noreferrer">
                          Account Moderation policy
                        </a>.
                      </li>
                      <li>
                        This is a <strong>non-refundable</strong> blockchain transaction. Once
                        confirmed, it cannot be reversed.
                      </li>
                    </ul>
                    {/* Spec 007 (US5): discrete, un-pre-ticked eligibility attestations.
                        allTicked drives `acknowledged`, which gates validation + the
                        purchase button below; the accepted Terms version is recorded
                        on-chain via purchaseTierWithTerms in handlePurchase. */}
                    <MembershipAttestation onChange={setAcknowledged} />
                    {errors.ack && <div className="ppm-error">{errors.ack}</div>}
                  </div>
                </div>

                {/* Spec 071 FR-007 + spec 098 FR-010: ONE pre-signature disclosure — which
                    account is credited, which account pays, which network it settles on, and (on
                    the vault rail) that the outcome is a proposal, not an active membership. It is
                    unconditional: a member should not have to infer any of it from the absence of
                    a warning. */}
                <div className="ppm-settlement-note" role="note">
                  <p>
                    This membership is credited to <strong>{creditedName}</strong>
                    {isActingAccount && membershipAddress
                      ? <> (<code>{membershipAddress.slice(0, 6)}...{membershipAddress.slice(-4)}</code>)</>
                      : null}
                    , and the price is paid from {payerDescription}.
                  </p>
                  <p>
                    Memberships are held on <strong>{purchaseNetworkName}</strong>, so this purchase
                    settles there and is recognised from every network afterwards.
                  </p>
                  {purchaseRail.rail === 'vault' && (
                    <p>
                      Confirming creates a <strong>proposal</strong> in the vault&rsquo;s queue. The
                      membership activates when the vault&rsquo;s threshold approves and executes
                      it — not when you confirm here.
                    </p>
                  )}
                  {/* Issue #1368 — WHICH SHAPE, and why. A vault whose policy guard denies
                      delegatecall cannot execute a batched proposal at all, so the approval and
                      the purchase are proposed separately. The member reads that here, before
                      signing, rather than discovering it when the batch reverts. */}
                  {purchaseRail.rail === 'vault' && vaultShape?.shape === 'split' && (
                    <p>
                      This will be <strong>two separate proposals</strong> — the USDC approval, then
                      the purchase — because{' '}
                      {vaultShape.batchSupport === 'batch-denied'
                        ? "this vault's policy does not allow batched transactions"
                        : "we could not confirm this vault's policy allows a batched transaction"}
                      . They are queued <strong>in order</strong>, so the purchase cannot execute
                      before the approval. The approval is for the <strong>exact</strong> price
                      ({selectedPrice} USDC) and nothing more; if the purchase is never executed,
                      that approval stays in place until the vault cancels or revokes it.
                    </p>
                  )}
                  {purchaseRail.rail === 'vault' && vaultShape?.shape && vaultShape.shape !== 'split' && (
                    <p>
                      This will be <strong>one proposal</strong>
                      {vaultShape.shape === 'batch'
                        ? ' carrying the USDC approval and the purchase together.'
                        : " — the vault's USDC approval already covers this price, so only the purchase is proposed."}
                    </p>
                  )}
                </div>

                {/* FR-003/US4: refusal names the account AND the specific reason, so the member
                    knows whether switching accounts, switching chains, or nothing would help. */}
                {!purchaseRail.eligible && (
                  <div className="ppm-network-warning">
                    <span aria-hidden="true">⚠️</span>
                    <div>
                      <strong>This account cannot hold a membership bought here</strong>
                      <p>{purchaseRail.reason}</p>
                    </div>
                  </div>
                )}

                {isConnected && !onPurchaseChain && (
                  <div className="ppm-network-warning">
                    <span aria-hidden="true">⚠️</span>
                    <div>
                      <strong>Switch to {purchaseNetworkName}</strong>
                      <p>
                        Your wallet is on {networkName(chainId)}. Membership purchases settle on{' '}
                        {purchaseNetworkName} — buying anywhere else would create a membership the
                        app could never read back.
                      </p>
                      {/* A decline now genuinely rejects (spec 088) — swallow it: the wallet showed its own
                          prompt and the button stays for retry. */}
                      <button type="button" onClick={() => { Promise.resolve(switchNetwork(purchaseChainId)).catch(() => {}) }}>
                        Switch to {purchaseNetworkName}
                      </button>
                    </div>
                  </div>
                )}

                {!isConnected && (
                  <div className="ppm-connect-warning">
                    <span aria-hidden="true">🔗</span>
                    <div>
                      <strong>Wallet Not Connected</strong>
                      <p>Please connect your wallet to complete the purchase.</p>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* Step 3: Complete */}
          {currentStep === 2 && (
            <div className="ppm-panel" role="tabpanel">
              <section className="ppm-section ppm-complete-section">
                <div className="ppm-success-icon" aria-hidden="true">
                  {purchaseResult?.proposed ? '🗳️' : purchaseResult?.success ? '🎉' : '⚠️'}
                </div>
                <h3 className="ppm-complete-title">
                  {purchaseResult?.proposed
                    ? 'Proposed to your vault'
                    : purchaseResult?.success ? 'Purchase Complete!' : 'Purchase Failed'}
                </h3>
                {/* FR-005/FR-014: `proposed` is NOT `paid`. Nothing has been charged and no
                    membership is active until the vault's threshold executes the proposal, which
                    lives in the vault queue whether or not this modal stays open. */}
                <p className="ppm-complete-desc">
                  {purchaseResult?.proposed
                    ? <>The <strong style={{ color: selectedTierInfo?.color }}>{selectedTierInfo?.name}</strong> membership for {actingAccountName} is waiting in the vault&rsquo;s queue. Nothing has been charged yet — it activates when the vault&rsquo;s threshold approves and executes the proposal. Closing this window changes nothing.</>
                    : purchaseResult?.success
                      ? <>Your <strong style={{ color: selectedTierInfo?.color }}>{selectedTierInfo?.name}</strong> Wager Participant membership is active for 30 days.</>
                      : purchaseResult?.error}
                </p>
                {purchaseResult?.txHash && (
                  <a
                    href={getTransactionUrl(chainId || 80002, purchaseResult.txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ppm-tx-link"
                  >
                    View transaction
                  </a>
                )}
                {purchaseResult?.success && (
                  <div className="ppm-key-reg-status">
                    {keyRegStatus === 'registering' && (
                      <div className="ppm-info-card">
                        <span className="ppm-spinner" aria-hidden="true" />
                        <span>Registering your encryption key...</span>
                      </div>
                    )}
                    {keyRegStatus === 'success' && (
                      <div className="ppm-info-card ppm-key-reg-success">
                        <span aria-hidden="true">&#x1F512;</span>
                        <span>Encryption key registered &mdash; you can send and receive private wagers.</span>
                      </div>
                    )}
                    {keyRegStatus === 'skipped' && (
                      <div className="ppm-info-card ppm-key-reg-success">
                        <span aria-hidden="true">&#x1F512;</span>
                        <span>Encryption key already registered.</span>
                      </div>
                    )}
                    {keyRegStatus === 'failed' && (
                      <div className="ppm-info-card ppm-key-reg-warn">
                        <span aria-hidden="true">&#x26A0;&#xFE0F;</span>
                        <span>
                          Key registration was not completed{keyRegError ? `: ${keyRegError}` : ''}.
                          You can register later from <strong>Security</strong> settings.
                        </span>
                      </div>
                    )}
                  </div>
                )}
                <div className="ppm-tier-summary">
                  <h4>Your {selectedTierInfo?.name} limits</h4>
                  <TierLimits tierName={selectedTier} chainLimits={chainLimits} />
                </div>
              </section>
            </div>
          )}
        </div>

        <footer className="ppm-footer">
          <div className="ppm-footer-left">
            {!showProcessing && currentStep > 0 && currentStep < 2 && (
              <button type="button" className="ppm-btn-secondary" onClick={handleBack} disabled={isBusy}>
                Back
              </button>
            )}
          </div>
          <div className="ppm-footer-right">
            {/* During the Processing view, recovery actions live in the progress
                view itself (Retry / Continue anyway), so the form footer is hidden. */}
            {!showProcessing && currentStep < 2 && (
              <button type="button" className="ppm-btn-secondary" onClick={handleClose} disabled={isBusy}>
                Cancel
              </button>
            )}
            {!showProcessing && currentStep === 0 && (
              <button
                type="button"
                className="ppm-btn-primary"
                onClick={handleNext}
                disabled={isBusy || availableTiers.length === 0}
              >
                Continue
              </button>
            )}
            {/* FR-005/FR-006: no purchase while the wallet is off the reference chain, and none
                while the current tier is unknown — either would charge for the wrong thing. */}
            {!showProcessing && currentStep === 1 && (
              <button
                type="button"
                className="ppm-btn-primary ppm-btn-purchase"
                onClick={handlePurchase}
                disabled={isBusy || !isConnected || !onPurchaseChain || !tierReadable || !acknowledged || !purchaseRail.eligible}
              >
                Confirm Purchase (${selectedPrice.toFixed(2)} USDC)
              </button>
            )}
            {currentStep === 2 && (
              <button type="button" className="ppm-btn-primary" onClick={handleClose}>
                Done
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

export default PremiumPurchaseModal
