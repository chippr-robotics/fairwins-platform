/**
 * ledgerRepository — assembly of the unified activity ledger (spec 051).
 *
 * Aggregates LedgerSource adapters (contracts/ledger-source.md) into one
 * normalized, deduplicated, enriched, sorted entry stream per (account,
 * chainId). Per-source degradation: a failing source marks its class stale
 * (`staleClasses`) instead of failing the ledger — the UI discloses staleness
 * honestly (constitution III) rather than blanking or fabricating.
 *
 * The read is two-state (`readState`): `unreadable` when every NETWORK-backed
 * source failed and nothing at all was collected, `read` otherwise. An
 * `unreadable` result's empty entry list is NOT an empty history — see #1280.
 * Sources declare `backing: 'network' | 'client'`; only network-backed ones
 * can testify that a chain went unread, because a client-store read fulfils
 * whether or not any network is up.
 *
 * Failed entries are INCLUDED here; excluding them from financial totals is
 * the summary helpers' job (FR-003), not the repository's.
 */
import { formatUnits } from '../../lib/evm/units'
import { getNetwork } from '../../config/networks'
import { resolveTokenMeta } from '../reports/tokenMeta'
import { valueTransfer } from '../reports/valuation'
import { normalizeEntry, collapseBridgeEntries } from './normalize'
import { mergeEntries } from './identity'
import { VALUATION_STATUS } from './constants'

/**
 * Default enrichment: token meta (symbol/decimals), human amount, and USD
 * valuation. Stablecoins value at the par baseline (spec 016 policy); entries
 * that arrive pre-valued (captured at activity time) keep their value; every
 * other asset is honestly flagged `unvalued` — never zeroed (FR-016).
 */
export async function defaultEnrich(entries, { chainId, fetchOnChain } = {}) {
  const net = getNetwork(Number(chainId))
  const stableAddress = String(net?.stablecoin?.address || '').toLowerCase()
  const out = []
  for (const e of entries) {
    let tokenSymbol = e.tokenSymbol
    let tokenDecimals = e.tokenDecimals
    let amount = e.amount

    if (e.tokenAddress) {
      const meta = await resolveTokenMeta(e.tokenAddress, chainId, { fetchOnChain })
      tokenSymbol = tokenSymbol || meta.ticker
      tokenDecimals = tokenDecimals ?? meta.decimals
    } else {
      tokenSymbol = tokenSymbol || net?.nativeCurrency?.symbol || 'NATIVE'
      tokenDecimals = tokenDecimals ?? 18
    }

    if (amount == null && e.amountRaw != null) {
      try {
        amount = Number(formatUnits(BigInt(e.amountRaw), tokenDecimals))
      } catch {
        amount = null
      }
    }

    let valueUsd = e.valueUsd
    let valuationStatus = e.valuationStatus
    if (valuationStatus == null) {
      if (valueUsd != null && Number.isFinite(Number(valueUsd))) {
        valuationStatus = VALUATION_STATUS.VALUED
      } else if (e.tokenAddress && e.tokenAddress === stableAddress && amount != null) {
        valueUsd = valueTransfer(amount).usdValue
        valuationStatus = VALUATION_STATUS.VALUED
      } else {
        valueUsd = null
        valuationStatus = VALUATION_STATUS.UNVALUED
      }
    }

    out.push({ ...e, tokenSymbol, tokenDecimals, amount, valueUsd, valuationStatus })
  }
  return out
}

function matchesFilter(entry, filter) {
  if (!filter) return true
  if (filter.classes?.length && !filter.classes.includes(entry.class)) return false
  if (filter.statuses?.length && !filter.statuses.includes(entry.status)) return false
  if (filter.kinds?.length && !filter.kinds.includes(entry.kind)) return false
  return true
}

function inPeriod(entry, period) {
  if (!period) return true
  // Entries without a real timestamp cannot be placed in a period; keeping
  // them out of period-scoped views is the honest choice — the full ledger
  // (no period) always lists them.
  if (entry.timestamp == null) return false
  if (period.fromMs != null && entry.timestamp < period.fromMs) return false
  if (period.toMs != null && entry.timestamp > period.toMs) return false
  return true
}

/** Newest first; entries with no real timestamp sort after all dated ones.
 * Exported so the estate merge (spec 092) orders its merged stream with the
 * exact same semantics — one comparator, two consumers. */
export function compareEntries(a, b) {
  const at = a.timestamp
  const bt = b.timestamp
  if (at != null && bt != null) return bt - at
  if (at != null) return -1
  if (bt != null) return 1
  return (b.recordedAt || 0) - (a.recordedAt || 0)
}

