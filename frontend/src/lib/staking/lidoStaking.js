/**
 * Lido liquid staking (spec 065, contracts/lido-liquid-staking.md).
 *
 * Non-custodial: all calls run from the member's own wallet against audited
 * Lido V2 contracts on Ethereum L1. Writes are `{ target, data, value }`
 * batches for the spec-041 unified send rail (useEarnSend). Members hold
 * wstETH (non-rebasing) as their position.
 *
 * Stake uses the wstETH one-hop: a plain ETH transfer to the wstETH contract's
 * `receive()` stakes via Lido and returns wstETH in a single call. (The Lido
 * `_referral` marker — tracking-only, no revenue, R1 — is not attachable on
 * this path; we accept that for the simpler, non-rebasing wstETH position.)
 *
 * Exit is the Lido Withdrawal Queue: request (mints an ERC-721 ticket) → wait
 * until finalized → claim. A request is ready iff `isFinalized && !isClaimed`.
 *
 * Spec 110 Phase 1: reads go through the chain seam — the chain is an argument
 * (`chainId`), never an ambient provider.
 */
import { encodeFunctionData } from 'viem'
import { LIDO_WSTETH_ABI } from '../../abis/LidoWstETH'
import { LIDO_WITHDRAWAL_QUEUE_ABI } from '../../abis/LidoWithdrawalQueue'
import { LIDO_APR_API } from '../../config/staking'
import { readContract, normalizeAbi } from '../chains/readContract'

const WSTETH_ABI = normalizeAbi(LIDO_WSTETH_ABI)
const QUEUE_ABI = normalizeAbi(LIDO_WITHDRAWAL_QUEUE_ABI)

/** Fetch Lido's 7-day SMA APR as a fraction (0.032), or null on failure. */
export async function fetchLidoApr(apiUrl = LIDO_APR_API) {
  try {
    const res = await fetch(apiUrl)
    if (!res.ok) return null
    const json = await res.json()
    const sma = json?.data?.smaApr
    if (sma == null) return null
    // The API returns a percentage (e.g. 3.2); normalize to a fraction.
    return Number(sma) / 100
  } catch {
    return null
  }
}

/**
 * Read the member's Lido position on a named chain.
 * Returns { lstBalanceRaw (wstETH), stakedRaw (underlying ETH) }.
 */
export async function readLidoPosition({ account, chainId, contracts }) {
  const wsteth = (functionName, args) =>
    readContract(chainId, { address: contracts.wsteth, abi: WSTETH_ABI, functionName, args })
  const lstBalanceRaw = await wsteth('balanceOf', [account])
  let stakedRaw = 0n
  if (lstBalanceRaw > 0n) {
    stakedRaw = await wsteth('getStETHByWstETH', [lstBalanceRaw])
  }
  return { lstBalanceRaw, stakedRaw }
}

/**
 * Stake ETH → wstETH (one-hop). Native coin, no approval leg.
 * Returns { calls, requiresApproval: false }.
 */
export function buildStakeCalls({ contracts, amount }) {
  return {
    calls: [{ target: contracts.wsteth, data: '0x', value: amount }],
    requiresApproval: false,
  }
}

/**
 * Request a withdrawal of wstETH from the Lido queue. Needs a wstETH approval
 * to the queue when the allowance is short. Returns { calls, requiresApproval }.
 */
export async function buildWithdrawalRequestCalls({ contracts, account, amount, chainId }) {
  const allowance = await readContract(chainId, {
    address: contracts.wsteth,
    abi: WSTETH_ABI,
    functionName: 'allowance',
    args: [account, contracts.withdrawalQueue],
  })
  const requiresApproval = allowance < amount
  const calls = []
  if (requiresApproval) {
    calls.push({
      target: contracts.wsteth,
      data: encodeFunctionData({
        abi: WSTETH_ABI,
        functionName: 'approve',
        args: [contracts.withdrawalQueue, amount],
      }),
      value: 0n,
    })
  }
  calls.push({
    target: contracts.withdrawalQueue,
    data: encodeFunctionData({
      abi: QUEUE_ABI,
      functionName: 'requestWithdrawalsWstETH',
      args: [[amount], account],
    }),
    value: 0n,
  })
  return { calls, requiresApproval }
}

/**
 * Read the status of the member's open Lido withdrawal requests.
 * Returns [{ requestId, amountRaw, ready }] where ready = finalized && !claimed.
 */
export async function readLidoWithdrawalStatuses({ contracts, account, chainId, requestIds }) {
  const queue = (functionName, args) =>
    readContract(chainId, { address: contracts.withdrawalQueue, abi: QUEUE_ABI, functionName, args })
  const ids = requestIds?.length
    ? requestIds.map((r) => BigInt(r))
    : await queue('getWithdrawalRequests', [account])
  if (!ids.length) return []
  const statuses = await queue('getWithdrawalStatus', [ids])
  return ids.map((id, i) => ({
    requestId: id.toString(),
    amountRaw: statuses[i].amountOfStETH,
    ready: Boolean(statuses[i].isFinalized) && !statuses[i].isClaimed,
    claimed: Boolean(statuses[i].isClaimed),
  }))
}

/**
 * Claim finalized Lido withdrawals. Resolves the checkpoint hints first.
 * Returns { calls }.
 */
export async function buildLidoClaimCalls({ contracts, chainId, requestIds }) {
  const queue = (functionName, args) =>
    readContract(chainId, { address: contracts.withdrawalQueue, abi: QUEUE_ABI, functionName, args })
  const ids = requestIds.map((r) => BigInt(r))
  const lastIndex = await queue('getLastCheckpointIndex')
  const hints = await queue('findCheckpointHints', [ids, 1n, lastIndex])
  return {
    calls: [
      {
        target: contracts.withdrawalQueue,
        data: encodeFunctionData({ abi: QUEUE_ABI, functionName: 'claimWithdrawals', args: [ids, hints] }),
        value: 0n,
      },
    ],
  }
}
