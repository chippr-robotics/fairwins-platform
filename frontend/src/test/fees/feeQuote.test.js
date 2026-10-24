/**
 * Platform-fee quote tests (spec 060) — the quote math mirrors the contract
 * (floor, member's favor), display formatting is honest, and fetchFeeQuote
 * distinguishes "no fee system on this chain" (proceed fee-free) from "rate
 * unreadable" (throw — callers must block, FR-015).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ fns: {}, address: null }))

// The FeeRouter read now rides the spec-110 chain seam — fake it at that seam.
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args }) => {
      const f = m.fns[functionName]
      if (!f) throw new Error('unmocked contract method: ' + functionName)
      return f(...(args || []))
    },
  }
})

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: vi.fn(() => m.address),
}))

import { splitFee, bpsToPercent, fetchFeeQuote, FEE_SERVICES } from '../../lib/fees/feeQuote'

describe('splitFee', () => {
  it('floors the fee in the member’s favor', () => {
    expect(splitFee(100_000_000n, 50)).toEqual({ feeAmount: 500_000n, netAmount: 99_500_000n })
    // 199 * 50 / 10000 = 0.995 → 0
    expect(splitFee(199n, 50)).toEqual({ feeAmount: 0n, netAmount: 199n })
    expect(splitFee(100n, 0)).toEqual({ feeAmount: 0n, netAmount: 100n })
  })
})

describe('bpsToPercent', () => {
  it('formats bps as a percentage', () => {
    expect(bpsToPercent(50)).toBe('0.50%')
    expect(bpsToPercent(250)).toBe('2.50%')
    expect(bpsToPercent(0)).toBe('0.00%')
  })
})

describe('fetchFeeQuote', () => {
  beforeEach(() => {
    m.fns = {}
    m.address = null
  })

  it('quotes unavailable (fee-free) when no router is deployed on the chain', async () => {
    const quote = await fetchFeeQuote({ serviceId: FEE_SERVICES.EARN_LEND, chainId: 63, provider: {} })
    expect(quote).toEqual({ available: false, bps: 0, capBps: 0, routerAddress: null })
  })

  it('quotes unavailable when the router exists but the service is unregistered', async () => {
    m.address = '0x00000000000000000000000000000000000000f1'
    m.fns.getService = async () => ({ capBps: 0n, feeBps: 0n, kind: 0n })
    const quote = await fetchFeeQuote({ serviceId: FEE_SERVICES.EARN_LEND, chainId: 137, provider: {} })
    expect(quote.available).toBe(false)
    expect(quote.bps).toBe(0)
  })

  it('returns the live rate and cap for a registered service', async () => {
    m.address = '0x00000000000000000000000000000000000000f1'
    m.fns.getService = async () => ({ capBps: 250n, feeBps: 50n, kind: 1n })
    const quote = await fetchFeeQuote({ serviceId: FEE_SERVICES.EARN_LEND, chainId: 137, provider: {} })
    expect(quote).toEqual({
      available: true,
      bps: 50,
      capBps: 250,
      routerAddress: '0x00000000000000000000000000000000000000f1',
    })
  })

  it('throws when a configured router cannot be read (callers must block, not assume zero)', async () => {
    m.address = '0x00000000000000000000000000000000000000f1'
    m.fns.getService = async () => {
      throw new Error('rpc down')
    }
    await expect(
      fetchFeeQuote({ serviceId: FEE_SERVICES.EARN_LEND, chainId: 137, provider: {} }),
    ).rejects.toThrow(/rpc down/)
  })
})
