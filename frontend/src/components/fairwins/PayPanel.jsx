import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUnits } from '../../lib/evm/units'
import { useSwitchChain } from 'wagmi'
import AmountKeypad from '../ui/AmountKeypad'
import AddressInput from '../ui/AddressInput'
import AddressBookButton from '../ui/AddressBookButton'
import QRScanner from '../ui/QRScanner'
import UniversalAssetSelect from '../ui/UniversalAssetSelect'
import BitcoinSendPanel from '../wallet/BitcoinSendPanel'
import GroupPayRecipients from '../wallet/GroupPayRecipients'
import { GroupPayBreakdown, GroupPayOutcomes } from '../wallet/GroupPaySummary'
import { useWallet } from '../../hooks'
import { useTransfer } from '../../hooks/useTransfer'
import { useSelectableAssets } from '../../hooks/useSelectableAssets'
import { useEffectiveAccount } from '../../hooks/useEffectiveAccount'
import { useBitcoinWallet } from '../../hooks/useBitcoinWallet'
import { useAddressScreening } from '../../hooks/useAddressScreening'
import AddressScreenNotice from '../ui/AddressScreenNotice'
import { useGroupPay } from '../../hooks/useGroupPay'
import { useNotification } from '../../hooks/useUI'
import { getNetwork } from '../../config/networks'
import { ASSET_ACTIVITIES } from '../../lib/assets/assetActivity'
import { getDefaultCurrencyKind } from '../../utils/homePreference'
import { parsePaymentRequest, NOTE_MAX_LENGTH } from '../../lib/payments/paymentRequest'
import { GROUP_RAIL, validateRecipients } from '../../lib/payments/groupPay'

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')

/** The form's own To/amount fields are recipient 1; GroupPayRecipients owns rows 2..N. */
const PRIMARY_ID = 'primary'

/** An honest one-liner for a finished group payment — every non-zero bucket is named. */
function groupNotice(summary) {
  const parts = []
  if (summary?.sent) parts.push(`${summary.sent} sent`)
  if (summary?.proposed) parts.push(`${summary.proposed} proposed to the vault`)
  if (summary?.pending) parts.push(`${summary.pending} still confirming`)
  if (summary?.failed) parts.push(`${summary.failed} failed`)
  if (summary?.skipped) parts.push(`${summary.skipped} skipped`)
  return `Group payment: ${parts.join(', ') || 'nothing was sent'}.`
}

/** Format base units for the keypad; trims trailing zeros ("12.50" → "12.5"). */
function formatUnitsForKeypad(units, decimals) {
  const s = formatUnits(units, decimals)
  const trimmed = s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
  return trimmed === '' ? '0' : trimmed
}

/**
 * PayPanel (spec 058 US1 + spec 064 US1) — the home surface's default mode: send
 * value to a recipient with the payments-style amount-hero + numpad layout.
 *
 * The currency control under the amount is the UNIVERSAL asset selector (spec 064):
 * a member can pay with ANY platform-supported asset the acting account holds across
 * every configured network — each shown with its nested asset logo (glyph + network
 * sub-badge) — not just the connected network's native coin and stablecoin. Non-EVM
 * Bitcoin is supported here and routes through the existing Bitcoin send panel; an
 * asset on another network is gated behind a "Switch to {network}" step. All routing
 * (screening, gasless, honest lifecycle, never-stranded fallbacks) is inherited from
 * the useTransfer engine via `send({ asset })`, never reimplemented.
 *
 * Contract: specs/064-universal-asset-selector/contracts/universal-asset-selector.md
 */
