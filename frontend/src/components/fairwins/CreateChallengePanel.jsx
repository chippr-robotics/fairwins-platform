import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { isAddress } from 'viem'
import { useSwitchChain } from 'wagmi'
import { useOpenChallengeCreate, OPEN_RESOLUTION_TYPES } from '../../hooks/useOpenChallengeCreate'
import { useWeb3 } from '../../hooks/useWeb3'
import { useChainTokens } from '../../hooks/useChainTokens'
import { useSelectableAssets } from '../../hooks/useSelectableAssets'
import { ResolutionType, isOracleModelExposed } from '../../constants/wagerDefaults'
import { ASSET_ACTIVITIES } from '../../lib/assets/assetActivity'
import { getNetwork } from '../../config/networks'
import AddressInput from '../ui/AddressInput'
import AddressBookButton from '../ui/AddressBookButton'
import QRScanner from '../ui/QRScanner'
import AmountKeypad from '../ui/AmountKeypad'
import UniversalAssetSelect from '../ui/UniversalAssetSelect'
import PolymarketBrowser from './PolymarketBrowser'
import ClaimCodeResultPanel from './ClaimCodeResultPanel'
import { toDatetimeLocal, fromDatetimeLocal, HOUR_MS } from './wagerTimeline'
import { deriveOracleChallengeTimeline } from '../../lib/openChallenge/oracleTimeline'
import PillSelect from '../ui/PillSelect'
import InfoTip from '../ui/InfoTip'
import { EitherSideIcon, ThirdPartyIcon, OracleIcon } from './resolutionIcons'
import './FriendMarketsModal.css'
import './OpenChallengeModal.css'

const BackIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 18l-6-6 6-6" />
  </svg>
)

/**
 * CreateChallengePanel (spec 053) — the reusable open-challenge create panel, extracted from the
 * Open Challenge modal so it can render inline on the home screen (`embedded`) or inside the modal
 * chrome (`OpenChallengeModal`). Create a code-gated wager with no named opponent (Silver+).
 * Oracle settlement (spec 041, Polymarket) is a third, network-gated resolution path (spec 052)
 * that swaps to a market-search step when chosen. Taking a challenge lives in the unified lookup.
 *
 * Props:
 *   - embedded: render inline (home) vs. inside the modal shell (styling hook only).
 *   - onClose: dismiss (modal mode).
 *   - onDone: called after a successful create (defaults to onClose).
 *   - initialResolutionType: preselect a resolution path (e.g. oracle from the ticker).
 *   - initialMarket: a Polymarket market to pre-select on the oracle path (e.g. a ticker click),
 *     skipping the market-search step.
 */
