// Spec 105 (T-001/T-005) — the creation record store. The refusing cases are the feature: a record
// is the initializer replay input for a deployed address and can never legitimately change, so
// overwrite-with-different is a thrown error and a conflicting backup merge is REPORTED, never
// silently adopted.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  sanitizeCreationRecord,
  loadCreationRecords,
  getCreationRecord,
  saveCreationRecord,
  mergeCreationRecords,
  creationRecordsEqual,
} from '../../lib/custody/vaultCreationRecords'

const ACCT = '0x1111111111111111111111111111111111111111'
const VAULT = '0xaBCdEf0000000000000000000000000000000001'
const O1 = '0x2222222222222222222222222222222222222222'
const O2 = '0x3333333333333333333333333333333333333333'

const rec = (extra = {}) => ({
  address: VAULT,
  owners: [O1, O2],
  threshold: 1,
  saltNonce: '1757100000000',
  presetType: 'joint',
  rules: { dailyCapAmount: '500', cooldownSeconds: 3600, allowedMoney: 'stable', bigSends: 'everyone' },
  createdAt: 1757100000000,
  ...extra,
})

beforeEach(() => localStorage.clear())

describe('sanitizeCreationRecord', () => {
  it('normalizes addresses and stringifies the saltNonce', () => {
    const r = sanitizeCreationRecord(rec({ saltNonce: 123n }))
    expect(r.address).toBe(VAULT)
    expect(r.saltNonce).toBe('123')
    expect(r.owners).toHaveLength(2)
  })
  it('rejects structural garbage rather than storing it', () => {
    expect(sanitizeCreationRecord(rec({ owners: [] }))).toBeNull()
    expect(sanitizeCreationRecord(rec({ threshold: 3 }))).toBeNull() // > owners.length
    expect(sanitizeCreationRecord(rec({ saltNonce: 'not-a-number' }))).toBeNull()
    expect(sanitizeCreationRecord(rec({ address: 'nope' }))).toBeNull()
  })
})

describe('save / load', () => {
  it('round-trips and reads back by address', () => {
    saveCreationRecord(ACCT, rec())
    expect(getCreationRecord(ACCT, VAULT)?.presetType).toBe('joint')
    expect(getCreationRecord(ACCT, VAULT.toLowerCase())?.address).toBe(VAULT)
  })
  it('saving the identical record twice is a no-op', () => {
    saveCreationRecord(ACCT, rec())
    saveCreationRecord(ACCT, rec())
    expect(loadCreationRecords(ACCT)).toHaveLength(1)
  })
  it('REFUSES to overwrite with a differing record — the replay input never changes', () => {
    saveCreationRecord(ACCT, rec())
    expect(() => saveCreationRecord(ACCT, rec({ threshold: 2 }))).toThrow(/different creation record/i)
    expect(getCreationRecord(ACCT, VAULT).threshold).toBe(1)
  })
  it('absence is a first-class state (no record ⇒ null, not a guess)', () => {
    expect(getCreationRecord(ACCT, O1)).toBeNull()
  })
})

describe('merge', () => {
  it('unions by address deterministically in both directions', () => {
    const other = rec({ address: '0x00000000000000000000000000000000000000A1', owners: [O1], threshold: 1 })
    const ab = mergeCreationRecords([rec()], [other])
    const ba = mergeCreationRecords([other], [rec()])
    expect(ab.value.map((r) => r.address)).toEqual(ba.value.map((r) => r.address))
    expect(ab.conflicts).toEqual([])
  })
  it('existing entry wins and a conflicting incoming record is REPORTED', () => {
    const { value, conflicts } = mergeCreationRecords([rec()], [rec({ saltNonce: '999' })])
    expect(value[0].saltNonce).toBe('1757100000000')
    expect(conflicts).toEqual([{ key: VAULT, kind: 'creation-record-mismatch' }])
  })
  it('equality is over every replay-relevant field including owner order', () => {
    expect(creationRecordsEqual(sanitizeCreationRecord(rec()), sanitizeCreationRecord(rec()))).toBe(true)
    expect(
      creationRecordsEqual(sanitizeCreationRecord(rec()), sanitizeCreationRecord(rec({ owners: [O2, O1] }))),
    ).toBe(false)
  })
})
