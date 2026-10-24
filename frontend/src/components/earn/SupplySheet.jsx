/**
 * SupplySheet (spec 067, US2 — T095/T096/T097/T099/T103/T153) — supply to, add to, and
 * withdraw from ONE curated liquidity pool. Bottom sheet reusing the shared
 * `.asset-sheet-*` shell, in the same idiom as `VaultSheet` and `StakeSheet`.
 *
 * Writes go through `useEarnSend` → `WalletContext.sendCalls` (the unified spec-041 rail), so
 * a passkey session authorizes the whole approve+supply batch with one ceremony and a classic
 * wallet signs each step.
 *
 * ── FIVE THINGS THIS FILE EXISTS TO KEEP TRUE ────────────────────────────────────────────
 *
 * 1. THE FEE IS CHARGED ON CAPITAL ACTUALLY DEPLOYED, NOT ON WHAT THE MEMBER OFFERS.
 *    `LiquidityRouter._supply` quotes the fee AFTER the mint against the amounts Uniswap
 *    actually consumed; everything the pool did not take is refunded whole, with no fee on it.
 *    So the confirm step discloses the RATE and what it applies to, plus an explicit CEILING
 *    ("if the pool takes everything you entered…"). It never renders "fee = rate × amount you
 *    typed" as though that were the charge — that figure is too high whenever the pool's price
 *    ratio takes less than both legs, and promising it would be dishonest (FR-028).
 *
 * 2. BRIDGE-LP IS FEE-FREE AND DOES NOT GO THROUGH THE ROUTER. Across's `addLiquidity` has no
 *    recipient parameter, so routing it would make FairWins the owner of a position the member
 *    could never exit (research R3). Those deposits are a DIRECT member call to the HubPool,
 *    and they show NO fee line at all — not a line reading 0.00, which would imply a lever
 *    that does not exist. `liquidityFeeCopy` returns null for them, always, and this sheet
 *    never fetches a fee quote on that path.
 *
 * 3. THE PAIR SELECTOR USES `samePair`, NOT `bridgeDest` — the exact inverse of the Bridge
 *    surface. A Uniswap pair lives on ONE network (FR-062). Swapping the predicate fails
 *    silently: an impossible cross-network "pair" would assemble and reach the confirm step.
 *    `src/test/earn/SupplySheet.test.jsx` fails if it is swapped — keep that test.
 *
 * 4. THE SHEET IS NOT GATED ON THE WALLET'S ACTIVE CHAIN. Availability is per-POOL, and the
 *    network switch happens at SIGNING, disclosed before the signature (FR-059/FR-061, T153).
 *    A member holding assets on another network is never told to go and switch first.
 *
 * 5. WITHDRAWAL IS NEVER FEE-GATED AND ALWAYS WORKS. It carries no platform fee (FR-021/
 *    FR-030), it is unaffected by an unreadable fee rate, and it works on a RETIRED pool —
 *    retirement closes new deposits only, and the pool stays visible and withdrawable
 *    (FR-024). Where inventory cannot fill an exit in full, the member takes what is available
 *    now and is told plainly that the remainder can be withdrawn later (FR-022).
 *
 * 6. SCREENING REFUSES VALUE-IN ONLY, AND IT BITES AT SUBMISSION (FR-032/FR-033, T116/T154).
 *    The acting wallet is screened through `useAddressScreening` — the platform's one
 *    screening path — against the POOL's network, using that network's own read provider,
 *    because the wallet may still be on another chain until the signing-time switch. The
 *    verdict is read TWICE and for two different jobs: at display it holds back the step that
 *    leads to a signature, and inside `submitSupply` it is re-read PAST THE CACHE so a wallet
 *    deny-listed since the sheet opened is refused before anything is signed. It never touches
 *    `submitWithdraw`: a restricted member keeps the exit, in full, always — point 5 is not
 *    conditional on screening. Note the BRIDGE-LP supply is a direct HubPool call with no
 *    FairWins contract in it, so this client-side screen is the only screen on that path.
 *    A verdict of `uncertain` blocks nothing AND says nothing: the pools here are a CURATED
 *    list of protocol contracts, not counterparties a member picks, so "we could not screen
 *    this network" is not a fact about the deposit in front of them. It used to be shown, and
 *    it read as a warning about a swap that carries no counterparty risk to warn about. What
 *    is NOT conditional is the refusal — a listed wallet is still refused, at display and
 *    again past the cache at submission.
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 * ── PROPS ────────────────────────────────────────────────────────────────────────────────
 *   pool           the pool this sheet opened for (required). Shape = `normalizePool` output
 *                  (`poolId, kind, enabled, feeTier, token0, token1, poolAddress,
 *                  maxDeposit0PerTx, maxDeposit1PerTx`) enriched for display with:
 *                  `chainId, networkName, token0Meta:{symbol,decimals}, token1Meta,
 *                  routerAddress, positionManager` (trading) / `hubPool, lpToken` (bridge),
 *                  and optional `unreachable: true` when the protocol could not be read.
 *   pools          every curated pool the member may supply, across networks. Used ONLY to
 *                  decide which assets can be a pair leg and which counterpart forms a real
 *                  curated pool — the selector never invents a pair (FR-054).
 *   assetOptions   `useSelectableAssets` options across ALL supported networks (spec 064).
 *   positions      the member's open positions, matched to a pool by `poolId`.
 *   onClose / onActionComplete
 * ─────────────────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, parseUnits } from '../../lib/evm/units'
import UniversalAssetSelect from '../ui/UniversalAssetSelect'
import InfoTip from '../ui/InfoTip'
import { useWallet } from '../../hooks/useWalletManagement'
import { useEarnSend, earnActingRefusal } from '../../hooks/useEarnSend'
import { useAddressScreening } from '../../hooks/useAddressScreening'
import { useActivityOptional } from '../../hooks/useActivity'
import usePortfolio from '../../hooks/usePortfolio'
import { NETWORKS } from '../../config/networks'
import { getBlockscoutUrl } from '../../config/blockExplorer'
import { makeReadProvider } from '../../utils/rpcProvider'
import { readPooledToken } from '../../lib/liquidity/acrossLpPositions'
import { samePair } from '../../lib/assets/networkPin'
import {
  DEFAULT_SUPPLY_SLIPPAGE_BPS,
  POOL_KIND,
  buildSupplyCalls,
  chargesPlatformFee,
  createLiquidityPin,
  maxSupplyFee,
  poolLimitViolation,
  readLiquidityPool,
  revalidatePairCounterpart,
  supplyMinimums,
} from '../../lib/liquidity/liquidityRouter'
import {
  EXCHANGE_RATE_SCALE,
  buildAddLiquidityCalls,
  buildRemoveLiquidityCalls,
} from '../../lib/liquidity/acrossLpPositions'
import { buildExitCalls } from '../../lib/liquidity/uniswapPositions'
import {
  BRIDGE_LP_FEE_FREE_NOTE,
  LIQUIDITY_KIND_LABEL,
  LIQUIDITY_TIPS,
  LIQUIDITY_UNAVAILABLE,
  POOL_UNREACHABLE_COPY,
  RETIRED_POOL_COPY,
  feeCeilingCopy,
  liquidityFeeCopy,
  noPairCounterpartCopy,
  partialWithdrawalCopy,
  poolDisclosure,
  poolKindOf,
  poolRiskSummary,
} from '../../lib/liquidity/liquidityCopy'
import { formatApy } from '../../lib/earn/format'
import { FEE_SERVICES, bpsToPercent, fetchFeeQuote, maxFeeBpsFor } from '../../lib/fees/feeQuote'
import { LIQUIDITY_ACTION, captureLiquidityAction } from '../../data/ledger/sources/liquidityLedgerSource'
import './SupplySheet.css'

/** Uniswap's deadline: long enough for a slow inclusion, short enough to expire honestly. */
const DEADLINE_SECONDS = 30 * 60

