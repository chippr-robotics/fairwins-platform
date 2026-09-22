// Spec 043 — shared, pure read of a vault's proposal state from chain + hub, used by both useVaultProposals
// (US2) and custodySource (US6). Reads owners/threshold/nonce, the verified hub proposals, per-owner
// approvals, and execution outcomes, then derives each proposal's status. Read-only; no React.
//
// Both event scans (the hub's proposals, and the Safe's own execution outcomes) go through
// `lib/chain/logScan`: bounded to the RPC's per-request block cap, resumable across calls, and cached
// for the session so a 30s poller re-reads only the new blocks. `complete` is false while a budgeted
// backfill is still catching up; a caller must disclose that rather than present the partial set as
// this vault's whole history.

import { getAddress } from 'viem'
import { SAFE_ABI } from '../../abis/Safe'
import { eventScanHandle } from '../chains/eventScan'
import { readContract, NoRpcEndpointError } from '../chains/readContract'
import { scanLogs } from '../chain/logScan'
import { readVerifiedProposals } from './proposalHub'
import { deriveProposalStatus } from './proposalStatus'

/**
 * @returns {Promise<{owners:string[], threshold:number, nonce:number, proposals:object[], complete:boolean}>}
 */
export async function readVaultProposalState({ safeAddress, hubAddress, chainId, provider, fromBlock, maxChunks }) {
  // Spec 110 Phase 1: the Safe's views read through the chain seam; `provider` still rides to
  // readVerifiedProposals until proposalHub converts. The scan handle satisfies scanLogs' duck
  // contract, so readExecutionOutcomes below is unchanged (its Phase-2 callers pass an ethers
  // Contract into the same parameter — both shapes work by construction).
  const safeRead = (functionName, args) =>
    readContract(chainId, { address: safeAddress, abi: SAFE_ABI, functionName, args })
  const safe = eventScanHandle(chainId, { address: safeAddress, abi: SAFE_ABI })
  if (!safe) throw new NoRpcEndpointError(chainId)
  const [ownersRaw, thresholdRaw, nonceRaw] = await Promise.all([
    safeRead('getOwners'),
    safeRead('getThreshold'),
    safeRead('nonce'),
  ])
  const owners = ownersRaw.map((o) => getAddress(o))
  const threshold = Number(thresholdRaw)
  const currentNonce = Number(nonceRaw)

  const { proposals: verified, complete: hubComplete } = await readVerifiedProposals({
    hubAddress,
    safeAddress,
    chainId,
    provider,
    fromBlock,
    maxChunks,
  })

  const { executed, failed, complete: execComplete } = await readExecutionOutcomes({
    safe,
    chainId,
    fromBlock,
    maxChunks,
  })

  const proposals = await Promise.all(
    verified.map(async (p) => {
      const hashLc = String(p.safeTxHash).toLowerCase()
      const approvalFlags = await Promise.all(
        owners.map((o) =>
          safeRead('approvedHashes', [o, p.safeTxHash]).then((n) => (n > 0n ? o : null)),
        ),
      )
      const approvers = approvalFlags.filter(Boolean)
      const status = deriveProposalStatus({
        approvals: approvers.length,
        threshold,
        currentNonce,
        proposalNonce: Number(p.nonce),
        executed: executed.has(hashLc),
        failed: failed.has(hashLc),
        cancelled: p.cancelled,
      })
      return { ...p, approvers, approvals: approvers.length, threshold, status }
    }),
  )

  return { owners, threshold, nonce: currentNonce, proposals, complete: hubComplete && execComplete }
}

/**
 * The Safe's own record of what executed and what reverted — one combined bounded scan of
 * ExecutionSuccess + ExecutionFailure (neither indexes its txHash, so they share an empty topic tail).
 * @returns {Promise<{executed:Set<string>, failed:Set<string>, complete:boolean}>}
 */
export async function readExecutionOutcomes({ safe, chainId, fromBlock, maxChunks }) {
  const { logs, complete } = await scanLogs({
    contract: safe,
    filters: [safe.filters.ExecutionSuccess(), safe.filters.ExecutionFailure()],
    fromBlock,
    chainId,
    maxChunks,
  })
  const executed = new Set()
  const failed = new Set()
  for (const l of logs) {
    const hash = String(l.args.txHash).toLowerCase()
    if (l.eventName === 'ExecutionSuccess') executed.add(hash)
    else if (l.eventName === 'ExecutionFailure') failed.add(hash)
  }
  return { executed, failed, complete }
}
