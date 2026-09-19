/**
 * Earn activity source (spec 050 / spec 031, FR-010). Two inputs, one feed:
 *
 * 1. **Action buffer** — deposit/withdraw/claim flows queue what the member
 *    just did (with the tx hash + explorer URL) via lib/earn/earnActivityBuffer;
 *    detect drains the buffer into precise entries. Routing user actions
 *    through the source keeps all store writes inside the engine's poll.
 * 2. **Snapshot-diff backstop** — vault share balances for every vault the
 *    member has touched through the app are snapped each cycle over the
 *    chain's read provider; a change with no matching drained action (e.g. a
 *    deposit made on the Morpho app directly) emits a generic
 *    position-changed entry. First-sight = baseline; ids are stable;
 *    hard read failure returns ok:false so the engine keeps the prior slice.
 *
 * No Morpho/Merkl API calls here — the 30s activity cadence would hammer
 * them; on-chain share reads are the cheap, honest signal.
 */
import { isAddress } from 'viem'
import { NETWORKS, isEarnAvailable } from '../../../config/networks'
import { readContract } from '../../../lib/chains/readContract'
import { drainEarnActions } from '../../../lib/earn/earnActivityBuffer'
import { earnPath } from '../../../config/earn'

const EMPTY = { ok: true, entries: [], nextSnapshots: {}, currentIds: [], actionNeededById: {} }
const BALANCE_OF_ABI = ['function balanceOf(address) view returns (uint256)']

export const earnSource = {
  key: 'earn',
  label: 'Earn',
  async detect({ account, chainId, nowMs, prior }) {
    if (!account || !isEarnAvailable(chainId)) return EMPTY

    const entries = []
    const nextSnapshots = {}
    const currentIds = []
    // Vaults whose change is already explained by a drained action this cycle
    // (skip the generic position-changed entry for them).
    const actedVaults = new Set()

    // 1) Precise entries for actions the member just performed in the app.
    for (const record of drainEarnActions(account, chainId)) {
      const refId = String(record.refId || '').toLowerCase()
      entries.push({
        id: `earn:${chainId}:${record.type}:${record.txHash}`,
        domain: 'earn',
        refId,
        type: record.type,
        message: record.message,
        severity: 'success',
        actionable: false,
        link: { to: earnPath() },
        txUrl: record.txUrl || null,
        createdAt: record.at || nowMs,
        read: false,
      })
      if (record.type === 'earn-deposit' || record.type === 'earn-withdraw') {
        actedVaults.add(refId)
        // Ensure the vault joins the tracked set from now on.
        nextSnapshots[`earn:${refId}`] = nextSnapshots[`earn:${refId}`] || null
      }
    }

    // 2) Snapshot-diff the tracked vaults' share balances.
    const priorSnapshots = prior?.snapshots || {}
    const trackedVaults = new Set([
      ...Object.keys(priorSnapshots).map((sid) => sid.replace(/^earn:/, '')),
      ...actedVaults,
    ])
    if (trackedVaults.size === 0) return { ...EMPTY, entries, currentIds: entries.map((e) => e.refId) }

    let anyOk = false
    for (const vaultAddress of trackedVaults) {
      if (!isAddress(vaultAddress)) continue
      const sid = `earn:${vaultAddress}`
      currentIds.push(sid)
      let shares
      try {
        shares = (
          await readContract(chainId, {
            address: vaultAddress,
            abi: BALANCE_OF_ABI,
            functionName: 'balanceOf',
            args: [account],
          })
        ).toString()
        anyOk = true
      } catch {
        // Keep the prior snapshot so the baseline survives a flaky read.
        if (priorSnapshots[sid]) nextSnapshots[sid] = priorSnapshots[sid]
        continue
      }

      const prev = priorSnapshots[sid]
      nextSnapshots[sid] = { shares, snappedAt: nowMs }

      // First sight = baseline (no retroactive entries); action-explained
      // changes already have their precise entry above.
      if (prev?.shares != null && prev.shares !== shares && !actedVaults.has(vaultAddress)) {
        const grew = BigInt(shares) > BigInt(prev.shares)
        entries.push({
          id: `earn:${chainId}:position-changed:${vaultAddress}:${nowMs}`,
          domain: 'earn',
          refId: vaultAddress,
          type: 'earn-position-changed',
          message: grew
            ? 'Your lending position increased'
            : 'Your lending position decreased',
          severity: 'info',
          actionable: false,
          link: { to: earnPath() },
          createdAt: nowMs,
          read: false,
        })
      }
    }

    if (!anyOk && trackedVaults.size > 0) return { ok: false }
    // Drop the placeholder nulls for vaults whose first read failed — they
    // re-enter tracking on the next action or successful read.
    for (const [sid, snap] of Object.entries(nextSnapshots)) {
      if (snap === null) delete nextSnapshots[sid]
    }
    return { ok: true, entries, nextSnapshots, currentIds, actionNeededById: {} }
  },
}

export default earnSource
