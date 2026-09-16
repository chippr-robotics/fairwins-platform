/**
 * useStakingPositions (spec 065, US1 + extended in US2) — the member's staking
 * positions and wallet balances across every option, read over each option's
 * chain read provider (authoritative on-chain state). Polls every
 * STAKING_POLL_MS (60s), scoped to the connected account; an account change
 * resets synchronously. USD valuation degrades to null ("—") honestly.
 *
 * US1 reads staked/LST balances + wallet balance (for the stake form). US2
 * extends this with pending unbonds + ready detection + delegated rewards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from './useWalletManagement'
import { NETWORKS } from '../config/networks'
import { STAKING_POLL_MS, POL_TOKEN_L1 } from '../config/staking'
import { getPublicClient } from '../lib/chains/publicClient'
import { readContract } from '../lib/chains/readContract'
import { readLidoPosition, readLidoWithdrawalStatuses } from '../lib/staking/lidoStaking'
import { readSpolPosition, readSpolOpenNonces } from '../lib/staking/spolStaking'
import { readDelegationPosition, readStakeManagerTiming, readOpenUnbonds } from '../lib/staking/polygonDelegation'

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)']

async function readWalletBalance({ option, account }) {
  if (option.providerKind === 'lido') {
    // Native ETH balance.
    return getPublicClient(option.chainId).getBalance({ address: account })
  }
  // sPOL + delegation stake POL (ERC-20).
  return readContract(option.chainId, {
    address: POL_TOKEN_L1,
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [account],
  })
}

async function readOptionState({ option, account, timingByChain }) {
  const walletBalanceRaw = await readWalletBalance({ option, account }).catch(() => null)
  const timing = timingByChain.get(option.chainId)
  const chainId = option.chainId

  if (option.providerKind === 'lido') {
    const pos = await readLidoPosition({ account, chainId, contracts: option.contracts })
    // Open Lido withdrawal requests, read straight from the queue (ready =
    // finalized && !claimed). US2 exit surface.
    const statuses = await readLidoWithdrawalStatuses({ contracts: option.contracts, account, chainId })
      .catch(() => [])
    const openExits = statuses
      .filter((s) => !s.claimed)
      .map((s) => ({ handle: { requestId: s.requestId }, amountRaw: s.amountRaw, ready: s.ready }))
    return { ...pos, walletBalanceRaw, rewardsClaimableRaw: null, openExits }
  }

  if (option.providerKind === 'spol') {
    const pos = await readSpolPosition({ account, chainId, contracts: option.contracts })
    const nonces = await readSpolOpenNonces({
      contracts: option.contracts,
      account,
      chainId,
      currentEpoch: timing?.epoch,
      withdrawalDelay: timing?.withdrawalDelay,
    }).catch(() => [])
    const openExits = nonces.map((n) => ({
      handle: { unbondNonce: n.unbondNonce },
      amountRaw: n.amountRaw,
      ready: n.ready,
    }))
    return { ...pos, walletBalanceRaw, rewardsClaimableRaw: null, openExits }
  }

  // delegated — read ALL open unbonds (a delegator can have several in flight).
  const pos = await readDelegationPosition({ validatorShare: option.validatorShare, account, chainId })
  const unbonds = await readOpenUnbonds({
    validatorShare: option.validatorShare,
    account,
    chainId,
    epoch: timing?.epoch,
    withdrawalDelay: timing?.withdrawalDelay,
  }).catch(() => [])
  const openExits = unbonds.map((u) => ({
    handle: { unbondNonce: u.unbondNonce },
    // unbonds_new exposes shares, not a POL amount — the withdraw returns the
    // exact POL, so the amount is intentionally omitted here (shown as a label).
    amountRaw: null,
    ready: u.ready,
  }))
  return {
    stakedRaw: pos.stakedRaw,
    lstBalanceRaw: null,
    walletBalanceRaw,
    rewardsClaimableRaw: pos.rewardsClaimableRaw,
    latestUnbond: unbonds[0] || null,
    openExits,
  }
}

export function useStakingPositions(options) {
  const { address, isConnected } = useWallet() || {}
  const [states, setStates] = useState(null)
  const [status, setStatus] = useState('loading')
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!isConnected || !address || !options?.length) return
    const reqId = ++reqIdRef.current
    try {
      // The chain seam is the availability gate: a chain with no RPC route reads nothing.
      const readable = new Map()
      const timingByChain = new Map()
      for (const chainId of new Set(options.map((o) => o.chainId))) {
        readable.set(chainId, getPublicClient(chainId) != null)
      }
      // StakeManager timing (epoch/withdrawalDelay) once per chain for unbond readiness.
      for (const [chainId, ok] of readable) {
        const del = NETWORKS[chainId]?.staking?.delegated
        if (del && ok) {
          try {
            timingByChain.set(chainId, await readStakeManagerTiming({ stakeManager: del.stakeManager, chainId }))
          } catch {
            /* best-effort */
          }
        }
      }

      const settled = await Promise.allSettled(
        options.map((option) => {
          if (!readable.get(option.chainId)) return Promise.reject(new Error('no provider'))
          return readOptionState({ option, account: address, timingByChain }).then((s) => ({
            optionId: option.id,
            state: s,
          }))
        }),
      )
      if (reqId !== reqIdRef.current) return
      const next = new Map()
      let anyOk = false
      for (const res of settled) {
        if (res.status === 'fulfilled') {
          anyOk = true
          next.set(res.value.optionId, res.value.state)
        }
      }
      if (!anyOk) {
        setStates(null)
        setStatus('unavailable')
        return
      }
      setStates(next)
      setStatus('ready')
    } catch {
      if (reqId !== reqIdRef.current) return
      setStates(null)
      setStatus('unavailable')
    }
  }, [isConnected, address, options])

  useEffect(() => {
    reqIdRef.current++
    setStates(null)
    setStatus(isConnected ? 'loading' : 'idle')
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, options])

  useEffect(() => {
    if (!isConnected || !address) return undefined
    const id = setInterval(() => load(), STAKING_POLL_MS)
    return () => clearInterval(id)
  }, [isConnected, address, load])

  return useMemo(() => {
    const positions = []
    if (states && options?.length) {
      for (const option of options) {
        const state = states.get(option.id)
        if (!state) continue
        const openExits = state.openExits || []
        const hasReady = openExits.some((e) => e.ready)
        const hasStake = (state.stakedRaw ?? 0n) > 0n
        if (!hasStake && openExits.length === 0) continue
        positions.push({
          option,
          stakedRaw: state.stakedRaw ?? 0n,
          lstBalanceRaw: state.lstBalanceRaw ?? null,
          rewardsClaimableRaw: state.rewardsClaimableRaw ?? null,
          pendingUnbonds: openExits,
          latestUnbond: state.latestUnbond ?? null,
          hasReadyWithdrawal: hasReady,
        })
      }
    }
    return { positions, states, status, refresh: load }
  }, [states, options, status, load])
}

export { readSpolOpenNonces }
export default useStakingPositions
