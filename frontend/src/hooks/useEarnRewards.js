/**
 * useEarnRewards (spec 050, US2) — the member's Merkl reward balances across
 * every earn-enabled network, plus per-network claim actions. Like the
 * portfolio, rewards are shown regardless of the wallet's active network;
 * claiming auto-switches to the reward's network as part of the confirmation
 * (useEarnSend) — the member never manages networks by hand.
 *
 * Honest-state: every chain failing is an explicit 'unavailable' (never a
 * fabricated zero); a partial failure lists the networks that couldn't be
 * checked; figures carry Merkl's ~8-hour cadence via `fetchedAt`. Claim
 * success is reported from the tx outcome, not the API (which may lag).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { encodeFunctionData } from 'viem'
import { formatUnits } from '../lib/evm/units'
import { normalizeAbi } from '../lib/chains/readContract'
import { useWallet } from './useWalletManagement'
import { useEarnSend } from './useEarnSend'
import { getEarnNetworks, getEarnConfig, NETWORKS } from '../config/networks'
import { getBlockscoutUrl } from '../config/blockExplorer'
import { fetchRewards, buildClaimArgs } from '../lib/earn/merkl'
import { MERKL_DISTRIBUTOR_ABI } from '../abis/MerklDistributor'
import { queueEarnAction } from '../lib/earn/earnActivityBuffer'
import { captureEarnAction } from '../data/ledger'
import { useActivityOptional } from './useActivity'

const DISTRIBUTOR_ABI = normalizeAbi(MERKL_DISTRIBUTOR_ABI)

export function useEarnRewards() {
  const { address, isConnected } = useWallet() || {}
  const { sendOnChain, canTransactOn, cannotTransactReason } = useEarnSend()
  const activity = useActivityOptional()
  const earnNetworks = useMemo(() => getEarnNetworks(), [])

  const [rewards, setRewards] = useState([]) // tagged with chainId
  const [failedNetworks, setFailedNetworks] = useState([])
  const [status, setStatus] = useState('loading')
  const [fetchedAt, setFetchedAt] = useState(null)
  const [claimState, setClaimState] = useState({ status: 'idle', chainId: null, txUrl: null, error: null })
  const reqIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!isConnected || !address || earnNetworks.length === 0) return
    const reqId = ++reqIdRef.current
    setStatus('loading')
    const results = await Promise.all(
      earnNetworks.map((net) =>
        fetchRewards(address, net.chainId)
          .then((list) => ({ chainId: net.chainId, list, ok: true }))
          .catch(() => ({ chainId: net.chainId, list: [], ok: false })),
      ),
    )
    if (reqId !== reqIdRef.current) return
    const anyOk = results.some((r) => r.ok)
    if (!anyOk) {
      setRewards([])
      setFailedNetworks(earnNetworks.map((n) => n.name))
      setStatus('unavailable')
      return
    }
    setRewards(
      results.flatMap((r) => r.list.map((reward) => ({ ...reward, chainId: r.chainId }))),
    )
    setFailedNetworks(results.filter((r) => !r.ok).map((r) => NETWORKS[r.chainId]?.name || String(r.chainId)))
    setFetchedAt(Date.now())
    setStatus('ready')
  }, [isConnected, address, earnNetworks])

  useEffect(() => {
    reqIdRef.current++
    setRewards([])
    setFailedNetworks([])
    setFetchedAt(null)
    setClaimState({ status: 'idle', chainId: null, txUrl: null, error: null })
    setStatus(isConnected ? 'loading' : 'idle')
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  const totalClaimable = useMemo(
    () => rewards.reduce((n, r) => n + (r.claimable > 0n ? 1 : 0), 0),
    [rewards],
  )

  /**
   * Claim every claimable reward on one network in a single distributor
   * transaction — switching to that network automatically first.
   */
  const claim = useCallback(
    async (chainId) => {
      const earnConfig = getEarnConfig(chainId)
      if (!address || !earnConfig?.merklDistributor) return
      const chainRewards = rewards.filter((r) => r.chainId === chainId)
      const args = buildClaimArgs(address, chainRewards)
      if (!args) return // nothing claimable — never prompt the wallet for a no-op
      setClaimState({ status: 'pending', chainId, txUrl: null, error: null })
      try {
        const sent = await sendOnChain(chainId, [
          {
            target: earnConfig.merklDistributor,
            data: encodeFunctionData({
              abi: DISTRIBUTOR_ABI,
              functionName: 'claim',
              args: [args.users, args.tokens, args.amounts, args.proofs],
            }),
            value: 0n,
          },
        ])
        if (sent?.state === 'failed') throw new Error(sent.reason || 'claim failed')
        const txHash = sent?.txHash ?? sent?.userOpHash ?? null
        if (!txHash) throw new Error('Submitted, but no transaction reference was returned.')
        // Explorer links only for real tx hashes (a UserOp hash has no page).
        const txUrl = sent?.txHash ? getBlockscoutUrl(chainId, sent.txHash, 'tx') : null
        const summary = args.rewards
          .map((r) => `${formatUnits(r.claimable, r.token.decimals)} ${r.token.symbol}`.trim())
          .join(', ')
        queueEarnAction(address, chainId, {
          type: 'earn-rewards-claimed',
          refId: args.tokens[0],
          message: `Claimed earn rewards: ${summary}`,
          txHash,
          txUrl,
          at: Date.now(),
        })
        // Durable audit entry in the unified activity ledger (spec 051),
        // scoped to the reward's own chain.
        captureEarnAction(address, chainId, {
          type: 'earn-rewards-claimed',
          txHash,
          at: Date.now(),
          tokenAddress: args.tokens[0] ?? null,
          description: `Claimed earn rewards: ${summary}`,
        })
        activity?.refresh?.()
        setClaimState({ status: 'confirmed', chainId, txUrl, error: null })
        load()
      } catch (err) {
        const rejected = /rejected|denied|cancelled|not allowed|abort/i.test(err?.message || '')
        setClaimState({
          status: 'error',
          chainId,
          txUrl: null,
          error: rejected ? 'The confirmation was cancelled.' : err?.message || 'Claim failed. Please try again.',
        })
      }
    },
    [sendOnChain, address, rewards, activity, load],
  )

  return useMemo(
    () => ({
      rewards,
      failedNetworks,
      status,
      fetchedAt,
      totalClaimable,
      claim,
      claimState,
      canTransactOn,
      cannotTransactReason,
      legacyRewardsUrl: earnNetworks[0]?.earn?.legacyRewardsUrl || null,
      refresh: load,
    }),
    [rewards, failedNetworks, status, fetchedAt, totalClaimable, claim, claimState, canTransactOn, cannotTransactReason, earnNetworks, load],
  )
}

export default useEarnRewards
