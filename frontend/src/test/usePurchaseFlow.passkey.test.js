/**
 * Spec 041 T034 — passkey branches of usePurchaseFlow:
 *  - batchPurchase: approve+pay collapse into ONE 'pay' step (FR-016), the
 *    approvalCheck (an EOA-signer concern) is never consulted;
 *  - EncryptionUnavailable during 'sign' degrades honestly: membership stays
 *    purchased, sign/register are marked skipped with the reason, overall
 *    status is 'succeeded' (clarification Q1);
 *  - cancel mid-ceremony (batchPurchase throws CeremonyCancelled) = clean
 *    failed 'pay' step, nothing marked complete, retry-able.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../utils/blockchainService', () => ({
  purchaseRoleWithStablecoin: vi.fn(),
  checkApprovalNeeded: vi.fn(),
  // Spec 098 — the acting-account allowance pre-flight. Declared so the hook can import it; the
  // passkey batch path must never CALL it (the batch carries its own approve leg), which the
  // assertion below pins.
  checkApprovalNeededForAddress: vi.fn(),
  resolveMembershipIntentParams: vi.fn().mockResolvedValue({ roleHash: '0xrole', validTier: 1, price: 0n, acceptedTermsHash: '0x0' }),
}))
vi.mock('../utils/keyRegistryService', () => ({
  ensureKeyRegistered: vi.fn(),
}))

// Specs 035 + 036 (merged from main): usePurchaseFlow now calls useGaslessWrite at the top, which
// calls useWeb3() and throws outside a WalletProvider. The passkey batch path never uses this seam
// (batchPurchase short-circuits it), so a minimal stub that forwards run()→selfSubmit is enough to
// let the hook render. Matches useIntentAction: run() returns {error} rather than throwing.
vi.mock('../lib/relay/useGaslessWrite', () => ({
  useGaslessWrite: (_action, cfg) => ({
    run: async (...args) => {
      try {
        const receipt = await cfg.selfSubmit(...args)
        return { via: 'self-submit', receipt, txHash: receipt?.hash ?? receipt?.transactionHash }
      } catch (error) {
        return { via: 'self-submit', error }
      }
    },
    status: 'idle', intent: null, result: null, error: null,
    invalidate: vi.fn(), selfSubmitNow: vi.fn(), reset: vi.fn(),
  }),
}))

import { usePurchaseFlow } from '../hooks/usePurchaseFlow'
import { purchaseRoleWithStablecoin, checkApprovalNeeded, checkApprovalNeededForAddress } from '../utils/blockchainService'
import { ensureKeyRegistered } from '../utils/keyRegistryService'

const passkeyParams = (overrides = {}) => ({
  signer: { getAddress: async () => '0xacc' },
  account: '0xacc',
  roleName: 'WAGER_PARTICIPANT',
  priceUSD: 50,
  tier: 1,
  action: 'purchase',
  termsHash: null,
  batchPurchase: vi.fn(async () => ({ txHash: '0xbatch', route: 'userop' })),
  ensureInitialized: vi.fn(async () => ({ publicKey: new Uint8Array([1]) })),
  onPaid: vi.fn(async () => {}),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  ensureKeyRegistered.mockResolvedValue(true)
})

describe('usePurchaseFlow — passkey batch path (spec 041)', () => {
  it('runs approve+pay as ONE step and never consults the EOA approval check', async () => {
    const params = passkeyParams()
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => {
      await result.current.start(params)
    })

    expect(result.current.status).toBe('succeeded')
    expect(result.current.steps.map((s) => s.id)).toEqual(['pay', 'sign', 'register'])
    expect(result.current.steps.find((s) => s.id === 'pay').state).toBe('completed')
    expect(result.current.steps.find((s) => s.id === 'pay').txHash).toBe('0xbatch')
    expect(params.batchPurchase).toHaveBeenCalledTimes(1)
    expect(checkApprovalNeeded).not.toHaveBeenCalled()
    // Spec 098 FR-006: the batch rail is personal-only and carries its own approve leg — neither
    // allowance pre-flight is an input to it.
    expect(checkApprovalNeededForAddress).not.toHaveBeenCalled()
    expect(purchaseRoleWithStablecoin).not.toHaveBeenCalled()
    expect(params.onPaid).toHaveBeenCalledTimes(1)
  })

  it('degrades honestly when the authenticator lacks PRF: purchase succeeds, sign/register skipped', async () => {
    const unavailable = Object.assign(new Error('no deterministic key material (PRF unsupported)'), {
      name: 'EncryptionUnavailable',
    })
    const params = passkeyParams({ ensureInitialized: vi.fn(async () => { throw unavailable }) })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => {
      await result.current.start(params)
    })

    expect(result.current.status).toBe('succeeded') // membership is real
    const sign = result.current.steps.find((s) => s.id === 'sign')
    const register = result.current.steps.find((s) => s.id === 'register')
    expect(sign.state).toBe('skipped')
    expect(sign.failureReason).toMatch(/PRF/i)
    expect(register.state).toBe('skipped')
    expect(result.current.keyRegOutcome).toBe('unavailable')
    expect(ensureKeyRegistered).not.toHaveBeenCalled() // never registers keys it doesn't have
  })

  it('cancelled ceremony mid-batch = clean failed pay step, nothing completed', async () => {
    const cancelled = Object.assign(new Error('Passkey prompt was cancelled'), { name: 'CeremonyCancelled' })
    const params = passkeyParams({ batchPurchase: vi.fn(async () => { throw cancelled }) })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => {
      await result.current.start(params)
    })

    expect(result.current.status).toBe('failed')
    const pay = result.current.steps.find((s) => s.id === 'pay')
    expect(pay.state).toBe('failed')
    expect(pay.failureReason).toMatch(/cancelled/i)
    expect(result.current.steps.some((s) => s.state === 'completed')).toBe(false)
    expect(params.onPaid).not.toHaveBeenCalled()
  })

  it('a non-PRF failure in sign still fails loudly (only EncryptionUnavailable degrades)', async () => {
    const params = passkeyParams({ ensureInitialized: vi.fn(async () => { throw new Error('boom') }) })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => {
      await result.current.start(params)
    })
    expect(result.current.status).toBe('failed')
    expect(result.current.steps.find((s) => s.id === 'sign').state).toBe('failed')
  })

  it('registers the derived key through the passkey registerKey closure (not the signer service)', async () => {
    const registerKey = vi.fn(async () => true)
    const params = passkeyParams({ registerKey })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => {
      await result.current.start(params)
    })

    expect(result.current.status).toBe('succeeded')
    expect(result.current.steps.find((s) => s.id === 'register').state).toBe('completed')
    // The publicKey derived in the sign step is what gets published on-chain.
    expect(registerKey).toHaveBeenCalledTimes(1)
    expect(registerKey.mock.calls[0][0]).toBeInstanceOf(Uint8Array)
    expect(ensureKeyRegistered).not.toHaveBeenCalled() // signer path is bypassed for passkey
    expect(result.current.keyRegOutcome).toBe('success')
  })

  it('a failed passkey registerKey surfaces as a non-blocking register failure (membership stays active)', async () => {
    const registerKey = vi.fn(async () => { throw new Error('user cancelled the key ceremony') })
    const params = passkeyParams({ registerKey })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => {
      await result.current.start(params)
    })

    expect(result.current.status).toBe('failed')
    const register = result.current.steps.find((s) => s.id === 'register')
    expect(register.state).toBe('failed')
    expect(register.blocking).toBe(false) // Continue anyway is offered — the membership is real
    expect(result.current.canContinueAnyway).toBe(true)
    expect(params.onPaid).toHaveBeenCalledTimes(1) // payment already succeeded
  })
})
