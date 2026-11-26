/**
 * usePredictOrders (spec 114 slice 6, FR-023 to FR-025) — follows the member's orders after they were signed.
 *
 * What it does: reads `lib/predict/orderProgress` (the device store), and while an order the venue can still
 * tell us about is tracked, asks the venue about it with the member's OWN on-device CLOB session and feeds
 * what the venue says to the reducer.
 *
 * What it will not do — each of these is a rule, not an omission:
 *  - It NEVER signs, never derives credentials and never prompts. No cached session means `locked`: the panel
 *    says "sign in to trading to see progress". (The client it builds holds a read-only signer that can name an
 *    address and refuses to sign.)
 *  - It NEVER posts an order. `unconfirmed` is resolved by LOOKING THE ORDER UP by the id computed before the
 *    post. The dependencies it takes do not include a submit function at all.
 *  - A lookup that fails is not an event. Only what the venue actually said reaches the reducer; an unreadable
 *    answer leaves the record exactly as it was (and is counted as `unreadable` for the screen to say so).
 *  - It NEVER concludes "not delivered" from absence. "Not found, and no trade names it" also describes an order
 *    that filled and that this lookup cannot see: whether the venue keeps a fill-and-kill order after it matched,
 *    and whether its trades name the order they came from, has not been checked against a real account. Telling
 *    a member an order was not delivered when it filled is how they come to place it twice. So an unconfirmed
 *    order resolves only POSITIVELY (the venue has it, or a trade names it); otherwise it stays unconfirmed, says
 *    how to check, and ends when the member says they have checked. The reducer keeps the `not-delivered` state
 *    for the day a lookup can prove it; nothing here emits it.
 *  - It never invents `settled` or `failed`: the app reads the venue, not the chain, for a matched order.
 *
 * Cadence (see useVisiblePolling): visible tab only; first look at once, then every 6 s backing off ×1.5 to
 * 30 s while nothing changes, back to 6 s on a change; at most 8 orders per round, one request at a time.
 * These reads go to the venue directly (the member's session), not through the gateway's 60/min Predict quota.
 */
import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { WalletContext } from '../contexts/WalletContext.js'
import { useVisiblePolling } from './useVisiblePolling'
import {
  loadStore, subscribe, applyToStore, patchRecord, removeRecord as defaultRemoveRecord, isVenueWatched, asDecimal, toMicro, fromMicro, STORE_KEY,
} from '../lib/predict/orderProgress'
import {
  loadCachedCreds as defaultLoadCachedCreds,
  makeClobClient as defaultMakeClient,
  lookupOrder as defaultLookupOrder,
} from '../lib/predict/clobSession'
import { resolveTradeSigner as defaultResolveTradeSigner } from '../lib/predict/tradeSigner'
import { readOnlySigner, readClientOptions } from '../lib/predict/readClient'

export const POLL_BASE_MS = 6_000
export const POLL_MAX_MS = 30_000
export const MAX_PER_ROUND = 8
/** A `sent` order the venue still has no record of stops being polled after this (it is shown as it was). */
export const SENT_POLL_HORIZON_MS = 60 * 60 * 1000

/** Shares matched, from trades that refer to the order. Trades the venue marks FAILED are not fills. */
function sharesFromTrades(trades, orderId) {
  const id = String(orderId).toLowerCase()
  let total = 0n
  let any = false
  for (const t of trades) {
    if (String(t?.status ?? '').toUpperCase() === 'FAILED') continue
    const own = String(t?.taker_order_id ?? '').toLowerCase() === id
    const part = own ? t.size : (t?.maker_orders ?? []).find((m) => String(m?.order_id ?? '').toLowerCase() === id)?.matched_amount
    const micro = toMicro(asDecimal(part) ?? '')
    if (micro != null) { total += micro; any = true }
  }
  return any && total > 0n ? fromMicro(total) : null
}

