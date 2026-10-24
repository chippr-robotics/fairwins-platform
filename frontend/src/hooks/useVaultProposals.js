// Spec 043 (US2) — a vault's pending queue + history, built entirely from on-chain + hub state, plus the
// propose/approve/execute actions. Honest state: approvals and execution come from the Safe itself; the hub
// only supplies (verified) preimages. Guards: execute only when ready and nonce-current; approvals counted
// once per owner on-chain (idempotent); non-owners get read-only.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { encodeFunctionData } from 'viem'
import { readContract, normalizeAbi } from '../lib/chains/readContract'
import { eventScanHandle } from '../lib/chains/eventScan'
import { getAddress } from '../lib/evm/address'
import { useWallet } from '.'
import { SAFE_ABI } from '../abis/Safe'
import { getContractAddressForChain, getDeploymentBlockForChain } from '../config/contracts'
import {
  buildSafeTx,
  computeSafeTxHash,
  buildPrevalidatedSignatures,
  encodeExecTransaction,
} from '../lib/custody/vaultTransaction'
import {
  emitProposal,
  cancelProposal,
  emitProposalCall,
  cancelProposalCall,
  readVerifiedProposals,
} from '../lib/custody/proposalHub'
import { readExecutionOutcomes } from '../lib/custody/vaultProposalReads'
import { deriveProposalStatus, isQueued, STATUS } from '../lib/custody/proposalStatus'
import { resolveWriteRail, requireWriteRail, RAILS } from '../lib/chains/writeRail'
import { chainDisplayName } from '../lib/custody/chainName'

const SAFE_ABI_PARSED = normalizeAbi(SAFE_ABI)
/** Calldata for a Safe call — the viem twin of the `Interface` this replaces. */
const safeCall = (functionName, args) =>
  encodeFunctionData({ abi: SAFE_ABI_PARSED, functionName, args })

