/**
 * useStakingActions (spec 065, US1 stake + extended in US2) — build and submit
 * staking transactions through the spec-041 unified send rail (useEarnSend), so
 * both passkey (one ceremony for the whole batch) and classic wallets work, and
 * any network switch is handled as part of submitting.
 *
 * US1 exposes `stake`. US2 adds unstake / withdraw / claim. Each resolves with
 * { txHash, txUrl } or throws a member-facing error.
 */
import { useCallback } from 'react'
import { useWallet } from './useWalletManagement'
import { useEarnSend } from './useEarnSend'
import { getBlockscoutUrl } from '../config/blockExplorer'
import { POL_TOKEN_L1 } from '../config/staking'
import { buildStakeForOption } from '../lib/staking/stakingActions'
import { buildWithdrawalRequestCalls, buildLidoClaimCalls } from '../lib/staking/lidoStaking'
import { buildUnstakeCalls as buildSpolUnstake, buildWithdrawCalls as buildSpolWithdraw } from '../lib/staking/spolStaking'
import {
  buildUndelegateCalls,
  buildDelegationWithdrawCalls,
  buildDelegationClaimCalls,
} from '../lib/staking/polygonDelegation'

/**
 * The POL contract for an option, taken from the OPTION rather than from the module constant.
 *
 * They are the same address on Ethereum — `ethereumStakingConfig()` builds `asset.address` from
 * `POL_TOKEN_L1` — but the constant is a default, not the identity of the thing on screen. Reading
 * it instead of the option's own asset silently approves and reads the WRONG TOKEN wherever the two
 * can differ: a second network offering delegation, or a `VITE_POL_TOKEN_L1` override applied to
 * one and not the other. The fallback keeps an option that carries no asset address working exactly
 * as before.
 */
const polTokenFor = (option) => option?.asset?.address || POL_TOKEN_L1

async function submitBatch({ sendOnChain, chainId, calls }) {
  const sent = await sendOnChain(chainId, calls)
  if (sent?.state === 'failed') throw new Error(sent.reason || 'transaction failed')
  const txHash = sent?.txHash ?? sent?.userOpHash ?? null
  if (!txHash) throw new Error('Submitted, but no transaction reference was returned.')
  const txUrl = sent?.txHash ? getBlockscoutUrl(chainId, sent.txHash, 'tx') : null
  return { txHash, txUrl }
}

export function useStakingActions() {
  const { address } = useWallet() || {}
  const send = useEarnSend()

  const stake = useCallback(
    async (option, amount, { onState, feeQuote } = {}) => {
      if (!address) throw new Error('This session cannot send transactions right now — please reconnect.')
      // spec 066: thread the disclosed fee quote (with its bps as the maxFeeBps ceiling) so the
      // router path charges no more than the member was shown. Falls back to the option's overlay.
      const { calls } = await buildStakeForOption(option, {
        account: address,
        amount,
        chainId: option.chainId,
        polToken: polTokenFor(option),
        feeQuote: feeQuote || option.feeQuote,
      })
      return submitBatch({
        sendOnChain: (chainId, c) => send.sendOnChain(chainId, c, { onState }),
        chainId: option.chainId,
        calls,
      })
    },
    [address, send],
  )

  // Begin an unstake. On success the next positions poll detects the new exit
  // on-chain (no receipt parsing needed). Returns { txHash, txUrl }.
  const requestUnstake = useCallback(
    async (option, amount, { onState } = {}) => {
      if (!address) throw new Error('This session cannot send transactions right now — please reconnect.')
      let calls
      if (option.providerKind === 'lido') {
        ;({ calls } = await buildWithdrawalRequestCalls({ contracts: option.contracts, account: address, amount, chainId: option.chainId }))
      } else if (option.providerKind === 'spol') {
        ;({ calls } = buildSpolUnstake({ contracts: option.contracts, amount }))
      } else {
        ;({ calls } = buildUndelegateCalls({ validatorShare: option.validatorShare, amount }))
      }
      return submitBatch({ sendOnChain: (id, c) => send.sendOnChain(id, c, { onState }), chainId: option.chainId, calls })
    },
    [address, send],
  )

  // Withdraw a matured exit. `exit` = { handle: { requestId } | { unbondNonce } }.
  const withdraw = useCallback(
    async (option, exit, { onState } = {}) => {
      if (!address) throw new Error('This session cannot send transactions right now — please reconnect.')
      let calls
      if (option.providerKind === 'lido') {
        ;({ calls } = await buildLidoClaimCalls({ contracts: option.contracts, chainId: option.chainId, requestIds: [exit.handle.requestId] }))
      } else if (option.providerKind === 'spol') {
        ;({ calls } = buildSpolWithdraw({ contracts: option.contracts }))
      } else {
        ;({ calls } = buildDelegationWithdrawCalls({ validatorShare: option.validatorShare, unbondNonce: exit.handle.unbondNonce }))
      }
      return submitBatch({ sendOnChain: (id, c) => send.sendOnChain(id, c, { onState }), chainId: option.chainId, calls })
    },
    [address, send],
  )

  // Claim separately-distributed delegation rewards (delegated only).
  const claimRewards = useCallback(
    async (option, { onState } = {}) => {
      if (!address) throw new Error('This session cannot send transactions right now — please reconnect.')
      const { calls } = buildDelegationClaimCalls({ validatorShare: option.validatorShare })
      return submitBatch({ sendOnChain: (id, c) => send.sendOnChain(id, c, { onState }), chainId: option.chainId, calls })
    },
    [address, send],
  )

  return { stake, requestUnstake, withdraw, claimRewards, address, ...send }
}

export default useStakingActions
