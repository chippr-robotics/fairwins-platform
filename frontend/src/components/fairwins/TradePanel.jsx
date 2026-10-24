import { useState, useEffect, useCallback, useMemo } from 'react'
import { parseUnits } from '../../lib/evm/units'
import { useSwitchChain } from 'wagmi'
import { useDex } from '../../hooks/useDex'
import {
  SLIPPAGE_OPTIONS,
  PRICE_TYPES,
  SPOT_ORDER_TYPES,
  PERPS_ORDER_TYPES,
  getPerpsVenue,
  getExplorerUrl,
} from '../../constants/dex'
import { NETWORKS } from '../../config/networks'
import { feeTierLabel } from '../../lib/uniswap/trade'
import {
  buildSwapOptions,
  counterpartFor,
  defaultPairForChain,
  findSwapOption,
  findSwapOptionByAddress,
  getSwapAddresses,
  getSwapVenue,
  isSwapChain,
} from '../../lib/uniswap/swapUniverse'
import { PIN_MODE, createPin, samePair } from '../../lib/assets/networkPin'
import { useWallet } from '../../hooks'
import { useActiveAccount } from '../../hooks/useActiveAccount'
import { useSwapBalances } from '../../hooks/useSwapBalances'
import SensitiveValue from '../common/SensitiveValue'
import InfoTip from '../ui/InfoTip'
import { formatDecimalForDisplay } from '../../lib/format/amount'
import TradeTokenSelect from './TradeTokenSelect'
import TokenNewsCard from '../news/TokenNewsCard'
import { isFeatureEnabled } from '../../config/tenant'
import './TradePanel.css'

// Price impact bands used to color the trade summary, mirroring the thresholds
// mainstream V3 clients use to warn a trader.
const IMPACT_WARN = 1 // %
const IMPACT_HIGH = 3 // %

function impactSeverity(pct) {
  if (pct == null) return 'unknown'
  if (pct >= IMPACT_HIGH) return 'high'
  if (pct >= IMPACT_WARN) return 'warn'
  return 'low'
}

// Quote figures only (minimum received / limit floor), NOT balances: a slippage floor is shown
// to more digits than a balance would be, and the summary only renders once a quote exists, so
// `value` is never an unread balance here. Balances go through `formatDecimalForDisplay` below.
const fmtQuoteAmount = (value) =>
  Number(value || 0).toLocaleString(undefined, { maximumSignificantDigits: 8 })

/**
 * TradePanel — the brokerage-style order ticket, MULTI-NETWORK.
 *
 * Pairs are listed from EVERY swap-capable network, not just the connected one
 * (`lib/uniswap/swapUniverse.js`), because seeing what is tradeable is a read:
 * quotes come from each chain's own QuoterV2 over that chain's provider, exactly
 * as the portfolio reads balances across chains. What still belongs to ONE
 * network is the pair itself and the order:
 *
 *   1. A V3 pool lives on a single chain, so choosing the first leg PINS the
 *      network and the second selector only offers legs from that same chain
 *      (`lib/assets/networkPin.js#samePair` — the shared pair rule, never the
 *      bridge's `bridgeDest`). Moving value between networks is the Bridge's job.
 *   2. The swap is a WRITE against that chain's router, so when the pair's
 *      network is not the wallet's, the ticket asks for the switch FIRST and
 *      refuses to place the order until it happens (DexContext.swap re-checks,
 *      so a mis-wired UI cannot approve a foreign address either).
 *
 * Balances follow the PAIR's network, not the wallet's (`useSwapBalances`), and
 * live on the pay/receive cards where the amount is actually entered.
 *
 * The ticket does NOT pick the account. Which account a member acts as —
 * personal wallet, a multisig vault, or a recovered legacy account — is chosen
 * once, app-wide, from the wallet menu's acting-account switcher
 * (`hooks/useAccountSwitcher.js`), exactly as Pay/Transfer and every other
 * surface do it. Trade only READS that identity (`useActiveAccount`) so it can
 * price, fund, and disclose the order honestly.
 */
