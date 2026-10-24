/**
 * Enrich derived transfers with the data only a transaction receipt/block can
 * supply (spec 016-wager-tax-report, FR-004/FR-005/FR-006; research.md D1/D2):
 *   - exact transfer timestamp (from the block)
 *   - the network/gas fee, attributed to the user ONLY when the user sent the
 *     transaction; otherwise the fee is null with an explicit reason (FR-015 —
 *     surfaced honestly, never fabricated)
 *
 * The full transaction hash is already on each pre-item from the log. Chain
 * reads are injected (`reader`) so this is unit-testable without a provider;
 * block/receipt lookups are memoized within a single call.
 */

const WEI_PER_NATIVE = 1e18

function eq(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

/** gasUsed × effectiveGasPrice (wei) → native-token amount (number). */
function feeFromReceipt(receipt) {
  const gasUsed = receipt?.gasUsed
  const price = receipt?.effectiveGasPrice ?? receipt?.gasPrice
  if (gasUsed == null || price == null) return null
  try {
    const wei = BigInt(gasUsed) * BigInt(price)
    return Number(wei) / WEI_PER_NATIVE
  } catch {
    return null
  }
}

/**
 * @param {object[]} preItems - output of deriveTransfers
 * @param {object} params
 * @param {object} params.reader - { getBlock(blockNumber), getTransactionReceipt(txHash) }
 * @param {string} params.userAddress - the report subject
 * @param {string} [params.nativeSymbol] - e.g. 'POL' (for display)
 * @returns {Promise<object[]>} items with { timestamp, feeNative, feeNativeSymbol, feeUnavailableReason }
 */
export async function enrichTransfers(preItems, { reader, userAddress, nativeSymbol = 'NATIVE' }) {
  const blockCache = new Map()
  const receiptCache = new Map()

  const getBlock = async (n) => {
    if (!blockCache.has(n)) blockCache.set(n, await reader.getBlock(n))
    return blockCache.get(n)
  }
  const getReceipt = async (h) => {
    if (!receiptCache.has(h)) receiptCache.set(h, await reader.getTransactionReceipt(h))
    return receiptCache.get(h)
  }

  const out = []
  for (const item of preItems) {
    // The subgraph path (spec 017) already carries the exact transfer timestamp,
    // so only the per-transfer fee receipt is fetched. The bounded-scan fallback
    // path has no timestamp on the pre-item, so resolve it from the block then.
    const receipt = await getReceipt(item.txHash)
    let timestamp = item.timestamp != null ? Number(item.timestamp) : null
    if (timestamp == null) {
      const block = await getBlock(item.blockNumber)
      timestamp = block?.timestamp != null ? Number(block.timestamp) * 1000 : null
    }

    let feeNative = null
    let feeUnavailableReason = null
    if (receipt && eq(receipt.from, userAddress)) {
      feeNative = feeFromReceipt(receipt)
      if (feeNative == null) feeUnavailableReason = 'Fee data unavailable for this transaction.'
    } else {
      // The user did not send this transaction (e.g. a counterparty-settled
      // refund/payout), so they paid no gas for it.
      feeUnavailableReason = 'Not sent by you — no gas fee paid.'
    }

    out.push({
      ...item,
      timestamp,
      feeNative,
      feeNativeSymbol: nativeSymbol,
      feeUnavailableReason,
    })
  }
  return out
}
