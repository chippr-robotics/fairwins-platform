/**
 * Perps read proxy routes — /v1/perps/* (spec 082).
 *
 * Contract: specs/082-perps-trade-view/contracts/gateway-perps-api.md.
 * Pipeline per request: killswitch -> enabled check -> param validation -> quota -> per-venue
 * cached fetch. READ-ONLY by design: there is no write route in this module (FR-018 — no in-app
 * execution this release), so a total outage leaves every value path intact (FR-016).
 *
 * The core rule is PER-VENUE ISOLATION (FR-004): each venue resolves independently to
 * read|degraded via its own cache key; a degraded venue contributes no rows and is reported in
 * `sources` — it never blanks the others and never renders as zeros. Serve-stale is bounded:
 * the TTL cache marks stale values, and anything older than STALE_FACTOR x TTL degrades instead.
 */
import express from 'express'
import { GatewayError } from '../errors.js'
import { callerQuotaKey } from '../identity/quotaKey.js'
import {
  HL_DEFAULT_DEX,
  isAddress,
  normalizeGainsPairs,
  normalizeGainsPendingOrders,
  normalizeGainsPositions,
  normalizeGmxPairs,
  normalizeHyperliquidDexes,
  normalizeHyperliquidPairs,
  normalizeHyperliquidPositions,
} from './normalize.js'

const STALE_FACTOR = 10 // a cached value older than 10x TTL is treated as gone, not served

/* ------------------------------------------------------------------------------------------- *
 * Hyperliquid perp dexes (HIP-3) — the fan-out, and the budget that shapes it
 *
 * Hyperliquid hosts validator-operated perp dexes beside its own book, and every `/info` read
 * defaults to the FIRST one. Reading only that one is how spec 082 reported "no open perp
 * positions" to a member holding 35 of them (hyperliquid-decision.md §5.2). So both reads fan out
 * across the discovered dex list.
 *
 * THE BINDING CONSTRAINT IS THE VENUE'S PER-IP RATE LIMIT, and the gateway is ONE IP for every
 * member (§2.5): 1200 request-weight per minute. The published weights make the arithmetic:
 *
 *   - `clearinghouseState` weighs 2. A 10-dex position fan-out is 20 weight per refresh, and the
 *     15s cache bounds one member to 4 refreshes/min => ~80 weight/min per actively-viewing
 *     member. That is the cost of telling the truth about a member's own positions and it is paid.
 *   - `metaAndAssetCtxs` weighs 20. A 10-dex PAIRS fan-out is 200 weight per refresh, which at the
 *     15s cache would be 800/min — two thirds of the entire budget for a market table nobody is
 *     necessarily looking at. The pairs feed is GLOBAL and single-flight cached, so its cost is
 *     fixed rather than per-member, and it is the one read that can honestly be slowed down: the
 *     non-default dexes get their own longer floor below (~40 weight/min at 10 dexes).
 *
 * Neither knob may ever silence a dex: a dex that was not read is NAMED in `sources.hyperliquid`,
 * because an unqualified absence is precisely the defect being fixed.
 * ------------------------------------------------------------------------------------------- */

/** How many dex reads may be in flight at once — bounds the burst, not the total weight. */
const HL_DEX_CONCURRENCY = 4

/**
 * Floor on the cache TTL for a NON-DEFAULT dex's pair read (5 min). Deliberately not lowerable by
 * env: it exists to hold a venue-side rate limit we do not control, and the direction an operator
 * would want to move it (down) is the direction that breaks the whole venue for every member.
 * `PERPS_CACHE_TTL_MS` still raises it. The default dex — the one carrying essentially all the
 * volume — keeps the normal TTL and is unaffected.
 */
const HL_DEX_PAIRS_MIN_TTL_MS = 300_000

/** Last-resort values, matching `config/index.js`, if the config block predates these knobs. */
const HL_DEX_LIST_TTL_FALLBACK_MS = 3_600_000
const HL_DEX_MAX_FALLBACK = 24

/** A usable positive integer, or the fallback. Never NaN — a NaN cap reads zero dexes. */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving order. `fn` must be total —
 * every caller here goes through `venueRead`, which maps failure to null rather than throwing.
 */
