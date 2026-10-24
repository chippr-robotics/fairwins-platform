import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, parseUnits } from '../../lib/evm/units'
import SensitiveValue from '../common/SensitiveValue'
import UniversalAssetSelect from '../ui/UniversalAssetSelect'
import { useWrapNative, WRAP_DIRECTION } from '../../hooks/useWrapNative'
import { useWrapCoinOptions } from '../../hooks/useWrapCoinOptions'
import { useActiveAccount } from '../../hooks/useActiveAccount'
import { useNotification } from '../../hooks/useUI'
import { getNetwork } from '../../config/networks'
import { formatUnitsForDisplay } from '../../lib/format/amount'
// The view is built on the Transfer section's `pt-*` vocabulary. It used to inherit this
// stylesheet from PayTransferPanel; now that it also mounts under Trade (release 1.14.0) it
// carries its own import so its styles never depend on which section mounted first.
import './PayTransfer.css'

/**
 * Wrap — turn the connected network's coin into its canonical wrapped token, and back.
 *
 * Deliberately the plainest surface in this section, because the operation is plain: the
 * wrapper mints 1:1 on deposit and burns 1:1 on withdraw. There is no rate to quote, no
 * slippage to disclose and no counterparty, so the only number the member needs is the
 * amount — and the only cost is the network fee, which is stated rather than implied.
 *
 * Two things this view will not do:
 *   - It never renders an unread balance as zero. A balance that failed to read shows "—",
 *     because "0" is a claim about the member's money (Constitution III).
 *   - It never offers a MAX that spends the fee. Wrapping is paid for in the same coin
 *     being wrapped, so MAX offers the balance less the reserve the hook quotes from the
 *     chain, and says so.
 *
 * Where the network has no wrapped coin in the app's configuration, the view says exactly
 * that and offers nothing — no address is guessed for a contract that would receive funds.
 */
