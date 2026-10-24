// Spec 105 — pure multichain deployment orchestration. One plan, N networks, SAME address: the
// initializer is the chain-independent spec-043 encoding (owners + threshold + canonical fallback
// handler, NO policy setup — research D1), so `computeVaultAddress` resolves identically on every
// chain whose canonical Safe set matches. Rules are installed AFTER deployment, per chain, from
// the vault's one semantic config (vaultRulesConfig.js) through the vault's own threshold
// machinery — directly where the creator alone meets the threshold, queued for co-owner approval
// where not (research D2). Everything here is pure and unit-testable; the wallet/rail/switch work
// lives in hooks/useVaultDeployment.js.
//
// Status truth: in-flight states are session-local; the DURABLE truth is re-derived from the
// chain (`deriveNetworkStatus`) — a probe failure is `unreadable`, never "not deployed"
// (constitution III: an unreachable chain is not evidence of absence).

import { encodeFunctionData } from 'viem'
import { normalizeAbi } from '../chains/readContract'
import { getAddress } from '../evm/address'
import { SAFE_ABI } from '../../abis/Safe'
import { getSafeContracts } from '../../config/safeContracts'
import { getContractAddressForChain } from '../../config/contracts'
import { buildSetupInitializer, computeVaultAddress, validateVaultConfig } from './safeVault'
import { buildSafeTx, computeSafeTxHash, buildPrevalidatedSignatures, encodeExecTransaction } from './vaultTransaction'
import { buildAdoptV2Txs } from './policyV2'
import { realizeRules, isEmptySemanticRules } from './vaultRulesConfig'
import { emitProposalCall } from './proposalHub'

const SAFE = normalizeAbi(SAFE_ABI)

export const DEPLOY_STATUS = {
  NOT_SELECTED: 'not-selected',
  QUEUED: 'queued',
  AWAITING_SIGNATURE: 'awaiting-signature',
  DEPLOYING: 'deploying',
  CONFIRMING: 'confirming',
  LIVE: 'live',
  ALREADY_LIVE: 'already-live',
  FAILED: 'failed',
  UNREADABLE: 'unreadable',
}

export const RULES_STATUS = {
  NONE: 'none',
  INSTALLING: 'installing',
  ACTIVE: 'active',
  AWAITING_APPROVAL: 'awaiting-approval',
  INSTALL_FAILED: 'install-failed',
  UNREADABLE: 'unreadable',
}

/** Failure stages — every `failed` names one, and retry re-enters that stage only. */
export const DEPLOY_STAGE = {
  SWITCH: 'switch',
  DEPLOY: 'deploy',
  RULES_SET: 'rules-setRules',
  RULES_GUARD: 'rules-setGuard',
}

/**
 * Build the chain-independent deployment plan. Throws — naming the chain — when a chain has no
 * custody support or its canonical Safe set would produce a DIFFERENT address (offering it would
 * silently break "same address on every network").
 * @returns {{ initializer:string, saltNonce:string, chainIds:number[], predictedAddressOf:(creationCode:string)=>string }}
 */
export function buildDeploymentPlan({ owners, threshold, saltNonce, chainIds }) {
  validateVaultConfig(owners, threshold)
  if (!Array.isArray(chainIds) || chainIds.length === 0) throw new Error('Pick at least one network')
  if (saltNonce == null) throw new Error('A saltNonce is required')
  let initializer = null
  let reference = null
  for (const chainId of chainIds) {
    const safe = getSafeContracts(chainId)
    if (!safe) throw new Error(`Vaults are not available on chain ${chainId}`)
    const init = buildSetupInitializer(owners, threshold, safe.fallbackHandler)
    if (initializer == null) {
      initializer = init
      reference = { chainId, factory: safe.proxyFactory, singleton: safe.singletonL2 }
    } else if (
      init !== initializer ||
      getAddress(safe.proxyFactory) !== getAddress(reference.factory) ||
      getAddress(safe.singletonL2) !== getAddress(reference.singleton)
    ) {
      throw new Error(
        `Chain ${chainId} would deploy this vault at a different address and cannot join this vault's network set`,
      )
    }
  }
  return {
    initializer,
    saltNonce: BigInt(saltNonce).toString(),
    chainIds: chainIds.map(Number),
    // creationCode is read on-chain once (identical across the canonical set); the caller feeds it in.
    predictedAddressOf: (creationCode) =>
      computeVaultAddress({
        proxyFactory: reference.factory,
        singleton: reference.singleton,
        initializer,
        saltNonce: BigInt(saltNonce),
        creationCode,
      }),
  }
}

/**
 * Build the per-chain rules installation. Returns null when the semantic config installs nothing.
 *
 * mode 'direct'   — the creator alone meets the threshold: two execTransaction calls (setRules on
 *                   the guard, THEN setGuard on the vault — rules exist before the guard activates)
 *                   signed with the pre-validated owner==sender encoding.
 * mode 'propose'  — more signatures are needed: each step becomes hub proposal + the creator's own
 *                   approveHash; co-owners approve through the existing queue, and every surface
 *                   shows the rules as AWAITING APPROVAL on that network until executed (FR-010).
 */
