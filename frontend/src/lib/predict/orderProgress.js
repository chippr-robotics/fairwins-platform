/**
 * Order progress (spec 114 slice 6, FR-023 to FR-025) — what the app knows about an order AFTER it was signed.
 *
 * Two halves, both free of the network:
 *
 *  1. `reduce(record, event, now)` — the pure state machine of data-model.md § OrderProgress. It knows the
 *     legal transitions and NOTHING ELSE: an event that is not a legal move leaves the record exactly as it was
 *     (same object back), so a late, duplicated or out-of-order observation can never walk an order backwards
 *     or out of an ending. `unconfirmed` is never terminal.
 *
 *  2. The device store — records under `predict_orders_v1`, per wallet, in localStorage (so an order survives
 *     closing the app, FR-025), pruned seven days after they stop moving. DEVICE-ONLY: the key is deliberately
 *     absent from `lib/backup/syncedObjects.js` (a test asserts it). A record holds the order's id and the
 *     PUBLIC facts of the order — never a signature, never a credential.
 *
 * Words the states may carry (the honesty rule that makes this a feature):
 *  - `matched` is the VENUE's word. `settled` is the CHAIN's. The app reads the venue only, so nothing in this
 *    app emits `settled` or `failed` today; the reducer accepts them so a chain read (or the market feed) can
 *    drive them without a second machine. Until then a matched order stays matched and says settlement happens
 *    on chain.
 *  - `unconfirmed` means the venue's answer never arrived. It is resolved by LOOKING THE ORDER UP, never by
 *    sending it again.
 *  - A lookup that fails is not an event. Callers dispatch only what the venue actually said.
 *
 * Amounts are decimal STRINGS; comparisons go through integer micro-units, never floats.
 */
import { getUserPreference, saveUserPreference } from '../../utils/userStorage'

export const STORE_KEY = 'predict_orders_v1'
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export const STATES = Object.freeze([
  'signed', 'sent', 'resting', 'partial', 'matched', 'settled',
  'cancelled', 'expired', 'rejected', 'unconfirmed', 'not-delivered', 'failed',
])

/** The edges of the diagram in data-model.md, and no others. */
const EDGES = {
  signed: ['sent', 'unconfirmed', 'rejected'],
  sent: ['resting', 'matched'],
  resting: ['partial', 'cancelled', 'expired'],
  partial: ['matched', 'cancelled', 'expired'],
  matched: ['settled', 'failed'],
  unconfirmed: ['sent', 'not-delivered'],
  settled: [],
  rejected: [],
  'not-delivered': [],
  cancelled: [],
  expired: [],
  failed: [],
}
// `resting → matched` is the diagram's `resting → partial → matched` seen by a poll that never caught the
// middle; a venue observation may skip states it did not see, never go backwards or leave an ending.
EDGES.resting = [...EDGES.resting, 'matched']

export const TERMINAL = Object.freeze(new Set(['settled', 'rejected', 'not-delivered', 'cancelled', 'expired', 'failed']))
export const isTerminal = (state) => TERMINAL.has(state)

/** States in which the VENUE can still tell us something new about the order. `matched` waits on the chain. */
const VENUE_WATCHED = new Set(['sent', 'resting', 'partial', 'unconfirmed'])
export const isVenueWatched = (record) => VENUE_WATCHED.has(record?.state)

function reachable(from, to) {
  const seen = new Set([from])
  const queue = [from]
  while (queue.length) {
    const s = queue.shift()
    for (const n of EDGES[s] ?? []) {
      if (n === to) return true
      if (!seen.has(n)) { seen.add(n); queue.push(n) }
    }
  }
  return false
}

/* ── decimals, exact ──────────────────────────────────────────────────────────────────────────────── */

