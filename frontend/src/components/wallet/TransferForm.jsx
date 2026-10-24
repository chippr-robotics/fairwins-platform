import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSwitchChain } from 'wagmi'
import AddressInput from '../ui/AddressInput'
import AddressBookButton from '../ui/AddressBookButton'
import QRScanner from '../ui/QRScanner'
import SensitiveValue from '../common/SensitiveValue'
import TransferAssetSelect from './TransferAssetSelect'
import TransferFromSelect from './TransferFromSelect'
import GroupPayRecipients from './GroupPayRecipients'
import { GroupPayBreakdown, GroupPayOutcomes } from './GroupPaySummary'
import { useTransfer, TRANSFER_KIND } from '../../hooks/useTransfer'
import { useWallet } from '../../hooks/useWalletManagement'
import { useActiveAccount } from '../../hooks/useActiveAccount'
import { useCustodyVaults } from '../../hooks/useCustodyVaults'
import { useLegacyAccounts } from '../../hooks/useLegacyAccounts'
import { useHardwareAccounts } from '../../hooks/useHardwareAccounts'
import { useEffectiveAccount } from '../../hooks/useEffectiveAccount'
import { useAccountAssets } from '../../hooks/useAccountAssets'
import usePortfolio from '../../hooks/usePortfolio'
import { useAddressScreening } from '../../hooks/useAddressScreening'
import AddressScreenNotice from '../ui/AddressScreenNotice'
import { useGroupPay } from '../../hooks/useGroupPay'
import { GROUP_RAIL, validateRecipients } from '../../lib/payments/groupPay'
import { useNotification } from '../../hooks/useUI'
import { extractAddressFromScan } from '../../lib/addressBook/scanAddress'
import { useBitcoinWallet } from '../../hooks/useBitcoinWallet'
import { getBitcoinNetwork } from '../../config/bitcoinNetworks'
import BitcoinSendPanel from './BitcoinSendPanel'
import { formatDecimalForDisplay } from '../../lib/format/amount'

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
const toNum = (v) => (v == null || v === '' ? null : Number(v))

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

/**
 * Transfer tab — send any asset from the connected account's cross-network portfolio to an address/ENS name.
 *
 * Flexibility (this spec): the asset is a dropdown of every transferable portfolio holding, the "From" is a
 * dropdown of the connected wallet plus Protect (custody) vaults, and the gasless badge reflects each asset's
 * OWN network capability. Because a transfer is signed on the connected chain, an asset on another network is
 * gated behind a "Switch to {network}" step before Preview/Send. Sending from a vault creates a threshold
 * proposal (useActiveAccount) rather than an immediate transfer.
 */
