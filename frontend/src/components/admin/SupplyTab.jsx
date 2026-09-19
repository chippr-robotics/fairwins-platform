/**
 * SupplyTab (spec 067, US4) — the operator control surface for supplied liquidity.
 *
 * One screen per network for the on-chain `LiquidityRouter`:
 *   - Status + pause / resume — GUARDIAN_ROLE (FR-043/FR-044).
 *   - The curated pool list of BOTH kinds, with per-transaction caps, supplied totals and
 *     position counts — LIQUIDITY_ADMIN_ROLE (FR-041/FR-045/FR-048).
 *   - Protocol addresses (Uniswap position manager, FeeRouter, sanctions guard), current value
 *     beside the input, invalid input refused with a reason before the wallet prompt (FR-042).
 *   - The `liquidity.deposit` platform fee — READ-ONLY (spec 060 single source of truth).
 *   - Decoded on-chain change history (FR-046).
 *
 * ---------------------------------------------------------------------------------------------
 * THE TWO THINGS THIS TAB EXISTS TO SAY OUT LOUD (research R3, FR-024).
 *
 * 1. **The pause is NARROW: it pauses new UNISWAP supplies, and nothing else.** Bridge-pool
 *    deposits are a DIRECT member call to Across's HubPool — `addLiquidity` has no recipient
 *    parameter, so routing them would leave FairWins owning a position the member could never
 *    exit. No FairWins contract is in that path, so no FairWins contract can stop it. What
 *    withholds a bridge pool is the per-pool `enabled` flag, which the app honours. Every label
 *    here says "new Uniswap supplies" rather than "pooling", because an operator reaching for a
 *    killswitch during an incident must not walk away believing they stopped something they did
 *    not.
 *
 * 2. **A retired pool is RETIRED, not GONE.** `setPoolEnabled(false)` closes a pool to NEW
 *    deposits and nothing else — which is why the contract has no `removePool` at all. Members
 *    still hold positions there and must keep being able to see and exit them, so retired pools
 *    stay in this table, with their position count, rather than disappearing from it.
 * ---------------------------------------------------------------------------------------------
 *
 * As on the Bridge tab, scope is a NETWORK and not the connected wallet: reads span every
 * Uniswap-capable network from its own RPC, and only writes need the wallet there (FR-050).
 */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { encodeFunctionData, zeroAddress } from 'viem'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { eventScanHandle } from '../../lib/chains/eventScan'
