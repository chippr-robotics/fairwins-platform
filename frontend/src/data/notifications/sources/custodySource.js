/**
 * Custody activity source (spec 043, US6 / spec 031). Snapshot-diffs each vault the member belongs to on the
 * active network: a pending proposal that needs the member's approval (action: approve), a proposal newly
 * executed, and an owners/threshold governance change. Pure snapshot-diff (first-sight = baseline). No hooks;
 * read-only provider. No-ops until the SafeProposalHub is deployed + its block recorded (never scans genesis).
 *
 * Spec 049 (FR-016): the SafePolicyGuard's rule events (RulesConfigured, CooldownSet, AllowlistEnabled,
 * AllowlistChanged) join the same snapshot-diff — a per-vault event count is snapped, and any increase emits a
 * "policy-changed" entry in the custody domain. No-ops until the guard is deployed + its block recorded.
 *
 * CATCHING UP IS NOT FAILING. Both reads scan event history, and on a live network that history starts over a
 * million blocks back while the RPC caps one request at 10,000 blocks — so the first pass is a bounded,
 * resumable backfill (`lib/chain/logScan`) that spends CHUNK_BUDGET_PER_POLL requests per cycle and resumes on
 * the next. While it is still short of the chain head this source reports `partial`, NOT `ok:false`: the
 * distinction is the whole point, because `ok:false` is what raises the member-facing "couldn't refresh"
 * notice, and "still reading" is not "could not read". Nothing is diffed off an incomplete scan either — a
 * baseline taken half-way through would emit invented "a transaction was executed" entries as the scan caught
 * up with history the member has already seen.
 */
import { isAddress } from 'viem'
import { getProvider } from '../../../utils/blockchainService'
import { getContractAddressForChain, getDeploymentBlockForChain } from '../../../config/contracts'
import { getSafeContracts } from '../../../config/safeContracts'
import { loadVaultReferences } from '../../../lib/custody/vaultReferences'
import { readVaultProposalState } from '../../../lib/custody/vaultProposalReads'
import { readPolicyEventCount } from '../../../lib/custody/policyEvents'
import { STATUS } from '../../../lib/custody/proposalStatus'

const EMPTY = { ok: true, entries: [], nextSnapshots: {}, currentIds: [], actionNeededById: {} }

/**
 * Log-scan chunks this source may spend per vault, per poll. A 30s cadence must never turn a
 * backfill into a request storm; at 10,000 blocks a chunk this walks ~120k blocks per cycle and
 * converges on a million-block history in a few minutes, after which the session cache makes each
 * later poll a single chunk.
 */
const CHUNK_BUDGET_PER_POLL = 12

