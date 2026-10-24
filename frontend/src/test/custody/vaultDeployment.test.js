// Spec 105 (T-003/T-005) — the pure orchestration core. Proves: chain-independent initializer ⇒
// identical CREATE2 address across chains; direct vs propose install modes; the reducer never
// fabricates progress; durable status is re-derived from chain facts (a failed probe is
// UNREADABLE, never "not deployed").

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config/contracts', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    getContractAddressForChain: vi.fn((name, chainId) => {
      if (name === 'safeProposalHub') return Number(chainId) === 61 ? null : '0x4444444444444444444444444444444444444444'
      if (name === 'safePolicyGuardV2') return '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c'
      if (name === 'policyGuardV2Setup' || name === 'policyGuardSetup') return '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b'
      if (name === 'paymentToken') return '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
      return null
    }),
  }
})

import {
  buildDeploymentPlan,
  buildInstallPlan,
  deriveNetworkStatus,
  initialDeploymentState,
  deploymentReducer,
  DEPLOY_STATUS,
  RULES_STATUS,
  DEPLOY_STAGE,
} from '../../lib/custody/vaultDeployment'
import { DEFAULT_SEMANTIC_RULES } from '../../lib/custody/vaultRulesConfig'

const O1 = '0x2222222222222222222222222222222222222222'
const O2 = '0x3333333333333333333333333333333333333333'
const VAULT = '0xaBCdEf0000000000000000000000000000000001'
// SafeProxy creation code prefix (any bytes work for the pure CREATE2 check — identity is what matters)
const CREATION_CODE = '0x608060405234801561001057600080fd5b50'

describe('buildDeploymentPlan', () => {
  it('produces ONE initializer for every custody chain and the same predicted address', () => {
    const plan = buildDeploymentPlan({ owners: [O1, O2], threshold: 1, saltNonce: 42, chainIds: [137, 8453, 61] })
    const single = buildDeploymentPlan({ owners: [O1, O2], threshold: 1, saltNonce: 42, chainIds: [10] })
    expect(plan.initializer).toBe(single.initializer)
    expect(plan.predictedAddressOf(CREATION_CODE)).toBe(single.predictedAddressOf(CREATION_CODE))
  })
  it('a different saltNonce or owner order is a different address', () => {
    const a = buildDeploymentPlan({ owners: [O1, O2], threshold: 1, saltNonce: 42, chainIds: [137] })
    const b = buildDeploymentPlan({ owners: [O1, O2], threshold: 1, saltNonce: 43, chainIds: [137] })
    const c = buildDeploymentPlan({ owners: [O2, O1], threshold: 1, saltNonce: 42, chainIds: [137] })
    expect(a.predictedAddressOf(CREATION_CODE)).not.toBe(b.predictedAddressOf(CREATION_CODE))
    expect(a.predictedAddressOf(CREATION_CODE)).not.toBe(c.predictedAddressOf(CREATION_CODE))
  })
  it('refuses a chain with no custody support, naming it', () => {
    expect(() => buildDeploymentPlan({ owners: [O1], threshold: 1, saltNonce: 1, chainIds: [1] })).toThrow(/chain 1/)
  })
  it('refuses an empty selection and a missing salt', () => {
    expect(() => buildDeploymentPlan({ owners: [O1], threshold: 1, saltNonce: 1, chainIds: [] })).toThrow(/at least one network/i)
    expect(() => buildDeploymentPlan({ owners: [O1], threshold: 1, chainIds: [137] })).toThrow(/saltNonce/)
  })
})

