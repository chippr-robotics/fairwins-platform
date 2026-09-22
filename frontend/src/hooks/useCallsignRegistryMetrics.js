/**
 * useCallsignRegistryMetrics (spec 054 — operator admin) — derives registry-wide metrics for the operator
 * dashboard from a bounded, resilient client-side event scan. The CallsignRegistry exposes only
 * point-lookup views (no counters / enumeration) and the subgraph does not index it, so — under the
 * no-backend footprint — event-log scanning is the only aggregate source (mirrors DenyListAdmin).
 *
 * The scan is bounded (a MAX_SPAN backward lookback, never from genesis — public RPCs reject wide
 * eth_getLogs), chunked, and degrades on provider range-caps via `getLogsRange` (bisect-on-reject).
 * Results are cached per (chain, address) with a short TTL so remounts don't re-scan. Triggered
 * explicitly (a Refresh button), never auto-polled. When the lookback is capped, `truncated` is true
 * and lifetime tallies are honestly "within the scanned window", not all-time.
 */
import { useCallback, useState } from 'react'
import { isAddress } from 'viem'
import { CALLSIGN_REGISTRY_ABI, CallsignStatus } from '../abis/callsignRegistry'
import { eventScanHandle } from '../lib/chains/eventScan'
import { getLogsRange } from '../lib/chains/logRange'

const CHUNK = 45_000
const MAX_SPAN = 3_000_000
const CACHE_TTL_MS = 60_000
const RECENT_LIMIT = 50

const cacheByKey = new Map() // `${chainId}:${address}` -> { at, data }

/**
 * Pure reducer: fold parsed registry events into operator metrics. Exported for unit testing.
 * @param {Array<{name:string,args:object,blockNumber:number,logIndex:number}>} events parsed log events
 * @param {boolean} truncated whether the scan window was capped (older history not loaded)
 */
export function reduceCallsignMetrics(events, truncated = false) {
  // Replay moderation state in chain order (last-write-wins per callsignHash).
  const ordered = [...events].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex,
  )
  const counts = {
    registered: 0,
    changed: 0,
    released: 0,
    reclaimed: 0,
    repointRequested: 0,
    repointFinalized: 0,
    repointCancelled: 0,
    committed: 0,
  }
  const suspended = new Set()
  const verified = new Set()
  const reserved = new Set()
  const hashToCallsign = new Map()

  for (const ev of ordered) {
    switch (ev.name) {
      case 'CallsignRegistered':
        counts.registered++
        if (ev.args.callsign) hashToCallsign.set(ev.args.callsignHash, ev.args.callsign)
        break
      case 'CallsignChanged':
        counts.changed++
        break
      case 'CallsignReleased':
        counts.released++
        break
      case 'CallsignReclaimed':
        counts.reclaimed++
        break
      case 'CallsignRepointRequested':
        counts.repointRequested++
        break
      case 'CallsignRepointFinalized':
        counts.repointFinalized++
        break
      case 'CallsignRepointCancelled':
        counts.repointCancelled++
        break
      case 'CallsignCommitted':
        counts.committed++
        break
      case 'CallsignSuspended':
        if (ev.args.suspended) suspended.add(ev.args.callsignHash)
        else suspended.delete(ev.args.callsignHash)
        break
      case 'CallsignVerificationSet':
        if (ev.args.verified) verified.add(ev.args.callsignHash)
        else verified.delete(ev.args.callsignHash)
        break
      case 'CallsignReserved':
        if (ev.args.reserved) reserved.add(ev.args.callsignHash)
        else reserved.delete(ev.args.callsignHash)
        break
      default:
        break
    }
  }

  // Net change to the active set within the window. CallsignChanged and repoints are count-neutral
  // (change: -1 old +1 new; repoint: owner moves, count unchanged), so net = registered − released
  // − reclaimed. When the window is not truncated (floor == 0) this equals the live active total.
  const netRegistrations = counts.registered - counts.released - counts.reclaimed

  const label = (h) => hashToCallsign.get(h) || null
  const recent = [...ordered]
    .reverse()
    .slice(0, RECENT_LIMIT)
    .map((ev) => ({
      type: ev.name,
      callsignHash: ev.args.callsignHash || ev.args.newCallsignHash || null,
      callsign: label(ev.args.callsignHash || ev.args.newCallsignHash),
      owner: ev.args.owner || ev.args.to || ev.args.from || null,
      block: ev.blockNumber,
    }))

  return {
    counts,
    netRegistrations,
    suspended: [...suspended].map((h) => ({ callsignHash: h, callsign: label(h) })),
    verified: [...verified].map((h) => ({ callsignHash: h, callsign: label(h) })),
    reserved: [...reserved].map((h) => ({ callsignHash: h, callsign: label(h) })),
    recent,
    truncated,
    totalEvents: events.length,
  }
}

/**
 * @param {{ provider: any, chainId: number, address: string }} args
 * @returns {{ loading, error, data, truncated, refresh }}
 */
export function useCallsignRegistryMetrics({ provider, chainId, address } = {}) {
  const [state, setState] = useState({ loading: false, error: null, data: null, truncated: false })

  const refresh = useCallback(
    async ({ force = false } = {}) => {
      // Spec 110 Phase 1: the scan reads through the chain seam; `provider` stays the
      // caller-side availability gate until callers convert.
      const handle =
        chainId != null && address && isAddress(address)
          ? eventScanHandle(chainId, { address, abi: CALLSIGN_REGISTRY_ABI })
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
          // No topic filter → all registry events in the range; getLogsRange bisects on RPC range-caps.
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
        const data = reduceCallsignMetrics(parsed, floor > 0)
        cacheByKey.set(key, { at: Date.now(), data })
        setState({ loading: false, error: null, data, truncated: data.truncated })
      } catch (err) {
        setState({ loading: false, error: err?.message || String(err), data: null, truncated: false })
      }
    },
    [provider, chainId, address],
  )

  return { ...state, refresh }
}

// Re-export for consumers building status chips.
export { CallsignStatus }
export default useCallsignRegistryMetrics
