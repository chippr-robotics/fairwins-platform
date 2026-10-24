import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

// Mock the services the hook depends on so we drive the wallet sequence
// deterministically without any chain calls (spec 022).
vi.mock('../utils/blockchainService', () => ({
  purchaseRoleWithStablecoin: vi.fn(),
  checkApprovalNeeded: vi.fn(),
  checkApprovalNeededForAddress: vi.fn(),
  resolveMembershipIntentParams: vi.fn(),
}))
vi.mock('../utils/keyRegistryService', () => ({
  ensureKeyRegistered: vi.fn(),
}))

// Spec 098 — capture the config each gasless write is wired with, so the acting-signer
// binding (FR-007: cfg.signer getter must resolve to the ACTING signer) is assertable.
const gasless = vi.hoisted(() => ({ cfgs: {} }))

// Specs 035 + 036: the hook now routes the pay through useGaslessWrite. With no relayer configured
// (test default) the real seam self-submits anyway, but useGaslessWrite calls useWeb3() which throws
// outside a WalletProvider — so mock it to run the caller's selfSubmit directly. selfSubmit is the
// existing purchaseFn (approve+pay) call, so the step-machine assertions are unchanged. The
// self-submit leg returns errors in `result.error` (never throws), matching useIntentAction.
vi.mock('../lib/relay/useGaslessWrite', () => ({
  useGaslessWrite: (action, cfg) => {
    gasless.cfgs[action] = cfg
    return {
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
    }
  },
}))

import { usePurchaseFlow } from '../hooks/usePurchaseFlow'
import { purchaseRoleWithStablecoin, checkApprovalNeeded, checkApprovalNeededForAddress, resolveMembershipIntentParams } from '../utils/blockchainService'
import { ensureKeyRegistered } from '../utils/keyRegistryService'

// A resolved intent-params object; its exact contents don't matter to the step machine (the mocked
// gasless seam forwards straight to selfSubmit), only that it resolves so the purchase segment proceeds.
const INTENT_PARAMS = {
  roleHash: '0x' + '11'.repeat(32),
  validTier: 1,
  price: 2000000n,
  acceptedTermsHash: '0x' + '00'.repeat(32),
}

const baseParams = (overrides = {}) => ({
  signer: { getAddress: async () => '0xabc' },
  account: '0xabc',
  roleName: 'WAGER_PARTICIPANT',
  priceUSD: 2,
  tier: 1,
  action: 'purchase',
  termsHash: null,
  ensureInitialized: vi.fn(async () => ({ publicKey: new Uint8Array([1, 2, 3]) })),
  onPaid: vi.fn(async () => {}),
  ...overrides,
})

describe('usePurchaseFlow — step list construction (FR-009)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveMembershipIntentParams.mockResolvedValue(INTENT_PARAMS)
    purchaseRoleWithStablecoin.mockResolvedValue({ hash: '0xpay' })
    ensureKeyRegistered.mockResolvedValue(true)
  })

  it('includes the approve step when allowance is insufficient', async () => {
    checkApprovalNeeded.mockResolvedValue(true)
    const { result } = renderHook(() => usePurchaseFlow())

    await act(async () => { await result.current.start(baseParams()) })

    const ids = result.current.steps.map((s) => s.id)
    expect(ids).toEqual(['approve', 'pay', 'sign', 'register'])
    expect(result.current.total).toBe(4)
  })

  it('OMITS the approve step entirely when allowance already covers the price', async () => {
    checkApprovalNeeded.mockResolvedValue(false)
    const { result } = renderHook(() => usePurchaseFlow())

    await act(async () => { await result.current.start(baseParams()) })

    const ids = result.current.steps.map((s) => s.id)
    expect(ids).toEqual(['pay', 'sign', 'register'])
    expect(result.current.total).toBe(3)
  })

  it('marks signature vs transaction kinds correctly', async () => {
    checkApprovalNeeded.mockResolvedValue(true)
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(baseParams()) })

    const byId = Object.fromEntries(result.current.steps.map((s) => [s.id, s]))
    expect(byId.approve.kind).toBe('transaction')
    expect(byId.pay.kind).toBe('transaction')
    expect(byId.sign.kind).toBe('signature')
    expect(byId.register.kind).toBe('transaction')
    expect(byId.sign.blocking).toBe(false)
    expect(byId.pay.blocking).toBe(true)
  })
})

