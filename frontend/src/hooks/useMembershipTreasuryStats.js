/**
 * useMembershipTreasuryStats — derives app-wide membership statistics and treasury growth for the
 * platform Admin → Overview from a bounded, resilient client-side event scan of the MembershipManager.
 *
 * The MembershipManager exposes only point-lookup views (per-user `getMembership`, a single
 * `accruedFees` counter) — no enumeration, no aggregate revenue counters — and the subgraph does not
 * index it. Under the repo's no-backend footprint, event-log scanning is the only aggregate source,
 * exactly like `useCallsignRegistryMetrics` (spec 054). We reduce the membership lifecycle events into:
 *   • membership statistics — lifetime event counts + currently-active members (net, by tier), and
 *   • treasury growth — gross membership revenue (paid purchases + extensions + upgrades) plus the
 *     amount already withdrawn to the treasury (`FeesWithdrawn`), the two streams that fund the treasury.
 *
 * The scan is bounded (a MAX_SPAN backward lookback, never from genesis — public RPCs reject wide
 * eth_getLogs), chunked, and degrades on provider range-caps via `getLogsRange` (bisect-on-reject).
 * Results are cached per (chain, address) with a short TTL so remounts don't re-scan. Triggered
 * explicitly (a Refresh button), never auto-polled. When the lookback is capped, `truncated` is true
 * and lifetime tallies / revenue are honestly "within the scanned window", not all-time.
 */
import { useCallback, useState } from 'react'
import { isAddress } from 'viem'
import { formatUnits } from '../lib/evm/units'
import { eventScanHandle } from '../lib/chains/eventScan'
import { MEMBERSHIP_MANAGER_ABI } from '../abis/MembershipManager'
import { getLogsRange } from '../lib/chains/logRange'

const CHUNK = 45_000
const MAX_SPAN = 3_000_000
const CACHE_TTL_MS = 60_000
const RECENT_LIMIT = 25
const USDC_DECIMALS = 6

const cacheByKey = new Map() // `${chainId}:${address}` -> { at, data }

// Format a USDC (6-decimal) bigint as a plain decimal string for display.
function fmtUsdc(v) {
  return formatUnits(v ?? 0n, USDC_DECIMALS)
}

/**
 * Turn a provider failure into something an operator can act on.
 *
 * A pruned-history refusal arrives as a raw JSON-RPC dump — the error object, the whole
 * `eth_getLogs` payload, hex block numbers, and the vendor's own upsell link — which tells an
 * operator nothing about what to DO. It is also not a bug in the scan: the endpoint simply does
 * not keep the blocks, and the fix is to point the chain at an archival endpoint, which spec 069
 * puts in the member's hands (Settings ▸ Network). Say that instead.
 *
 * The raw text is still appended, because a failure nobody can diagnose is its own problem.
 */
export function describeScanFailure(err) {
  const raw = err?.message || String(err || '')
  // -32701 is the code seen from Polygon public nodes; the phrasing varies by vendor, so match
  // the condition rather than any one provider's wording.
  const pruned =
    /has been pruned|missing trie node|state is not available|older than \d+ blocks|archive (node|data)/i.test(raw) ||
    String(err?.error?.code || err?.code || '') === '-32701'
  if (!pruned) return raw
  return (
    'This endpoint does not keep enough history for the scan — it has pruned the blocks the ' +
    'lifetime tallies are read from. Point this chain at an archival RPC endpoint under ' +
    'Settings ▸ Network, then run the scan again. ' +
    `(Endpoint said: ${raw})`
  )
}

/**
 * Pure reducer: fold parsed MembershipManager events into app-wide membership + treasury metrics.
 * Exported for unit testing. All USDC sums are returned as bigint (6-decimal base units); the caller
 * formats. `nowSec` (unix seconds) decides which memberships are still active — pass the current time.
 *
 * @param {Array<{name:string,args:object,blockNumber:number,logIndex:number}>} events parsed log events
 * @param {boolean} truncated whether the scan window was capped (older history not loaded)
 * @param {number} nowSec current time in unix seconds (memberships with expiresAt > nowSec are active)
 */
