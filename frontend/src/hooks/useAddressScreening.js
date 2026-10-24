/**
 * useAddressScreening (Spec 021) — advisory, fail-closed sanctions/compliance
 * screening for the address book and address picker. Wraps the existing
 * utils/sanctionsScreen.js (read-only SanctionsGuard reads). This is a UX
 * pre-check only; the on-chain guard remains the real enforcement (FR-013).
 *
 * Results are cached per (chainId, lowercase(address)) for a short TTL so a
 * contact that becomes restricted is reflected on the next open after expiry,
 * without background polling (FR-010, FR-014, clarified Q5).
 */

import { useState, useCallback } from 'react'
import { useWallet } from './useWalletManagement'
import { screenAddress } from '../utils/sanctionsScreen'
import { addressKey } from '../lib/addressBook/addressBookStore'
import { SCREENING_TTL_MS } from '../lib/addressBook/constants'

// Shared across hook instances for the session.
const cache = new Map() // key -> { status, ts }
const inflight = new Map() // key -> Promise<status>

/** Test seam: clear the module-level screening cache. */
export function __clearScreeningCache() {
  cache.clear()
  inflight.clear()
}

function fresh(key) {
  const entry = cache.get(key)
  if (entry && Date.now() - entry.ts < SCREENING_TTL_MS) return entry.status
  return null
}

export function useAddressScreening() {
  const { provider, chainId: activeChainId } = useWallet()
  const [, setTick] = useState(0)
  const rerender = useCallback(() => setTick((n) => n + 1), [])

  /**
   * Screen ONE address.
   *
   * Options (both added for spec 067's cross-network value surfaces; omitting
   * them keeps the address-book behaviour byte-identical):
   *
   *   provider  a read provider the CALLER guarantees talks to `chainId`. The
   *             Bridge and Supply surfaces deliberately act on a network the
   *             wallet is not currently on — the switch happens at signing — so
   *             without this they could only ever report 'uncertain' for the
   *             network the value actually moves on.
   *   force     skip the cache and re-read. A cached 'clear' is fine for
   *             browsing, but a submission-time screen has to be a live read:
   *             a wallet deny-listed since the quote must still be refused
   *             (spec 067 FR-032 — NOT a spec-021 requirement; 021 asks only
   *             that the warning stay advisory, FR-013), and the TTL would
   *             otherwise hide that for a minute.
   */
  const screenOne = useCallback(
    (address, chainId, { provider: providerOverride = null, force = false } = {}) => {
      const key = addressKey(address, chainId)
      if (!force) {
        const cached = fresh(key)
        if (cached) return Promise.resolve(cached)
        if (inflight.has(key)) return inflight.get(key)
      }

      const run = async () => {
        let status
        // Only screen an entry against a provider that talks to its own chain;
        // otherwise report uncertain rather than screening the wrong network.
        const readProvider =
          providerOverride || (Number(chainId) === Number(activeChainId) ? provider : null)
        if (!readProvider) {
          status = 'uncertain'
        } else {
          try {
            // The entry's own chain — the guard that will enforce it, never one inferred from
            // whatever connection this happens to be (spec 110). The guard above already
            // established that this IS the connected chain.
            const res = await screenAddress(address, readProvider, chainId)
            status = res.available ? (res.allowed ? 'clear' : 'restricted') : 'uncertain'
          } catch {
            status = 'uncertain' // fail-closed (FR-011)
          }
        }
        cache.set(key, { status, ts: Date.now() })
        return status
      }

      // A forced read never joins the shared slot: it must not be handed to a
      // browsing caller as though it were that caller's own read, and it must
      // not evict one either.
      if (force) return run()

      const promise = run().finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key)
      })
      inflight.set(key, promise)
      return promise
    },
    [provider, activeChainId],
  )

  // Synchronous accessor: returns a cached status or 'loading' while it screens.
  const getStatus = useCallback(
    (address, chainId) => {
      const key = addressKey(address, chainId)
      const cached = fresh(key)
      if (cached) return cached
      screenOne(address, chainId).then(rerender)
      return 'loading'
    },
    [screenOne, rerender],
  )

  // Imperatively (re-)screen a batch (e.g. on book open / on select).
  const screen = useCallback(
    async (entries) => {
      await Promise.all((entries || []).map((e) => screenOne(e.address, e.chainId)))
      rerender()
    },
    [screenOne, rerender],
  )

  const anyRestricted = useCallback(
    (entries) =>
      (entries || []).some((e) => fresh(addressKey(e.address, e.chainId)) === 'restricted'),
    [],
  )

  return { screenOne, getStatus, screen, anyRestricted }
}

export default useAddressScreening
