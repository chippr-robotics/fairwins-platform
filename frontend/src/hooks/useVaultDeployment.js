// Spec 105 — drives the pure deployment plan (lib/custody/vaultDeployment) across the member's
// selected networks, ONE network in flight at a time (one wallet, one active chain). Per network:
// resolve the write rail FIRST (signer-first, spec writeRail rules — an unavailable rail is a
// stated reason, not an attempted throw), probe for already-live, settle the wallet on that chain
// (spec-102 switch-first loop), deploy, then install the rules per the plan's mode. Failures
// isolate per network and name their stage; retry re-enters that network only. Reopen truth is
// re-derived from the chain (`refreshStatuses`), never from this session's memory.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '.'
import { getProvider } from '../utils/blockchainService'
import { getSafeContracts } from '../config/safeContracts'
import { resolveWriteRail, RAILS } from '../lib/chains/writeRail'
import { settleWalletOn } from '../lib/chains/submitOn'
import { chainDisplayName } from '../lib/custody/chainName'
import { buildCreateVaultCalldata } from '../lib/custody/safeVault'
import {
  buildDeploymentPlan,
  buildInstallPlan,
  initialDeploymentState,
  deploymentReducer,
  deriveNetworkStatus,
  DEPLOY_STATUS,
  DEPLOY_STAGE,
} from '../lib/custody/vaultDeployment'
import { saveCreationRecord, getCreationRecord } from '../lib/custody/vaultCreationRecords'
import { upsertVaultReference } from '../lib/custody/vaultReferences'
import { ensureVaultContact } from '../lib/custody/vaultAddressBook'

