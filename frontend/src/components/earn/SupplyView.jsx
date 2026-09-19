/**
 * SupplyView (spec 067, US2 — T093/T098/T100/T101) — the Earn → Supply area.
 *
 * ONE curated list holding BOTH kinds of pool together (FR-015): trading
 * liquidity (an asset PAIR supplied to Uniswap) and bridge liquidity (a SINGLE
 * asset supplied to Across's HubPool), each labelled, each carrying the shared
 * nested asset + network artwork, laid out like the Lend vault list so the two
 * areas read as one experience.
 *
 * ── SIX THINGS THIS FILE IS DELIBERATE ABOUT ────────────────────────────────
 *
 * 1. THE AREA IS NOT GATED ON THE WALLET'S ACTIVE CHAIN. Availability is per
 *    POOL, not per active network, and the network switch happens at SIGNING
 *    (FR-059/FR-061). Phase 3 shipped that gate on the Bridge tab by accident
 *    and the audit caught it: a member holding assets on one network was shown
 *    an instruction they could not follow. What the active network gets here is
 *    a NOTE — one that says in as many words that you do not have to switch to
 *    look around — inside the folded "Where pools are available" disclosure,
 *    never a wall in front of the list.
 *
 * 2. AVAILABILITY IS ASYMMETRIC AND THE COPY SAYS SO. Trading liquidity is on
 *    every Uniswap network this build may read; bridge liquidity is ETHEREUM
 *    ONLY, because the Across HubPool is an L1 contract by design (research R8).
 *    Both rosters are cohort-bounded (#1265; see `useLiquidityCatalog` below), so
 *    on a testnet build each says "not set up in this build yet" rather than
 *    naming mainnet pools nobody here can supply.
 *    `liquidityAvailabilityCopy()` states both halves separately so nothing here
 *    implies both kinds exist everywhere.
 *
 * 3. A RETIRED POOL STAYS VISIBLE AND WITHDRAWABLE (FR-024). It is filtered out
 *    of nothing. Every way this list narrows — the `tokenFilter` deep link, the
 *    search box, the kind chips (`lib/liquidity/poolSearch`) — narrows by what a
 *    pool IS, never by whether it is taking deposits, and none of them touches
 *    the POSITIONS list above: a control that could hide a member's own position
 *    would be hiding their money. A pool a member holds is rendered whatever the
 *    router says about new deposits.
 *
 * 4. EVERY POSITION FIGURE IS LABELLED AN ESTIMATE (FR-020). Current value,
 *    earnings to date, and — for trading pools — the current composition all
 *    move with the market. They are read from the protocol and shown as "—"
 *    with a reason when they cannot be read, never filled in.
 *
 * 5. THE FEE IS CHARGED ON CAPITAL ACTUALLY DEPLOYED. Nothing on this surface
 *    promises a fee AMOUNT: `LiquidityRouter._supply` quotes the fee after the
 *    mint against what Uniswap actually consumed, and refunds the remainder
 *    whole. Cards disclose the RATE (see LiquidityPoolCard); bridge pools show
 *    no fee line at all, because that path cannot be charged without taking
 *    custody (research R3).
 *
 * 6. THE LIST SUMMARISES; THE SHEET DISCLOSES. Every pool is one dense,
 *    scannable ROW — identity, size, kind, where it lives, and a label when it
 *    is not taking deposits — and the whole row opens `SupplySheet`. That is
 *    where the estimated return, the total's caveat, the risk summary, the
 *    platform-fee rate and every InfoTip explaining those terms now live. The
 *    rule this keeps is that nothing was DROPPED to make the row dense: a
 *    disclosure the old card carried is a disclosure the sheet carries, and a
 *    member reaches it before typing an amount, not after.
 *
 * DATA. `useLiquidityCatalog` reads the on-chain control surface directly — the
 * per-network `LiquidityRouter` is the authority on which pools are curated and
 * whether supplying is open (FR-051) — and returns null-on-failure everywhere,
 * so an unreadable protocol degrades into a stated reason instead of invented
 * figures (FR-054). The `catalog` prop is the injection seam: pass one and the
 * hook stands down. That is what the tests use, and what a future shared hook
 * would use.
 */
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readContract } from '../../lib/chains/readContract'
import { getPublicClient } from '../../lib/chains/publicClient'
import { formatUnits } from '../../lib/evm/units'
import { useWallet } from '../../hooks/useWalletManagement'
import { useSelectableAssets } from '../../hooks/useSelectableAssets'
import { ASSET_ACTIVITIES } from '../../lib/assets/assetActivity'
import { NETWORKS, cohortChainIds } from '../../config/networks'
import InfoTip from '../ui/InfoTip'
import AssetLogo from '../wallet/AssetLogo'
import SensitiveValue from '../common/SensitiveValue'
import LiquidityPoolCard from './LiquidityPoolCard'
import { FEE_SERVICES, fetchFeeQuote } from '../../lib/fees/feeQuote'
import {
  getLiquidityRouterAddress,
  readLiquidityRouterConfig,
  POOL_KIND,
} from '../../lib/liquidity/liquidityRouter'
import {
  readMemberPositions,
  readPositionSnapshot,
} from '../../lib/liquidity/uniswapPositions'
import { readLpPosition, readPooledToken } from '../../lib/liquidity/acrossLpPositions'
import {
  LIQUIDITY_DISCLOSURE,
  LIQUIDITY_POOL_KIND,
  LIQUIDITY_PROTOCOLS,
  LIQUIDITY_TIPS,
  LIQUIDITY_UNAVAILABLE,
  NO_POOLS_COPY,
  liquidityAvailabilityCopy,
  liquidityUnavailableCopy,
  noPoolMatchCopy,
  partialWithdrawalCopy,
  poolKindOf,
} from '../../lib/liquidity/liquidityCopy'
import {
  POOL_KIND_FILTERS,
  POOL_KIND_FILTER_ALL,
  filterPools,
  poolKindsPresent,
} from '../../lib/liquidity/poolSearch'
import './Supply.css'