async function mapLimited(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/**
 * @param {object} config full gateway config (only .perps and .feeRouter are read)
 * @param {{
 *   clients: {gains: Record<string, object>, gainsPricing: object|null, gmx: object|null, hyperliquid: object|null},
 *   cache: {fetchThrough: Function},
 *   quotas: {hit: Function},
 *   killSwitch: {isActive: () => boolean},
 *   feeRates?: {getPerpsHlBuilderBps: () => Promise<number|null>} | null,
 *   now?: () => number,
 * }} deps
 */
export function createPerpsRouter(config, { clients, cache, quotas, killSwitch, feeRates = null, now = Date.now }) {
  const perps = config.perps
  const router = express.Router()

  function requireLive() {
    // Module killswitch first (the bitcoin/bridge convention), then the global one.
    if (perps.killSwitch) {
      throw new GatewayError(503, 'perps_killed', 'perps market data is temporarily disabled; try again later')
    }
    if (killSwitch.isActive()) {
      throw new GatewayError(503, 'killswitch_active', 'the gateway is temporarily disabled; try again later')
    }
    if (!perps.enabled) {
      throw new GatewayError(503, 'perps_unconfigured', 'perps market data is not configured on this gateway')
    }
  }

  /**
   * Total-outage honesty (contract: 502 upstream_failed only when EVERY venue fails): a 200 with
   * empty rows must always mean "the venues answered and this is what exists", never "nothing was
   * reachable" — the SPA maps the 502 to its honest unavailable state instead of an empty table.
   */
  function requireAnyRead(sources) {
    const entries = Object.values(sources)
    if (entries.length > 0 && !entries.some((s) => s?.status === 'read')) {
      throw new GatewayError(502, 'upstream_failed', 'no perps venue is reachable right now; try again later')
    }
  }

  // Keyed on the resolved caller (spec 106, FR-011) rather than on `req.ip` alone. An identified
  // caller gets their own bucket and a higher ceiling; an anonymous one still falls back to the
  // network address, which is the weakest key available and the only one left when nothing has
  // been proven.
  const quotaKey = callerQuotaKey

  function guard(req) {
    requireLive()
    const q = quotas.hit(quotaKey(req))
    if (!q.allowed) {
      throw new GatewayError(429, 'quota_exceeded', `${q.scope} perps read quota exceeded`, {
        retryAfterSec: q.retryAfterSec,
      })
    }
  }

  function handleError(res, err) {
    if (err instanceof GatewayError) {
      if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
      return res.status(err.status).json(err.toBody())
    }
    return res
      .status(503)
      .json({ error: { code: 'upstream_unavailable', reason: 'perps market data is temporarily unavailable; try again later' } })
  }

  /**
   * Cached per-venue fetch that maps failure to `null` instead of throwing, so one venue's outage
   * never fails the merged response. Bounded staleness: a stale cache hit past STALE_FACTOR x TTL
   * counts as an outage (stale-as-live would be dishonest, FR-004).
   */
  async function venueRead(key, loader, ttlMs = perps.cacheTtlMs) {
    try {
      const result = await cache.fetchThrough(key, ttlMs, loader)
      if (result.stale && now() - result.fetchedAt > ttlMs * STALE_FACTOR) return null
      return result
    } catch {
      return null
    }
  }

  /* ---- Hyperliquid perp dexes -------------------------------------------------------------- *
   *
   * The dex list is GLOBAL, not per-member, so it is discovered once and cached far longer than a
   * member read: re-fetching it per request would spend `perpDexs` (weight 20) on a fact that
   * changes when Hyperliquid onboards a deployer, i.e. rarely. It grew to 10 while spec 083 was
   * being written and will grow again, which is exactly why it is discovered rather than pinned.
   * ------------------------------------------------------------------------------------------ */

  /**
   * @returns {Promise<{dexes: string[], skipped: string[]|null, discovered: boolean}>}
   *   `dexes` are the ones this request will read; `skipped` names the ones it will not, or is
   *   NULL when discovery itself failed and we cannot name what we are missing. `[]` means nothing
   *   was left out — the two must never be confused, which is why an unknown is not an empty list.
   */
  async function hlDexesToRead() {
    const read = await venueRead(
      'hl-perp-dexs',
      () => clients.hyperliquid.postRead('/info', { type: 'perpDexs' }),
      positiveInt(perps.hlDexListTtlMs, HL_DEX_LIST_TTL_FALLBACK_MS),
    )
    if (!read) {
      // Discovery is down. Read the first dex — which is exactly what spec 082 did — but say so,
      // so the caller can qualify the absence instead of implying the venue was fully searched.
      return { dexes: [HL_DEFAULT_DEX], skipped: null, discovered: false }
    }
    const all = normalizeHyperliquidDexes(read.value)
    // A missing/garbled cap must never resolve to "read nothing": an empty fan-out would report a
    // member's whole Hyperliquid position set as absent, which is the defect, not a safe default.
    const max = positiveInt(perps.hlDexMax, HL_DEX_MAX_FALLBACK)
    // Default dex first (normalizeHyperliquidDexes guarantees it), so a cap can never cost us the
    // book that carries essentially all the volume.
    return { dexes: all.slice(0, max), skipped: all.slice(max), discovered: true }
  }

  /**
   * One `sources.hyperliquid` entry from a fan-out.
   *
   * `partial` is the whole point: a `read` status whose dex list is incomplete would let an empty
   * position list read as "you hold nothing on Hyperliquid" when the honest answer is "nothing on
   * the books we could reach". `status` stays `read` while ANY dex answered — degrading the venue
   * outright would throw away positions we genuinely read (and, on a Hyperliquid-only gateway,
   * turn a good answer into the total-outage 502).
   */
  function hlSource({ dexList, readDexes, anyStale }) {
    const unread = dexList.discovered
      ? [...dexList.dexes.filter((d) => !readDexes.includes(d)), ...dexList.skipped]
      : null
    return {
      status: readDexes.length > 0 ? 'read' : 'degraded',
      chains: [], // non-EVM venue — never a numeric chain id (FR-012)
      stale: anyStale,
      // The venue's own dex names. `''` is the first/default dex, not a missing value.
      dexes: readDexes,
      // Named where we know them; null when dex discovery itself failed, which is "we do not know
      // what we missed" and must not be flattened into "we missed nothing".
      unreadDexes: unread,
      partial: unread == null || unread.length > 0,
    }
  }

  /** Gains needs the (large) trading-variables payload for pairs, positions and scaling context. */
  const gainsTvRead = (chainId) =>
    venueRead(`gains-tv:${chainId}`, () => clients.gains[chainId].get('/trading-variables'))

  /**
   * Gains per-member state: `pendingMarketOrders` / `pendingMarketOrdersIds` (spec 083) — the
   * stuck-order recovery surface. Cached per (chain, address) like the open-trades read.
   */
  const gainsUserTvRead = (chainId, address) =>
    venueRead(`gains-utv:${chainId}:${address.toLowerCase()}`, () =>
      clients.gains[chainId].get(`/user-trading-variables/${address}`),
    )

  /** The gains pricing feed is one global snapshot (pair universe is shared across chains). */
  const gainsPricesRead = () =>
    clients.gainsPricing ? venueRead('gains-prices', () => clients.gainsPricing.get('/charts')) : Promise.resolve(null)

  // ---- GET /v1/perps/pairs ------------------------------------------------------------------
  router.get('/v1/perps/pairs', async (req, res) => {
    try {
      guard(req)

      const gainsChainIds = Object.keys(clients.gains)
      const [gainsPrices, ...gainsTvs] = await Promise.all([gainsPricesRead(), ...gainsChainIds.map(gainsTvRead)])

      const gmxResult = clients.gmx
        ? await venueRead('gmx-pairs', async () => {
            const [marketsInfo, tickers, tokens] = await Promise.all([
              clients.gmx.get('/markets/info'),
              clients.gmx.get('/prices/tickers'),
              clients.gmx.get('/tokens'),
            ])
            return { marketsInfo, tickers, tokens }
          })
        : null

      // Hyperliquid: one read per perp dex, so HIP-3 markets are listed instead of silently
      // missing. The default dex keeps the normal TTL; the rest sit behind the longer floor that
      // keeps a 10x weight-20 fan-out inside the venue's per-IP budget (see the header).
      const hlDexList = clients.hyperliquid ? await hlDexesToRead() : null
      const hlPairReads = hlDexList
        ? await mapLimited(hlDexList.dexes, HL_DEX_CONCURRENCY, async (dex) => ({
            dex,
            read: await venueRead(
              `hl-pairs:${dex}`,
              () => clients.hyperliquid.postRead('/info', { type: 'metaAndAssetCtxs', dex }),
              dex === HL_DEFAULT_DEX ? perps.cacheTtlMs : Math.max(perps.cacheTtlMs, HL_DEX_PAIRS_MIN_TTL_MS),
            ),
          }))
        : null

      const pairs = []
      const sources = {}

      if (gainsChainIds.length > 0) {
        const okChains = []
        let anyStale = false
        gainsChainIds.forEach((chainId, i) => {
          const tv = gainsTvs[i]
          if (!tv) return
          okChains.push(Number(chainId))
          if (tv.stale) anyStale = true
          pairs.push(
            ...normalizeGainsPairs({
              tradingVariables: tv.value,
              chartPrices: gainsPrices?.value ?? null,
              chainId: Number(chainId),
            }),
          )
        })
        sources.gains = { status: okChains.length > 0 ? 'read' : 'degraded', chains: okChains, stale: anyStale }
      }

      if (clients.gmx) {
        if (gmxResult) {
          pairs.push(...normalizeGmxPairs({ ...gmxResult.value, chainId: perps.gmxChainId }))
          sources.gmx = { status: 'read', chains: [perps.gmxChainId], stale: Boolean(gmxResult.stale) }
        } else {
          sources.gmx = { status: 'degraded', chains: [], stale: false }
        }
      }

      if (clients.hyperliquid) {
        const readDexes = []
        let anyStale = false
        for (const { dex, read } of hlPairReads) {
          if (!read) continue // this dex did not answer — reported below, never rendered as empty
          readDexes.push(dex)
          if (read.stale) anyStale = true
          pairs.push(...normalizeHyperliquidPairs({ metaAndAssetCtxs: read.value, dex }))
        }
        sources.hyperliquid = hlSource({ dexList: hlDexList, readDexes, anyStale })
      }

      requireAnyRead(sources)
      res.json({ pairs, sources, asOf: new Date(now()).toISOString() })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/perps/positions?address=0x… --------------------------------------------------
  // Read-only, per-venue isolated. GMX positions are NOT served here: the GMX REST API does not
  // expose them and they are read client-side from GMX's Reader contract (spec 083 T032) — the
  // venue stays honestly ABSENT from `sources` rather than being invented in the gateway.
  //
  // Spec 083 adds `pendingOrders` to THIS response rather than a sibling route, deliberately:
  // positions and pending orders are one screen and one member fact. Two routes would mean two
  // quota hits, two independent staleness windows, and two `sources` maps that can disagree — the
  // UI could then show "gains: read" positions while the member's stuck order silently 502'd, which
  // is exactly the invisibility this surface exists to prevent. Older clients ignore the new array.
  router.get('/v1/perps/positions', async (req, res) => {
    try {
      const address = typeof req.query.address === 'string' ? req.query.address : ''
      if (!isAddress(address)) {
        throw new GatewayError(400, 'invalid_address', 'address must be a 0x-prefixed 20-byte hex address')
      }
      guard(req)
      const addr = address.toLowerCase()

      const gainsChainIds = Object.keys(clients.gains)
      const gainsReads = await Promise.all(
        gainsChainIds.map(async (chainId) => {
          const [tv, open, userTv] = await Promise.all([
            gainsTvRead(chainId),
            venueRead(`gains-open:${chainId}:${addr}`, () => clients.gains[chainId].get(`/open-trades/${address}`)),
            gainsUserTvRead(chainId, address),
          ])
          return {
            chainId: Number(chainId),
            tv: tv?.value ?? null,
            open: open?.value ?? null,
            userTv: userTv?.value ?? null,
            // The two facets resolve INDEPENDENTLY. Positions need the trading variables for their
            // scales; pending orders do not (an order with a null symbol is still recoverable), so
            // a trading-variables outage must never withhold a recovery handle (exits are never
            // gated — not by a flag, not by an outage).
            positionsOk: Boolean(tv && open),
            pendingOk: Boolean(userTv),
          }
        }),
      )

      // THE FAN-OUT THAT FIXES THE FABRICATED ABSENCE. `clearinghouseState` answers for ONE perp
      // dex, so a member whose positions all live on a HIP-3 book was told they had none. Each dex
      // is cached and isolated exactly like a venue: one that did not answer contributes no rows
      // and is NAMED, never rendered as "nothing here".
      const hlDexList = clients.hyperliquid ? await hlDexesToRead() : null
      const hlReads = hlDexList
        ? await mapLimited(hlDexList.dexes, HL_DEX_CONCURRENCY, async (dex) => ({
            dex,
            read: await venueRead(`hl-positions:${addr}:${dex}`, () =>
              clients.hyperliquid.postRead('/info', { type: 'clearinghouseState', user: address, dex }),
            ),
          }))
        : null

      const positions = []
      // Gains is the only venue contributing pending orders: GMX orders are read client-side with
      // its Reader, and Hyperliquid's resting orders are out of scope for this release.
      const pendingOrders = []
      const sources = {}

      if (gainsChainIds.length > 0) {
        const okChains = []
        const pendingOrderChains = []
        for (const read of gainsReads) {
          if (read.positionsOk) {
            okChains.push(read.chainId)
            positions.push(
              ...normalizeGainsPositions({ openTrades: read.open, tradingVariables: read.tv, chainId: read.chainId }),
            )
          }
          if (read.pendingOk) {
            pendingOrderChains.push(read.chainId)
            pendingOrders.push(
              ...normalizeGainsPendingOrders({
                userTradingVariables: read.userTv,
                tradingVariables: read.tv,
                chainId: read.chainId,
              }),
            )
          }
        }
        // `chains` is the POSITION facet (unchanged for spec-082 clients); `pendingOrderChains` is
        // the recovery facet. A chain present in one and missing from the other says "this fact is
        // unknown here" — an empty `pendingOrders` for a chain that never answered must not read as
        // "you have no stuck orders".
        sources.gains = { status: okChains.length > 0 ? 'read' : 'degraded', chains: okChains, pendingOrderChains }
      }

      if (clients.hyperliquid) {
        const readDexes = []
        let anyStale = false
        for (const { dex, read } of hlReads) {
          if (!read) continue
          readDexes.push(dex)
          if (read.stale) anyStale = true
          positions.push(...normalizeHyperliquidPositions({ clearinghouseState: read.value, dex }))
        }
        sources.hyperliquid = hlSource({ dexList: hlDexList, readDexes, anyStale })
      }

      // The total-outage 502 stands — with one exception: if we DID reach a member's pending
      // orders, a 502 would bury a recovery handle behind an error screen. Exits are never gated,
      // and an outage is not an exception to that; the honest answer is the orders plus a `sources`
      // map that says which reads failed.
      if (pendingOrders.length === 0) requireAnyRead(sources)
      res.json({ positions, pendingOrders, sources, asOf: new Date(now()).toISOString() })
    } catch (err) {
      handleError(res, err)
    }
  })

  // ---- GET /v1/perps/config -----------------------------------------------------------------
  // Public attribution identifiers + the live Hyperliquid builder-fee bps. Since spec 060 the bps
  // come LIVE from the FeeRouter (`perps.hyperliquid.builder`, admin-editable on-chain); the env
  // value is the honest fallback when the router is unset/unreachable. Never contains secrets.
  router.get('/v1/perps/config', async (req, res) => {
    try {
      guard(req)
      const live = feeRates ? await feeRates.getPerpsHlBuilderBps() : null
      res.json({
        attribution: {
          gains: { referrer: perps.gainsReferrer ?? null },
          gmx: { refCode: perps.gmxRefCode ?? null },
          hyperliquid: { builderAddress: perps.hlBuilderAddress ?? null },
        },
        hyperliquidBuilderFee: {
          bps: live ?? perps.hlBuilderFeeBps,
          capBps: perps.hlBuilderFeeCapBps,
          source: live != null ? 'chain' : 'env-fallback',
        },
      })
    } catch (err) {
      handleError(res, err)
    }
  })

  return router
}

/** /status contribution (FR-014): operational visibility, no member data. */
export function perpsStatus(config, { killSwitch }) {
  const perps = config.perps
  return {
    // Honest liveness: the module is "enabled" only if a request right now would be served —
    // the module killswitch counts as much as the global one.
    enabled: Boolean(perps.enabled) && !perps.killSwitch && !killSwitch.isActive(),
    venues: {
      gains: Object.entries(perps.gainsUrls)
        .filter(([, url]) => Boolean(url))
        .map(([chainId]) => Number(chainId)),
      gmx: Boolean(perps.gmxUrl),
      hyperliquid: Boolean(perps.hlUrl),
    },
    attribution: {
      gains: Boolean(perps.gainsReferrer),
      gmx: Boolean(perps.gmxRefCode),
      hyperliquid: Boolean(perps.hlBuilderAddress),
    },
    hlBuilderFeeBpsFallback: perps.hlBuilderFeeBps,
  }
}
