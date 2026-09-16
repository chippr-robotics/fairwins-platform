import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatUnits } from '../lib/evm/units'
import { useWallet } from './useWalletManagement'
import { useActiveAccount } from './useActiveAccount'
import { listWrappableCoins } from '../config/wrappedNative'
import { readBalancesSettled } from '../lib/portfolio/batchBalances'
import { getReadProvider } from '../utils/rpcProvider'
import { useEndpointsRevision } from './useRpcEndpoints'
import { WRAP_DIRECTION } from './useWrapNative'

/**
 * useWrapCoinOptions (spec 108) — the Wrap picker's option list: every cohort chain's base
 * coin (or, for the unwrap direction, its wrapped twin) with the member's balance beside it,
 * read per chain with FAILURE ISOLATION.
 *
 * Honesty rules, verbatim from the estate-read family (specs 071/089):
 *
 *   - A value exists only in state `read`. A chain that could not answer keeps `balance:
 *     null` and `readState: 'unreadable'` — the row renders "…"/"—" and STAYS SELECTABLE,
 *     because an unreachable RPC says nothing about what the member holds there.
 *   - One dark chain never blanks the list: reads ride `readBalancesSettled`, whose
 *     contract is per-asset allSettled semantics (a failed read is skipped, never zero).
 *   - Providers come from `getReadProvider(chainId)` (spec 069) — never hand-built — and a
 *     member endpoint change re-reads immediately (`useEndpointsRevision`).
 *
 * Balances belong to whoever is ACTING (spec 088 FR-001): a vault or recovered account's
 * options read THAT address. The view separately pins the picker to the acting account's
 * own chain — this hook only answers "what would each row's number be".
 *
 * Option shape is spec-064 SelectableAsset (consumed directly by `UniversalAssetSelect`):
 * `balance` is a human-decimal string or null, `chainId`/`symbol`/`networkName` label the
 * row, and `wrapped` carries the resolver's twin verbatim for the submit path.
 */
export function useWrapCoinOptions({ direction = WRAP_DIRECTION.WRAP } = {}) {
  const { address, chainId } = useWallet()
  const { identity, isVault, isLegacy, isHardware } = useActiveAccount()
  const endpointRevision = useEndpointsRevision()

  const actingAddress =
    (isVault && identity?.vaultAddress) ||
    ((isLegacy || isHardware) && identity?.address) ||
    address || null

  const coins = useMemo(() => listWrappableCoins(), [])
  const wrapping = direction === WRAP_DIRECTION.WRAP

  // key -> { balance: string|null, readState: 'pending'|'read'|'unreadable' }
  const [readings, setReadings] = useState({})

  const refresh = useCallback(async () => {
    if (!actingAddress || coins.length === 0) {
      setReadings({})
      return
    }

    // One asset per candidate chain: the base coin for wrapping, the wrapped ERC-20 for
    // unwrapping — the leg the member would SPEND in this direction.
    const registry = coins.map((coin) =>
      wrapping
        ? { kind: 'native', chainId: coin.chainId }
        : { kind: 'erc20', chainId: coin.chainId, address: coin.wrapped.address },
    )
    const providers = new Map(coins.map((coin) => [coin.chainId, getReadProvider(coin.chainId)]))

    const settled = await readBalancesSettled(registry, providers, actingAddress)
    setReadings((prev) => {
      const next = { ...prev }
      settled.forEach((res, i) => {
        const coin = coins[i]
        const decimals = wrapping ? coin.decimals : coin.wrapped.decimals
        next[coin.key] =
          res?.status === 'fulfilled'
            ? { balance: formatUnits(res.value, decimals), readState: 'read' }
            : { balance: null, readState: 'unreadable' }
      })
      return next
    })
  }, [actingAddress, coins, wrapping])

  useEffect(() => {
    setReadings({})
    refresh()
    // A member endpoint change (spec 069) re-reads immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, endpointRevision])

  const options = useMemo(
    () =>
      coins.map((coin) => {
        const reading = readings[coin.key] || { balance: null, readState: 'pending' }
        return {
          ...coin,
          // Unwrapping shows/spends the wrapped leg; the option's face follows suit so the
          // picker names what the member is actually parting with.
          symbol: wrapping ? coin.symbol : coin.wrapped.symbol,
          name: wrapping ? coin.name : coin.wrapped.name,
          balance: reading.balance, // human-decimal string | null — null is UNREAD, not zero
          readState: reading.readState,
        }
      }),
    [coins, readings, wrapping],
  )

  // Default: the connected chain's coin where it is wrappable, else the first candidate.
  const defaultKey = useMemo(() => {
    const connected = options.find((o) => o.chainId === Number(chainId))
    return (connected || options[0])?.key ?? null
  }, [options, chainId])

  return useMemo(
    () => ({ options, defaultKey, refresh }),
    [options, defaultKey, refresh],
  )
}

export default useWrapCoinOptions
