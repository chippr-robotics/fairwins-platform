/**
 * Polygon PoS delegated staking (spec 065, contracts/polygon-delegation.md).
 *
 * Non-custodial calls from the member's wallet against the Polygon staking
 * contracts on Ethereum L1. Delegate: approve POL → buyVoucherPOL. Undelegate:
 * sellVoucherPOL → unbond nonce → unstakeClaimTokens_newPOL after the
 * withdrawal delay. Rewards: getLiquidRewards / withdrawRewardsPOL.
 *
 * Validator targets come ONLY from the curated allowlist (FR-008). The Polygon
 * staking API decorates allowlisted entries with live commission/status; it
 * never expands the list.
 *
 * Spec 110 Phase 1: reads go through the chain seam — the chain is an argument
 * (`chainId`), never an ambient provider.
 */
import { encodeFunctionData } from 'viem'
import { POLYGON_VALIDATOR_SHARE_ABI, POL_TOKEN_ABI } from '../../abis/PolygonValidatorShare'
import { POLYGON_STAKE_MANAGER_ABI } from '../../abis/PolygonStakeManager'
import { toBaseUnitString } from '../earn/format'
import { readContract, normalizeAbi } from '../chains/readContract'

const VS_ABI = normalizeAbi(POLYGON_VALIDATOR_SHARE_ABI)
const POL_ABI = normalizeAbi(POL_TOKEN_ABI)
const SM_ABI = normalizeAbi(POLYGON_STAKE_MANAGER_ABI)

// Slippage tolerance for buyVoucher's _minSharesToMint (0 = accept any). We
// pass 0 because the exchange rate moves slowly and a strict bound would risk
// spurious reverts; the member sees the exact POL amount they are delegating.
const MIN_SHARES_TO_MINT = 0n
const MAX_SHARES_TO_BURN = (1n << 256n) - 1n // effectively unbounded burn cap

/**
 * Fetch the live decoration for the curated validators. Returns a Map keyed by
 * validatorId with { commissionPct, totalStaked, status, delegationEnabled }.
 * The allowlist is the boundary — ids not in `allowlistIds` are dropped.
 */
export async function fetchValidatorDecoration(stakingApi, allowlistIds) {
  try {
    const res = await fetch(stakingApi)
    if (!res.ok) return new Map()
    const json = await res.json()
    const rows = json?.result || json?.validators || []
    const wanted = new Set(allowlistIds)
    const out = new Map()
    for (const row of rows) {
      const id = Number(row.id)
      if (!wanted.has(id)) continue // allowlist decoration only — never expand
      out.set(id, {
        commissionPct: row.commissionPercent != null ? Number(row.commissionPercent) : null,
        // The API quotes wei-scale stake as a JSON double
        // (`"totalStaked": 1.2105466892436343e+26`), so String() would hand
        // consumers an exponent BigInt() rejects — normalize at the boundary.
        totalStakedRaw: toBaseUnitString(row.totalStaked),
        status: row.status || row.currentState || null,
        delegationEnabled: row.delegationEnabled !== false,
      })
    }
    return out
  } catch {
    return new Map()
  }
}

/** Read StakeManager epoch + withdrawalDelay (governance-mutable — read live). */
export async function readStakeManagerTiming({ stakeManager, chainId }) {
  const [epoch, withdrawalDelay] = await Promise.all([
    readContract(chainId, { address: stakeManager, abi: SM_ABI, functionName: 'epoch' }),
    readContract(chainId, { address: stakeManager, abi: SM_ABI, functionName: 'withdrawalDelay' }),
  ])
  return { epoch, withdrawalDelay }
}

/**
 * Read the member's delegated position + pending rewards for one validator.
 * Returns { stakedRaw, rewardsClaimableRaw }.
 */
export async function readDelegationPosition({ validatorShare, account, chainId }) {
  const [totalStake, rewards] = await Promise.all([
    readContract(chainId, { address: validatorShare, abi: VS_ABI, functionName: 'getTotalStake', args: [account] }),
    readContract(chainId, {
      address: validatorShare,
      abi: VS_ABI,
      functionName: 'getLiquidRewards',
      args: [account],
    }).catch(() => 0n),
  ])
  return { stakedRaw: totalStake[0], rewardsClaimableRaw: rewards }
}

/**
 * Delegate POL to a validator. Needs a POL approval to the StakeManager when
 * short. Returns { calls, requiresApproval }.
 */
