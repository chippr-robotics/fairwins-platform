/**
 * VaultSheet (spec 050, US1) — deposit into / withdraw from one lending
 * vault. Bottom-sheet modal per repo convention (Escape + backdrop close,
 * focus managed).
 *
 * Writes go through useEarnSend → WalletContext.sendCalls — the unified
 * spec-041 rail — so BOTH session kinds work: a passkey session authorizes
 * the whole approve+deposit batch with one WebAuthn ceremony (it has no
 * ethers signer), a classic wallet signs each step. Network selection is
 * transparent (like the portfolio): the sheet names the vault's network, and
 * submitting on a different active network switches automatically as part of
 * the confirmation — no separate switch step. Reads (allowance, dry-runs)
 * use the VAULT's chain read provider, never the signer.
 *
 * Non-intimidating by design: amounts are validated with member-facing
 * reasons BEFORE any wallet prompt; a first deposit explains up front how
 * many confirmations to expect for the session kind; a plain-English summary
 * states exactly what will happen; withdrawal honors the vault's honest
 * liquidity bound (maxWithdraw). Every completed action is queued for the
 * activity feed with its transaction link (FR-010).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, parseUnits } from '../../lib/evm/units'
import { useWallet } from '../../hooks/useWalletManagement'
import { useEarnSend, earnActingRefusal } from '../../hooks/useEarnSend'
import { useActivityOptional } from '../../hooks/useActivity'
import { getBlockscoutUrl } from '../../config/blockExplorer'
import { NETWORKS } from '../../config/networks'
import { makeReadProvider } from '../../utils/rpcProvider'
import InfoTip from '../ui/InfoTip'
import { EARN_TIPS } from '../../lib/earn/earnCopy'
import {
  validateDepositAmount,
  validateWithdrawAmount,
  buildDepositCalls,
  buildWithdrawCalls,
} from '../../lib/earn/vaultActions'
import { fetchFeeQuote, splitFee, bpsToPercent, FEE_SERVICES } from '../../lib/fees/feeQuote'
import { queueEarnAction } from '../../lib/earn/earnActivityBuffer'
import { captureEarnAction } from '../../data/ledger'
import { formatApy } from '../../lib/earn/format'

function fmt(amountBig, decimals, symbol) {
  if (amountBig == null) return '—'
  const value = Number(formatUnits(amountBig, decimals))
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${symbol}`
}

export default function VaultSheet({ vault, userState, onClose, onActionComplete }) {
  const { address } = useWallet() || {}
  const { sendOnChain, canTransactOn, cannotTransactReason, isPasskey, isActingAccount, actingAccount } = useEarnSend()
  const activity = useActivityOptional()
  const sheetRef = useRef(null)
  const restoreFocusRef = useRef(null)
  const vaultNetwork = NETWORKS[vault.chainId]
  const canTransact = canTransactOn(vault.chainId)

  const [mode, setMode] = useState('deposit')
  const [amountText, setAmountText] = useState('')
  const [inputError, setInputError] = useState(null)
  // idle | approving | confirming | done | error
  const [txState, setTxState] = useState({ step: 'idle', txUrl: null, error: null })
  // Live platform-fee quote (spec 060). null = loading; { failed: true } = the
  // router exists but the rate could not be read — deposits are blocked rather
  // than shown a possibly-understated rate (FR-015).
  const [feeQuote, setFeeQuote] = useState(null)

  useEffect(() => {
    let cancelled = false
    const provider = makeReadProvider(vaultNetwork.rpcUrl, vault.chainId)
    fetchFeeQuote({ serviceId: FEE_SERVICES.EARN_LEND, chainId: vault.chainId, provider })
      .then((quote) => {
        if (!cancelled) setFeeQuote(quote)
      })
      .catch(() => {
        if (!cancelled) setFeeQuote({ failed: true, available: false, bps: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [vault.chainId, vaultNetwork.rpcUrl])

  useEffect(() => {
    restoreFocusRef.current = document.activeElement
    sheetRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus?.()
    }
  }, [onClose])

  const decimals = vault.asset.decimals
  const symbol = vault.asset.symbol
  const hasPosition = (userState?.shares ?? 0n) > 0n

  const amount = useMemo(() => {
    const trimmed = amountText.trim()
    if (!trimmed) return null
    try {
      return parseUnits(trimmed, decimals)
    } catch {
      return undefined // unparseable — distinct from empty
    }
  }, [amountText, decimals])

  const maxAmount =
    mode === 'deposit' ? userState?.walletBalance ?? null : userState?.maxWithdrawAssets ?? null

  const setMax = () => {
    if (maxAmount == null) return
    setAmountText(formatUnits(maxAmount, decimals))
    setInputError(null)
  }

  const validate = () => {
    if (amount === undefined) return { ok: false, reason: 'Enter a valid number.' }
    return mode === 'deposit'
      ? validateDepositAmount({
          amount,
          walletBalance: userState?.walletBalance ?? null,
          maxDepositAssets: userState?.maxDepositAssets ?? null,
        })
      : validateWithdrawAmount({ amount, maxWithdrawAssets: userState?.maxWithdrawAssets ?? null })
  }

  // The fee applies only to deposits, only when the router quotes a nonzero
  // live rate. `feeBlocked` = we KNOW a router exists but couldn't read the
  // rate — never proceed on a rate we can't stand behind (FR-015).
  const feeApplies = mode === 'deposit' && Boolean(feeQuote?.available && feeQuote.bps > 0)
  const feeBlocked = mode === 'deposit' && Boolean(feeQuote?.failed)
  const feeSplit = feeApplies && amount != null && amount > 0n ? splitFee(amount, feeQuote.bps) : null

  const submit = async () => {
    const check = validate()
    if (!check.ok) {
      setInputError(check.reason)
      return
    }
    setInputError(null)
    if (feeBlocked) {
      setTxState({
        step: 'error',
        txUrl: null,
        error:
          'The platform fee rate could not be confirmed right now, so deposits are paused. Nothing was moved — please try again shortly.',
      })
      return
    }
    // Never a silent no-op (constitution III): sessions that can't transact
    // on this vault's network see the reason instead of a dead tap.
    if (!address || !canTransact) {
      setTxState({
        step: 'error',
        txUrl: null,
        error: !address
          ? 'This session cannot send transactions right now — please reconnect and try again.'
          : cannotTransactReason(vault.chainId),
      })
      return
    }

    try {
      // Reads (allowance check, dry-runs) go over the VAULT's chain read
      // provider — independent of the wallet's active network.
      const provider = makeReadProvider(vaultNetwork.rpcUrl, vault.chainId)
      let calls
      let message
      let busyStep
      if (mode === 'deposit') {
        const built = await buildDepositCalls({
          vault,
          account: address,
          amount,
          provider,
          feeQuote: feeApplies ? feeQuote : null,
        })
        calls = built.calls
        busyStep = built.requiresApproval ? 'approving' : 'confirming'
        message = `Deposited ${fmt(amount, decimals, symbol)} into ${vault.name}`
      } else {
        // A full withdrawal redeems all shares so no dust strands.
        const isFullExit =
          userState?.maxWithdrawAssets != null && amount === userState.maxWithdrawAssets &&
          userState?.shares != null
        const built = await buildWithdrawCalls({
          vault,
          account: address,
          amount,
          redeemAllShares: isFullExit ? userState.shares : null,
          provider,
        })
        calls = built.calls
        busyStep = 'confirming'
        message = `Withdrew ${fmt(amount, decimals, symbol)} from ${vault.name}`
      }

      // Network selection is managed for the member: if the wallet is on a
      // different network, sendOnChain switches to the vault's network first
      // (no separate in-app confirmation step), then submits. One passkey
      // ceremony covers the whole batch; classic wallets prompt per call.
      setTxState({ step: busyStep, txUrl: null, error: null })
      const sent = await sendOnChain(vault.chainId, calls, {
        onState: ({ step }) => {
          if (step === 'switching') setTxState({ step: 'switching', txUrl: null, error: null })
          if (step === 'sending') setTxState({ step: busyStep, txUrl: null, error: null })
        },
      })
      if (sent?.state === 'failed') {
        throw new Error(sent.reason || 'transaction failed')
      }
      const txHash = sent?.txHash ?? sent?.userOpHash ?? null
      if (!txHash) throw new Error('Submitted, but no transaction reference was returned.')
      // Explorer links only for real tx hashes — a UserOp hash is not a page
      // on the block explorer.
      const txUrl = sent?.txHash ? getBlockscoutUrl(vault.chainId, sent.txHash, 'tx') : null
      queueEarnAction(address, vault.chainId, {
        type: mode === 'deposit' ? 'earn-deposit' : 'earn-withdraw',
        refId: vault.address,
        message,
        txHash,
        txUrl,
        at: Date.now(),
      })
      // Durable audit entry in the unified activity ledger (spec 051),
      // scoped to the VAULT's chain (network-transparent flows).
      captureEarnAction(address, vault.chainId, {
        type: mode === 'deposit' ? 'earn-deposit' : 'earn-withdraw',
        txHash,
        at: Date.now(),
        vaultAddress: vault.address,
        amountRaw: amount?.toString?.() ?? String(amount),
        tokenAddress: vault.asset?.address ?? null,
        tokenSymbol: symbol,
        tokenDecimals: decimals,
        description: message,
      })
      activity?.refresh?.()
      setTxState({ step: 'done', txUrl, error: null })
      onActionComplete?.()
    } catch (err) {
      const rejected = /rejected|denied|cancelled|not allowed|abort/i.test(err?.message || '')
      setTxState({
        step: 'error',
        txUrl: null,
        error: rejected
          ? 'The confirmation was cancelled. Nothing was moved.'
          : err?.message && /switch|network/i.test(err.message)
            ? err.message
            : 'The transaction could not be completed. Nothing was moved — you can try again.',
      })
    }
  }

  const busy = txState.step === 'approving' || txState.step === 'confirming' || txState.step === 'switching'
  const titleId = 'earn-vault-sheet-title'

  // Spec 088 FR-001/FR-002 — every read and write in this sheet belongs to the CONNECTED
  // wallet (deposits/withdrawals go out on useEarnSend.sendOnChain, which signs with whatever
  // the wallet holds and switches networks on it directly — see the BridgeView template this
  // mirrors). So while the switcher shows a vault, a recovered, a hardware, or any other
  // non-personal account, the whole sheet is withheld with the reason, rather than left up with
  // the connected wallet's own balances shown under the acting account's name.
  if (isActingAccount) {
    return (
      <div className="asset-sheet-backdrop">
        <button type="button" className="asset-sheet-scrim" aria-label="Close vault details" onClick={onClose} />
        <div
          className="asset-sheet earn-vault-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          ref={sheetRef}
        >
          <div className="asset-sheet-grabber" aria-hidden="true" />
          <div className="asset-sheet-header">
            <div className="asset-sheet-heading">
              <h3 id={titleId}>{vault.name}</h3>
            </div>
            <button type="button" className="asset-sheet-close" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="earn-unavailable" role="note" data-testid="earn-vault-acting-refusal">
            {earnActingRefusal(actingAccount)}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="asset-sheet-backdrop">
      <button type="button" className="asset-sheet-scrim" aria-label="Close vault details" onClick={onClose} />
      <div
        className="asset-sheet earn-vault-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={sheetRef}
      >
        <div className="asset-sheet-grabber" aria-hidden="true" />
        <div className="asset-sheet-header">
          <div className="asset-sheet-heading">
            <h3 id={titleId}>{vault.name}</h3>
            <p className="earn-vault-sheet-meta">
              Deposits {symbol} · {formatApy(vault.netApy)} yearly rate
              <InfoTip label="What is APY?" className="earn-info">
                {EARN_TIPS.apy}
              </InfoTip>
            </p>
            <p className="earn-vault-sheet-meta">
              On {vaultNetwork?.name || 'its network'}
              {vault.curator ? ` · Managed by ${vault.curator}` : ''}
            </p>
          </div>
          <button type="button" className="asset-sheet-close" onClick={onClose}>
            Close
          </button>
        </div>

        {userState == null ? (
          <p className="earn-state">Loading your balances…</p>
        ) : txState.step === 'done' ? (
          <div className="earn-tx-done" role="status">
            <p>
              {mode === 'deposit' ? 'Deposit complete.' : 'Withdrawal complete.'} Your balances
              update in a moment.
            </p>
            {txState.txUrl && (
              <a href={txState.txUrl} target="_blank" rel="noopener noreferrer">
                View transaction ↗
              </a>
            )}
            <button type="button" className="earn-btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <div className="earn-mode-tabs" role="tablist" aria-label="Deposit or withdraw">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'deposit'}
                className={`earn-mode-tab ${mode === 'deposit' ? 'active' : ''}`}
                onClick={() => {
                  setMode('deposit')
                  setAmountText('')
                  setInputError(null)
                }}
              >
                Deposit
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'withdraw'}
                className={`earn-mode-tab ${mode === 'withdraw' ? 'active' : ''}`}
                disabled={!hasPosition}
                title={hasPosition ? undefined : 'You have nothing in this vault yet'}
                onClick={() => {
                  setMode('withdraw')
                  setAmountText('')
                  setInputError(null)
                }}
              >
                Withdraw
              </button>
            </div>

            <dl className="earn-vault-sheet-facts">
              {mode === 'deposit' ? (
                <>
                  <div>
                    <dt>In your wallet</dt>
                    <dd>{fmt(userState.walletBalance, decimals, symbol)}</dd>
                  </div>
                  {hasPosition && (
                    <div>
                      <dt>Already in this vault</dt>
                      <dd>{fmt(userState.assets, decimals, symbol)}</dd>
                    </div>
                  )}
                  {feeApplies && (
                    <>
                      <div>
                        <dt>
                          FairWins platform fee ({bpsToPercent(feeQuote.bps)})
                          <InfoTip label="About the platform fee" className="earn-info">
                            {EARN_TIPS.platformFee}
                          </InfoTip>
                        </dt>
                        <dd>{feeSplit ? fmt(feeSplit.feeAmount, decimals, symbol) : '—'}</dd>
                      </div>
                      <div>
                        <dt>Goes into the vault</dt>
                        <dd>{feeSplit ? fmt(feeSplit.netAmount, decimals, symbol) : '—'}</dd>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  <div>
                    <dt>In this vault</dt>
                    <dd>{fmt(userState.assets, decimals, symbol)}</dd>
                  </div>
                  <div>
                    <dt>
                      Available to withdraw now
                      <InfoTip label="Why can availability differ?" className="earn-info">
                        {EARN_TIPS.withdrawalLiquidity}
                      </InfoTip>
                    </dt>
                    <dd>{fmt(userState.maxWithdrawAssets, decimals, symbol)}</dd>
                  </div>
                </>
              )}
            </dl>

            <div className="earn-amount-row">
              <label htmlFor="earn-amount">Amount ({symbol})</label>
              <div className="earn-amount-input">
                <input
                  id="earn-amount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amountText}
                  disabled={busy}
                  onChange={(e) => {
                    setAmountText(e.target.value)
                    setInputError(null)
                  }}
                />
                <button type="button" className="earn-btn secondary" onClick={setMax} disabled={busy || maxAmount == null}>
                  Max
                </button>
              </div>
              {inputError && (
                <p className="earn-input-error" role="alert">
                  {inputError}
                </p>
              )}
            </div>

            {mode === 'deposit' && (
              <p className="earn-summary">
                Your {symbol} moves from your wallet into this vault and starts earning. You can
                withdraw it whenever you like.{' '}
                {isPasskey
                  ? 'One passkey confirmation covers the whole deposit — including the spending permission on a first deposit.'
                  : 'A first deposit asks for two quick wallet confirmations.'}
                <InfoTip label="About the spending permission" className="earn-info">
                  {EARN_TIPS.approval}
                </InfoTip>
              </p>
            )}
            {mode === 'withdraw' && (
              <p className="earn-summary">
                Your {symbol}, including what it has earned, moves from the vault back to your
                wallet.
              </p>
            )}

            {txState.step === 'error' && (
              <p className="earn-input-error" role="alert">
                {txState.error}
              </p>
            )}

            {/* The live rate could not be read while a fee router exists on
                this network — pause deposits rather than risk showing a rate
                lower than what would be charged (spec 060, FR-015). */}
            {feeBlocked && (
              <p className="earn-input-error" role="alert">
                The platform fee rate could not be confirmed right now, so deposits are paused.
                Withdrawals are unaffected — please try again shortly.
              </p>
            )}

            {/* Sessions that can't transact on this vault's network get the
                reason up front instead of a doomed submit (constitution III). */}
            {!canTransact && (
              <p className="earn-summary" role="note">
                {cannotTransactReason(vault.chainId)}
              </p>
            )}
            <button
              type="button"
              className="earn-btn primary earn-submit"
              onClick={submit}
              disabled={busy || !canTransact || (mode === 'deposit' && (feeQuote == null || feeBlocked))}
              title={canTransact ? undefined : cannotTransactReason(vault.chainId)}
            >
              {txState.step === 'switching'
                ? `Switching to ${vaultNetwork?.name || 'the vault network'}…`
                : txState.step === 'approving'
                  ? isPasskey
                    ? 'Confirm with your passkey…'
                    : 'Approve, then confirm the deposit…'
                  : txState.step === 'confirming'
                    ? isPasskey
                      ? 'Confirm with your passkey…'
                      : 'Waiting for confirmation…'
                    : mode === 'deposit'
                      ? `Deposit ${symbol}`
                      : `Withdraw ${symbol}`}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
