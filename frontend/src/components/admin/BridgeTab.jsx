/**
 * BridgeTab (spec 067, US4) — the operator control surface for cross-chain bridging.
 *
 * One screen per network for the on-chain `BridgeRouter`:
 *   - Status + emergency pause / resume of new bridges — GUARDIAN_ROLE (FR-043/FR-044).
 *   - Curated routes: add, edit, enable, disable, remove, per-transaction limits, and bulk
 *     enable/disable per destination — LIQUIDITY_ADMIN_ROLE (FR-041/FR-045, SC-017).
 *   - Protocol addresses (Across SpokePool, FeeRouter, sanctions guard) with the current value
 *     beside the input and invalid input refused with a reason BEFORE the wallet prompt (FR-042).
 *   - The `bridge.transfer` platform fee — READ-ONLY here; rates live on the FeeRouter and are
 *     edited in the Fees tab by a FEE_ADMIN (spec 060, FR-048).
 *   - Operations: what is in flight, what is past its expected window, what recently delivered
 *     or came back, and whether the quoting gateway is up (FR-047).
 *   - Decoded on-chain change history — the audit trail (FR-046).
 *
 * ---------------------------------------------------------------------------------------------
 * TWO THINGS THIS TAB MUST NOT IMPLY.
 *
 * 1. **Scope is a NETWORK, not the connected wallet.** Bridge control state exists on five
 *    networks at once (FR-050). Reads here span all of them from each network's own RPC; only
 *    WRITES need the wallet on the selected network, and the tab says so rather than showing a
 *    dead button. An operator must never conclude "no routes are configured" from being
 *    connected somewhere else.
 *
 * 2. **The Operations panel is OBSERVATIONAL ONLY.** There is no operator action — here or in
 *    the contract — that can touch a member's in-flight bridge. Across settles directly to the
 *    member and the router is not in that path, which is exactly why `IBridgeRouter` has no
 *    rescue or claim-refund function. Pausing stops NEW bridges; it cannot reach one already
 *    moving, and it cannot strand one either. The panel states this so nobody spends an incident
 *    hunting for a button that was deliberately never built.
 * ---------------------------------------------------------------------------------------------
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { eventScanHandle } from '../../lib/chains/eventScan'
import { getLogsRange } from '../../lib/chains/logRange'
import { getPublicClient } from '../../lib/chains/publicClient'
import { getAddress } from '../../lib/evm/address'
import { getContractAddressForChain } from '../../config/contracts'
import { BRIDGE_ROUTER_ABI } from '../../abis/BridgeRouter'
import { FEE_SERVICES, fetchFeeQuote } from '../../lib/fees/feeQuote'
import { getBlockscoutUrl, getTransactionUrl } from '../../config/blockExplorer'
import { useGatewayStatus } from '../../hooks/useGatewayStatus'
import { BRIDGE_SETTLEMENT, bridgeStateCopy } from '../../lib/bridge/bridgeCopy'
import { decodeEventLog, toEventSelector } from 'viem'
import { SPOKE_POOL_ABI, deriveBridgeState, evidenceFromGatewayStatus, fetchBridgeStatus } from '../../lib/bridge/bridgeStatus'
import { BRIDGE_STATE } from '../../data/ledger/sources/bridgeLedgerSource'
import { FeeRateCard, HistoryCard, NetworkScopeCard, WriteScopeNotice } from './liquidityAdminCards'
import {
  adminNetworks,
  authorityGates,
  formatAmount,
  formatDuration,
  formatLimit,
  isValidAddr,
  limitUnitLabel,
  loadRouterHistory,
  networkName,
  parseLimit,
  readProviderFor,
  readRouterAuthority,
  shortAddr,
  tokenLabel,
} from './liquidityAdminCommon'

/** Config events this router emits — the audit trail (FR-046). */
const HISTORY_EVENTS = [
  'RouteSet',
  'RouteEnabledChanged',
  'RouteLimitChanged',
  'RouteRemoved',
  'SpokePoolUpdated',
  'FeeRouterUpdated',
  'SanctionsGuardUpdated',
  'Paused',
  'Unpaused',
]

/** Bounds on a route's advisory delivery window — mirrors BridgeRouter's own constants. */
const MIN_FILL_SECONDS = 60
const MAX_FILL_SECONDS = 86_400

/**
 * The Operations scan is deliberately bounded, in two stages.
 *
 * `OPS_SCAN_LIMIT` bridges get a block-timestamp read, which is cheap, so lateness can be computed
 * across a wider slice than the panel shows. `OPS_LIMIT` rows are then displayed — the late ones
 * first — and only those pay the expensive per-row costs: a receipt read (to recover the Across
 * deposit id from the SpokePool log in the same transaction) and, when the gateway is up, a status
 * request. What the panel had to drop is stated in the footnote; the explorer link answers the rest.
 */
const OPS_LOOKBACK_BLOCKS = 50_000
const OPS_SCAN_LIMIT = 40
const OPS_LIMIT = 10

const safe = (p) => p.then((v) => v).catch(() => undefined)

/** Topic hashes for BOTH Across deposit vocabularies — see SPOKE_POOL_ABI. */
const DEPOSIT_TOPICS = new Set(
  ['V3FundsDeposited', 'FundsDeposited'].map((n) =>
    toEventSelector(SPOKE_POOL_ABI.find((i) => i.type === 'event' && i.name === n)),
  ),
)