/**
 * The amount-entry + confirm step, loaded on demand.
 *
 * Lazily, not statically, for one reason worth stating: the sheet owns the
 * disclosure gate and the fee line, and it is not on the path a member takes to
 * BROWSE pools or to READ their positions. Deferring it keeps the list — the
 * part FR-024 says must always render, including for a retired pool a member
 * still has money in — independent of it.
 */
const SupplySheet = lazy(() => import('./SupplySheet'))

/** Only what this view reads off a token; the pool list carries no metadata itself. */
const ERC20_META_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
]

/** Token metadata does not change. Cached per (chain, address) for the session. */
const tokenMetaCache = new Map()

const safe = (p) => p.then((v) => v).catch(() => undefined)

/** Base units → a short readable amount. Null in, null out — never a zero stand-in. */
function formatTokenAmount(raw, decimals, symbol) {
  if (raw == null || decimals == null) return null
  let value
  try {
    value = Number(formatUnits(BigInt(raw), Number(decimals)))
  } catch {
    return null
  }
  if (!Number.isFinite(value)) return null
  const unit = symbol ? ` ${symbol}` : ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M${unit}`
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K${unit}`
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}${unit}`
}

/** Symbol/decimals for one token, or honest nulls when the reads fail. */
async function readTokenMeta(chainId, address) {
  const key = `${chainId}:${String(address).toLowerCase()}`
  if (tokenMetaCache.has(key)) return tokenMetaCache.get(key)
  const read = (functionName) => readContract(chainId, { address, abi: ERC20_META_ABI, functionName })
  const [symbol, decimals] = await Promise.all([safe(read('symbol')), safe(read('decimals'))])
  const meta = {
    address,
    symbol: symbol == null ? null : String(symbol),
    decimals: decimals == null ? null : Number(decimals),
  }
  // Only cache a reading we actually got; a failed read must be retried later.
  if (meta.symbol != null && meta.decimals != null) tokenMetaCache.set(key, meta)
  return meta
}

/** "62% USDC / 38% WETH" — what a trading position is made of right now (FR-020). */
function compositionLabel(shares, assets) {
  if (!shares || !assets || assets.length < 2) return null
  const a = assets[0]?.symbol || 'token 0'
  const b = assets[1]?.symbol || 'token 1'
  return `${shares.share0.toFixed(0)}% ${a} / ${shares.share1.toFixed(0)}% ${b}`
}

/**
 * Assemble one network's curated pools and the member's positions in them.
 *
 * Every failure produces a STATE, not an exception: an unreadable router means
 * this network's pools are withheld with a reason, and an unreadable figure on
 * an otherwise-readable pool leaves that figure null so the card shows "—".
 */
async function loadNetwork(chainId, owner) {
  const net = NETWORKS[chainId]
  const name = net?.name || `chain ${chainId}`
  // The client is the AVAILABILITY GATE only — no endpoint configured for this chain is a
  // different fact from a read that failed, and the helpers below still take it as that gate.
  // Every actual read names `chainId` (spec 110), so nothing here can land on another network.
  const provider = getPublicClient(chainId)
  const blank = { pools: [], positions: [] }
  if (!provider) return { network: { chainId, name, status: 'unreachable' }, ...blank }

  let config = null
  try {
    config = await readLiquidityRouterConfig({ chainId, provider })
  } catch {
    config = null
  }
  if (!config) return { network: { chainId, name, status: 'unreachable' }, ...blank }

  // The live `liquidity.deposit` rate (FR-026/FR-027 — one source of truth, never
  // a hardcoded bps). A failed read is NOT "no fee": it is an unknown rate, and a
  // card that cannot quote must not offer a deposit at a rate it is unsure of.
  let fee = { available: false, bps: 0 }
  let feeKnown = true
  try {
    fee = await fetchFeeQuote({ serviceId: FEE_SERVICES.LIQUIDITY_DEPOSIT, chainId, provider })
  } catch {
    feeKnown = false
  }

  const listings = config.pools || []
  const enriched = await Promise.all(
    listings.map((listing) => enrichPool({ listing, chainId, name, provider, config, fee, feeKnown })),
  )
  const pools = enriched.filter(Boolean)

  const positions = owner ? await loadPositions({ chainId, provider, config, pools, owner }) : []

  return {
    network: { chainId, name, status: 'ready', poolsComplete: config.poolsComplete !== false },
    pools,
    positions,
  }
}

/** One router listing + live protocol reads → the `PoolOption` the card renders. */
async function enrichPool({ listing, chainId, name, provider, config, fee, feeKnown }) {
  const isTrading = Number(listing.kind) === POOL_KIND.TRADING_LP
  const kind = isTrading ? LIQUIDITY_POOL_KIND.TRADING_LP : LIQUIDITY_POOL_KIND.BRIDGE_LP
  const protocol = isTrading
    ? LIQUIDITY_PROTOCOLS.trading.protocol
    : LIQUIDITY_PROTOCOLS.bridge.protocol

  const addresses = isTrading ? [listing.token0, listing.token1] : [listing.token0]
  const assets = await Promise.all(addresses.map((a) => readTokenMeta(chainId, a)))

  let totalSuppliedLabel = null
  // The same total, unjoined. A pair's total is two amounts, and "33.8M USDC + 32K
  // WETH" wrapped mid-figure in a dense row reads as one broken number — the row
  // stacks the legs instead. Same figures, same source; only the joining differs.
  let totalSuppliedParts = null
  let unavailableReason = null
  let acceptsDeposits = listing.enabled
  let lpToken = null

  if (isTrading) {
    // A Uniswap pool's total is what the pool contract holds of each leg.
    const balances = await Promise.all(
      addresses.map((a) =>
        safe(
          readContract(chainId, {
            address: a,
            abi: ERC20_META_ABI,
            functionName: 'balanceOf',
            args: [listing.poolAddress],
          }),
        ),
      ),
    )
    const parts = balances
      .map((raw, i) => formatTokenAmount(raw, assets[i]?.decimals, assets[i]?.symbol))
      .filter(Boolean)
    totalSuppliedParts = parts.length === addresses.length ? parts : null
    totalSuppliedLabel = totalSuppliedParts ? totalSuppliedParts.join(' + ') : null
    // The router's pause stops UNISWAP supplies only — it is not a killswitch over
    // the bridge path, which never touches this contract (ILiquidityRouter).
    if (config.paused) unavailableReason = 'paused'
    if (!config.positionManager || /^0x0{40}$/i.test(String(config.positionManager))) {
      unavailableReason = unavailableReason || 'unreachable'
    }
  } else {
    // Across's own record: its retirement flag and how much of the pot is here.
    const pooled = await safe(
      Promise.resolve(
        readPooledToken({ chainId, provider, hubPool: listing.poolAddress, l1Token: listing.token0 }),
      ),
    )
    if (!pooled) {
      unavailableReason = 'unreachable'
    } else {
      acceptsDeposits = acceptsDeposits && pooled.isEnabled
      lpToken = pooled.lpToken || null
      const total = BigInt(pooled.liquidReserves ?? 0n) + BigInt(pooled.utilizedReserves ?? 0n)
      totalSuppliedLabel = formatTokenAmount(total, assets[0]?.decimals, assets[0]?.symbol)
      totalSuppliedParts = totalSuppliedLabel ? [totalSuppliedLabel] : null
    }
  }

  if (!acceptsDeposits) unavailableReason = unavailableReason || 'retired'
  // A rate we could not read blocks NEW deposits rather than guessing zero
  // (FR-027) — and says so as its OWN reason. Calling it "protocol unreachable"
  // would blame Uniswap for a FeeRouter read, which is a different fault with a
  // different remedy.
  if (isTrading && !feeKnown) unavailableReason = unavailableReason || 'fees'

  return {
    // The listing fields are spread FLAT, not nested, because `SupplySheet`
    // consumes a `normalizePool` output enriched for display — token0/token1,
    // poolAddress, the per-transaction ceilings — and reshaping the same pool
    // twice is how the two surfaces drift apart. `listing` is kept alongside for
    // the position readers, which take the raw curated list.
    ...listing,
    key: `${chainId}:${listing.poolId}`,
    poolId: listing.poolId,
    chainId,
    networkName: name,
    kind: listing.kind,
    protocol,
    listing,
    assets,
    token0Meta: assets[0] || null,
    token1Meta: assets[1] || null,
    routerAddress: config.routerAddress,
    positionManager: isTrading ? config.positionManager : null,
    hubPool: isTrading ? null : listing.poolAddress,
    lpToken,
    unreachable: unavailableReason === 'unreachable' || undefined,
    feeTier: isTrading ? listing.feeTier : null,
    // No on-chain source exists for either protocol's realised return, so it stays
    // null and the card says why. Inventing one is exactly what FR-054 forbids.
    estimatedReturnApr: null,
    estimatedReturnReason: null,
    totalSuppliedLabel,
    totalSuppliedParts,
    enabled: Boolean(acceptsDeposits),
    available: Boolean(acceptsDeposits) && !unavailableReason,
    unavailableReason,
    // Bridge pools carry no `liquidity.deposit` charge at any rate (research R3);
    // the card's `liquidityFeeCopy` refuses one regardless of what is passed.
    feeBps: isTrading ? fee.bps ?? 0 : 0,
    feeAvailable: isTrading ? Boolean(fee.available) && feeKnown : false,
    kindLabel: kind,
  }
}

/** The member's positions on one network, in the curated pools only. */
async function loadPositions({ chainId, provider, config, pools, owner }) {
  const out = []

  const tradingPools = pools.filter((p) => Number(p.kind) === POOL_KIND.TRADING_LP)
  if (tradingPools.length > 0 && config.positionManager) {
    const listed = await safe(
      Promise.resolve(
        readMemberPositions({
          chainId,
          provider,
          positionManager: config.positionManager,
          owner,
          pools: tradingPools.map((p) => p.listing),
        }),
      ),
    )
    for (const position of listed?.positions || []) {
      const pool = tradingPools.find((p) => p.poolId === position.poolId)
      if (!pool) continue
      const snapshot = await safe(
        Promise.resolve(
          readPositionSnapshot({
            chainId,
            provider,
            positionManager: config.positionManager,
            tokenId: position.tokenId,
            owner,
            poolAddress: pool.listing.poolAddress,
          }),
        ),
      )
      out.push(tradingPosition(pool, snapshot || position))
    }
  }

  const bridgePools = pools.filter((p) => Number(p.kind) === POOL_KIND.BRIDGE_LP)
  for (const pool of bridgePools) {
    const lp = await safe(
      Promise.resolve(
        readLpPosition({
          chainId,
          provider,
          hubPool: pool.listing.poolAddress,
          l1Token: pool.listing.token0,
          owner,
        }),
      ),
    )
    if (!lp || !lp.lpBalance || BigInt(lp.lpBalance) === 0n) continue
    out.push(bridgePosition(pool, lp))
  }

  return out
}

/** A Uniswap position → the shape the positions list renders. */
function tradingPosition(pool, snapshot) {
  const [a0, a1] = pool.assets
  const amounts = snapshot?.composition || null
  const valueParts = amounts
    ? [
        formatTokenAmount(amounts.amount0, a0?.decimals, a0?.symbol),
        formatTokenAmount(amounts.amount1, a1?.decimals, a1?.symbol),
      ].filter(Boolean)
    : []
  const earned = snapshot?.earnings
    ? [
        formatTokenAmount(snapshot.earnings.amount0, a0?.decimals, a0?.symbol),
        formatTokenAmount(snapshot.earnings.amount1, a1?.decimals, a1?.symbol),
      ].filter(Boolean)
    : []
  return {
    // The raw protocol reading travels WITH the display labels: `SupplySheet`
    // matches a position to a pool by `poolId` and sizes an exit from
    // `liquidity` / `withdrawable`, so stripping those out here would leave the
    // member able to see a position and unable to exit it.
    ...snapshot,
    poolId: pool.poolId,
    key: `${pool.key}:${snapshot?.tokenId ?? '0'}`,
    pool,
    currentValueLabel: valueParts.length === 2 ? valueParts.join(' + ') : null,
    earningsLabel: earned.length === 2 ? earned.join(' + ') : null,
    compositionLabel: compositionLabel(snapshot?.shares, pool.assets),
    partialNote: null,
    isEstimate: true,
  }
}

/** An Across LP position → the same shape. No composition: it holds one asset. */
function bridgePosition(pool, lp) {
  const asset = pool.assets[0]
  const withdrawable = lp.withdrawable
  return {
    ...lp,
    poolId: pool.poolId,
    key: `${pool.key}:lp`,
    pool,
    currentValueLabel: formatTokenAmount(lp.currentValue, asset?.decimals, asset?.symbol),
    // Deliberately absent, not zero: Across fees accrue INTO the exchange rate, so
    // earnings can only be stated against a recorded cost basis, which lives in the
    // activity ledger rather than on-chain (acrossLpPositions).
    earningsLabel: null,
    earningsNote:
      'Bridge-pool earnings build into the value above rather than accruing separately, so there is no separate earned figure to show.',
    compositionLabel: null,
    // FR-022 — when the pot is lent out, say so plainly instead of offering an exit
    // that would revert.
    partialNote:
      withdrawable && withdrawable.isFull === false
        ? partialWithdrawalCopy(formatTokenAmount(withdrawable.underlying, asset?.decimals, asset?.symbol))
        : null,
    isEstimate: true,
  }
}

/**
 * The curated pool list and the member's positions, across every network IN THIS
 * BUILD'S COHORT with a `LiquidityRouter` deployed — never narrowed to the
 * wallet's active chain.
 *
 * The roster is `cohortChainIds()` and never `listSupportedChainIds()` (issue
 * #1265): "not gated on the ACTIVE chain" (point 1 in the header) is a different
 * question from "may read the OTHER cohort", and constitution III forbids the
 * second. Enumerating every supported chain here had a testnet build opening
 * connections to the five mainnet routers and listing mainnet pools a member on
 * that build can never supply.
 *
 * Status is honest-state: 'loading' | 'ready' | 'unavailable'. 'unavailable'
 * means no network could be read at all; a network that individually failed is
 * reported in `networks` so the surface can say which, without withholding the
 * ones that did answer. An empty cohort roster is 'ready' with no pools, which
 * the empty-state copy explains — never an "unavailable" that blames a read.
 */
function useLiquidityCatalog({ skip = false } = {}) {
  const wallet = useWallet() || {}
  const owner = wallet.address || null

  const chainIds = useMemo(
    () =>
      cohortChainIds().filter(
        (id) => Number.isFinite(id) && Boolean(getLiquidityRouterAddress(id)),
      ),
    [],
  )

  const [state, setState] = useState({
    status: 'loading',
    pools: [],
    positions: [],
    networks: [],
    asOf: null,
  })
  const reqRef = useRef(0)

  const load = useCallback(async () => {
    const reqId = ++reqRef.current
    if (chainIds.length === 0) {
      setState({ status: 'ready', pools: [], positions: [], networks: [], asOf: Date.now() })
      return
    }
    setState((prev) => ({ ...prev, status: 'loading' }))
    const results = await Promise.all(chainIds.map((id) => loadNetwork(id, owner)))
    if (reqId !== reqRef.current) return
    const networks = results.map((r) => r.network)
    const readable = networks.filter((n) => n.status === 'ready')
    setState({
      // Every network failing is an outage; some failing is a partial list that
      // names what is missing rather than pretending it is whole.
      status: readable.length === 0 ? 'unavailable' : 'ready',
      pools: results.flatMap((r) => r.pools),
      positions: results.flatMap((r) => r.positions),
      networks,
      asOf: Date.now(),
    })
  }, [chainIds, owner])

  useEffect(() => {
    if (skip) return
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skip, owner])

  return useMemo(() => ({ ...state, refresh: load }), [state, load])
}

/** FR-020 — one open position, every figure labelled a live estimate. */
function PositionRow({ position }) {
  const { pool } = position
  const isTrading = poolKindOf(pool.kind) === LIQUIDITY_POOL_KIND.TRADING_LP
  const label = (pool.assets || []).map((a) => a.symbol || 'Unknown asset').join(' / ')
  return (
    <li className="supply-position">
      <div className="supply-position-head">
        <span className={`supply-card-logos${(pool.assets || []).length > 1 ? ' pair' : ''}`}>
          {(pool.assets || []).map((asset) => (
            <AssetLogo
              key={asset.address || asset.symbol}
              symbol={asset.symbol}
              chainId={pool.chainId}
              showBadge
              size={28}
            />
          ))}
        </span>
        <span className="supply-position-name">
          {label}
          <span className="earn-position-network">
            {pool.protocol} · on {pool.networkName}
            {pool.enabled === false ? ' · closed to new deposits' : ''}
          </span>
        </span>
      </div>

      <dl className="supply-position-figures">
        <div>
          <dt>
            Current value
            <InfoTip label="What is my position worth?" className="earn-info">
              {LIQUIDITY_TIPS.positionValue}
            </InfoTip>
          </dt>
          <dd>
            <SensitiveValue>{position.currentValueLabel || '—'}</SensitiveValue>
            <span className="supply-estimate-flag">Live estimate</span>
          </dd>
        </div>
        <div>
          <dt>
            Earnings to date
            <InfoTip label="What have I earned?" className="earn-info">
              {LIQUIDITY_TIPS.earnings}
            </InfoTip>
          </dt>
          <dd>
            <SensitiveValue>{position.earningsLabel || '—'}</SensitiveValue>
            {position.earningsLabel ? (
              <span className="supply-estimate-flag">Live estimate</span>
            ) : (
              <span className="supply-figure-note">
                {position.earningsNote ||
                  'We could not read this just now, so it is not being shown rather than shown wrong.'}
              </span>
            )}
          </dd>
        </div>
        {isTrading && (
          <div>
            <dt>
              Current mix
              <InfoTip label="What is my position made of?" className="earn-info">
                {LIQUIDITY_TIPS.composition}
              </InfoTip>
            </dt>
            <dd>
              <SensitiveValue>{position.compositionLabel || '—'}</SensitiveValue>
              <span className="supply-estimate-flag">Live estimate</span>
            </dd>
          </div>
        )}
      </dl>

      {position.partialNote && (
        <p className="supply-card-state" role="note">
          {position.partialNote}
        </p>
      )}
    </li>
  )
}

export default function SupplyView({ tokenFilter: initialTokenFilter = null, catalog = null }) {
  const wallet = useWallet() || {}
  const live = useLiquidityCatalog({ skip: Boolean(catalog) })
  const data = catalog || live
  // The member's assets across ALL networks (FR-059), which the sheet's pair
  // selector filters down by the pinned network. Resolved here rather than in
  // the sheet so the sheet stays a pure confirm step.
  const { options: assetOptions } = useSelectableAssets({
    activity: ASSET_ACTIVITIES.TRANSFER,
    catalog: true,
  })

  const [tokenFilter, setTokenFilter] = useState(initialTokenFilter)
  // What the member typed, and which kind of pool they asked for. Both are local:
  // narrowing a list you are looking at is not a place you can navigate back to.
  const [query, setQuery] = useState('')
  const [kindFilter, setKindFilter] = useState(POOL_KIND_FILTER_ALL)
  // `mode` is 'supply' or 'withdraw'. Withdrawing is reachable for a RETIRED pool
  // and carries no platform fee — a member can always exit (FR-021/FR-024).
  const [sheet, setSheet] = useState(null)

  const pools = useMemo(() => data.pools || [], [data.pools])
  const positions = useMemo(() => data.positions || [], [data.positions])

  // FR-024 — every one of these narrows by what a pool IS, never by state. A
  // retired pool matching the search is still listed; hiding it would hide a
  // member's own money. The positions list above is rendered from `positions`
  // and is deliberately not filtered at all.
  const shownPools = useMemo(
    () => filterPools(pools, { query, kind: kindFilter, tokenSymbol: tokenFilter }),
    [pools, query, kindFilter, tokenFilter],
  )

  // The chip row is only offered when there is something to choose between: with
  // one kind curated, a "Trading / Bridge" pair is two controls where one of them
  // empties the list and the other does nothing.
  const kindsPresent = useMemo(() => poolKindsPresent(pools), [pools])
  const narrowed = Boolean(query.trim()) || kindFilter !== POOL_KIND_FILTER_ALL
  const clearNarrowing = () => {
    setQuery('')
    setKindFilter(POOL_KIND_FILTER_ALL)
  }

  const positionKeys = useMemo(
    () => new Set(positions.map((p) => p.pool?.key).filter(Boolean)),
    [positions],
  )

  const failedNetworks = (data.networks || []).filter((n) => n.status !== 'ready')
  const partialNetworks = (data.networks || []).filter(
    (n) => n.status === 'ready' && n.poolsComplete === false,
  )

  // Point 1: this is a NOTE about the active network, not a gate on the list.
  // `liquidityUnavailableCopy` says in as many words that you do not have to
  // switch networks to look around, and it returns null where pooling exists.
  const activeNetworkNote =
    wallet.chainId != null ? liquidityUnavailableCopy(wallet.chainId) : null

  const positionFor = (pool) => positions.find((p) => p.pool?.key === pool.key) || null

  // Two empty states carry `liquidityAvailabilityCopy()` inside their own copy —
  // an empty catalog, and a ?token= deep link no pool takes. Where they render,
  // the folded disclosure below would be the same sentence a second time, so it
  // stands down. A search that found nothing says nothing about availability, so
  // there it stays.
  const emptyCatalog = data.status === 'ready' && pools.length === 0
  const tokenFilterMiss =
    data.status === 'ready' && pools.length > 0 && shownPools.length === 0 && !narrowed
  const availabilityStatedElsewhere = emptyCatalog || tokenFilterMiss

  /**
   * Point 6 — ONE way in. A row is a summary, not a fork: tapping it opens the
   * pool's sheet, which holds the full disclosure and both actions behind tabs.
   *
   * The tab it lands on is the only thing decided here, and it is decided by
   * what the member can actually do. A pool that is not taking deposits opens on
   * WITHDRAW when they have something in it, because the supply tab is a dead
   * end there and their exit is the whole reason the row is still listed
   * (FR-021/FR-024). Everything else opens on Supply with Withdraw one tap away.
   */
  const openPool = (pool) => {
    const closedToDeposits = !pool.available
    const held = positionKeys.has(pool.key)
    setSheet({ pool, mode: closedToDeposits && held ? 'withdraw' : 'supply' })
  }

  return (
    <div className="earn-lend supply-view" data-attention="earn-supply">
      {/* FR-020 — open positions first, exactly like the Lend area. */}
      {positions.length > 0 && (
        <div className="earn-positions">
          <h3>
            Your pools
            <InfoTip label="About your pools" className="earn-info">
              {LIQUIDITY_TIPS.positionValue}
            </InfoTip>
          </h3>
          <p className="supply-estimate-legend" role="note">
            {LIQUIDITY_TIPS.estimateLabel}
          </p>
          <ul className="supply-position-list">
            {positions.map((position) => (
              <PositionRow key={position.key} position={position} />
            ))}
          </ul>
        </div>
      )}

      <div className="earn-lend-header">
        <h3>
          Pools you can supply
          <InfoTip label="What is supplying?" className="earn-info">
            {LIQUIDITY_TIPS.supply}
          </InfoTip>
        </h3>
        {tokenFilter && (
          <button type="button" className="earn-filter-chip" onClick={() => setTokenFilter(null)}>
            {tokenFilter} only · clear ✕
          </button>
        )}
      </div>

      {/* Search + kind chips. Offered once there is more than one pool to choose
          between — a search box over a single row is decoration. */}
      {data.status === 'ready' && pools.length > 1 && (
        <div className="supply-toolbar">
          <div className="supply-search">
            <span className="supply-search-icon" aria-hidden="true">
              🔍
            </span>
            <input
              type="search"
              className="supply-search-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pools"
              aria-label="Search pools by asset, network, or type"
            />
          </div>

          {kindsPresent.size > 1 && (
            <div className="supply-kind-filters" role="group" aria-label="Filter pools by type">
              {POOL_KIND_FILTERS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  className={`supply-filter-chip${kindFilter === value ? ' selected' : ''}`}
                  aria-pressed={kindFilter === value}
                  onClick={() => setKindFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* How many of the curated pools the current search is showing — so a short
          list reads as a narrowed one rather than as the whole estate. */}
      {data.status === 'ready' && narrowed && shownPools.length > 0 && (
        <p className="supply-result-count" role="status">
          {`Showing ${shownPools.length} of ${pools.length} pools.`}
        </p>
      )}

      {data.status === 'loading' && <p className="earn-state">Loading pools…</p>}

      {data.status === 'unavailable' && (
        <div className="earn-unavailable" role="alert">
          <p>{LIQUIDITY_UNAVAILABLE.router}</p>
          <button type="button" className="earn-btn secondary" onClick={data.refresh}>
            Try again
          </button>
        </div>
      )}

      {/* Some networks answered and some did not: name the ones that did not
          rather than presenting a short list as the whole curated set. */}
      {data.status === 'ready' && failedNetworks.length > 0 && (
        <p className="supply-note" role="note">
          {`We could not read pools on ${failedNetworks.map((n) => n.name).join(', ')} just now, so any pools there are not listed. Nothing here is invented — a pool that is missing is one we could not confirm.`}
        </p>
      )}
      {data.status === 'ready' && partialNetworks.length > 0 && (
        <p className="supply-note" role="note">
          {`Some pools on ${partialNetworks.map((n) => n.name).join(', ')} could not be read, so this list may be incomplete.`}
        </p>
      )}

      {/* FR-025 — nothing curated anywhere: say so, and name where pooling IS
          available, asymmetrically. No mock rows, no dead controls. */}
      {data.status === 'ready' && pools.length === 0 && (
        <p className="earn-state">{NO_POOLS_COPY}</p>
      )}

      {/* Nothing matched. Which of the two things went wrong decides the copy: a
          deep link asking for an asset no pool takes is a fact about the catalog,
          while a search that found nothing is a fact about the search — and only
          one of them is fixed by typing something else. */}
      {data.status === 'ready' && pools.length > 0 && shownPools.length === 0 && (
        <div className="supply-no-match">
          <p className="earn-state">
            {narrowed
              ? noPoolMatchCopy(query)
              : `No pool takes ${tokenFilter} right now. ${liquidityAvailabilityCopy()}`}
          </p>
          {narrowed && (
            <button type="button" className="earn-btn secondary" onClick={clearNarrowing}>
              Clear search
            </button>
          )}
        </div>
      )}

      {data.status === 'ready' && shownPools.length > 0 && (
        <ul className="supply-pool-list">
          {shownPools.map((pool) => (
            <li key={pool.key}>
              <LiquidityPoolCard pool={pool} position={positionFor(pool)} onOpen={openPool} />
            </li>
          ))}
        </ul>
      )}

      {/* Point 2 — the asymmetry, still stated where a member decides, but folded
          away and moved BELOW the list: it is reference material read once, and as
          a paragraph above the pools it was spending the top of the screen on the
          same sentence every visit. Collapsed and moved, NOT removed — a member
          must still be able to find out that bridge pools are Ethereum-only
          without meeting that fact at the confirm step.

          The active-network note replaces this copy rather than joining it: that
          note already ends with this sentence, and the same sentence twice on one
          screen reads as a glitch — which is also why the whole disclosure stands
          down in the two empty states that already state availability in their own
          copy (`NO_POOLS_COPY` and the token-filter miss). A search that found
          nothing does NOT state it, so there the disclosure stays. */}
      {!availabilityStatedElsewhere && (
        <details className="supply-availability-details">
          <summary>Where pools are available</summary>
          <p className="supply-availability">{activeNetworkNote || liquidityAvailabilityCopy()}</p>
        </details>
      )}

      {data.asOf && (
        <p className="earn-freshness">
          Pool availability as of{' '}
          {new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}.
        </p>
      )}

      <p className="earn-disclosure" role="note">
        {LIQUIDITY_DISCLOSURE}
        <InfoTip label="Who holds my assets?" className="earn-info">
          {LIQUIDITY_TIPS.nonCustodial}
        </InfoTip>{' '}
        <InfoTip label="About withdrawing" className="earn-info">
          {LIQUIDITY_TIPS.withdrawal}
        </InfoTip>
      </p>

      {sheet && (
        <Suspense fallback={<p className="earn-state">Opening…</p>}>
          <SupplySheet
            pool={sheet.pool}
            /* The card asked for supply or withdraw — deliver it. Without this the sheet
               always opened on Supply, and a retired pool has no Supply control at all. */
            initialMode={sheet.mode}
            /* Every curated pool, not just the shown ones: the sheet decides which
               assets can form a real pair, and a token filter must not silently
               narrow what a member is allowed to pair (FR-054). */
            pools={pools}
            assetOptions={assetOptions}
            positions={positions}
            onClose={() => setSheet(null)}
            onActionComplete={() => {
              setSheet(null)
              data.refresh?.()
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
