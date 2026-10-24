/**
 * stakingSource tests (spec 065, US3/T035) — precise entries from the action
 * buffer, first-sight baseline (no retroactive entries), a freshly-ready
 * unbond emitting an ACTIONABLE entry that breaks through a focused profile,
 * idempotent re-runs, and ok:false on a hard read failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const bufferRecords = vi.hoisted(() => ({ current: [] }))
vi.mock('../../lib/staking/stakingActivityBuffer', () => ({
  drainStakingActions: () => bufferRecords.current.splice(0),
}))

const readyKeysByOption = vi.hoisted(() => ({ current: {} }))
const shouldThrow = vi.hoisted(() => ({ current: false }))
vi.mock('../../lib/staking/lidoStaking', () => ({
  readLidoWithdrawalStatuses: async () => {
    if (shouldThrow.current) throw new Error('rpc down')
    return (readyKeysByOption.current['liquid:lido'] || []).map((requestId) => ({ requestId, ready: true, claimed: false }))
  },
}))
vi.mock('../../lib/staking/spolStaking', () => ({ readSpolOpenNonces: async () => [] }))
vi.mock('../../lib/staking/polygonDelegation', () => ({
  readOpenUnbonds: async () => [],
  readStakeManagerTiming: async () => ({ epoch: 100n, withdrawalDelay: 80n }),
}))
import { stakingSource } from '../../data/notifications/sources/stakingSource'

const ACCOUNT = '0xabc'
const CHAIN = 1

beforeEach(() => {
  bufferRecords.current = []
  readyKeysByOption.current = {}
  shouldThrow.current = false
})

describe('stakingSource (spec 065 US3)', () => {
  it('turns a buffered action into a precise entry with a tx link', async () => {
    bufferRecords.current = [
      { type: 'stake', optionId: 'liquid:lido', refId: '0xw', message: 'Staked ETH · Lido', txHash: '0x1', txUrl: 'http://x/tx/0x1', at: 5 },
    ]
    const res = await stakingSource.detect({ account: ACCOUNT, chainId: CHAIN, nowMs: 10, prior: {} })
    const entry = res.entries.find((e) => e.type === 'stake')
    expect(entry).toBeTruthy()
    expect(entry.txUrl).toBe('http://x/tx/0x1')
    expect(entry.domain).toBe('staking')
  })

  it('first sight of a tracked option is a baseline (no ready entry)', async () => {
    readyKeysByOption.current['liquid:lido'] = ['42']
    bufferRecords.current = [{ type: 'unstake-requested', optionId: 'liquid:lido', message: 'x', txHash: '0x2', at: 1 }]
    const res = await stakingSource.detect({ account: ACCOUNT, chainId: CHAIN, nowMs: 10, prior: {} })
    expect(res.entries.some((e) => e.type === 'unbond-ready')).toBe(false)
    expect(res.nextSnapshots['staking:liquid:lido'].readyKeys).toContain('liquid:lido:req:42')
  })

  it('emits an actionable unbond-ready when a new ready exit appears', async () => {
    readyKeysByOption.current['liquid:lido'] = ['42']
    const prior = { snapshots: { 'staking:liquid:lido': { readyKeys: [] } } }
    const res = await stakingSource.detect({ account: ACCOUNT, chainId: CHAIN, nowMs: 10, prior })
    const ready = res.entries.find((e) => e.type === 'unbond-ready')
    expect(ready).toBeTruthy()
    // actionable:true is what lets it break through a focused profile's
    // "action required" exception (notificationProfiles.resolveEntryDelivery).
    expect(ready.actionable).toBe(true)
    expect(res.actionNeededById[ready.id]).toBe(true)
  })

  it('is idempotent — a still-ready exit does not re-emit', async () => {
    readyKeysByOption.current['liquid:lido'] = ['42']
    const prior = { snapshots: { 'staking:liquid:lido': { readyKeys: ['liquid:lido:req:42'] } } }
    const res = await stakingSource.detect({ account: ACCOUNT, chainId: CHAIN, nowMs: 10, prior })
    expect(res.entries.some((e) => e.type === 'unbond-ready')).toBe(false)
  })

  it('returns ok:false on a hard read failure (engine keeps prior slice)', async () => {
    shouldThrow.current = true
    const prior = { snapshots: { 'staking:liquid:lido': { readyKeys: [] } } }
    const res = await stakingSource.detect({ account: ACCOUNT, chainId: CHAIN, nowMs: 10, prior })
    // With no buffered entries and the only tracked read throwing, ok:false.
    expect(res.ok).toBe(false)
  })

  it('is a no-op on a non-staking network', async () => {
    const res = await stakingSource.detect({ account: ACCOUNT, chainId: 137, nowMs: 10, prior: {} })
    expect(res.entries).toHaveLength(0)
  })
})