export function buildInstallPlan({ vaultAddress, chainId, semanticRules, owners, threshold, creator, startNonce = 0 }) {
  if (!semanticRules || isEmptySemanticRules(semanticRules)) return null
  const realized = realizeRules(chainId, semanticRules, owners)
  const steps = buildAdoptV2Txs(getAddress(vaultAddress), chainId, realized.rules, realized.cooldown)
  const safeTxs = steps.map((t, i) => buildSafeTx({ ...t, nonce: BigInt(startNonce) + BigInt(i) }))
  const hashes = safeTxs.map((tx) => computeSafeTxHash(vaultAddress, chainId, tx))
  const cleanOwners = owners.map((o) => getAddress(o))
  const canDirect = Number(threshold) === 1 && creator != null && cleanOwners.includes(getAddress(creator))

  if (canDirect) {
    const calls = safeTxs.map((tx) => ({
      to: getAddress(vaultAddress),
      value: 0n,
      data: encodeFunctionData({
        abi: SAFE,
        functionName: 'execTransaction',
        args: encodeExecTransaction(tx, buildPrevalidatedSignatures([creator])),
      }),
    }))
    return { mode: 'direct', realized, safeTxs, hashes, calls }
  }

  const hubAddress = getContractAddressForChain('safeProposalHub', chainId)
  if (!hubAddress) {
    // No hub ⇒ proposals cannot be DISCOVERED by co-owners; queuing here would strand the rules
    // invisibly. Honest refusal — the vault still deploys, the rules state says why they did not.
    return { mode: 'unavailable', realized, safeTxs, hashes, calls: [], reason: `Rule proposals cannot be published on chain ${chainId}` }
  }
  const calls = safeTxs.flatMap((tx, i) => {
    // emitProposalCall returns the passkey sendCalls shape ({target,...}); every call in THIS
    // plan is `{to,value,data}` — the shape both rails consume. Mixing them sent the hub call
    // with `to: undefined`, which a wallet treats as a CONTRACT DEPLOYMENT of propose calldata
    // (invalid opcode, rules never queued) — caught on chain by full/44 RL-02 (issue #1452).
    const emit = emitProposalCall({ hubAddress, safe: getAddress(vaultAddress), safeTx: tx, safeTxHash: hashes[i] })
    return [
      { to: emit.target, value: emit.value ?? 0n, data: emit.data },
      { to: getAddress(vaultAddress), value: 0n, data: encodeFunctionData({ abi: SAFE, functionName: 'approveHash', args: [hashes[i]] }) },
    ]
  })
  return { mode: 'propose', realized, safeTxs, hashes, calls }
}

/**
 * Durable status from chain facts (reopen/second device — FR-009). `code` is the getCode result;
 * pass `codeError: true` when the read itself failed.
 */
export function deriveNetworkStatus({ code, codeError = false }) {
  if (codeError) return { status: DEPLOY_STATUS.UNREADABLE }
  if (code && code !== '0x') return { status: DEPLOY_STATUS.LIVE }
  return { status: DEPLOY_STATUS.NOT_SELECTED, deployed: false }
}

/** Initial per-network state for a selection. */
export function initialDeploymentState(chainIds) {
  const state = {}
  for (const id of chainIds) {
    state[Number(id)] = { status: DEPLOY_STATUS.QUEUED, rulesStatus: RULES_STATUS.NONE }
  }
  return state
}

/**
 * Event reducer for the per-network state machine (contracts/deployment-states.md). Transitions
 * happen ONLY on real events — a selection, a probe result, a wallet event, a sent tx, a receipt,
 * a read — never on a timer pretending progress.
 */
export function deploymentReducer(state, event) {
  const chainId = Number(event.chainId)
  const cur = state[chainId] || { status: DEPLOY_STATUS.QUEUED, rulesStatus: RULES_STATUS.NONE }
  const set = (patch) => ({ ...state, [chainId]: { ...cur, ...patch } })
  switch (event.type) {
    case 'probed-live':
      return set({ status: DEPLOY_STATUS.ALREADY_LIVE })
    case 'signature-requested':
      return set({ status: DEPLOY_STATUS.AWAITING_SIGNATURE, stage: event.stage || DEPLOY_STAGE.DEPLOY })
    case 'submitted':
      return set({ status: DEPLOY_STATUS.DEPLOYING, txHash: event.txHash })
    case 'confirming':
      return set({ status: DEPLOY_STATUS.CONFIRMING })
    case 'deployed':
      return set({ status: DEPLOY_STATUS.LIVE, stage: undefined })
    case 'rules-installing':
      return set({ rulesStatus: RULES_STATUS.INSTALLING })
    case 'rules-active':
      return set({ rulesStatus: RULES_STATUS.ACTIVE })
    case 'rules-queued':
      return set({ rulesStatus: RULES_STATUS.AWAITING_APPROVAL })
    case 'rules-failed':
      return set({ rulesStatus: RULES_STATUS.INSTALL_FAILED, reason: event.reason })
    case 'failed':
      // Every failure names its stage and carries a member-facing reason; retry re-enters here.
      return set({ status: DEPLOY_STATUS.FAILED, stage: event.stage, reason: event.reason })
    case 'retry':
      return set({ status: DEPLOY_STATUS.QUEUED, reason: undefined })
    default:
      return state
  }
}