describe('usePurchaseFlow — happy path & progress (US2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveMembershipIntentParams.mockResolvedValue(INTENT_PARAMS)
    checkApprovalNeeded.mockResolvedValue(false)
    ensureKeyRegistered.mockResolvedValue(true)
  })

  it('drives approve/pay step state from onProgress events and completes', async () => {
    purchaseRoleWithStablecoin.mockImplementation(async (...args) => {
      const onProgress = args[6]
      onProgress({ step: 'pay', phase: 'start' })
      onProgress({ step: 'pay', phase: 'sent', txHash: '0xp' })
      onProgress({ step: 'pay', phase: 'confirmed', txHash: '0xp' })
      return { hash: '0xp' }
    })
    const params = baseParams()
    const { result } = renderHook(() => usePurchaseFlow())

    await act(async () => { await result.current.start(params) })

    expect(result.current.status).toBe('succeeded')
    expect(result.current.steps.every((s) => s.state === 'completed')).toBe(true)
    expect(result.current.completedCount).toBe(3)
    expect(result.current.progressFraction).toBe(1)
    expect(result.current.keyRegOutcome).toBe('success')
    expect(params.onPaid).toHaveBeenCalledTimes(1)
  })

  it('reports skipped key registration as "skipped"', async () => {
    purchaseRoleWithStablecoin.mockResolvedValue({ hash: '0xp' })
    ensureKeyRegistered.mockResolvedValue(false)
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(baseParams()) })
    expect(result.current.keyRegOutcome).toBe('skipped')
  })
})