function CreateChallengePanel({
  embedded = false,
  onClose,
  onDone,
  onOracleModeChange,
  // Connection is injected by the host so the panel stays presentational (and testable
  // without a WalletProvider). Defaults to connected: hosts that only mount it post-connect
  // (e.g. the modal opened from the dashboard) need no wiring. The home screen passes the
  // live state + a connect handler so tapping the primary button opens the connect panel as
  // part of the create flow (spec 053 feedback), then continues to create once connected.
  isConnected = true,
  onConnect,
  initialResolutionType,
  initialMarket = null,
}) {
  const { createOpenChallenge, busy } = useOpenChallengeCreate()
  const { capabilities, chainId: connectedChainId } = useChainTokens()
  const { switchChainAsync, isPending: switching } = useSwitchChain()
  // Stake asset (spec 064 US3): the wager was USDC-locked; it now escrows ANY
  // ERC-20 the account holds. The head-to-head escrow pulls the stake via
  // `transferFrom`, so the selector is scoped to ERC-20 kinds only — the native
  // coin and non-EVM Bitcoin are excluded by the `wager` capability profile.
  const { options: assetOptions, defaultKey: assetDefaultKey } = useSelectableAssets({ activity: ASSET_ACTIVITIES.WAGER })
  const [selectedAssetKey, setSelectedAssetKey] = useState(null)
  // Oracle settlement is only offered where the Polymarket CTF is reachable and
  // the model is exposed; otherwise the pill shows locked (spec 052 consolidation).
  const polymarketAvailable =
    Boolean(capabilities?.polymarketSidebets) && isOracleModelExposed(ResolutionType.Polymarket)

  const [description, setDescription] = useState('')
  // Payments-style entry (spec 052): start from the zero state ($0) so the
  // number pad drives entry. Submission stays gated until a positive amount.
  const [stake, setStake] = useState('')
  const [resolutionType, setResolutionType] = useState(() => {
    const wantOracle = Number(initialResolutionType) === OPEN_RESOLUTION_TYPES.Polymarket
    if (initialResolutionType != null && (!wantOracle || polymarketAvailable)) return String(initialResolutionType)
    return String(OPEN_RESOLUTION_TYPES.Either)
  })
  const [arbitrator, setArbitrator] = useState('')
  const [arbitratorResolved, setArbitratorResolved] = useState('')
  // Oracle path (consolidated from the former Open Oracle Challenge modal).
  const [market, setMarket] = useState(null)
  const [side, setSide] = useState('') // '' | '0' | '1' — outcome index; 0 = YES side
  const [ineligible, setIneligible] = useState(null)
  // 'form' = the amount/details view; 'market' = the Polymarket search sub-view.
  const [step, setStep] = useState(() =>
    Number(initialResolutionType) === OPEN_RESOLUTION_TYPES.Polymarket && polymarketAvailable ? 'market' : 'form'
  )
  // Deadlines (feature 024): fixed sensible defaults for the self/arbitrator paths — 48h to take,
  // then +7d to settle. No longer edited in the create view (spec 053: the slider timeline was
  // dropped to stop the sheet scrolling). Converted to unix seconds on submit.
  const [acceptBy] = useState(() => toDatetimeLocal(Date.now() + 48 * HOUR_MS))
  const [resolveBy] = useState(() => toDatetimeLocal(Date.now() + (48 + 24 * 7) * HOUR_MS))
  const [nowMs] = useState(() => Date.now())
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  // Set when the user taps the primary button while disconnected: we open the connect panel,
  // then auto-continue the create once the wallet connects (see the effect below).
  const [pendingSubmit, setPendingSubmit] = useState(false)

  const isThirdParty = Number(resolutionType) === OPEN_RESOLUTION_TYPES.ThirdParty
  const isOracle = Number(resolutionType) === OPEN_RESOLUTION_TYPES.Polymarket

  // Selection with fallback to the activity default (connected stablecoin ⇒ USDC,
  // so the first-render default is unchanged). The member's pick always wins (FR-013).
  const activeAssetKey = selectedAssetKey && assetOptions.some((o) => o.key === selectedAssetKey)
    ? selectedAssetKey
    : assetDefaultKey
  const stakeAsset = assetOptions.find((o) => o.key === activeAssetKey) || null
  const stakeSymbol = stakeAsset?.symbol || 'USDC'
  // A stake asset on another network is create-gated behind a switch (the wager is
  // created + escrowed on the connected chain) — only once the wallet is connected.
  // We only claim a mismatch when the connected chain is actually known (honest state:
  // never gate on an unknown/NaN chain).
  const assetChainMismatch =
    Boolean(stakeAsset) && Number.isFinite(Number(connectedChainId)) &&
    Number(stakeAsset.chainId) !== Number(connectedChainId)
  const chainGateActive = isConnected && assetChainMismatch
  const switchTargetName = assetChainMismatch
    ? getNetwork(stakeAsset.chainId)?.name || `network ${stakeAsset.chainId}`
    : null

  const handleSelectAsset = useCallback((option) => {
    setSelectedAssetKey(option.key)
    setError(null)
  }, [])

  const handleSwitchAssetNetwork = useCallback(async () => {
    if (!stakeAsset) return
    setError(null)
    try {
      await switchChainAsync({ chainId: Number(stakeAsset.chainId) })
    } catch (err) {
      setError(err?.shortMessage || err?.message || 'Could not switch network.')
    }
  }, [stakeAsset, switchChainAsync])

  // Let an embedding host react to the oracle path (the home screen hides its
  // secondary actions while an oracle challenge is being composed — the market +
  // side picker need the room and the goal is a no-scroll view).
  useEffect(() => {
    onOracleModeChange?.(isOracle)
  }, [isOracle, onOracleModeChange])
  const arbitratorAddr = arbitratorResolved || arbitrator
  const arbitratorValid = !isThirdParty || isAddress(arbitratorAddr)
  const acceptMs = fromDatetimeLocal(acceptBy)
  const resolveMs = fromDatetimeLocal(resolveBy)
  const deadlinesValid =
    Number.isFinite(acceptMs) && Number.isFinite(resolveMs) &&
    acceptMs > Date.now() && resolveMs > acceptMs

  // Oracle-derived timeline + auto-composed description (the event defines both).
  const oracleTimeline = useMemo(
    () => (market ? deriveOracleChallengeTimeline(market.endDate, nowMs) : null),
    [market, nowMs]
  )
  const sideName = (idx) => market?.outcomes?.[Number(idx)]?.name || (String(idx) === '0' ? 'YES' : 'NO')
  const composedDescription = market && side !== ''
    ? `${market.question} — creator takes ${sideName(side)} · settled automatically by Polymarket`
    : ''

  const canCreate = Number(stake) > 0 && !busy && Boolean(stakeAsset) && !chainGateActive && (
    isOracle
      ? Boolean(market && oracleTimeline?.eligible && side !== '')
      : (description.trim().length > 0 && arbitratorValid && deadlinesValid)
  )

  // The accept/resolve windows use sensible defaults (48h to take · +7d to settle) and are no
  // longer editable in the create view (spec 053 feedback: drop the slider timeline to stop the
  // sheet scrolling). The default state above still flows to the submit call as valid deadlines.

  const handleResolutionChange = (value) => {
    setResolutionType(value)
    // Choosing oracle settlement opens the market-search step (unless already picked).
    if (Number(value) === OPEN_RESOLUTION_TYPES.Polymarket && !market) setStep('market')
  }

  const handleSelectMarket = useCallback((m) => {
    setError(null)
    const t = deriveOracleChallengeTimeline(m?.endDate, Date.now())
    if (!t.eligible) {
      setIneligible({ question: m?.question || 'That market', reason: t.reason })
      return
    }
    setIneligible(null)
    setMarket(m)
    setSide('')
    setStep('form')
  }, [])

  const backFromSearch = useCallback(() => {
    setStep('form')
    // Backing out of the initial oracle pick (no market chosen) reverts to self-resolution.
    if (!market) setResolutionType(String(OPEN_RESOLUTION_TYPES.Either))
  }, [market])

  // Pre-select a market handed in from the ticker crawler (main #877): open the oracle path
  // with it already chosen, skipping the market-search step. Seed once, and only while the
  // picker is still empty, so re-picks and the Change affordance aren't clobbered.
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || !initialMarket || !polymarketAvailable) return
    seededRef.current = true
    setResolutionType(String(OPEN_RESOLUTION_TYPES.Polymarket))
    handleSelectMarket(initialMarket)
  }, [initialMarket, polymarketAvailable, handleSelectMarket])

  const handleCreate = useCallback(async (e) => {
    e?.preventDefault?.()
    setError(null)
    // Not signed in yet? Open the connect panel as part of this flow, then let the effect
    // below resume the create once the wallet connects. If the host gave us no connect
    // handler we fall through and let the create hook surface its own "connect" error.
    if (!isConnected && onConnect) {
      setPendingSubmit(true)
      try {
        await onConnect()
      } catch {
        setPendingSubmit(false)
      }
      return
    }
    // Normalize the pad string (e.g. "10." → "10", "10.50" → "10.5").
    const cleanStake = Number(stake) > 0 ? String(Number(stake)) : stake
    try {
      // The selected stake token (spec 064): the create hook denominates escrow +
      // payout in it (defaulting to USDC when the default asset is chosen). A held
      // ERC-20 the registry doesn't allowlist surfaces the friendly NotAllowedToken
      // error from the hook — never a silent failure.
      const stakeTokenAddress = stakeAsset?.address || undefined
      const payload = isOracle
        ? {
            description: composedDescription,
            stake: cleanStake,
            token: stakeTokenAddress,
            resolutionType: OPEN_RESOLUTION_TYPES.Polymarket,
            oracleConditionId: market.conditionId,
            creatorIsYes: side === '0',
            acceptDeadline: Math.floor(oracleTimeline.acceptDeadlineMs / 1000),
            resolveDeadline: Math.floor(oracleTimeline.resolveDeadlineMs / 1000),
            // Sealed market metadata so a code-holder can read the bet even when
            // live market data is unreachable (D4/FR-014).
            oracleMeta: {
              source: 'polymarket',
              conditionId: market.conditionId,
              question: market.question,
              outcomes: [sideName(0), sideName(1)],
              creatorSide: Number(side),
              endDate: market.endDate,
              slug: market.slug || null,
            },
          }
        : {
            description: description.trim(),
            stake: cleanStake,
            token: stakeTokenAddress,
            resolutionType: Number(resolutionType),
            arbitrator: isThirdParty ? arbitratorAddr : undefined,
            acceptDeadline: Number.isFinite(acceptMs) ? Math.floor(acceptMs / 1000) : undefined,
            resolveDeadline: Number.isFinite(resolveMs) ? Math.floor(resolveMs / 1000) : undefined,
          }
      const res = await createOpenChallenge(payload, (p) => setProgress(p))
      setResult(res)
    } catch (err) {
      setError(err.message)
    } finally {
      setProgress(null)
    }
  }, [isConnected, onConnect, isOracle, composedDescription, stake, stakeAsset, market, side, oracleTimeline, description, resolutionType, isThirdParty, arbitratorAddr, acceptMs, resolveMs, createOpenChallenge]) // eslint-disable-line react-hooks/exhaustive-deps

  // Resume a create that was waiting on the wallet: the moment the connection lands, continue.
  useEffect(() => {
    if (pendingSubmit && isConnected) {
      setPendingSubmit(false)
      handleCreate()
    }
  }, [pendingSubmit, isConnected, handleCreate])

  if (result) {
    return (
      <ClaimCodeResultPanel
        result={result}
        backupMeta={{ description: isOracle ? composedDescription : description.trim(), stake }}
        onDone={onDone || onClose}
      />
    )
  }

  // ── Market-search sub-view (stepped) ─────────────────────────────────────
  if (step === 'market') {
    return (
      <div className={`fm-form${embedded ? ' oc-create-embedded' : ''}`}>
        <button type="button" className="fm-link-btn oc-market-back" onClick={backFromSearch} disabled={busy}>
          <BackIcon /> Back
        </button>
        <div className="fm-form-group fm-form-full">
          <span className="fm-label-row">
            <label htmlFor="oc-market-picker">Pick a market <span className="fm-required">*</span></label>
            <InfoTip label="About: Linked Polymarket market">
              The challenge settles automatically from this market&apos;s public resolution — you just
              pick a side and share the code.
            </InfoTip>
          </span>
          {ineligible && (
            <div className="oc-notice oc-notice--warn ooc-ineligible" role="alert">
              <strong>{ineligible.question}</strong> can&apos;t back an open challenge: {ineligible.reason}
            </div>
          )}
          <div id="ooc-market-picker">
            <PolymarketBrowser
              variant="inline"
              showFilters
              limit={20}
              selectedConditionId={market?.conditionId}
              onSelectMarket={handleSelectMarket}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <form className={`fm-form fm-pay-form${embedded ? ' oc-create-embedded' : ''}`} onSubmit={handleCreate}>
      {/* Payments-style hero (spec 052): the stake amount is the centerpiece,
          entered with the on-screen number pad. The stake asset is chosen with the
          universal selector (spec 064) — any held ERC-20, not USDC-locked. */}
      <div className="fm-pay-hero">
        <AmountKeypad
          value={stake}
          onChange={setStake}
          prefix="$"
          token={stakeSymbol}
          tokenSlot={(
            <>
              <span className="sr-only">Stake asset</span>
              <UniversalAssetSelect
                label="Stake asset"
                options={assetOptions}
                value={activeAssetKey}
                onChange={handleSelectAsset}
                disabled={busy}
              />
            </>
          )}
          disabled={busy}
          ariaLabel="Stake amount, each side"
          id="oc-stake"
        />
      </div>

      {/* Resolution selector — minimal icons, compact and inline right under the number pad
          (spec 053 feedback). Short labels keep the three options on as few rows as possible. */}
      <div className="fm-form-group fm-form-full fm-pay-resolution">
        <PillSelect
          label={<>How is it resolved? <span className="fm-required">*</span></>}
          options={[
            { value: String(OPEN_RESOLUTION_TYPES.Either), label: 'Either side', icon: <EitherSideIcon /> },
            { value: String(OPEN_RESOLUTION_TYPES.ThirdParty), label: 'Arbitrator', icon: <ThirdPartyIcon /> },
            {
              value: String(OPEN_RESOLUTION_TYPES.Polymarket),
              label: 'Event',
              icon: <OracleIcon />,
              disabled: !polymarketAvailable,
              disabledReason: 'Requires a Polymarket-enabled network. Switch networks to settle from a market.',
            },
          ]}
          value={resolutionType}
          onChange={handleResolutionChange}
          disabled={busy}
          hideLabel
          bordered
        />
      </div>

      {isOracle ? (
        // Oracle path: the picked market + your side stand in for the free memo
        // (the description is auto-composed from them).
        <>
          {market ? (
            <div className="fm-form-group fm-form-full">
              <div className="fm-polymarket-selected">
                <div className="fm-polymarket-selected-body">
                  <strong>{market.question}</strong>
                  <div className="fm-polymarket-meta">
                    {market.endDate && <span>Ends {formatDate(market.endDate)}</span>}
                    {market.outcomes?.length > 0 && (
                      <span>
                        {market.outcomes
                          .map((o) => `${o.name}${o.price != null ? ` ${Math.round(o.price * 100)}¢` : ''}`)
                          .join(' · ')}
                      </span>
                    )}
                  </div>
                </div>
                <button type="button" className="fm-link-btn" onClick={() => setStep('market')} disabled={busy}>
                  Change
                </button>
              </div>
            </div>
          ) : (
            <div className="fm-form-group fm-form-full">
              <button type="button" className="fm-btn-secondary" onClick={() => setStep('market')} disabled={busy}>
                Choose a market
              </button>
            </div>
          )}

          {market && (
            <div className="fm-form-group fm-form-full">
              <span className="fm-label-row">
                <label>Your side of the bet <span className="fm-required">*</span></label>
                <InfoTip label="About: Your side of the bet">
                  Pick the outcome you&apos;re backing. Whoever takes your code gets the other side.
                </InfoTip>
              </span>
              <div className="fm-side-picker">
                {['0', '1'].map((idx) => {
                  const name = sideName(idx)
                  const active = side === idx
                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`fm-side-btn ${active ? 'active' : ''}`}
                      onClick={() => setSide(idx)}
                      disabled={busy}
                      aria-pressed={active}
                    >
                      <span className="fm-side-btn-label">I&apos;m taking {name}</span>
                    </button>
                  )
                })}
              </div>
              {side !== '' && (
                <span className="fm-hint">
                  Whoever takes your code will be taking <strong>{sideName(side === '0' ? 1 : 0)}</strong>.
                </span>
              )}
            </div>
          )}
        </>
      ) : (
        // Wager description demoted to a Venmo/Cash-App-style memo below the amount.
        // No label/InfoTip — the placeholder itself explains the intent (design feedback).
        <div className="fm-form-group fm-form-full fm-pay-memo">
          <label htmlFor="oc-desc" className="sr-only">What&apos;s the wager?</label>
          <input
            id="oc-desc" type="text" maxLength={200} className="fm-pay-memo-input" required
            placeholder="Add a note — e.g. I'm betting NO that it rains in Denver tomorrow"
            value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy}
          />
        </div>
      )}

      {/* Arbitrator entry only when the third-party path is chosen. */}
      {isThirdParty && (
        <ArbitratorField
          value={arbitrator}
          onChange={setArbitrator}
          onResolvedChange={setArbitratorResolved}
          disabled={busy}
        />
      )}

      {progress && <p className="fm-hint" role="status">{progress.message}</p>}
      {error && <div className="fm-error-banner" role="alert">{error}</div>}

      <div className="fm-success-actions">
        {chainGateActive ? (
          <button
            type="button"
            className="fm-btn-primary"
            onClick={handleSwitchAssetNetwork}
            disabled={switching || busy}
          >
            {switching ? 'Switching…' : `Switch to ${switchTargetName} to stake ${stakeSymbol}`}
          </button>
        ) : (
          <button type="submit" className="fm-btn-primary" disabled={!canCreate}>
            {busy ? 'Opening…' : 'Lock in!'}
          </button>
        )}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Arbitrator entry — ENS-aware address input with address-book + QR-scan helpers
