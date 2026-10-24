/**
 * membershipSource tests (spec 031, FR-029) — tier/expiry snapshot-diff (granted/upgraded/expired),
 * expiring-soon (action: renew, once/day), voucher redeemable (action: redeem), ok:false on read failure.
 *
 * The voucher leg reads event history through `lib/chain/logScan` (bounded + resumable, because the
 * voucher contract is millions of blocks old and public RPCs cap one getLogs at 10,000 blocks). The
 * scanner is mocked here and unit-tested on its own; what these tests pin is that an INCOMPLETE scan
 * never becomes a voucher count — and never downgrades the whole source, whose membership read
 * succeeded.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ fns: {} }))

vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: () => '0x000000000000000000000000000000000000abcd',
  getDeploymentBlockForChain: () => 500,
}))
vi.mock('../../lib/chain/logScan', () => ({ scanLogs: (...a) => m.scan(...a) }))
// Reads and the scan handle both come from the spec-110 seams; `m.fns` is unchanged. The handle
// only needs the shape `scanLogs` is given, and `scanLogs` itself is mocked above.
vi.mock('../../lib/chains/publicClient', async (orig) => ({
  ...(await orig()),
  getPublicClient: () => ({}),
}))
vi.mock('../../lib/chains/eventScan', async (orig) => ({
  ...(await orig()),
  eventScanHandle: () => ({ filters: { Transfer: () => ({}) } }),
}))
vi.mock('../../lib/chains/readContract', async (orig) => ({
  ...(await orig()),
  readContract: (_chainId, { functionName, args = [] }) => {
    const fn = m.fns[functionName]
    if (!fn) throw new Error('unmocked contract method: ' + functionName)
    return fn(...args)
  },
}))

import { membershipSource } from '../../data/notifications/sources/membershipSource'

const ACCT = '0x00000000000000000000000000000000000000ac'
const NOW = 1_700_000_000_000 // ms
const NOW_S = Math.floor(NOW / 1000)
const DAY = 86400

beforeEach(() => {
  m.fns = {
    getMembership: () => ({ tier: 2n, expiresAt: BigInt(NOW_S + 30 * DAY) }), // Silver, 30d out
    ownerOf: () => ACCT,
  }
  m.scan = vi.fn(async () => ({ logs: [], complete: true })) // no vouchers, fully scanned
})

const detect = (prior = { snapshots: {}, aux: {} }, nowMs = NOW) =>
  membershipSource.detect({ account: ACCT, chainId: 137, nowMs, prior })

describe('membershipSource (spec 031)', () => {
  it('first sight records tier/expiry + voucher snapshots and emits no entries', async () => {
    const res = await detect()
    expect(res.ok).toBe(true)
    expect(res.entries).toEqual([])
    expect(res.nextSnapshots.membership).toMatchObject({ tier: 2 })
    expect(res.nextSnapshots.voucher).toMatchObject({ count: 0 })
    expect(res.actionNeededById.membership).toBeUndefined() // not expiring soon
  })

  it('emits membership-upgraded on a tier increase', async () => {
    m.fns.getMembership = () => ({ tier: 3n, expiresAt: BigInt(NOW_S + 30 * DAY) })
    const res = await detect({ snapshots: { membership: { tier: 1, expiresAt: NOW_S } }, aux: {} })
    expect(res.entries.map((e) => e.type)).toEqual(['membership-upgraded'])
    expect(res.entries[0].message).toMatch(/Gold/)
  })

  it('emits membership-expired when the tier drops to None', async () => {
    m.fns.getMembership = () => ({ tier: 0n, expiresAt: BigInt(NOW_S - 10) })
    const res = await detect({ snapshots: { membership: { tier: 2, expiresAt: NOW_S - 10 } }, aux: {} })
    expect(res.entries.map((e) => e.type)).toEqual(['membership-expired'])
  })

  it('flags expiring-soon as action:renew and emits once per day', async () => {
    m.fns.getMembership = () => ({ tier: 2n, expiresAt: BigInt(NOW_S + 3 * DAY) }) // 3 days left
    const res = await detect()
    expect(res.actionNeededById.membership).toBe('renew')
    expect(res.entries.map((e) => e.type)).toContain('membership-expiring')
    // same UTC day → no second expiring entry
    const dayBucket = Math.floor(NOW / 86_400_000)
    const res2 = await detect({ snapshots: { membership: { tier: 2, expiresAt: NOW_S + 3 * DAY } }, aux: { expiringDay: dayBucket } })
    expect(res2.entries.map((e) => e.type)).not.toContain('membership-expiring')
    expect(res2.actionNeededById.membership).toBe('renew') // action still surfaced
  })

  it('flags a redeemable voucher as action:redeem and emits on 0→N transition', async () => {
    m.scan = vi.fn(async () => ({ logs: [{ args: { tokenId: 1n } }, { args: { tokenId: 2n } }], complete: true }))
    m.fns.ownerOf = () => ACCT // both still held
    const res = await detect({ snapshots: { membership: { tier: 2, expiresAt: NOW_S + 30 * DAY }, voucher: { count: 0 } }, aux: {} })
    expect(res.actionNeededById.voucher).toBe('redeemVoucher')
    expect(res.entries.map((e) => e.type)).toContain('voucher-redeemable')
    expect(res.nextSnapshots.voucher.count).toBe(2)
  })

  it('returns ok:false when the membership read fails', async () => {
    m.fns.getMembership = () => { throw new Error('rpc down') }
    const res = await detect()
    expect(res.ok).toBe(false)
  })

  // An unfinished backfill would otherwise announce "you have 1 voucher", then "2", then "3" as the
  // scan walked back through history the member has had all along.
  it('keeps the prior voucher slice while the scan is incomplete, and never counts a partial one', async () => {
    m.scan = vi.fn(async () => ({ logs: [{ args: { tokenId: 1n } }], complete: false }))
    const prior = { snapshots: { membership: { tier: 2, expiresAt: NOW_S + 30 * DAY }, voucher: { count: 0 } }, aux: {} }
    const res = await detect(prior)
    expect(res.ok).toBe(true) // the membership read succeeded — this is not a failed cycle
    expect(res.partial).toBe(true)
    expect(res.entries.map((e) => e.type)).not.toContain('voucher-redeemable')
    expect(res.nextSnapshots.voucher).toEqual({ count: 0 })
  })

  it('marks the cycle partial (never ok:false) when the voucher scan throws', async () => {
    m.scan = vi.fn(async () => { throw new Error('exceed maximum block range: 10000') })
    const res = await detect()
    expect(res.ok).toBe(true)
    expect(res.partial).toBe(true)
    expect(res.nextSnapshots.membership).toMatchObject({ tier: 2 }) // the good half survives
  })
})