export function usePredictOrders({ deps } = {}) {
  const wallet = useContext(WalletContext) || {}
  const { address, loginMethod } = wallet
  const d = useMemo(
    () => ({
      loadCachedCreds: defaultLoadCachedCreds,
      makeClient: defaultMakeClient,
      lookupOrder: defaultLookupOrder,
      removeRecord: defaultRemoveRecord,
      resolveTradeSigner: defaultResolveTradeSigner,
      now: () => Date.now(),
      ...deps,
    }),
    [deps]
  )

  const [store, setStore] = useState(() => loadStore(address))
  const [locked, setLocked] = useState(false)
  const [unreadable, setUnreadable] = useState(false)
  const [readAt, setReadAt] = useState(null)
  // Bumped whenever a round CHANGES a record, so a surface can refresh what depends on it (positions).
  const [changes, setChanges] = useState(0)

  useEffect(() => {
    setStore(loadStore(address))
    const sync = () => setStore(loadStore(address))
    const onStorage = (e) => { if (!e.key || e.key.includes(STORE_KEY)) sync() }
    const off = subscribe(sync)
    window.addEventListener('storage', onStorage)
    return () => {
      off()
      window.removeEventListener('storage', onStorage)
    }
  }, [address])

  const watching = store.orders.some(isVenueWatched)

  const round = useCallback(async () => {
    if (!address) return false
    const creds = d.loadCachedCreds(address)
    if (!creds) {
      setLocked(true)
      return false
    }
    setLocked(false)
    const now = d.now()
    const current = loadStore(address, now)
    const targets = current.orders
      .filter(isVenueWatched)
      .filter((r) => r.idKnown)
      // A computed id is only a lookup key if the venue has not shown that it uses another scheme.
      .filter((r) => !(r.state === 'unconfirmed' && current.idScheme === 'mismatch'))
      .filter((r) => !(r.state === 'sent' && now - r.updatedAt > SENT_POLL_HORIZON_MS))
      .slice(0, MAX_PER_ROUND)
    if (!targets.length) return false

    const client = d.makeClient(readOnlySigner(address), creds, readClientOptions({ loginMethod, address, resolve: d.resolveTradeSigner }))
    let changed = false
    let sawUnreadable = false
    for (const r of targets) {
      const found = await d.lookupOrder(client, { orderId: r.orderId, tokenId: r.tokenId, side: r.side, since: r.signedAt ?? r.createdAt })
      const t = d.now()
      if (found.kind === 'unreadable') {
        sawUnreadable = true
        continue
      }
      let next = r
      if (found.kind === 'found') {
        const o = found.order
        next = applyToStore(address, r.orderId, { type: 'venue', status: o.status, filledSize: o.size_matched }, t, { absentSince: null, absentReads: 0 })
      } else {
        const matched = sharesFromTrades(found.trades ?? [], r.orderId)
        if (matched) {
          next = applyToStore(address, r.orderId, { type: 'venue', status: 'matched', filledSize: matched }, t, { absentSince: null, absentReads: 0 })
        } else if (r.state === 'unconfirmed') {
          // Not found and no trade names it. Counted for the screen ("looked N times"); never a conclusion.
          patchRecord(address, r.orderId, { absentReads: (r.absentReads ?? 0) + 1, absentSince: r.absentSince ?? t })
        }
        // sent/resting/partial with no record: the last known state stands; nothing is concluded from absence.
      }
      // (compared by value: the store hands back a fresh copy of the record each time it is read)
      if (next && (next.state !== r.state || next.filledSize !== r.filledSize || next.reason !== r.reason)) changed = true
    }
    setUnreadable(sawUnreadable)
    if (!sawUnreadable) setReadAt(d.now())
    if (changed) setChanges((n) => n + 1)
    return changed
  }, [address, loginMethod, d])

  useVisiblePolling(round, { enabled: Boolean(address) && watching, baseMs: POLL_BASE_MS, maxMs: POLL_MAX_MS, factor: 1.5, resetKey: address })

  const dismiss = useCallback((orderId) => d.removeRecord(address, orderId), [d, address])
  const refresh = round
  const orders = store.orders

  return {
    orders,
    watching,
    // `locked`: orders are tracked but this tab holds no trading session to ask the venue with.
    locked: Boolean(address) && watching && locked,
    unreadable,
    readAt,
    changes,
    dismiss,
    refresh,
    idScheme: store.idScheme,
  }
}

export default usePredictOrders