export default function useVaultDeployment() {
  const wallet = useWallet()
  const { address: account, chainId, loginMethod, sendCalls, switchNetwork } = wallet
  const [byChain, setByChain] = useState({})
  const [predictedAddress, setPredictedAddress] = useState(null)
  const [running, setRunning] = useState(false)
  const latestRef = useRef(wallet)
  useEffect(() => {
    latestRef.current = wallet
  })

  const dispatch = useCallback((event) => {
    setByChain((prev) => deploymentReducer(prev, event))
  }, [])

  /** The write rail for one target chain — stated BEFORE anything is attempted. */
  const railFor = useCallback(
    (targetChainId) =>
      resolveWriteRail({
        chainId: targetChainId,
        signer: latestRef.current.signer,
        loginMethod,
        chainName: chainDisplayName(targetChainId),
      }),
    [loginMethod],
  )

  /**
   * Spec-102 switch-first settle loop — now the SHARED one (spec 110 T026,
   * `lib/chains/submitOn.js#settleWalletOn`). This hook's copy waited 30s at a 250ms poll while
   * the other two waited 20s at 150ms; nothing chose that, it is what happens when a loop is
   * copied. The shared constants are the 20s/150ms pair, so a deployment now gets the same
   * patience as every other write instead of ten seconds more.
   */
  const settleOnChain = useCallback(
    (target) =>
      settleWalletOn(target, {
        readWallet: () => latestRef.current,
        switchNetwork,
        chainName: chainDisplayName,
        needsSigner: loginMethod !== 'passkey',
        subject: 'This deployment',
      }),
    [loginMethod, switchNetwork],
  )

  const recordReference = useCallback(
    (target, vaultAddress, label = '') => {
      if (!account || !vaultAddress) return
      upsertVaultReference(account, { chainId: Number(target), address: vaultAddress, label, role: 'owner' }, Date.now())
      ensureVaultContact(account, { address: vaultAddress, chainId: Number(target), label })
    },
    [account],
  )

  /** One network, start to terminal state. Never throws — failures land in the row's state. */
  const deployToChain = useCallback(
    async ({ chainId: target, predicted, owners, threshold, saltNonce, semanticRules, label }) => {
      const isPasskey = loginMethod === 'passkey'
      try {
        // 1 — probe: already live is success, not failure (FR-019).
        let code = null
        try {
          code = await getProvider(target).getCode(predicted)
        } catch {
          code = null // unreadable probe: proceed — the deploy tx itself will answer
        }
        if (code && code !== '0x') {
          dispatch({ type: 'probed-live', chainId: target })
          recordReference(target, predicted, label)
          return
        }

        // 2 — the write rail, stated before anything is attempted.
        const rail = railFor(target)
        if (!rail.available) {
          dispatch({ type: 'failed', chainId: target, stage: DEPLOY_STAGE.SWITCH, reason: rail.reason })
          return
        }

        // 3 — wallet onto this chain (classic rail; the passkey rail addresses the chain itself).
        let settledSigner = null
        if (rail.rail === RAILS.SIGNER) {
          try {
            const settled = await settleOnChain(target)
            settledSigner = settled.signer
          } catch (err) {
            dispatch({ type: 'failed', chainId: target, stage: DEPLOY_STAGE.SWITCH, reason: err.message })
            return
          }
        }

        // 4 — build create + install.
        const create = buildCreateVaultCalldata({ chainId: target, owners, threshold, saltNonce })
        const install = buildInstallPlan({
          vaultAddress: predicted,
          chainId: target,
          semanticRules,
          owners,
          threshold,
          creator: account,
          startNonce: 0,
        })

        dispatch({ type: 'signature-requested', chainId: target, stage: DEPLOY_STAGE.DEPLOY })

        if (isPasskey && rail.rail === RAILS.PASSKEY) {
          // One batch: deploy + installs (the CREATE2 address is known before deployment).
          const calls = [
            { target: create.to, data: create.data, value: create.value ?? 0n },
            ...(install?.calls || []).map((c) => ({ target: c.to, data: c.data, value: c.value ?? 0n })),
          ]
          if (install?.calls?.length) dispatch({ type: 'rules-installing', chainId: target })
          const sent = await sendCalls(calls, { chainId: target })
          dispatch({ type: 'submitted', chainId: target, txHash: sent?.txHash ?? sent?.userOpHash })
          dispatch({ type: 'deployed', chainId: target })
        } else {
          const sent = await settledSigner.sendTransaction({ to: create.to, data: create.data, value: create.value })
          dispatch({ type: 'submitted', chainId: target, txHash: sent.hash })
          dispatch({ type: 'confirming', chainId: target })
          await sent.wait()
          dispatch({ type: 'deployed', chainId: target })

          if (install && install.calls.length > 0) {
            dispatch({ type: 'rules-installing', chainId: target })
            const stages = [DEPLOY_STAGE.RULES_SET, DEPLOY_STAGE.RULES_GUARD]
            for (let i = 0; i < install.calls.length; i++) {
              const call = install.calls[i]
              try {
                const tx = await settledSigner.sendTransaction({ to: call.to, data: call.data, value: call.value ?? 0n })
                await tx.wait()
              } catch (err) {
                dispatch({
                  type: 'rules-failed',
                  chainId: target,
                  stage: stages[Math.min(i, 1)],
                  reason: err?.shortMessage || err?.message || 'Rule installation failed',
                })
                recordReference(target, predicted, label)
                return
              }
            }
          }
        }

        if (!install) {
          // no rules chosen — nothing more to say
        } else if (install.mode === 'direct') {
          dispatch({ type: 'rules-active', chainId: target })
        } else if (install.mode === 'propose') {
          dispatch({ type: 'rules-queued', chainId: target })
        } else if (install.mode === 'unavailable') {
          dispatch({ type: 'rules-failed', chainId: target, reason: install.reason })
        }
        recordReference(target, predicted, label)
      } catch (err) {
        dispatch({
          type: 'failed',
          chainId: target,
          stage: DEPLOY_STAGE.DEPLOY,
          reason: err?.shortMessage || err?.message || 'Deployment failed',
        })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, loginMethod, sendCalls, railFor, settleOnChain, dispatch],
  )

  /**
   * Deploy (or extend) a vault across `chainIds`, sequentially, in selection order.
   * Resolves with { address, results } when every network has reached a terminal state
   * (live / already-live / failed / rules queued) — a failure on one network never
   * aborts the rest.
   */
  const start = useCallback(
    async ({ owners, threshold, saltNonce, presetType = 'complex', semanticRules = null, chainIds, label = '' }) => {
      const plan = buildDeploymentPlan({ owners, threshold, saltNonce, chainIds })
      setRunning(true)
      setByChain(initialDeploymentState(chainIds))
      try {
        // The canonical creation code is identical wherever the canonical factory is; read it from
        // the first chain that answers so the address is shown before any signature (FR-007).
        let creationCode = null
        let lastErr = null
        for (const id of chainIds) {
          try {
            const factory = getSafeContracts(id).proxyFactory
            const provider = getProvider(id)
            const res = await provider.call({
              to: factory,
              data: '0x53e5d935', // proxyCreationCode()
            })
            // abi-decode bytes return
            const offset = 2 + 64
            const len = parseInt(res.slice(offset, offset + 64), 16) * 2
            creationCode = '0x' + res.slice(offset + 64, offset + 64 + len)
            break
          } catch (err) {
            lastErr = err
          }
        }
        if (!creationCode) {
          throw new Error('No selected network could be reached to predict the vault address', { cause: lastErr })
        }
        const predicted = plan.predictedAddressOf(creationCode)
        setPredictedAddress(predicted)

        for (const id of chainIds) {
          await deployToChain({
            chainId: Number(id),
            predicted,
            owners,
            threshold,
            saltNonce,
            semanticRules,
            label,
          })
        }
        // The record is written once, on the first run that produced (or found) the address —
        // saveCreationRecord is a no-op for an identical record, a thrown error for a different one.
        if (account && predicted) {
          try {
            saveCreationRecord(account, {
              address: predicted,
              owners,
              threshold,
              saltNonce: String(saltNonce),
              presetType,
              rules: semanticRules,
              createdAt: Date.now(),
            })
          } catch (err) {
            // A conflicting record means this address was created with OTHER parameters — surface
            // loudly rather than silently keeping either story.
            console.error('creation record conflict', err)
          }
        }
        return { address: predicted }
      } finally {
        setRunning(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, dispatch],
  )



  /** Retry ONE network's failed stage (the rest are untouched). */
  const retryChain = useCallback(
    async ({ chainId: target, owners, threshold, saltNonce, semanticRules, label }) => {
      const predicted = predictedAddress
      if (!predicted) return
      dispatch({ type: 'retry', chainId: target })
      await deployToChain({ chainId: Number(target), predicted, owners, threshold, saltNonce, semanticRules, label })
    },
    [predictedAddress, deployToChain, dispatch],
  )

  /**
   * Durable truth for reopen / a second device (FR-009): probe each chain and derive the status
   * from what the chain itself says. A failed read is UNREADABLE, never "not deployed".
   */
  const refreshStatuses = useCallback(async (vaultAddress, chainIds) => {
    const next = {}
    await Promise.all(
      chainIds.map(async (id) => {
        try {
          const code = await getProvider(id).getCode(vaultAddress)
          next[Number(id)] = deriveNetworkStatus({ code })
        } catch {
          next[Number(id)] = deriveNetworkStatus({ codeError: true })
        }
      }),
    )
    setByChain((prev) => {
      const merged = { ...prev }
      for (const [id, st] of Object.entries(next)) {
        merged[id] = { ...(prev[id] || {}), ...st }
      }
      return merged
    })
    return next
  }, [])

  const hasRecordFor = useCallback(
    (vaultAddress) => (account ? Boolean(getCreationRecord(account, vaultAddress)) : false),
    [account],
  )

  return useMemo(
    () => ({
      byChain,
      predictedAddress,
      running,
      start,
      retryChain,
      refreshStatuses,
      railFor,
      hasRecordFor,
      connectedChainId: chainId,
      DEPLOY_STATUS,
    }),
    [byChain, predictedAddress, running, start, retryChain, refreshStatuses, railFor, hasRecordFor, chainId],
  )
}