describe('usePurchaseFlow — failure attribution & recovery (US3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveMembershipIntentParams.mockResolvedValue(INTENT_PARAMS)
    checkApprovalNeeded.mockResolvedValue(false)
  })

  it('attributes a payment rejection to the pay step with a reason (FR-007)', async () => {
    purchaseRoleWithStablecoin.mockImplementation(async (...args) => {
      const onProgress = args[6]
      onProgress({ step: 'pay', phase: 'start' })
      throw new Error('Transaction rejected by user')
    })
    const { result } = renderHook(() => usePurchaseFlow())

    await act(async () => { await result.current.start(baseParams()) })

    expect(result.current.status).toBe('failed')
    const pay = result.current.steps.find((s) => s.id === 'pay')
    expect(pay.state).toBe('failed')
    expect(pay.failureReason).toMatch(/rejected/i)
    // Non-blocking continue must NOT be offered for a blocking pay failure.
    expect(result.current.canContinueAnyway).toBe(false)
  })

  it('retry after a key-registration failure does NOT re-run payment (FR-008)', async () => {
    purchaseRoleWithStablecoin.mockResolvedValue({ hash: '0xp' })
    const ensureInitialized = vi.fn(async () => ({ publicKey: new Uint8Array([9]) }))
    ensureKeyRegistered
      .mockRejectedValueOnce(new Error('register boom'))
      .mockResolvedValueOnce(true)

    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(baseParams({ ensureInitialized })) })

    expect(result.current.status).toBe('failed')
    const reg = result.current.steps.find((s) => s.id === 'register')
    expect(reg.state).toBe('failed')
    expect(result.current.canContinueAnyway).toBe(true) // register is non-blocking

    await act(async () => { await result.current.retry() })

    expect(result.current.status).toBe('succeeded')
    // Payment ran exactly once across the initial attempt + retry.
    expect(purchaseRoleWithStablecoin).toHaveBeenCalledTimes(1)
    // The encryption signature was not re-requested (sign already completed).
    expect(ensureInitialized).toHaveBeenCalledTimes(1)
    expect(ensureKeyRegistered).toHaveBeenCalledTimes(2)
  })

  it('continueAnyway finalizes a non-blocking key failure as success (FR-010)', async () => {
    purchaseRoleWithStablecoin.mockResolvedValue({ hash: '0xp' })
    ensureKeyRegistered.mockRejectedValue(new Error('register boom'))
    const { result } = renderHook(() => usePurchaseFlow())

    await act(async () => { await result.current.start(baseParams()) })
    expect(result.current.status).toBe('failed')

    await act(async () => { result.current.continueAnyway() })

    await waitFor(() => expect(result.current.status).toBe('succeeded'))
    expect(result.current.keyRegOutcome).toBe('failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Spec 098 — purchase as the ACTING account.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ACTING_ADDR = '0x1215000000000000000000000000000000008575'

const actingClassicParams = (overrides = {}) => {
  const actingSigner = { getAddress: async () => ACTING_ADDR, __acting: true }
  return {
    actingSigner,
    params: {
      signer: null,
      account: ACTING_ADDR,
      acting: { kind: 'legacy', address: ACTING_ADDR, label: 'Recovered account' },
      getActingSigner: vi.fn(async () => actingSigner),
      roleName: 'WAGER_PARTICIPANT',
      priceUSD: 2,
      tier: 1,
      action: 'purchase',
      termsHash: null,
      ensureInitialized: vi.fn(async () => ({ publicKey: new Uint8Array([1, 2, 3]) })),
      onPaid: vi.fn(async () => {}),
      ...overrides,
    },
  }
}

describe('usePurchaseFlow — acting classic rail (spec 098 FR-004/FR-007/FR-015)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gasless.cfgs = {}
    resolveMembershipIntentParams.mockResolvedValue(INTENT_PARAMS)
    purchaseRoleWithStablecoin.mockResolvedValue({ hash: '0xpay' })
    ensureKeyRegistered.mockResolvedValue(true)
    checkApprovalNeededForAddress.mockResolvedValue(true)
  })

  it('pre-flights allowance for the ACTING address, never the signer', async () => {
    const { params } = actingClassicParams()
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })

    expect(checkApprovalNeededForAddress).toHaveBeenCalledTimes(1)
    expect(checkApprovalNeededForAddress.mock.calls[0][0]).toBe(ACTING_ADDR)
    expect(checkApprovalNeeded).not.toHaveBeenCalled()
    expect(result.current.steps.map((s) => s.id)).toEqual(['approve', 'pay', 'sign', 'register'])
  })

  it('omits the approve step when the acting account already holds allowance (FR-015)', async () => {
    checkApprovalNeededForAddress.mockResolvedValue(false)
    const { params } = actingClassicParams()
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })
    expect(result.current.steps.map((s) => s.id)).toEqual(['pay', 'sign', 'register'])
  })

  it('runs the ceremony ONCE at confirm time and every purchase/sign/register call uses the acting signer', async () => {
    const { params, actingSigner } = actingClassicParams()
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })

    expect(result.current.status).toBe('succeeded')
    // One ceremony serves the whole flow.
    expect(params.getActingSigner).toHaveBeenCalledTimes(1)
    // approve+pay were signed by the acting signer, not the (null) connected one.
    expect(purchaseRoleWithStablecoin.mock.calls[0][0]).toBe(actingSigner)
    // intent params resolved against the acting signer (its address decides the upgrade basis).
    expect(resolveMembershipIntentParams.mock.calls[0][0]).toBe(actingSigner)
    // key derivation was offered THROUGH the acting signer (FR-012).
    expect(params.ensureInitialized.mock.calls[0][0]).toBe(actingSigner)
    // key registration signs as the acting account.
    expect(ensureKeyRegistered.mock.calls[0][0]).toBe(actingSigner)
    expect(ensureKeyRegistered.mock.calls[0][1]).toBe(ACTING_ADDR)
    // FR-007: the gasless seam's signer override resolves to the acting signer — the relayed
    // rail can never fall back to the connected wallet while acting.
    expect(gasless.cfgs.purchaseTier.signer()).toBe(actingSigner)
  })

  it('refuses when the ceremony hands back a signer for a DIFFERENT address (SC-003)', async () => {
    const wrong = { getAddress: async () => '0x00000000000000000000000000000000DeaDBeef' }
    const { params } = actingClassicParams({ getActingSigner: vi.fn(async () => wrong) })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })

    expect(result.current.status).toBe('failed')
    expect(purchaseRoleWithStablecoin).not.toHaveBeenCalled()
    const failed = result.current.steps.find((s) => s.state === 'failed')
    expect(failed.failureReason).toMatch(/acting account/i)
  })

  it('a dismissed ceremony fails the step with the stated reason, nothing signed; Retry re-offers it', async () => {
    const getActingSigner = vi.fn()
      .mockRejectedValueOnce(new Error('Signing was cancelled.'))
      .mockResolvedValueOnce({ getAddress: async () => ACTING_ADDR })
    const { params } = actingClassicParams({ getActingSigner })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })

    expect(result.current.status).toBe('failed')
    expect(purchaseRoleWithStablecoin).not.toHaveBeenCalled()
    const failed = result.current.steps.find((s) => s.state === 'failed')
    expect(failed.failureReason).toMatch(/cancelled/i)

    await act(async () => { await result.current.retry() })
    expect(getActingSigner).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('succeeded')
  })
})

