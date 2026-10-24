import { describe, it, expect, vi, beforeEach } from 'vitest'

const chain = vi.hoisted(() => ({ client: null }))
vi.mock('../../lib/chains/publicClient', async (orig) => {
  const actual = await orig()
  return { ...actual, getPublicClient: () => chain.client }
})

import { chainNow } from '../../hooks/useFundingPools'

/*
 * Deadline decisions are enforced by the contract against block.timestamp, so the UI judges them by
 * the chain's clock, not the device's (a wrong device clock must never offer a poke the contract
 * would revert). The device clock is only the fallback for a chain that cannot answer.
 *
 * `chainNow` takes a CHAIN now rather than a contract (spec 110). The behaviour asserted is
 * unchanged; what changed is that the clock is reached through the read seam instead of by digging
 * a provider out of an ethers Contract's runner.
 */
describe('chainNow', () => {
  beforeEach(() => {
    chain.client = null
  })

  it('reads the latest block timestamp from the chain', async () => {
    const getBlock = vi.fn(async () => ({ timestamp: 1_800_000_000n }))
    chain.client = { getBlock }
    expect(await chainNow(137)).toBe(1_800_000_000)
    expect(getBlock).toHaveBeenCalledWith({ blockTag: 'latest' })
  })

  it('falls back to the device clock when the chain cannot answer', async () => {
    const before = Math.floor(Date.now() / 1000)
    // No endpoint for that chain at all.
    chain.client = null
    expect(await chainNow(137)).toBeGreaterThanOrEqual(before)
    // The read throws.
    chain.client = { getBlock: async () => { throw new Error('down') } }
    expect(await chainNow(137)).toBeGreaterThanOrEqual(before)
    // The read answers with nothing usable.
    chain.client = { getBlock: async () => null }
    expect(await chainNow(137)).toBeGreaterThanOrEqual(before)
    chain.client = { getBlock: async () => ({ timestamp: 0n }) }
    expect(await chainNow(137)).toBeGreaterThanOrEqual(before)
    // And no chain named at all.
    expect(await chainNow(undefined)).toBeGreaterThanOrEqual(before)
  })
})
