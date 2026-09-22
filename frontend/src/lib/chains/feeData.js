/**
 * The fee read, with ethers' policy kept deliberately — spec 110, DIVERGENCE 28.
 *
 * viem's `estimateFeesPerGas` is NOT a drop-in for ethers' `getFeeData`, and both differences
 * are load-bearing on the paths this migration converts:
 *
 * 28a — **viem THROWS on a chain that prices in legacy `gasPrice`.** Its default `type` is
 *   `'eip1559'`, and when the latest block carries no `baseFeePerGas` it raises
 *   `Eip1559FeesNotSupportedError` rather than falling back. ethers answered `gasPrice` and left
 *   `maxFeePerGas`/`maxPriorityFeePerGas` null. **ETC mainnet (61) and Mordor (63) are exactly
 *   that kind of chain**, and they are in the cohort — so on the sweep path a member recovering a
 *   legacy account on ETC would not have got a worse quote, they would have got an exception
 *   where the whole read used to work.
 *
 * 28b — **the EIP-1559 headroom is 1.2× where ethers' was 2×.** ethers computed
 *   `maxFeePerGas = baseFeePerGas * 2 + tip`; viem computes `baseFeePerGas * 1.2 + tip`
 *   (`chain.fees.baseFeeMultiplier`, default 1.2). That margin is not cosmetic in
 *   `lib/recovery/legacyKeys.js`: the coin leg sends `balance − gasLimit × price` and PINS
 *   `maxFeePerGas` to that same `price`, so the headroom is the only thing covering a base fee
 *   that climbs between signing and inclusion. Halving it does not produce an error — it produces
 *   a transaction that sits unmined, which is the stranding the reserve exists to prevent.
 *
 * So the policy is reproduced here rather than delegated: one block read, `eth_gasPrice` and
 * `eth_maxPriorityFeePerGas` alongside it, each tolerated when the node does not answer, exactly
 * as ethers tolerated them. `baseFeePerGas === 0n` takes the legacy branch, because ethers tested
 * it for TRUTHINESS and `0n` is falsy — a chain reporting a zero base fee was priced legacy.
 */

/** ethers' fallback tip when a node does not implement `eth_maxPriorityFeePerGas`. */
const DEFAULT_PRIORITY_FEE = 1000000000n // 1 gwei

const orNull = (promise) => promise.then((v) => v).catch(() => null)

/**
 * `{ maxFeePerGas, maxPriorityFeePerGas, gasPrice }`, in ethers' `FeeData` shape and by ethers'
 * arithmetic. Never throws for a legacy-priced chain; a field the node could not answer is null.
 *
 * @param {import('viem').PublicClient} client
 * @returns {Promise<{maxFeePerGas: bigint|null, maxPriorityFeePerGas: bigint|null, gasPrice: bigint|null}>}
 */
export async function estimateFeeData(client) {
  const [block, gasPrice, priorityFee] = await Promise.all([
    orNull(client.getBlock({ blockTag: 'latest' })),
    orNull(client.getGasPrice()),
    orNull(client.estimateMaxPriorityFeePerGas()),
  ])
  const base = block?.baseFeePerGas
  if (typeof base === 'bigint' && base > 0n) {
    const maxPriorityFeePerGas = priorityFee ?? DEFAULT_PRIORITY_FEE
    return { maxFeePerGas: base * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas, gasPrice }
  }
  return { maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice }
}

export default estimateFeeData
