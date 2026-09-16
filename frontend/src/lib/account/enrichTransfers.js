/**
 * enrichTransfers — turn raw WagerTransfer pre-items (amountRaw in base units)
 * into valued transfers the dashboard's pure helpers consume (spec 020).
 *
 * Mirrors the report builder's enrichment: resolve token meta (ticker +
 * decimals), convert base units → human with `formatUnits`, then value
 * at the stablecoin par baseline (`valuation.valueTransfer`). I/O (token meta
 * lookup) is injected so this is unit-testable without a provider.
 */
import { formatUnits } from '../evm/units'
import { resolveTokenMeta } from '../../data/reports/tokenMeta'
import { valueTransfer } from '../../data/reports/valuation'

/**
 * @param {Array} rawTransfers - pre-items { wagerId, direction, tokenAddress, amountRaw, txHash, timestamp(ms) }
 * @param {object} opts
 * @param {number} opts.chainId
 * @param {(address:string)=>Promise<{symbol:string,decimals:number}>} [opts.fetchOnChain]
 * @returns {Promise<{ transfers: Array, tokenMetaByAddress: Object }>}
 */
export async function enrichTransfers(rawTransfers = [], { chainId, fetchOnChain } = {}) {
  const tokenMetaByAddress = {}
  const transfers = []
  for (const row of rawTransfers) {
    const meta = await resolveTokenMeta(row.tokenAddress, chainId, { fetchOnChain })
    const key = String(row.tokenAddress || '').toLowerCase()
    tokenMetaByAddress[key] = meta
    let amount
    try {
      amount = Number(formatUnits(BigInt(row.amountRaw ?? 0), meta.decimals))
    } catch {
      amount = 0
    }
    const valued = valueTransfer(amount)
    transfers.push({
      wagerId: String(row.wagerId ?? ''),
      direction: row.direction,
      tokenAddress: key,
      ticker: meta.ticker,
      decimals: meta.decimals,
      amount,
      usdValue: valued.usdValue,
      timestamp: Number(row.timestamp) || 0,
      txHash: row.txHash || '',
    })
  }
  return { transfers, tokenMetaByAddress }
}
