/**
 * Best-route quoting against a Uniswap V3 QuoterV2 — for ANY chain's quoter.
 *
 * Extracted from DexContext so the same routine serves both the connected chain
 * (through the wallet's provider) and every other swap-capable network (through
 * that network's read provider). The caller supplies the quoter contract and the
 * leg metadata; this module owns only the routing + SDK math, so there is one
 * implementation of "what does this pair actually pay out" rather than a second
 * cross-chain copy that could drift from the one members already trade against.
 *
 * Chain-agnostic by construction: `chainId` is used solely to build SDK Token
 * instances for the figures, never to pick addresses — those arrive from the
 * caller, already resolved per-chain.
 */
import { formatUnits, parseUnits } from '../evm/units'
import { toSdkToken, buildTradeMetrics, ROUTED_FEE_TIERS } from './trade'

/**
 * Probe the routed fee tiers and return the deepest fill, decorated with the
 * figures a trading UI shows (execution price, minimum received, price impact).
 *
 * @param {object} p
 * @param {object} p.quoter QuoterV2 bound to `chainId`'s read provider (injected by the caller)
 * @param {number} p.chainId         chain the pool lives on (SDK Token identity)
 * @param {string} p.tokenIn         leg being sold
 * @param {string} p.tokenOut        leg being bought
 * @param {string} p.amountIn        human amount of `tokenIn`
 * @param {number} p.decimalsIn
 * @param {number} p.decimalsOut
 * @param {string} p.symbolIn
 * @param {string} p.symbolOut
 * @param {number} p.slippageBps     tolerance enforced as amountOutMinimum
 * @returns {Promise<object>} the quote shape TradePanel renders
 * @throws when the amount is non-positive or no fee tier holds liquidity
 */
export async function quoteBestRoute({
  quoter,
  chainId,
  tokenIn,
  tokenOut,
  amountIn,
  decimalsIn,
  decimalsOut,
  symbolIn,
  symbolOut,
  slippageBps,
}) {
  const amountInWei = parseUnits(amountIn, decimalsIn)
  if (amountInWei <= 0n) {
    throw new Error('Enter an amount greater than zero')
  }

  // Probe each fee tier; QuoterV2 reverts where no pool exists, so we keep
  // the deepest output across the tiers that do quote — a lightweight route.
  let best = null
  for (const fee of ROUTED_FEE_TIERS) {
    try {
      const res = await quoter.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn: amountInWei,
        fee,
        sqrtPriceLimitX96: 0,
      })
      const out = res[0]
      if (out > 0n && (!best || out > best.amountOutWei)) {
        best = { fee, amountOutWei: out, gasEstimate: res[3] }
      }
    } catch {
      // No pool for this fee tier — skip it.
    }
  }

  if (!best) {
    throw new Error('No liquidity route available for this pair')
  }

  // Near-spot reference quote (a fraction of the size) on the winning tier,
  // used to derive price impact via the SDK. Optional — impact is hidden if
  // the reference quote is unavailable.
  let refInWei = amountInWei / 1000n
  if (refInWei <= 0n) refInWei = 1n
  let refAmountInRaw = null
  let refAmountOutRaw = null
  try {
    const refRes = await quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn: refInWei,
      fee: best.fee,
      sqrtPriceLimitX96: 0,
    })
    if (refRes[0] > 0n) {
      refAmountInRaw = refInWei
      refAmountOutRaw = refRes[0]
    }
  } catch {
    // Impact figure is best-effort.
  }

  const metrics = buildTradeMetrics({
    tokenIn: toSdkToken(chainId, tokenIn, decimalsIn, symbolIn),
    tokenOut: toSdkToken(chainId, tokenOut, decimalsOut, symbolOut),
    amountInRaw: amountInWei,
    amountOutRaw: best.amountOutWei,
    refAmountInRaw,
    refAmountOutRaw,
    slippageBps,
  })

  return {
    chainId: Number(chainId),
    amountOut: formatUnits(best.amountOutWei, decimalsOut),
    amountOutWei: best.amountOutWei,
    feeTier: best.fee,
    gasEstimate: best.gasEstimate,
    executionPrice: metrics.executionPrice.toSignificant(6),
    executionPriceInverted: metrics.executionPrice.invert().toSignificant(6),
    minimumReceived: formatUnits(metrics.minimumReceivedRaw, decimalsOut),
    minimumReceivedWei: metrics.minimumReceivedRaw,
    priceImpactPercent: metrics.priceImpact
      ? parseFloat(metrics.priceImpact.toSignificant(4))
      : null,
    tokenInSymbol: symbolIn,
    tokenOutSymbol: symbolOut,
  }
}

export default quoteBestRoute
