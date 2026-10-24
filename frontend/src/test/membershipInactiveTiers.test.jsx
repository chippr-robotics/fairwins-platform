/**
 * Inactive tiers must never be offered (production incident, 2026-08-26).
 *
 * The live Polygon MembershipManager had WAGER_PARTICIPANT Bronze and Platinum configured with
 * `active: false`, while Silver and Gold were active. Both purchase surfaces listed all four and
 * DEFAULTED the selection to Bronze — so a member picked a tier the contract refuses, approved
 * 2 USDC, and `purchaseTierWithTerms` reverted `TierInactive()` (0x4ed1bf50) with the approval
 * already on chain. `useTierPrices` did read `active`, and exposed `isTierActive`, but it
 * answered `?? true` for an unknown tier and NO caller consumed it.
 *
 * The rule these pin: a DEFINITE `active === false` is hidden; an UNREAD tier stays offered (an
 * RPC blip must not empty the grid — the contract remains the real gate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

// The production configuration verbatim: Bronze/Platinum off, Silver/Gold on.
const LIVE_TIERS = {
  1: { priceUSDC: 2_000_000n, durationDays: 30, active: false, limits: { monthlyMarketCreation: 15, maxConcurrentMarkets: 5 } },
  2: { priceUSDC: 8_000_000n, durationDays: 30, active: true, limits: { monthlyMarketCreation: 30, maxConcurrentMarkets: 10 } },
  3: { priceUSDC: 25_000_000n, durationDays: 30, active: true, limits: { monthlyMarketCreation: 100, maxConcurrentMarkets: 30 } },
  4: { priceUSDC: 2_000_000n, durationDays: 30, active: false, limits: { monthlyMarketCreation: 15, maxConcurrentMarkets: 5 } },
}

const { getTierConfig } = vi.hoisted(() => ({ getTierConfig: vi.fn() }))

// The tier config now reads through the spec-110 chain seam; `getTierConfig` is the same
// mock each test seeds, reached by function name rather than off a contract object.
vi.mock('../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: (_chainId, { functionName, args = [] }) => {
      if (functionName !== 'getTierConfig') throw new Error('unmocked read: ' + functionName)
      return getTierConfig(...args)
    },
  }
})
vi.mock('../config/contracts', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, getContractAddressForChain: () => '0xEfd1a880c6BfBf38A661A3F5fF6d5ECB296D557a' }
})
vi.mock('../utils/blockchainService', () => ({ getProvider: () => ({}) }))

import { useTierPrices } from '../hooks/useTierPrices'

describe('useTierPrices.isTierActive — three states, and the third is not "yes"', () => {
  beforeEach(() => {
    getTierConfig.mockReset()
    getTierConfig.mockImplementation(async (_role, tierId) => LIVE_TIERS[Number(tierId)])
  })

  it('reports the live production config: Bronze and Platinum inactive, Silver and Gold active', async () => {
    const { result } = renderHook(() => useTierPrices())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isTierActive('WAGER_PARTICIPANT', 'BRONZE')).toBe(false)
    expect(result.current.isTierActive('WAGER_PARTICIPANT', 'PLATINUM')).toBe(false)
    expect(result.current.isTierActive('WAGER_PARTICIPANT', 'SILVER')).toBe(true)
    expect(result.current.isTierActive('WAGER_PARTICIPANT', 'GOLD')).toBe(true)
  })

  it('prices come from the chain, not the fallback ladder', async () => {
    // The fallback claims Platinum is 100 USDC; the chain says 2. Whatever is displayed has to
    // be what the contract would charge — that mismatch is exactly what must not be shown.
    const { result } = renderHook(() => useTierPrices())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.getPrice('WAGER_PARTICIPANT', 'SILVER')).toBe(8)
    expect(result.current.getPrice('WAGER_PARTICIPANT', 'GOLD')).toBe(25)
    expect(result.current.getPrice('WAGER_PARTICIPANT', 'PLATINUM')).toBe(2)
    expect(result.current.usingFallbackPrices).toBe(false)
  })

  it('answers null — NOT true — for a tier whose read failed', async () => {
    // Gold's read throws; the others succeed. Gold is unknown, and unknown must not claim to be
    // purchasable (the `?? true` that let the incident through).
    getTierConfig.mockImplementation(async (_role, tierId) => {
      if (Number(tierId) === 3) throw new Error('rpc timeout')
      return LIVE_TIERS[Number(tierId)]
    })
    const { result } = renderHook(() => useTierPrices())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isTierActive('WAGER_PARTICIPANT', 'GOLD')).toBe(null)
    expect(result.current.isTierActive('WAGER_PARTICIPANT', 'BRONZE')).toBe(false)
    expect(result.current.usingFallbackPrices).toBe(true)
  })
})
