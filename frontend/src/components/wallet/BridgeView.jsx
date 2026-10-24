/**
 * BridgeView (spec 067, US1 — T078/T080/T083/T151) — the Transfer → Bridge surface.
 *
 * A member picks an asset they hold on ANY supported network, a destination network, and
 * an amount; reads one itemized quote (BridgeQuoteCard); and confirms from their own
 * wallet. Nothing here takes custody and nothing here claims delivery — the progress view
 * (BridgeStatusList) owns what happens after the signature, and only destination-chain
 * evidence can complete a transfer (FR-009).
 *
 * ── THE INVERSION (research R11b) ────────────────────────────────────────────────────
 * The destination selector uses `bridgeDest` — the SAME asset on OTHER networks (FR-063).
 * It must NEVER use `samePair`, the pair/swap rule (FR-062). Getting this backwards fails
 * silently and expensively: the destination would sit on the source chain, the gateway
 * would still price it, the member would still sign, and a "bridge" would have become an
 * ordinary same-chain transfer with a bridge's fees. `frontend/src/test/bridge/
 * BridgeView.test.jsx` fails if the predicate is swapped — keep that test.
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * ── THE SIGNING-TIME SWITCH (FR-061, T151) ───────────────────────────────────────────
 * The selector deliberately lists assets on networks the wallet is NOT currently on, so
 * the switch has to happen somewhere. It happens at SUBMIT, through `useEarnSend`, and is
 * disclosed above the confirm button before any signature. A member never has to find a
 * network switcher to start; without this the cross-network list would produce a failed
 * transaction for every asset off the active chain.
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * Honest states (FR-051/FR-052/FR-053/FR-054/FR-006c, T083). Availability is READ, never
 * assumed: the gateway prices transfers (no gateway ⇒ no bridge, research R10) and the
 * on-chain `BridgeRouter` is the authority on routes, limits, and the pause flag. An
 * undeployed or unreadable router withholds the surface with a stated reason rather than
 * offering controls that cannot work, and the route list is shown "as of" its last read.
 * Bitcoin is out of scope (FR-006) and says so — its network ids are STRINGS and are kept
 * away from every chain-keyed call by `isEvmOption`.
 *
 * ── ONE ROSTER (issue #1265) ─────────────────────────────────────────────────────────
 * The asset selector draws on the CATALOG (`useSelectableAssets({catalog:true})`), which is
 * mainnets-always plus a member opt-in and knows nothing about the build's cohort. This form
 * narrows it to `bridgeNetworks()` — the same cohort-bounded roster the availability copy and
 * `BridgeStatusList` read — because those three must describe ONE build. Before #1265 they did
 * not have to: the roster spanned both cohorts, so it was never empty. Bounding only the copy
 * would have let a testnet build quote, sign and record a mainnet bridge and then state
 * underneath that no network here bridges at all — a transfer the member had just made,
 * denied by the surface that made it (FR-053). Networks dropped by this narrowing are NAMED
 * with their real reason below (FR-006c); a silent omission is the failure that requirement
 * exists to prevent.
 * ─────────────────────────────────────────────────────────────────────────────────────
 *
 * ── SCREENING AND THE RESTRICTED ACCOUNT (FR-032/FR-033, T116/T154) ──────────────────
 * The acting wallet is screened through `useAddressScreening` — the platform's one
 * screening path — against the SOURCE network (its own read provider, because the wallet
 * may still be on another chain until the signing-time switch). The verdict does two
 * different jobs, and conflating them would be the failure:
 *   · at DISPLAY it disables the confirm control and states the reason;
 *   · at SUBMISSION it is read AGAIN, forced past the cache, so a wallet deny-listed
 *     between the quote and the signature is still refused before anything is signed.
 * A restricted member is refused new value-in ONLY. Everything already sent stays visible
 * and keeps settling — the progress list is a sibling of this form and is never gated —
 * because refusing new money is correct and trapping existing money is not.
 * `uncertain` is not `restricted`: the guard is not deployed on every bridgeable network,
 * so an unscreenable wallet is disclosed, never blocked on an assumption.
 *
 * ── ACTING ACCOUNTS ARE REFUSED, NOT SILENTLY IGNORED (spec 088 FR-001/FR-002) ───────
 * Every read and every write on this surface belongs to the CONNECTED wallet: the asset
 * roster, the balance behind Max, the screened address, the `recipient` baked into the
 * deposit, the ledger entry, and the signature itself (`useEarnSend.sendOnChain` sends
 * through the wallet's own rail). While the account switcher shows a vault, a recovered,
 * a hardware or any other non-personal account, that would be a transfer of the connected
 * wallet's money made under another account's name.
 *
 * Routing it through the acting seam is not a small change and is not simply better here:
 * `submitAsActiveAccount` does not switch networks, while a bridge is defined by starting
 * on a chain the wallet may not be on and the acting signer binds to the wallet's CURRENT
 * chain at ceremony time (FR-005) — so an acting bridge would sign against the wrong chain.
 * And a vault has no owner guarantee at the same address on the DESTINATION chain, so a
 * bridge "as a vault" can deliver to an address nobody controls. Both are follow-up work
 * with their own design; neither is a reason to proceed as the connected wallet in the
 * meantime. So the surface is WITHHELD with the reason stated, the way Verify refuses to
 * sign a message as a vault (spec 084) — the whole form, because leaving it up would show
 * the connected wallet's assets under the acting account's name.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, parseUnits } from '../../lib/evm/units'
import UniversalAssetSelect from '../ui/UniversalAssetSelect'
import InfoTip from '../ui/InfoTip'
import BridgeQuoteCard from './BridgeQuoteCard'
import { useWallet } from '../../hooks/useWalletManagement'
import { useEffectiveAccount } from '../../hooks/useEffectiveAccount'
import { useSelectableAssets } from '../../hooks/useSelectableAssets'
import usePortfolio from '../../hooks/usePortfolio'
import { useEarnSend } from '../../hooks/useEarnSend'
import { useAddressScreening } from '../../hooks/useAddressScreening'
import { PIN_MODE, bridgeDest, createPin, isEvmOption, revalidateSelection } from '../../lib/assets/networkPin'
import {
  bridgeGatewayUrl,
  fetchBridgeQuote,
  isQuoteStale,
  quoteMsRemaining,
} from '../../lib/bridge/acrossQuotes'
import {
  buildBridgeCalls,
  readBridgeRoute,
  readBridgeRouterConfig,
} from '../../lib/bridge/bridgeRouter'
import { decodeEventLog } from 'viem'
import { SPOKE_POOL_ABI } from '../../lib/bridge/bridgeStatus'
import {
  BRIDGE_DISCLOSURE,
  BRIDGE_TIPS,
  BRIDGE_UNAVAILABLE,
  bridgeNetworks,
  noBridgeDestinationCopy,
} from '../../lib/bridge/bridgeCopy'
import { captureBridgeSubmission } from '../../data/ledger/sources/bridgeLedgerSource'
import { NATIVE_GAS_RESERVE } from '../../lib/staking/stakingActions'
import { NETWORKS } from '../../config/networks'
import { isBitcoinNetworkId } from '../../config/bitcoinNetworks'
import { getBlockscoutUrl } from '../../config/blockExplorer'
import { makeReadProvider } from '../../utils/rpcProvider'
import './Bridge.css'

/** Wait after the last keystroke before pricing, so typing an amount is not 6 quotes. */
const QUOTE_DEBOUNCE_MS = 400
/** How long we look for the deposit receipt before recording the transfer without one. */
const RECEIPT_ATTEMPTS = 6
const RECEIPT_POLL_MS = 1_500