/**
 * FR-032/FR-033 — the refusal a flagged wallet gets. It names what is refused (new value
 * in) AND what is not (the exit), because a member who is told only "blocked" will assume
 * their money is stuck, and it is not.
 */
const SCREENING_REFUSAL =
  'This wallet is flagged by sanctions screening, so nothing new can be supplied. Nothing has been moved. Withdrawing what you already have in a pool is unaffected.'

/** Why a return figure is missing, when the pool itself did not say. */
const NO_RETURN_COPY =
  'Not available right now. An estimated return comes from the pool’s recent trading and bridging activity — we would rather show nothing than a figure we cannot source.'

/** Why a total is missing. Same rule: a blank with a reason beats an invented zero. */
const NO_TOTAL_COPY = 'We could not read this pool’s total just now, so it is not being shown.'

const lower = (v) => (v == null ? null : String(v).toLowerCase())
/** Identity of one pool leg: a token address ON a network. */
const legKey = (chainId, address) => `${Number(chainId)}:${lower(address)}`

/** Base units → a readable amount. `—` when the figure is genuinely unknown (never a 0). */
function fmt(raw, decimals, symbol) {
  if (raw == null || decimals == null) return '—'
  const value = Number(formatUnits(BigInt(raw), decimals))
  const text = value.toLocaleString('en-US', { maximumFractionDigits: Math.min(6, decimals) })
  return symbol ? `${text} ${symbol}` : text
}

/** `null` = nothing entered, `undefined` = not a number. Same idiom as StakeSheet/BridgeView. */
function parseAmount(text, decimals) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed || decimals == null) return null
  try {
    const parsed = parseUnits(trimmed, decimals)
    return parsed > 0n ? parsed : null
  } catch {
    return undefined
  }
}

/** Both legs of a trading pool, or the single leg of a bridge pool, as leg keys. */
function poolLegKeys(pool) {
  if (!pool) return []
  const keys = [legKey(pool.chainId, pool.token0)]
  if (Number(pool.kind) === POOL_KIND.TRADING_LP && pool.token1) keys.push(legKey(pool.chainId, pool.token1))
  return keys
}

/** True when `pool` holds exactly these two legs, in either order. */
function poolHoldsPair(pool, aKey, bKey) {
  if (!pool || !aKey || !bKey || aKey === bKey) return false
  if (Number(pool.kind) !== POOL_KIND.TRADING_LP) return false
  const k0 = legKey(pool.chainId, pool.token0)
  const k1 = legKey(pool.chainId, pool.token1)
  return (k0 === aKey && k1 === bKey) || (k0 === bKey && k1 === aKey)
}

/** The enabled trading pool pairing these two leg keys, or null when none is curated. */
function findPairPool(pools, aKey, bKey) {
  if (!aKey || !bKey || aKey === bKey) return null
  return (pools || []).find((p) => p.enabled && poolHoldsPair(p, aKey, bKey)) || null
}