export const custodySource = {
  key: 'custody',
  label: 'Custody',
  async detect({ account, chainId, nowMs, prior }) {
    if (!account || !getSafeContracts(chainId)) return EMPTY
    const hubAddress = getContractAddressForChain('safeProposalHub', chainId)
    const fromBlock = getDeploymentBlockForChain('safeProposalHub', chainId)
    // Until the hub is deployed + its block recorded, there is nothing to read (and we never scan genesis).
    if (!hubAddress || !isAddress(hubAddress) || !fromBlock) return EMPTY

    const refs = loadVaultReferences(account).filter((r) => r.chainId === Number(chainId))
    if (refs.length === 0) return EMPTY

    // Spec 049 — policy engine coordinates (optional; policy diffing no-ops when absent).
    const guardAddress = getContractAddressForChain('safePolicyGuard', chainId)
    const guardFromBlock = getDeploymentBlockForChain('safePolicyGuard', chainId)
    const policyEnabled = !!guardAddress && isAddress(guardAddress) && !!guardFromBlock

    let provider
    try {
      provider = getProvider(chainId)
    } catch {
      return { ok: false }
    }

    const entries = []
    const currentIds = []
    const actionNeededById = {}
    const nextSnapshots = { ...(prior.snapshots || {}) }
    const accountLc = String(account).toLowerCase()
    let anyOk = false
    let partial = false
    // Genuine unreadable vaults only — a reference whose address holds no code is an absence and
    // is deliberately counted by neither this nor `anyOk` (see the catch below).
    let failedCount = 0

    const mk = (vaultAddr, type, message, severity, actionable) => ({
      id: `custody:${vaultAddr}:${type}:${nowMs}`,
      domain: 'custody',
      refId: vaultAddr,
      type,
      message,
      severity,
      actionable,
      link: { to: '/wallet', state: { tab: 'custody', vault: vaultAddr } },
      createdAt: nowMs,
      read: false,
    })

    for (const ref of refs) {
      const vaultAddr = ref.address
      const sid = `custody:${vaultAddr}`
      currentIds.push(sid)
      let state
      try {
        state = await readVaultProposalState({
          safeAddress: vaultAddr,
          hubAddress,
          chainId,
          provider,
          fromBlock,
          maxChunks: CHUNK_BUDGET_PER_POLL,
        })
        anyOk = true
      } catch (error) {
        // Keep the prior snapshot either way, so a failed read never loses the baseline.
        if (prior.snapshots?.[sid]) nextSnapshots[sid] = prior.snapshots[sid]

        /*
         * A failed read is TWO different facts and they must not be collapsed.
         *
         * If the address holds no code on this chain, the saved reference is stale or belongs to
         * another chain (references have carried a chainId since spec 068). That is an ABSENCE:
         * there is nothing to read and there never will be, so reporting it as an outage produces
         * a "will keep retrying" notice that retries forever against something that cannot appear.
         * Only a read that failed against an address that IS a contract is `unreadable`.
         *
         * The code check runs only on the failure path, so the happy path costs no extra call.
         */
        let hasCode
        try {
          hasCode = (await provider.getCode(vaultAddr)) !== '0x'
        } catch {
          hasCode = null // could not even ask — fall through and treat as unreadable
        }

        if (hasCode === false) {
          console.warn(
            `[custody] vault ${vaultAddr} holds no code on chain ${chainId} — ` +
            'skipping a stale or mis-chained vault reference (not an outage)'
          )
          continue
        }

        // These catches used to be bare, which is why the member-facing "Couldn't refresh Custody
        // activity" notice arrived with ZERO console evidence — undebuggable in production. Name
        // the vault and the reason.
        failedCount += 1
        console.warn(
          `[custody] could not read vault ${vaultAddr} on chain ${chainId}:`,
          error?.message || error
        )
        continue
      }

      // Still backfilling: the vault answered, so this is not a failure — but its proposal set is
      // not yet known to be complete, so keep the prior snapshot and diff nothing this cycle.
      if (!state.complete) {
        partial = true
        if (prior.snapshots?.[sid]) nextSnapshots[sid] = prior.snapshots[sid]
        if (prior.snapshots?.[sid]?.needMe?.length) actionNeededById[sid] = 'approve'
        continue
      }

      const isOwner = state.owners.some((o) => o.toLowerCase() === accountLc)
      // Pending proposals that still need THIS member's approval.
      const needMe = state.proposals
        .filter((p) => p.status === STATUS.PENDING && isOwner && !p.approvers.some((a) => a.toLowerCase() === accountLc))
        .map((p) => String(p.safeTxHash).toLowerCase())
        .sort()
      const executedCount = state.proposals.filter((p) => p.status === STATUS.EXECUTED).length
      const label = ref.label || 'vault'
      const govKey = `${state.owners.length}:${state.threshold}`

      const prev = prior.snapshots?.[sid]

      // Spec 049 (FR-016) — count the guard's rule events for this vault; on failure keep the
      // prior count so the baseline survives a flaky read (no false "changed" later).
      let policyEventCount = prev?.policyEventCount
      if (policyEnabled) {
        try {
          const res = await readPolicyEventCount({
            guardAddress,
            safeAddress: vaultAddr,
            chainId,
            provider,
            fromBlock: guardFromBlock,
            maxChunks: CHUNK_BUDGET_PER_POLL,
          })
          // A count from an unfinished scan only rises because the scan is catching up, which would
          // read as "the policy on this vault changed" over and over. Keep the prior count until the
          // scan is whole.
          if (res.complete) policyEventCount = res.count
          else partial = true
        } catch {
          // keep prior count
        }
      }

      nextSnapshots[sid] = { needMe, executedCount, govKey, policyEventCount, snappedAt: nowMs }

      if (needMe.length > 0) actionNeededById[sid] = 'approve'

      if (prev) {
        const prevNeed = new Set(prev.needMe || [])
        if (needMe.some((h) => !prevNeed.has(h))) {
          entries.push(mk(vaultAddr, 'approval-needed', `A transaction on “${label}” needs your approval`, 'warning', true))
        }
        if (executedCount > (prev.executedCount || 0)) {
          entries.push(mk(vaultAddr, 'executed', `A transaction on “${label}” was executed`, 'success', false))
        }
        if (prev.govKey && prev.govKey !== govKey) {
          entries.push(mk(vaultAddr, 'governance-changed', `The owners or threshold on “${label}” changed`, 'info', false))
        }
        if (
          policyEventCount != null &&
          prev.policyEventCount != null &&
          policyEventCount > prev.policyEventCount
        ) {
          entries.push(mk(vaultAddr, 'policy-changed', `The policy rules on “${label}” changed`, 'info', false))
        }
      }
    }

    /*
     * Report not-ok only when something genuinely FAILED and nothing succeeded — the engine then
     * retains the prior slice and the member is told it will keep retrying.
     *
     * A member whose only references are stale (no code on this chain) lands here with
     * `failedCount === 0`: that is an honest empty answer, not an outage, and it no longer
     * produces a retry notice for a vault that will never resolve.
     */
    if (!anyOk && failedCount > 0) return { ok: false }
    return { ok: true, entries, nextSnapshots, currentIds, actionNeededById, partial }
  },
}

export default custodySource
