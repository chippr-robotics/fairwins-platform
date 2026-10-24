/**
 * useEstateScreening — one address, every source, every cohort chain (spec 021 amendment,
 * issue #1458). The React face of `lib/screening/screenEstate.js`.
 *
 * Distinct from `useAddressScreening`, which stays the PER-CHAIN screen: the surfaces that gate
 * a submission (Transfer, Pay, Bridge, Supply) still ask the guard on the chain the value moves
 * on, forced and live, because that is the read the contract will repeat. This hook answers the
 * broader question a member asks when they first paste an address — "is this address flagged
 * anywhere?" — and its result is advisory, never a gate.
 *
 * Returns `{ status, result, refresh }`:
 *   status  'idle' (no valid address) | 'loading' | 'done'
 *   result  an EstateScreeningResult on 'done', else null — so `result.verdict` cannot be read
 *           before it exists, and a loading pill is a distinct state, never a stale one.
 *
 * Status is DERIVED from (the address asked, the address answered): a result is only ever shown
 * for the address it was computed for, so typing a new address flips straight to 'loading'
 * without a synchronous setState in the effect.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getAddress, isAddress } from 'viem'
import { WalletContext } from '../contexts/WalletContext'
import { forgetEstateScreening, screenAddressAcrossEstate } from '../lib/screening/screenEstate'
import { verdictOnChain } from '../lib/screening/verdict'

/**
 * The wallet context WITHOUT requiring it: screening needs no wallet — the sweep resolves its own
 * read provider per chain — and a wallet's provider is only a cheaper transport for the one chain
 * it happens to be on. A surface with no WalletProvider above it still screens.
 */
function useWalletMaybe() {
  const wallet = useContext(WalletContext)
  return { provider: wallet?.provider ?? null, chainId: wallet?.chainId ?? null }
}

export function useEstateScreening(address) {
  const { provider, chainId: walletChainId } = useWalletMaybe()
  const key = typeof address === 'string' && isAddress(address.trim()) ? getAddress(address.trim()) : null
  const [answer, setAnswer] = useState(null) // { address, result, tick }
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!key) return undefined
    let cancelled = false
    screenAddressAcrossEstate(key, { walletChainId, walletProvider: provider })
      .then((result) => {
        if (!cancelled) setAnswer({ address: key, result, tick })
      })
      .catch(() => {
        // screenAddressAcrossEstate never rejects; belt-and-braces so a surface can never be
        // left on 'loading' forever.
        if (!cancelled) setAnswer(null)
      })
    return () => {
      cancelled = true
    }
  }, [key, provider, walletChainId, tick])

  const refresh = useCallback(() => {
    if (key) forgetEstateScreening(key)
    setTick((n) => n + 1)
  }, [key])

  if (!key) return { status: 'idle', result: null, refresh }
  const done = answer && answer.address === key && answer.tick === tick
  return { status: done ? 'done' : 'loading', result: done ? answer.result : null, refresh }
}

/**
 * useEstateScreeningMany — the same sweep for a LIST of addresses, for the address book.
 *
 * Why the book needed this: its rows were still asking `useAddressScreening`, the per-chain guard
 * read, which can only answer for the chain the wallet is connected to. A contact saved on Amoy
 * while the wallet sat on Polygon — or any contact at all with no wallet connected — rendered
 * "Unscreened", so a member opening their book saw a column of amber that said nothing about the
 * addresses and everything about their wallet (issue #1458 QA round: thirteen contacts, thirteen
 * Unscreened, on a build where screening worked perfectly).
 *
 * Screening needs no wallet, so the book no longer pretends it does. Each unique address gets one
 * cohort sweep, shared through the module cache and in-flight de-duplication in `screenEstate`,
 * and the reads themselves batch per chain inside ethers.
 *
 *   getVerdict(address)             the whole-estate verdict, or null while it is still running
 *   getVerdictOn(address, chainId)  that network's verdict, or null when nothing screens there
 *   resultFor(address)              the full result, for a caller that wants the readings
 */
export const NO_SOURCE = 'no-source'

export function useEstateScreeningMany(addresses) {
  const { provider, chainId: walletChainId } = useWalletMaybe()

  // One stable key per distinct set, so a re-render with the same addresses does not re-sweep.
  const keys = useMemo(() => {
    const seen = new Set()
    for (const a of addresses || []) {
      if (typeof a === 'string' && isAddress(a.trim())) seen.add(getAddress(a.trim()))
    }
    return [...seen].sort()
  }, [addresses])
  const keySignature = keys.join(',')

  const [results, setResults] = useState({}) // checksummed address -> EstateScreeningResult

  useEffect(() => {
    if (!keys.length) return undefined
    let cancelled = false
    Promise.all(
      keys.map((address) =>
        screenAddressAcrossEstate(address, { walletChainId, walletProvider: provider })
          .then((result) => [address, result])
          .catch(() => null),
      ),
    ).then((pairs) => {
      if (cancelled) return
      setResults((prev) => {
        const next = { ...prev }
        let changed = false
        for (const pair of pairs) {
          if (!pair) continue
          const [address, result] = pair
          if (next[address] !== result) {
            next[address] = result
            changed = true
          }
        }
        return changed ? next : prev
      })
    })
    return () => {
      cancelled = true
    }
    // keySignature stands in for `keys`: same addresses, same sweep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySignature, provider, walletChainId])

  const resultFor = useCallback(
    (address) => {
      if (typeof address !== 'string' || !isAddress(address.trim())) return null
      return results[getAddress(address.trim())] || null
    },
    [results],
  )

  const getVerdict = useCallback((address) => resultFor(address)?.verdict || null, [resultFor])

  // Three answers, not two: a verdict, the string `no-source` when the sweep finished and nothing
  // screens that chain, and null while it is still running. Collapsing the middle one into null
  // would render "still checking" forever on ETC, where nothing will ever answer.
  const getVerdictOn = useCallback(
    (address, chainId) => {
      const result = resultFor(address)
      if (!result) return null
      return verdictOnChain(result, chainId)?.verdict || NO_SOURCE
    },
    [resultFor],
  )

  return { getVerdict, getVerdictOn, resultFor }
}

export default useEstateScreening
