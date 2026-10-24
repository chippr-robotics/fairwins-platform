import { describe, it, expect, vi } from 'vitest'
import { parseUnits } from '../../evm/units'
import { quoteBestRoute } from '../quote'
import { ROUTED_FEE_TIERS } from '../trade'

/**
 * Best-route quoting, the one implementation shared by the connected chain and
 * every other swap-capable network. The routine is handed a quoter, so these
 * tests hand it a fake one and assert the behavior a trader depends on: the
 * DEEPEST tier wins, a tier with no pool is skipped rather than fatal, and a
 * pair with no liquidity anywhere fails loudly instead of quoting zero.
 */

/** A QuoterV2 stand-in: `pools` maps fee tier → output per unit of input. */
function fakeQuoter(pools, { onCall } = {}) {
  return {
    quoteExactInputSingle: {
      staticCall: vi.fn(async (params) => {
        onCall?.(params)
        const rate = pools[Number(params.fee)]
        if (rate == null) throw new Error('execution reverted') // no pool at this tier
        // 6-decimal output for an 18-decimal input, the WMATIC/USDC shape.
        const out = (BigInt(params.amountIn) * BigInt(Math.round(rate * 1e6))) / 10n ** 18n
        if (out <= 0n) throw new Error('execution reverted')
        return [out, 0n, 0n, 21000n]
      }),
    },
  }
}

const BASE_ARGS = {
  chainId: 137,
  tokenIn: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  tokenOut: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  amountIn: '10',
  decimalsIn: 18,
  decimalsOut: 6,
  symbolIn: 'WMATIC',
  symbolOut: 'USDC',
  slippageBps: 50,
}

describe('quoteBestRoute', () => {
  it('keeps the deepest fee tier and reports it as the route', async () => {
    const quoter = fakeQuoter({ 500: 0.4, 3000: 0.5, 10000: 0.3 })
    const quote = await quoteBestRoute({ ...BASE_ARGS, quoter })

    expect(quote.feeTier).toBe(3000)
    expect(quote.amountOut).toBe('5.0')
    expect(quote.tokenInSymbol).toBe('WMATIC')
    expect(quote.tokenOutSymbol).toBe('USDC')
    // The quote states which chain it came from — a cross-chain ticket needs it.
    expect(quote.chainId).toBe(137)
  })

  it('probes every routed tier and survives the ones with no pool', async () => {
    const seen = []
    const quoter = fakeQuoter({ 100: 0.45 }, { onCall: (p) => seen.push(Number(p.fee)) })
    const quote = await quoteBestRoute({ ...BASE_ARGS, quoter })

    expect(quote.feeTier).toBe(100)
    for (const tier of ROUTED_FEE_TIERS) expect(seen).toContain(tier)
  })

  it('enforces slippage as the minimum received', async () => {
    const quoter = fakeQuoter({ 3000: 0.5 })
    const quote = await quoteBestRoute({ ...BASE_ARGS, quoter, slippageBps: 100 })

    // 5 USDC less 1% — the figure we can enforce on-chain as amountOutMinimum.
    expect(quote.minimumReceivedWei).toBe(parseUnits('4.95', 6))
    expect(quote.minimumReceived).toBe('4.95')
  })

  it('derives price impact from a near-spot reference quote', async () => {
    // A pool that pays proportionally less on size than at spot has real impact.
    const quoter = {
      quoteExactInputSingle: {
        staticCall: vi.fn(async ({ fee, amountIn }) => {
          if (Number(fee) !== 3000) throw new Error('execution reverted')
          const rate = BigInt(amountIn) > parseUnits('1', 18) ? 495_000n : 500_000n
          return [(BigInt(amountIn) * rate) / 10n ** 18n, 0n, 0n, 21000n]
        }),
      },
    }
    const quote = await quoteBestRoute({ ...BASE_ARGS, quoter })
    expect(quote.priceImpactPercent).toBeGreaterThan(0.5)
    expect(quote.priceImpactPercent).toBeLessThan(1.5)
  })

  it('leaves impact null when the reference quote is unavailable — never a guess', async () => {
    const quoter = {
      quoteExactInputSingle: {
        staticCall: vi.fn(async ({ fee, amountIn }) => {
          if (Number(fee) !== 3000) throw new Error('execution reverted')
          if (BigInt(amountIn) < parseUnits('1', 18)) throw new Error('execution reverted')
          return [(BigInt(amountIn) * 500_000n) / 10n ** 18n, 0n, 0n, 21000n]
        }),
      },
    }
    const quote = await quoteBestRoute({ ...BASE_ARGS, quoter })
    expect(quote.priceImpactPercent).toBeNull()
    expect(quote.amountOut).toBe('5.0')
  })

  it('fails loudly when no tier holds liquidity', async () => {
    await expect(quoteBestRoute({ ...BASE_ARGS, quoter: fakeQuoter({}) })).rejects.toThrow(
      /No liquidity route available/,
    )
  })

  it('refuses a non-positive amount', async () => {
    await expect(
      quoteBestRoute({ ...BASE_ARGS, amountIn: '0', quoter: fakeQuoter({ 3000: 0.5 }) }),
    ).rejects.toThrow(/greater than zero/)
  })
})