export default function BridgeTab({
  signer,
  account,
  chainId,
  provider,
  runTx,
  pendingTx,
  onOpenFees,
}) {
  const networks = useMemo(() => adminNetworks('bridge'), [])
  const [scopeChainId, setScopeChainId] = useState(
    () => (networks.some((n) => n.chainId === chainId) ? chainId : networks[0]?.chainId) ?? null,
  )

  // ── AUTHORITY IS READ FROM THE ROUTER IN SCOPE, NOT FROM THE APP-WIDE ROLE FLAGS ──────────────
  // The `isAdmin`/`isGuardian`/`isLiquidityAdmin` props are a coarse entry signal: they answer "is
  // this operator an admin of SOMETHING on the wallet's chain", which is not the question a control
  // on this tab needs answered. GUARDIAN_ROLE on the WagerRegistry is not GUARDIAN_ROLE on this
  // BridgeRouter; LIQUIDITY_ADMIN on the LiquidityRouter is not authority over bridge routes; and
  // the wallet's chain is not the network in scope. So every gate below comes from asking THIS
  // router on THIS network — see readRouterAuthority for the full account of what went wrong.
  const [authority, setAuthority] = useState(null) // null = not yet asked
  const gates = authorityGates(authority)
  const canConfig = gates.config
  const canPause = gates.pause
  // Address writes are DEFAULT_ADMIN_ROLE on the contract, a role ABOVE curation: `spokePool` and
  // `feeRouter` decide where member funds and fees go, so they are not a route-curation power.
  // Unconfirmed authority stays permissive here for the same reason it does elsewhere — the contract
  // is the gate, and a false "you cannot" is as misleading as a false "you can".
  const canWire = Boolean(authority?.admin || gates.unconfirmed)
  const onScopeNetwork = Number(scopeChainId) === Number(chainId)
  const canSubmit = Boolean(signer) && onScopeNetwork && !pendingTx

  const routerAddr = getContractAddressForChain('bridgeRouter', scopeChainId)
  const readProvider = useMemo(
    () => readProviderFor(scopeChainId, chainId, provider),
    [scopeChainId, chainId, provider],
  )

  const [state, setState] = useState(null) // null = loading
  const [readError, setReadError] = useState(null)
  const [lastReadAt, setLastReadAt] = useState(null)
  const [fee, setFee] = useState(undefined) // undefined = loading
  const [history, setHistory] = useState({ entries: null, error: null })
  const [ops, setOps] = useState({ rows: null, error: null })
  const [formError, setFormError] = useState(null)
  const [forms, setForms] = useState({
    inputToken: '',
    outputToken: '',
    destinationChainId: '',
    maxAmount: '0',
    expectedFillSeconds: '900',
    nativeInput: false,
    enabled: true,
    spokePool: '',
    feeRouter: '',
    sanctionsGuard: '',
  })
  const [limitDrafts, setLimitDrafts] = useState({})

  const gateway = useGatewayStatus()

  /**
   * Reads are bound to the SCOPED chain; `readProvider` stays the availability gate.
   *
   * That gate matters more here than on a cohort-bounded tab: `readProviderFor` in
   * `liquidityAdminCommon` passes `requireCohort: false` ON PURPOSE (these routers live only on
   * mainnets, so a testnet build would otherwise blank both tabs), so its null means the chain has
   * no endpoint at all rather than that the cohort refused it.
   */
  const routerRead = useMemo(() => {
    if (!routerAddr || !readProvider) return null
    return (functionName, args = []) =>
      readContract(scopeChainId, {
        address: routerAddr,
        abi: BRIDGE_ROUTER_ABI,
        functionName,
        args,
      })
  }, [routerAddr, readProvider, scopeChainId])

  const write = useCallback(
    (functionName, args = []) =>
      signer.sendTransaction({
        to: routerAddr,
        data: encodeFunctionData({
          abi: normalizeAbi(BRIDGE_ROUTER_ABI),
          functionName,
          args,
        }),
      }),
    [routerAddr, signer],
  )

  /* -------------------------------------------------------------------------------- reads */

  const fetchState = useCallback(async () => {
    if (!routerRead) {
      setState(null)
      return
    }
    try {
      setReadError(null)
      // CLEARED BEFORE THE NEW NETWORK IS READ, not after. `setState` only fires on success, so
      // without this the PREVIOUS network's pause banner, table and counts keep rendering under the
      // newly-selected network's name — with an "as of" timestamp that looks current. On a public RPC
      // that window is a full round-trip, and it fails in the direction that reads as safe: an
      // operator pausing network A, switching to B and seeing A's PAUSED banner moves on believing B
      // is stopped (FR-050 no-mixing, FR-052 as-of).
      setState(null)
      setLastReadAt(null)
      // `paused` is load-bearing: a router we cannot even ask about is reported as unreadable,
      // never as "not paused" (FR-051 — withhold, never invent).
      const paused = await routerRead('paused')
      const [spokePool, feeRouter, sanctionsGuard, maxFeeBps, count] = await Promise.all([
        safe(routerRead('spokePool')),
        safe(routerRead('feeRouter')),
        safe(routerRead('sanctionsGuard')),
        safe(routerRead('MAX_FEE_BPS')),
        safe(routerRead('routeCount')),
      ])

      const routes = []
      let routesComplete = count !== undefined
      if (count !== undefined) {
        const n = Number(count)
        const ids = await Promise.all(Array.from({ length: n }, (_, i) => safe(routerRead('routeAt', [BigInt(i)]))))
        const raws = await Promise.all(ids.map((id) => (id ? safe(routerRead('getRoute', [id])) : Promise.resolve(undefined))))
        for (let i = 0; i < n; i += 1) {
          const id = ids[i]
          const raw = raws[i]
          if (!id || raw === undefined) {
            routesComplete = false
            continue
          }
          routes.push({
            routeId: id,
            inputToken: raw.inputToken,
            outputToken: raw.outputToken,
            destinationChainId: Number(raw.destinationChainId),
            maxAmount: BigInt(raw.maxAmount ?? 0n),
            expectedFillSeconds: Number(raw.expectedFillSeconds ?? 0),
            enabled: Boolean(raw.enabled),
            nativeInput: Boolean(raw.nativeInput),
          })
        }
      }

      setState({
        spokePool,
        feeRouter,
        sanctionsGuard,
        maxFeeBps: maxFeeBps === undefined ? null : Number(maxFeeBps),
        paused: Boolean(paused),
        routes,
        routesComplete,
      })
      setLastReadAt(new Date())
    } catch (e) {
      setState(null)
      setReadError(
        `Could not read the BridgeRouter on ${networkName(scopeChainId)}: ${e?.message || e}. Nothing below can be trusted as current until this clears.`,
      )
    }
  }, [routerRead, scopeChainId])

  // THE RATE IS QUOTED FROM THE FEE ROUTER THIS ROUTER ACTUALLY HOLDS, NOT FROM THIS BUILD'S CONFIG.
  //
  // `fetchFeeQuote` defaults to the configured address, which is right for members but wrong here:
  // the contract that will charge them is whatever `BridgeRouter.feeRouter()` returns right now, and the
  // two diverge in exactly the window an operator most needs the truth — after someone repoints the
  // router and before the config ships, or the reverse. Quoting the config address there reports a
  // rate (or a confident "no fee") from a contract that is not in the path.
  //
  // `liveFeeRouter` is read in fetchState; until it resolves there is nothing to quote FROM, so this
  // waits rather than falling back to the config address and printing a figure it cannot stand behind.
  const liveFeeRouter = state?.feeRouter
  const fetchFee = useCallback(async () => {
    if (!routerAddr || !readProvider || !liveFeeRouter) return
    setFee(undefined)
    try {
      const quote = await fetchFeeQuote({
        serviceId: FEE_SERVICES.BRIDGE_TRANSFER,
        chainId: scopeChainId,
        provider: readProvider,
        routerAddress: liveFeeRouter,
      })
      // A mismatch is not an error — it is a real, temporary state — but it means the MEMBER surface
      // is quoting a different contract than the one charging, so the card says so.
      const configured = getContractAddressForChain('feeRouter', scopeChainId)
      setFee({
        ...quote,
        configuredRouterAddress: configured || null,
        configMismatch:
          Boolean(configured) && configured.toLowerCase() !== String(liveFeeRouter).toLowerCase(),
      })
    } catch (e) {
      // A configured-but-unreadable FeeRouter is NOT a zero rate. It blocks the member's
      // fee-bearing path, and this card has to say which of the two it is (FR-048/FR-051).
      setFee({ failed: true, reason: e?.message || String(e) })
    }
  }, [routerAddr, readProvider, scopeChainId, liveFeeRouter])

  const fetchHistory = useCallback(async () => {
    if (!routerAddr || !readProvider) return
    setHistory({ entries: null, error: null })
    setHistory(
      await loadRouterHistory({
        chainId: scopeChainId,
        address: routerAddr,
        abi: BRIDGE_ROUTER_ABI,
        provider: readProvider,
        eventNames: HISTORY_EVENTS,
        describe: describeBridgeEvent(scopeChainId),
      }),
    )
  }, [routerAddr, readProvider, scopeChainId])

  /**
   * Operations (FR-047).
   *
   * The router emits `BridgeInitiated` for every member bridge, and the Across SpokePool emits
   * its deposit event in the SAME transaction — so the deposit id can be recovered from the
   * receipt and handed to the gateway's status endpoint. That join is the only way an operator
   * can see delivery at all, because delivery happens on ANOTHER network, straight to the
   * member, with this contract nowhere in the path.
   *
   * Every step degrades on its own: no receipt ⇒ no deposit id ⇒ no status ⇒ the row still
   * shows what was initiated and how long ago, and the panel says delivery is not observable
   * from here. Nothing is ever guessed into "delivered".
   */
  const fetchOps = useCallback(async () => {
    if (!routerAddr || !readProvider || !state) return
    setOps({ rows: null, error: null })
    try {
      const handle = eventScanHandle(scopeChainId, { address: routerAddr, abi: BRIDGE_ROUTER_ABI })
      const client = getPublicClient(scopeChainId)
      if (!handle || !client) return
      const latest = Number(await handle.provider.getBlockNumber())
      const fromBlock = Math.max(0, latest - OPS_LOOKBACK_BLOCKS)
      // Bisects on refusal: a public RPC that caps `eth_getLogs` used to make this panel say it
      // could not look, on every scan.
      const logs = await getLogsRange(
        handle.provider,
        routerAddr,
        fromBlock,
        latest,
        2000,
        handle.filters.BridgeInitiated().getTopicFilter(),
      )
      const evs = logs.map((log) => ({ ...log, args: handle.interface.parseLog(log).args }))
      const ordered = [...evs].sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index)

      const byRouteId = new Map((state.routes || []).map((r) => [r.routeId, r]))
      const now = Date.now()

      // ── WHAT IS LATE OUTRANKS WHAT IS RECENT ─────────────────────────────────────────────────
      // This used to be a plain "ten most recent". The panel's whole job is to answer "is anything
      // stuck right now", and on a busy network ten bridges is minutes — so a stuck transfer was
      // pushed out of the list before its own delivery window had even expired, by the newer
      // transfers that were fine. Timestamps are read for a wider slice first (cheap), lateness is
      // computed from each route's advisory window, and the late rows are kept AHEAD of newer ones.
      // The costly per-row work — a receipt read to recover the Across deposit id, and a gateway
      // status request — still happens only for the rows actually shown.
      const scanned = ordered.slice(0, OPS_SCAN_LIMIT)
      const timed = await Promise.all(
        scanned.map(async (ev) => {
          const block = await safe(client.getBlock({ blockNumber: BigInt(ev.blockNumber) }))
          const at = block ? Number(block.timestamp) * 1000 : null
          const route = byRouteId.get(ev.args?.routeId)
          // A route that is no longer curated (removed, or missing from a partial read) has no
          // advisory window, so lateness is UNKNOWN for its transfers rather than false. Reporting
          // `late: false` there silently exonerated exactly the transfers an operator had just
          // removed a misbehaving route over.
          const windowUnknown = !route?.expectedFillSeconds
          const expectedBy = at && !windowUnknown ? at + route.expectedFillSeconds * 1000 : null
          return { ev, at, route, windowUnknown, expectedBy, late: Boolean(expectedBy && now >= expectedBy) }
        }),
      )
      const attention = timed.filter((r) => r.late || r.windowUnknown)
      const rest = timed.filter((r) => !r.late && !r.windowUnknown)
      const picked = [...attention, ...rest].slice(0, OPS_LIMIT)
      const hidden = timed.length - picked.length + Math.max(0, ordered.length - scanned.length)

      const rows = await Promise.all(
        picked.map(async ({ ev, at, route, windowUnknown, expectedBy, late }) => {
          const depositId = await readDepositId(readProvider, ev.transactionHash)
          let status
          if (depositId != null && gateway.configured) {
            status = await safe(fetchBridgeStatus({ originChainId: Number(scopeChainId), depositId }))
          }

          const evidence = status ? evidenceFromGatewayStatus(status) : {}
          const derived = deriveBridgeState({
            // The router event only exists in a mined, successful transaction, so the origin
            // side is already confirmed. Everything above that needs evidence.
            current: BRIDGE_STATE.SOURCE_CONFIRMED,
            evidence,
            expectedBy,
            now,
          })

          return {
            key: `${ev.transactionHash}-${ev.index}`,
            txHash: ev.transactionHash,
            routeId: ev.args?.routeId,
            member: ev.args?.member,
            recipient: ev.args?.recipient,
            destinationChainId: Number(ev.args?.destinationChainId ?? 0),
            grossAmount: ev.args?.grossAmount,
            feeAmount: ev.args?.feeAmount,
            inputToken: route?.inputToken ?? null,
            at,
            expectedBy,
            windowUnknown,
            late,
            depositId: depositId == null ? null : String(depositId),
            observed: Boolean(status),
            state: derived.state,
            dstTxHash: derived.dstTxHash,
            refundTxHash: derived.refundTxHash,
          }
        }),
      )
      setOps({ rows, error: null, scanned: timed.length, found: ordered.length, hidden })
    } catch (e) {
      setOps({ rows: [], error: e?.message || String(e) })
    }
  }, [routerAddr, readProvider, state, gateway.configured, scopeChainId])

  // ── THE FEE QUOTE GETS ITS OWN EFFECT (same fix as SupplyTab, #1031) ──────────────────────────
  //
  // Sharing one effect fed `fetchState` back into itself:
  //
  //   fetchState() clears `state` first (deliberately — the FR-050 network-switch honesty rule)
  //     → `liveFeeRouter` (= state?.feeRouter, :251) flips to undefined
  //     → `fetchFee`, which lists it as a dependency (:276), gets a new identity
  //     → this effect re-runs → fetchState() again → …
  //
  // Not a bounded over-fetch: a loop with a period of one RPC round-trip, running for as long as
  // the tab is open. Measured HERE, over one second against a mock costing a macrotask (the count
  // scales with round-trip latency, so treat it as an order of magnitude, not a constant):
  // `paused()` 141 -> 1, `queryFilter` 1312 -> 1. Worse than the SupplyTab case because `fetchOps`
  // depends on the whole `state` object (:388) and is dragged along each lap, each pass carrying
  // per-row getBlock, receipt reads and gateway status calls.
  //
  // The quote SHOULD re-run when the router repoints its FeeRouter, so the dependency stays; only
  // the coupling back into `fetchState` is severed.
  useEffect(() => {
    fetchState()
    fetchHistory()
  }, [fetchState, fetchHistory])

  useEffect(() => {
    fetchFee()
  }, [fetchFee])

  useEffect(() => {
    fetchOps()
  }, [fetchOps])

  // Re-asked whenever the ROUTER or the NETWORK changes, because the answer is a property of both.
  useEffect(() => {
    let live = true
    setAuthority(null)
    readRouterAuthority({ chainId: scopeChainId, provider: readProvider, routerAddress: routerAddr, account }).then((a) => {
      if (live) setAuthority(a)
    })
    return () => {
      live = false
    }
  }, [readProvider, routerAddr, account, scopeChainId])

  const refresh = () => {
    fetchState()
    fetchFee()
    fetchHistory()
    gateway.refresh()
  }

  /* ------------------------------------------------------------------------------- writes */

  const togglePause = () => {
    const fn = state?.paused ? 'unpause' : 'pause'
    runTx(() => write(fn), state?.paused ? 'Bridging resumed' : 'New bridges paused').then(refresh)
  }

  const submitRoute = () => {
    setFormError(null)
    const destination = Number(forms.destinationChainId)
    const fill = Number(forms.expectedFillSeconds)
    if (!isValidAddr(forms.inputToken) || !isValidAddr(forms.outputToken)) {
      setFormError('Both the sent asset and the delivered asset must be valid, non-zero token addresses.')
      return
    }
    if (!Number.isInteger(destination) || destination <= 0 || destination === Number(scopeChainId)) {
      setFormError('Choose a destination network — it cannot be the network this router is on.')
      return
    }
    if (!Number.isInteger(fill) || fill < MIN_FILL_SECONDS || fill > MAX_FILL_SECONDS) {
      setFormError(`The expected delivery window must be between ${MIN_FILL_SECONDS} and ${MAX_FILL_SECONDS} seconds — the contract refuses anything outside that.`)
      return
    }
    let maxAmount
    try {
      maxAmount = parseLimit(scopeChainId, forms.inputToken, forms.maxAmount)
    } catch (e) {
      setFormError(e.message)
      return
    }
    runTx(
      () =>
        write('setRoute', [
          {
            // Normalised through `getAddress` (divergence 16): `isValidAddr` now reproduces
            // ethers' rule and ACCEPTS an all-uppercase address, which viem's encoder refuses.
            // The two halves have to move together or the validator passes something the encoder
            // then throws on.
            inputToken: getAddress(forms.inputToken.trim()),
            enabled: Boolean(forms.enabled),
            nativeInput: Boolean(forms.nativeInput),
            expectedFillSeconds: fill,
            outputToken: getAddress(forms.outputToken.trim()),
            destinationChainId: destination,
            maxAmount,
          },
        ]),
      `Route to ${networkName(destination)} saved`,
    ).then(refresh)
  }

  const setRouteEnabled = (route, enabled) =>
    runTx(
      () => write('setRouteEnabled', [route.routeId, enabled]),
      `Route to ${networkName(route.destinationChainId)} ${enabled ? 'enabled' : 'disabled'}`,
    ).then(refresh)

  /**
   * Delete a route's curation entirely.
   *
   * ── WHY THIS ASKS AND "DISABLE" DOES NOT ───────────────────────────────────────────────────────
   * Both stop new bridges on the route. Disable is a flag the adjacent button flips straight back;
   * removal deletes the entry, so restoring it means re-entering every field, and until then the
   * Operations panel below loses the route's advisory delivery window — which is how it decides that
   * an in-flight transfer is taking too long. During an incident "Remove" looks like the harder,
   * safer version of "Disable", and it is the one that degrades the panel you are watching. So the
   * confirm names that consequence rather than asking "are you sure".
   */
  const removeRoute = (route) => {
    const inFlight = (ops.rows || []).filter((r) => r.routeId === route.routeId).length
    const dest = networkName(route.destinationChainId)
    const asset = tokenLabel(scopeChainId, route.inputToken)
    const ok = window.confirm(
      `Remove the ${asset} → ${dest} route?\n\n` +
        'This deletes the curation entry, not just its availability. Disabling stops new bridges too and is one click to undo; ' +
        'after removal the route has to be re-entered field by field.\n\n' +
        `Transfers already moving on it are unaffected — Across settles those directly to the member — but the Operations panel loses this route's expected delivery window, so it can no longer flag them as late${inFlight > 0 ? `, and ${inFlight} ${inFlight === 1 ? 'transfer is' : 'transfers are'} currently listed on it` : ''}.\n\n` +
        'To stop new bridges reversibly, cancel and use Disable instead.',
    )
    if (!ok) return
    return runTx(
      () => write('removeRoute', [route.routeId]),
      `Route to ${dest} removed`,
    ).then(refresh)
  }

  const applyLimit = (route) => {
    setFormError(null)
    let value
    try {
      value = parseLimit(scopeChainId, route.inputToken, limitDrafts[route.routeId])
    } catch (e) {
      setFormError(e.message)
      return
    }
    runTx(() => write('setRouteLimit', [route.routeId, value]), 'Per-transaction maximum updated').then(refresh)
  }

  /**
   * Bulk enable/disable every route to one destination.
   *
   * One transaction per route, run in order — the contract has no batch setter and inventing a
   * client-side "batch" that fires several wallet prompts at once would be worse. The button
   * says how many transactions it will ask for.
   */
  const bulkSetEnabled = async (destination, enabled) => {
    setFormError(null)
    const targets = (state?.routes || []).filter(
      (r) => r.destinationChainId === destination && r.enabled !== enabled,
    )
    for (const [i, route] of targets.entries()) {
      // STOPS ON THE FIRST FAILURE, INCLUDING A REJECTED PROMPT.
      //
      // This comment used to claim that while `runTx` swallowed every error and resolved with no
      // signal, so the loop ran to the end regardless: an operator who clicked "Disable all (5 tx)"
      // on the wrong destination and rejected the first prompt to abort got the other four anyway,
      // and any they accepted by reflex disabled a live route. `runTx` now resolves false on failure
      // and this checks it — rejecting the first prompt IS the cancel.
      const ok = await runTx(
        () => write('setRouteEnabled', [route.routeId, enabled]),
        `Route ${tokenLabel(scopeChainId, route.inputToken)} → ${networkName(destination)} ${enabled ? 'enabled' : 'disabled'}`,
      )
      if (!ok) {
        const done = i
        const left = targets.length - i
        setFormError(
          `Stopped after ${done} of ${targets.length} ${done === 1 ? 'change' : 'changes'} — the last transaction was refused or rejected, so the remaining ${left} ${left === 1 ? 'route was' : 'routes were'} left untouched. The table below shows what actually changed.`,
        )
        break
      }
    }
    refresh()
  }

  const setAddress = (fn, value, label) => {
    setFormError(null)
    if (!isValidAddr(value)) {
      setFormError(`Enter a valid, non-zero address for the ${label} — the contract rejects malformed and zero addresses.`)
      return
    }
    // A fund-path address (spokePool / feeRouter / sanctionsGuard). Repointing one is the change
    // this repo's guardrails call out as not reversible, so it is normalised, not just validated.
    runTx(() => write(fn, [getAddress(value.trim())]), `${label} updated`).then(refresh)
  }

  /* ------------------------------------------------------------------------------- render */

  if (!scopeChainId) {
    return (
      <div className="admin-tab-content" role="tabpanel">
        <div className="admin-card">
          <h3>Bridge Controls</h3>
          <p className="card-info">
            No network in this build carries an Across deployment, so there is nothing to control
            here. Bridging is hidden for members on every network (FR-006c).
          </p>
        </div>
      </div>
    )
  }

  const destinations = networks.filter((n) => n.chainId !== Number(scopeChainId))
  const destinationsWithRoutes = destinations
    .map((net) => {
      const routes = (state?.routes || []).filter((r) => r.destinationChainId === net.chainId)
      return { net, total: routes.length, enabled: routes.filter((r) => r.enabled).length }
    })

  return (
    <div className="admin-tab-content" role="tabpanel">
      <NetworkScopeCard
        title="Bridge Controls"
        description={`Routes, limits, addresses and the pause for one network's BridgeRouter. Transfers are settled by ${BRIDGE_SETTLEMENT.protocol} — FairWins never holds a member's asset in transit.`}
        networks={networks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('bridgeRouter', id))}
        walletChainId={chainId}
        onRefresh={refresh}
        lastReadAt={routerAddr ? lastReadAt : null}
      >
        {routerAddr && (
          <div className="status-details">
            <div className="status-row">
              <span className="status-label">BridgeRouter</span>
              <span className="status-value">
                <code title={routerAddr}>{shortAddr(routerAddr)}</code>
              </span>
            </div>
            <div className="status-row">
              <span className="status-label">New bridges</span>
              <span className="status-value">
                {state == null ? (
                  '…'
                ) : state.paused ? (
                  <span className="status-value paused">
                    PAUSED — no new bridges start. Transfers already moving are unaffected.
                  </span>
                ) : (
                  'active'
                )}
              </span>
            </div>
            <div className="status-row">
              <span className="status-label">Curated routes</span>
              <span className="status-value">
                {state == null
                  ? '…'
                  : `${state.routes.length} (${state.routes.filter((r) => r.enabled).length} enabled)${state.routesComplete ? '' : ' — partial read, some routes could not be loaded'}`}
              </span>
            </div>
          </div>
        )}
        {readError && (
          <p className="card-info error" role="alert">
            {readError}
          </p>
        )}
      </NetworkScopeCard>

      {!routerAddr ? (
        <div className="admin-card">
          <h3>Not deployed on {networkName(scopeChainId)}</h3>
          <p className="card-info">
            No BridgeRouter is deployed on {networkName(scopeChainId)}, so there is nothing to
            control here and members are shown no bridge on this network — an honest absence, not
            a broken surface. Deploy it with{' '}
            <code>scripts/deploy/deploy-bridge-liquidity.js</code>, then pick another network above
            to manage one that is live.
          </p>
        </div>
      ) : (
        <>
          <WriteScopeNotice
            scopeChainId={scopeChainId}
            walletChainId={chainId}
            signer={signer}
            canWrite={canConfig || canPause}
          />

          {/*
            THE CARD IS ALWAYS RENDERED, INCLUDING WHEN THIS OPERATOR CANNOT USE IT.

            It used to be hidden behind the authority check. During an incident that reads as "this
            network has no killswitch" — the operator stops looking and starts improvising, which is
            the worst possible outcome of a permission check. So the card states that the killswitch
            exists, and says separately whether THIS account can pull it and where the role comes
            from if not (FR-043/FR-044).
          */}
          <div className="admin-card">
            <h3>Emergency pause</h3>
            <p>
              Pausing stops <strong>new</strong> bridges on {networkName(scopeChainId)}{' '}
              immediately, with no redeploy and no dependency on the gateway or any other
              optional service. It cannot touch a transfer already moving — those are settled by{' '}
              {BRIDGE_SETTLEMENT.protocol} directly to the member — so a pause never traps
              member value.
            </p>
            {gates.unconfirmed && (
              <p className="card-info" role="status">
                Your authority on this router could not be confirmed{authority?.reason ? ` (${authority.reason})` : ''}.
                The control is still offered, because the contract is the real gate and will refuse
                anything you do not hold — withholding a killswitch over an unanswered read would be
                the worse error.
              </p>
            )}
            {gates.pending ? (
              <p className="card-info">Checking your authority on this router…</p>
            ) : canPause ? (
              <button
                type="button"
                className={`confirm-btn ${state?.paused ? 'primary' : 'danger'}`}
                onClick={togglePause}
                disabled={!canSubmit || state == null}
              >
                {state?.paused ? 'Resume bridging' : 'Pause new bridges'}
              </button>
            ) : (
              <p className="card-info" role="status">
                This account holds neither <code>GUARDIAN_ROLE</code> nor admin on the BridgeRouter on{' '}
                {networkName(scopeChainId)}, so the pause is not yours to pull —{' '}
                <strong>the killswitch exists and is exercisable by an account that does hold it.</strong>{' '}
                Holding the guardian role on another contract (the WagerRegistry, or this router on a
                different network) does not carry here; a Role Manager grants{' '}
                <code>GUARDIAN_ROLE</code> on this router from the Roles tab.
              </p>
            )}
            {/*
              The pause is network-wide, and it is the ONLY lever this role has. Disabling a single
              route is LIQUIDITY_ADMIN on the contract and renders under the config gate, so a
              guardian handling a one-destination incident at 03:00 sees one control with a blast
              radius the incident did not require and no hint the narrow lever exists. Naming it here
              is the difference between over-pausing and knowing who to wake.
            */}
            {canPause && !canConfig && (
              <p className="card-info">
                This pause covers <strong>every route from {networkName(scopeChainId)}</strong>. If
                only one destination or asset is affected, disabling that single route is the narrower
                fix — it needs <code>LIQUIDITY_ADMIN_ROLE</code>, which this account does not hold, so
                it is not shown below. Pausing the network is the right call when you cannot reach
                someone who has it.
              </p>
            )}
          </div>

          <div className="admin-card">
            <h3>Routes</h3>
            <p className="card-info">
              A route is one asset, from {networkName(scopeChainId)}, to one destination network.
              Routes in the other direction live on that network’s own router — select it above to
              manage them (FR-050).
            </p>
            {state == null ? (
              <p className="card-info">Loading routes…</p>
            ) : state.routes.length === 0 ? (
              <p className="card-info">
                No routes are curated on {networkName(scopeChainId)} yet, so members are offered no
                destination from here.
              </p>
            ) : (
              <table className="admin-table" aria-label="Curated bridge routes">
                <thead>
                  <tr>
                    <th scope="col">Asset</th>
                    <th scope="col">Route</th>
                    <th scope="col">Delivers</th>
                    <th scope="col">Status</th>
                    <th scope="col">Per-transaction max</th>
                    <th scope="col">Expected delivery</th>
                    {canConfig && <th scope="col">Change</th>}
                  </tr>
                </thead>
                <tbody>
                  {state.routes.map((route) => (
                    <tr key={route.routeId}>
                      <td>
                        {tokenLabel(scopeChainId, route.inputToken)}
                        {route.nativeInput ? ' (native)' : ''}
                      </td>
                      <td>
                        {networkName(scopeChainId)} → {networkName(route.destinationChainId)}
                      </td>
                      <td>{tokenLabel(route.destinationChainId, route.outputToken)}</td>
                      <td>
                        <span className={route.enabled ? 'status-value' : 'status-value paused'}>
                          {route.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </td>
                      <td>{formatLimit(scopeChainId, route.inputToken, route.maxAmount)}</td>
                      <td>{formatDuration(route.expectedFillSeconds)}</td>
                      {canConfig && (
                        <td>
                          <button
                            type="button"
                            className={`confirm-btn ${route.enabled ? 'danger' : 'primary'}`}
                            disabled={!canSubmit}
                            onClick={() => setRouteEnabled(route, !route.enabled)}
                          >
                            {route.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <label>
                            <span className="hint">
                              New max in {limitUnitLabel(scopeChainId, route.inputToken)} (0 = uncapped)
                            </span>
                            <input
                              type="text"
                              aria-label={`Per-transaction maximum for ${tokenLabel(scopeChainId, route.inputToken)} to ${networkName(route.destinationChainId)}`}
                              value={limitDrafts[route.routeId] ?? ''}
                              onChange={(e) =>
                                setLimitDrafts((d) => ({ ...d, [route.routeId]: e.target.value }))
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="confirm-btn primary"
                            disabled={!canSubmit}
                            onClick={() => applyLimit(route)}
                          >
                            Set limit
                          </button>
                          <button
                            type="button"
                            className="confirm-btn danger"
                            disabled={!canSubmit}
                            onClick={() => removeRoute(route)}
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h4>Destination coverage from {networkName(scopeChainId)}</h4>
            <table className="admin-table" aria-label="Destination coverage">
              <thead>
                <tr>
                  <th scope="col">Destination</th>
                  <th scope="col">Routes</th>
                  {canConfig && <th scope="col">All routes to this destination</th>}
                </tr>
              </thead>
              <tbody>
                {destinationsWithRoutes.map(({ net, total, enabled }) => (
                  <tr key={net.chainId}>
                    <td>{net.name}</td>
                    <td>
                      {total === 0 ? (
                        <span className="status-value paused">none — not offered to members</span>
                      ) : (
                        `${enabled} of ${total} enabled`
                      )}
                    </td>
                    {canConfig && (
                      <td>
                        <button
                          type="button"
                          className="confirm-btn primary"
                          disabled={!canSubmit || enabled === total}
                          onClick={() => bulkSetEnabled(net.chainId, true)}
                        >
                          Enable all ({total - enabled} tx)
                        </button>
                        <button
                          type="button"
                          className="confirm-btn danger"
                          disabled={!canSubmit || enabled === 0}
                          onClick={() => bulkSetEnabled(net.chainId, false)}
                        >
                          Disable all ({enabled} tx)
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {canConfig && (
              <div className="admin-form">
                <h4>Add or edit a route</h4>
                <p className="card-info">
                  A route is identified by the asset sent, the asset delivered, and the destination
                  network. Saving one that already exists updates it in place; changing the
                  delivered asset creates a different route rather than overwriting the old one.
                </p>
                <label>
                  Asset sent from {networkName(scopeChainId)}
                  <input
                    type="text"
                    placeholder="input token 0x…"
                    value={forms.inputToken}
                    onChange={(e) => setForms((f) => ({ ...f, inputToken: e.target.value }))}
                  />
                </label>
                <label>
                  Asset delivered on the destination
                  <input
                    type="text"
                    placeholder="output token 0x…"
                    value={forms.outputToken}
                    onChange={(e) => setForms((f) => ({ ...f, outputToken: e.target.value }))}
                  />
                </label>
                <label>
                  Destination network
                  <select
                    value={forms.destinationChainId}
                    onChange={(e) => setForms((f) => ({ ...f, destinationChainId: e.target.value }))}
                  >
                    <option value="">Choose…</option>
                    {destinations.map((net) => (
                      <option key={net.chainId} value={String(net.chainId)}>
                        {net.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Per-transaction maximum ({limitUnitLabel(scopeChainId, forms.inputToken)}) — 0 = uncapped
                  <input
                    type="text"
                    value={forms.maxAmount}
                    onChange={(e) => setForms((f) => ({ ...f, maxAmount: e.target.value }))}
                  />
                </label>
                <label>
                  Expected delivery window (seconds, {MIN_FILL_SECONDS}–{MAX_FILL_SECONDS})
                  <input
                    type="text"
                    value={forms.expectedFillSeconds}
                    onChange={(e) => setForms((f) => ({ ...f, expectedFillSeconds: e.target.value }))}
                  />
                  <span className="hint">
                    Advisory only: it is what tells a member their transfer is running late, not a
                    promise the contract enforces.
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={forms.nativeInput}
                    onChange={(e) => setForms((f) => ({ ...f, nativeInput: e.target.checked }))}
                  />
                  Member pays in this network’s native coin (the asset above is then its wrapped form)
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={forms.enabled}
                    onChange={(e) => setForms((f) => ({ ...f, enabled: e.target.checked }))}
                  />
                  Offer this route to members immediately
                </label>
                <button type="button" className="confirm-btn primary" disabled={!canSubmit} onClick={submitRoute}>
                  Save route
                </button>
              </div>
            )}
            {formError && (
              <p className="card-info error" role="alert">
                {formError}
              </p>
            )}
          </div>

          {canWire && (
            <div className="admin-card">
              <h3>Protocol addresses</h3>
              <p>
                Current values are shown beside each field. Invalid or zero addresses are rejected
                here, before the wallet prompt (FR-042).
              </p>
              {/*
                These three are not curation, and the contract does not treat them as such: they are
                DEFAULT_ADMIN_ROLE, a role above LIQUIDITY_ADMIN. The card says why, because "set an
                address" reads like configuration and the consequence is not.
              */}
              <p className="card-info">
                <strong>These are fund-path references, not settings.</strong> The SpokePool is
                approved and handed each member’s net amount; the FeeRouter names both the rate and
                the treasury the fee is transferred to. Pointing either at the wrong contract
                redirects member money, which is why they need admin rather than the route-curation
                role, and why the router caps the fee it will pay out at{' '}
                {state?.maxFeeBps == null ? 'its own hard ceiling' : `${state.maxFeeBps / 100}%`}{' '}
                <em>of the amount</em> no matter what a FeeRouter reports about itself. Verify the
                address on the explorer before saving.
              </p>
              <div className="admin-form">
                <label>
                  Across SpokePool
                  <input
                    type="text"
                    placeholder="SpokePool 0x…"
                    value={forms.spokePool}
                    onChange={(e) => setForms((f) => ({ ...f, spokePool: e.target.value }))}
                  />
                  <span className="hint">now: {shortAddr(state?.spokePool) || '—'}</span>
                </label>
                <button
                  type="button"
                  className="confirm-btn primary"
                  disabled={!canSubmit}
                  onClick={() => setAddress('setSpokePool', forms.spokePool, 'SpokePool')}
                >
                  Set SpokePool
                </button>

                <label>
                  FeeRouter reference
                  <input
                    type="text"
                    placeholder="FeeRouter 0x…"
                    value={forms.feeRouter}
                    onChange={(e) => setForms((f) => ({ ...f, feeRouter: e.target.value }))}
                  />
                  <span className="hint">now: {shortAddr(state?.feeRouter) || '—'}</span>
                </label>
                <button
                  type="button"
                  className="confirm-btn primary"
                  disabled={!canSubmit}
                  onClick={() => setAddress('setFeeRouter', forms.feeRouter, 'FeeRouter reference')}
                >
                  Set FeeRouter
                </button>

                <label>
                  Sanctions guard
                  <input
                    type="text"
                    placeholder="SanctionsGuard 0x…"
                    value={forms.sanctionsGuard}
                    onChange={(e) => setForms((f) => ({ ...f, sanctionsGuard: e.target.value }))}
                  />
                  <span className="hint">now: {shortAddr(state?.sanctionsGuard) || '—'}</span>
                </label>
                <button
                  type="button"
                  className="confirm-btn primary"
                  disabled={!canSubmit}
                  onClick={() => setAddress('setSanctionsGuard', forms.sanctionsGuard, 'Sanctions guard')}
                >
                  Set guard
                </button>
              </div>
            </div>
          )}

          <FeeRateCard
            serviceLabel="bridge"
            serviceId="bridge.transfer"
            quote={fee}
            routerMaxFeeBps={state?.maxFeeBps ?? null}
            onOpenFees={onOpenFees}
          />

          <div className="admin-card">
            <h3>Operations</h3>
            <p className="card-info warning-text">
              <strong>This panel is observational only.</strong> No action here — or anywhere in the
              contract — can touch a member’s in-flight bridge: {BRIDGE_SETTLEMENT.protocol} settles
              directly to the member and the router is not in that path, which is why it has no
              rescue or refund function. A transfer that cannot be delivered is returned
              automatically to the wallet it left from. There is no button to hunt for.
            </p>
            <div className="status-details">
              <div className="status-row">
                <span className="status-label">Quoting gateway</span>
                <span className="status-value">
                  {!gateway.configured
                    ? 'not configured — members cannot start a bridge (quoting is impossible), but transfers already moving still resolve'
                    : gateway.loading
                      ? 'checking…'
                      : gateway.reachable
                        ? `reachable${gateway.status?.killSwitch ? ' — KILL SWITCH ACTIVE' : ''}`
                        : 'unreachable — new bridges are withheld rather than priced from stale data'}
                </span>
              </div>
              <div className="status-row">
                <span className="status-label">Delivery evidence</span>
                <span className="status-value">
                  {gateway.configured
                    ? 'gateway status endpoint, joined to each transfer by its Across deposit id'
                    : 'unavailable — delivery happens on another network, straight to the member, so this router cannot observe it'}
                </span>
              </div>
            </div>
            {ops.rows == null ? (
              <p className="card-info">Loading recent bridges…</p>
            ) : ops.rows.length === 0 ? (
              <p className="card-info">
                {ops.error
                  ? 'Recent bridges could not be read here — this RPC bounds event lookups. Use the block explorer link below.'
                  : `No bridges have been started from ${networkName(scopeChainId)} in the recent lookback window.`}
              </p>
            ) : (
              <table className="admin-table" aria-label="Recent bridges">
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Member</th>
                    <th scope="col">To</th>
                    <th scope="col">Amount</th>
                    <th scope="col">State</th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {ops.rows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.at ? new Date(row.at).toLocaleString() : '—'}</td>
                      <td>
                        <code title={row.member}>{shortAddr(row.member)}</code>
                      </td>
                      <td>{networkName(row.destinationChainId)}</td>
                      <td>{formatAmount(scopeChainId, row.inputToken, row.grossAmount ?? 0n)}</td>
                      <td>
                        <span className={row.late && row.state !== BRIDGE_STATE.DELIVERED ? 'status-value paused' : 'status-value'}>
                          {bridgeStateCopy(row.state).label}
                        </span>
                        {/*
                          No curated route ⇒ no advisory window ⇒ lateness is UNKNOWN, not false.
                          Said in the row, because the alternative is a transfer that silently stops
                          being flagged the moment an operator removes the route it is on.
                        */}
                        {row.windowUnknown && row.state !== BRIDGE_STATE.DELIVERED && (
                          <span className="hint">
                            {' '}
                            — no expected window: this route is no longer curated, so whether this is
                            overdue cannot be said here
                          </span>
                        )}
                      </td>
                      <td>
                        {row.observed
                          ? row.dstTxHash
                            ? 'destination fill'
                            : row.refundTxHash
                              ? 'return transaction'
                              : 'bridge knows the deposit'
                          : 'origin transaction only'}
                        {row.txHash && getTransactionUrl(scopeChainId, row.txHash) && (
                          <>
                            {' '}
                            <a href={getTransactionUrl(scopeChainId, row.txHash)} target="_blank" rel="noopener noreferrer">
                              start tx ↗
                            </a>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {/*
              THE PANEL SAYS WHAT IT COULD NOT SHOW. A bounded list that does not admit its bound
              reads as "everything is here", which for an incident panel is the one reading that
              costs something.
            */}
            <p className="card-info">
              Anything past its expected window is listed <strong>ahead of</strong> newer transfers,
              so a stuck one is not pushed out by traffic that is fine.
              {ops.found != null && ops.found > (ops.rows?.length ?? 0)
                ? ` ${ops.found} bridges were found in the lookback window and ${ops.rows.length} are shown${
                    ops.hidden > 0 ? `; ${ops.hidden} older ${ops.hidden === 1 ? 'one is' : 'ones are'} not listed` : ''
                  } — use the explorer link for the rest.`
                : ''}{' '}
              “Taking longer than expected” means past the route’s advisory window — it is a
              statement about the clock, not about the outcome: those transfers still deliver or
              are returned.
            </p>
          </div>

          <HistoryCard
            title="Change history"
            history={history}
            explorerUrl={getBlockscoutUrl(scopeChainId, routerAddr, 'address')}
          />
        </>
      )}
    </div>
  )
}

/**
 * Recover the Across deposit id from the SpokePool log the router's own transaction emitted.
 *
 * Returns null for every ambiguity — no receipt, no matching log, an undecodable one. Null means
 * "we cannot ask about this transfer", never "this transfer does not exist".
 */
async function readDepositId(provider, txHash) {
  if (!provider || !txHash) return null
  const receipt = await safe(provider.getTransactionReceipt(txHash))
  if (!receipt?.logs) return null
  for (const log of receipt.logs) {
    if (!DEPOSIT_TOPICS.has(log?.topics?.[0])) continue
    try {
      const parsed = decodeEventLog({ abi: SPOKE_POOL_ABI, topics: [...log.topics], data: log.data ?? '0x' })
      if (parsed?.args?.depositId != null) return parsed.args.depositId
    } catch {
      // Not one of the deposit events after all — ignore rather than count it.
    }
  }
  return null
}

/**
 * Decode one config event into the audit row: what changed, on what, before → after.
 *
 * `RouteLimitChanged` is the only route event carrying an old value, so it is the only one with a
 * real "before". The others print "—", and the history card explains why rather than letting the
 * dash read as "it was empty".
 */
function describeBridgeEvent(scopeChainId) {
  const route = (args) => {
    const dest = Number(args?.destinationChainId ?? 0)
    return dest ? `route → ${networkName(dest)}` : `route ${shortAddr(args?.routeId) || String(args?.routeId ?? '').slice(0, 10)}`
  }
  return (name, args) => {
    switch (name) {
      case 'RouteSet':
        return {
          action: 'Route saved',
          target: `${tokenLabel(scopeChainId, args.inputToken)} ${route(args)}`,
          // `RouteSet` now carries `enabled` (added after the T150 security review), so this row can
          // state availability truthfully. It previously could NOT: the event omitted the field, so
          // `args.enabled` was undefined and a naive ternary reported every saved route as offered —
          // including one saved with the box unchecked. Reporting it is only correct because the
          // contract emits it; if that ever regresses, report nothing again rather than guessing.
          after: `${args.enabled ? 'offered' : 'not offered'}, max ${formatLimit(scopeChainId, args.inputToken, args.maxAmount)}, window ${formatDuration(args.expectedFillSeconds)}`,
        }
      case 'RouteEnabledChanged':
        return { action: 'Route availability', target: route(args), after: args.enabled ? 'enabled' : 'disabled' }
      case 'RouteLimitChanged':
        return {
          action: 'Per-transaction maximum',
          target: route(args),
          // The event carries no token, so the figures are shown in raw units and say so
          // rather than being scaled by a guess about which asset the route moves.
          before: String(args.oldMax) === '0' ? 'uncapped' : `${args.oldMax} raw units`,
          after: String(args.newMax) === '0' ? 'uncapped' : `${args.newMax} raw units`,
        }
      case 'RouteRemoved':
        return { action: 'Route removed', target: route(args), after: 'no longer offered' }
      case 'SpokePoolUpdated':
        return { action: 'SpokePool address', target: 'Across SpokePool', before: shortAddr(args.oldSpokePool) || '—', after: shortAddr(args.newSpokePool) || '—' }
      case 'FeeRouterUpdated':
        return { action: 'FeeRouter reference', target: 'FeeRouter', before: shortAddr(args.oldRouter) || '—', after: shortAddr(args.newRouter) || '—' }
      case 'SanctionsGuardUpdated':
        return { action: 'Sanctions guard', target: 'SanctionsGuard', before: shortAddr(args.oldGuard) || '—', after: shortAddr(args.newGuard) || '—' }
      case 'Paused':
        return { action: 'Emergency pause', target: 'new bridges', after: 'paused (in-flight transfers unaffected)' }
      case 'Unpaused':
        return { action: 'Emergency pause lifted', target: 'new bridges', after: 'active' }
      default:
        return { action: name, target: '—' }
    }
  }
}
