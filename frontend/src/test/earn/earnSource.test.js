/**
 * earnSource tests (spec 050 / spec 031 contract) — buffered user actions
 * become precise entries with tx links; share-balance snapshot-diff is a
 * baseline-first, idempotent backstop; hard read failure returns ok:false.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ fns: {} }))

// Spec 110 Phase 1: earnSource reads through the chain seam; the fixture registry keeps the
// same shape (functionName -> impl, unmocked throws) it had under the ethers Contract proxy.
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: async (_chainId, { functionName, args = [] }) => {
      const fn = m.fns[functionName]
      if (!fn) throw new Error('unmocked contract method: ' + String(functionName))
      return fn(...args)
    },
  }
})

import { earnSource } from '../../data/notifications/sources/earnSource'
import { queueEarnAction, peekEarnActions } from '../../lib/earn/earnActivityBuffer'

const ACCT = '0x00000000000000000000000000000000000000ac'
const VAULT = '0x00000000000000000000000000000000000000a1'
const NOW = 3_000_000
const CHAIN = 137

const detect = (prior = { snapshots: {}, aux: {} }) =>
  earnSource.detect({ account: ACCT, chainId: CHAIN, nowMs: NOW, prior })

beforeEach(() => {
  localStorage.clear()
  m.fns = { balanceOf: async () => 1000n }
})

describe('earnSource (spec 050 FR-010)', () => {
  it('no-ops on networks without earn support', async () => {
    const res = await earnSource.detect({ account: ACCT, chainId: 63, nowMs: NOW, prior: { snapshots: {} } })
    expect(res).toMatchObject({ ok: true, entries: [] })
  })

  it('drains buffered actions into entries with tx links and starts tracking the vault', async () => {
    queueEarnAction(ACCT, CHAIN, {
      type: 'earn-deposit',
      refId: VAULT,
      message: 'Deposited 10 USDC into Prime Vault',
      txHash: '0xhash1',
      txUrl: 'https://polygonscan.com/tx/0xhash1',
      at: NOW - 5,
    })
    const res = await detect()
    expect(res.ok).toBe(true)
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0]).toMatchObject({
      id: `earn:${CHAIN}:earn-deposit:0xhash1`,
      domain: 'earn',
      type: 'earn-deposit',
      txUrl: 'https://polygonscan.com/tx/0xhash1',
      severity: 'success',
    })
    // Buffer drained; vault share balance snapped (baseline for future diffs).
    expect(peekEarnActions(ACCT, CHAIN)).toEqual([])
    expect(res.nextSnapshots[`earn:${VAULT.toLowerCase()}`]).toMatchObject({ shares: '1000' })
    // The action already explains this cycle's change — no duplicate diff entry.
    expect(res.entries.filter((e) => e.type === 'earn-position-changed')).toHaveLength(0)
  })

  it('first sight of a tracked vault is baseline — no retroactive entries', async () => {
    queueEarnAction(ACCT, CHAIN, {
      type: 'earn-deposit',
      refId: VAULT,
      message: 'dep',
      txHash: '0xh',
      txUrl: '',
      at: NOW,
    })
    const first = await detect()
    // Re-run with the produced snapshots and no new actions: idempotent.
    const second = await detect({ snapshots: first.nextSnapshots, aux: {} })
    expect(second.entries).toEqual([])
    expect(second.nextSnapshots).toMatchObject(first.nextSnapshots)
  })

  it('emits a position-changed entry when shares change outside the app', async () => {
    const prior = { snapshots: { [`earn:${VAULT.toLowerCase()}`]: { shares: '500', snappedAt: NOW - 60 } }, aux: {} }
    const res = await detect(prior)
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0]).toMatchObject({ type: 'earn-position-changed', severity: 'info' })
    expect(res.entries[0].message).toMatch(/increased/i)
  })

  it('returns ok:false when every tracked vault read fails (engine keeps prior slice)', async () => {
    m.fns.balanceOf = async () => {
      throw new Error('rpc down')
    }
    const prior = { snapshots: { [`earn:${VAULT.toLowerCase()}`]: { shares: '500', snappedAt: NOW - 60 } }, aux: {} }
    const res = await detect(prior)
    expect(res.ok).toBe(false)
  })
})
