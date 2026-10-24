/**
 * Fee state across the whole estate (spec 071 US3, FR-021…FR-023).
 *
 * ── WHAT ACTUALLY ACCRUES, AND WHERE (research R6) ──────────────────────────────────────────
 * "All chains for accrued fees" needed a real answer about what accrues, and there is exactly
 * ONE accruing balance in the system:
 *
 *   ACCRUED (undrawn) — `MembershipManager.accruedFees()`, withdrawable via `withdrawFees`.
 *                       Deployed on the reference chain and the testnet/local networks only.
 *   RECEIVED          — the treasury's payment-token balance on each chain carrying a
 *                       `FeeRouter`. The FeeRouter itself holds NOTHING: it forwards the fee to
 *                       the treasury inside the same transaction (spec 060), by design.
 *
 * These are never added together. One is money the platform still owes itself; the other is
 * money already delivered. Summing them would invent a third number that is neither.
 *
 * ── AND WHY THERE IS NO GRAND TOTAL ─────────────────────────────────────────────────────────
 * Payment tokens differ per chain — Polygon holds USDC, Mordor holds Classic USD. `aggregate`
 * returns per-unit subtotals and refuses to cross them (FR-022), and any total computed while a
 * chain was unreadable is flagged `partial` and names what is missing (FR-023). A chain that
 * simply has no deployment reads `not-deployed`, which is a fact rather than a gap.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { zeroAddress } from 'viem'
import { NETWORKS, cohortChainIds } from '../config/networks'
import { readContract } from '../lib/chains/readContract'
import { getContractAddressForChain } from '../config/contracts'
import { readAcrossEstate } from '../lib/chains/estate'
import { aggregate } from '../lib/chains/chainReadResult'

const MEMBERSHIP_FEE_ABI = [
  'function accruedFees() view returns (uint128)',
  'function treasury() view returns (address)',
]
const FEE_ROUTER_ABI = ['function treasury() view returns (address)']
const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)']

/** The unit a chain's fee balances are denominated in. Never guessed — config or nothing. */
export function feeUnitFor(chainId) {
  const s = NETWORKS[chainId]?.stablecoin
  return s?.symbol ? { symbol: s.symbol, decimals: s.decimals ?? 6, address: s.address } : null
}

export function useFeeEstate({ walletChainId, walletProvider } = {}) {
  const [accrued, setAccrued] = useState([])
  const [received, setReceived] = useState([])
  const [loading, setLoading] = useState(true)
  const chains = useMemo(() => cohortChainIds(), [])

  const refresh = useCallback(async () => {
    setLoading(true)
    // The two reads are independent and run together; neither can fail the other, and a chain
    // that answers for one but not the other is reported honestly in each.
    const [accruedResults, receivedResults] = await Promise.all([
      readAcrossEstate({
        chainIds: chains,
        addressFor: (id) => getContractAddressForChain('membershipManager', id),
        read: ({ chainId, address }) =>
          readContract(chainId, { address, abi: MEMBERSHIP_FEE_ABI, functionName: 'accruedFees' }),
        walletChainId,
        walletProvider,
        unitFor: feeUnitFor,
      }),
      readAcrossEstate({
        chainIds: chains,
        addressFor: (id) => getContractAddressForChain('feeRouter', id),
        read: async ({ chainId, address }) => {
          // The FeeRouter holds nothing, so the meaningful figure is what its treasury RECEIVED.
          const treasury = await readContract(chainId, {
            address,
            abi: FEE_ROUTER_ABI,
            functionName: 'treasury',
          })
          if (!treasury || treasury === zeroAddress) {
            throw new Error('no treasury configured on this router')
          }
          const token = NETWORKS[chainId]?.stablecoin?.address
          if (!token) throw new Error('no payment token configured for this network')
          return readContract(chainId, {
            address: token,
            abi: ERC20_BALANCE_ABI,
            functionName: 'balanceOf',
            args: [treasury],
          })
        },
        walletChainId,
        walletProvider,
        unitFor: feeUnitFor,
      }),
    ])
    setAccrued(accruedResults)
    setReceived(receivedResults)
    setLoading(false)
  }, [chains, walletChainId, walletProvider])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 60_000)
    return () => clearInterval(interval)
  }, [refresh])

  // Two separate aggregates, deliberately. There is no API here that returns one figure across
  // both, because the two things are not the same kind of money.
  const accruedTotals = useMemo(() => aggregate(accrued), [accrued])
  const receivedTotals = useMemo(() => aggregate(received), [received])

  return { accrued, received, accruedTotals, receivedTotals, loading, refresh, chains }
}

export default useFeeEstate
