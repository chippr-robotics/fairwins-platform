// Spec 102 (D5, US3) — a vault's proposal queue on EVERY network it lives on. `useVaultProposals`
// reads one instance, and only while the wallet is on that instance's chain; this hook reads each
// instance of a VaultGroup on ITS OWN chain, named per read, so the member's pending work is not a
// function of which network their wallet happens to be on.
//
// Every chain resolves to exactly one state — `read` / `unreadable` / `not-configured` /
// `not-supported` (plus `loading` in flight) — and rows exist ONLY for `read`. Constitution III:
// a chain that could not be read is named, never rendered as "none pending". Failures are
// isolated per chain (one dead RPC degrades one entry) and each chain carries its own request-id
// guard, so a slow read on Base can never overwrite a fresh one on Polygon, or leak into another
// vault after the sheet moved on.
//
// The enrichment (owners / threshold / nonce / approvedHashes → deriveProposalStatus) mirrors
// `useVaultProposals.refresh` exactly; the two must stay in step or the same proposal would show
// two statuses depending on which surface the member opened.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useWallet } from '.'
import { SAFE_ABI } from '../abis/Safe'
import { NETWORKS } from '../config/networks'
import { getContractAddressForChain, getDeploymentBlockForChain } from '../config/contracts'
import { eventScanHandle } from '../lib/chains/eventScan'
import { readContract, NoRpcEndpointError } from '../lib/chains/readContract'
import { getAddress } from '../lib/evm/address'
import { readVerifiedProposals } from '../lib/custody/proposalHub'
import { readExecutionOutcomes } from '../lib/custody/vaultProposalReads'

/** Ceiling on one chain's read. Exported for tests; a member-facing surface waits this long at most. */
export const QUEUE_READ_TIMEOUT_MS = 20_000

function withReadTimeout(promise, chainId, ms = QUEUE_READ_TIMEOUT_MS) {
  let timer
  const ceiling = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Chain ${chainId} did not answer within ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer))
}
import { deriveProposalStatus, isQueued } from '../lib/custody/proposalStatus'

const EMPTY = Object.freeze({})

/**
 * @param {object|null} group a VaultGroup from `useCustodyVaults().groups` (or anything with `key` + `instances`)
 * @returns {{ byChain: object, rows: object[], pending: number, missing: number[], partial: boolean, loading: boolean, refresh: (chainId?: number) => Promise<void> }}
 */
