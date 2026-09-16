/**
 * Membership belongs to an ADDRESS, so it must be read for the account the member is ACTING AS.
 *
 * The regression: `useRoleDetails` resolved its address from wagmi's `useAccount()` — the
 * CONNECTED wallet. Switching the acting account (multisig vault, recovered account, hardware
 * account) left the membership card showing the connected wallet's tier and expiry. A member
 * operating as a vault saw "GOLD" over an account that held nothing.
 *
 * It is not a cosmetic mismatch. `MembershipManager.purchaseTier` credits `msg.sender` and takes
 * no beneficiary, and every gated action — creating a wager, registering a callsign — is sent BY
 * the acting account, so the contract checks the acting account's membership. The card was
 * claiming an entitlement the chain would refuse.
 *
 * Fixing this could not be done in WalletContext: `CustodyProvider` nests INSIDE `WalletProvider`,
 * so the context that knows the acting account is invisible from the one that loads roles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const CONNECTED = '0x4402000000000000000000000000000000008eC5'
const ACTING = '0x1215000000000000000000000000000000008575'

const m = vi.hoisted(() => ({
  /** Every address getMembership() is asked about, in order. */
  asked: [],
  effective: null,
}))

// A MembershipManager that answers GOLD for the CONNECTED wallet and nothing for the acting one,
// so a hook reading the wrong address produces a visibly wrong tier rather than a subtle one.
// The membership reads ride the spec-110 chain seam — what is asserted below is WHICH ACCOUNT
// was asked about, which the seam carries as the read's first argument exactly as before.
vi.mock('../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args = [] }) => {
      if (functionName === 'getMembership') {
        const user = args[0]
        m.asked.push(String(user))
        const gold = String(user).toLowerCase() === CONNECTED.toLowerCase()
        return {
          tier: gold ? 3n : 0n,
          expiresAt: gold ? BigInt(Math.floor(Date.now() / 1000) + 86_400) : 0n,
          activeCount: 0n,
          monthAnchor: 0n,
          monthCount: 0n,
        }
      }
      if (functionName === 'getTierConfig') {
        return { limits: { monthlyMarketCreation: 100n, maxConcurrentMarkets: 30n } }
      }
      throw new Error('unmocked membership read: ' + functionName)
    },
  }
})

vi.mock('../hooks/useWeb3', () => ({
  useWeb3: () => ({ chainId: 80002, provider: { ok: true }, isConnected: true, account: CONNECTED }),
}))
vi.mock('../hooks/useEffectiveAccount', () => ({ useEffectiveAccount: () => m.effective }))

import { useRoleDetails } from '../hooks/useRoleDetails'

const personal = () => ({
  address: CONNECTED,
  isActingAccount: false,
  type: 'personal',
  label: null,
  connectedAddress: CONNECTED,
  chainId: null,
})
const actingAsVault = () => ({
  address: ACTING,
  isActingAccount: true,
  type: 'vault',
  label: 'Ops vault',
  connectedAddress: CONNECTED,
  chainId: 80002,
})

beforeEach(() => {
  m.asked = []
  m.effective = personal()
})

describe('useRoleDetails reads the acting account', () => {
  it('asks about the connected wallet while acting as yourself', async () => {
    const { result } = renderHook(() => useRoleDetails())
    await waitFor(() => expect(result.current.getRoleDetails('WAGER_PARTICIPANT')).toBeTruthy())
    expect(m.asked.map((a) => a.toLowerCase())).toContain(CONNECTED.toLowerCase())
    expect(result.current.getRoleDetails('WAGER_PARTICIPANT').tierName).toBe('Gold')
  })

  it('asks about the ACTING account — never the connected wallet — once one is selected', async () => {
    m.effective = actingAsVault()
    const { result } = renderHook(() => useRoleDetails())
    await waitFor(() => expect(result.current.getRoleDetails('WAGER_PARTICIPANT')).toBeTruthy())

    // The whole bug in one assertion: the connected wallet must never be the address asked about
    // when the member is operating as somebody else.
    expect(m.asked.map((a) => a.toLowerCase())).toContain(ACTING.toLowerCase())
    expect(m.asked.map((a) => a.toLowerCase())).not.toContain(CONNECTED.toLowerCase())
  })

  it('reports the acting account’s real membership, not the connected wallet’s tier', async () => {
    m.effective = actingAsVault()
    const { result } = renderHook(() => useRoleDetails())
    await waitFor(() => expect(result.current.getRoleDetails('WAGER_PARTICIPANT')).toBeTruthy())

    const d = result.current.getRoleDetails('WAGER_PARTICIPANT')
    // Before the fix this read Gold/active — the connected wallet's membership under the vault's
    // name, which is exactly what the member reported seeing.
    expect(d.tierName).toBe('None')
    expect(d.isActive).toBe(false)
    expect(d.hasRole).toBe(false)
  })

  it('re-reads when the acting account changes, rather than keeping the previous answer', async () => {
    const { result, rerender } = renderHook(() => useRoleDetails())
    await waitFor(() =>
      expect(result.current.getRoleDetails('WAGER_PARTICIPANT')?.tierName).toBe('Gold'),
    )

    m.effective = actingAsVault()
    rerender()

    // Switching accounts must move the card. A hook keyed on the connected address never
    // re-fires, which is why the stale Gold persisted across a switch.
    await waitFor(() =>
      expect(result.current.getRoleDetails('WAGER_PARTICIPANT')?.tierName).toBe('None'),
    )
  })
})