function TradePanel() {
  const {
    loading,
    quotingPrice,
    swap,
    getBestQuoteOn,
    slippage,
    setSlippage,
    dexProvider,
    network,
    tradingAddress,
  } = useDex()

  const { isConnected, chainId, loginMethod } = useWallet()
  const { switchChainAsync, isPending: switching } = useSwitchChain()

  // The acting account (spec 043 + 062), read-only here: the personal wallet, one
  // of the member's saved multisig vaults, or a recovered legacy account. A vault
  // turns every order into a threshold-gated proposal; a recovered account signs
  // each order with its unlocked in-memory key. Balances always follow it.
  const { identity, isVault, isLegacy } = useActiveAccount()

  // Every pair leg on every swap-capable network, connected network first.
  const options = useMemo(() => buildSwapOptions({ connectedChainId: chainId }), [chainId])
  // The opening pair: this network's wrapped-native → stablecoin when it can
  // trade, otherwise the first network that can — a member on a chain without a
  // DEX still gets a usable ticket instead of a dead end.
  const initialPair = useMemo(
    () => defaultPairForChain(options, chainId) || defaultPairForChain(options, options[0]?.chainId),
    [options, chainId],
  )

  const [fromKey, setFromKey] = useState(() => initialPair?.from.key ?? null)
  const [toKey, setToKey] = useState(() => initialPair?.to.key ?? null)
  const [orderType, setOrderType] = useState('sell')
  const [priceType, setPriceType] = useState('market')
  const [limitPrice, setLimitPrice] = useState('')
  const [amount, setAmount] = useState('')
  const [quote, setQuote] = useState(null)
  const [rateInverted, setRateInverted] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  let fromToken = findSwapOption(options, fromKey)
  let toToken = findSwapOption(options, toKey)
  // A selection can only vanish when the option list itself shrinks (leaving the
  // testnet whose legs it used). Re-seed during render — React's endorsed
  // adjust-state-on-props-change pattern — so we never quote a leg that no longer
  // exists. A deliberate cross-chain pick is otherwise NEVER reseeded: switching
  // the wallet's network must not silently repoint the member's pair.
  if (options.length > 0 && (!fromToken || !toToken) && initialPair) {
    setFromKey(initialPair.from.key)
    setToKey(initialPair.to.key)
    fromToken = initialPair.from
    toToken = initialPair.to
  }

  // The pair's network — the one that quotes, holds the balances, and must be the
  // wallet's network before an order can be placed.
  const pairChainId = Number(fromToken?.chainId ?? toToken?.chainId ?? chainId)
  const pairNetwork =
    pairChainId === Number(chainId) ? network || NETWORKS[pairChainId] : NETWORKS[pairChainId]
  const pairAddresses = getSwapAddresses(pairChainId)
  const pairNetworkName = pairNetwork?.name || 'this network'
  const walletNetworkName = NETWORKS[Number(chainId)]?.name || 'another network'
  const needsSwitch = Boolean(fromToken) && pairChainId !== Number(chainId)

  // Second-leg eligibility: one network per pair (FR-062's rule, shared with the
  // liquidity pair selector), minus the leg already chosen.
  const pin = useMemo(() => createPin(fromToken, PIN_MODE.SAME_NETWORK), [fromToken])
  const receiveOptions = useMemo(
    () => options.filter((o) => samePair(o, pin) && o.key !== fromToken?.key),
    [options, pin, fromToken],
  )

  // Leg balances come from the PAIR's network over its own read provider — the
  // connected chain's DexContext balances would be the wrong account's funds on
  // the wrong chain the moment a member picks a pair elsewhere.
  const legTokens = useMemo(
    () => [fromToken, toToken].filter(Boolean).map((o) => ({ address: o.address, decimals: o.decimals })),
    [fromToken, toToken],
  )
  const { balances: legBalances, refresh: refreshLegBalances } = useSwapBalances({
    chainId: pairChainId,
    address: tradingAddress,
    tokens: legTokens,
  })
  const balanceFor = useCallback(
    (token) => (token ? legBalances[token.address.toLowerCase()] : undefined),
    [legBalances],
  )
  // Honest-state: an unread balance shows as "…", never as 0 — nobody should be
  // told they hold nothing because a read failed.
  const renderBalance = (token) => {
    const value = balanceFor(token)
    return value == null ? (
      <span className="trade-balance-pending" aria-label="balance loading">…</span>
    ) : (
      <SensitiveValue>{formatDecimalForDisplay(value) ?? '—'}</SensitiveValue>
    )
  }

  // Session rails: passkey accounts transact through their smart account —
  // gasless (FairWins-sponsored) where the PAIR's network has a sponsor
  // paymaster (spec 050), self-funded otherwise. Classic wallets pay network fees.
  const isPasskey = loginMethod === 'passkey'
  const passkeyReady = !isPasskey || Boolean(pairNetwork?.passkey)
  const passkeySponsored = isPasskey && Boolean(pairNetwork?.passkey?.sponsorPaymasterUrl)

  // Perpetuals order types only exist where the pair's network has a perps venue.
  // No supported network configures one yet, so these stay off — honest-state.
  const perpsVenue = getPerpsVenue(pairNetwork)

  // DEX identity follows the PAIR's network (ETC family → ETCswap; else Uniswap),
  // so an ETC pair is never labelled as routing through Uniswap.
  const venue = getSwapVenue(pairChainId) || dexProvider
  const providerName = venue?.name || 'the DEX'
  const providerUrl = venue?.url || null
  // The trading engine is the Uniswap V3 protocol on every supported chain
  // (ETCswap is a V3 deployment). Name the chain's DEX first, then note the
  // protocol underneath — a subtle acknowledgement of the DeFi tool inside.
  const isUniswap = /uniswap/i.test(providerName)
  const poweredBy = isUniswap
    ? 'Powered by Uniswap v3'
    : `Powered by ${providerName} · Uniswap v3 protocol`

  const pairNativeSymbol = pairNetwork?.nativeCurrency?.symbol || ''
  const wnativeSymbol = pairNativeSymbol ? `W${pairNativeSymbol}` : 'WNATIVE'
  const pairStableSymbol = pairNetwork?.stablecoin?.symbol || 'the stablecoin'

  const symbolOf = (token) => token?.symbol || '—'
  const isPerpsOrder = orderType === 'sell_short' || orderType === 'buy_to_cover'

  // Live quoting — debounced, against the PAIR's network.
  useEffect(() => {
    if (!amount || parseFloat(amount) <= 0) {
      setQuote(null)
      return
    }

    if (!fromToken || !toToken || fromToken.key === toToken.key || isPerpsOrder) {
      setQuote(null)
      return
    }

    let cancelled = false
    const fromAddress = fromToken.address
    const toAddress = toToken.address
    const timeoutId = setTimeout(async () => {
      try {
        const result = await getBestQuoteOn(pairChainId, fromAddress, toAddress, amount)
        if (!cancelled) {
          setQuote(result)
          setError('')
        }
      } catch (err) {
        if (!cancelled) {
          setQuote(null)
          setError(err.message || 'Unable to price this trade')
        }
      }
    }, 450)

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [amount, fromToken, toToken, pairChainId, isPerpsOrder, getBestQuoteOn])

  // Spot order type maps onto the pair direction relative to cash: paying the
  // network's stablecoin to receive an asset is a Buy; paying an asset for the
  // stablecoin is a Sell. Asset-for-asset pairs leave the order type unchanged.
  const deriveOrderType = (from, to) => {
    const stable = getSwapAddresses(from?.chainId ?? to?.chainId)?.stablecoin
    if (!stable) return null
    const isStable = (token) =>
      Boolean(token) && token.address.toLowerCase() === stable.toLowerCase()
    if (isStable(to) && !isStable(from)) return 'sell'
    if (isStable(from) && !isStable(to)) return 'buy'
    return null
  }

  const handleOrderTypeChange = (next) => {
    setOrderType(next)
    setQuote(null)
    setError('')
    setSuccess('')
    if (next !== 'buy' && next !== 'sell') return
    // Buy/Sell re-seed the pair on the network already in play, never a different one.
    const wnative = findSwapOptionByAddress(options, pairChainId, pairAddresses?.wnative)
    const stable = findSwapOptionByAddress(options, pairChainId, pairAddresses?.stablecoin)
    if (!wnative || !stable) return
    setFromKey(next === 'buy' ? stable.key : wnative.key)
    setToKey(next === 'buy' ? wnative.key : stable.key)
  }

  const handleSellLegChange = (option) => {
    setFromKey(option.key)
    // The pin moved: keep the receive leg when it is still on this network,
    // otherwise take that network's stablecoin so the ticket stays quotable.
    const counterpart = counterpartFor(options, option.chainId, option, toToken)
    setToKey(counterpart?.key ?? null)
    const derived = deriveOrderType(option, counterpart)
    if (derived) setOrderType(derived)
    setQuote(null)
    setError('')
    setSuccess('')
  }

  const handleBuyLegChange = (option) => {
    setToKey(option.key)
    const derived = deriveOrderType(fromToken, option)
    if (derived) setOrderType(derived)
    setQuote(null)
    setError('')
  }

  const handleFlipTokens = () => {
    const derived = deriveOrderType(toToken, fromToken)
    setFromKey(toToken?.key ?? null)
    setToKey(fromToken?.key ?? null)
    if (derived) setOrderType(derived)
    setAmount('')
    setQuote(null)
    setError('')
  }

  const handleSwitchNetwork = async () => {
    setError('')
    try {
      if (typeof switchChainAsync !== 'function') {
        throw new Error('This wallet cannot switch networks from the app.')
      }
      await switchChainAsync({ chainId: pairChainId })
    } catch (err) {
      setError(err?.shortMessage || err?.message || `Could not switch to ${pairNetworkName}.`)
    }
  }

  // A Limit order's floor: limit price (output per 1 unit paid) × quantity,
  // enforced on-chain as the swap's minimum received.
  const outDecimals = toToken?.decimals ?? 18
  const limitFloor = useMemo(() => {
    if (priceType !== 'limit') return null
    const qty = parseFloat(amount)
    const px = parseFloat(limitPrice)
    if (!Number.isFinite(qty) || !Number.isFinite(px) || qty <= 0 || px <= 0) return null
    const text = (qty * px).toFixed(outDecimals)
    try {
      return { wei: parseUnits(text, outDecimals), text }
    } catch {
      return null
    }
  }, [priceType, amount, limitPrice, outDecimals])

  const handleExecute = async () => {
    setError('')
    setSuccess('')

    if (!amount || parseFloat(amount) <= 0) {
      setError('Enter an amount to trade')
      return
    }
    if (priceType === 'limit' && !limitFloor) {
      setError('Enter a limit price to place a limit order')
      return
    }

    try {
      const proposedNote = `Proposed to ${identity.label || 'the multisig'} — owners approve before it executes.`
      // The pair's network rides along so the DEX layer refuses an order aimed at
      // a chain the wallet is not on, whatever the UI believes.
      const opts = { chainId: pairChainId }
      if (priceType === 'limit') opts.limitMinOutWei = limitFloor.wei
      const res = await swap(fromToken.address, toToken.address, amount, opts)
      setSuccess(
        res?.proposed
          ? proposedNote
          : `Swapped ${amount} ${symbolOf(fromToken)} → ${symbolOf(toToken)} on ${pairNetworkName}`,
      )
      setAmount('')
      setQuote(null)
      refreshLegBalances()
    } catch (err) {
      console.error('Trade error:', err)
      setError(err.message || 'Transaction failed')
    }
  }

  const handleSetMax = () => {
    const available = balanceFor(fromToken)
    if (available == null) return
    setAmount(available)
  }

  if (!isConnected) {
    return (
      <div className="trade-panel">
        <div className="trade-header">
          <h2>Trade</h2>
          <p className="trade-subtitle">Trade across every supported network</p>
        </div>
        <div className="trade-empty">
          <p>Connect your wallet to start trading.</p>
        </div>
      </div>
    )
  }

  // The only true dead end left: no supported network has a DEX deployment at
  // all. A DEX-less CONNECTED chain is no longer a dead end — pairs from other
  // networks are listed, and the ticket asks for the switch when one is picked.
  if (options.length === 0) {
    return (
      <div className="trade-panel">
        <div className="trade-header">
          <h2>Trade</h2>
          <p className="trade-subtitle">Trading is unavailable</p>
        </div>
        <div className="trade-empty">
          <p>
            {dexProvider
              ? `${dexProvider.name} is not configured on any supported network in this build, so there are no pairs to trade in-app.`
              : 'No DEX is configured on any supported network in this build, so there are no pairs to trade in-app.'}
          </p>
        </div>
      </div>
    )
  }

  const receiveValue = quotingPrice
    ? '…'
    : quote?.amountOut
      ? Number(quote.amountOut).toLocaleString(undefined, { maximumSignificantDigits: 8 })
      : '0.0'

  const severity = impactSeverity(quote?.priceImpactPercent)
  // A vault is a contract on ONE network; it cannot sign for a pair elsewhere.
  const vaultChainId = isVault && identity?.chainId != null ? Number(identity.chainId) : null
  const vaultOffNetwork = vaultChainId != null && vaultChainId !== pairChainId
  const canExecute =
    !loading &&
    !needsSwitch &&
    !vaultOffNetwork &&
    // A recovered account signs with its own EOA key, not the passkey rail, so
    // passkey readiness doesn't gate it.
    (passkeyReady || isLegacy) &&
    !isPerpsOrder &&
    amount &&
    parseFloat(amount) > 0 &&
    Boolean(quote) &&
    (priceType !== 'limit' || Boolean(limitFloor))

  const rateLabel =
    quote && !rateInverted
      ? `1 ${quote.tokenInSymbol} = ${quote.executionPrice} ${quote.tokenOutSymbol}`
      : quote
        ? `1 ${quote.tokenOutSymbol} = ${quote.executionPriceInverted} ${quote.tokenInSymbol}`
        : null

  const feeBadge = isVault
    ? { className: 'trade-badge-proposal', text: 'Multisig proposal' }
    : isLegacy
      ? { className: 'trade-badge-fee', text: 'Network fee applies' }
      : passkeySponsored
        ? { className: 'trade-badge-gasless', text: '⚡ Gasless · sponsored' }
        : { className: 'trade-badge-fee', text: 'Network fee applies' }

  return (
    <div className="trade-panel">
      <div className="trade-header">
        <div className="trade-title-row">
          <h2>Trade</h2>
          <div className="trade-title-tags">
            {/* The rail this order takes — sponsored, member-paid, or a multisig
                proposal. Stated up front, before any amount is entered. */}
            <span className={`trade-badge ${feeBadge.className}`}>{feeBadge.text}</span>
            <span className="trade-venue" title={`Routing via ${providerName} on ${pairNetworkName}`}>
              {providerName}
            </span>
          </div>
        </div>
        {/* No subtitle. It claimed "best execution" — a phrase with a regulatory meaning nobody
            here is measuring — and then restated the venue badge beside it, which names the
            provider on the ticket and again on the pair. Which network a pair trades on is on the
            pair itself, and the switch notice below says so when it matters. */}
      </div>

      {/* What the member needs to know about THIS order before placing it. The
          account itself is switched app-wide from the wallet menu, so the ticket
          states the consequences of the current one rather than re-offering the
          choice. */}
      {isLegacy && (
        <p className="trade-note" role="note">
          Orders sign with your recovered account&apos;s key on {pairNetworkName}. You pay the
          network fee — recovered accounts aren&apos;t gasless.
        </p>
      )}
      {isVault && (
        <p className="trade-note">
          Orders from this account are proposed to the multisig and execute once enough
          owners approve.
        </p>
      )}
      {vaultOffNetwork && (
        <p className="trade-note" role="note">
          This multisig lives on {NETWORKS[vaultChainId]?.name || 'another network'}, so it
          can&apos;t trade the {pairNetworkName} pair you picked. Choose a pair on{' '}
          {NETWORKS[vaultChainId]?.name || 'its network'}, or switch accounts from your
          wallet menu.
        </p>
      )}
      {!passkeyReady && !isLegacy && (
        <p className="trade-note" role="note">
          Passkey accounts can’t send transactions on {pairNetworkName} yet — connect a
          browser wallet to trade this pair.
        </p>
      )}
      {/* A fact about the member's OWN network, stated whether or not a switch
          is also pending — "your network can't trade" and "this pair is
          elsewhere" are two different things to know. `isSwapChain` is the same
          gate the option list is built from, so the note can never contradict it. */}
      {!isSwapChain(chainId) && (
        <p className="trade-note" role="note">
          {walletNetworkName} has no DEX deployment, so its own pairs aren’t tradeable —
          the pairs listed below are on other networks.
        </p>
      )}

      {/* Order ticket controls — order type + price type share a row, with the
          limit price / term beneath (brokerage-style). */}
      <div className="trade-order-grid">
        <div className="trade-field">
          <span className="trade-field-label">
            <label htmlFor="trade-order-type">Order Type</label>
            <InfoTip label="About order types" className="trade-info">
              Buy receives {wnativeSymbol} for {pairStableSymbol}; Sell does the reverse.
              Both stay on {pairNetworkName} — the network of the pair you picked.
              Sell Short and Buy to Cover appear on networks with a perpetuals venue —
              {perpsVenue ? ` ${perpsVenue.name} on this network.` : ' none of the supported networks has one yet.'}
            </InfoTip>
          </span>
          <select
            id="trade-order-type"
            className="trade-field-select"
            value={orderType}
            onChange={(e) => handleOrderTypeChange(e.target.value)}
          >
            {SPOT_ORDER_TYPES.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {perpsVenue &&
              PERPS_ORDER_TYPES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
          </select>
        </div>

        <div className="trade-field">
          <span className="trade-field-label">
            <label htmlFor="trade-price-type">Price Type</label>
            <InfoTip label="About price types" className="trade-info">
              Market fills at the best routed price within your slippage tolerance.
              Limit fills at your price or better, or not at all — orders don’t rest
              on a book.
            </InfoTip>
          </span>
          <select
            id="trade-price-type"
            className="trade-field-select"
            value={priceType}
            onChange={(e) => {
              setPriceType(e.target.value)
              setError('')
            }}
          >
            {PRICE_TYPES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        {priceType === 'limit' && (
          <div className="trade-field">
            <label className="trade-field-label" htmlFor="trade-limit-price">
              Limit Price ({symbolOf(toToken)} per {symbolOf(fromToken)})
            </label>
            <input
              id="trade-limit-price"
              className="trade-field-input"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.000001"
              placeholder="0.0"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
            />
          </div>
        )}

        <div className="trade-field">
          <span className="trade-field-label">Term</span>
          <span className="trade-field-static">
            {priceType === 'limit' ? 'Fill at limit or cancel' : 'Immediate'}
          </span>
        </div>
      </div>

      {isPerpsOrder && (
        <div className="trade-message trade-error" role="alert">
          {perpsVenue
            ? `${orderType === 'sell_short' ? 'Sell Short' : 'Buy to Cover'} orders route to ${perpsVenue.name}, which isn’t wired into in-app execution yet.`
            : `Short selling needs a perpetuals venue, and ${pairNetworkName} doesn’t have one yet.`}
        </div>
      )}

      <div className="trade-ticket">
        {/* Pay leg */}
        <div className="trade-leg">
          <div className="trade-leg-top">
            <label htmlFor="trade-amount">You pay</label>
            <span className="trade-balance">Balance: {renderBalance(fromToken)}</span>
          </div>
          <div className="trade-leg-body">
            <input
              id="trade-amount"
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              step="0.000001"
              min="0"
              inputMode="decimal"
              className="trade-amount-input"
            />
            <TradeTokenSelect
              ariaLabel="Token to sell"
              options={options}
              value={fromKey}
              onChange={handleSellLegChange}
            />
            <button
              type="button"
              onClick={handleSetMax}
              className="trade-max-btn"
              disabled={balanceFor(fromToken) == null}
            >
              MAX
            </button>
          </div>
          <p className="trade-leg-network">{fromToken?.networkName || pairNetworkName}</p>
        </div>

        <div className="trade-switch-row">
          <button
            type="button"
            onClick={handleFlipTokens}
            className="trade-switch-btn"
            aria-label="Switch direction"
          >
            ↓↑
          </button>
        </div>

        {/* Receive leg — pinned to the pay leg's network (one pool, one chain). */}
        <div className="trade-leg">
          <div className="trade-leg-top">
            <label>You receive</label>
            <span className="trade-balance">Balance: {renderBalance(toToken)}</span>
          </div>
          <div className="trade-leg-body">
            <div className="trade-receive-value" aria-live="polite">
              <SensitiveValue>{receiveValue}</SensitiveValue>
            </div>
            <TradeTokenSelect
              ariaLabel="Token to buy"
              options={receiveOptions}
              value={toKey}
              onChange={handleBuyLegChange}
              emptyLabel="Select"
            />
          </div>
          <p className="trade-leg-network">
            {receiveOptions.length === 0
              ? `No other token trades against ${symbolOf(fromToken)} on ${pairNetworkName}.`
              : `On ${pairNetworkName} — a pair lives on one network.`}
          </p>
        </div>
      </div>

      {/* Token news (spec 109 US2) — below the amount entry, ADVISORY ONLY: no news state gates,
          delays or alters the swap form, quoting or submission (FR-006). One card per leg, so a
          pair with one covered and one uncovered token renders labelled partial coverage rather
          than a silently completed feed. */}
      {isFeatureEnabled('news') && (fromToken || toToken) && (
        <div className="trade-news">
          {[fromToken, toToken].filter(Boolean).map((token) => (
            <TokenNewsCard
              key={`${token.chainId}:${token.address}`}
              chainId={Number(token.chainId)}
              address={token.address}
              assetLabel={token.symbol}
            />
          ))}
        </div>
      )}

      {/* Trade summary — the capital-markets read-out */}
      {quote && (
        <div className="trade-summary" role="group" aria-label="Trade details">
          <button
            type="button"
            className="trade-summary-row trade-rate"
            onClick={() => setRateInverted((v) => !v)}
            title="Tap to invert"
          >
            <span className="trade-summary-key">Rate</span>
            <span className="trade-summary-val">{rateLabel} ⇄</span>
          </button>
          <div className="trade-summary-row">
            <span className="trade-summary-key">Price impact</span>
            <span className={`trade-summary-val impact-${severity}`}>
              {quote.priceImpactPercent == null
                ? '—'
                : quote.priceImpactPercent < 0.01
                  ? '<0.01%'
                  : `${quote.priceImpactPercent.toFixed(2)}%`}
            </span>
          </div>
          <div className="trade-summary-row">
            <span className="trade-summary-key">
              Minimum received
              {priceType === 'limit' ? (
                <span className="trade-summary-note"> at your limit price</span>
              ) : (
                <span className="trade-summary-note"> after {(slippage / 100).toFixed(2)}% slippage</span>
              )}
            </span>
            <span className="trade-summary-val">
              <SensitiveValue>
                {priceType === 'limit' && limitFloor
                  ? fmtQuoteAmount(limitFloor.text)
                  : fmtQuoteAmount(quote.minimumReceived)}
              </SensitiveValue>{' '}
              {quote.tokenOutSymbol}
            </span>
          </div>
          <div className="trade-summary-row">
            <span className="trade-summary-key">Route</span>
            <span className="trade-summary-val trade-route">
              {quote.tokenInSymbol} → {quote.tokenOutSymbol}
              <span className="trade-route-fee">{feeTierLabel(quote.feeTier)} pool</span>
              <span className="trade-route-network">on {pairNetworkName}</span>
            </span>
          </div>
          {priceType !== 'limit' && (
            <div className="trade-summary-row trade-slippage">
              <label htmlFor="trade-slippage-select" className="trade-summary-key">
                Slippage tolerance
              </label>
              <select
                id="trade-slippage-select"
                value={slippage}
                onChange={(e) => setSlippage(parseInt(e.target.value))}
                className="trade-slippage-select"
              >
                {SLIPPAGE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {severity === 'high' && (
        <div className="trade-impact-warning" role="alert">
          High price impact — you may receive substantially less than the market rate.
        </div>
      )}

      {/* The pair's network is the wallet's network, or the order can't be placed.
          Disclosed before any signature, with the switch as the primary action. */}
      {needsSwitch ? (
        <>
          <p className="trade-switch-note" role="note">
            This pair trades on {pairNetworkName} and your wallet is on {walletNetworkName}.
            Switch networks to place the order — the price above is quoted from{' '}
            {pairNetworkName} liquidity either way.
          </p>
          <button
            type="button"
            onClick={handleSwitchNetwork}
            disabled={switching}
            className="trade-execute-btn"
          >
            {switching ? `Switching to ${pairNetworkName}…` : `Switch to ${pairNetworkName}`}
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={handleExecute}
          disabled={!canExecute}
          className="trade-execute-btn"
        >
          {loading
            ? 'Processing…'
            : quotingPrice
              ? 'Fetching best price…'
              : quote
                ? priceType === 'limit'
                  ? `Place limit order — ${symbolOf(fromToken)} for ${symbolOf(toToken)}`
                  : `Swap ${symbolOf(fromToken)} for ${symbolOf(toToken)}`
                : 'Enter an amount'}
        </button>
      )}

      {isPasskey && passkeyReady && !isVault && !isLegacy && (
        <p className="trade-session-note">
          One passkey confirmation covers the whole order — including the spending
          permission when it’s needed.
          {passkeySponsored ? ' FairWins sponsors the network fee.' : ''}
        </p>
      )}

      {error && (
        <div className="trade-message trade-error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="trade-message trade-success" role="status">
          {success}
        </div>
      )}

      <div className="trade-footer">
        <div className="trade-attribution" title={`${providerName} — Uniswap V3 protocol`}>
          <span className="trade-attribution-dot" aria-hidden="true" />
          {poweredBy} on {pairNetworkName}
        </div>
        <div className="trade-links">
          {pairAddresses?.swapRouter && (
            <a
              href={getExplorerUrl(pairChainId, pairAddresses.swapRouter, 'address')}
              target="_blank"
              rel="noopener noreferrer"
              className="trade-link"
            >
              {providerName} Router ↗
            </a>
          )}
          {providerUrl && (
            <a href={providerUrl} target="_blank" rel="noopener noreferrer" className="trade-link">
              Open {providerName} ↗
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

export default TradePanel