export async function buildDelegateCalls({ validatorShare, stakeManager, polToken, account, amount, chainId }) {
  const allowance = await readContract(chainId, {
    address: polToken,
    abi: POL_ABI,
    functionName: 'allowance',
    args: [account, stakeManager],
  })
  const requiresApproval = allowance < amount
  const calls = []
  if (requiresApproval) {
    calls.push({
      target: polToken,
      data: encodeFunctionData({ abi: POL_ABI, functionName: 'approve', args: [stakeManager, amount] }),
      value: 0n,
    })
  }
  calls.push({
    target: validatorShare,
    data: encodeFunctionData({
      abi: VS_ABI,
      functionName: 'buyVoucherPOL',
      args: [amount, MIN_SHARES_TO_MINT],
    }),
    value: 0n,
  })
  return { calls, requiresApproval }
}

/** Begin undelegation (records an unbond at the current epoch). Returns { calls }. */
export function buildUndelegateCalls({ validatorShare, amount }) {
  return {
    calls: [
      {
        target: validatorShare,
        data: encodeFunctionData({
          abi: VS_ABI,
          functionName: 'sellVoucherPOL',
          args: [amount, MAX_SHARES_TO_BURN],
        }),
        value: 0n,
      },
    ],
  }
}

/** Withdraw a matured unbond by its nonce. Returns { calls }. */
export function buildDelegationWithdrawCalls({ validatorShare, unbondNonce }) {
  return {
    calls: [
      {
        target: validatorShare,
        data: encodeFunctionData({
          abi: VS_ABI,
          functionName: 'unstakeClaimTokens_newPOL',
          args: [BigInt(unbondNonce)],
        }),
        value: 0n,
      },
    ],
  }
}

/** Claim accrued delegation rewards. Returns { calls }. */
export function buildDelegationClaimCalls({ validatorShare }) {
  return {
    calls: [
      {
        target: validatorShare,
        data: encodeFunctionData({ abi: VS_ABI, functionName: 'withdrawRewardsPOL', args: [] }),
        value: 0n,
      },
    ],
  }
}

// How many prior unbond nonces to scan back from the latest. A delegator makes
// at most a handful of unstake requests; this bounds the reads while covering
// every realistically-open unbond.
const UNBOND_SCAN_WINDOW = 20n

/**
 * Read ALL of the member's open unbonds for a validator (not just the latest) —
 * a delegator can have several in flight, and an earlier nonce can mature while
 * a later one is still waiting. Scans back a bounded window of nonces and
 * returns every one that still has shares, with its claimable flag.
 * Returns [{ unbondNonce, withdrawEpoch, shares, ready }] (newest first).
 */
export async function readOpenUnbonds({ validatorShare, account, chainId, epoch, withdrawalDelay }) {
  const vsRead = (functionName, args) =>
    readContract(chainId, { address: validatorShare, abi: VS_ABI, functionName, args })
  const latest = await vsRead('unbondNonces', [account])
  if (latest === 0n) return []
  const from = latest > UNBOND_SCAN_WINDOW ? latest - UNBOND_SCAN_WINDOW + 1n : 1n
  const nonces = []
  for (let n = latest; n >= from; n -= 1n) nonces.push(n)
  const rows = await Promise.all(nonces.map((n) => vsRead('unbonds_new', [account, n]).then((u) => ({ n, u }))))
  const out = []
  for (const { n, u } of rows) {
    const shares = BigInt(u.shares ?? u[0])
    if (shares === 0n) continue // already withdrawn / never used
    const withdrawEpoch = BigInt(u.withdrawEpoch ?? u[1])
    const ready =
      epoch != null && withdrawalDelay != null
        ? withdrawEpoch + BigInt(withdrawalDelay) <= BigInt(epoch)
        : false
    out.push({ unbondNonce: n.toString(), withdrawEpoch: withdrawEpoch.toString(), shares, ready })
  }
  return out
}

/**
 * Convenience: the most recent open unbond (or null). Kept for callers that
 * only need a single "is anything unbonding?" signal.
 */
export async function readLatestUnbond(args) {
  const open = await readOpenUnbonds(args)
  return open[0] || null
}

/** Human label for the delegation unbonding period from the on-chain delay. */
export function unbondingLabel(withdrawalDelay) {
  if (withdrawalDelay == null) return null
  const checkpoints = Number(withdrawalDelay)
  // Checkpoints land ~30 min–3 h apart; ~80 ≈ 2–4 days.
  return `~2–4 days (${checkpoints} checkpoints)`
}