export function useVaultProposals(vault) {
  const { chainId, signer, provider, sendCalls, loginMethod } = useWallet()
  /*
   * The rail is a property of the SIGNER, not the login (lib/chains/writeRail.js).
   *
   * This used to be `loginMethod === 'passkey'`, which meant a member holding a key that signs
   * perfectly well on Ethereum Classic was routed down a rail that has no bundler there — and got
   * a chain-support error from inside the batch sender rather than an answer they could act on.
   */
  const railArgs = useMemo(
    () => ({ chainId, signer, loginMethod, chainName: chainId != null ? chainDisplayName(chainId) : null }),
    [chainId, signer, loginMethod],
  )
  const writeRail = useMemo(() => resolveWriteRail(railArgs), [railArgs])
  const isPasskey = writeRail.rail === RAILS.PASSKEY
  const [proposals, setProposals] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  // True while a bounded history backfill has not yet reached the chain head — the queue shown is
  // real but not yet known to be all of it.
  const [partial, setPartial] = useState(false)
  const reqId = useRef(0)

  const vaultAddress = vault?.isSafe ? vault.address : null
  const hubAddress = getContractAddressForChain('safeProposalHub', chainId)
  // Only read when the connected wallet is on the vault's own network — the connected chainId/provider drive
  // the reads, so a mismatched chain would query the wrong contracts. The UI gates actions on the same fact.
  const onVaultChain = vault?.chainId != null && Number(chainId) === Number(vault.chainId)

  const refresh = useCallback(async () => {
    // Bump first so any in-flight request is invalidated even on the early-return path.
    const myReq = ++reqId.current
    if (!vaultAddress || !hubAddress || !provider || !onVaultChain) {
      setProposals([])
      setPartial(false)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      // Never scan from genesis (contracts.js guidance): require a recorded hub deploy block.
      const fromBlock = getDeploymentBlockForChain('safeProposalHub', chainId)
      if (!fromBlock) {
        if (myReq === reqId.current) {
          setProposals([])
          setPartial(false)
          setError('Custody proposal history is not configured for this network yet.')
        }
        return
      }
      const askSafe = (functionName, args = []) =>
        readContract(chainId, { address: vaultAddress, abi: SAFE_ABI, functionName, args })
      // The log-scan handle is the duck type `scanLogs` consumes (target / runner.provider /
      // filters / interface.parseLog) — the seam exists for exactly this swap, so
      // `readExecutionOutcomes` is unchanged.
      const safe = eventScanHandle(chainId, { address: vaultAddress, abi: SAFE_ABI })
      const [owners, threshold, currentNonce] = await Promise.all([
        askSafe('getOwners'),
        askSafe('getThreshold'),
        askSafe('nonce'),
      ])
      // History is scanned in bounded, resumable chunks (lib/chain/logScan) — the hub is over a
      // million blocks old on the live networks and public RPCs cap one getLogs at 10,000 blocks.
      // This is the surface a member is waiting on, so it is given no chunk budget: it backfills
      // fully, and the session cache means later refreshes only read the new blocks.
      const { proposals: verified, complete: hubComplete } = await readVerifiedProposals({
        hubAddress,
        safeAddress: vaultAddress,
        chainId,
        provider,
        fromBlock,
      })

      // Execution outcomes from the Safe itself.
      const { executed: executedHashes, failed: failedHashes, complete: execComplete } =
        await readExecutionOutcomes({ safe, chainId, fromBlock })
      const historyComplete = hubComplete && execComplete

      // Approvals per proposal (one on-chain read per owner per proposal).
      const enriched = await Promise.all(
        verified.map(async (p) => {
          const hashLc = String(p.safeTxHash).toLowerCase()
          const approvalFlags = await Promise.all(
            owners.map((o) =>
              askSafe('approvedHashes', [getAddress(o), p.safeTxHash]).then((n) =>
                BigInt(n) > 0n ? getAddress(o) : null,
              ),
            ),
          )
          const approvers = approvalFlags.filter(Boolean)
          const status = deriveProposalStatus({
            approvals: approvers.length,
            threshold: Number(threshold),
            currentNonce: Number(currentNonce),
            proposalNonce: Number(p.nonce),
            executed: executedHashes.has(hashLc),
            failed: failedHashes.has(hashLc),
            cancelled: p.cancelled,
          })
          return { ...p, approvers, approvals: approvers.length, threshold: Number(threshold), status }
        }),
      )
      if (myReq === reqId.current) {
        setProposals(enriched)
        // An unfinished scan is disclosed, never rendered as the whole queue: "no pending
        // proposals" from a scan that has not reached them yet is the one wrong answer here.
        setPartial(!historyComplete)
      }
    } catch (e) {
      if (myReq === reqId.current) {
        setError(e?.message || 'Failed to read proposals')
        // Clear the catching-up notice: it belongs to a cycle that has been superseded, and leaving
        // it up would claim a scan is progressing at the same moment we say the read failed. The
        // error is the live truth and should be the only thing claimed.
        setPartial(false)
      }
    } finally {
      if (myReq === reqId.current) setLoading(false)
    }
  }, [vaultAddress, hubAddress, provider, chainId, onVaultChain])

  useEffect(() => {
    refresh()
  }, [refresh])

  /** Propose a transaction: build the SafeTx at the current nonce, broadcast it, and record the proposer's
   *  first approval on-chain. An explicit `nonce` may be passed to queue ordered follow-ups (spec 049
   *  attach flow: configureRules at N, setGuard at N+1 — the chain then enforces the order). */
  const propose = useCallback(
    async ({ to, value = 0n, data = '0x', operation = 0, nonce: nonceOverride }) => {
      requireWriteRail(railArgs)
      if (!hubAddress) throw new Error('Custody proposals are not configured on this network')
      // The nonce is a READ, and reads are chain-parameterised now — it no longer matters whether
      // a signer or the session read provider is at hand, which is what the old
      // `signer || provider` was choosing between.
      const nonce =
        nonceOverride ??
        (await readContract(chainId, {
          address: vaultAddress,
          abi: SAFE_ABI,
          functionName: 'nonce',
        }))
      const safeTx = buildSafeTx({ to, value, data, operation, nonce })
      const safeTxHash = computeSafeTxHash(vaultAddress, chainId, safeTx)
      if (isPasskey) {
        // Passkey rail: broadcast the preimage AND record the proposer's approval in ONE sponsored
        // UserOp — same two on-chain effects as the classic path, batched.
        const calls = [
          emitProposalCall({ hubAddress, safe: vaultAddress, safeTx, safeTxHash }),
          { target: vaultAddress, data: safeCall('approveHash', [safeTxHash]), value: 0n },
        ]
        await sendCalls(calls)
      } else {
        await emitProposal({ hubAddress, safe: vaultAddress, safeTx, safeTxHash, signer })
        const approveTx = await signer.sendTransaction({
          to: vaultAddress,
          data: safeCall('approveHash', [safeTxHash]),
        })
        await approveTx.wait()
      }
      await refresh()
      return { safeTxHash, nonce: Number(nonce) }
    },
    [isPasskey, signer, railArgs, sendCalls, vaultAddress, hubAddress, chainId, refresh],
  )

  /** Record the connected owner's approval for a proposal (idempotent on-chain). */
  const approve = useCallback(
    async (safeTxHash) => {
      requireWriteRail(railArgs)
      if (isPasskey) {
        await sendCalls([
          { target: vaultAddress, data: safeCall('approveHash', [safeTxHash]), value: 0n },
        ])
      } else {
        const tx = await signer.sendTransaction({
          to: vaultAddress,
          data: safeCall('approveHash', [safeTxHash]),
        })
        await tx.wait()
      }
      await refresh()
    },
    [isPasskey, signer, railArgs, sendCalls, vaultAddress, refresh],
  )

  /** Execute a proposal that has reached threshold, using pre-validated (on-chain approval) signatures. */
  const execute = useCallback(
    async (proposal) => {
      requireWriteRail(railArgs)
      if (proposal.status !== STATUS.READY) throw new Error('Proposal is not ready to execute')
      const signatures = buildPrevalidatedSignatures(proposal.approvers)
      const args = encodeExecTransaction(proposal.safeTx, signatures)
      if (isPasskey) {
        const sent = await sendCalls([
          { target: vaultAddress, data: safeCall('execTransaction', args), value: 0n },
        ])
        await refresh()
        return { txHash: sent?.txHash ?? sent?.userOpHash ?? sent?.intentId }
      }
      const tx = await signer.sendTransaction({
        to: vaultAddress,
        data: safeCall('execTransaction', args),
      })
      const receipt = await tx.wait()
      await refresh()
      return { txHash: receipt.hash }
    },
    [isPasskey, signer, railArgs, sendCalls, vaultAddress, refresh],
  )

  const cancel = useCallback(
    async (safeTxHash) => {
      requireWriteRail(railArgs)
      if (!hubAddress) throw new Error('Custody proposals are not configured on this network')
      if (isPasskey) {
        await sendCalls([cancelProposalCall({ hubAddress, safe: vaultAddress, safeTxHash })])
      } else {
        await cancelProposal({ hubAddress, safe: vaultAddress, safeTxHash, signer })
      }
      await refresh()
    },
    [isPasskey, signer, railArgs, sendCalls, hubAddress, vaultAddress, refresh],
  )

  const queue = proposals.filter((p) => isQueued(p.status))
  const history = proposals.filter((p) => !isQueued(p.status))

  // `writeRail` is returned so a surface can say WHY an action is unavailable before the member
  // taps it, rather than offering a button that throws.
  return { proposals, queue, history, loading, error, partial, writeRail, refresh, propose, approve, execute, cancel }
}

export default useVaultProposals
