import { useCallback, useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'
import AmountKeypad from '../ui/AmountKeypad'
import RequestQRModal from './RequestQRModal'
import UniversalAssetSelect from '../ui/UniversalAssetSelect'
import { useWallet } from '../../hooks'
import { useEffectiveAccount } from '../../hooks/useEffectiveAccount'
import { useSelectableAssets } from '../../hooks/useSelectableAssets'
import { useBitcoinWallet } from '../../hooks/useBitcoinWallet'
import { formatBip21 } from '../../lib/bitcoin/addresses'
import { ASSET_ACTIVITIES } from '../../lib/assets/assetActivity'
import { getDefaultCurrencyKind } from '../../utils/homePreference'
import { buildPaymentRequestUri, NOTE_MAX_LENGTH } from '../../lib/payments/paymentRequest'
import PillSelect from '../ui/PillSelect'
import NavIcon from '../nav/NavIcon'
import FundingPoolCreatePanel from '../funding/FundingPoolCreatePanel'
import MyFundingPoolsSheet from '../funding/MyFundingPoolsSheet'
import '../funding/funding.css'

// Request kinds (spec 103, FR-001): a DIRECT one-time request, or a funding POOL. Same surface, same
// chrome, a compact switch with a subtle glyph each; the direct form below is byte-for-byte the
// spec-058/064 flow.
const REQUEST_KINDS = [
  { value: 'once', label: 'Direct', icon: <NavIcon name="arrowIn" size={14} /> },
  { value: 'pool', label: 'Pool', icon: <NavIcon name="users" size={14} /> },
]

const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || '')

/**
 * RequestPanel (spec 058 US2 + spec 064 US2) — ask someone for value in ANY
 * platform-supported asset the acting account holds, chosen with the universal asset
 * selector (nested logos + network sub-badge). The "Request" action builds a standard
 * payment request encoding the selected asset's identity: an EIP-681 URI for EVM
 * assets (native `value=` or ERC-20 `/transfer` form), or a BIP-21 `bitcoin:` URI for
 * a Bitcoin request. Requests are ephemeral — displayed, never persisted — and a shown
 * request is invalidated whenever the selected asset or acting account changes so a
 * stale QR can never point at the wrong asset/account (FR-010).
 *
 * Contract: specs/064-universal-asset-selector/contracts/universal-asset-selector.md
 */
