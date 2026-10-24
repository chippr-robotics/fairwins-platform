/**
 * Issue #1368 — a policy-guarded vault must never be handed a proposal its own guard is known to
 * revert.
 *
 * Both `SafePolicyGuard` (v1, `_checkPolicy`) and `SafePolicyGuardV2` (`_preCheck`) deny
 * `operation != 0` — but ONLY once the vault actually has a policy on that guard. A vault holding
 * the guard with no rules configured behaves exactly like an unguarded Safe, delegatecall
 * included. So "has a guard" is NOT the question; "would this guard deny a delegatecall from THIS
 * vault" is, and the only honest way to answer it is the guard's own `previewTransaction`.
 *
 * Three states, never two: a guard we cannot read is `unknown`, which on a money path is treated
 * like a denial (propose the per-action shape) but is DISCLOSED differently — "could not confirm"
 * is not "denied".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ZeroAddress, getAddress } from 'ethers'

const V2_GUARD = getAddress('0x0000000000000000000000000000000000000011')
const V1_GUARD = getAddress('0x0000000000000000000000000000000000000022')
const FOREIGN = getAddress('0x0000000000000000000000000000000000000033')
const VAULT = getAddress('0x1111111111111111111111111111111111111111')
const CHAIN = 137 // Polygon — has Safe contracts, so a MultiSendCallOnly probe target exists

const policy = {
  readVaultGuard: vi.fn(async () => ZeroAddress),
  getPolicyEngineAddresses: vi.fn(() => ({ guard: V1_GUARD, setup: FOREIGN })),
  previewPolicy: vi.fn(async () => ({ ok: true })),
}
const policyV2 = {
  getPolicyEngineV2Addresses: vi.fn(() => ({ guard: V2_GUARD, setup: FOREIGN })),
  previewPolicyV2: vi.fn(async () => ({ ok: true, reason: null })),
}

vi.mock('../../lib/custody/policy', () => ({
  readVaultGuard: (...a) => policy.readVaultGuard(...a),
  getPolicyEngineAddresses: (...a) => policy.getPolicyEngineAddresses(...a),
  previewPolicy: (...a) => policy.previewPolicy(...a),
}))
vi.mock('../../lib/custody/policyV2', () => ({
  getPolicyEngineV2Addresses: (...a) => policyV2.getPolicyEngineV2Addresses(...a),
  previewPolicyV2: (...a) => policyV2.previewPolicyV2(...a),
}))

import { BATCH_SUPPORT, DELEGATECALL, previewBatchSupport } from '../../lib/custody/batchPreflight'
import { getSafeContracts } from '../../config/safeContracts'

beforeEach(() => {
  vi.clearAllMocks()
  policy.readVaultGuard.mockResolvedValue(ZeroAddress)
  policy.getPolicyEngineAddresses.mockReturnValue({ guard: V1_GUARD, setup: FOREIGN })
  policy.previewPolicy.mockResolvedValue({ ok: true })
  policyV2.getPolicyEngineV2Addresses.mockReturnValue({ guard: V2_GUARD, setup: FOREIGN })
  policyV2.previewPolicyV2.mockResolvedValue({ ok: true, reason: null })
})

describe('previewBatchSupport — the three states', () => {
  it('a vault with NO guard batches, and no guard is read for an opinion', async () => {
    const res = await previewBatchSupport(VAULT, CHAIN)
    expect(res.support).toBe(BATCH_SUPPORT.OK)
    expect(res.engine).toBe('none')
    expect(res.reason).toBeNull()
    expect(policyV2.previewPolicyV2).not.toHaveBeenCalled()
    expect(policy.previewPolicy).not.toHaveBeenCalled()
  })

  it('a V2-guarded vault whose guard denies the delegatecall reports batch-denied', async () => {
    policy.readVaultGuard.mockResolvedValue(V2_GUARD)
    policyV2.previewPolicyV2.mockResolvedValue({
      ok: false,
      reason: { rule: null, code: 'delegatecall', message: 'Policy-managed vaults cannot run delegatecall batches.' },
    })
    const res = await previewBatchSupport(VAULT, CHAIN)
    expect(res.support).toBe(BATCH_SUPPORT.DENIED)
    expect(res.engine).toBe('v2')
    expect(res.reason).toMatch(/does not allow batched transactions/i)
    expect(res.detail).toMatch(/delegatecall/i)
  })

  it('asks the guard about a DELEGATECALL to the real MultiSendCallOnly address', async () => {
    policy.readVaultGuard.mockResolvedValue(V2_GUARD)
    await previewBatchSupport(VAULT, CHAIN)
    const [vault, chainId, payload] = policyV2.previewPolicyV2.mock.calls[0]
    expect(vault).toBe(VAULT)
    expect(chainId).toBe(CHAIN)
    expect(payload.operation).toBe(DELEGATECALL)
    expect(payload.to).toBe(getSafeContracts(CHAIN).multiSendCallOnly)
  })

  it('a V2-guarded vault with NO rules is exempt, so the batch is allowed (narrower than "guarded")', async () => {
    // _preCheck returns exempt when `_rules[safe].length == 0` — that vault behaves exactly like
    // an unguarded Safe, so refusing its batch would be a false statement about its policy.
    policy.readVaultGuard.mockResolvedValue(V2_GUARD)
    policyV2.previewPolicyV2.mockResolvedValue({ ok: true, reason: null })
    const res = await previewBatchSupport(VAULT, CHAIN)
    expect(res.support).toBe(BATCH_SUPPORT.OK)
    expect(res.engine).toBe('v2')
  })

  it('a v1-guarded vault is read through the v1 guard, and a denial is a denial there too', async () => {
    policy.readVaultGuard.mockResolvedValue(V1_GUARD)
    policy.previewPolicy.mockResolvedValue({
      ok: false,
      violation: { rule: 'delegatecall', message: 'Blocked by the vault policy' },
    })
    const res = await previewBatchSupport(VAULT, CHAIN)
    expect(res.support).toBe(BATCH_SUPPORT.DENIED)
    expect(res.engine).toBe('v1')
    expect(policyV2.previewPolicyV2).not.toHaveBeenCalled()
    const [, , payload] = policy.previewPolicy.mock.calls[0]
    expect(payload.operation).toBe(DELEGATECALL)
  })

  it('a v1-guarded vault with no policy configured still batches', async () => {
    policy.readVaultGuard.mockResolvedValue(V1_GUARD)
    policy.previewPolicy.mockResolvedValue({ ok: true })
    expect((await previewBatchSupport(VAULT, CHAIN)).support).toBe(BATCH_SUPPORT.OK)
  })

  it('a guard slot that cannot be read is UNKNOWN — never silently ok, never silently denied', async () => {
    policy.readVaultGuard.mockRejectedValue(new Error('rpc timeout'))
    const res = await previewBatchSupport(VAULT, CHAIN)
    expect(res.support).toBe(BATCH_SUPPORT.UNKNOWN)
    expect(res.reason).toMatch(/could not confirm/i)
  })

  it('a guard read that throws mid-preview is UNKNOWN, not a denial', async () => {
    policy.readVaultGuard.mockResolvedValue(V2_GUARD)
    policyV2.previewPolicyV2.mockRejectedValue(new Error('rpc timeout'))
    const res = await previewBatchSupport(VAULT, CHAIN)
    expect(res.support).toBe(BATCH_SUPPORT.UNKNOWN)
  })

  it('a guard this app does not recognise is UNKNOWN — we cannot speak for somebody else’s guard', async () => {
    policy.readVaultGuard.mockResolvedValue(FOREIGN)
    const res = await previewBatchSupport(VAULT, CHAIN)
    expect(res.support).toBe(BATCH_SUPPORT.UNKNOWN)
    expect(res.engine).toBe('foreign')
    expect(res.reason).toMatch(/could not confirm/i)
  })

  it('a chain with no Safe contracts cannot be probed, so it is UNKNOWN', async () => {
    policy.readVaultGuard.mockResolvedValue(V2_GUARD)
    const res = await previewBatchSupport(VAULT, 1)
    expect(res.support).toBe(BATCH_SUPPORT.UNKNOWN)
  })

  it('a missing vault address is UNKNOWN and reads nothing', async () => {
    const res = await previewBatchSupport(null, CHAIN)
    expect(res.support).toBe(BATCH_SUPPORT.UNKNOWN)
    expect(policy.readVaultGuard).not.toHaveBeenCalled()
  })
})