const DECIMAL = /^\d+(\.\d+)?$/
export function toMicro(value) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return null
  const [w, f = ''] = value.split('.')
  return BigInt(w) * 1_000_000n + BigInt(f.slice(0, 6).padEnd(6, '0'))
}
export function fromMicro(micro) {
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${micro / 1_000_000n}.${frac}` : String(micro / 1_000_000n)
}
/** A venue figure as a decimal string, or null when it is not one (a number is accepted only if it prints plainly). */
export function asDecimal(value) {
  const s = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  return typeof s === 'string' && DECIMAL.test(s.trim()) ? fromMicro(toMicro(s.trim())) : null
}

/**
 * What a VENUE order status means for our states. `live` with matched size is `partial`; with none, or when the
 * size matched is not known, it rests. Unknown words map to null — and null is "no change", never a guess.
 */
export function venueStateOf(status, filledSize) {
  const s = String(status ?? '').trim().toLowerCase()
  if (s === 'live' || s === 'open') {
    const filled = toMicro(filledSize ?? '')
    return filled != null && filled > 0n ? 'partial' : 'resting'
  }
  if (s === 'matched') return 'matched'
  if (s === 'canceled' || s === 'cancelled' || s === 'canceled_market_resolved') return 'cancelled'
  if (s === 'expired') return 'expired'
  if (s === 'delayed' || s === 'unmatched') return 'sent'
  return null
}

/* ── the reducer ──────────────────────────────────────────────────────────────────────────────────── */

const move = (record, state, now, patch = {}) => ({ ...record, ...patch, state, updatedAt: now })

/**
 * @param {object} record  an OrderProgress record
 * @param {{ type: string }} event
 *   accepted                       the venue answered the post and took it          signed → sent
 *   no-answer {reason}             the post's answer never arrived                  signed → unconfirmed
 *   refused {reason}               the venue refused it outright                    signed → rejected
 *   venue {status, filledSize?}    what the venue reports for the order (a lookup)  → the state it implies
 *   absent {reason}                looked up, positively not there, with proof      unconfirmed → not-delivered
 *   settled {settledSize} / failed {reason}   the chain's word                      matched → settled | failed
 * @returns the next record, or `record` itself when the event is not a legal move.
 */
export function reduce(record, event, now = Date.now()) {
  if (!record || !event || isTerminal(record.state)) return record
  const to = (state, patch) => (EDGES[record.state]?.includes(state) ? move(record, state, now, patch) : record)
  switch (event.type) {
    case 'accepted':
      return to('sent', { reason: null })
    case 'no-answer':
      return to('unconfirmed', { reason: event.reason ?? null })
    case 'refused':
      return to('rejected', { reason: event.reason ?? null })
    case 'absent':
      return to('not-delivered', { reason: event.reason ?? null })
    case 'settled': {
      const settled = asDecimal(event.settledSize)
      return to('settled', { settledSize: settled ?? record.settledSize, reason: null })
    }
    case 'failed':
      return to('failed', { reason: event.reason ?? null })
    case 'venue': {
      const filled = asDecimal(event.filledSize)
      const target = venueStateOf(event.status, filled)
      if (!target) return record
      // Fills only ever grow: a smaller figure is a stale read, not news.
      const a = toMicro(record.filledSize ?? '')
      const b = toMicro(filled ?? '')
      const filledSize = b != null && (a == null || b >= a) ? filled : record.filledSize
      const moves = target !== record.state && reachable(record.state, target)
      const grows = target === record.state && filledSize !== record.filledSize
      if (!moves && !grows) return record
      // `unconfirmed`'s reason is superseded the moment the venue knows the order.
      return { ...record, state: moves ? target : record.state, filledSize, reason: moves ? null : record.reason, absentSince: null, updatedAt: now }
    }
    default:
      return record
  }
}

/** A record for an order that has just been signed. `orderId` may be null: the venue's answer never carried one. */
export function newRecord({ orderId, tokenId, side, kind, size, sizeUnit, limitPrice, label = null, idKnown = true, signedAt = null }, now = Date.now()) {
  const id = orderId ?? `unsent-${now}-${Math.random().toString(16).slice(2, 10)}`
  return {
    orderId: id,
    idKnown: orderId != null && idKnown,
    tokenId: String(tokenId),
    side: side === 'SELL' ? 'SELL' : 'BUY',
    kind: kind === 'resting' ? 'resting' : 'market',
    size: String(size),
    sizeUnit: sizeUnit === 'shares' ? 'shares' : 'USDC',
    limitPrice: String(limitPrice),
    label: typeof label === 'string' ? label.slice(0, 200) : null,
    state: 'signed',
    filledSize: null, // shares the venue reports matched; null = not read, never 0
    settledSize: null,
    averageFillPrice: null, // the venue's order record carries no average; shown only if a source provides one
    createdAt: now,
    // When the order was signed, taken before the post (createdAt is when the answer arrived, or failed to).
    signedAt: Number.isFinite(signedAt) ? Math.min(signedAt, now) : now,
    updatedAt: now,
    reason: null,
    absentSince: null,
    absentReads: 0,
  }
}

/** Seven days after an order last moved, an ending is dropped — and so is a `matched` the app can never advance. */
export function prune(records, now = Date.now()) {
  return records.filter((r) => !((isTerminal(r.state) || r.state === 'matched') && now - (r.updatedAt ?? 0) > PRUNE_AFTER_MS))
}

/* ── the device store ─────────────────────────────────────────────────────────────────────────────── */

const listeners = new Set()
export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const announce = () => listeners.forEach((l) => { try { l() } catch { /* a listener never breaks a write */ } })

const EMPTY = { v: 1, orders: [], idScheme: 'unknown' }

/**
 * `idScheme` records whether the order id we compute before posting has ever been seen to equal the id the venue
 * answered with: 'unknown' (no successful post yet), 'verified' (equal at least once), 'mismatch' (differed —
 * lookups by the computed id are then meaningless, and are not made).
 */
export function loadStore(account, now = Date.now()) {
  if (!account) return { ...EMPTY }
  const raw = getUserPreference(account, STORE_KEY, null, true)
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.orders)) return { ...EMPTY }
  return {
    v: 1,
    orders: prune(raw.orders.filter((r) => r && typeof r.orderId === 'string' && STATES.includes(r.state)), now),
    idScheme: ['verified', 'mismatch'].includes(raw.idScheme) ? raw.idScheme : 'unknown',
  }
}

function saveStore(account, store) {
  if (!account) return
  saveUserPreference(account, STORE_KEY, store, true)
  announce()
}

export const loadOrders = (account, now) => loadStore(account, now).orders

/** `mismatch` is sticky, `verified` beats `unknown`: an id scheme is only ever learned, never forgotten. */
const mergeScheme = (a, b) => (a === 'mismatch' || b === 'mismatch' ? 'mismatch' : a === 'verified' || b === 'verified' ? 'verified' : 'unknown')

/**
 * THE one way the device store is written (T036b). The store is shared by every tab of this browser, and each tab
 * used to read the whole store, change it and write the whole thing back — so a record another tab added in
 * between (an `unconfirmed` one, whose "do not send it again" notice is the whole point of keeping it) was
 * overwritten with the older picture. A write is now a DELTA applied to what is on disk AT THAT MOMENT:
 *  - `upserts` — each record is merged by `orderId`; when the disk already holds that id, the record with the
 *    NEWER `updatedAt` stays (a tie goes to the writer, which is what bookkeeping patches that do not touch
 *    `updatedAt` rely on);
 *  - `removes` — ids the member dismissed, dropped from what is on disk and from nothing else;
 *  - a record this writer never mentions is never touched, so it can never be dropped.
 * `idScheme` merges as a union (mismatch is sticky).
 */
export function commitToStore(account, { upserts = [], removes = [], idScheme } = {}) {
  if (!account) return
  const disk = loadStore(account) // read NOW, not when the caller started its work
  const byId = new Map(disk.orders.map((r) => [r.orderId, r]))
  for (const mine of upserts) {
    const theirs = byId.get(mine.orderId)
    if (theirs && (theirs.updatedAt ?? 0) > (mine.updatedAt ?? 0)) continue
    byId.set(mine.orderId, mine)
  }
  for (const id of removes) byId.delete(id)
  // newest first, as `putRecord` always kept it
  const orders = [...byId.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  saveStore(account, { ...disk, orders, idScheme: mergeScheme(disk.idScheme, idScheme ?? 'unknown') })
}

/** Insert or replace one record (by orderId); see `commitToStore` for what "replace" means across tabs. */
export function putRecord(account, record, { idScheme } = {}) {
  commitToStore(account, { upserts: [record], idScheme })
}

/**
 * Apply one event to one record in the store; returns the updated record, or the SAME unchanged one (identity) when
 * the event was not a legal move — callers read `result !== before` as "something changed". `patch` is
 * bookkeeping (absence counters) merged into whichever record results.
 */
export function applyToStore(account, orderId, event, now = Date.now(), patch = null) {
  const store = loadStore(account, now)
  const current = store.orders.find((r) => r.orderId === orderId)
  if (!current) return null
  const next = reduce(current, event, now)
  const merged = patch ? { ...next, ...patch } : next
  const patched = patch && Object.keys(patch).some((k) => merged[k] !== current[k])
  if (next === current && !patched) return current
  commitToStore(account, { upserts: [merged] })
  return next === current ? current : merged
}

/** Remove one record (the member dismissing an ending). */
export function removeRecord(account, orderId) {
  if (!loadStore(account).orders.some((r) => r.orderId === orderId)) return
  commitToStore(account, { removes: [orderId] })
}

/** Bookkeeping that is not a state change (absence counters) — stored without touching `state` or `updatedAt`. */
export function patchRecord(account, orderId, patch) {
  const current = loadStore(account).orders.find((r) => r.orderId === orderId)
  if (!current) return
  commitToStore(account, { upserts: [{ ...current, ...patch }] })
}

/**
 * Hand a just-signed order to the tracker. Called ONCE per order, from the ticket's answer:
 *   - the venue took it (`posted` carries its answer) → sent, then whatever the answer's own status implies;
 *   - the answer never arrived (`unconfirmed`) → unconfirmed, keyed by the id we computed before posting.
 * `posted.orderId` is the venue's id; `computedId` is the EIP-712 hash computed before the post. Never throws.
 */
export function trackSignedOrder(account, facts, outcome, now = Date.now()) {
  try {
    if (!account) return null
    const { orderId: venueId = null, status = null, computedId = null } = outcome.posted ?? {}
    const orderId = outcome.unconfirmed ? computedId : (venueId ?? computedId)
    let record = newRecord({ ...facts, orderId }, now)
    let idScheme
    if (outcome.unconfirmed) {
      record = reduce(record, { type: 'no-answer', reason: outcome.reason ?? null }, now)
    } else {
      record = reduce(record, { type: 'accepted' }, now)
      record = reduce(record, { type: 'venue', status }, now)
      // When the venue's id differs from the computed one the record is keyed by the VENUE's (lookups use it);
      // only the SCHEME — whether a computed id can be trusted for an unconfirmed order — is affected.
      if (venueId && computedId) idScheme = String(venueId).toLowerCase() === String(computedId).toLowerCase() ? 'verified' : 'mismatch'
    }
    const store = loadStore(account)
    // A mismatch is sticky; a later 'verified' does not erase it.
    const scheme = store.idScheme === 'mismatch' || idScheme === 'mismatch' ? 'mismatch' : (idScheme ?? store.idScheme)
    putRecord(account, record, { idScheme: scheme })
    return record
  } catch {
    return null
  }
}