function PayPanel({ onSuccess }) {
  const { isConnected, chainId, openConnectModal } = useWallet()
  const { send, status, error: sendError, refreshBalances } = useTransfer()
  const { screenOne } = useAddressScreening()
  const { showNotification } = useNotification()
  const { switchChainAsync, isPending: switching } = useSwitchChain()
  const btc = useBitcoinWallet()

  // Assets + balances come from whichever account we're ACTING AS, else the personal
  // portfolio — consistent with the Transfer form (FR-014). Spec 088: resolved through the
  // shared effective-account seam, so EVERY acting kind (vault, recovered, hardware, derived)
  // is covered — the inline vault/legacy-only copy this replaces silently showed the CONNECTED
  // wallet's balances while acting as a hardware account.
  const { address: effectiveAddress, isActingAccount } = useEffectiveAccount()
  const actingAddress = isActingAccount ? effectiveAddress : null
  const { options, defaultKey, isGasless } = useSelectableAssets({ activity: ASSET_ACTIVITIES.PAY, actingAddress })

  const [selectedKey, setSelectedKey] = useState(null)
  const [amount, setAmount] = useState('')
  const [toRaw, setToRaw] = useState('')
  const [toResolved, setToResolved] = useState('')
  const [note, setNote] = useState('')
  const [scanOpen, setScanOpen] = useState(false)
  const [scanNotice, setScanNotice] = useState(null)
  // Advisory screening result, remembered WITH the address it was for.
  const [screeningResult, setScreeningResult] = useState(null) // { addr, status } | null
  const [formError, setFormError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  // A scanned request payable on another network pins that chain until the user
  // switches, even when we hold no matching asset to preselect (FR-007).
  const [pinnedChainId, setPinnedChainId] = useState(null)
  // Recipients 2..N, and the screening statuses / result for a group payment. Empty ⇒ this is
  // the ordinary single-recipient form and NOTHING below behaves differently.
  const [extraRecipients, setExtraRecipients] = useState([])
  const [groupScreening, setGroupScreening] = useState({})
  const [groupResult, setGroupResult] = useState(null)

  const connectedChainId = Number(chainId)

  // Preference-aware default (spec 058): the home currency preference still picks
  // the STARTING asset — 'native' preselects the connected native coin, otherwise
  // the activity default (connected stablecoin) — before generalizing to any held
  // asset (spec 064). The member's own pick always overrides once made (FR-013).
  const preferredDefaultKey = useMemo(() => {
    if (getDefaultCurrencyKind() === 'native') {
      const nativeOpt = options.find((o) => Number(o.chainId) === connectedChainId && o.kind === 'native')
      if (nativeOpt) return nativeOpt.key
    }
    return defaultKey
  }, [options, connectedChainId, defaultKey])

  // Selection with fallback: keep the member's pick while it's valid, else the
  // preference-aware activity default. (FR-013)
  const activeKey = selectedKey && options.some((o) => o.key === selectedKey) ? selectedKey : preferredDefaultKey
  const selectedAsset = options.find((o) => o.key === activeKey) || null

  const isBitcoin = selectedAsset?.kind === 'btc-native'
  const symbol = selectedAsset?.symbol || ''
  const bal = selectedAsset?.balance ?? null
  const gasless = selectedAsset ? isGasless(selectedAsset) : false

  // Group pay (release 1.14.0): dormant until the member adds a second recipient. It is handed
  // the selected asset because issue #1441's availability is a fact about the asset's own
  // NETWORK, not only about the acting identity — hence its position here, after the selection.
  const groupPay = useGroupPay({ asset: selectedAsset })
  const groupBusy = groupPay.status === 'screening' || groupPay.status === 'submitting'
  const busy = status === 'signing' || status === 'submitting' || status === 'pending' || groupBusy

  useEffect(() => { refreshBalances() }, [refreshBalances])

  // Wrong-chain: the selected EVM asset lives on a network the wallet isn't on, or
  // a scanned request pinned another chain. Bitcoin is non-EVM and never gated here.
  const assetChainId = selectedAsset && !isBitcoin ? Number(selectedAsset.chainId) : connectedChainId
  // Only claim a mismatch when the connected chain is actually known (honest state:
  // never gate on an unknown/NaN chain).
  const knownConnectedChain = Number.isFinite(connectedChainId)
  const chainMismatch =
    !isBitcoin && knownConnectedChain &&
    ((pinnedChainId != null && Number(pinnedChainId) !== connectedChainId) ||
      (Boolean(selectedAsset) && assetChainId !== connectedChainId))
  const switchTargetChainId = pinnedChainId != null && Number(pinnedChainId) !== connectedChainId
    ? Number(pinnedChainId)
    : chainMismatch
      ? assetChainId
      : null
  const switchTargetName = switchTargetChainId != null
    ? getNetwork(switchTargetChainId)?.name || `network ${switchTargetChainId}`
    : null

  // Advisory sanctions pre-check on the resolved recipient (on-chain guards enforce).
  useEffect(() => {
    let cancelled = false
    if (!toResolved) return undefined
    Promise.resolve(screenOne(toResolved, assetChainId))
      .then((s) => { if (!cancelled) setScreeningResult({ addr: toResolved, status: s }) })
      .catch(() => { if (!cancelled) setScreeningResult({ addr: toResolved, status: 'uncertain' }) })
    return () => { cancelled = true }
  }, [toResolved, screenOne, assetChainId])

  const screening = screeningResult && screeningResult.addr === toResolved ? screeningResult.status : null

  const amountValid = useMemo(() => {
    const n = Number(amount)
    return Number.isFinite(n) && n > 0
  }, [amount])

  const overBalance = useMemo(() => {
    if (bal == null || !amountValid) return false
    return Number(amount) > Number(bal)
  }, [bal, amount, amountValid])

  // ── Group pay ─────────────────────────────────────────────────────────────────────────────
  // The list is the form's own recipient followed by the extra rows, so the member's first entry
  // keeps its place and its number. `isGroup` is false until a second recipient exists, and while
  // it is false every branch below is the single-recipient one that shipped before.
  const isGroup = extraRecipients.length > 0
  const allRecipients = useMemo(
    () => [{ id: PRIMARY_ID, raw: toRaw, address: toResolved, amount }, ...extraRecipients],
    [toRaw, toResolved, amount, extraRecipients],
  )
  const groupAddressKey = allRecipients.map((r) => r.address).join(',')

  // Advisory screening for every recipient in the list (the engine re-screens, forced, at submit).
  useEffect(() => {
    if (!isGroup) return undefined
    let cancelled = false
    const addrs = [...new Set(groupAddressKey.split(',').filter(Boolean).map((a) => a.toLowerCase()))]
    Promise.all(addrs.map((a) =>
      Promise.resolve(screenOne(a, assetChainId)).then((s) => [a, s]).catch(() => [a, 'uncertain']),
    )).then((pairs) => {
      if (cancelled) return
      setGroupScreening((prev) => {
        const next = { ...prev }
        let changed = false
        for (const [a, s] of pairs) if (next[a] !== s) { next[a] = s; changed = true }
        return changed ? next : prev
      })
    })
    return () => { cancelled = true }
  }, [isGroup, groupAddressKey, screenOne, assetChainId])

  const groupValidation = useMemo(
    () => (isGroup
      ? validateRecipients(allRecipients, {
          decimals: selectedAsset?.decimals ?? 18,
          symbol,
          balance: bal,
          selfAddress: effectiveAddress,
          screening: groupScreening,
        })
      : null),
    [isGroup, allRecipients, selectedAsset, symbol, bal, effectiveAddress, groupScreening],
  )
  const groupRefused = isGroup && groupPay.rail === GROUP_RAIL.REFUSED
  const issuesFor = useCallback(
    (id) => groupValidation?.rows.find((r) => r.id === id)?.issues ?? [],
    [groupValidation],
  )

  const canPay =
    isConnected && Boolean(selectedAsset) && !chainMismatch && !busy && (
      isGroup
        ? !groupValidation.blocking && !groupRefused
        : Boolean(toResolved) && amountValid && !overBalance && screening !== 'restricted'
    )

  const applyAddress = useCallback((addr) => {
    setToRaw(addr)
    setToResolved(addr)
    setScanNotice(null)
  }, [])

  const resetDraft = useCallback(() => {
    setAmount(''); setToRaw(''); setToResolved(''); setNote('')
    setScreeningResult(null); setFormError(null); setScanNotice(null)
    setConfirming(false); setPinnedChainId(null)
    setExtraRecipients([]); setGroupScreening({}); setGroupResult(null)
  }, [])

  const handleSelectAsset = useCallback((option) => {
    setSelectedKey(option.key)
    setPinnedChainId(null)
    setConfirming(false)
    setFormError(null)
  }, [])

  /**
   * A scan is either a payment request (full prefill), a bare address
   * (recipient-only prefill), or unusable. A request denominated in a token that is
   * not its network's stablecoin prefills NOTHING — never a wrong-asset send. A
   * request on another network preselects the held asset when we have it, else pins
   * that chain and surfaces the switch (FR-007).
   */
  const handleScan = useCallback((decodedText) => {
    setScanOpen(false)
    const parsed = parsePaymentRequest(decodedText)
    if (!parsed) {
      setScanNotice("That code isn't a payment request or address, so nothing was filled in.")
      return
    }

    const targetChainId = parsed.chainId ?? connectedChainId
    const targetNetwork = getNetwork(targetChainId)

    let wantAddress = null // null ⇒ native
    let decimals = null
    if (parsed.tokenAddress) {
      const stableAddr = targetNetwork?.stablecoin?.address
      if (!stableAddr || parsed.tokenAddress.toLowerCase() !== stableAddr.toLowerCase()) {
        setScanNotice("This request asks for a token FairWins doesn't send on that network, so nothing was filled in.")
        return
      }
      wantAddress = stableAddr
      decimals = targetNetwork.stablecoin.decimals ?? 6
    } else if (parsed.amountUnits != null) {
      decimals = targetNetwork?.nativeCurrency?.decimals ?? 18
    }

    applyAddress(parsed.to)
    const match = options.find(
      (o) =>
        Number(o.chainId) === Number(targetChainId) &&
        (wantAddress ? o.address && o.address.toLowerCase() === wantAddress.toLowerCase() : o.kind === 'native'),
    )
    if (match) setSelectedKey(match.key)
    if (parsed.amountUnits != null && decimals != null) setAmount(formatUnitsForKeypad(parsed.amountUnits, decimals))
    if (parsed.note) setNote(parsed.note)
    setPinnedChainId(parsed.chainId != null && Number(parsed.chainId) !== connectedChainId ? Number(parsed.chainId) : null)
  }, [applyAddress, connectedChainId, options])

  const handleSwitch = useCallback(async () => {
    setFormError(null)
    if (switchTargetChainId == null) return
    try {
      await switchChainAsync({ chainId: Number(switchTargetChainId) })
      setPinnedChainId(null)
    } catch (err) {
      setFormError(err?.shortMessage || err?.message || 'Could not switch network.')
    }
  }, [switchChainAsync, switchTargetChainId])

  const handleSend = useCallback(async () => {
    setFormError(null)
    try {
      const res = await send({ asset: selectedAsset, to: toResolved, amount })
      if (res?.proposed) {
        showNotification(
          `Proposed sending ${amount} ${symbol} to ${short(toResolved)} from the vault — its signers must approve it.`,
          'info',
        )
      } else if (res?.pending) {
        showNotification(
          `Submitted ${amount} ${symbol} to ${short(toResolved)} — still confirming on-chain. It will show as complete in Activity once settled.`,
          'info',
        )
      } else {
        showNotification(`Sent ${amount} ${symbol} to ${short(toResolved)}${res.route === 'gasless' ? ' (gasless)' : ''}.`, 'success')
      }
      resetDraft()
      onSuccess?.(res)
    } catch (err) {
      setConfirming(false)
      setFormError(err?.shortMessage || err?.message || 'Transfer failed.')
    }
  }, [send, selectedAsset, toResolved, amount, symbol, showNotification, resetDraft, onSuccess])

  /**
   * Submit the whole list. The rail (one batch, one vault proposal, or N sequential sends) is the
   * engine's decision, and its per-recipient outcomes are what gets shown afterwards — a partial
   * result is reported as a partial result, never rounded up to "sent".
   */
  const handleGroupSend = useCallback(async () => {
    setFormError(null)
    try {
      const res = await groupPay.submitGroup({ asset: selectedAsset, recipients: allRecipients })
      setGroupResult(res)
      const clean = !res.summary?.failed && !res.summary?.skipped
      showNotification(groupNotice(res.summary), clean ? 'success' : 'info')
      onSuccess?.(res)
    } catch (err) {
      // Nothing was signed: stay on the confirm with the draft intact so the member can fix it.
      setFormError(err?.shortMessage || err?.message || 'The payment could not be submitted.')
    }
  }, [groupPay, selectedAsset, allRecipients, showNotification, onSuccess])

  const blockReason = isGroup
    ? (groupValidation.overBalance
        ? `That's more ${symbol} than you have.`
        : groupValidation.tooMany
          ? 'That is more recipients than one payment can carry.'
          : groupRefused ? groupPay.railReason : null)
    : !amountValid
      ? null
      : overBalance
        ? `That's more ${symbol} than you have.`
        : null

  const assetSelect = (
    <UniversalAssetSelect
      label="Currency"
      options={options}
      value={activeKey}
      onChange={handleSelectAsset}
      isGasless={isGasless}
      disabled={busy}
    />
  )

  // Bitcoin (spec 061) has its own amount/fee/send surface — swap the EVM body for
  // the Bitcoin send panel, keeping the asset selector so the member can switch back.
  if (isBitcoin) {
    return (
      <div className="fm-form fm-pay-form pay-panel">
        <div className="fm-pay-hero fm-pay-hero-asset">
          {assetSelect}
        </div>
        {!isConnected ? (
          <div className="fm-success-actions">
            <button type="button" className="fm-btn-primary" onClick={() => openConnectModal()}>
              Connect wallet
            </button>
          </div>
        ) : (
          <BitcoinSendPanel btc={btc} usdPerBtc={null} onSent={onSuccess} />
        )}
      </div>
    )
  }

  // A finished group payment reports itself per recipient before the draft is cleared.
  if (confirming && groupResult) {
    return (
      <div className="fm-form fm-pay-form pay-panel">
        <GroupPayOutcomes
          outcomes={groupResult.outcomes}
          summary={groupResult.summary}
          symbol={symbol}
          onDone={() => { groupPay.reset(); resetDraft() }}
        />
      </div>
    )
  }

  if (confirming && isGroup) {
    return (
      <div className="fm-form fm-pay-form pay-panel">
        <GroupPayBreakdown
          recipients={allRecipients}
          total={groupValidation.total}
          symbol={symbol}
          networkName={selectedAsset?.networkName}
          rail={groupPay.rail}
          batchSupport={groupPay.vaultBatch?.support ?? null}
          gasless={gasless}
          nativeSymbol={getNetwork(assetChainId)?.nativeCurrency?.symbol || ''}
        />
        {note && <div className="pay-confirm-row"><span className="k">Note</span><span className="v">{note}</span></div>}

        {(formError || sendError || groupPay.error) && (
          <div className="fm-error-banner" role="alert">{formError || sendError || groupPay.error}</div>
        )}

        <div className="pay-confirm-actions">
          <button type="button" className="fm-btn-secondary" onClick={() => setConfirming(false)} disabled={busy}>
            Back
          </button>
          <button type="button" className="fm-btn-primary" onClick={handleGroupSend} disabled={busy}>
            {busy ? 'Sending…' : 'Confirm'}
          </button>
        </div>
      </div>
    )
  }

  if (confirming) {
    return (
      <div className="fm-form fm-pay-form pay-panel" data-testid="pay-confirm">
        <div className="pay-confirm" aria-live="polite">
          <div className="pay-confirm-amount">{amount} {symbol}</div>
          <div className="pay-confirm-row"><span className="k">To</span><span className="v">{short(toResolved)}</span></div>
          <div className="pay-confirm-row"><span className="k">Network</span><span className="v">{selectedAsset?.networkName}</span></div>
          <div className="pay-confirm-row">
            <span className="k">Fee</span>
            <span className="v">{gasless ? 'Gasless — no network fee' : 'You pay the network fee'}</span>
          </div>
          {note && <div className="pay-confirm-row"><span className="k">Note</span><span className="v">{note}</span></div>}
        </div>

        {(formError || sendError) && (
          <div className="fm-error-banner" role="alert">{formError || sendError}</div>
        )}

        <div className="pay-confirm-actions">
          <button type="button" className="fm-btn-secondary" onClick={() => setConfirming(false)} disabled={busy}>
            Back
          </button>
          <button type="button" className="fm-btn-primary" onClick={handleSend} disabled={busy}>
            {busy ? (status === 'signing' ? 'Confirm in wallet…' : 'Sending…') : 'Confirm'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="fm-form fm-pay-form pay-panel">
      {/* Amount hero — the shared payments-style keypad; the universal asset selector
          sits directly under the amount (in place of the old native/stable pill) and
          shows every held asset with its nested logo. */}
      <div className="fm-pay-hero">
        <AmountKeypad
          value={amount}
          onChange={setAmount}
          prefix="$"
          token={symbol}
          tokenSlot={(
            <>
              <span className="sr-only">Currency</span>
              {assetSelect}
            </>
          )}
          disabled={busy}
          ariaLabel="Amount to pay"
          id="pay-amount"
        />
      </div>

      {/* Recipient — the standard address entry stack (typed/pasted + book + scan). */}
      <div className="fm-form-group fm-form-full">
        <span className="fm-label-row fm-label-row-spaced">
          <label className="fm-label" htmlFor="pay-to">To</label>
          {/* Recipient ONE of a group, not the only recipient — see the note in TransferForm. */}
          {isGroup && (
            <span
              className="fm-badge-multi"
              aria-label={`Multiple recipients: ${allRecipients.length}`}
            >
              Multi · {allRecipients.length}
            </span>
          )}
        </span>
        <div className="fm-input-with-action">
          <div className="fm-address-input-wrap">
            <AddressInput
              id="pay-to"
              value={toRaw}
              onChange={(e) => setToRaw(e.target.value)}
              onResolvedChange={(addr) => setToResolved(addr || '')}
              chainId={assetChainId}
              placeholder="0x…, %callsign, or ENS name"
              disabled={busy}
            />
          </div>
          <AddressBookButton disabled={busy} onSelect={(entry) => applyAddress(entry.address)} />
          <button
            type="button"
            className="fm-scan-btn"
            onClick={() => setScanOpen(true)}
            disabled={busy}
            title="Scan QR code"
            aria-label="Scan QR code"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm4 0h2v2h-2v-2zm-4 4h2v2h-2v-2zm2 2h2v2h-2v-2zm2-2h2v2h-2v-2zm0 4h2v2h-2v-2z" />
            </svg>
          </button>
        </div>
        <QRScanner isOpen={scanOpen} onClose={() => setScanOpen(false)} onScanSuccess={handleScan} />
        {scanNotice && <div className="fm-hint" role="status">{scanNotice}</div>}
        {/* Estate-wide advisory screen (issue #1458): every list on every cohort chain. */}
        <AddressScreenNotice address={toResolved} chainId={assetChainId} />
        {/* The per-chain `screening` read is a SEPARATE fact: it is the guard on the chain the value
            moves on, the read the contract will repeat, and it is what withholds the button — so
            its refusal is stated as its own alert, next to the button it disables. */}
        {screening === 'restricted' && (
          <div className="fm-error-banner" role="alert">
            This address is flagged by sanctions screening on this network. Pay is withheld: the on-chain guard would refuse it.
          </div>
        )}
        {isGroup && issuesFor(PRIMARY_ID).map((issue) => (
          <div
            key={issue.code}
            className={issue.blocking ? 'fm-error-banner' : 'fm-hint'}
            {...(issue.blocking ? { role: 'alert' } : {})}
          >
            {issue.message}
          </div>
        ))}

        {/* Rows 2..N. Withdrawn entirely while `available` is false (#1441); otherwise
            absent — and inert — until the member presses Add. */}
        <GroupPayRecipients
          recipients={extraRecipients}
          onChange={setExtraRecipients}
          issuesFor={issuesFor}
          chainId={assetChainId}
          symbol={symbol}
          disabled={busy}
          idPrefix="pay"
          available={Boolean(groupPay.available)}
        />
      </div>

      {/* Note — client-side only; a plain transfer carries no on-chain memo. */}
      <div className="fm-form-group fm-form-full fm-pay-memo">
        <label className="sr-only" htmlFor="pay-note">Note</label>
        <input
          id="pay-note"
          type="text"
          maxLength={NOTE_MAX_LENGTH}
          className="fm-pay-memo-input"
          placeholder="Add a note — e.g. lunch, rent, thanks!"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
      </div>

      {/* The selected asset's balance and its gasless marker now live in the
          currency selector (trigger + rows), so no separate balance/gasless line
          is shown above the Pay button. The fee/gasless disclosure still appears
          honestly on the confirm step. */}
      {blockReason && <div className="fm-error-banner" role="alert">{blockReason}</div>}
      {formError && <div className="fm-error-banner" role="alert">{formError}</div>}

      <div className="fm-success-actions">
        {!isConnected ? (
          <button type="button" className="fm-btn-primary" onClick={() => openConnectModal()}>
            Connect wallet
          </button>
        ) : chainMismatch ? (
          <button type="button" className="fm-btn-primary" onClick={handleSwitch} disabled={switching || busy}>
            {switching ? 'Switching…' : `Switch to ${switchTargetName} to pay`}
          </button>
        ) : (
          <button type="button" className="fm-btn-primary" onClick={() => setConfirming(true)} disabled={!canPay}>
            {isGroup ? `Pay ${allRecipients.length} recipients` : 'Pay'}
          </button>
        )}
      </div>
    </div>
  )
}

export default PayPanel