export function reduceMembershipTreasuryStats(events, truncated = false, nowSec = 0) {
  // Replay in chain order so per-member tier/expiry state and cumulative revenue are correct.
  const ordered = [...events].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  )

  const counts = { purchased: 0, granted: 0, redeemed: 0, extended: 0, upgraded: 0, revoked: 0 }
  const revenue = { purchases: 0n, extensions: 0n, upgrades: 0n, withdrawn: 0n }
  const revenueByTier = { 1: 0n, 2: 0n, 3: 0n, 4: 0n }

  // Per (user,role) membership state, replayed last-write-wins. A member holds at most one active
  // membership per role, so keying by user+role de-dupes repeat purchases/extensions into one member.
  const members = new Map() // `${user}:${role}` -> { tier, expiresAt, revoked }
  const memberKey = (user, role) => `${String(user).toLowerCase()}:${role}`

  // Cumulative membership-revenue series (magnitude over the sequence of revenue events). Block
  // numbers are the only monotonic clock the logs carry (events don't include timestamps), so the
  // series is honestly "cumulative revenue vs. block", not calendar time.
  const series = []
  let cumulative = 0n

  const addRevenue = (bucket, tier, amount) => {
    if (!amount) return
    revenue[bucket] += amount
    if (tier >= 1 && tier <= 4) revenueByTier[tier] += amount
    cumulative += amount
  }

  for (const ev of ordered) {
    const { name, args, blockNumber } = ev
    switch (name) {
      case 'MembershipPurchased': {
        counts.purchased++
        const tier = Number(args.tier)
        members.set(memberKey(args.user, args.role), { tier, expiresAt: Number(args.expiresAt), revoked: false })
        addRevenue('purchases', tier, BigInt(args.price ?? 0))
        series.push({ block: blockNumber, cumulative })
        break
      }
      case 'MembershipGranted': {
        counts.granted++
        // Admin grant — free (no price paid to the contract), so it funds no treasury growth.
        members.set(memberKey(args.user, args.role), { tier: Number(args.tier), expiresAt: Number(args.expiresAt), revoked: false })
        break
      }
      case 'MembershipRedeemed': {
        counts.redeemed++
        // Voucher redemption — already paid for at voucher mint, no price at redeem time.
        members.set(memberKey(args.user, args.role), { tier: Number(args.tier), expiresAt: Number(args.expiresAt), revoked: false })
        break
      }
      case 'MembershipExtended': {
        counts.extended++
        const cur = members.get(memberKey(args.user, args.role))
        const tier = cur ? cur.tier : 0
        if (cur) cur.expiresAt = Number(args.expiresAt)
        else members.set(memberKey(args.user, args.role), { tier: 0, expiresAt: Number(args.expiresAt), revoked: false })
        addRevenue('extensions', tier, BigInt(args.price ?? 0))
        series.push({ block: blockNumber, cumulative })
        break
      }
      case 'MembershipUpgraded': {
        counts.upgraded++
        const cur = members.get(memberKey(args.user, args.role))
        const toTier = Number(args.toTier)
        if (cur) cur.tier = toTier
        else members.set(memberKey(args.user, args.role), { tier: toTier, expiresAt: 0, revoked: false })
        addRevenue('upgrades', toTier, BigInt(args.delta ?? 0))
        series.push({ block: blockNumber, cumulative })
        break
      }
      case 'MembershipRevoked': {
        counts.revoked++
        const cur = members.get(memberKey(args.user, args.role))
        if (cur) cur.revoked = true
        break
      }
      case 'FeesWithdrawn': {
        revenue.withdrawn += BigInt(args.amount ?? 0)
        break
      }
      default:
        break
    }
  }

  revenue.total = revenue.purchases + revenue.extensions + revenue.upgrades

  // Active members: still within their term (expiresAt > now) and not revoked. Grants/redemptions
  // carry an expiry too, so they count while live. `everMembers` is every unique (user,role) seen.
  const byTier = { 1: 0, 2: 0, 3: 0, 4: 0 }
  let active = 0
  for (const m of members.values()) {
    if (m.revoked) continue
    if (m.expiresAt > nowSec) {
      active++
      if (m.tier >= 1 && m.tier <= 4) byTier[m.tier]++
    }
  }

  const recent = [...ordered]
    .reverse()
    .slice(0, RECENT_LIMIT)
    .map((ev) => ({
      type: ev.name,
      user: ev.args.user || ev.args.to || null,
      tier: ev.args.tier != null ? Number(ev.args.tier) : (ev.args.toTier != null ? Number(ev.args.toTier) : null),
      amount:
        ev.args.price != null ? BigInt(ev.args.price)
          : ev.args.delta != null ? BigInt(ev.args.delta)
            : ev.args.amount != null ? BigInt(ev.args.amount)
              : null,
      block: ev.blockNumber,
    }))

  return {
    counts,
    revenue,
    revenueByTier,
    members: { active, everMembers: members.size, byTier },
    series,
    recent,
    truncated,
    totalEvents: events.length,
  }
}