/** The Across deposit events, by the two names the SpokePool has used. */
const DEPOSIT_EVENT_NAMES = ['V3FundsDeposited', 'FundsDeposited']

/**
 * FR-032/FR-033 — the refusal a flagged wallet gets, and it says what is NOT refused.
 * A member who cannot start a transfer must not be left believing the transfers they
 * already have in flight are gone too.
 */
const SCREENING_REFUSAL =
  'This wallet is flagged by sanctions screening, so a new transfer cannot be started. Nothing has been sent. Transfers already on their way are unaffected and still shown below.'

/**
 * Spec 088 FR-001/FR-002 — the refusal a member gets while acting as any non-personal
 * account. It names the account they are acting as, says plainly that this surface can only
 * move the connected wallet's own assets, and gives the one action that changes that. It
 * must never read as an outage: nothing is broken, and the member's own bridging works the
 * moment they switch back.
 *
 * @param {{ type: string, label: string|null }} acting
 * @returns {string}
 */
function actingRefusal(acting) {
  const named =
    acting.label ||
    (acting.type === 'vault'
      ? 'a vault'
      : acting.type === 'hardware'
        ? 'a hardware account'
        : acting.type === 'legacy' || acting.type === 'derived'
          ? 'a recovered account'
          : 'another account')
  return `You are acting as ${named}. Bridging can only move assets held by the wallet connected to this app, so it is not offered here — showing it would let you start a transfer of your connected wallet's money under ${named}'s name. Switch back to acting as yourself to bridge, or send the assets to your own wallet first and bridge them from there. Nothing has been sent, and transfers already on their way are unaffected and still shown below.`
}

/** Screening could not run here — stated as unknown, never treated as clear or as flagged. */
const SCREENING_UNAVAILABLE =
  'Sanctions screening could not be run on this network just now, so this transfer has not been pre-checked here.'

const addrEq = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase())

const readProviderFor = (chainId) => {
  const rpcUrl = NETWORKS[chainId]?.rpcUrl
  return rpcUrl ? makeReadProvider(rpcUrl, chainId) : null
}

/**
 * The curated route that moves `source` to `destination`, or null when the operator has
 * not opened one.
 *
 * A NATIVE source is identified by the route's `nativeInput` flag rather than by an
 * address, because Across names the WRAPPED token as `inputToken` even when the member
 * sends the coin itself. A destination ERC-20 must match the route's delivered token
 * exactly — that is what stops a look-alike asset (USDC vs USDC.e) being substituted
 * silently; a native destination has no address to compare, so the operator's curation
 * plus the same-symbol pin is the identity we have, and it is stated rather than implied.
 */
function findRouteForPair(routes, source, destination) {
  if (!Array.isArray(routes) || !source || !destination) return null
  return (
    routes.find((r) => {
      if (Number(r.destinationChainId) !== Number(destination.chainId)) return false
      const inputMatches =
        source.kind === 'native' ? r.nativeInput === true : addrEq(r.inputToken, source.address)
      if (!inputMatches) return false
      return destination.address ? addrEq(r.outputToken, destination.address) : true
    }) || null
  )
}

/** The Across deposit id in a mined receipt, or null when no deposit log is present. */
function depositIdFromReceipt(receipt) {
  for (const log of receipt?.logs || []) {
    let parsed
    try {
      parsed = decodeEventLog({ abi: SPOKE_POOL_ABI, topics: [...(log.topics || [])], data: log.data ?? '0x' })
    } catch {
      parsed = null // a log from some other contract in the same transaction
    }
    if (parsed && DEPOSIT_EVENT_NAMES.includes(parsed.eventName)) return String(parsed.args.depositId)
  }
  return null
}

