/**
 * orderProgress (spec 114 slice 6) — the reducer of data-model.md § OrderProgress and its device store.
 * The properties that carry the honesty: only the diagram's moves happen and an illegal event hands back the
 * SAME record; `unconfirmed` is never terminal; fills never shrink; settled/failed come only from their own
 * events (a venue observation can never say them); the store is per wallet, pruned after seven days, and its
 * key is NOT in the backup registry.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  reduce, newRecord, prune, isTerminal, isVenueWatched, venueStateOf, STATES, STORE_KEY, PRUNE_AFTER_MS,
  loadStore, putRecord, applyToStore, patchRecord, removeRecord, trackSignedOrder, subscribe, toMicro, asDecimal,
} from '../../lib/predict/orderProgress'

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const B = '0x1111111111111111111111111111111111111111'
const T0 = Date.now()
const facts = { tokenId: '123', side: 'BUY', kind: 'market', size: '50', sizeUnit: 'USDC', limitPrice: '0.95', label: 'Buy Yes' }
const at = (state, over = {}) => ({ ...newRecord({ ...facts, orderId: '0xo' }, T0), state, ...over })

describe('the diagram, move by move', () => {
  it('signed → sent → resting → partial → matched, each on the venue\'s word', () => {
    let r = at('signed')
    r = reduce(r, { type: 'accepted' }, T0 + 1)
    expect(r.state).toBe('sent')
    r = reduce(r, { type: 'venue', status: 'live', filledSize: '0' }, T0 + 2)
    expect(r.state).toBe('resting')
    r = reduce(r, { type: 'venue', status: 'live', filledSize: '10.5' }, T0 + 3)
    expect(r).toMatchObject({ state: 'partial', filledSize: '10.5', updatedAt: T0 + 3 })
    r = reduce(r, { type: 'venue', status: 'matched', filledSize: '50' }, T0 + 4)
    expect(r).toMatchObject({ state: 'matched', filledSize: '50' })
  })

  it('sent → matched directly (a fill-and-kill that matched at once)', () => {
    const r = reduce(at('sent'), { type: 'venue', status: 'matched', filledSize: '12.3' })
    expect(r).toMatchObject({ state: 'matched', filledSize: '12.3' })
  })

  it('resting and partial end as cancelled or expired, keeping what matched', () => {
    expect(reduce(at('resting'), { type: 'venue', status: 'CANCELED' }).state).toBe('cancelled')
    expect(reduce(at('resting'), { type: 'venue', status: 'expired' }).state).toBe('expired')
    const c = reduce(at('partial', { filledSize: '4' }), { type: 'venue', status: 'canceled', filledSize: '4' })
    expect(c).toMatchObject({ state: 'cancelled', filledSize: '4' })
  })

  it('a poll that missed the middle still lands: resting → matched, sent → partial, sent → cancelled', () => {
    expect(reduce(at('resting'), { type: 'venue', status: 'matched', filledSize: '9' }).state).toBe('matched')
    expect(reduce(at('sent'), { type: 'venue', status: 'live', filledSize: '1' }).state).toBe('partial')
    expect(reduce(at('sent'), { type: 'venue', status: 'canceled' }).state).toBe('cancelled')
  })

  it('matched → settled and matched → failed are the CHAIN\'s events; a venue observation can never say them', () => {
    expect(reduce(at('matched'), { type: 'settled', settledSize: '50' })).toMatchObject({ state: 'settled', settledSize: '50' })
    expect(reduce(at('matched'), { type: 'failed', reason: 'reverted' })).toMatchObject({ state: 'failed', reason: 'reverted' })
    for (const status of ['settled', 'confirmed', 'mined', 'failed', 'filled']) {
      const m = at('matched')
      expect(reduce(m, { type: 'venue', status })).toBe(m)
    }
    // and not from anywhere else
    for (const s of ['sent', 'resting', 'partial', 'unconfirmed', 'signed']) {
      const r = at(s)
      expect(reduce(r, { type: 'settled', settledSize: '1' })).toBe(r)
      expect(reduce(r, { type: 'failed' })).toBe(r)
    }
  })

  it('signed → unconfirmed | rejected', () => {
    expect(reduce(at('signed'), { type: 'no-answer', reason: 'timed out' })).toMatchObject({ state: 'unconfirmed', reason: 'timed out' })
    expect(reduce(at('signed'), { type: 'refused', reason: 'no' })).toMatchObject({ state: 'rejected', reason: 'no' })
  })

  it('unconfirmed → sent (found) | not-delivered (absent) — and a venue observation resolves it forward', () => {
    expect(reduce(at('unconfirmed', { reason: 'x' }), { type: 'venue', status: 'live', filledSize: '0' })).toMatchObject({ state: 'resting', reason: null })
    expect(reduce(at('unconfirmed'), { type: 'venue', status: 'matched', filledSize: '5' }).state).toBe('matched')
    expect(reduce(at('unconfirmed'), { type: 'accepted' }).state).toBe('sent')
    expect(reduce(at('unconfirmed'), { type: 'absent', reason: 'none' })).toMatchObject({ state: 'not-delivered', reason: 'none' })
  })
})

describe('nothing else happens', () => {
  const sameObject = (r, e) => expect(reduce(r, e)).toBe(r)

  it('terminal records never move, whatever the event', () => {
    const events = [
      { type: 'accepted' }, { type: 'no-answer' }, { type: 'refused' }, { type: 'absent' },
      { type: 'venue', status: 'live', filledSize: '1' }, { type: 'venue', status: 'matched' }, { type: 'settled', settledSize: '1' }, { type: 'failed' },
    ]
    for (const s of STATES.filter(isTerminal)) for (const e of events) sameObject(at(s), e)
  })

  it('no event walks an order backwards', () => {
    sameObject(at('matched'), { type: 'venue', status: 'live', filledSize: '0' })
    sameObject(at('partial', { filledSize: '5' }), { type: 'venue', status: 'live', filledSize: '0' }) // a smaller fill is stale, not news
    sameObject(at('resting'), { type: 'accepted' })
    sameObject(at('sent'), { type: 'no-answer' })
    sameObject(at('resting'), { type: 'absent' })
    sameObject(at('sent'), { type: 'absent' }) // an order the venue accepted is never "not delivered"
    sameObject(at('matched'), { type: 'refused' })
  })

  it('unknown events, unknown statuses and garbage leave the record alone', () => {
    sameObject(at('resting'), { type: 'teleport' })
    sameObject(at('resting'), { type: 'venue', status: 'wat' })
    sameObject(at('resting'), { type: 'venue' })
    sameObject(at('resting'), null)
    expect(reduce(null, { type: 'accepted' })).toBeNull()
  })

  it('exhaustive: from every state, every venue-status target reachable per the diagram moves, every other leaves the record untouched', () => {
    const closure = {
      signed: ['sent', 'resting', 'partial', 'matched', 'cancelled', 'expired'],
      sent: ['resting', 'partial', 'matched', 'cancelled', 'expired'],
      resting: ['partial', 'matched', 'cancelled', 'expired'],
      partial: ['matched', 'cancelled', 'expired'],
      matched: [],
      unconfirmed: ['sent', 'resting', 'partial', 'matched', 'cancelled', 'expired'],
    }
    const observations = { resting: { status: 'live' }, partial: { status: 'live', filledSize: '1' }, matched: { status: 'matched' }, cancelled: { status: 'canceled' }, expired: { status: 'expired' } }
    for (const [from, reach] of Object.entries(closure)) {
      for (const [target, obs] of Object.entries(observations)) {
        const r = at(from)
        const next = reduce(r, { type: 'venue', ...obs })
        if (reach.includes(target)) expect(next.state, `${from} -> ${target}`).toBe(target)
        else if (from !== target) expect(next, `${from} -/-> ${target}`).toBe(r)
      }
    }
  })
})

describe('`unconfirmed` is never terminal and never a failure', () => {
  it('is watched, not an ending, and has exactly two ways out', () => {
    expect(isTerminal('unconfirmed')).toBe(false)
    expect(isVenueWatched({ state: 'unconfirmed' })).toBe(true)
    const r = at('unconfirmed')
    // time passing, repeated no-answers and errors do not end it
    sameStateAfter(r, [{ type: 'no-answer' }, { type: 'refused' }, { type: 'venue', status: 'wat' }, { type: 'failed' }, { type: 'settled' }])
  })
  function sameStateAfter(r, events) {
    let cur = r
    for (const e of events) cur = reduce(cur, e)
    expect(cur).toBe(r)
  }
})

describe('figures are exact strings', () => {
  it('fills are compared in micro-units, never floats, and only ever grow', () => {
    let r = at('partial', { filledSize: '0.1' })
    r = reduce(r, { type: 'venue', status: 'live', filledSize: '0.30000000000000004' }) // >6 dp truncates, no float math
    expect(r.filledSize).toBe('0.3')
    r = reduce(r, { type: 'venue', status: 'live', filledSize: '0.2' })
    expect(r.filledSize).toBe('0.3')
    expect(toMicro('0.1')).toBe(100000n)
    expect(asDecimal(1.5)).toBe('1.5')
    expect(asDecimal('abc')).toBeNull()
    expect(asDecimal(undefined)).toBeNull()
  })

  it('a fill the venue has not reported stays null — never 0', () => {
    const r = reduce(at('sent'), { type: 'venue', status: 'live' })
    expect(r.state).toBe('resting')
    expect(r.filledSize).toBeNull()
  })

  it('maps venue words, and unknown words map to nothing', () => {
    expect(venueStateOf('LIVE', '0')).toBe('resting')
    expect(venueStateOf('live', '2')).toBe('partial')
    expect(venueStateOf('MATCHED')).toBe('matched')
    expect(venueStateOf('CANCELED_MARKET_RESOLVED')).toBe('cancelled')
    expect(venueStateOf('INVALID')).toBeNull()
    expect(venueStateOf(undefined)).toBeNull()
  })
})

describe('pruning', () => {
  it('drops endings (and a matched the app can never advance) seven days after they last moved — never an unconfirmed or a live one', () => {
    const now = T0 + PRUNE_AFTER_MS + 1
    const old = (state) => at(state, { orderId: state, updatedAt: T0 })
    const kept = prune(['settled', 'cancelled', 'expired', 'rejected', 'not-delivered', 'failed', 'matched', 'unconfirmed', 'resting', 'sent', 'partial'].map(old), now).map((r) => r.state)
    expect(kept).toEqual(['unconfirmed', 'resting', 'sent', 'partial'])
    expect(prune([at('cancelled', { updatedAt: T0 })], T0 + PRUNE_AFTER_MS)).toHaveLength(1) // exactly seven days is not yet over
  })
})

describe('the device store', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a record under predict_orders_v1, per wallet, in localStorage (so it survives closing the app)', () => {
    const r = at('resting')
    putRecord(A, r)
    expect(loadStore(A).orders).toEqual([r])
    expect(loadStore(B).orders).toEqual([])
    const key = Object.keys(localStorage).find((k) => k.endsWith(STORE_KEY))
    expect(key).toContain(A.toLowerCase())
    expect(key.includes(B.toLowerCase())).toBe(false)
    expect(sessionStorage.length).toBe(0)
  })

  it('stores public facts only: no signature, no credential, ever', () => {
    trackSignedOrder(A, facts, { posted: { orderId: '0xv', status: 'live', computedId: '0xv' } })
    const raw = Object.entries(localStorage).find(([k]) => k.endsWith(STORE_KEY))[1]
    expect(raw).not.toMatch(/signature|secret|passphrase|apiKey|0xsig/i)
    expect(Object.keys(JSON.parse(raw).orders[0]).sort()).toEqual(
      ['absentReads', 'absentSince', 'averageFillPrice', 'createdAt', 'filledSize', 'idKnown', 'kind', 'label', 'limitPrice', 'orderId', 'reason', 'settledSize', 'side', 'signedAt', 'size', 'sizeUnit', 'state', 'tokenId', 'updatedAt'],
    )
  })

  it('loading prunes, ignores damage, and never throws on garbage', () => {
    putRecord(A, at('cancelled', { orderId: 'old', updatedAt: 1 }))
    expect(loadStore(A, T0 + PRUNE_AFTER_MS * 2).orders).toEqual([])
    localStorage.setItem(`fw_user_${A.toLowerCase()}_${STORE_KEY}`, '{"orders":"nope"}')
    expect(loadStore(A).orders).toEqual([])
    localStorage.setItem(`fw_user_${A.toLowerCase()}_${STORE_KEY}`, 'not json')
    expect(loadStore(A).orders).toEqual([])
    expect(loadStore(null).orders).toEqual([])
  })

  it('applyToStore returns the SAME record for an illegal event and writes nothing; a legal one persists and notifies', () => {
    const r = at('resting')
    putRecord(A, r)
    let n = 0
    const off = subscribe(() => n++)
    const before = n
    expect(applyToStore(A, '0xo', { type: 'accepted' })).toEqual(r)
    expect(n).toBe(before)
    const moved = applyToStore(A, '0xo', { type: 'venue', status: 'canceled', filledSize: '3' }, T0 + 9)
    expect(moved).toMatchObject({ state: 'cancelled', filledSize: '3', updatedAt: T0 + 9 })
    expect(loadStore(A).orders[0].state).toBe('cancelled')
    expect(n).toBe(before + 1)
    expect(applyToStore(A, 'missing', { type: 'accepted' })).toBeNull()
    off()
  })

  it('bookkeeping patches and removal do not change state', () => {
    putRecord(A, at('unconfirmed'))
    patchRecord(A, '0xo', { absentReads: 2, absentSince: 5 })
    expect(loadStore(A).orders[0]).toMatchObject({ state: 'unconfirmed', absentReads: 2, absentSince: 5, updatedAt: T0 })
    removeRecord(A, '0xo')
    expect(loadStore(A).orders).toEqual([])
  })

  it('is NOT in the backup registry: predict_orders_v1 is device-only', () => {
    const registry = readFileSync(resolve(process.cwd(), 'src/lib/backup/syncedObjects.js'), 'utf-8')
    expect(registry).not.toContain(STORE_KEY)
    expect(registry).not.toContain('predict_orders')
  })
})

describe('trackSignedOrder — the hand-off from the ticket', () => {
  beforeEach(() => localStorage.clear())

  it('an order the venue took: sent, then what its own status says; the id is the venue\'s', () => {
    const r = trackSignedOrder(A, facts, { posted: { orderId: '0xv', status: 'live', computedId: '0xv' } }, T0)
    expect(r).toMatchObject({ orderId: '0xv', state: 'resting', idKnown: true, filledSize: null })
    expect(loadStore(A).idScheme).toBe('verified')
    const m = trackSignedOrder(A, facts, { posted: { orderId: '0xw', status: 'matched', computedId: '0xW' } }, T0)
    expect(m.state).toBe('matched')
    expect(m.filledSize).toBeNull() // the answer's status is not a fill figure
  })

  it('an answer that never arrived: UNCONFIRMED under the computed id — and a record with no id is honest about it', () => {
    const r = trackSignedOrder(A, facts, { unconfirmed: true, reason: 'x', posted: { computedId: '0xc' } }, T0)
    expect(r).toMatchObject({ orderId: '0xc', state: 'unconfirmed', idKnown: true, reason: 'x' })
    const none = trackSignedOrder(A, facts, { unconfirmed: true, posted: { computedId: null } }, T0)
    expect(none.state).toBe('unconfirmed')
    expect(none.idKnown).toBe(false)
    expect(none.orderId).toMatch(/^unsent-/)
  })

  it('a venue id that differs from the computed one marks the scheme `mismatch` (sticky), keyed by the venue\'s id', () => {
    const r = trackSignedOrder(A, facts, { posted: { orderId: '0xvenue', status: 'live', computedId: '0xother' } }, T0)
    expect(r.orderId).toBe('0xvenue')
    expect(loadStore(A).idScheme).toBe('mismatch')
    trackSignedOrder(A, facts, { posted: { orderId: '0xa', status: 'live', computedId: '0xa' } }, T0 + 1)
    expect(loadStore(A).idScheme).toBe('mismatch')
  })

  it('never throws, and does nothing without a wallet', () => {
    expect(trackSignedOrder(null, facts, { posted: {} })).toBeNull()
  })
})