export default function SupplySheet({
  pool: initialPool,
  pools = [],
  assetOptions = [],
  positions = [],
  onClose,
  onActionComplete,
  initialMode = 'supply',
}) {
  const { address, chainId: walletChainId } = useWallet() || {}
  const { sendOnChain, canTransactOn, cannotTransactReason, isPasskey, isActingAccount, actingAccount } = useEarnSend()
  const { screenOne } = useAddressScreening()
  const activity = useActivityOptional()
  const portfolio = usePortfolio() || {}
  const sheetRef = useRef(null)
  const restoreFocusRef = useRef(null)

  // Honour the mode the CARD asked for. It used to hard-start at 'supply', so tapping Withdraw
  // landed the member on the supply tab — worst on a retired pool, which renders no Supply control
  // at all, leaving the member unable to reach their own exit (FR-021/FR-024).
  const [mode, setMode] = useState(initialMode === 'withdraw' ? 'withdraw' : 'supply')
  const [step, setStep] = useState('amount') // amount | confirm
  const [ackDisclosure, setAckDisclosure] = useState(false)
  const [amount0Text, setAmount0Text] = useState('')
  const [amount1Text, setAmount1Text] = useState('')
  const [withdrawText, setWithdrawText] = useState('')
  const [withdrawPercent, setWithdrawPercent] = useState(100)
  const [firstKey, setFirstKey] = useState(null)
  const [secondKey, setSecondKey] = useState(null)
  const [inputError, setInputError] = useState(null)
  const [feeQuote, setFeeQuote] = useState(null)
  // null = not screened yet | 'clear' | 'restricted' | 'uncertain'
  const [screening, setScreening] = useState(null)
  const [txState, setTxState] = useState({ step: 'idle', txUrl: null, error: null, note: null })

  useEffect(() => {
    restoreFocusRef.current = document.activeElement
    sheetRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      restoreFocusRef.current?.focus?.()
    }
  }, [onClose])

  const isTrading = Number(initialPool?.kind) === POOL_KIND.TRADING_LP
  const kindLabel = LIQUIDITY_KIND_LABEL[poolKindOf(initialPool?.kind)] || 'Liquidity pool'

  // ── The pair selector (T097/T103) ───────────────────────────────────────────────────────
  // Every leg of every ENABLED curated trading pool, so the first selector offers exactly the
  // assets that can start a real pair — never an asset with nowhere to go.
  const tradingLegKeys = useMemo(() => {
    const set = new Set()
    for (const p of pools) {
      if (Number(p.kind) !== POOL_KIND.TRADING_LP || !p.enabled) continue
      for (const key of poolLegKeys(p)) set.add(key)
    }
    return set
  }, [pools])

  const optionKeyToLeg = useMemo(() => {
    const map = new Map()
    for (const o of assetOptions) {
      // A native coin has no token address; a Uniswap leg is always an ERC-20, so it never
      // matches one. That exclusion is by identity, not by a special case.
      if (!o?.address) continue
      map.set(o.key, legKey(o.chainId, o.address))
    }
    return map
  }, [assetOptions])

  const firstOptions = useMemo(
    () => assetOptions.filter((o) => tradingLegKeys.has(optionKeyToLeg.get(o.key))),
    [assetOptions, tradingLegKeys, optionKeyToLeg],
  )

  // Default the first leg to the pool this sheet was opened for, so a member who tapped a card
  // lands on that card's pool rather than on whatever sorts first.
  const defaultFirstKey = useMemo(() => {
    if (!isTrading) return null
    const want = legKey(initialPool.chainId, initialPool.token0)
    return firstOptions.find((o) => optionKeyToLeg.get(o.key) === want)?.key || firstOptions[0]?.key || null
  }, [isTrading, initialPool, firstOptions, optionKeyToLeg])

  const firstAsset = useMemo(
    () => firstOptions.find((o) => o.key === (firstKey ?? defaultFirstKey)) || firstOptions[0] || null,
    [firstOptions, firstKey, defaultFirstKey],
  )

  /**
   * THE PAIR PIN. `createLiquidityPin` fixes `PIN_MODE.SAME_NETWORK` in the liquidity client,
   * so this surface cannot pick the wrong rule by accident.
   */
  const pin = useMemo(() => (firstAsset ? createLiquidityPin(firstAsset) : null), [firstAsset])

  /**
   * THE COUNTERPART PREDICATE — `samePair` FIRST (one network, FR-062), then "and a curated
   * pool actually pairs these two". Never `bridgeDest`: that is the Bridge surface's rule and
   * would offer the same asset on OTHER networks as a pair leg.
   */
  const pairPredicate = useMemo(() => {
    const firstLeg = firstAsset ? optionKeyToLeg.get(firstAsset.key) : null
    return (option, activePin) =>
      samePair(option, activePin) && Boolean(findPairPool(pools, firstLeg, optionKeyToLeg.get(option?.key)))
  }, [firstAsset, optionKeyToLeg, pools])

  const secondOptions = useMemo(
    () => assetOptions.filter((o) => pairPredicate(o, pin)),
    [assetOptions, pairPredicate, pin],
  )
  const secondAsset = useMemo(
    () => secondOptions.find((o) => o.key === secondKey) || secondOptions[0] || null,
    [secondOptions, secondKey],
  )

  // Re-pinning (the member changed the first asset) CLEARS a second selection that no longer
  // qualifies, rather than leaving an impossible cross-network pair assembled (FR-062).
  useEffect(() => {
    setSecondKey((prev) => {
      if (!prev) return prev
      const current = assetOptions.find((o) => o.key === prev) || null
      if (!revalidatePairCounterpart(current, pin)) return null
      return pairPredicate(current, pin) ? prev : null
    })
  }, [pin, pairPredicate, assetOptions])

  /*
   * The pool actually being supplied: for a trading pool the member's chosen pair resolves it
   * (they may have picked a different curated pool than the card they opened); for a bridge
   * pool there is one asset and nothing to resolve.
   *
   * THE POOL THE MEMBER OPENED WINS while the pair on screen is still its pair. Uniswap curates
   * the same pair at SEVERAL fee tiers — USDC/WETH exists at 0.05% and 0.30% — and `findPairPool`
   * returns the first match, which is not necessarily the pool whose fee tier, size and
   * disclosure this sheet is showing. Without this line, opening the 0.30% row and pressing
   * Supply deposited into the 0.05% pool: every figure on the confirm step described one pool
   * and the signature went to another. The fallback below still covers the case this resolution
   * exists for — the member CHANGED the pair, so the opened pool is no longer what they mean.
   */
  const pool = useMemo(() => {
    if (!isTrading) return initialPool
    const aKey = firstAsset ? optionKeyToLeg.get(firstAsset.key) : null
    const bKey = secondAsset ? optionKeyToLeg.get(secondAsset.key) : null
    if (poolHoldsPair(initialPool, aKey, bKey)) return initialPool
    return findPairPool(pools, aKey, bKey) || initialPool
  }, [isTrading, initialPool, pools, firstAsset, secondAsset, optionKeyToLeg])

  const chainId = pool?.chainId
  const network = NETWORKS[chainId]
  const networkName = pool?.networkName || network?.name || 'its network'
  const meta0 = pool?.token0Meta || {}
  const meta1 = pool?.token1Meta || {}
  const symbol0 = meta0.symbol || 'token'
  const symbol1 = meta1.symbol || 'token'
  const decimals0 = meta0.decimals ?? null
  const decimals1 = meta1.decimals ?? null
  const retired = pool ? !pool.enabled : false
  const unreachable = Boolean(pool?.unreachable)
  /**
   * The router's pause, as the LIST read it. The sheet does not re-read the router's
   * paused flag — but it must not offer a deposit the list already knows would revert,
   * so the reason travels on the pool and closes the amount fields here too. It is a
   * separate state from retirement on purpose: a pause lifts, a retirement does not.
   */
  const routerPaused = pool?.unavailableReason === 'paused'
  const risk = poolRiskSummary(pool?.kind)

  const stillHolds = useCallback(
    (p) => Boolean(p) && (isTrading ? (p.liquidity ?? 0n) > 0n : (p.lpBalance ?? 0n) > 0n),
    [isTrading],
  )

  /**
   * The member's position in this pool.
   *
   * A LIVE one wins over a spent one. A member can hold several positions in the same pool —
   * supplying twice mints a second NFT — and a position withdrawn to zero is kept rather than
   * deleted, because their history is theirs. Taking the plain first match meant one emptied
   * position hid every live one behind it, and the sheet told a member with money in the pool
   * that they had nothing to withdraw. FR-021/FR-024 make the exit the one thing that is
   * always available; a first-match lookup was quietly making it conditional on ordering.
   */
  const position = useMemo(() => {
    const inPool = (positions || []).filter((p) => p?.poolId && pool?.poolId && p.poolId === pool.poolId)
    return inPool.find(stillHolds) || inPool[0] || null
  }, [positions, pool, stillHolds])
  const hasPosition = stillHolds(position)

  // ── The live platform fee (FR-026/FR-027/FR-028/FR-029) ────────────────────────────────
  // Fetched ONLY for a trading pool: a bridge pool has no fee to read, and reading one would
  // create a rate the member could be shown for a charge that cannot exist (point 2).
  const feeApplicable = chargesPlatformFee(pool)
  useEffect(() => {
    if (!feeApplicable || !chainId) {
      setFeeQuote(null)
      return undefined
    }
    let cancelled = false
    setFeeQuote(null)
    const rpcUrl = NETWORKS[chainId]?.rpcUrl
    const provider = rpcUrl ? makeReadProvider(rpcUrl, chainId) : null
    fetchFeeQuote({ serviceId: FEE_SERVICES.LIQUIDITY_DEPOSIT, chainId, provider })
      .then((quote) => {
        if (!cancelled) setFeeQuote(quote)
      })
      .catch(() => {
        // A router exists but the rate could not be read: block the fee-bearing path rather
        // than proceed on an assumed rate. Withdrawals stay open (point 5).
        if (!cancelled) setFeeQuote({ failed: true, available: false, bps: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [feeApplicable, chainId])

  // ── Screening the ACTING wallet (FR-032, point 6) ───────────────────────────────────────
  // Against the POOL's network, with that network's own read provider: the wallet may still
  // be on another chain until the signing-time switch, and screening against the wrong
  // network's guard would be worse than not screening at all.
  useEffect(() => {
    if (!address || !chainId) {
      setScreening(null)
      return undefined
    }
    let cancelled = false
    setScreening(null)
    const rpcUrl = NETWORKS[chainId]?.rpcUrl
    const provider = rpcUrl ? makeReadProvider(rpcUrl, chainId) : null
    Promise.resolve(screenOne(address, chainId, { provider }))
      .then((status) => {
        if (!cancelled) setScreening(status)
      })
      .catch(() => {
        if (!cancelled) setScreening('uncertain')
      })
    return () => {
      cancelled = true
    }
  }, [address, chainId, screenOne])

  /**
   * ONE derivation for both the rate on screen and the ceiling in the calldata (T113/
   * T114). `maxFeeBpsFor` is the only thing that turns a quote into basis points, so the
   * disclosed rate and the signed `maxFeeBps` cannot drift apart — and an unread or
   * out-of-cap rate resolves to `null` (no usable rate) rather than to a quiet 0, which
   * would be a ceiling nobody was shown.
   */
  const quotedBps = useMemo(() => {
    if (!feeApplicable) return 0
    try {
      return maxFeeBpsFor(feeQuote)
    } catch {
      return null
    }
  }, [feeApplicable, feeQuote])

  const feeLoading = feeApplicable && feeQuote == null
  // A router IS deployed here and the rate did not come back (or came back failing its
  // own cap). New value-in stops; withdrawing is untouched (point 5).
  const feeBlocked = feeApplicable && !feeLoading && quotedBps == null
  const feeBps = quotedBps ?? 0
  /**
   * The fee copy, or null ⇒ NO fee line at all. Null for a bridge pool (point 2), for a
   * network with no fee system, and at a zero rate (FR-029 — identical to no fee configured).
   */
  const feeCopy = liquidityFeeCopy({
    kind: pool?.kind,
    bps: feeBps,
    available: Boolean(feeApplicable && feeQuote?.available),
  })

  // ── Balances. The selector's `balance` is a rounded float and must never fund a Max. ────
  const balanceRawFor = useMemo(() => {
    const map = new Map()
    for (const h of portfolio.holdings || []) {
      map.set(`${Number(h.asset?.chainId)}:${lower(h.asset?.id)}`, h.balanceRaw ?? null)
    }
    return (token) => (token && chainId ? (map.get(legKey(chainId, token)) ?? null) : null)
  }, [portfolio.holdings, chainId])

  const balance0 = balanceRawFor(pool?.token0)
  const balance1 = isTrading ? balanceRawFor(pool?.token1) : null

  const amount0 = parseAmount(amount0Text, decimals0)
  const amount1 = isTrading ? parseAmount(amount1Text, decimals1) : null

  // ── Withdrawal (T099). Never fee-gated, and it works on a retired pool. ─────────────────
  const withdrawable = position?.withdrawable || null
  const withdrawMax = isTrading ? (position?.liquidity ?? null) : (withdrawable?.underlying ?? null)
  const withdrawAmount = isTrading ? null : parseAmount(withdrawText, decimals0)
  // A bridge pool is lent out across networks, so a full exit is not always fillable right now
  // (FR-022). `isFull === false` is the protocol's own answer, never a guess.
  const shortInventory = Boolean(!isTrading && withdrawable && withdrawable.isFull === false)

  const resetTx = () =>
    setTxState((prev) => (prev.step === 'idle' ? prev : { step: 'idle', txUrl: null, error: null, note: null }))

  const changeMode = (next) => {
    setMode(next)
    setStep('amount')
    setAckDisclosure(false)
    setInputError(null)
    setAmount0Text('')
    setAmount1Text('')
    setWithdrawText('')
    setWithdrawPercent(100)
    resetTx()
  }

  const setMax0 = () => {
    if (balance0 == null || decimals0 == null) return
    setAmount0Text(formatUnits(balance0, decimals0))
    setInputError(null)
  }
  const setMax1 = () => {
    if (balance1 == null || decimals1 == null) return
    setAmount1Text(formatUnits(balance1, decimals1))
    setInputError(null)
  }
  const setMaxWithdraw = () => {
    if (withdrawMax == null || decimals0 == null) return
    setWithdrawText(formatUnits(withdrawMax, decimals0))
    setInputError(null)
  }

  /** Validate the amounts BEFORE any wallet prompt (constitution III). */
  const validateSupply = () => {
    if (!pool) return 'This pool could not be resolved, so nothing can be supplied to it.'
    if (retired) return RETIRED_POOL_COPY
    if (routerPaused) return LIQUIDITY_UNAVAILABLE.paused
    if (amount0 === undefined || amount1 === undefined) return 'Enter a valid number.'
    if (amount0 == null) return `Enter an amount of ${symbol0} greater than zero.`
    if (isTrading && amount1 == null) {
      return `A trading pool takes both assets together, so enter an amount of ${symbol1} as well.`
    }
    if (balance0 != null && amount0 > balance0) {
      return `That is more than your ${symbol0} on ${networkName}.`
    }
    if (isTrading && balance1 != null && amount1 > balance1) {
      return `That is more than your ${symbol1} on ${networkName}.`
    }
    const violation = poolLimitViolation(pool, { amount0: amount0 ?? 0n, amount1: amount1 ?? 0n })
    if (violation) {
      const leg = violation.leg === 0 ? { d: decimals0, s: symbol0 } : { d: decimals1, s: symbol1 }
      return `${LIQUIDITY_UNAVAILABLE.aboveLimit} The most this pool takes in one deposit is ${fmt(violation.max, leg.d, leg.s)}.`
    }
    // Both fee stops are re-checked HERE, on the submit path, not only on the control
    // that leads to it: the rate is re-read whenever the pool's network changes, so a
    // member can be standing on the confirm step when it goes away. A quote still in
    // flight is not a zero rate, so it holds the signature back too (FR-028).
    if (feeBlocked) return LIQUIDITY_UNAVAILABLE.fees
    if (feeLoading) return 'The current platform fee is still being read — one moment, so the rate you sign against is the live one.'
    // FR-032 — new value in is refused for a flagged wallet. This is the DISPLAY-side
    // half; `submitSupply` re-reads the verdict live before it builds anything.
    if (screening === 'restricted') return SCREENING_REFUSAL
    return null
  }

  /**
   * FR-033 — deliberately NO screening check here, and none in `submitWithdraw`.
   * Refusing new value in is correct; standing between a member and money that is
   * already theirs is not. The exit stays open whatever the verdict.
   */
  const validateWithdraw = () => {
    if (!hasPosition) return 'You do not have anything in this pool to withdraw.'
    if (isTrading) {
      if (!position?.tokenId && position?.tokenId !== 0) return LIQUIDITY_UNAVAILABLE.reads
      if (!pool?.positionManager) return LIQUIDITY_UNAVAILABLE.reads
      return null
    }
    if (withdrawAmount === undefined) return 'Enter a valid number.'
    if (withdrawAmount == null) return 'Enter an amount greater than zero.'
    if (withdrawMax != null && withdrawAmount > withdrawMax) {
      return partialWithdrawalCopy(fmt(withdrawMax, decimals0, symbol0))
    }
    return null
  }

  const goToConfirm = () => {
    const reason = validateSupply()
    if (reason) {
      setInputError(reason)
      return
    }
    setInputError(null)
    setAckDisclosure(false)
    setStep('confirm')
  }

  const record = ({ action, txHash, txUrl, extra }) => {
    if (!address || !txHash) return
    captureLiquidityAction(address, chainId, {
      type: action,
      txHash,
      at: Date.now(),
      poolId: pool.poolId,
      poolKind: pool.kind,
      poolAddress: pool.poolAddress,
      tokenAddress: pool.token0,
      tokenSymbol: symbol0,
      tokenDecimals: decimals0,
      token1Address: isTrading ? pool.token1 : null,
      token1Symbol: isTrading ? symbol1 : null,
      token1Decimals: isTrading ? decimals1 : null,
      ...extra,
    })
    activity?.refresh?.()
    return txUrl
  }

  const runSend = async (calls, { action, extra, doneNote }) => {
    setTxState({ step: 'confirming', txUrl: null, error: null, note: null })
    try {
      const sent = await sendOnChain(chainId, calls, {
        onState: ({ step: s }) =>
          setTxState({
            step: s === 'switching' ? 'switching' : 'confirming',
            txUrl: null,
            error: null,
            note: null,
          }),
      })
      if (sent?.state === 'failed') throw new Error(sent.reason || 'The transaction did not go through.')
      const txHash = sent?.txHash ?? sent?.userOpHash ?? null
      if (!txHash) throw new Error('Submitted, but no transaction reference was returned.')
      // A UserOp hash is not a page on a block explorer, so it gets no link.
      const txUrl = sent?.txHash ? getBlockscoutUrl(chainId, sent.txHash, 'tx') : null
      record({ action, txHash, txUrl, extra })
      setTxState({ step: 'done', txUrl, error: null, note: doneNote || null })
      onActionComplete?.()
    } catch (err) {
      const rejected = /rejected|denied|cancelled|not allowed|abort/i.test(err?.message || '')
      setTxState({
        step: 'error',
        txUrl: null,
        note: null,
        error: rejected
          ? 'The confirmation was cancelled. Nothing was moved.'
          : err?.message && /switch|network/i.test(err.message)
            ? err.message
            : err?.message || 'The transaction could not be completed. Nothing was moved — you can try again.',
      })
    }
  }

  const guard = () => {
    if (!address) {
      setTxState({
        step: 'error',
        txUrl: null,
        note: null,
        error: 'This session cannot send transactions right now — please reconnect and try again.',
      })
      return false
    }
    if (!canTransactOn(chainId)) {
      setTxState({ step: 'error', txUrl: null, note: null, error: cannotTransactReason(chainId) })
      return false
    }
    return true
  }

  const submitSupply = async () => {
    const reason = validateSupply()
    if (reason) {
      setInputError(reason)
      setStep('amount')
      return
    }
    if (!guard()) return

    // FR-032 — the screen BITES HERE, before any call is built or signed, and it is a
    // forced re-read rather than the cached verdict behind the disabled control: a wallet
    // deny-listed since the sheet opened is refused at this line. It matters most on the
    // bridge-LP branch below, which calls the HubPool directly with no FairWins contract
    // in the path, so no on-chain guard backs it up.
    const rpc = NETWORKS[chainId]?.rpcUrl
    const verdict = await screenOne(address, chainId, {
      provider: rpc ? makeReadProvider(rpc, chainId) : null,
      force: true,
    })
    setScreening(verdict)
    if (verdict === 'restricted') {
      setTxState({ step: 'error', txUrl: null, note: null, error: SCREENING_REFUSAL })
      return
    }

    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS

    if (!isTrading) {
      // BRIDGE-LP: direct to the HubPool. No router, no fee, no `maxFeeBps` (point 2).
      let built
      try {
        built = buildAddLiquidityCalls({ hubPool: pool.hubPool, l1Token: pool.token0, amount: amount0 })
      } catch (err) {
        setTxState({ step: 'error', txUrl: null, note: null, error: err.message })
        return
      }

      // Re-read the pool at signing time, exactly as the trading branch below does. Across
      // exposes its own retirement flag (`isEnabled`) and it is already read at DISPLAY time, so
      // a pool retired between opening the sheet and signing was reaching the wallet and
      // reverting opaquely — the very failure the trading branch says it exists to prevent.
      setTxState({ step: 'checking', txUrl: null, error: null, note: null })
      try {
        const provider = makeReadProvider(pool.chainId)
        const pooled = provider
          ? await readPooledToken({ chainId: pool.chainId, provider, hubPool: pool.hubPool, l1Token: pool.token0 })
          : null
        if (pooled && pooled.isEnabled === false) {
          setTxState({ step: 'error', txUrl: null, note: null, error: RETIRED_POOL_COPY })
          return
        }
      } catch {
        // A failed re-read is not proof the pool is closed. Fall through rather than refuse a
        // supply on an unreadable RPC — the contract still enforces its own state.
      }

      await runSend(built.calls, {
        action: LIQUIDITY_ACTION.SUPPLY,
        extra: { amountRaw: amount0.toString() },
        doneNote: `Your ${symbol0} is in the pool and earning. You can withdraw it whenever you like.`,
      })
      return
    }

    // TRADING-LP: re-read the listing at signing time. A pool retired or re-limited since the
    // member opened the sheet should be caught HERE, not by an opaque revert.
    setTxState({ step: 'checking', txUrl: null, error: null, note: null })
    const rpcUrl = NETWORKS[chainId]?.rpcUrl
    let fresh
    try {
      fresh = await readLiquidityPool({
        chainId,
        provider: rpcUrl ? makeReadProvider(rpcUrl, chainId) : null,
        kind: pool.kind,
        poolAddress: pool.poolAddress,
        token0: pool.token0,
        token1: pool.token1,
      })
    } catch {
      fresh = null
    }
    if (!fresh) {
      setTxState({ step: 'error', txUrl: null, note: null, error: LIQUIDITY_UNAVAILABLE.router })
      return
    }
    if (!fresh.enabled) {
      setTxState({ step: 'error', txUrl: null, note: null, error: RETIRED_POOL_COPY })
      return
    }
    const violation = poolLimitViolation(fresh, { amount0, amount1 })
    if (violation) {
      const leg = violation.leg === 0 ? { d: decimals0, s: symbol0 } : { d: decimals1, s: symbol1 }
      setTxState({
        step: 'error',
        txUrl: null,
        note: null,
        error: `${LIQUIDITY_UNAVAILABLE.aboveLimit} The most this pool takes in one deposit is ${fmt(violation.max, leg.d, leg.s)}.`,
      })
      return
    }

    let built
    try {
      // SLIPPAGE BOUND. These become Uniswap's `amount0Min`/`amount1Min`, and they used to be
      // omitted entirely — `buildSupplyCalls` defaulted them to 0, which switches off Uniswap's
      // own price-slippage check and leaves the deposit open to being sandwiched at a manipulated
      // price. Derived from the amounts the confirm step disclosed, net of the fee, at the
      // tolerance shown alongside them. `buildSupplyCalls` now requires both, so this cannot be
      // silently dropped again.
      const { amount0Min, amount1Min } = supplyMinimums({
        amount0Desired: amount0,
        amount1Desired: amount1,
        bps: feeBps,
        slippageBps: DEFAULT_SUPPLY_SLIPPAGE_BPS,
      })
      built = buildSupplyCalls({
        routerAddress: pool.routerAddress,
        pool: fresh,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min,
        amount1Min,
        deadline,
        // FR-028 — the ceiling the router enforces on-chain is the SAME number the
        // confirm step disclosed, straight from `maxFeeBpsFor`. `validateSupply` has
        // already refused an unread rate, so this is never a defaulted 0.
        maxFeeBps: quotedBps,
      })
    } catch (err) {
      setTxState({ step: 'error', txUrl: null, note: null, error: err.message })
      return
    }
    await runSend(built.calls, {
      action: LIQUIDITY_ACTION.SUPPLY,
      extra: { amountRaw: amount0.toString(), amount1Raw: amount1.toString(), feeBps },
      doneNote:
        'Your position is open. Whatever the pool did not take has been returned to your wallet in the same transaction, whole.',
    })
  }

  const submitWithdraw = async () => {
    const reason = validateWithdraw()
    if (reason) {
      setInputError(reason)
      return
    }
    if (!guard()) return
    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS

    if (isTrading) {
      // Straight to Uniswap's position manager — the member owns the NFT, so no FairWins
      // state (pause, retirement, a pending upgrade) can stand between them and their money.
      const liquidity = (BigInt(position.liquidity) * BigInt(withdrawPercent)) / 100n
      let built
      try {
        built = buildExitCalls({
          positionManager: pool.positionManager,
          tokenId: position.tokenId,
          liquidity,
          deadline,
          recipient: address,
        })
      } catch (err) {
        setTxState({ step: 'error', txUrl: null, note: null, error: err.message })
        return
      }
      await runSend(built.calls, {
        action: LIQUIDITY_ACTION.WITHDRAW,
        extra: { tokenId: String(position.tokenId) },
        doneNote:
          withdrawPercent === 100
            ? 'Your assets and the fees they earned are back in your wallet. No FairWins fee was charged on the way out.'
            : 'That share is back in your wallet, along with the fees it earned. The rest stays in the pool and keeps earning.',
      })
      return
    }

    // BRIDGE-LP exit: `removeLiquidity`, direct to the HubPool. A full exit uses the LP-token
    // figure the protocol itself said the reserves can cover, so it cannot be rejected for
    // rounding; a partial exit converts at the current rate.
    const isFullExit = withdrawMax != null && withdrawAmount === withdrawMax
    const lpTokenAmount =
      isFullExit && withdrawable?.lpTokens != null
        ? BigInt(withdrawable.lpTokens)
        : position?.exchangeRate
          ? (withdrawAmount * EXCHANGE_RATE_SCALE) / BigInt(position.exchangeRate)
          : null
    if (lpTokenAmount == null || lpTokenAmount <= 0n) {
      setTxState({ step: 'error', txUrl: null, note: null, error: LIQUIDITY_UNAVAILABLE.reads })
      return
    }
    let built
    try {
      built = buildRemoveLiquidityCalls({
        hubPool: pool.hubPool,
        l1Token: pool.token0,
        lpTokenAmount,
      })
    } catch (err) {
      setTxState({ step: 'error', txUrl: null, note: null, error: err.message })
      return
    }
    await runSend(built.calls, {
      action: LIQUIDITY_ACTION.WITHDRAW,
      extra: { amountRaw: withdrawAmount.toString(), lpTokenAmountRaw: lpTokenAmount.toString() },
      doneNote: shortInventory
        ? 'That is back in your wallet. The rest of your share stays supplied and keeps earning — come back for it shortly.'
        : 'Your share is back in your wallet. No FairWins fee was charged on the way out.',
    })
  }

  const busy = ['checking', 'switching', 'confirming'].includes(txState.step)
  // FR-061 (T153) — `walletChainId` is undefined until the wallet resolves, and Number(undefined)
  // is NaN, which would assert "your wallet is on another network" about a wallet we have no
  // reading for. An unknown is never presented as a known.
  const walletChainKnown = walletChainId != null && Number.isFinite(Number(walletChainId))
  const needsSwitch = Boolean(chainId && walletChainKnown && Number(walletChainId) !== Number(chainId))
  const canTransact = canTransactOn(chainId)
  const disclosure = poolDisclosure(pool?.kind)
  const titleId = 'supply-sheet-title'
  const disclosureId = 'supply-sheet-disclosure'

  // Two different bars, and the difference matters. `depositsClosed` is the pool itself
  // refusing new value — the amount fields go dead because there is nothing to enter them
  // for. `supplyBlocked` additionally covers a rate we cannot yet stand behind: the member
  // may still type and look around, but the step that leads to a signature is held back
  // until the rate is known (FR-028). Blocking the keyboard on a pending read would read as
  // a broken form rather than as an honest wait.
  const depositsClosed = retired || unreachable || routerPaused
  // FR-033 — a flagged wallet loses the SUPPLY path and nothing else. The Withdraw tab, the
  // position figures, and `submitWithdraw` are all untouched below, so a restricted member
  // can still see what they hold and take it out.
  const screeningRestricted = screening === 'restricted'
  const supplyBlocked = depositsClosed || feeBlocked || feeLoading || screeningRestricted
  // FR-065 — a pin that leaves no counterpart says so and names what would change it, rather
  // than pairing an empty dropdown with a silently disabled control.
  const pairEmptyMessage = noPairCounterpartCopy(firstAsset?.symbol, firstAsset?.networkName || networkName)

  /**
   * FR-028's "resulting net amount", in the only form that is true here: a CEILING.
   * `maxSupplyFee` is the fee on the whole amount entered — the most it can ever be,
   * because the pool can only take less than offered, never more — and the net beside
   * it is the matching floor on what goes in. Neither is presented as the charge.
   */
  const feeCeiling = (() => {
    if (!feeCopy || amount0 == null || amount1 == null) return null
    const maxFee0 = maxSupplyFee({ amountDesired: amount0, bps: feeBps })
    const maxFee1 = maxSupplyFee({ amountDesired: amount1, bps: feeBps })
    return feeCeilingCopy(
      `${fmt(maxFee0, decimals0, symbol0)} + ${fmt(maxFee1, decimals1, symbol1)}`,
      `${fmt(amount0 - maxFee0, decimals0, symbol0)} + ${fmt(amount1 - maxFee1, decimals1, symbol1)}`,
    )
  })()

  // Spec 088 FR-001/FR-002 — every read and write in this sheet belongs to the CONNECTED
  // wallet (supply/withdraw goes out on useEarnSend.sendOnChain, which signs with whatever the
  // wallet holds and switches networks on it directly — see the BridgeView template this
  // mirrors). So while the switcher shows a vault, a recovered, a hardware, or any other
  // non-personal account, the whole sheet is withheld with the reason, rather than left up with
  // the connected wallet's own balances and positions shown under the acting account's name.
  if (isActingAccount) {
    return (
      <div className="asset-sheet-backdrop">
        <button type="button" className="asset-sheet-scrim" aria-label="Close pool details" onClick={onClose} />
        <div
          className="asset-sheet earn-vault-sheet supply-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          ref={sheetRef}
        >
          <div className="asset-sheet-grabber" aria-hidden="true" />
          <div className="asset-sheet-header">
            <div className="asset-sheet-heading">
              <h3 id={titleId}>{isTrading ? `${symbol0} / ${symbol1}` : symbol0}</h3>
            </div>
            <button type="button" className="asset-sheet-close" onClick={onClose}>
              Close
            </button>
          </div>
          <p className="supply-unavailable" role="note" data-testid="earn-supply-acting-refusal">
            {earnActingRefusal(actingAccount)}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="asset-sheet-backdrop">
      <button type="button" className="asset-sheet-scrim" aria-label="Close pool details" onClick={onClose} />
      <div
        className="asset-sheet earn-vault-sheet supply-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={sheetRef}
      >
        <div className="asset-sheet-grabber" aria-hidden="true" />
        <div className="asset-sheet-header">
          <div className="asset-sheet-heading">
            <h3 id={titleId}>
              {isTrading ? `${symbol0} / ${symbol1}` : symbol0}{' '}
              <span className={`supply-kind-badge ${isTrading ? 'trading' : 'bridge'}`}>{kindLabel}</span>
            </h3>
            <p className="earn-vault-sheet-meta">
              {pool?.protocol ? `${pool.protocol} · ` : ''}On {networkName}
              {isTrading && pool?.feeTier ? ` · ${(Number(pool.feeTier) / 10_000).toFixed(2)}% pool fee` : ''}
              <InfoTip label="What is this pool?" className="earn-info">
                {isTrading ? LIQUIDITY_TIPS.tradingPool : LIQUIDITY_TIPS.bridgePool}
              </InfoTip>
              {isTrading && pool?.feeTier ? (
                <InfoTip label="What is the pool fee?" className="earn-info">
                  {LIQUIDITY_TIPS.feeTier}
                </InfoTip>
              ) : null}
            </p>
          </div>
          <button type="button" className="asset-sheet-close" onClick={onClose}>
            Close
          </button>
        </div>

        {/* FR-017 — the figures the list row is too dense to carry, read BEFORE an amount is
            typed rather than after. A figure we could not source is "—" with the reason in
            its place; the list said the same thing with a dash, and this is where it is
            explained. */}
        <dl className="supply-facts">
          <div>
            <dt>
              Estimated return
              <InfoTip label="What is the estimated return?" className="earn-info">
                {LIQUIDITY_TIPS.estimatedReturn}
              </InfoTip>
            </dt>
            <dd>
              {pool?.estimatedReturnApr == null ? '—' : formatApy(pool.estimatedReturnApr)}
              {pool?.estimatedReturnApr == null && (
                <span className="supply-figure-note">{pool?.estimatedReturnReason || NO_RETURN_COPY}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>
              Total supplied
              <InfoTip label="What does total supplied mean?" className="earn-info">
                {LIQUIDITY_TIPS.totalSupplied}
              </InfoTip>
            </dt>
            <dd>
              {pool?.totalSuppliedLabel || '—'}
              {!pool?.totalSuppliedLabel && <span className="supply-figure-note">{NO_TOTAL_COPY}</span>}
            </dd>
          </div>
        </dl>

        {/* FR-017 — the kind-specific risk, in the same plain register as the Lend area. */}
        {risk && (
          <p className="supply-card-risk">
            {risk}
            <InfoTip
              label={isTrading ? 'About changing asset mix' : 'About withdrawing from a bridge pool'}
              className="earn-info"
            >
              {isTrading ? LIQUIDITY_TIPS.impermanentLoss : LIQUIDITY_TIPS.inventory}
            </InfoTip>
          </p>
        )}

        {/* FR-024 — a pool that is not taking deposits stays VISIBLE and WITHDRAWABLE. It is
            never hidden while a member's money is inside it; only new deposits are closed.
            Each reason states ITSELF: they have different remedies, and telling a member the
            wrong one has them waiting for the wrong thing. */}
        {retired && (
          <p className="supply-note" role="note">
            {RETIRED_POOL_COPY}
          </p>
        )}
        {unreachable && !retired && (
          <p className="supply-note" role="note">
            {POOL_UNREACHABLE_COPY}
          </p>
        )}
        {routerPaused && (
          <p className="supply-note" role="note">
            {LIQUIDITY_UNAVAILABLE.paused}
          </p>
        )}

        {txState.step === 'done' ? (
          <div className="earn-tx-done" role="status">
            <p>{txState.note || 'Done. Your balances update in a moment.'}</p>
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
            <div className="earn-mode-tabs" role="tablist" aria-label="Supply or withdraw">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'supply'}
                className={`earn-mode-tab ${mode === 'supply' ? 'active' : ''}`}
                onClick={() => changeMode('supply')}
              >
                {hasPosition ? 'Add to position' : 'Supply'}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'withdraw'}
                className={`earn-mode-tab ${mode === 'withdraw' ? 'active' : ''}`}
                // Deliberately NOT disabled by retirement, by an unreadable fee rate, or by a
                // paused router: the exit is always available (FR-021/FR-024).
                disabled={!hasPosition}
                title={hasPosition ? undefined : 'You have nothing in this pool yet'}
                onClick={() => changeMode('withdraw')}
              >
                Withdraw
              </button>
            </div>

            {mode === 'supply' ? (
              <>
                {/* FR-032/FR-033 — the verdict, stated, on the value-in path only, and only
                    when it REFUSES: it says what is refused and what is not. An 'uncertain'
                    verdict is deliberately silent — see point 6 — while still never being
                    treated as clearance on the refusal path. */}
                {screeningRestricted && (
                  <p className="earn-input-error" role="alert" data-testid="supply-screening-refusal">
                    {SCREENING_REFUSAL}
                  </p>
                )}
                {step === 'amount' ? (
                  <>
                    {/* ── The pair selector (T097). `samePair`, never `bridgeDest`. ── */}
                    {isTrading && (
                      <>
                        <div className="supply-field">
                          <span className="supply-label" id="supply-first-label">
                            First asset
                          </span>
                          <UniversalAssetSelect
                            label="First asset"
                            options={firstOptions}
                            value={firstAsset?.key}
                            onChange={(option) => {
                              setFirstKey(option.key)
                              setAmount0Text('')
                              setAmount1Text('')
                              setInputError(null)
                              resetTx()
                            }}
                            disabled={busy}
                          />
                        </div>

                        <div className="supply-field">
                          <span className="supply-label" id="supply-second-label">
                            Paired with
                            <InfoTip label="Why two assets?" className="earn-info">
                              {LIQUIDITY_TIPS.pair}
                            </InfoTip>
                          </span>
                          <UniversalAssetSelect
                            label="Paired with"
                            options={assetOptions}
                            value={secondAsset?.key}
                            onChange={(option) => {
                              setSecondKey(option.key)
                              setAmount1Text('')
                              setInputError(null)
                              resetTx()
                            }}
                            disabled={busy}
                            pin={pin}
                            pinPredicate={pairPredicate}
                            pinEmptyMessage={pairEmptyMessage}
                          />
                          {/* FR-062 — the pinned network is VISIBLE, not merely enforced. */}
                          <p className="supply-hint" data-testid="supply-pin-hint">
                            {pin?.pinnedNetworkName || networkName} is pinned — a trading pool holds both
                            assets on one network.
                          </p>
                          {/* FR-065 — the empty-counterpart explanation is rendered ONCE, by the
                              selector itself, next to the control it disables (`pinEmptyMessage`
                              above). Repeating the same sentence here reads as a glitch. */}
                        </div>
                      </>
                    )}

                    <dl className="earn-vault-sheet-facts">
                      <div>
                        <dt>Your {symbol0}</dt>
                        <dd>{fmt(balance0, decimals0, symbol0)}</dd>
                      </div>
                      {isTrading && (
                        <div>
                          <dt>Your {symbol1}</dt>
                          <dd>{fmt(balance1, decimals1, symbol1)}</dd>
                        </div>
                      )}
                    </dl>

                    <div className="earn-amount-row">
                      <label htmlFor="supply-amount-0">Amount ({symbol0})</label>
                      <div className="earn-amount-input">
                        <input
                          id="supply-amount-0"
                          type="text"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0.00"
                          value={amount0Text}
                          disabled={busy || depositsClosed}
                          onChange={(e) => {
                            setAmount0Text(e.target.value)
                            setInputError(null)
                            resetTx()
                          }}
                        />
                        <button
                          type="button"
                          className="earn-btn secondary"
                          onClick={setMax0}
                          disabled={busy || depositsClosed || balance0 == null}
                        >
                          Max
                        </button>
                      </div>
                    </div>

                    {isTrading && (
                      <div className="earn-amount-row">
                        <label htmlFor="supply-amount-1">Amount ({symbol1})</label>
                        <div className="earn-amount-input">
                          <input
                            id="supply-amount-1"
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="0.00"
                            value={amount1Text}
                            disabled={busy || depositsClosed}
                            onChange={(e) => {
                              setAmount1Text(e.target.value)
                              setInputError(null)
                              resetTx()
                            }}
                          />
                          <button
                            type="button"
                            className="earn-btn secondary"
                            onClick={setMax1}
                            disabled={busy || depositsClosed || balance1 == null}
                          >
                            Max
                          </button>
                        </div>
                      </div>
                    )}

                    {inputError && (
                      <p className="earn-input-error" role="alert">
                        {inputError}
                      </p>
                    )}

                    {feeLoading && !retired && (
                      <p className="earn-summary">Checking the current platform fee…</p>
                    )}
                    {feeBlocked && (
                      <p className="earn-input-error" role="alert">
                        {LIQUIDITY_UNAVAILABLE.fees}
                      </p>
                    )}

                    <button
                      type="button"
                      className="earn-btn primary earn-submit"
                      onClick={goToConfirm}
                      // The step that LEADS to a signature is held back by everything,
                      // including a rate we cannot yet stand behind (FR-028).
                      disabled={busy || supplyBlocked}
                    >
                      Review and confirm
                    </button>
                  </>
                ) : (
                  <>
                    {/* ── THE CONFIRM STEP (T095/T096) ─────────────────────────────────────
                        The disclosure is a GATE, not a tooltip: it is rendered INLINE here and
                        the confirm control stays unusable until it has been acknowledged
                        (FR-018 for a trading pool, FR-019 for a bridge pool). */}
                    <dl className="earn-vault-sheet-facts">
                      <div>
                        <dt>You supply</dt>
                        <dd>
                          {fmt(amount0, decimals0, symbol0)}
                          {isTrading ? ` + ${fmt(amount1, decimals1, symbol1)}` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>Into</dt>
                        <dd>
                          {kindLabel} on {networkName}
                        </dd>
                      </div>
                    </dl>

                    {/* FR-028 — the RATE, as its own line, and what it applies to. Deliberately
                        NOT "fee = rate × what you typed": the router charges on what the pool
                        actually consumed and refunds the rest whole (point 1). */}
                    {feeCopy ? (
                      <div className="supply-fee" data-testid="supply-fee-line">
                        <dl className="earn-vault-sheet-facts">
                          <div>
                            <dt>
                              FairWins platform fee
                              <InfoTip label="About the platform fee" className="earn-info">
                                {LIQUIDITY_TIPS.platformFee}
                              </InfoTip>
                            </dt>
                            <dd>{bpsToPercent(feeBps)}</dd>
                          </div>
                        </dl>
                        <p className="supply-fee-basis">{feeCopy.basis}</p>
                        {feeCeiling && <p className="supply-fee-basis">{feeCeiling}</p>}
                        <p className="supply-fee-basis">
                          {feeCopy.remainder}
                          <InfoTip label="What comes back?" className="earn-info">
                            {LIQUIDITY_TIPS.refundedRemainder}
                          </InfoTip>
                        </p>
                        <p className="supply-fee-basis">{feeCopy.withdrawal}</p>
                      </div>
                    ) : (
                      // NO fee line at all — not a line reading 0.00 (point 2 / FR-029). A bridge
                      // pool says WHY it is free; a zero rate simply says nothing.
                      !isTrading && (
                        <p className="supply-note" data-testid="supply-fee-free" role="note">
                          {BRIDGE_LP_FEE_FREE_NOTE}
                        </p>
                      )
                    )}

                    <div className="supply-disclosure" role="note" id={disclosureId}>
                      <h4>{isTrading ? 'Before you supply a trading pool' : 'Before you supply a bridge pool'}</h4>
                      <p>{disclosure}</p>
                    </div>

                    <label className="supply-ack">
                      <input
                        type="checkbox"
                        checked={ackDisclosure}
                        aria-describedby={disclosureId}
                        onChange={(e) => setAckDisclosure(e.target.checked)}
                      />
                      {isTrading
                        ? 'I understand the mix of assets I get back changes with their prices and can be worth less than simply holding them.'
                        : 'I understand my asset is lent out across networks and that withdrawal depends on what is available then.'}
                    </label>

                    {/* FR-061 (T153) — the switch is disclosed BEFORE the signature, never
                        demanded as a prerequisite the member has to go and perform first. */}
                    {needsSwitch && (
                      <p className="supply-switch-note" role="note">
                        Your wallet is on {NETWORKS[walletChainId]?.name || 'another network'}. It will
                        switch to {networkName} when you confirm — you do not need to change networks
                        yourself.
                        <InfoTip label="About the network switch" className="earn-info">
                          {LIQUIDITY_TIPS.networkSwitch}
                        </InfoTip>
                      </p>
                    )}

                    {!canTransact && (
                      <p className="earn-summary" role="note">
                        {cannotTransactReason(chainId)}
                      </p>
                    )}

                    {inputError && (
                      <p className="earn-input-error" role="alert">
                        {inputError}
                      </p>
                    )}
                    {txState.step === 'error' && (
                      <p className="earn-input-error" role="alert">
                        {txState.error}
                      </p>
                    )}

                    <div className="supply-confirm-row">
                      <button
                        type="button"
                        className="earn-btn secondary"
                        onClick={() => {
                          setStep('amount')
                          setAckDisclosure(false)
                          resetTx()
                        }}
                        disabled={busy}
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        className="earn-btn primary earn-submit"
                        onClick={submitSupply}
                        disabled={!ackDisclosure || busy || !canTransact || supplyBlocked}
                      >
                        {txState.step === 'switching'
                          ? `Switching to ${networkName}…`
                          : txState.step === 'checking'
                            ? 'Checking the pool…'
                            : txState.step === 'confirming'
                              ? isPasskey
                                ? 'Confirm with your passkey…'
                                : 'Waiting for confirmation…'
                              : 'Supply to this pool'}
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {/* ── WITHDRAW (T099). No fee line anywhere on this path, ever. ── */}
                <dl className="earn-vault-sheet-facts">
                  <div>
                    <dt>
                      In this pool
                      <InfoTip label="How is this valued?" className="earn-info">
                        {LIQUIDITY_TIPS.positionValue}
                      </InfoTip>
                    </dt>
                    <dd>
                      {isTrading
                        ? `${fmt(position?.amount0, decimals0, symbol0)} + ${fmt(position?.amount1, decimals1, symbol1)}`
                        : fmt(position?.currentValue, decimals0, symbol0)}
                      <span className="supply-estimate"> (estimate)</span>
                    </dd>
                  </div>
                  {!isTrading && (
                    <div>
                      <dt>
                        Available to withdraw now
                        <InfoTip label="Why can this differ?" className="earn-info">
                          {LIQUIDITY_TIPS.inventory}
                        </InfoTip>
                      </dt>
                      <dd>{fmt(withdrawMax, decimals0, symbol0)}</dd>
                    </div>
                  )}
                </dl>

                {/* FR-022 — inventory cannot fill this in full right now: take what is
                    available and be told plainly that the remainder comes later. */}
                {shortInventory && (
                  <p className="supply-note" data-testid="supply-partial-note" role="note">
                    {partialWithdrawalCopy(fmt(withdrawable?.underlying, decimals0, symbol0))}
                  </p>
                )}

                {isTrading ? (
                  <div className="supply-field">
                    <span className="supply-label" id="supply-withdraw-share-label">
                      How much of your position
                    </span>
                    <div className="supply-percent-row" role="group" aria-labelledby="supply-withdraw-share-label">
                      {[25, 50, 100].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          className={`earn-btn secondary ${withdrawPercent === pct ? 'active' : ''}`}
                          aria-pressed={withdrawPercent === pct}
                          disabled={busy}
                          onClick={() => {
                            setWithdrawPercent(pct)
                            setInputError(null)
                            resetTx()
                          }}
                        >
                          {pct === 100 ? 'All' : `${pct}%`}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="earn-amount-row">
                    <label htmlFor="supply-withdraw-amount">Amount ({symbol0})</label>
                    <div className="earn-amount-input">
                      <input
                        id="supply-withdraw-amount"
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder="0.00"
                        value={withdrawText}
                        disabled={busy}
                        onChange={(e) => {
                          setWithdrawText(e.target.value)
                          setInputError(null)
                          resetTx()
                        }}
                      />
                      <button
                        type="button"
                        className="earn-btn secondary"
                        onClick={setMaxWithdraw}
                        disabled={busy || withdrawMax == null}
                      >
                        Max
                      </button>
                    </div>
                  </div>
                )}

                {/* FR-021/FR-030 — stated, not merely implied by the absence of a fee line. */}
                <p className="earn-summary" data-testid="supply-withdraw-free">
                  Withdrawing never carries a FairWins fee.
                  <InfoTip label="About withdrawing" className="earn-info">
                    {LIQUIDITY_TIPS.withdrawal}
                  </InfoTip>
                </p>

                {needsSwitch && (
                  <p className="supply-switch-note" role="note">
                    Your wallet is on {NETWORKS[walletChainId]?.name || 'another network'}. It will switch
                    to {networkName} when you confirm — you do not need to change networks yourself.
                  </p>
                )}

                {!canTransact && (
                  <p className="earn-summary" role="note">
                    {cannotTransactReason(chainId)}
                  </p>
                )}
                {inputError && (
                  <p className="earn-input-error" role="alert">
                    {inputError}
                  </p>
                )}
                {txState.step === 'error' && (
                  <p className="earn-input-error" role="alert">
                    {txState.error}
                  </p>
                )}

                <button
                  type="button"
                  className="earn-btn primary earn-submit"
                  onClick={submitWithdraw}
                  disabled={busy || !canTransact || !hasPosition}
                >
                  {txState.step === 'switching'
                    ? `Switching to ${networkName}…`
                    : txState.step === 'confirming'
                      ? isPasskey
                        ? 'Confirm with your passkey…'
                        : 'Waiting for confirmation…'
                      : `Withdraw ${symbol0}`}
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