import { getLogsRange } from '../../lib/chains/logRange'
import { getAddress } from '../../lib/evm/address'
import { getContractAddressForChain } from '../../config/contracts'
import { LIQUIDITY_ROUTER_ABI } from '../../abis/LiquidityRouter'
import { FEE_SERVICES, fetchFeeQuote } from '../../lib/fees/feeQuote'
import { getBlockscoutUrl } from '../../config/blockExplorer'
import { POOL_KIND } from '../../lib/liquidity/liquidityRouter'
import { readPooledToken } from '../../lib/liquidity/acrossLpPositions'
import { BRIDGE_LP_FEE_FREE_NOTE } from '../../lib/liquidity/liquidityCopy'
import { FeeRateCard, HistoryCard, NetworkScopeCard, WriteScopeNotice } from './liquidityAdminCards'
import {
  adminNetworks,
  authorityGates,
  formatAmount,
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

const HISTORY_EVENTS = [
  'PoolListed',
  'PoolEnabledChanged',
  'PoolLimitChanged',
  'PositionManagerUpdated',
  'FeeRouterUpdated',
  'SanctionsGuardUpdated',
  'Paused',
  'Unpaused',
]

/**
 * Supplied totals and position counts come from the router's own `LiquiditySupplied` events over
 * a bounded window — there is no indexer and no backend. That makes them "supplied THROUGH
 * FairWins in the recent window", which is a narrower claim than "everything in this pool", and
 * the table says so rather than passing one off as the other.
 */
const TOTALS_LOOKBACK_BLOCKS = 200_000

/** Minimal Uniswap V3 pool reads, for verifying a listing before it is signed. */
const POOL_ABI = [
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
]

const safe = (p) => p.then((v) => v).catch(() => undefined)

const KIND_LABEL = {
  [POOL_KIND.BRIDGE_LP]: 'Bridge pool (Across)',
  [POOL_KIND.TRADING_LP]: 'Trading pool (Uniswap V3)',
}

export default function SupplyTab({
  signer,
  account,
  chainId,
  provider,
  runTx,
  pendingTx,
  onOpenFees,
}) {
  const networks = useMemo(() => adminNetworks('liquidity'), [])
  const [scopeChainId, setScopeChainId] = useState(
    () => (networks.some((n) => n.chainId === chainId) ? chainId : networks[0]?.chainId) ?? null,
  )

  // ── AUTHORITY IS READ FROM THE ROUTER IN SCOPE, NOT FROM THE APP-WIDE ROLE FLAGS ──────────────
  // The `isAdmin`/`isGuardian`/`isLiquidityAdmin` props answer "is this operator an admin of
  // SOMETHING on the wallet's chain", which is not the question a control here needs answered.
  // GUARDIAN_ROLE on the WagerRegistry is not GUARDIAN_ROLE on this LiquidityRouter, LIQUIDITY_ADMIN
  // on the BridgeRouter is not authority over pools, and the wallet's chain is not the network in
  // scope. Every gate below asks THIS router on THIS network — see readRouterAuthority.
  const [authority, setAuthority] = useState(null) // null = not yet asked
  const gates = authorityGates(authority)
  const canConfig = gates.config
  const canPause = gates.pause
  // Address writes are DEFAULT_ADMIN_ROLE on the contract, a role ABOVE curation: `positionManager`
  // is approved and mints the member's position and `feeRouter` names the treasury the fee goes to,
  // so they are not a pool-curation power.
  const canWire = Boolean(authority?.admin || gates.unconfirmed)
  const canSubmit = Boolean(signer) && Number(scopeChainId) === Number(chainId) && !pendingTx

  const routerAddr = getContractAddressForChain('liquidityRouter', scopeChainId)
  const readProvider = useMemo(
    () => readProviderFor(scopeChainId, chainId, provider),
    [scopeChainId, chainId, provider],
  )

  const [state, setState] = useState(null) // null = loading
  const [readError, setReadError] = useState(null)
  const [lastReadAt, setLastReadAt] = useState(null)
  const [fee, setFee] = useState(undefined)
  const [history, setHistory] = useState({ entries: null, error: null })
  const [activity, setActivity] = useState({ byPool: null, error: null })
  // Per-pool HubPool size for BRIDGE_LP listings: poolId -> readPooledToken result, or null when
  // that pool's read failed. Absent key = not asked yet.
  const [bridgeSizes, setBridgeSizes] = useState({})
  const [formError, setFormError] = useState(null)
  const [formNote, setFormNote] = useState(null)
  const [forms, setForms] = useState({
    kind: String(POOL_KIND.TRADING_LP),
    poolAddress: '',
    token0: '',
    token1: '',
    feeTier: '',
    max0: '0',
    max1: '0',
    enabled: true,
    positionManager: '',
    feeRouter: '',
    sanctionsGuard: '',
  })
  const [capDrafts, setCapDrafts] = useState({})

  const routerRead = useMemo(
    () =>
      routerAddr && readProvider
        ? (functionName, args = []) =>
            readContract(scopeChainId, {
              address: routerAddr,
              abi: LIQUIDITY_ROUTER_ABI,
              functionName,
              args,
            })
        : null,
    [routerAddr, readProvider, scopeChainId],
  )
  const write = useCallback(
    (functionName, args = []) =>
      signer.sendTransaction({
        to: routerAddr,
        data: encodeFunctionData({
          abi: normalizeAbi(LIQUIDITY_ROUTER_ABI),
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
      const paused = await routerRead('paused')
      const [feeRouter, positionManager, sanctionsGuard, maxFeeBps, count] = await Promise.all([
        safe(routerRead('feeRouter')),
        safe(routerRead('positionManager')),
        safe(routerRead('sanctionsGuard')),
        safe(routerRead('MAX_FEE_BPS')),
        safe(routerRead('poolCount')),
      ])

      const pools = []
      let poolsComplete = count !== undefined
      if (count !== undefined) {
        const n = Number(count)
        const ids = await Promise.all(Array.from({ length: n }, (_, i) => safe(routerRead('poolAt', [BigInt(i)]))))
        const raws = await Promise.all(ids.map((id) => (id ? safe(routerRead('getPool', [id])) : Promise.resolve(undefined))))
        for (let i = 0; i < n; i += 1) {
          const id = ids[i]
          const raw = raws[i]
          if (!id || raw === undefined) {
            poolsComplete = false
            continue
          }
          const kind = Number(raw.kind)
          // `Unlisted` (0) at an enumerated id is not an incomplete read — the id is simply no
          // longer a pool — so it does not clear `poolsComplete`.
          if (kind !== POOL_KIND.BRIDGE_LP && kind !== POOL_KIND.TRADING_LP) continue
          pools.push({
            poolId: id,
            kind,
            enabled: Boolean(raw.enabled),
            feeTier: Number(raw.feeTier ?? 0),
            token0: raw.token0,
            token1: raw.token1,
            poolAddress: raw.poolAddress,
            maxDeposit0PerTx: BigInt(raw.maxDeposit0PerTx ?? 0n),
            maxDeposit1PerTx: BigInt(raw.maxDeposit1PerTx ?? 0n),
          })
        }
      }

      setState({
        feeRouter,
        positionManager,
        sanctionsGuard,
        maxFeeBps: maxFeeBps === undefined ? null : Number(maxFeeBps),
        paused: Boolean(paused),
        pools,
        poolsComplete,
      })
      setLastReadAt(new Date())
    } catch (e) {
      setState(null)
      setReadError(
        `Could not read the LiquidityRouter on ${networkName(scopeChainId)}: ${e?.message || e}. Nothing below can be trusted as current until this clears.`,
      )
    }
  }, [routerRead, scopeChainId])

  // THE RATE IS QUOTED FROM THE FEE ROUTER THIS ROUTER ACTUALLY HOLDS, NOT FROM THIS BUILD'S CONFIG.
  //
  // `fetchFeeQuote` defaults to the configured address, which is right for members but wrong here:
  // the contract that will charge them is whatever `LiquidityRouter.feeRouter()` returns right now,
  // and the two diverge in exactly the window an operator most needs the truth — after someone
  // repoints the router and before the config ships, or the reverse. Quoting the config address there
  // reports a rate (or a confident "no fee") from a contract that is not in the path.
  //
  // `liveFeeRouter` is read in fetchState; until it resolves there is nothing to quote FROM, so this
  // waits rather than falling back to the config address and printing a figure it cannot stand behind.
  const liveFeeRouter = state?.feeRouter
  const fetchFee = useCallback(async () => {
    if (!routerAddr || !readProvider || !liveFeeRouter) return
    setFee(undefined)
    try {
      const quote = await fetchFeeQuote({
        serviceId: FEE_SERVICES.LIQUIDITY_DEPOSIT,
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
        abi: LIQUIDITY_ROUTER_ABI,
        provider: readProvider,
        eventNames: HISTORY_EVENTS,
        describe: describeLiquidityEvent(scopeChainId),
      }),
    )
  }, [routerAddr, readProvider, scopeChainId])

  /**
   * Per-pool supplied totals and position counts (FR-048), aggregated from the router's own
   * `LiquiditySupplied` events.
   *
   * What this can and cannot see is the honest part. It counts positions minted THROUGH the
   * router in the lookback window — which is every trading-pool supply FairWins has made, and
   * NONE of the bridge-pool deposits, because those never touch this contract. A bridge pool's
   * count is therefore reported as not observable rather than as zero: zero would read as "no
   * member has money in here", which is exactly the claim that must not be made about a pool
   * being retired (FR-024).
   */
  const fetchActivity = useCallback(async () => {
    if (!routerAddr || !readProvider) return
    setActivity({ byPool: null, error: null })
    try {
      const handle = eventScanHandle(scopeChainId, {
        address: routerAddr,
        abi: LIQUIDITY_ROUTER_ABI,
      })
      if (!handle) return
      const latest = Number(await handle.provider.getBlockNumber())
      const fromBlock = Math.max(0, latest - TOTALS_LOOKBACK_BLOCKS)
      // Bisects on refusal. An RPC that caps log ranges used to land in the catch below, which
      // reports the totals as UNREADABLE — correct, but it meant this panel could never show a
      // figure on such a chain.
      const logs = await getLogsRange(
        handle.provider,
        routerAddr,
        fromBlock,
        latest,
        2000,
        handle.filters.LiquiditySupplied().getTopicFilter(),
      )
      const evs = logs.map((log) => ({ ...log, args: handle.interface.parseLog(log).args }))
      const byPool = {}
      for (const ev of evs) {
        const poolId = ev.args?.poolId
        if (!poolId) continue
        const entry = byPool[poolId] || { positions: new Set(), amount0: 0n, amount1: 0n }
        if (ev.args?.tokenId != null) entry.positions.add(String(ev.args.tokenId))
        entry.amount0 += BigInt(ev.args?.amount0 ?? 0n)
        entry.amount1 += BigInt(ev.args?.amount1 ?? 0n)
        byPool[poolId] = entry
      }
      setActivity({
        byPool: Object.fromEntries(
          Object.entries(byPool).map(([id, e]) => [id, { positions: e.positions.size, amount0: e.amount0, amount1: e.amount1 }]),
        ),
        error: null,
      })
    } catch (e) {
      // `byPool: null`, NOT `{}`. An empty map is indistinguishable from "scanned, found nothing",
      // and the cells below fall back to `?? 0` — so an unreadable scan would print "0 positions"
      // against a pool members still hold LP in. That is the single claim FR-024 exists to prevent,
      // made at the moment an operator decides whether to retire it.
      setActivity({ byPool: null, error: e?.message || String(e) })
    }
  }, [routerAddr, readProvider, scopeChainId])

  /**
   * How much sits in each curated BRIDGE pool, read from the HubPool itself (FR-048).
   *
   * The router's events cannot see these deposits — they never touch it — which is why the position
   * COUNT stays unobservable here: attributing LP balances to members needs an indexer. But the POOL
   * SIZE is a plain read that this app already performs on the member-facing Supply view, from the
   * same address (`readPooledToken` on `pool.poolAddress`, which for a bridge listing IS the
   * HubPool). Withholding it left an operator deciding whether to retire a bridge pool with no
   * figure at all for the money inside it, while the member screen showed exactly that. One number
   * genuinely cannot be produced; this one can, so it is.
   */
  // Bumped whenever a newer run starts, so a slow HubPool read cannot land its result after the
  // scope moved on — or after unmount, which surfaced in tests as a React act() warning and an
  // intermittent failure in whichever test happened to be running when the late update arrived.
  const bridgePoolsRun = useRef(0)
  const fetchBridgePools = useCallback(async () => {
    if (!readProvider || !state?.pools) return
    const run = ++bridgePoolsRun.current
    const bridgePools = state.pools.filter((p) => p.kind === POOL_KIND.BRIDGE_LP)
    if (bridgePools.length === 0) {
      if (run === bridgePoolsRun.current) setBridgeSizes({})
      return
    }
    const entries = await Promise.all(
      bridgePools.map(async (pool) => {
        // Per-pool, so one unreadable HubPool never blanks the others.
        const info = await readPooledToken({
          chainId: scopeChainId,
          provider: readProvider,
          hubPool: pool.poolAddress,
          l1Token: pool.token0,
        }).catch(() => null)
        return [pool.poolId, info]
      }),
    )
    // Stale runs drop their result rather than overwriting a newer network's.
    if (run === bridgePoolsRun.current) setBridgeSizes(Object.fromEntries(entries))
  }, [readProvider, state?.pools, scopeChainId])

  // ── THE FEE QUOTE GETS ITS OWN EFFECT, AND THAT SPLIT IS THE WHOLE POINT ──────────────────────
  //
  // These four reads used to share one effect keyed on all four callbacks, which fed `fetchState`
  // back into itself and made the tab refetch continuously:
  //
  //   fetchState() clears `state` first (deliberately — see the FR-050 note above)
  //     → `liveFeeRouter` (= state?.feeRouter) flips to undefined
  //     → `fetchFee`, which lists it as a dependency, gets a new identity
  //     → the shared effect re-runs
  //     → fetchState() again, clearing `state` again…
  //
  // That is not a bounded over-fetch, it is a loop with a period of one RPC round-trip, and it runs
  // for as long as the tab is open. Measured against a round-trip that costs a macrotask rather than
  // an instantly-resolved mock: `paused()` was called 51 times in 250ms, 201 in 1s and 401 in 2s —
  // linear in how long an operator leaves the tab open, each lap carrying the batched address reads,
  // the per-pool fan-out and an eight-event history scan behind it. The pool table was torn out of
  // the DOM and rebuilt ~100 times a second, so an operator watched it strobe, and anything holding
  // a reference to a row — a click landing mid-lap, or a test that queried an element and acted on
  // it a tick later — was holding a detached node.
  //
  // The fee quote genuinely SHOULD re-run when the router's FeeRouter changes. Only the coupling
  // back into `fetchState` was wrong, so the dependency stays and the effect is separated: router
  // state is keyed on the router and the network, the quote on the fee router it reports.
  useEffect(() => {
    fetchState()
    fetchHistory()
    fetchActivity()
  }, [fetchState, fetchHistory, fetchActivity])

  useEffect(() => {
    fetchFee()
  }, [fetchFee])

  useEffect(() => {
    fetchBridgePools()
  }, [fetchBridgePools])

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
    fetchActivity()
    fetchBridgePools()
  }

  /* ------------------------------------------------------------------------------- writes */

  const togglePause = () => {
    const fn = state?.paused ? 'unpause' : 'pause'
    runTx(
      () => write(fn),
      state?.paused ? 'New Uniswap supplies resumed' : 'New Uniswap supplies paused',
    ).then(refresh)
  }

  const setPoolEnabled = (pool, enabled) =>
    runTx(
      () => write('setPoolEnabled', [pool.poolId, enabled]),
      enabled ? 'Pool reopened to new deposits' : 'Pool retired — closed to new deposits, existing positions untouched',
    ).then(refresh)

  /**
   * Write new per-transaction ceilings, leaving anything the operator did not type alone.
   *
   * ── AN UNTOUCHED LEG KEEPS ITS CURRENT CEILING ─────────────────────────────────────────────────
   * `setPoolLimit` writes BOTH legs in one call and `0` means UNCAPPED on-chain, so defaulting the
   * blank leg to '0' silently deleted a member-facing limit the operator never intended to touch:
   * typing a new WETH ceiling on a pool capped at 25,000 USDC removed the USDC cap and reported
   * success. Blank now means "keep", read from the pool's live value, and blanking BOTH is refused
   * outright rather than quietly writing uncapped/uncapped — an operator who wants no ceiling can
   * type 0, which still means uncapped and now says so only when they asked for it.
   */
  const applyCaps = (pool) => {
    setFormError(null)
    const draft0 = capDrafts[`${pool.poolId}-0`]
    const draft1 = capDrafts[`${pool.poolId}-1`]
    const typed0 = String(draft0 ?? '').trim() !== ''
    const typed1 = String(draft1 ?? '').trim() !== ''
    const twoLegs = pool.kind === POOL_KIND.TRADING_LP
    if (!typed0 && !(twoLegs && typed1)) {
      setFormError(
        'Type a new ceiling first. Leaving the boxes blank would write 0 — uncapped — over the current limits; enter 0 explicitly if that is what you intend.',
      )
      return
    }
    let max0
    let max1
    try {
      max0 = typed0 ? parseLimit(scopeChainId, pool.token0, draft0) : BigInt(pool.maxDeposit0PerTx ?? 0n)
      if (!twoLegs) {
        max1 = 0n
      } else {
        max1 = typed1 ? parseLimit(scopeChainId, pool.token1, draft1) : BigInt(pool.maxDeposit1PerTx ?? 0n)
      }
    } catch (e) {
      setFormError(e.message)
      return
    }
    runTx(() => write('setPoolLimit', [pool.poolId, max0, max1]), 'Per-transaction deposit caps updated').then(refresh)
  }

  /**
   * Read the named Uniswap pool and check the listing against it BEFORE any signature.
   *
   * The contract cross-checks the same three fields and reverts `PoolListingMismatch`, which
   * costs gas and tells the operator nothing about WHICH field was wrong. Doing it here turns
   * that into a sentence — and a listing whose metadata disagreed with its pool would have been
   * shown to members as the pool they were not supplying (FR-042).
   */
  const verifyPool = async () => {
    setFormError(null)
    setFormNote(null)
    if (!isValidAddr(forms.poolAddress)) {
      setFormError('Enter the Uniswap V3 pool address first.')
      return
    }
    if (!readProvider) {
      setFormError(`No read connection to ${networkName(scopeChainId)}, so the pool cannot be checked from here.`)
      return
    }
    const askPool = (functionName) =>
      readContract(scopeChainId, {
        address: getAddress(forms.poolAddress.trim()),
        abi: POOL_ABI,
        functionName,
      })
    const [token0, token1, feeTier] = await Promise.all([
      safe(askPool('token0')),
      safe(askPool('token1')),
      safe(askPool('fee')),
    ])
    if (!token0 || !token1 || feeTier === undefined) {
      setFormError(
        'That address did not answer as a Uniswap V3 pool. Check it is the POOL, not the token pair or the position manager.',
      )
      return
    }
    setForms((f) => ({ ...f, token0, token1, feeTier: String(feeTier) }))
    setFormNote(
      `Pool confirmed: ${tokenLabel(scopeChainId, token0)} / ${tokenLabel(scopeChainId, token1)} at ${Number(feeTier) / 10_000}%. The fields above now match the pool the router will check against.`,
    )
  }

  const submitPool = () => {
    setFormError(null)
    const kind = Number(forms.kind)
    if (!isValidAddr(forms.poolAddress) || !isValidAddr(forms.token0)) {
      setFormError('The pool address and the first asset must both be valid, non-zero addresses.')
      return
    }
    if (kind === POOL_KIND.TRADING_LP) {
      if (!isValidAddr(forms.token1)) {
        setFormError('A trading pool has two legs — enter the second asset, or use “Check pool” to fill both from the pool itself.')
        return
      }
      if (!/^\d+$/.test(forms.feeTier) || Number(forms.feeTier) === 0) {
        setFormError('A trading pool needs its Uniswap fee tier (500, 3000 or 10000). The router rejects a listing without one.')
        return
      }
    } else if (forms.token1 && forms.token1 !== zeroAddress) {
      setFormError('A bridge pool has exactly one asset — leave the second asset empty. The router rejects a two-legged bridge listing.')
      return
    }
    let max0
    let max1
    try {
      max0 = parseLimit(scopeChainId, forms.token0, forms.max0)
      max1 = kind === POOL_KIND.TRADING_LP ? parseLimit(scopeChainId, forms.token1, forms.max1) : 0n
    } catch (e) {
      setFormError(e.message)
      return
    }
    runTx(
      () =>
        write('listPool', [
          {
            kind,
            // `Boolean`/`getAddress` are not decoration (spec 110, divergences 16 and 18). viem's
            // encoder REFUSES an all-uppercase address that `isValidAddr` accepts, and refuses
            // anything that is not a real boolean for a `bool` — where ethers coerced both. The
            // validator and the encoder have to agree, or a listing fails between them.
            enabled: Boolean(forms.enabled),
            feeTier: kind === POOL_KIND.TRADING_LP ? Number(forms.feeTier) : 0,
            token0: getAddress(forms.token0.trim()),
            token1: kind === POOL_KIND.TRADING_LP ? getAddress(forms.token1.trim()) : zeroAddress,
            poolAddress: getAddress(forms.poolAddress.trim()),
            maxDeposit0PerTx: max0,
            maxDeposit1PerTx: max1,
          },
        ]),
      'Pool listing saved',
    ).then(refresh)
  }

  const setAddress = (fn, value, label) => {
    setFormError(null)
    if (!isValidAddr(value)) {
      setFormError(`Enter a valid, non-zero address for the ${label} — the contract rejects malformed and zero addresses.`)
      return
    }
    // A fund-path address (feeRouter / positionManager / sanctionsGuard). Normalised, not just
    // validated — repointing one of these is the change that is not reversible.
    runTx(() => write(fn, [getAddress(value.trim())]), `${label} updated`).then(refresh)
  }

  /* ------------------------------------------------------------------------------- render */

  if (!scopeChainId) {
    return (
      <div className="admin-tab-content" role="tabpanel">
        <div className="admin-card">
          <h3>Supply Controls</h3>
          <p className="card-info">
            No network in this build carries a Uniswap position manager, so there is nothing to
            control here and the Supply area is hidden for members everywhere.
          </p>
        </div>
      </div>
    )
  }

  // A COUNT IS NEVER PRINTED AS A BARE NUMBER UNLESS THE SCAN THAT PRODUCED IT SUCCEEDED.
  //
  // Three states, three different sentences, because they mean different things to an operator about
  // to retire a pool: the scan has not answered yet, the scan FAILED (so nothing is known — the case
  // that used to render "0"), and the scan succeeded but found nothing in its window (which is not
  // the same as "no member holds a position", since the window is bounded).
  const positionsFor = (pool) => {
    if (pool.kind === POOL_KIND.BRIDGE_LP) return 'not observable here'
    if (activity.error) return 'unknown — the scan failed'
    if (activity.byPool == null) return '…'
    const agg = activity.byPool[pool.poolId]
    if (!agg) return 'none in window'
    return String(agg.positions)
  }
  const suppliedFor = (pool) => {
    if (pool.kind === POOL_KIND.BRIDGE_LP) {
      // Read from the HubPool, not from this router's events — see fetchBridgePools. Three states,
      // and the failed one says so rather than reading as an empty pool.
      if (!(pool.poolId in bridgeSizes)) return '…'
      const info = bridgeSizes[pool.poolId]
      if (!info) return 'unknown — the HubPool could not be read'
      const total = info.liquidReserves + (info.utilizedReserves > 0n ? info.utilizedReserves : 0n)
      return `${formatAmount(scopeChainId, pool.token0, total)} in the pool`
    }
    if (activity.error) return 'unknown — the scan failed'
    if (activity.byPool == null) return '…'
    const agg = activity.byPool[pool.poolId]
    if (!agg) return 'none in window'
    return `${formatAmount(scopeChainId, pool.token0, agg.amount0)} + ${formatAmount(scopeChainId, pool.token1, agg.amount1)}`
  }

  return (
    <div className="admin-tab-content" role="tabpanel">
      <NetworkScopeCard
        title="Supply Controls"
        description="The curated pool list, deposit caps, addresses and the Uniswap supply pause for one network's LiquidityRouter."
        networks={networks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(getContractAddressForChain('liquidityRouter', id))}
        walletChainId={chainId}
        onRefresh={refresh}
        lastReadAt={routerAddr ? lastReadAt : null}
      >
        {routerAddr && (
          <div className="status-details">
            <div className="status-row">
              <span className="status-label">LiquidityRouter</span>
              <span className="status-value">
                <code title={routerAddr}>{shortAddr(routerAddr)}</code>
              </span>
            </div>
            <div className="status-row">
              <span className="status-label">New Uniswap supplies</span>
              <span className="status-value">
                {state == null ? (
                  '…'
                ) : state.paused ? (
                  <span className="status-value paused">
                    PAUSED — no new Uniswap supplies. Existing positions are untouched and still withdrawable.
                  </span>
                ) : (
                  'active'
                )}
              </span>
            </div>
            <div className="status-row">
              <span className="status-label">Curated pools</span>
              <span className="status-value">
                {state == null
                  ? '…'
                  : `${state.pools.length} (${state.pools.filter((p) => p.enabled).length} open to new deposits)${state.poolsComplete ? '' : ' — partial read, some pools could not be loaded'}`}
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
            No LiquidityRouter is deployed on {networkName(scopeChainId)}, so there is nothing to
            control here and members are offered no pools on this network. Deploy it with{' '}
            <code>scripts/deploy/deploy-bridge-liquidity.js</code>, or pick another network above.
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
            THE CARD IS ALWAYS RENDERED, INCLUDING WHEN THIS OPERATOR CANNOT USE IT — see the same
            note in BridgeTab. Hiding it behind the authority check made a network with a working
            killswitch look like a network without one, mid-incident.
          */}
          <div className="admin-card">
            <h3>Emergency pause</h3>
            <p>
              <strong>Pauses new Uniswap supplies</strong> on {networkName(scopeChainId)} —
              immediately, with no redeploy, and with no dependency on any optional service.
            </p>
            <p className="card-info warning-text">
              It does <strong>not</strong> pause bridge-pool deposits. Those go straight from the
              member’s wallet to the Across HubPool with no FairWins contract in the path, so this
              contract cannot stop them: what withholds a bridge pool is its <em>enabled</em> flag
              in the table below, which the app honours. Nothing here can trap member value —
              every existing position stays withdrawable, because withdrawing never went through
              this router in the first place.
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
                {state?.paused ? 'Resume new Uniswap supplies' : 'Pause new Uniswap supplies'}
              </button>
            ) : (
              <p className="card-info" role="status">
                This account holds neither <code>GUARDIAN_ROLE</code> nor admin on the LiquidityRouter
                on {networkName(scopeChainId)}, so the pause is not yours to pull —{' '}
                <strong>the killswitch exists and is exercisable by an account that does hold it.</strong>{' '}
                Holding the guardian role on another contract (the WagerRegistry, or this router on a
                different network) does not carry here; a Role Manager grants{' '}
                <code>GUARDIAN_ROLE</code> on this router from the Roles tab.
              </p>
            )}
          </div>

          <div className="admin-card">
            <h3>Curated pools</h3>
            <p className="card-info">
              Retiring a pool closes it to <strong>new</strong> deposits only. It stays listed here
              and for members who hold a position in it, so they can keep seeing and exiting it —
              which is why the router has no “remove pool” at all (FR-024).
            </p>
            {state == null ? (
              <p className="card-info">Loading pools…</p>
            ) : state.pools.length === 0 ? (
              <p className="card-info">
                No pools are curated on {networkName(scopeChainId)} yet, so members are offered
                nothing to supply here.
              </p>
            ) : (
              <table className="admin-table" aria-label="Curated pools">
                <thead>
                  <tr>
                    <th scope="col">Kind</th>
                    <th scope="col">Pool</th>
                    <th scope="col">Status</th>
                    <th scope="col">Positions</th>
                    <th scope="col">Supplied via FairWins</th>
                    <th scope="col">Per-transaction caps</th>
                    {canConfig && <th scope="col">Change</th>}
                  </tr>
                </thead>
                <tbody>
                  {state.pools.map((pool) => (
                    <tr key={pool.poolId}>
                      <td>{KIND_LABEL[pool.kind]}</td>
                      <td>
                        {pool.kind === POOL_KIND.TRADING_LP
                          ? `${tokenLabel(scopeChainId, pool.token0)} / ${tokenLabel(scopeChainId, pool.token1)} ${Number(pool.feeTier) / 10_000}%`
                          : tokenLabel(scopeChainId, pool.token0)}{' '}
                        <code title={pool.poolAddress}>{shortAddr(pool.poolAddress)}</code>
                      </td>
                      <td>
                        <span className={pool.enabled ? 'status-value' : 'status-value paused'}>
                          {pool.enabled ? 'open to new deposits' : 'RETIRED — closed to new deposits, still withdrawable'}
                        </span>
                      </td>
                      <td>{positionsFor(pool)}</td>
                      <td>{suppliedFor(pool)}</td>
                      <td>
                        {formatLimit(scopeChainId, pool.token0, pool.maxDeposit0PerTx)}
                        {pool.kind === POOL_KIND.TRADING_LP && (
                          <> / {formatLimit(scopeChainId, pool.token1, pool.maxDeposit1PerTx)}</>
                        )}
                        {/*
                          A bridge pool's cap is honoured by the APP, not by the contract: the
                          router's limit check lives inside the trading-pool entry point, and a
                          bridge-LP deposit never enters it. Same property the pause card explains
                          for the enabled flag — so it is said here too, where the number is, rather
                          than left to imply contract enforcement it does not have.
                        */}
                        {pool.kind === POOL_KIND.BRIDGE_LP && (
                          <span className="hint"> — honoured by this app, not by the contract</span>
                        )}
                      </td>
                      {canConfig && (
                        <td>
                          <button
                            type="button"
                            className={`confirm-btn ${pool.enabled ? 'danger' : 'primary'}`}
                            disabled={!canSubmit}
                            onClick={() => setPoolEnabled(pool, !pool.enabled)}
                          >
                            {pool.enabled ? 'Retire' : 'Reopen'}
                          </button>
                          <label>
                            <span className="hint">
                              New cap, {limitUnitLabel(scopeChainId, pool.token0)} (0 = uncapped)
                            </span>
                            <input
                              type="text"
                              aria-label={`Per-transaction cap for ${tokenLabel(scopeChainId, pool.token0)} in pool ${shortAddr(pool.poolAddress)}`}
                              value={capDrafts[`${pool.poolId}-0`] ?? ''}
                              onChange={(e) =>
                                setCapDrafts((d) => ({ ...d, [`${pool.poolId}-0`]: e.target.value }))
                              }
                            />
                          </label>
                          {pool.kind === POOL_KIND.TRADING_LP && (
                            <label>
                              <span className="hint">
                                New cap, {limitUnitLabel(scopeChainId, pool.token1)} (0 = uncapped)
                              </span>
                              <input
                                type="text"
                                aria-label={`Per-transaction cap for ${tokenLabel(scopeChainId, pool.token1)} in pool ${shortAddr(pool.poolAddress)}`}
                                value={capDrafts[`${pool.poolId}-1`] ?? ''}
                                onChange={(e) =>
                                  setCapDrafts((d) => ({ ...d, [`${pool.poolId}-1`]: e.target.value }))
                                }
                              />
                            </label>
                          )}
                          <button
                            type="button"
                            className="confirm-btn primary"
                            disabled={!canSubmit}
                            onClick={() => applyCaps(pool)}
                          >
                            Set caps
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="card-info">
              “Positions” and “Supplied via FairWins” are counted from this router’s own deposit
              events over the recent window — they are what FairWins routed, not the pool’s whole
              size. A bridge pool’s <em>size</em> is different: it is read straight from the Across
              HubPool, so it is the whole pool and not a FairWins subset. Its per-member{' '}
              <em>position count</em> is the one figure that genuinely cannot be produced without an
              indexer — those deposits never touch this contract — and it says so rather than
              printing a zero, which would read as “no member has money in this pool”: precisely the
              claim that must not be made when retiring one.
              {activity.error
                ? ' This RPC bounds event lookups, so the recent window could not be read — the affected cells say “unknown”, never 0.'
                : ''}
            </p>
            <p className="card-info">
              A <strong>bridge pool’s</strong> per-transaction cap is enforced by this app, not by the
              router: the contract’s limit check sits inside the Uniswap supply path, and a bridge-LP
              deposit is a direct member call to Across that never enters it. The cap still does real
              work — every FairWins surface refuses above it — but a member calling the HubPool
              directly is not bound by it, exactly as with the <em>enabled</em> flag.
            </p>
            {canConfig && (
              <div className="admin-form">
                <h4>Add or edit a pool</h4>
                <label>
                  Kind
                  <select value={forms.kind} onChange={(e) => setForms((f) => ({ ...f, kind: e.target.value }))}>
                    <option value={String(POOL_KIND.TRADING_LP)}>Trading pool (Uniswap V3) — routed, fee-charged</option>
                    <option value={String(POOL_KIND.BRIDGE_LP)}>Bridge pool (Across HubPool) — direct member call, fee-free</option>
                  </select>
                </label>
                <label>
                  Pool address
                  <input
                    type="text"
                    placeholder="pool 0x…"
                    value={forms.poolAddress}
                    onChange={(e) => setForms((f) => ({ ...f, poolAddress: e.target.value }))}
                  />
                </label>
                {Number(forms.kind) === POOL_KIND.TRADING_LP && (
                  <button type="button" className="confirm-btn primary" onClick={verifyPool}>
                    Check pool
                  </button>
                )}
                <label>
                  First asset
                  <input
                    type="text"
                    placeholder="token0 0x…"
                    value={forms.token0}
                    onChange={(e) => setForms((f) => ({ ...f, token0: e.target.value }))}
                  />
                </label>
                {Number(forms.kind) === POOL_KIND.TRADING_LP && (
                  <>
                    <label>
                      Second asset
                      <input
                        type="text"
                        placeholder="token1 0x…"
                        value={forms.token1}
                        onChange={(e) => setForms((f) => ({ ...f, token1: e.target.value }))}
                      />
                    </label>
                    <label>
                      Uniswap fee tier
                      <input
                        type="text"
                        placeholder="500 / 3000 / 10000"
                        value={forms.feeTier}
                        onChange={(e) => setForms((f) => ({ ...f, feeTier: e.target.value }))}
                      />
                      <span className="hint">
                        The router checks these three fields against the pool itself and refuses a
                        listing that disagrees with it — use “Check pool” to fill them from the pool.
                      </span>
                    </label>
                  </>
                )}
                <label>
                  Per-transaction cap, first asset ({limitUnitLabel(scopeChainId, forms.token0)}) — 0 = uncapped
                  <input
                    type="text"
                    value={forms.max0}
                    onChange={(e) => setForms((f) => ({ ...f, max0: e.target.value }))}
                  />
                </label>
                {Number(forms.kind) === POOL_KIND.TRADING_LP && (
                  <label>
                    Per-transaction cap, second asset ({limitUnitLabel(scopeChainId, forms.token1)}) — 0 = uncapped
                    <input
                      type="text"
                      value={forms.max1}
                      onChange={(e) => setForms((f) => ({ ...f, max1: e.target.value }))}
                    />
                    <span className="hint">
                      Two caps, not one: a pair’s legs routinely differ in decimals, so one number
                      compared against both would be meaningless.
                    </span>
                  </label>
                )}
                <label>
                  <input
                    type="checkbox"
                    checked={forms.enabled}
                    onChange={(e) => setForms((f) => ({ ...f, enabled: e.target.checked }))}
                  />
                  Open to new deposits immediately
                </label>
                <button type="button" className="confirm-btn primary" disabled={!canSubmit} onClick={submitPool}>
                  Save pool listing
                </button>
                {formNote && <p className="card-info">{formNote}</p>}
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
                Not curation, and the contract does not treat them as such: DEFAULT_ADMIN_ROLE, a role
                above LIQUIDITY_ADMIN. The card says why, because "set an address" reads like a
                setting and the consequence is not.
              */}
              <p className="card-info">
                <strong>These are fund-path references, not settings.</strong> The position manager is
                approved and mints each member’s position; the FeeRouter names both the rate and the
                treasury the fee is transferred to. Pointing either at the wrong contract redirects
                member capital, which is why they need admin rather than the pool-curation role, and
                why the router caps the fee it will pay out at{' '}
                {state?.maxFeeBps == null ? 'its own hard ceiling' : `${state.maxFeeBps / 100}%`}{' '}
                <em>of the amount</em> no matter what a FeeRouter reports about itself. Verify the
                address on the explorer before saving.
              </p>
              <div className="admin-form">
                <label>
                  Uniswap position manager
                  <input
                    type="text"
                    placeholder="NonfungiblePositionManager 0x…"
                    value={forms.positionManager}
                    onChange={(e) => setForms((f) => ({ ...f, positionManager: e.target.value }))}
                  />
                  <span className="hint">
                    now: {shortAddr(state?.positionManager) || 'unset — trading-pool supplies revert until it is set'}
                  </span>
                </label>
                <button
                  type="button"
                  className="confirm-btn primary"
                  disabled={!canSubmit}
                  onClick={() => setAddress('setPositionManager', forms.positionManager, 'Position manager')}
                >
                  Set position manager
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
            serviceLabel="supply"
            serviceId="liquidity.deposit"
            quote={fee}
            routerMaxFeeBps={state?.maxFeeBps ?? null}
            onOpenFees={onOpenFees}
            extraNote={BRIDGE_LP_FEE_FREE_NOTE}
          />

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
 * Decode one config event into the audit row (FR-046).
 *
 * `PoolLimitChanged` carries only the new caps — the contract emits no old values — so its
 * "before" is blank and the history card explains why. Inventing one would be worse than a dash.
 */
function describeLiquidityEvent(scopeChainId) {
  const poolTarget = (args) =>
    args?.poolAddress
      ? `${KIND_LABEL[Number(args.kind)] || 'pool'} ${shortAddr(args.poolAddress)}`
      : `pool ${String(args?.poolId ?? '').slice(0, 10)}…`
  return (name, args) => {
    switch (name) {
      case 'PoolListed':
        return {
          action: 'Pool listed',
          target: poolTarget(args),
          // `PoolListed` now carries `enabled` (added after the T150 security review), so this row
          // can state availability truthfully. It previously could not — the event omitted the field,
          // so a naive ternary reported every listed pool as open, including one listed closed.
          after: `${args.enabled ? 'open to new deposits' : 'retired'}, ${tokenLabel(scopeChainId, args.token0)}${args.token1 && args.token1 !== zeroAddress ? ` / ${tokenLabel(scopeChainId, args.token1)}` : ''}`,
        }
      case 'PoolEnabledChanged':
        return {
          action: 'Pool availability',
          target: poolTarget(args),
          after: args.enabled ? 'open to new deposits' : 'retired (still visible and withdrawable)',
        }
      case 'PoolLimitChanged':
        return {
          action: 'Per-transaction caps',
          target: poolTarget(args),
          // Raw units: the event carries no token, so the figures are not scaled by a guess.
          after: `${String(args.newMax0) === '0' ? 'uncapped' : `${args.newMax0} raw units`} / ${String(args.newMax1) === '0' ? 'uncapped' : `${args.newMax1} raw units`}`,
        }
      case 'PositionManagerUpdated':
        return { action: 'Position manager', target: 'Uniswap NonfungiblePositionManager', before: shortAddr(args.oldManager) || '—', after: shortAddr(args.newManager) || '—' }
      case 'FeeRouterUpdated':
        return { action: 'FeeRouter reference', target: 'FeeRouter', before: shortAddr(args.oldRouter) || '—', after: shortAddr(args.newRouter) || '—' }
      case 'SanctionsGuardUpdated':
        return { action: 'Sanctions guard', target: 'SanctionsGuard', before: shortAddr(args.oldGuard) || '—', after: shortAddr(args.newGuard) || '—' }
      case 'Paused':
        return { action: 'Emergency pause', target: 'new Uniswap supplies', after: 'paused (bridge-pool deposits are unaffected — they never route through this contract)' }
      case 'Unpaused':
        return { action: 'Emergency pause lifted', target: 'new Uniswap supplies', after: 'active' }
      default:
        return { action: name, target: '—' }
    }
  }
}