describe('usePurchaseFlow — vault proposal rail (spec 098 FR-005/FR-012/FR-014)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gasless.cfgs = {}
    resolveMembershipIntentParams.mockResolvedValue(INTENT_PARAMS)
    ensureKeyRegistered.mockResolvedValue(true)
  })

  const vaultParams = (overrides = {}) => ({
    signer: null,
    account: ACTING_ADDR,
    acting: { kind: 'vault', address: ACTING_ADDR, chainId: 80002, label: 'Ops vault' },
    roleName: 'WAGER_PARTICIPANT',
    priceUSD: 2,
    tier: 1,
    action: 'purchase',
    termsHash: null,
    proposePurchase: vi.fn(async () => ({ kind: 'proposed', safeTxHash: '0xsafehash' })),
    onPaid: vi.fn(async () => {}),
    ...overrides,
  })

  it('terminal state is PROPOSED — never paid/succeeded — and key steps are skipped with disclosure', async () => {
    const params = vaultParams()
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })

    expect(result.current.status).toBe('proposed')
    expect(params.proposePurchase).toHaveBeenCalledTimes(1)
    expect(result.current.steps.map((s) => s.id)).toEqual(['propose', 'sign', 'register'])
    expect(result.current.steps.find((s) => s.id === 'propose').state).toBe('completed')
    // FR-012: a Safe cannot sign a key-derivation message — skipped, honestly, not failed.
    expect(result.current.steps.find((s) => s.id === 'sign').state).toBe('skipped')
    expect(result.current.steps.find((s) => s.id === 'register').state).toBe('skipped')
    expect(result.current.keyRegOutcome).toBe('unavailable')
    expect(result.current.purchaseReceipt?.safeTxHash).toBe('0xsafehash')
    // Nothing was paid: no onPaid side effects, no signer purchase, no key registration.
    expect(params.onPaid).not.toHaveBeenCalled()
    expect(purchaseRoleWithStablecoin).not.toHaveBeenCalled()
    expect(ensureKeyRegistered).not.toHaveBeenCalled()
  })

  // Issue #1368 — a policy-guarded vault cannot execute a MultiSend, so the purchase is proposed
  // as TWO transactions. The step the member watches must not claim they are "together".
  it('the propose step says TWO proposals when the vault’s policy forces a split', async () => {
    const params = vaultParams({ proposalShape: 'split' })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })
    const propose = result.current.steps.find((s) => s.id === 'propose')
    expect(propose.detail).toMatch(/two/i)
    expect(propose.detail).not.toMatch(/together/i)
  })

  it('the propose step copy is unchanged for a vault that can batch', async () => {
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(vaultParams()) })
    expect(result.current.steps.find((s) => s.id === 'propose').detail).toMatch(/together/i)
  })

  it('a failed proposal fails the propose step and is retryable', async () => {
    const params = vaultParams({
      proposePurchase: vi.fn()
        .mockRejectedValueOnce(new Error("Wallet is not connected to the vault's network"))
        .mockResolvedValueOnce({ kind: 'proposed', safeTxHash: '0xsafehash' }),
    })
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })

    expect(result.current.status).toBe('failed')
    expect(result.current.steps.find((s) => s.id === 'propose').state).toBe('failed')

    await act(async () => { await result.current.retry() })
    expect(result.current.status).toBe('proposed')
  })
})

describe('usePurchaseFlow — the identity is bound at confirm (spec 098 FR-013)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gasless.cfgs = {}
    resolveMembershipIntentParams.mockResolvedValue(INTENT_PARAMS)
    purchaseRoleWithStablecoin.mockResolvedValue({ hash: '0xpay' })
    checkApprovalNeededForAddress.mockResolvedValue(false)
  })

  it('invalidateIdentity fails the flow with the stated reason and retry refuses to run again', async () => {
    ensureKeyRegistered.mockRejectedValue(new Error('register boom'))
    const { params } = actingClassicParams()
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { await result.current.start(params) })
    expect(result.current.status).toBe('failed') // register failed, would normally be retryable

    await act(async () => { result.current.invalidateIdentity('The acting account changed mid-purchase.') })
    expect(result.current.status).toBe('failed')

    await act(async () => { await result.current.retry() })
    // FR-013: no later step may run under the new identity — register was NOT retried.
    expect(ensureKeyRegistered).toHaveBeenCalledTimes(1)
    expect(result.current.status).toBe('failed')
  })

  it('a fresh start() after reset clears the invalidation', async () => {
    ensureKeyRegistered.mockResolvedValue(true)
    const { params } = actingClassicParams()
    const { result } = renderHook(() => usePurchaseFlow())
    await act(async () => { result.current.invalidateIdentity('changed') })
    await act(async () => { result.current.reset() })
    await act(async () => { await result.current.start(params) })
    expect(result.current.status).toBe('succeeded')
  })
})
