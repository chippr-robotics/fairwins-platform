import { useCallback, useEffect, useState } from 'react'
import { useWallet } from './useWalletManagement'
import { useFundingPools } from './useFundingPools'
import { readFundingPools } from '../lib/funding/myFundingPools'
import { bucketFor, nextActionFor } from '../lib/funding/progress'

// Bound the on-chain reads per open so a long device history can't fan out into dozens of RPC calls.
const MAX_READS = 12

/**
 * The connected member's funding pools for the My Pools sheet (spec 103, US6 / FR-022..023).
 *
 * Source of truth is the device record (addresses + role); every row is re-read from chain, scoped to
 * the active network, and reads that fail are reported as `unreadable` rows (never dropped, never
 * zeroed). Read-only; no wallet signature. Auto-refreshes every 30s while mounted.
 */
export function useMyFundingPools({ enabled = true } = {}) {
  const { account, chainId } = useWallet()
  const { getSummary } = useFundingPools()
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    const recorded = readFundingPools(account).slice(-MAX_READS).reverse()
    const rows = await Promise.all(recorded.map(async (rec) => {
      try {
        const s = await getSummary(rec.address)
        if (Number(s.chainId) !== Number(chainId)) return null
        return {
          address: s.address,
          purpose: s.purpose,
          // Role comes from the CHAIN, never the device record: a stale record must not label someone
          // an organizer of a pool they only contributed to.
          role: s.isOrganizer ? (s.me.hasContributed ? 'both' : 'organizer') : 'contributor',
          state: s.state,
          stateLabel: s.stateLabel,
          bucket: bucketFor(s),
          progressPct: s.progressPct,
          raisedFormatted: s.raisedFormatted,
          goalFormatted: s.goalFormatted,
          tokenSymbol: s.tokenSymbol,
          nextAction: nextActionFor(s),
          me: s.me,
          readable: true,
        }
      } catch {
        return { address: rec.address, role: rec.role, readable: false, bucket: 'active', nextAction: null }
      }
    }))
    return rows.filter(Boolean)
  }, [account, chainId, getSummary])

  const refresh = useCallback(() => {
    if (!account) { setItems([]); return Promise.resolve() }
    return load().then(setItems).catch(() => { /* keep prior items */ })
  }, [account, load])

  useEffect(() => {
    let alive = true
    if (!enabled || !account) {
      setItems([])
      return undefined
    }
    setLoading(true)
    load()
      .then((list) => { if (alive) setItems(list) })
      .catch(() => { if (alive) setItems([]) })
      .finally(() => { if (alive) setLoading(false) })
    const id = setInterval(() => {
      load().then((list) => { if (alive) setItems(list) }).catch(() => {})
    }, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [enabled, account, load])

  return { items, loading, refresh }
}

export default useMyFundingPools