export default function WrapView() {
  const { showNotification } = useNotification()
  const [direction, setDirection] = useState(WRAP_DIRECTION.WRAP)
  const [amount, setAmount] = useState('')
  const [formError, setFormError] = useState(null)
  const [receipt, setReceipt] = useState(null)

  // Spec 108 — the ASSET is the entry point. The picker lists every cohort chain's coin
  // (config/wrappedNative.js#listWrappableCoins via useWrapCoinOptions), and the selection
  // decides where the wrap runs; the connected network only decides whether a switch will be
  // asked for at submit time.
  const { options, defaultKey } = useWrapCoinOptions({ direction })
  const [selectedKey, setSelectedKey] = useState(null)
  const activeKey = selectedKey ?? defaultKey
  const selectedCoin = options.find((o) => o.key === activeKey) || null

  // Acting accounts (vault / recovered / hardware) wrap on their own chain only — the picker
  // pins to it, so the acting rails never see a foreign target (their refusals are already
  // chain-specific and spec 102 owns multichain custody actions).
  const { isVault: actingVault, isLegacy, isHardware } = useActiveAccount()
  const acting = actingVault || isLegacy || isHardware

  const wrapper = useWrapNative(selectedCoin ? { chainId: selectedCoin.chainId } : {})

  const {
    token, available, networkName, chainId, nativeSymbol, wrappedSymbol, decimals,
    nativeBalance, wrappedBalance, maxWrappable, gasReserve, sponsored, isVault, busy, status, error,
    needsSwitch, writeRail,
  } = wrapper

  // A MAX (or any amount) quoted against one chain's balance and reserve is never carried to
  // another — changing the coin clears the form exactly as changing direction does. Only a
  // CHANGE clears: the picker's options load asynchronously, so the default key resolving
  // (null → first coin) is not a member action and must not wipe an amount already typed.
  const prevKeyRef = useRef(null)
  useEffect(() => {
    const prev = prevKeyRef.current
    prevKeyRef.current = activeKey
    if (prev == null || prev === activeKey) return
    setAmount('')
    setFormError(null)
    setReceipt(null)
  }, [activeKey])

  const pinPredicate = useMemo(
    () => (acting ? (o) => o.chainId === Number(chainId) : null),
    [acting, chainId],
  )

  const wrapping = direction === WRAP_DIRECTION.WRAP
  const fromSymbol = wrapping ? nativeSymbol : wrappedSymbol
  const toSymbol = wrapping ? wrappedSymbol : nativeSymbol
  const sourceBalance = wrapping ? nativeBalance : wrappedBalance
  // Unwrapping is capped by the wrapped balance alone: the fee comes out of the native coin,
  // which is a different balance from the one being spent.
  const spendable = wrapping ? maxWrappable : wrappedBalance

  // Display only (spec 102 FR-018): the tiles, the Balance line and the fee hint show a rounded
  // figure so an 18-decimal balance fits a phone. MAX below still fills the full-precision
  // amount — what is SENT is never rounded here.
  const fmt = useCallback(
    (v) => formatUnitsForDisplay(v, decimals),
    [decimals],
  )

  const parsed = useMemo(() => {
    if (!amount) return null
    try {
      const v = parseUnits(amount, decimals)
      return v > 0n ? v : null
    } catch {
      return null
    }
  }, [amount, decimals])

  const overBalance = parsed != null && sourceBalance != null && parsed > sourceBalance
  // Distinct from over-balance: the coin is there, but wrapping all of it would leave nothing
  // to pay the fee with. Worth its own message — "exceeds balance" would be untrue.
  const overSpendable =
    !overBalance && parsed != null && spendable != null && parsed > spendable

  const canSubmit = Boolean(token) && parsed != null && !overBalance && !overSpendable && !busy

  const handleDirection = useCallback((next) => {
    setDirection(next)
    setAmount('')
    setFormError(null)
    setReceipt(null)
  }, [])

  const handleMax = useCallback(() => {
    if (spendable == null) return
    setAmount(formatUnits(spendable, decimals))
  }, [spendable, decimals])

  const handleSubmit = useCallback(async () => {
    setFormError(null)
    setReceipt(null)
    try {
      const res = wrapping ? await wrapper.wrap(amount) : await wrapper.unwrap(amount)
      setReceipt(res)
      if (res?.proposed) {
        showNotification(
          `Proposed ${wrapping ? 'wrapping' : 'unwrapping'} ${amount} ${fromSymbol} from the vault — its signers must approve it.`,
          'info',
        )
      } else if (res?.pending) {
        showNotification(
          `Submitted ${amount} ${fromSymbol} — still confirming on-chain.`,
          'info',
        )
      } else {
        showNotification(`${wrapping ? 'Wrapped' : 'Unwrapped'} ${amount} ${fromSymbol} → ${toSymbol}.`, 'success')
        setAmount('')
      }
    } catch (err) {
      setFormError(err?.shortMessage || err?.message || 'The transaction failed.')
    }
  }, [wrapping, wrapper, amount, fromSymbol, toSymbol, showNotification])

  if (!available) {
    return (
      <div className="pt-form">
        <div className="pt-notice pt-notice-warn" role="status">
          {options.length === 0
            ? 'No network in this build has a wrapped coin configured, so there is nothing to wrap here.'
            : networkName
              ? `${networkName} has no wrapped coin configured in this app, so there is nothing to wrap here.`
              : 'Connect to a network to wrap its coin.'}
        </div>
      </div>
    )
  }

  const explorerBase = getNetwork(chainId)?.explorer?.baseUrl
  const txUrl = receipt?.txHash && explorerBase ? `${explorerBase}/tx/${receipt.txHash}` : null
  const railUnavailable = writeRail?.kind === 'unavailable'

  return (
    <div className="pt-form">
      {/* The coin (spec 108). Any cohort chain's base coin, with the member's balance beside
          it — the network is a property of the SELECTION, not a mode set beforehand. */}
      <div className="pt-field" data-testid="wrap-coin-field">
        <span className="pt-label">Coin</span>
        <UniversalAssetSelect
          options={options}
          value={activeKey}
          onChange={(option) => setSelectedKey(option.key)}
          disabled={busy}
          label={wrapping ? 'Coin to wrap' : 'Coin to unwrap'}
          pin={acting ? { pinnedSymbol: nativeSymbol, pinnedNetworkName: networkName } : null}
          pinPredicate={pinPredicate}
          pinEmptyMessage={
            acting
              ? `The account you are operating as lives on ${networkName || 'its own network'}, which has no wrapped coin configured.`
              : null
          }
        />
        {selectedCoin?.readState === 'unreadable' && (
          <span className="pt-hint">
            {selectedCoin.networkName} could not be read just now — the balance shown as “—” is
            unknown, not zero. You can still wrap from it.
          </span>
        )}
      </div>

      {/* Direction. Two radio-shaped buttons rather than a swap-style pair of asset pickers:
          the two assets are fixed and the only choice is which way round they go. */}
      <div className="pt-field">
        <span className="pt-label" id="pt-wrap-dir-label">Direction</span>
        <div className="pt-wrap-toggle" role="radiogroup" aria-labelledby="pt-wrap-dir-label">
          <button
            type="button"
            role="radio"
            aria-checked={wrapping}
            className={`pt-wrap-dir ${wrapping ? 'active' : ''}`}
            onClick={() => handleDirection(WRAP_DIRECTION.WRAP)}
            disabled={busy}
          >
            Wrap {nativeSymbol} → {wrappedSymbol}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!wrapping}
            className={`pt-wrap-dir ${!wrapping ? 'active' : ''}`}
            onClick={() => handleDirection(WRAP_DIRECTION.UNWRAP)}
            disabled={busy}
          >
            Unwrap {wrappedSymbol} → {nativeSymbol}
          </button>
        </div>
        <span className="pt-hint">
          {wrappedSymbol} is {networkName}&apos;s wrapped {nativeSymbol} — the ERC-20 form of the
          coin, redeemable one-for-one at any time. Wrapping never changes how much you hold.
        </span>
      </div>

      {/* Balances — both sides, always, so the effect of the action is visible before it runs. */}
      <div className="pt-field">
        <span className="pt-label">Balances</span>
        <div className="pt-wrap-balances">
          <div className="pt-wrap-balance">
            <span className="pt-wrap-balance-sym">{nativeSymbol}</span>
            <span className="pt-wrap-balance-val">
              {nativeBalance == null ? '—' : <SensitiveValue>{fmt(nativeBalance)}</SensitiveValue>}
            </span>
          </div>
          <div className="pt-wrap-balance">
            <span className="pt-wrap-balance-sym">{wrappedSymbol}</span>
            <span className="pt-wrap-balance-val">
              {wrappedBalance == null ? '—' : <SensitiveValue>{fmt(wrappedBalance)}</SensitiveValue>}
            </span>
          </div>
        </div>
        {(nativeBalance == null || wrappedBalance == null) && (
          <span className="pt-hint">A balance shown as “—” could not be read just now — it is not zero.</span>
        )}
      </div>

      {/* Amount */}
      <div className="pt-field">
        <label className="pt-label" htmlFor="pt-wrap-amount">Amount</label>
        <div className="pt-amount-row">
          <input
            id="pt-wrap-amount"
            className="pt-amount-input"
            inputMode="decimal"
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            placeholder="0.00"
            disabled={busy}
            aria-describedby="pt-wrap-amount-hint"
          />
          <button
            type="button"
            className="pt-max"
            onClick={handleMax}
            disabled={busy || spendable == null || isVault}
          >
            MAX
          </button>
          <span className="pt-amount-sym">{fromSymbol}</span>
        </div>
        <span className="pt-hint" id="pt-wrap-amount-hint">
          {sourceBalance == null
            ? `${fromSymbol} balance unavailable`
            : <>Balance: <SensitiveValue>{fmt(sourceBalance)}</SensitiveValue> {fromSymbol}</>}
          {overBalance && ` · exceeds your ${fromSymbol}`}
          {overSpendable && ' · leaves nothing for the network fee'}
        </span>
        {wrapping && !sponsored && gasReserve != null && (
          <span className="pt-hint">
            MAX holds back about {fmt(gasReserve)} {nativeSymbol} for the network fee, since wrapping is
            paid for in {nativeSymbol}.
          </span>
        )}
      </div>

      {/* What it costs. Wrapping mints 1:1, so the ONLY thing worth previewing is the fee. */}
      <div className="pt-preview" aria-live="polite">
        <div className="pt-preview-row">
          <span className="k">You {wrapping ? 'wrap' : 'unwrap'}</span>
          <span className="v">{amount || '0'} {fromSymbol}</span>
        </div>
        <div className="pt-preview-row">
          <span className="k">You receive</span>
          <span className="v">{amount || '0'} {toSymbol}</span>
        </div>
        <div className="pt-preview-row">
          <span className="k">Rate</span>
          <span className="v">1:1 — no price, no slippage</span>
        </div>
        <div className="pt-preview-row">
          <span className="k">Fee</span>
          <span className="v">
            {sponsored ? 'Sponsored — no network fee' : `You pay the ${nativeSymbol} network fee`}
          </span>
        </div>
        {needsSwitch && (
          <div className="pt-preview-row">
            <span className="k">Network</span>
            <span className="v">{networkName} — your wallet will be asked to switch</span>
          </div>
        )}
        {isVault && (
          <div className="pt-preview-row">
            <span className="k">Acting as</span>
            <span className="v">Vault proposal</span>
          </div>
        )}
      </div>

      {isVault && (
        <span className="pt-hint">
          Balances are the vault&apos;s. Wrapping creates a proposal its signers must approve before it executes.
        </span>
      )}

      {(formError || error) && (
        <div className="pt-notice pt-notice-error" role="alert">{formError || error}</div>
      )}

      {receipt && !formError && (
        <div className="pt-notice pt-notice-success" role="status">
          {receipt.proposed
            ? 'Proposed to the vault — its signers must approve it before anything moves.'
            : receipt.pending
              ? 'Submitted and still confirming on-chain. Your balances update once it settles.'
              : `Done — your ${toSymbol} balance is updated.`}
          {txUrl && (
            <>
              {' '}
              <a href={txUrl} target="_blank" rel="noopener noreferrer">View transaction</a>
            </>
          )}
        </div>
      )}

      {/* An unavailable rail is stated BEFORE the tap, in place of a control that would
          throw (the write-rail rule) — and it is a rail fact about THIS chain, not
          "view-only". */}
      {railUnavailable ? (
        <div className="pt-notice pt-notice-warn" role="status" data-testid="wrap-rail-unavailable">
          {writeRail.reason} Pick a coin on a supported network, or connect a wallet that can
          sign on {networkName}.
        </div>
      ) : (
        <div className="pt-actions">
          <button
            type="button"
            className="pt-btn pt-btn-primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {busy
              ? status === 'signing'
                ? 'Confirm in wallet…'
                : status === 'pending'
                  ? 'Confirming…'
                  : 'Submitting…'
              : isVault
                ? 'Propose'
                : wrapping
                  ? `Wrap ${nativeSymbol}${needsSwitch ? ` on ${networkName}` : ''}`
                  : `Unwrap ${wrappedSymbol}${needsSwitch ? ` on ${networkName}` : ''}`}
          </button>
        </div>
      )}
    </div>
  )
}
