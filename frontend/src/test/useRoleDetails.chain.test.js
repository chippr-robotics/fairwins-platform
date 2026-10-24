import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// ── WHAT THIS GUARDS, AND WHY IT CHANGED ────────────────────────────────────────────────────
// Spec 008 pinned membership/role details to the WALLET's connected chain: the address used to be
// build-bound while the provider was the wallet's, a mismatch that could read a membership on the
// wrong network.
//
// Spec 071 (FR-003) supersedes that. Membership lives in exactly one place per environment cohort,
// so both the address AND the provider come from the REFERENCE chain and therefore still cannot
// disagree — the original mismatch stays fixed, by a stronger rule.
//
// The old version of this test mocked the wallet onto chain 80002 and asserted the resolver was
// called with 80002. In a testnet build 80002 IS the reference chain, so that assertion passed
// whichever chain the code actually used — it could not fail. The wallet is now deliberately put
// on a DIFFERENT cohort chain so the two answers are distinguishable.
const { resolver, web3, referenceChainId } = vi.hoisted(() => ({
  resolver: vi.fn(() => undefined),
  // Mordor (63): a real cohort chain, and NOT the reference chain (Amoy 80002).
  web3: { chainId: 63, provider: { ok: true }, switchNetwork: () => {}, account: '0xabc', isConnected: true },
  referenceChainId: 80002,
}))

vi.mock('../config/contracts', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getContractAddressForChain: resolver }
})
vi.mock('../hooks/useWeb3', () => ({ useWeb3: () => web3 }))
// The address now comes from the ACTING account (see useRoleDetails' header), not wagmi's
// connected one. This suite is about WHICH CHAIN, so it pins a single account and says nothing
// about which one — `membershipActingAccount.test.jsx` is the suite that covers that.
vi.mock('../hooks/useEffectiveAccount', () => ({
  useEffectiveAccount: () => ({
    address: '0x0000000000000000000000000000000000000abc',
    isActingAccount: false,
    type: 'personal',
    label: null,
    connectedAddress: '0x0000000000000000000000000000000000000abc',
    chainId: null,
  }),
}))

import { useRoleDetails } from '../hooks/useRoleDetails'
import { membershipChainId } from '../config/networks'

describe('useRoleDetails — membership resolves on the reference chain (spec 071 FR-003)', () => {
  beforeEach(() => resolver.mockClear())

  it('the fixture is meaningful: the wallet is NOT on the reference chain', () => {
    expect(membershipChainId()).toBe(referenceChainId)
    expect(web3.chainId).not.toBe(membershipChainId())
  })

  it('resolves membershipManager for the reference chain, not the connected one', async () => {
    renderHook(() => useRoleDetails())
    await waitFor(() =>
      expect(resolver).toHaveBeenCalledWith('membershipManager', membershipChainId())
    )
    // The failure this replaces: a member connected anywhere other than the reference chain saw
    // tier None with no expiry, because the lookup found no MembershipManager on their chain.
    expect(resolver).not.toHaveBeenCalledWith('membershipManager', web3.chainId)
  })
})