export default function TransferForm({ onSent }) {
  const {
    send, status, error, quoteGaslessForAsset, balanceOf, refreshBalances, tokens, isPasskey,
  } = useTransfer()
  const { address, chainId } = useWallet()
  const { identity, isVault, operateAsPersonal, operateAsVault, operateAsLegacy, operateAsHardware } = useActiveAccount()
  const { vaults } = useCustodyVaults()
  const legacyAccounts = useLegacyAccounts()
  const hardwareAccounts = useHardwareAccounts()
  const portfolio = usePortfolio()
  // Assets + balances come from whichever account we're ACTING AS — not the connected wallet.
  // Spec 088: resolved through the shared effective-account seam so EVERY acting kind (vault,
  // recovered, hardware, derived) is covered; the inline vault/legacy-only copy this replaces
  // silently showed the connected wallet's balances for the other kinds.
  const { address: effectiveAddress, isActingAccount } = useEffectiveAccount()
  const actingAddress = isActingAccount ? effectiveAddress : null
  const actingAssets = useAccountAssets(actingAddress)
  const { screenOne } = useAddressScreening()
  const { showNotification } = useNotification()
  const { switchChainAsync, isPending: switching } = useSwitchChain()
  // Bitcoin (spec 061): a parallel, non-EVM send pipeline. The asset row only
  // appears when the wallet is actually usable (ready, unlocked) — the
  // receive/portfolio surfaces own the unlock journey, honest-state style.
  const btc = useBitcoinWallet()

  const [selectedKey, setSelectedKey] = useState(null)
  const [toRaw, setToRaw] = useState('')
  const [toResolved, setToResolved] = useState('')
  const [amount, setAmount] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [screening, setScreening] = useState(null) // null | 'clear' | 'restricted' | 'uncertain'
  const [formError, setFormError] = useState(null)
  const [scanOpen, setScanOpen] = useState(false)
  // Group pay (release 1.14.0): recipients 2..N. Empty ⇒ this is the single-recipient form and
  // nothing below behaves differently.
  const [extraRecipients, setExtraRecipients] = useState([])
  const [groupScreening, setGroupScreening] = useState({})
  const [groupResult, setGroupResult] = useState(null)

  const connectedChainId = Number(chainId)

  useEffect(() => { refreshBalances() }, [refreshBalances])

  const isConnectedStableAddr = useCallback(
    (addr) => Boolean(addr && tokens.stableAddress && addr.toLowerCase() === tokens.stableAddress.toLowerCase()),
    [tokens.stableAddress],
  )

  // Compose the asset dropdown. The connected chain's native + stablecoin are always present (so the form is
  // usable before balances load / at zero balance); balances and the rest of the list come from the active
  // funding source. Keyed by `${chainId}:${registryId}` so the synthesized defaults merge with their row.
  //
  // Personal → the whole cross-network portfolio (usePortfolio). Vault → the vault's own connected-chain
  // holdings (useAccountAssets); a vault can only move funds on its own chain, so no cross-chain rows.
  const assetOptions = useMemo(() => {
    const byKey = new Map()
    const put = (opt) => byKey.set(opt.key, { ...(byKey.get(opt.key) || {}), ...opt })

    if (tokens.native) {
      put({
        key: `${connectedChainId}:native`,
        chainId: connectedChainId,
        kind: 'native',
        address: null,
        symbol: tokens.native,
        name: tokens.nativeName,
        decimals: tokens.nativeDecimals,
        networkName: tokens.networkName,
        balance: actingAddress ? null : toNum(balanceOf(TRANSFER_KIND.NATIVE)),
      })
    }
    if (tokens.stableAddress) {
      put({
        key: `${connectedChainId}:${tokens.stableAddress.toLowerCase()}`,
        chainId: connectedChainId,
        kind: 'erc20',
        address: tokens.stableAddress,
        symbol: tokens.stable,
        name: tokens.stableName,
        decimals: tokens.stableDecimals,
        networkName: tokens.networkName,
        balance: actingAddress ? null : toNum(balanceOf(TRANSFER_KIND.STABLE)),
      })
    }

    // Native Bitcoin — personal wallet only (custody vaults are EVM Safes and
    // can never hold BTC). Balance is the SPENDABLE amount: what a send can
    // actually move (protected/pending value is disclosed in the panel).
    if (!actingAddress && btc.status === 'ready') {
      put({
        key: 'bitcoin:native',
        chainId: btc.networkId,
        kind: 'btc-native',
        address: null,
        symbol: 'BTC',
        name: 'Bitcoin',
        decimals: 8,
        networkName: getBitcoinNetwork(btc.networkId)?.name || 'Bitcoin',
        balance: (btc.balances.spendableSats ?? 0) / 1e8,
      })
    }

    const source = actingAddress ? actingAssets.holdings : portfolio.holdings
    for (const h of source || []) {
      if (h.asset.kind !== 'native' && h.asset.kind !== 'erc20') continue // no NFTs in a value transfer
      const keepZero = h.asset.kind === 'native' || isConnectedStableAddr(h.asset.address)
      if (!(h.balance > 0) && !keepZero) continue
      put({
        key: `${Number(h.asset.chainId)}:${String(h.asset.id).toLowerCase()}`,
        chainId: Number(h.asset.chainId),
        kind: h.asset.kind,
        address: h.asset.address || null,
        symbol: h.asset.symbol,
        name: h.asset.name,
        decimals: h.asset.decimals,
        networkName: h.network,
        balance: h.balance,
      })
    }

    return [...byKey.values()].sort((a, b) => {
      const ac = a.chainId === connectedChainId ? 0 : 1
      const bc = b.chainId === connectedChainId ? 0 : 1
      if (ac !== bc) return ac - bc
      return (b.balance ?? 0) - (a.balance ?? 0)
    })
  }, [actingAddress, actingAssets.holdings, portfolio.holdings, tokens, connectedChainId, balanceOf, isConnectedStableAddr, btc.status, btc.networkId, btc.balances.spendableSats])

  // Default to the connected chain's stablecoin, then its native coin, then whatever's first.
  const defaultKey = useMemo(() => {
    const stable = assetOptions.find(
      (o) => o.chainId === connectedChainId && o.address && tokens.stableAddress &&
        o.address.toLowerCase() === tokens.stableAddress.toLowerCase(),
    )
    if (stable) return stable.key
    const native = assetOptions.find((o) => o.chainId === connectedChainId && o.kind === 'native')
    return (native || assetOptions[0])?.key || null
  }, [assetOptions, connectedChainId, tokens.stableAddress])

  const activeKey = selectedKey && assetOptions.some((o) => o.key === selectedKey) ? selectedKey : defaultKey
  const selectedAsset = assetOptions.find((o) => o.key === activeKey) || null

  const isBitcoinAsset = selectedAsset?.kind === 'btc-native'
  const onConnectedChain = selectedAsset && Number(selectedAsset.chainId) === connectedChainId

  // Group pay (release 1.14.0): dormant until the member adds a second recipient. It is handed
  // the selected asset because issue #1441's availability is a fact about the asset's own
  // NETWORK, not only about the acting identity — hence its position here, after the selection.
  const groupPay = useGroupPay({ asset: selectedAsset })
  const groupBusy = groupPay.status === 'screening' || groupPay.status === 'submitting'
  const busy = status === 'signing' || status === 'submitting' || status === 'pending' || groupBusy

  // Bitcoin is never gasless (FR-015) — both the badge and the dropdown's
  // per-option marker must say so, whatever the EVM quote would claim.
  const gaslessForOption = useCallback(
    (opt) => (opt?.kind === 'btc-native' ? false : quoteGaslessForAsset(opt)),
    [quoteGaslessForAsset],
  )
  const gasless = selectedAsset ? gaslessForOption(selectedAsset) : false
  const bal = selectedAsset?.balance ?? null
  const symbol = selectedAsset?.symbol || ''

  // "From" accounts: the personal wallet plus every custody vault surfaced in Protect (on this network).
  const fromAccounts = useMemo(() => {
    const list = [{ id: 'personal', kind: 'personal', label: '', address, chainId: connectedChainId }]
    for (const v of vaults || []) {
      if (v.isSafe === false) continue
      list.push({
        id: `vault:${v.address}`,
        kind: 'vault',
        label: v.label || `Vault ${short(v.address)}`,
        address: v.address,
        chainId: Number(v.chainId),
      })
    }
    return list.concat(legacyAccounts, hardwareAccounts)
  }, [address, vaults, connectedChainId, legacyAccounts, hardwareAccounts])

  const fromValue = isVault && identity?.vaultAddress
    ? `vault:${identity.vaultAddress}`
    : (identity?.mode === 'legacy' || identity?.mode === 'hardware') && identity.address
      ? `${identity.mode}:${String(identity.address).toLowerCase()}`
      : 'personal'

  // Spec 088 — switching the "from" account is ADDRESS-ONLY and instant for every kind. The
  // unlock / device ceremony happens at SEND time, rendered by the global SignerRequestHost.
  const handleFromChange = useCallback(
    (account) => {
      setPreviewing(false)
      setFormError(null)
      if (account.kind === 'vault') {
        operateAsVault({ address: account.address, chainId: account.chainId, label: account.label })
      } else if (account.kind === 'legacy') {
        operateAsLegacy({ address: account.address, kind: account.entry?.kind, label: account.label })
      } else if (account.kind === 'hardware') {
        operateAsHardware({ address: account.address, vendor: account.vendor, label: account.label })
      } else {
        operateAsPersonal()
      }
    },
    [operateAsVault, operateAsPersonal, operateAsLegacy, operateAsHardware],
  )

  // Advisory sanctions pre-check on the resolved recipient, against the SELECTED asset's chain.
  useEffect(() => {
    let cancelled = false
    if (!toResolved) { setScreening(null); return undefined }
    setScreening(null)
    Promise.resolve(screenOne(toResolved, selectedAsset?.chainId ?? connectedChainId))
      .then((s) => { if (!cancelled) setScreening(s) })
      .catch(() => { if (!cancelled) setScreening('uncertain') })
    return () => { cancelled = true }
  }, [toResolved, screenOne, selectedAsset?.chainId, connectedChainId])

  const amountValid = useMemo(() => {
    const n = Number(amount)
    return Number.isFinite(n) && n > 0
  }, [amount])

  // Gate on the active funding source's balance (the vault's own holdings when operating as a vault, so a
  // proposal is never drafted for more than the vault holds). A still-loading balance (null) doesn't gate.
  const overBalance = useMemo(() => {
    if (bal == null || !amountValid) return false
    return Number(amount) > Number(bal)
  }, [bal, amount, amountValid])

  // ── Group pay ─────────────────────────────────────────────────────────────────────────────
  const isGroup = extraRecipients.length > 0
  const allRecipients = useMemo(
    () => [{ id: PRIMARY_ID, raw: toRaw, address: toResolved, amount }, ...extraRecipients],
    [toRaw, toResolved, amount, extraRecipients],
  )
  const groupAddressKey = allRecipients.map((r) => r.address).join(',')
  const assetChainId = selectedAsset?.chainId ?? connectedChainId

  // Advisory screening for every recipient (the engine re-screens, forced, at submit time).
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
          selfAddress: actingAddress || address,
          screening: groupScreening,
        })
      : null),
    [isGroup, allRecipients, selectedAsset, symbol, bal, actingAddress, address, groupScreening],
  )
  const groupRefused = isGroup && groupPay.rail === GROUP_RAIL.REFUSED
  const issuesFor = useCallback(
    (id) => groupValidation?.rows.find((r) => r.id === id)?.issues ?? [],
    [groupValidation],
  )

  const canPreview =
    Boolean(selectedAsset) && onConnectedChain && !busy && (
      isGroup
        ? !groupValidation.blocking && !groupRefused
        : Boolean(toResolved) && amountValid && !overBalance && screening !== 'restricted'
    )

  const handleMax = useCallback(() => {
    if (bal != null) setAmount(String(bal))
  }, [bal])

  const resetForm = useCallback(() => {
    setToRaw(''); setToResolved(''); setAmount(''); setPreviewing(false); setScreening(null); setFormError(null)
    setExtraRecipients([]); setGroupScreening({}); setGroupResult(null)
  }, [])

  const applyAddress = useCallback((addr) => {
    setToRaw(addr)
    setToResolved(addr)
  }, [])

  const handleScan = useCallback((decodedText) => {
    const addr = extractAddressFromScan(decodedText)
    if (addr) applyAddress(addr)
    setScanOpen(false)
  }, [applyAddress])

  const handleSelectAsset = useCallback((option) => {
    setSelectedKey(option.key)
    setPreviewing(false)
    setFormError(null)
  }, [])

  const handleSwitch = useCallback(async () => {
    if (!selectedAsset) return
    setFormError(null)
    try {
      await switchChainAsync({ chainId: selectedAsset.chainId })
    } catch (err) {
      setFormError(err?.shortMessage || err?.message || 'Could not switch network.')
    }
  }, [selectedAsset, switchChainAsync])

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
        // Submitted but not yet confirmed on-chain (a stalled/never-included UserOp): tell the truth.
        showNotification(
          `Submitted ${amount} ${symbol} to ${short(toResolved)} — still confirming on-chain. It will show as complete in Activity once settled.`,
          'info',
        )
      } else {
        showNotification(
          `Sent ${amount} ${symbol} to ${short(toResolved)}${res.route === 'gasless' ? ' (gasless)' : ''}.`,
          'success',
        )
      }
      resetForm()
      onSent?.(res)
    } catch (err) {
      setFormError(err?.shortMessage || err?.message || 'Transfer failed.')
    }
  }, [send, selectedAsset, toResolved, amount, symbol, showNotification, resetForm, onSent])

  /**
   * Submit the whole list. The rail (one batch, one vault proposal, or N sequential sends) is the
   * engine's decision; its per-recipient outcomes are what gets shown afterwards, so a partial
   * result is reported as a partial result.
   */
  const handleGroupSend = useCallback(async () => {
    setFormError(null)
    try {
      const res = await groupPay.submitGroup({ asset: selectedAsset, recipients: allRecipients })
      setGroupResult(res)
      const clean = !res.summary?.failed && !res.summary?.skipped
      showNotification(groupNotice(res.summary), clean ? 'success' : 'info')
      onSent?.(res)
    } catch (err) {
      // Nothing was signed: stay on the preview with the draft intact.
      setFormError(err?.shortMessage || err?.message || 'The payment could not be submitted.')
    }
  }, [groupPay, selectedAsset, allRecipients, showNotification, onSent])

  return (
    <div className="pt-form">
      {/* Asset selector — the whole cross-network portfolio */}
      <div className="pt-field">
        <span className="pt-label">Asset</span>
        <TransferAssetSelect
          options={assetOptions}
          value={activeKey}
          onChange={handleSelectAsset}
          isGasless={gaslessForOption}
          disabled={busy}
        />
        {gasless ? (
          <span className="pt-badge pt-badge-gasless">⚡ Gasless{isPasskey ? ' · sponsored' : ''}</span>
        ) : (
          <span className="pt-badge pt-badge-fee">Network fee applies</span>
        )}
      </div>

      {isBitcoinAsset ? (
        <BitcoinSendPanel
          btc={btc}
          usdPerBtc={portfolio.priceMap?.get('BTC')?.usd ?? null}
          onSent={onSent}
        />
      ) : !previewing ? (
        <>
          {/* From — connected wallet or a Protect vault */}
          <div className="pt-field">
            <span className="pt-label">From</span>
            <TransferFromSelect
              accounts={fromAccounts}
              value={fromValue}
              onChange={handleFromChange}
              disabled={busy}
            />
            {isVault && (
              <span className="pt-hint">
                Balances and assets are the vault&apos;s. Sending creates a proposal its signers must approve
                before it executes.
              </span>
            )}
          </div>

          {/* To — the standard address entry (ENS resolution + address book + QR scan) */}
          <div className="pt-field">
            <div className="pt-label-row">
              <label className="pt-label" htmlFor="pt-to">To</label>
              {/* The To field is recipient ONE of a group, not the only recipient (spec 058:
                  `allRecipients` puts this form's own address first, then rows 2..N). Without a
                  marker the field reads as the whole destination while the money goes to several
                  people, so the count is stated where the address is entered. */}
              {isGroup && (
                <span
                  className="pt-badge pt-badge-multi"
                  aria-label={`Multiple recipients: ${allRecipients.length}`}
                >
                  Multi · {allRecipients.length}
                </span>
              )}
            </div>
            <div className="pt-input-with-action">
              <div className="pt-address-input-wrap">
                <AddressInput
                  id="pt-to"
                  value={toRaw}
                  onChange={(e) => setToRaw(e.target.value)}
                  onResolvedChange={(addr) => setToResolved(addr || '')}
                  chainId={selectedAsset?.chainId ?? connectedChainId}
                  placeholder="0x… or ENS name (e.g., vitalik.eth)"
                  disabled={busy}
                />
              </div>
              <AddressBookButton disabled={busy} onSelect={(entry) => applyAddress(entry.address)} />
              <button
                type="button"
                className="pt-scan-btn"
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
            {/* Estate-wide advisory screen (issue #1458): every list on every cohort chain. */}
            <AddressScreenNotice address={toResolved} chainId={assetChainId} />
            {/* The per-chain `screening` read is a SEPARATE fact: it is the guard on the chain the
                value moves on, the read the contract will repeat, and it is what withholds the
                button — so its refusal is stated as its own alert, next to the button it disables. */}
            {screening === 'restricted' && (
              <div className="pt-notice pt-notice-error" role="alert">
                This address is flagged by sanctions screening on this network. Sending is withheld: the on-chain guard would refuse it.
              </div>
            )}
            {isGroup && issuesFor(PRIMARY_ID).map((issue) => (
              <div
                key={issue.code}
                className={issue.blocking ? 'pt-notice pt-notice-error' : 'pt-hint'}
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
              idPrefix="pt"
              available={Boolean(groupPay.available)}
            />
          </div>

          {/* Amount */}
          <div className="pt-field">
            <label className="pt-label" htmlFor="pt-amount">Amount</label>
            <div className="pt-amount-row">
              <input
                id="pt-amount"
                className="pt-amount-input"
                inputMode="decimal"
                type="text"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="0.00"
                disabled={busy}
                aria-describedby="pt-amount-hint"
              />
              <button type="button" className="pt-max" onClick={handleMax} disabled={isVault || bal == null || busy}>MAX</button>
              <span className="pt-amount-sym">{symbol}</span>
            </div>
            <span className="pt-hint" id="pt-amount-hint">
              {bal != null
                ? <>Balance: <SensitiveValue>{formatDecimalForDisplay(bal)}</SensitiveValue> {symbol}</>
                : 'Loading balance…'}
              {overBalance && ' · exceeds balance'}
            </span>
          </div>

          {isGroup && (groupRefused || groupValidation.overBalance || groupValidation.tooMany) && (
            <div className="pt-notice pt-notice-error" role="alert">
              {groupRefused
                ? groupPay.railReason
                : groupValidation.overBalance
                  ? `That's more ${symbol} than you have in total.`
                  : 'That is more recipients than one payment can carry.'}
            </div>
          )}

          {(error || formError) && (
            <div className="pt-notice pt-notice-error" role="alert">{formError || error}</div>
          )}

          <div className="pt-actions">
            {selectedAsset && !onConnectedChain ? (
              <button
                type="button"
                className="pt-btn pt-btn-primary"
                onClick={handleSwitch}
                disabled={switching || busy}
              >
                {switching ? 'Switching…' : `Switch to ${selectedAsset.networkName} to send`}
              </button>
            ) : (
              <button
                type="button"
                className="pt-btn pt-btn-primary"
                onClick={() => setPreviewing(true)}
                disabled={!canPreview}
              >
                Preview
              </button>
            )}
          </div>
        </>
      ) : groupResult ? (
        <GroupPayOutcomes
          outcomes={groupResult.outcomes}
          summary={groupResult.summary}
          symbol={symbol}
          onDone={() => { groupPay.reset(); resetForm() }}
        />
      ) : isGroup ? (
        <>
          <GroupPayBreakdown
            recipients={allRecipients}
            total={groupValidation.total}
            symbol={symbol}
            networkName={selectedAsset?.networkName}
            rail={groupPay.rail}
            batchSupport={groupPay.vaultBatch?.support ?? null}
            gasless={gasless}
            nativeSymbol={tokens.native}
          />

          {(error || formError) && (
            <div className="pt-notice pt-notice-error" role="alert">{formError || error}</div>
          )}

          <div className="pt-actions">
            <button type="button" className="pt-btn pt-btn-secondary" onClick={() => setPreviewing(false)} disabled={busy}>
              Back
            </button>
            <button type="button" className="pt-btn pt-btn-primary" onClick={handleGroupSend} disabled={busy}>
              {busy
                ? 'Sending…'
                : isVault
                  ? `Propose ${allRecipients.length} payments`
                  : `Send to ${allRecipients.length} recipients`}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pt-preview" aria-live="polite">
            <div className="pt-preview-amount">{amount} {symbol}</div>
            <div className="pt-preview-row"><span className="k">To</span><span className="v">{short(toResolved)}</span></div>
            <div className="pt-preview-row"><span className="k">Network</span><span className="v">{selectedAsset?.networkName}</span></div>
            <div className="pt-preview-row">
              <span className="k">Fee</span>
              <span className="v">{gasless ? 'Gasless — no network fee' : `You pay the ${tokens.native} network fee`}</span>
            </div>
            {isVault && (
              <div className="pt-preview-row">
                <span className="k">Sending as</span>
                <span className="v">Vault proposal</span>
              </div>
            )}
          </div>

          {(error || formError) && (
            <div className="pt-notice pt-notice-error" role="alert">{formError || error}</div>
          )}

          <div className="pt-actions">
            <button type="button" className="pt-btn pt-btn-secondary" onClick={() => setPreviewing(false)} disabled={busy}>
              Back
            </button>
            <button type="button" className="pt-btn pt-btn-primary" onClick={handleSend} disabled={busy}>
              {busy ? (status === 'signing' ? 'Confirm in wallet…' : 'Sending…') : isVault ? 'Propose' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