/**
 * What a source had to reach to answer. `network` (the default for an
 * unclassified source — the conservative reading, since a failure there is
 * evidence a read did not happen) crosses an RPC or subgraph; `client` reads
 * the local record store and cannot fail because a network is down. Only the
 * former counts toward the `unreadable` verdict below.
 * @param {{backing?: 'network'|'client'}} src
 */
function sourceBacking(src) {
  return src?.backing === 'client' ? 'client' : 'network'
}

/**
 * @param {object} deps
 * @param {Array}  deps.sources - LedgerSource adapters
 * @param {Function} [deps.enrich] - (entries, {chainId}) => enriched entries
 * @param {Function} [deps.getPrunedBefore] - ({account, chainId}) => epoch ms | null (FR-013 disclosure)
 */
export function createLedgerRepository({ sources = [], enrich = defaultEnrich, getPrunedBefore } = {}) {
  /**
   * @param {object} q - { account, chainId, filter?, period?, provider?, signal? }
   * @returns {Promise<{entries: Array, readState: 'read'|'unreadable', staleClasses: string[], prunedBefore: number|null}>}
   */
  async function listEntries(q) {
    const ctx = { account: String(q.account || '').toLowerCase(), chainId: Number(q.chainId) }
    const staleClasses = []
    const settled = await Promise.allSettled(
      sources.map(async (src) => {
        const items = await src.list({ ...ctx, provider: q.provider, signal: q.signal })
        // Normalize inside the per-source boundary so one bad source degrades
        // to stale instead of poisoning the whole ledger.
        //
        // This stays deliberately COARSE. An entry that violates an invariant here (a leaked
        // chainId, an unknown class) is a SOURCE bug, and a source that emits one should be
        // flagged untrustworthy rather than quietly filtered. Damaged STORED records — the
        // self-contradictory bridge a restored backup can carry — are dropped by the source
        // adapter that reads them, so they never reach this boundary.
        return items.map((item) => normalizeEntry(item, ctx))
      }),
    )

    const collected = []
    // Reachability is counted over the NETWORK-backed sources only (#1280).
    // Counting rejections across all nine default sources looked right and was
    // useless: six of them read the client store, which cannot fail during an
    // RPC or subgraph outage, so `failedSources === sources.length` was never
    // true and the verdict below was dead code on the shipped wiring. What
    // makes a chain unreadable is that nothing which had to cross the network
    // came back — a localStorage read fulfilling says nothing about that.
    let networkSources = 0
    let networkFailures = 0
    settled.forEach((res, i) => {
      const isNetworkBacked = sourceBacking(sources[i]) === 'network'
      if (isNetworkBacked) networkSources++
      if (res.status === 'fulfilled') collected.push(...res.value)
      else {
        if (isNetworkBacked) networkFailures++
        staleClasses.push(sources[i].class)
      }
    })

    // The read verdict (constitution III, issue #1280). Per-source degradation
    // is right, but it has one blind spot: when every network-backed source
    // fails the caller gets the same empty array a chain with no history
    // returns, and cannot tell "nothing happened" from "nothing was read". Say
    // so here, where the distinction is knowable. `unreadable` never means
    // empty — it means the entry list below carries no information at all,
    // which is why it also requires that NOTHING was collected: records that
    // did arrive are the member's own data and are shown (with the failed
    // classes disclosed as stale), never discarded as an unreachable chain.
    //
    // A source that returns [] because its contract is not deployed here has
    // FULFILLED — a read of nothing is a read. That is why a chain carrying no
    // FairWins contracts stays `read` with zero entries even mid-outage: there
    // was nothing on it to fail to read.
    const readState =
      networkSources > 0 && networkFailures === networkSources && collected.length === 0
        ? 'unreadable'
        : 'read'

    // Dedup across sources, then collapse every observation of one bridge into
    // the single movement it is — a bridge spans two networks and two
    // transactions but is never two ledger entries (spec 067 FR-035).
    const merged = collapseBridgeEntries(mergeEntries(collected))
    const enriched = await enrich(merged, { chainId: ctx.chainId, provider: q.provider })
    const filtered = enriched.filter((e) => matchesFilter(e, q.filter) && inPeriod(e, q.period))
    filtered.sort(compareEntries)

    return {
      entries: filtered,
      readState,
      staleClasses,
      prunedBefore: typeof getPrunedBefore === 'function' ? getPrunedBefore(ctx) ?? null : null }
  }

  return { listEntries }
}