/**
 * @param {{ provider: any, chainId: number, address: string }} args
 * @returns {{ loading, error, data, truncated, refresh }}
 */
export function useMembershipTreasuryStats({ provider, chainId, address } = {}) {
  const [state, setState] = useState({ loading: false, error: null, data: null, truncated: false })

  const refresh = useCallback(
    async ({ force = false } = {}) => {
      // Spec 110 Phase 1: the scan reads through the chain seam; `provider` stays the
      // caller-side availability gate until callers convert.
      const handle =
        chainId != null && address && isAddress(address)
          ? eventScanHandle(chainId, { address, abi: MEMBERSHIP_MANAGER_ABI })
          : null
      if (!provider || !handle) {
        setState({ loading: false, error: null, data: null, truncated: false })
        return
      }
      const key = `${chainId}:${address.toLowerCase()}`
      const cached = cacheByKey.get(key)
      if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
        setState({ loading: false, error: null, data: cached.data, truncated: cached.data.truncated })
        return
      }
      setState((s) => ({ ...s, loading: true, error: null }))
      try {
        const latest = await handle.provider.getBlockNumber()
        const floor = Math.max(0, latest - MAX_SPAN)
        const rawLogs = []
        let to = latest
        while (to >= floor) {
          const from = Math.max(floor, to - CHUNK + 1)
          // No topic filter → all MembershipManager events in the range; getLogsRange bisects on RPC caps.
          const batch = await getLogsRange(handle.provider, address, from, to, 2000, [])
          rawLogs.push(...batch)
          if (from === floor) break
          to = from - 1
        }
        const parsed = []
        for (const log of rawLogs) {
          try {
            const p = handle.interface.parseLog({ topics: log.topics, data: log.data })
            if (p) parsed.push({ name: p.name, args: p.args, blockNumber: log.blockNumber, logIndex: log.index ?? log.logIndex })
          } catch {
            /* not one of our events — skip */
          }
        }
        const nowSec = Math.floor(Date.now() / 1000)
        const data = reduceMembershipTreasuryStats(parsed, floor > 0, nowSec)
        cacheByKey.set(key, { at: Date.now(), data })
        setState({ loading: false, error: null, data, truncated: data.truncated })
      } catch (err) {
        setState({ loading: false, error: describeScanFailure(err), data: null, truncated: false })
      }
    },
    [provider, chainId, address],
  )

  return { ...state, refresh }
}

export { fmtUsdc }
export default useMembershipTreasuryStats