export function useVaultQueueAcrossChains(group) {
  // The wallet supplies the member's identity only. WHICH CHAIN a queue is read on is a property of
  // the vault instance, never of the connection (spec 102, spec 110) — so no provider is taken here,
  // and a member sitting on Polygon reads their Base queue by exactly the same path.
  const { address } = useWallet()
  const [byChain, setByChain] = useState(EMPTY)
  // Per-(vault, chain) request ids: `${key}:${chainId}` → latest request number.
  const reqIds = useRef({})
  // The group the reads belong to. A commit for another vault's chain is dropped, not merged.
  const groupKeyRef = useRef(null)
  // Latest instances, so `refresh(chainId)` from a callback reads the CURRENT instance.
  const instancesRef = useRef([])

  const key = group?.key || null
  // Safe instances only: an EOA / unreachable instance has no queue to read and is reported by the
  // list (unreachable / unreadable), not here.
  const instances = useMemo(
    () => (group?.instances || []).filter((i) => i?.isSafe === true && i.chainId != null),
    [group],
  )
  // Instances the LIST already failed to read (unreachable chain, or no Safe there) still get an
  // entry — `unreadable`, with the list's own reason — so the queue's per-network line states the
  // fact rather than leaving a hole that renders as "reading…" (actor-critic round 3 finding).
  const unread = useMemo(
    () =>
      (group?.instances || [])
        .filter((i) => i?.chainId != null && i.isSafe !== true)
        .map((i) => ({
          chainId: Number(i.chainId),
          state: 'unreadable',
          proposals: [],
          partial: false,
          owner: false,
          error:
            i.reachable === false
              ? `${NETWORKS[Number(i.chainId)]?.name || `Chain ${Number(i.chainId)}`} could not be reached`
              : 'No Safe could be read at this address on this network',
        })),
    [group],
  )
  // Declared BEFORE the read effect below: effects run in order, so it sees the current set.
  useEffect(() => {
    instancesRef.current = instances
  }, [instances])
  const chainKey = instances
    .map((i) => Number(i.chainId))
    .concat(unread.map((u) => `!${u.chainId}`))
    .join(',')

  const readChain = useCallback(
    async (inst) => {
      const cid = Number(inst.chainId)
      const slot = `${key}:${cid}`
      const myReq = (reqIds.current[slot] = (reqIds.current[slot] || 0) + 1)
      const commit = (patch) => {
        if (reqIds.current[slot] !== myReq || groupKeyRef.current !== key) return
        setByChain((prev) => ({ ...prev, [cid]: { chainId: cid, proposals: [], partial: false, owner: false, ...patch } }))
      }

      // Strict lookup: a chain this build does not know is stated as such, never relabelled as the
      // default network by `getNetwork()`.
      if (!NETWORKS[cid]) return commit({ state: 'not-supported' })
      const hubAddress = getContractAddressForChain('safeProposalHub', cid)
      // Never scan from genesis (contracts.js guidance): a hub with no recorded deploy block means
      // proposal discovery is honestly "not configured", not "nothing pending".
      const fromBlock = getDeploymentBlockForChain('safeProposalHub', cid)
      if (!hubAddress || !fromBlock) return commit({ state: 'not-configured' })

      commit({ state: 'loading' })
      try {
        const safeRead = (functionName, args) =>
          readContract(cid, { address: inst.address, abi: SAFE_ABI, functionName, args })
        // The scan handle is the log-reading half of what `new Contract(…)` used to be; the views go
        // through `readContract`. Both name `cid`, so nothing here can read the wrong chain.
        const safe = eventScanHandle(cid, { address: inst.address, abi: SAFE_ABI })
        if (!safe) throw new NoRpcEndpointError(cid)
        // A chain whose endpoint never answers must resolve to `unreadable`, not sit on
        // "reading…" for the life of the sheet: a transport can retry indefinitely on a dead
        // endpoint, so without a ceiling the member never learns that this network was not read.
        const [ownersRaw, thresholdRaw, nonceRaw] = await withReadTimeout(
          Promise.all([safeRead('getOwners'), safeRead('getThreshold'), safeRead('nonce')]),
          cid,
        )
        const owners = ownersRaw.map((o) => getAddress(o))
        const threshold = Number(thresholdRaw)
        const currentNonce = Number(nonceRaw)

        const { proposals: verified, complete: hubComplete } = await withReadTimeout(
          readVerifiedProposals({
            hubAddress,
            safeAddress: inst.address,
            chainId: cid,
            fromBlock,
          }),
          cid,
        )
        const { executed, failed, complete: execComplete } = await withReadTimeout(
          readExecutionOutcomes({ safe, chainId: cid, fromBlock }),
          cid,
        )

        /*
         * ONE row per proposal. The hub scan is chunked and session-cached (lib/chain/logScan), so
         * the same `Proposed` log can come back from two overlapping ranges — observed on a local
         * chain as React's duplicate-key warning and, on a real vault, as the same pending
         * transaction rendered twice with two Approve buttons. A proposal is identified by its
         * safeTxHash on its chain; reading it twice is a scan artifact, never two proposals.
         */
        const unique = []
        const seenHash = new Set()
        for (const p of verified) {
          const h = String(p.safeTxHash).toLowerCase()
          if (seenHash.has(h)) continue
          seenHash.add(h)
          unique.push(p)
        }

        const proposals = await Promise.all(
          unique.map(async (p) => {
            const hashLc = String(p.safeTxHash).toLowerCase()
            const flags = await Promise.all(
              owners.map((o) => safeRead('approvedHashes', [o, p.safeTxHash]).then((n) => (BigInt(n) > 0n ? o : null))),
            )
            const approvers = flags.filter(Boolean)
            const status = deriveProposalStatus({
              approvals: approvers.length,
              threshold,
              currentNonce,
              proposalNonce: Number(p.nonce),
              executed: executed.has(hashLc),
              failed: failed.has(hashLc),
              cancelled: p.cancelled,
            })
            // Tagged with its chain: the network is a property of the transaction (spec 102).
            return { ...p, chainId: cid, approvers, approvals: approvers.length, threshold, status }
          }),
        )

        const me = address ? String(address).toLowerCase() : null
        commit({
          state: 'read',
          proposals,
          // An unfinished backfill is disclosed, never presented as the whole queue.
          partial: !(hubComplete && execComplete),
          owner: me != null && owners.some((o) => o.toLowerCase() === me),
          owners,
          threshold,
          nonce: currentNonce,
        })
      } catch (e) {
        commit({ state: 'unreadable', error: e?.message || 'Failed to read proposals' })
      }
    },
    [key, address],
  )

  /** Re-read one chain (after an action there) or every chain. */
  const refresh = useCallback(
    async (chainId) => {
      const targets =
        chainId == null
          ? instancesRef.current
          : instancesRef.current.filter((i) => Number(i.chainId) === Number(chainId))
      await Promise.all(targets.map((i) => readChain(i)))
    },
    [readChain],
  )

  // A new vault (or a changed instance set / wallet) starts the reads over. Entries for chains the
  // group no longer has are dropped rather than left as stale facts about another vault.
  useEffect(() => {
    groupKeyRef.current = key
    setByChain(unread.length > 0 ? Object.fromEntries(unread.map((u) => [u.chainId, u])) : EMPTY)
    if (!key || instancesRef.current.length === 0) return
    refresh()
    // chainKey stands in for the instance set: instance objects change identity on every list refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, chainKey, refresh])

  const rows = useMemo(() => {
    const out = []
    for (const entry of Object.values(byChain)) {
      if (entry.state !== 'read') continue
      for (const p of entry.proposals) if (isQueued(p.status)) out.push(p)
    }
    return out.sort((a, b) => Number(b.blockNumber ?? 0) - Number(a.blockNumber ?? 0))
  }, [byChain])

  const entries = Object.values(byChain)
  const missing = entries.filter((e) => e.state !== 'read' && e.state !== 'loading').map((e) => e.chainId)
  const loading = entries.some((e) => e.state === 'loading')
  const partial = missing.length > 0 || entries.some((e) => e.state === 'read' && e.partial)

  return { byChain, rows, pending: rows.length, missing, partial, loading, refresh }
}

export default useVaultQueueAcrossChains
