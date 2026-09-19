import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits } from '../lib/evm/units'
import { readContract } from '../lib/chains/readContract'
import { NETWORKS } from '../config/networks'
import { useEndpointsRevision } from './useRpcEndpoints'
import logger from '../utils/logger'

const BALANCE_OF_ABI = ['function balanceOf(address) view returns (uint256)']

/**
 * Balances for a handful of ERC-20s on ONE network, read over that network's own
 * provider — the leg balances behind the multi-network Trade ticket.
 *
 * DexContext only ever reads the CONNECTED chain, so once a member can select a
 * pair on Base while their wallet sits on Polygon, the ticket needs a balance
 * source that follows the PAIR's network instead of the wallet's. This is that
 * source, scoped deliberately narrowly: only the legs currently on screen, which
 * is two reads, not a portfolio scan.
 *
 * Honest-state (constitution III): an unread balance is `null`, never `0`. The
 * ticket shows "…" for null and never invites a member to trade against a number
 * we failed to fetch. A read that fails leaves the previous value alone rather
 * than zeroing it.
 *
 * @param {{ chainId: number|null, address: string|null, tokens: Array<{address: string, decimals: number}> }} params
 * @returns {{ balances: Record<string, string|null>, loading: boolean, refresh: () => Promise<void> }}
 */
export function useSwapBalances({ chainId, address, tokens = [] } = {}) {
  const [balances, setBalances] = useState({})
  const [loading, setLoading] = useState(false)
  const reqIdRef = useRef(0)
  const endpointRevision = useEndpointsRevision()

  // Identity of the read set — deduped, lower-cased, order-independent — so a
  // re-render that rebuilds the same token array does not refetch.
  const targets = useMemo(() => {
    const byAddress = new Map()
    for (const token of tokens || []) {
      if (!token?.address) continue
      byAddress.set(token.address.toLowerCase(), {
        address: token.address,
        decimals: token.decimals ?? 18,
      })
    }
    return [...byAddress.values()].sort((a, b) => a.address.localeCompare(b.address))
  }, [tokens])
  const targetKey = targets.map((t) => `${t.address.toLowerCase()}:${t.decimals}`).join(',')

  const numericChainId = Number(chainId)
  const rpcUrl = NETWORKS[numericChainId]?.rpcUrl || null

  const load = useCallback(async () => {
    if (import.meta.env.VITE_SKIP_BLOCKCHAIN_CALLS === 'true') return
    if (!address || !rpcUrl || targets.length === 0) return

    const reqId = ++reqIdRef.current
    setLoading(true)
    try {
      const results = await Promise.all(
        targets.map(async (token) => {
          try {
            const raw = await readContract(numericChainId, {
              address: token.address,
              abi: BALANCE_OF_ABI,
              functionName: 'balanceOf',
              args: [address],
            })
            return [token.address.toLowerCase(), formatUnits(raw, token.decimals)]
          } catch (error) {
            // Stale-or-unknown, never zero: a failed read must not read as "no funds".
            logger.debug?.('Swap balance read failed', token.address, error?.message)
            return [token.address.toLowerCase(), null]
          }
        }),
      )
      if (reqId !== reqIdRef.current) return // a newer read superseded this one
      setBalances((prev) => {
        const next = { ...prev }
        for (const [key, value] of results) {
          // Keep the last known figure when this read failed.
          if (value != null || next[key] === undefined) next[key] = value
        }
        return next
      })
    } finally {
      if (reqId === reqIdRef.current) setLoading(false)
    }
  }, [address, rpcUrl, numericChainId, targets])

  // A different network or account means the old figures belong to someone else.
  useEffect(() => {
    setBalances({})
  }, [numericChainId, address])

  // `targetKey` (not `targets`) keeps this to real changes in the read set;
  // `endpointRevision` re-reads after the member repoints a network (spec 069).
  useEffect(() => {
    load()
  }, [load, targetKey, endpointRevision])

  return { balances, loading, refresh: load }
}

export default useSwapBalances