describe('buildInstallPlan', () => {
  const base = { vaultAddress: VAULT, chainId: 137, semanticRules: DEFAULT_SEMANTIC_RULES, owners: [O1, O2] }

  it('creator meets threshold ⇒ direct mode: setRules exec THEN setGuard exec', () => {
    const plan = buildInstallPlan({ ...base, threshold: 1, creator: O1 })
    expect(plan.mode).toBe('direct')
    expect(plan.calls).toHaveLength(2)
    // Both calls are execTransaction on the vault itself
    expect(plan.calls.every((c) => c.to === VAULT)).toBe(true)
    expect(plan.safeTxs[0].nonce).toBe(0n)
    expect(plan.safeTxs[1].nonce).toBe(1n)
  })
  it('threshold above the creator alone ⇒ propose mode: hub proposal + creator approveHash per step', () => {
    const plan = buildInstallPlan({ ...base, threshold: 2, creator: O1 })
    expect(plan.mode).toBe('propose')
    expect(plan.calls).toHaveLength(4) // (emit + approve) × 2
    // EVERY call carries `to` — the shape both rails consume. emitProposalCall's own shape is
    // {target,...} (passkey sendCalls); leaking it here sent the hub call as a contract
    // DEPLOYMENT (`to: undefined`) and the rules never queued — full/44 RL-02, issue #1452.
    for (const call of plan.calls) {
      expect(call.to, 'every install call is addressed').toMatch(/^0x[0-9a-fA-F]{40}$/)
      expect(call.target).toBeUndefined()
    }
    // Alternating: hub emit (discoverability), then the creator's approveHash on the vault.
    expect(plan.calls[1].to).toBe(VAULT)
    expect(plan.calls[3].to).toBe(VAULT)
    expect(plan.calls[0].to).toBe(plan.calls[2].to)
    expect(plan.calls[0].to).not.toBe(VAULT)
  })
  it('no hub on the chain ⇒ honest unavailable, nothing queued invisibly', () => {
    const plan = buildInstallPlan({ ...base, chainId: 61, threshold: 2, creator: O1 })
    expect(plan.mode).toBe('unavailable')
    expect(plan.calls).toHaveLength(0)
    expect(plan.reason).toMatch(/61/)
  })
  it('empty semantic rules ⇒ null (nothing to install anywhere)', () => {
    expect(
      buildInstallPlan({ ...base, threshold: 1, creator: O1, semanticRules: { dailyCapAmount: '', cooldownSeconds: 0, allowedMoney: 'everything' } }),
    ).toBeNull()
  })
  it('a non-owner creator never gets direct mode', () => {
    const plan = buildInstallPlan({ ...base, threshold: 1, creator: '0x5555555555555555555555555555555555555555' })
    expect(plan.mode).toBe('propose')
  })
})

describe('deriveNetworkStatus (durable truth)', () => {
  it('code present ⇒ live; absent ⇒ not deployed; READ FAILURE ⇒ unreadable, never absence', () => {
    expect(deriveNetworkStatus({ code: '0x6080' }).status).toBe(DEPLOY_STATUS.LIVE)
    expect(deriveNetworkStatus({ code: '0x' }).status).toBe(DEPLOY_STATUS.NOT_SELECTED)
    expect(deriveNetworkStatus({ codeError: true }).status).toBe(DEPLOY_STATUS.UNREADABLE)
  })
})

describe('deploymentReducer', () => {
  it('walks the happy path on real events only', () => {
    let s = initialDeploymentState([137, 8453])
    expect(s[137].status).toBe(DEPLOY_STATUS.QUEUED)
    s = deploymentReducer(s, { type: 'signature-requested', chainId: 137 })
    s = deploymentReducer(s, { type: 'submitted', chainId: 137, txHash: '0xabc' })
    s = deploymentReducer(s, { type: 'confirming', chainId: 137 })
    s = deploymentReducer(s, { type: 'deployed', chainId: 137 })
    s = deploymentReducer(s, { type: 'rules-installing', chainId: 137 })
    s = deploymentReducer(s, { type: 'rules-active', chainId: 137 })
    expect(s[137].status).toBe(DEPLOY_STATUS.LIVE)
    expect(s[137].rulesStatus).toBe(RULES_STATUS.ACTIVE)
    // failure isolation: 8453 untouched
    expect(s[8453].status).toBe(DEPLOY_STATUS.QUEUED)
  })
  it('a failure names its stage and retry re-enters queued for that network only', () => {
    let s = initialDeploymentState([137, 8453])
    s = deploymentReducer(s, { type: 'failed', chainId: 137, stage: DEPLOY_STAGE.SWITCH, reason: 'Wallet refused the switch to Polygon' })
    expect(s[137].status).toBe(DEPLOY_STATUS.FAILED)
    expect(s[137].stage).toBe('switch')
    expect(s[137].reason).toMatch(/Polygon/)
    s = deploymentReducer(s, { type: 'retry', chainId: 137 })
    expect(s[137].status).toBe(DEPLOY_STATUS.QUEUED)
    expect(s[8453].status).toBe(DEPLOY_STATUS.QUEUED)
  })
  it('already-live is success from a probe, not a failure', () => {
    let s = initialDeploymentState([137])
    s = deploymentReducer(s, { type: 'probed-live', chainId: 137 })
    expect(s[137].status).toBe(DEPLOY_STATUS.ALREADY_LIVE)
  })
  it('rules queued for co-owner approval is its own honest state', () => {
    let s = initialDeploymentState([137])
    s = deploymentReducer(s, { type: 'deployed', chainId: 137 })
    s = deploymentReducer(s, { type: 'rules-queued', chainId: 137 })
    expect(s[137].rulesStatus).toBe(RULES_STATUS.AWAITING_APPROVAL)
  })
})