function RequestPanel({ initialKind = 'once', kindNonce = 0 }) {
  const { address: connectedAddress, isConnected, openConnectModal } = useWallet()
  const [kind, setKind] = useState(initialKind)
  const [showMyPools, setShowMyPools] = useState(false)
  // A deep link that arrives while mounted re-applies the requested kind (HomeScreen bumps the nonce).
  useEffect(() => {
    if (kindNonce > 0) setKind(initialKind)
  }, [initialKind, kindNonce])
  // Spec 063 (US1): the request must be addressed to the account the member is ACTING AS
  // (a vault or recovered account), not always the connected wallet.
  const { address: effectiveAddress, isActingAccount, label: actingLabel, type: actingType } = useEffectiveAccount()
  const address = effectiveAddress || connectedAddress

  const actingAddress = isActingAccount ? effectiveAddress : null
  // Request RECEIVES value, so it offers the full catalog of platform-supported
  // assets (not just held ones) — a member can request anything. Default stays USDC.
  const { options, defaultKey } = useSelectableAssets({
    activity: ASSET_ACTIVITIES.REQUEST,
    actingAddress,
    catalog: true,
  })
  const btc = useBitcoinWallet()

  const [selectedKey, setSelectedKey] = useState(null)
  const [amount, setAmountState] = useState('')
  const [note, setNoteState] = useState('')
  const [generated, setGenerated] = useState(null) // { uri, note, amount, symbol, accountKey, assetKey } | null
  const [formError, setFormError] = useState(null)

  // Preference-aware default (spec 058): 'native' preselects the connected native
  // coin, else the activity default (connected stablecoin). The member's pick wins.
  const preferredDefaultKey = useMemo(() => {
    if (getDefaultCurrencyKind() === 'native') {
      const nativeOpt = options.find((o) => o.kind === 'native')
      if (nativeOpt) return nativeOpt.key
    }
    return defaultKey
  }, [options, defaultKey])

  const activeKey = selectedKey && options.some((o) => o.key === selectedKey) ? selectedKey : preferredDefaultKey
  const selectedAsset = options.find((o) => o.key === activeKey) || null
  const symbol = selectedAsset?.symbol || ''
  const isBitcoin = selectedAsset?.kind === 'btc-native'

  const amountValid = Number.isFinite(Number(amount)) && Number(amount) > 0

  // A generated request is only valid for the acting account + asset it was built
  // for: any change nulls it so the QR can never pay the previous address/asset.
  const safeGenerated =
    generated && generated.accountKey === address && generated.assetKey === activeKey ? generated : null

  // Any input change invalidates a displayed code (belt-and-braces alongside the
  // modal's focus trap, so a stale QR is never shown after an edit).
  const setAmount = useCallback((v) => { setAmountState(v); setGenerated(null); setFormError(null) }, [])
  const setNote = useCallback((v) => { setNoteState(v); setGenerated(null); setFormError(null) }, [])
  const handleSelectAsset = useCallback((option) => {
    setSelectedKey(option.key); setGenerated(null); setFormError(null)
  }, [])

  const handleRequest = useCallback(() => {
    setFormError(null)
    if (!selectedAsset) { setFormError('Pick an asset to request.'); return }
    try {
      if (isBitcoin) {
        // BIP-21 request against a freshly issued receive address (never reused).
        if (btc.status !== 'ready') {
          setFormError('Your Bitcoin wallet is not ready — unlock it to request BTC.')
          return
        }
        const entry = btc.receive?.nextReceiveAddress?.()
        const btcAddress = entry?.address
        if (!btcAddress) { setFormError('Could not get a Bitcoin receive address.'); return }
        const amountSats = Math.round(Number(amount) * 1e8)
        const uri = formatBip21(btcAddress, { amountSats, label: note?.trim() || undefined })
        setGenerated({ uri, note: note.trim(), amount, symbol, accountKey: address, assetKey: activeKey })
        return
      }
      // EVM: native `value=` form, or the `/transfer` form for any ERC-20.
      const uri = buildPaymentRequestUri({
        chainId: selectedAsset.chainId,
        to: address,
        kind: selectedAsset.kind === 'native' ? 'native' : 'stable',
        tokenAddress: selectedAsset.address,
        decimals: selectedAsset.decimals,
        amount,
        note,
      })
      setGenerated({ uri, note: note.trim(), amount, symbol, accountKey: address, assetKey: activeKey })
    } catch (err) {
      setFormError(err?.message || 'Could not create the request.')
    }
  }, [selectedAsset, isBitcoin, btc, amount, note, symbol, address, activeKey])

  const requestDisabled = !amountValid || !selectedAsset || (isBitcoin && btc.status !== 'ready')

  const kindSwitch = (
    <div className="fp-kind-switch">
      <PillSelect
        label="Request kind"
        hideLabel
        options={REQUEST_KINDS}
        value={kind}
        onChange={setKind}
      />
    </div>
  )

  if (kind === 'pool') {
    return (
      <div className="fm-form fm-pay-form request-panel request-panel--pool" data-testid="request-kind" data-kind="pool">
        {kindSwitch}
        <FundingPoolCreatePanel
          isConnected={isConnected && Boolean(address)}
          onConnect={() => openConnectModal()}
          onOpenMyPools={() => setShowMyPools(true)}
        />
        <MyFundingPoolsSheet open={showMyPools} onClose={() => setShowMyPools(false)} onStartPool={() => setKind('pool')} />
      </div>
    )
  }

  return (
    <div className="fm-form fm-pay-form request-panel" data-testid="request-kind" data-kind="once">
      {kindSwitch}
      <div className="fm-pay-hero">
        <AmountKeypad
          value={amount}
          onChange={setAmount}
          prefix="$"
          token={symbol}
          tokenSlot={(
            <>
              <span className="sr-only">Currency</span>
              <UniversalAssetSelect
                label="Currency"
                options={options}
                value={activeKey}
                onChange={handleSelectAsset}
                disabled={false}
              />
            </>
          )}
          ariaLabel="Amount to request"
          id="request-amount"
        />
      </div>

      <div className="fm-form-group fm-form-full fm-pay-memo">
        <label className="sr-only" htmlFor="request-note">What&apos;s it for?</label>
        <input
          id="request-note"
          type="text"
          maxLength={NOTE_MAX_LENGTH}
          className="fm-pay-memo-input"
          placeholder="What's it for? — e.g. pizza night"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {isActingAccount && address && (
        <p className="fm-pay-acting-note" role="note">
          Paid to your {actingType === 'vault' ? 'multisig' : 'recovered account'}
          {actingLabel ? ` · ${actingLabel}` : ` · ${shortAddr(address)}`}
        </p>
      )}
      {isBitcoin && (
        <p className="fm-pay-acting-note" role="note">
          Paid to a fresh Bitcoin address on {selectedAsset?.networkName || 'Bitcoin'}.
        </p>
      )}

      {isBitcoin && btc.status !== 'ready' && (
        <div className="fm-error-banner" role="alert">Unlock your Bitcoin wallet to request BTC.</div>
      )}
      {formError && <div className="fm-error-banner" role="alert">{formError}</div>}

      <div className="fm-success-actions">
        {!isConnected || !address ? (
          <button type="button" className="fm-btn-primary" onClick={() => openConnectModal()}>
            Connect wallet
          </button>
        ) : (
          <button
            type="button"
            className="fm-btn-primary"
            onClick={handleRequest}
            disabled={requestDisabled}
          >
            Request
          </button>
        )}
      </div>

      <RequestQRModal
        isOpen={Boolean(safeGenerated)}
        onClose={() => setGenerated(null)}
        uri={safeGenerated?.uri}
        amount={safeGenerated?.amount}
        symbol={safeGenerated?.symbol}
        note={safeGenerated?.note}
      />
    </div>
  )
}

RequestPanel.propTypes = {
  /** 'once' (default) or 'pool' — lets a deep link or test open the Pool kind directly. */
  initialKind: PropTypes.oneOf(['once', 'pool']),
  /** Bumped by the parent when a deep link re-requests `initialKind` on an already-mounted panel. */
  kindNonce: PropTypes.number,
}

export default RequestPanel