// (feature 024 feedback). Isolated so the wallet-scoped hooks (chainId, address
// book) only mount for the third-party path.
// ---------------------------------------------------------------------------
function ArbitratorField({ value, onChange, onResolvedChange, disabled }) {
  const { chainId } = useWeb3()
  const [scannerOpen, setScannerOpen] = useState(false)

  const handleScan = useCallback((decodedText) => {
    const addr = extractAddress(decodedText)
    if (addr) {
      onChange(addr)
      onResolvedChange(addr)
    }
    setScannerOpen(false)
  }, [onChange, onResolvedChange])

  return (
    <div className="fm-form-group fm-form-full">
      <span className="fm-label-row">
        <label htmlFor="oc-arb">Arbitrator address <span className="fm-required">*</span></label>
        <InfoTip label="About: Arbitrator address">
          The arbitrator can read and resolve this challenge, and cannot also take it.
        </InfoTip>
      </span>
      <div className="fm-input-with-action">
        <div className="fm-address-input-wrap">
          <AddressInput
            id="oc-arb"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onResolvedChange={(addr) => onResolvedChange(addr || '')}
            placeholder="0x… or ENS name — the neutral resolver"
            disabled={disabled}
          />
        </div>
        <AddressBookButton
          chainId={chainId}
          disabled={disabled}
          onSelect={(entry) => { onChange(entry.address); onResolvedChange(entry.address) }}
        />
        <button
          type="button"
          className="fm-scan-btn"
          onClick={() => setScannerOpen(true)}
          disabled={disabled}
          title="Scan QR code"
          aria-label="Scan QR code"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm0 4h2v2h-2v-2z"/>
          </svg>
        </button>
      </div>
      <QRScanner isOpen={scannerOpen} onClose={() => setScannerOpen(false)} onScanSuccess={handleScan} />
    </div>
  )
}

// Recover codes moved to My Account → Security (spec 037, US3):
// see components/account/RecoveryCodesPanel.jsx.

/** Pull a 0x-address out of scanned QR text — a bare address or one embedded in a URL path/query. */
function extractAddress(decodedText) {
  if (!decodedText) return null
  const match = String(decodedText).match(/0x[a-fA-F0-9]{40}/)
  return match ? match[0] : null
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString([], { dateStyle: 'medium' })
  } catch {
    return String(iso)
  }
}

export default CreateChallengePanel
