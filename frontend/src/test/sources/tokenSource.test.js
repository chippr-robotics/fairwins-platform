/**
 * tokenSource tests (spec 031, FR-028) — role/pause snapshot-diff (first-sight baseline, change → entry),
 * informational only (no action-needed), ok:false on enumeration failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ fns: {} }))

vi.mock('../../config/contracts', () => ({ getContractAddressForChain: () => '0x000000000000000000000000000000000000fac0' }))
// The seam answers both the availability gate and the reads (spec 110); `m.fns` is unchanged.
vi.mock('../../lib/chains/publicClient', async (orig) => ({
  ...(await orig()),
  getPublicClient: () => ({}),
}))
vi.mock('../../lib/chains/readContract', async (orig) => ({
  ...(await orig()),
  readContract: (_chainId, { functionName, args = [] }) => {
    const fn = m.fns[functionName]
    if (!fn) throw new Error('unmocked contract method: ' + functionName)
    return fn(...args)
  },
}))

import { tokenSource } from '../../data/notifications/sources/tokenSource'

const TOKEN = '0x00000000000000000000000000000000000000a1'
const ACCT = '0x00000000000000000000000000000000000000ac'
const NOW = 2_000_000

beforeEach(() => {
  m.fns = {
    getTokensByIssuer: () => ['1'],
    getToken: () => ({ tokenAddress: TOKEN, symbol: 'ACME', isPausable: true }),
    DEFAULT_ADMIN_ROLE: () => '0xadmin',
    MINTER_ROLE: () => '0xminter',
    PAUSER_ROLE: () => '0xpauser',
    BURNER_ROLE: () => '0xburner',
    hasRole: (role) => role === '0xminter', // user holds minter only
    paused: () => false,
  }
})

const detect = (prior = { snapshots: {}, aux: {} }) =>
  tokenSource.detect({ account: ACCT, chainId: 137, nowMs: NOW, prior })

describe('tokenSource (spec 031)', () => {
  it('first sight records the role/pause snapshot and emits no entries', async () => {
    const res = await detect()
    expect(res.ok).toBe(true)
    expect(res.entries).toEqual([])
    expect(res.nextSnapshots[TOKEN]).toMatchObject({ v2: true, roles: { admin: false, minter: true, pauser: false, burner: false }, paused: false })
    expect(res.actionNeededById).toEqual({}) // informational only
  })

  it('emits role-granted when a role flips false→true vs the prior snapshot', async () => {
    const prior = { snapshots: { [TOKEN]: { v2: true, roles: { admin: false, minter: false, pauser: false, burner: false }, paused: false } }, aux: {} }
    const res = await detect(prior)
    expect(res.entries.map((e) => e.type)).toEqual(['role-granted'])
    expect(res.entries[0]).toMatchObject({ domain: 'token', refId: TOKEN })
    expect(res.entries[0].message).toMatch(/minter role on ACME/i)
  })

  it('emits paused when the token pauses vs prior', async () => {
    m.fns.paused = () => true
    const prior = { snapshots: { [TOKEN]: { v2: true, roles: { admin: false, minter: true, pauser: false, burner: false }, paused: false } }, aux: {} }
    const res = await detect(prior)
    expect(res.entries.map((e) => e.type)).toEqual(['paused'])
  })

  it('does NOT fabricate a role change on a transient read failure (carries prior snapshot)', async () => {
    m.fns.hasRole = () => { throw new Error('transient revert') }
    const prior = { snapshots: { [TOKEN]: { v2: true, roles: { admin: false, minter: true, pauser: false, burner: false }, paused: false } }, aux: {} }
    const res = await detect(prior)
    expect(res.ok).toBe(true)
    expect(res.entries).toEqual([]) // no fabricated revoke/grant
    expect(res.nextSnapshots[TOKEN]).toEqual(prior.snapshots[TOKEN]) // prior carried forward unchanged
  })

  it('treats a v1/Ownable token (no role surface) as a stable baseline (no entries)', async () => {
    m.fns.DEFAULT_ADMIN_ROLE = () => { throw new Error('not AccessControl') }
    const prior = { snapshots: { [TOKEN]: { v2: false } }, aux: {} }
    const res = await detect(prior)
    expect(res.ok).toBe(true)
    expect(res.entries).toEqual([])
    expect(res.nextSnapshots[TOKEN]).toMatchObject({ v2: false })
  })

  it('returns ok:false when token enumeration fails', async () => {
    m.fns.getTokensByIssuer = () => { throw new Error('rpc down') }
    const res = await detect()
    expect(res.ok).toBe(false)
  })
})