/** Base units → a readable amount, or null when we cannot format it honestly. */
function fmtAmount(raw, decimals, symbol) {
  if (raw == null || decimals == null) return null
  const value = Number(formatUnits(BigInt(raw), decimals))
  return `${value.toLocaleString('en-US', { maximumFractionDigits: Math.min(6, decimals) })} ${symbol}`
}

/**
 * Member-facing copy for a failed quote, by the failure class the quote layer reports.
 * Each class gets the reason that is actually true for it — an operator's decision is
 * never dressed up as an outage, and an outage is never dressed up as a route problem.
 */
function quoteErrorCopy(err) {
  if (!err) return null
  switch (err.code) {
    case 'fee_unavailable':
      return BRIDGE_UNAVAILABLE.fees
    case 'unsupported_chain':
    case 'invalid_route':
      return BRIDGE_UNAVAILABLE.noRoute
    case 'invalid_amount':
      return 'That amount is too small to bridge. Try a larger amount.'
    default:
      return err.disabled ? BRIDGE_UNAVAILABLE.paused : BRIDGE_UNAVAILABLE.gateway
  }
}

export default function BridgeView({ onRecorded } = {}) {
  const { address, chainId } = useWallet() || {}
  // Spec 088 — which account does the switcher say we are? Everything below belongs to the
  // CONNECTED wallet, so anything other than the personal account is refused (see the header).
  const acting = useEffectiveAccount()
  // Catalog mode: a destination network is one the member may hold NOTHING on yet, so the
  // list has to include supported-but-unheld assets. Source options are narrowed below.
  const { options } = useSelectableAssets({ activity: 'transfer', catalog: true })
  const portfolio = usePortfolio()
  const { sendOnChain, canTransactOn, cannotTransactReason, isPasskey } = useEarnSend()
  const { screenOne } = useAddressScreening()

  const [sourceKey, setSourceKey] = useState(null)
  const [destKey, setDestKey] = useState(null)
  const [amountText, setAmountText] = useState('')
  const [inputError, setInputError] = useState(null)
  const [router, setRouter] = useState({ status: 'idle', config: null, readAt: null })
  const [quoteState, setQuoteState] = useState({ status: 'idle', quote: null, error: null })
  const [txState, setTxState] = useState({ step: 'idle', txUrl: null, error: null, note: null })
  const [now, setNow] = useState(() => Date.now())
  // null = not screened yet | 'clear' | 'restricted' | 'uncertain'
  const [screening, setScreening] = useState(null)
  const quoteSeqRef = useRef(0)

  // Quoting is impossible without the gateway and a bridge price cannot be derived
  // client-side (research R10) — so the honest degradation is to say so, not to guess.
  const gatewayReady = bridgeGatewayUrl() !== ''

  // The networks this form may bridge from or to — cohort-bounded (#1265), see the header.
  const bridgeRoster = useMemo(() => bridgeNetworks(), [])
  const bridgeChainIds = useMemo(
    () => new Set(bridgeRoster.map((net) => Number(net.chainId))),
    [bridgeRoster],
  )
  const bridgeOptions = useMemo(
    () => options.filter((o) => isEvmOption(o) && bridgeChainIds.has(Number(o.chainId))),
    [options, bridgeChainIds],
  )
  // FR-066 — Bitcoin is excluded WITH a reason shown below, never silently dropped.
  const hasNonEvmOption = useMemo(() => options.some((o) => !isEvmOption(o)), [options])
  // FR-006c — the same rule for EVM networks this form will not bridge. An asset vanishing
  // from the list with no explanation is the silent-omission failure the requirement exists
  // to prevent, so name the networks — and give each its OWN reason, because the two are not
  // the same fact: the settlement protocol is not deployed on Ethereum Classic or Mordor at
  // all, whereas a network in the other cohort is one this BUILD does not reach (#1265).
  const withheld = useMemo(() => {
    const undeployed = new Set()
    const otherCohort = new Set()
    for (const o of options) {
      if (!isEvmOption(o)) continue
      const id = Number(o.chainId)
      if (bridgeChainIds.has(id)) continue
      const name = NETWORKS[id]?.name || o.networkName || `chain ${id}`
      if (NETWORKS[id]?.capabilities?.bridge) otherCohort.add(name)
      else undeployed.add(name)
    }
    return { undeployed: [...undeployed], otherCohort: [...otherCohort] }
  }, [options, bridgeChainIds])

  // You can only send what you have: unheld catalog rows belong in the DESTINATION list,
  // not the source one. A null balance is "not loaded yet", which is not the same as zero.
  const sourceOptions = useMemo(
    () => bridgeOptions.filter((o) => o.balance == null || o.balance > 0),
    [bridgeOptions],
  )

  // Mirrors UniversalAssetSelect's own fallback so the trigger and this view never
  // disagree about what is selected.
  const source = useMemo(
    () => sourceOptions.find((o) => o.key === sourceKey) || sourceOptions[0] || null,
    [sourceOptions, sourceKey],
  )

  const pin = useMemo(
    () => (source ? createPin(source, PIN_MODE.OTHER_NETWORK_SAME_ASSET) : null),
    [source],
  )

  const routes = router.config?.routes
  const routerPaused = Boolean(router.config?.paused)

  /**
   * The destination predicate. `bridgeDest` FIRST (same asset, different network — FR-063),
   * then the operator's curated, enabled route (FR-005/FR-051): a destination we cannot
   * actually settle to is not offered.
   */
  const destPredicate = useCallback(
    (option, activePin) =>
      bridgeDest(option, activePin) && Boolean(findRouteForPair(routes, source, option)?.enabled),
    [routes, source],
  )

  const destOptions = useMemo(
    () => bridgeOptions.filter((o) => destPredicate(o, pin)),
    [bridgeOptions, destPredicate, pin],
  )
  // Does the member's asset even exist on another network? That distinguishes "no route is
  // open for this pair" from "this asset has nowhere to go", and the two get different
  // answers (FR-065) instead of one vague empty state.
  const symbolElsewhere = useMemo(
    () => bridgeOptions.some((o) => bridgeDest(o, pin)),
    [bridgeOptions, pin],
  )
  const destination = useMemo(
    () => destOptions.find((o) => o.key === destKey) || destOptions[0] || null,
    [destOptions, destKey],
  )

  // Re-pinning (the member changed the source) clears a destination that no longer
  // qualifies, rather than leaving a stale — possibly same-network — choice assembled.
  useEffect(() => {
    setDestKey((prev) => {
      if (!prev) return prev
      const current = bridgeOptions.find((o) => o.key === prev) || null
      return revalidateSelection(current, pin, destPredicate) ? prev : null
    })
  }, [pin, destPredicate, bridgeOptions])

  // ── Router config: the authority on routes, limits, and the pause flag (FR-051) ──
  useEffect(() => {
    const originChainId = source?.chainId
    if (!originChainId || !gatewayReady) {
      setRouter({ status: 'idle', config: null, readAt: null })
      return undefined
    }
    let cancelled = false
    setRouter({ status: 'loading', config: null, readAt: null })
    readBridgeRouterConfig({ chainId: originChainId, provider: readProviderFor(originChainId) })
      .then((config) => {
        if (cancelled) return
        setRouter(
          config
            ? { status: 'ready', config, readAt: Date.now() }
            : { status: 'unavailable', config: null, readAt: Date.now() },
        )
      })
      .catch(() => {
        if (!cancelled) setRouter({ status: 'unavailable', config: null, readAt: Date.now() })
      })
    return () => {
      cancelled = true
    }
  }, [source?.chainId, gatewayReady])

  // ── Screening the ACTING wallet (FR-032) ─────────────────────────────────────────
  // Against the SOURCE network, with that network's own read provider: the wallet may
  // still be on another chain until the signing-time switch, and screening it against
  // the wrong network's guard would be worse than not screening at all.
  useEffect(() => {
    const originChainId = source?.chainId
    if (!address || !originChainId) {
      setScreening(null)
      return undefined
    }
    let cancelled = false
    setScreening(null)
    Promise.resolve(screenOne(address, originChainId, { provider: readProviderFor(originChainId) }))
      .then((status) => {
        if (!cancelled) setScreening(status)
      })
      .catch(() => {
        if (!cancelled) setScreening('uncertain')
      })
    return () => {
      cancelled = true
    }
  }, [address, source?.chainId, screenOne])

  const decimals = source?.decimals ?? null
  const symbol = source?.symbol || ''
  const route = useMemo(() => findRouteForPair(routes, source, destination), [routes, source, destination])

  // `null` = nothing entered, `undefined` = not a number. Same idiom as StakeSheet.
  const amountRaw = useMemo(() => {
    const trimmed = amountText.trim()
    if (!trimmed || decimals == null) return null
    try {
      const parsed = parseUnits(trimmed, decimals)
      return parsed > 0n ? parsed : null
    } catch {
      return undefined
    }
  }, [amountText, decimals])

  // Exact spendable balance from the portfolio's raw reads (the selector's number is a
  // rounded float and must never be what a Max spends).
  const balanceRaw = useMemo(() => {
    if (!source) return null
    const holding = (portfolio.holdings || []).find(
      (h) => `${Number(h.asset.chainId)}:${String(h.asset.id).toLowerCase()}` === source.key,
    )
    return holding?.balanceRaw ?? null
  }, [portfolio.holdings, source])

  // Max on a native coin leaves the same gas reserve staking leaves, so Max never strands
  // the member without the means to pay for the transaction they are about to send.
  const maxRaw = useMemo(() => {
    if (balanceRaw == null) return null
    if (source?.kind !== 'native') return balanceRaw
    return balanceRaw > NATIVE_GAS_RESERVE ? balanceRaw - NATIVE_GAS_RESERVE : 0n
  }, [balanceRaw, source?.kind])

  const destinationNativeRaw = useMemo(() => {
    if (!destination) return null
    const holding = (portfolio.holdings || []).find(
      (h) => Number(h.asset.chainId) === Number(destination.chainId) && h.asset.kind === 'native',
    )
    // Undefined stays null: "we did not read it" is not "you have none" (FR-012).
    return holding?.balanceRaw ?? null
  }, [portfolio.holdings, destination])

  const canQuote = Boolean(
    gatewayReady &&
      route?.enabled &&
      !routerPaused &&
      source &&
      destination &&
      amountRaw != null &&
      amountRaw !== undefined,
  )

  const loadQuote = useCallback(async () => {
    if (!canQuote) return
    const seq = quoteSeqRef.current + 1
    quoteSeqRef.current = seq
    setQuoteState((prev) => ({
      status: prev.quote ? 'refreshing' : 'loading',
      quote: prev.quote,
      error: null,
    }))
    try {
      const quote = await fetchBridgeQuote({
        originChainId: source.chainId,
        destinationChainId: destination.chainId,
        inputToken: route.inputToken,
        outputToken: route.outputToken,
        amount: amountRaw,
        tokenSymbol: symbol,
        decimals,
        recipient: address || null,
        provider: readProviderFor(source.chainId),
        expectedFillSeconds: route.expectedFillSeconds ?? null,
        destinationNativeBalance: destinationNativeRaw,
        // A route delivering the destination's own coin can never strand a member there.
        destinationDeliversGas: destination.kind === 'native',
      })
      if (quoteSeqRef.current !== seq) return
      setNow(Date.now())
      setQuoteState({ status: 'ready', quote, error: null })
    } catch (err) {
      if (quoteSeqRef.current !== seq) return
      setQuoteState({ status: 'error', quote: null, error: err })
    }
  }, [canQuote, source, destination, route, amountRaw, symbol, decimals, address, destinationNativeRaw])

  // The debounce below MUST re-arm only when the quote's actual INPUTS change, so it is
  // keyed on this primitive signature — never on `loadQuote`'s identity. The surrounding
  // hooks rebuild their option objects on unrelated re-renders (a portfolio poll, a
  // balance read), which gives `source`/`destination` fresh identities and `loadQuote` a
  // fresh identity with them; keying the effect on the callback turned every quote
  // completion into a re-render into another fetch, an endless loop that flickered
  // between "getting a price" and the failure copy (issue #1027).
  const quoteKey = canQuote
    ? [
        source.key,
        destination.key,
        route.routeId,
        String(amountRaw),
        address || '',
        // In the signature so a destination balance read landing AFTER the quote still
        // refreshes the FR-012 gas disclosure — a value change, not an identity change.
        String(destinationNativeRaw ?? 'unknown'),
      ].join('|')
    : null
  const loadQuoteRef = useRef(loadQuote)
  useEffect(() => {
    loadQuoteRef.current = loadQuote
  })

  useEffect(() => {
    if (!quoteKey) {
      quoteSeqRef.current += 1 // abandon anything in flight for a route that no longer applies
      setQuoteState({ status: 'idle', quote: null, error: null })
      return undefined
    }
    const timer = setTimeout(() => loadQuoteRef.current(), QUOTE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [quoteKey])

  const quote = quoteState.quote
  const stale = quote ? isQuoteStale(quote, now) : false

  // The countdown only runs while there is a quote to expire.
  useEffect(() => {
    if (!quote) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [quote])

  /**
   * Clear a finished attempt the moment the member starts another one, so the confirm
   * control comes back instead of the previous receipt standing in its place. The sent
   * transfer is not lost by this — it lives in the ledger and in Activity.
   */
  const resetTx = () =>
    setTxState((prev) => (prev.step === 'idle' ? prev : { step: 'idle', txUrl: null, error: null, note: null }))

  const setMax = () => {
    if (maxRaw == null || decimals == null) return
    setAmountText(formatUnits(maxRaw, decimals))
    setInputError(null)
  }

  /**
   * Record the submitted bridge so it survives the member closing the app (FR-010). The
   * ledger is keyed by origin chain + Across `depositId`, which only exists in the mined
   * receipt — so we wait for it. If it never arrives, the transfer is NOT recorded and the
   * member is told plainly that automatic tracking could not start, with the transaction
   * link to follow it themselves. An entry invented without a deposit id would be a
   * transfer the reconciler could never resolve.
   */
  const recordSubmission = useCallback(
    async ({ txHash, originChainId }) => {
      const provider = readProviderFor(originChainId)
      if (!provider || !txHash || !address) return false
      for (let attempt = 0; attempt < RECEIPT_ATTEMPTS; attempt += 1) {
        let receipt
        try {
          receipt = await provider.getTransactionReceipt(txHash)
        } catch {
          receipt = null
        }
        const depositId = receipt ? depositIdFromReceipt(receipt) : null
        if (depositId != null) {
          const fillSeconds = quote?.estimatedFillSeconds ?? route?.expectedFillSeconds ?? null
          return Boolean(
            captureBridgeSubmission(address, originChainId, {
              depositId,
              destinationChainId: destination.chainId,
              srcTxHash: txHash,
              amountRaw: amountRaw.toString(),
              tokenAddress: source.address,
              tokenSymbol: symbol,
              tokenDecimals: decimals,
              feeAmountRaw: quote?.platformFeeRaw ?? null,
              feeBps: quote?.platformFeeBps ?? 0,
              outputAmountRaw: quote?.outputAmount ?? null,
              recipient: address,
              expectedBy: fillSeconds ? Date.now() + fillSeconds * 1000 : null,
              at: Date.now(),
            }),
          )
        }
        if (attempt < RECEIPT_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS))
        }
      }
      return false
    },
    [address, amountRaw, decimals, destination, quote, route, source, symbol],
  )

  const submit = async () => {
    setInputError(null)
    // Spec 088 FR-002 — belt and braces behind the withheld form above: this surface signs with
    // the connected wallet, so it must never sign while the switcher shows another account.
    if (acting.isActingAccount) return setInputError(actingRefusal(acting))
    if (amountRaw === undefined) return setInputError('Enter a valid number.')
    if (amountRaw == null) return setInputError('Enter an amount greater than zero.')
    if (maxRaw != null && amountRaw > maxRaw) {
      return setInputError(
        source.kind === 'native'
          ? `That is more than your ${symbol} on ${source.networkName}, once a little is left behind to pay for the transaction.`
          : `That is more than your ${symbol} balance on ${source.networkName}.`,
      )
    }
    if (!quote) return setInputError('Wait for the quote before confirming.')
    if (stale) return setInputError(BRIDGE_UNAVAILABLE.quoteStale)
    if (!address) {
      return setInputError('This session cannot send transactions right now — please reconnect and try again.')
    }
    if (!canTransactOn(source.chainId)) return setInputError(cannotTransactReason(source.chainId))

    setTxState({ step: 'checking', txUrl: null, error: null, note: null })
    try {
      // FR-032 — the screen BITES HERE, before anything is built or signed, and it is a
      // forced re-read rather than the cached verdict behind the disabled button. A wallet
      // deny-listed between the quote and this tap is refused at this line.
      const verdict = await screenOne(address, source.chainId, {
        provider: readProviderFor(source.chainId),
        force: true,
      })
      setScreening(verdict)
      if (verdict === 'restricted') {
        setTxState({ step: 'error', txUrl: null, error: SCREENING_REFUSAL, note: null })
        return
      }

      // Re-read the route at signing time: an operator may have disabled or re-limited it
      // since the quote, and the member should learn that here rather than from a revert.
      const fresh = await readBridgeRoute({
        chainId: source.chainId,
        provider: readProviderFor(source.chainId),
        inputToken: route.inputToken,
        outputToken: route.outputToken,
        destinationChainId: destination.chainId,
      })
      if (!fresh || !fresh.enabled) {
        setTxState({ step: 'error', txUrl: null, error: BRIDGE_UNAVAILABLE.routeDisabled, note: null })
        return
      }
      if (fresh.maxAmount > 0n && amountRaw > fresh.maxAmount) {
        setTxState({
          step: 'error',
          txUrl: null,
          error: `The most this route moves in one transfer is ${fmtAmount(fresh.maxAmount, decimals, symbol)}. Send a smaller amount, or bridge in more than one go.`,
          note: null,
        })
        return
      }

      const { calls } = buildBridgeCalls({
        routerAddress: router.config.routerAddress,
        route: fresh,
        inputAmount: amountRaw,
        outputAmount: BigInt(quote.outputAmount),
        recipient: address,
        quoteTimestamp: Number(quote.quoteTimestamp),
        fillDeadline: Number(quote.fillDeadline),
        exclusivityDeadline: Number(quote.exclusivityDeadline || 0),
        exclusiveRelayer: quote.exclusiveRelayer || undefined,
        // FR-028 — the rate the member was shown is the ceiling the router enforces.
        maxFeeBps: quote.platformFeeBps,
      })

      const sent = await sendOnChain(source.chainId, calls, {
        onState: ({ step }) =>
          setTxState({
            step: step === 'switching' ? 'switching' : 'confirming',
            txUrl: null,
            error: null,
            note: null,
          }),
      })
      if (sent?.state === 'failed') throw new Error(sent.reason || 'The transaction did not go through.')
      const txHash = sent?.txHash ?? sent?.userOpHash ?? null
      if (!txHash) throw new Error('Submitted, but no transaction reference was returned.')
      const txUrl = sent?.txHash ? getBlockscoutUrl(source.chainId, sent.txHash, 'tx') : null

      setTxState({ step: 'recording', txUrl, error: null, note: null })
      const recorded = await recordSubmission({ txHash, originChainId: source.chainId })
      // A submission we could not read a deposit reference for is NOT a sent bridge. It may be a
      // transaction still waiting for inclusion (routine on the Ethereum family, and the normal
      // outcome for a stalled passkey UserOp), so calling it "sent" would assert a fact the chain
      // has not confirmed. `unconfirmed` says exactly what is known: it left the wallet, and we
      // cannot yet see it land.
      setTxState({
        step: recorded ? 'submitted' : 'unconfirmed',
        txUrl,
        error: null,
        note: recorded
          ? null
          : 'This left your wallet but we cannot yet see it confirmed on the network, so it is not being tracked here. Follow the transaction link — if it confirms, it will start appearing below on your next visit.',
      })
      // Surface it in the in-flight list straight away: a transfer that just happened must not be
      // invisible on the screen that reported it (FR-009/FR-010).
      if (recorded) onRecorded?.()
      setAmountText('')
      setQuoteState({ status: 'idle', quote: null, error: null })
    } catch (err) {
      const rejected = /rejected|denied|cancelled|not allowed|abort/i.test(err?.message || '')
      setTxState({
        step: 'error',
        txUrl: null,
        note: null,
        error: rejected
          ? 'The confirmation was cancelled. Nothing has been sent.'
          : err?.message || 'The transfer could not be sent. Nothing has left your wallet.',
      })
    }
  }

  // ── Honest unavailable states (T083). Read top to bottom: the broadest reason wins. ──
  // The acting account comes FIRST because it is true whatever the network or the gateway is
  // doing: an account this surface cannot act for is not a bridge outage (spec 088).
  const unavailable = (() => {
    if (acting.isActingAccount) return actingRefusal(acting)
    if (isBitcoinNetworkId(chainId)) return BRIDGE_UNAVAILABLE.bitcoin
    if (!gatewayReady) return BRIDGE_UNAVAILABLE.gateway
    return null
  })()

  if (unavailable) {
    return (
      <div className="bridge-root">
        <p
          className="bridge-unavailable"
          role="note"
          data-testid={acting.isActingAccount ? 'bridge-acting-refusal' : undefined}
        >
          {unavailable}
        </p>
      </div>
    )
  }

  const bridgeNetworkNames = bridgeRoster.map((n) => n.name).join(', ')
  // `chainId` is undefined until the wallet resolves. Number(undefined) is NaN and NaN !== x is
  // always true, which made the surface assert "your wallet is on another network" about a wallet
  // it had no reading for — an unknown presented as a known.
  const walletChainKnown = chainId != null && Number.isFinite(Number(chainId))
  const needsSwitch = Boolean(source && walletChainKnown && Number(chainId) !== Number(source.chainId))
  const busy = ['checking', 'switching', 'confirming', 'recording'].includes(txState.step)
  const destNetworkName = destination ? NETWORKS[destination.chainId]?.name || destination.networkName : null
  const quoteError = quoteState.error
  // Across itself says the amount is under the route's minimum — its word, not our guess.
  const amountTooLow = Boolean(quote?.isAmountTooLow)
  // FR-033 — a flagged wallet loses the CONFIRM control and nothing else. The asset and
  // destination selectors, the quote, and the in-flight list below all stay usable, so a
  // restricted member can still see where their money is and take it out.
  const screeningBlocked = screening === 'restricted'
  const canSubmit = Boolean(
    quote && !stale && !amountTooLow && !busy && !routerPaused && route?.enabled && !screeningBlocked,
  )
  // The selector's own empty-list message. It never repeats the block below it verbatim —
  // the same sentence twice reads as a glitch — so the router states are summarised here
  // and explained in full there.
  const destEmptyMessage =
    router.status === 'loading'
      ? 'Checking which networks this asset can be bridged to…'
      : router.status !== 'ready'
        ? 'No destination can be offered until route availability can be read again — see below.'
        : symbolElsewhere
          ? BRIDGE_UNAVAILABLE.noRoute
          : noBridgeDestinationCopy(symbol)

  return (
    <div className="bridge-root">
      {/* FR-066/FR-006c — assets this surface cannot use are named and explained wherever they
          exist, including when they are ALL a member holds. These sit outside the branch below
          because the empty case is exactly when the explanation matters most. */}
      {hasNonEvmOption && (
        <p className="bridge-note" role="note">
          {BRIDGE_UNAVAILABLE.bitcoin}
        </p>
      )}
      {withheld.undeployed.length > 0 && (
        <p className="bridge-note" role="note">
          {/* Short, but still said: FR-066 is about a member not silently missing an asset they
              hold, and one clause carries that as well as three did. */}
          {`Assets on ${withheld.undeployed.join(', ')} are not listed — the bridge protocol is not deployed there.`}
        </p>
      )}
      {withheld.otherCohort.length > 0 && (
        <p className="bridge-note" role="note">
          {/* A different fact from the line above, so it gets its own sentence: the protocol IS
              deployed on these networks, this build simply does not reach them (#1265). */}
          {`Assets on ${withheld.otherCohort.join(', ')} are not listed — this build does not bridge on those networks.`}
        </p>
      )}

      {sourceOptions.length === 0 ? (
        <p className="bridge-unavailable" role="note">
          {bridgeNetworkNames
            ? `You do not hold anything on a network this can bridge from yet. Bridging works from ${bridgeNetworkNames} — receive or buy an asset on one of those networks and it will appear here.`
            : 'No network is set up for bridging in this build yet, so there is nothing to bridge from.'}
        </p>
      ) : (
        <>
          <div className="bridge-field">
            <span className="bridge-label" id="bridge-source-label">
              Asset to send
              {/* "What is bridging?" used to hang off a paragraph above this tab. The paragraph
                  went; the explainer stayed, on the first field a member touches. */}
              <InfoTip label="What is bridging?" className="earn-info">
                {BRIDGE_TIPS.bridge}
              </InfoTip>
            </span>
            <UniversalAssetSelect
              label="Asset to send"
              options={sourceOptions}
              value={source?.key}
              onChange={(option) => {
                setSourceKey(option.key)
                setAmountText('')
                setInputError(null)
                resetTx()
              }}
              disabled={busy}
            />
            {source && (
              <p className="bridge-hint">
                Sending from {source.networkName}
                {balanceRaw != null ? ` · you hold ${fmtAmount(balanceRaw, decimals, symbol)}` : ''}
              </p>
            )}
          </div>

          <div className="bridge-field">
            <span className="bridge-label" id="bridge-destination-label">
              Destination network
              <InfoTip label="About the destination network" className="earn-info">
                {BRIDGE_TIPS.destinationNetwork}
              </InfoTip>
            </span>
            {/* THE INVERSION: bridgeDest, never samePair. See the header. */}
            <UniversalAssetSelect
              label="Destination network"
              options={bridgeOptions}
              value={destination?.key}
              onChange={(option) => {
                setDestKey(option.key)
                setInputError(null)
                resetTx()
              }}
              disabled={busy || router.status !== 'ready'}
              pin={pin}
              pinPredicate={destPredicate}
              pinEmptyMessage={destEmptyMessage}
            />
            <p className="bridge-hint">
              {source ? `${symbol} on ${source.networkName} is pinned as the source — ` : ''}
              the destination is the same asset on another network.
              <InfoTip label="Why the same asset?" className="earn-info">
                {BRIDGE_TIPS.sameAsset}
              </InfoTip>
            </p>
          </div>

          {/* FR-051/FR-052 — availability comes from the router, and is stated as of its read. */}
          {router.status === 'loading' && <p className="bridge-state">Checking which routes are open…</p>}
          {router.status === 'unavailable' && (
            <p className="bridge-unavailable" role="note">
              {BRIDGE_UNAVAILABLE.router}
            </p>
          )}
          {router.status === 'ready' && routerPaused && (
            <p className="bridge-unavailable" role="note">
              {BRIDGE_UNAVAILABLE.paused}
            </p>
          )}
          {router.status === 'ready' && !routerPaused && destination && !route?.enabled && (
            <p className="bridge-unavailable" role="note">
              {BRIDGE_UNAVAILABLE.routeDisabled}
            </p>
          )}
          {router.status === 'ready' && router.config?.routesComplete === false && (
            <p className="bridge-note" role="note">
              Some routes could not be read just now, so this list may be incomplete. Nothing shown
              here is invented — a route that is missing is one we could not confirm.
            </p>
          )}
          {router.status === 'ready' && router.readAt && (
            <p className="bridge-asof">
              Route availability as of{' '}
              {new Date(router.readAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
            </p>
          )}

          <div className="bridge-field">
            <label className="bridge-label" htmlFor="bridge-amount">
              Amount ({symbol})
            </label>
            <div className="earn-amount-input">
              <input
                id="bridge-amount"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amountText}
                disabled={busy}
                onChange={(e) => {
                  setAmountText(e.target.value)
                  setInputError(null)
                  resetTx()
                }}
              />
              <button
                type="button"
                className="earn-btn secondary"
                onClick={setMax}
                disabled={busy || maxRaw == null}
              >
                Max
              </button>
            </div>
            {inputError && (
              <p className="earn-input-error" role="alert">
                {inputError}
              </p>
            )}
          </div>

          {quoteState.status === 'loading' && <p className="bridge-state">Getting a price for this transfer…</p>}
          {quoteState.status === 'error' && quoteError && (
            <div className="bridge-unavailable" role="alert">
              <p>{quoteErrorCopy(quoteError)}</p>
              {quoteError.retryable && (
                <button type="button" className="earn-btn secondary" onClick={loadQuote}>
                  Try again
                </button>
              )}
            </div>
          )}

          {amountTooLow && (
            <p className="bridge-unavailable" role="note">
              This amount is below the minimum this route will move. Try a larger amount.
            </p>
          )}

          {quote && (
            <BridgeQuoteCard
              quote={quote}
              symbol={symbol}
              decimals={decimals}
              stale={stale}
              msRemaining={quoteMsRemaining(quote, now)}
              onRefresh={loadQuote}
              refreshing={quoteState.status === 'refreshing'}
              destinationNetworkName={destNetworkName}
              destinationNativeSymbol={
                destination ? NETWORKS[destination.chainId]?.nativeCurrency?.symbol || null : null
              }
            />
          )}

          {/* FR-061 (T151) — the switch is disclosed BEFORE the signature, never demanded
              as a prerequisite the member has to go and perform first. */}
          {needsSwitch && (
            <p className="bridge-switch-note" role="note">
              Your wallet is on {NETWORKS[chainId]?.name || 'another network'}. It will switch to{' '}
              {source.networkName} when you confirm — you do not need to change networks yourself.
              <InfoTip label="About the network switch" className="earn-info">
                {BRIDGE_TIPS.networkSwitch}
              </InfoTip>
            </p>
          )}

          {source && !canTransactOn(source.chainId) && (
            <p className="bridge-note" role="note">
              {cannotTransactReason(source.chainId)}
            </p>
          )}

          {/* FR-032/FR-033 — the verdict, stated. 'restricted' refuses the transfer and says
              what is not refused; 'uncertain' is disclosed as an unknown and blocks nothing,
              because the guard is not deployed on every bridgeable network. */}
          {screeningBlocked && (
            <p className="bridge-unavailable" role="alert" data-testid="bridge-screening-refusal">
              {SCREENING_REFUSAL}
            </p>
          )}
          {screening === 'uncertain' && quote && (
            <p className="bridge-note" role="note" data-testid="bridge-screening-unavailable">
              {SCREENING_UNAVAILABLE}
            </p>
          )}

          {txState.step === 'error' && (
            <p className="earn-input-error" role="alert">
              {txState.error}
            </p>
          )}

          {txState.step === 'submitted' || txState.step === 'unconfirmed' ? (
            <div className="bridge-submitted" role="status">
              <p>
                {txState.step === 'submitted' ? (
                  <>
                    {/* Points at the list directly below, which is where this transfer IS visible.
                        The Activity feed does not carry bridge entries until the ledger source is
                        registered (US3/T105), and naming a surface that cannot show it would be the
                        same class of dishonesty as a silent spinner. */}
                    Sent from {source.networkName}. It is not delivered until{' '}
                    {destNetworkName || 'the destination network'} confirms it — follow its progress
                    in the list below.
                  </>
                ) : (
                  <>
                    Submitted from {source.networkName}. We cannot yet see it confirmed on the
                    network, so nothing has been delivered and nothing is being tracked here yet.
                  </>
                )}
                <InfoTip label="How progress is tracked" className="earn-info">
                  {BRIDGE_TIPS.progress}
                </InfoTip>
              </p>
              {txState.note && <p className="bridge-note">{txState.note}</p>}
              {txState.txUrl && (
                <a href={txState.txUrl} target="_blank" rel="noopener noreferrer">
                  View the sending transaction ↗
                </a>
              )}
            </div>
          ) : (
            <button
              type="button"
              className="earn-btn primary earn-submit"
              onClick={submit}
              disabled={!canSubmit}
            >
              {txState.step === 'switching'
                ? `Switching to ${source.networkName}…`
                : txState.step === 'confirming'
                  ? isPasskey
                    ? 'Confirm with your passkey…'
                    : 'Waiting for confirmation…'
                  : txState.step === 'checking'
                    ? 'Checking the route…'
                    : txState.step === 'recording'
                      ? 'Recording your transfer…'
                      : stale
                        ? 'Refresh the quote to confirm'
                        : `Bridge ${symbol}`}
            </button>
          )}
        </>
      )}

      {/* FR-013/FR-014 — non-custodial, and the third party that settles it, in the open. */}
      <p className="bridge-disclosure" role="note">
        {BRIDGE_DISCLOSURE}
        <InfoTip label="Who holds my asset?" className="earn-info">
          {BRIDGE_TIPS.nonCustodial}
        </InfoTip>
      </p>
    </div>
  )
}
