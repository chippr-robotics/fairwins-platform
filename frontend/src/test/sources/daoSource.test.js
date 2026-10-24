/**
 * daoSource tests (spec 031 + 042) — enumerates registry AND device-local tracked DAOs, reads each through the
 * per-framework connector, maps state→event with snapshot-diff (first-sight baseline), honest action-needed
 * (vote/queue/execute with degrade), and ok:false on a registry read failure. The connector + registry are
 * mocked; the governor reads route through the connector (framework-agnostic).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const DAO = '0x00000000000000000000000000000000000000da'
const LOCAL_DAO = '0x00000000000000000000000000000000000000b0'
const ACCT = '0x00000000000000000000000000000000000000ac'
const refId = `${DAO}#5`
const NOW = 1_000_000

// NOTE: the hoisted factory runs ABOVE the const declarations above, so it must NOT reference them — use
// literals here; beforeEach resets these with the named constants once they're initialized.
const m = vi.hoisted(() => ({
  proposals: { ok: true, partial: false, proposals: [] },
  voter: { hasVoted: false, votingPower: '10', support: null },
  eta: null,
  registry: {
    count: 1n,
    entry: ['0x00000000000000000000000000000000000000da', 0n, 'Olympia', '0x00000000000000000000000000000000000000ac', 0n],
    throws: false,
  },
  local: [],
}))

vi.mock('../../config/networks', () => ({
  getNetwork: () => ({ capabilities: { clearpath: true }, rpcUrl: 'http://rpc.test' }),
}))
vi.mock('../../utils/rpcProvider', () => ({ makeReadProvider: () => ({}) }))
vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: () => '0x000000000000000000000000000000000000d0a0',
}))
vi.mock('../../lib/clearpath/connectors', () => ({
  getConnector: () => ({
    framework: 0,
    fetchProposals: () => m.proposals,
    readProposalEta: () => m.eta,
    readVoterState: () => m.voter,
  }),
  detectFramework: () => Promise.resolve(0),
}))
// ClearPath is a package now, so its device-tracked list lives in the app's namespaced host store.
// `lib/clearpath/trackedDaos` is the HOST-side reader of that namespace — legitimate, because the
// host implements the namespaces; the isolation rule binds packages, not the host.
vi.mock('../../lib/clearpath/trackedDaos', () => ({ list: () => m.local }))
// The registry read rides the spec-110 seam; the connectors below still take a provider, which is
// why this file keeps both fakes. `m.registry` is unchanged.
vi.mock('../../lib/chains/readContract', async (orig) => ({
  ...(await orig()),
  readContract: (_chainId, { functionName }) => {
    if (functionName === 'externalCount') {
      if (m.registry.throws) throw new Error('rpc down')
      return m.registry.count
    }
    if (functionName === 'getExternalDAO') return m.registry.entry
    throw new Error('unmocked registry read: ' + functionName)
  },
}))

import { daoSource } from '../../data/notifications/sources/daoSource'

beforeEach(() => {
  m.proposals = { ok: true, partial: false, proposals: [{ id: '5', description: '# Fund dev', state: 1, voteStart: '100' }] }
  m.voter = { hasVoted: false, votingPower: '10', support: null }
  m.eta = null
  m.registry = { count: 1n, entry: [DAO, 0n, 'Olympia', ACCT, 0n], throws: false }
  m.local = []
})

const detect = (prior = { snapshots: {}, aux: {} }) =>
  daoSource.detect({ account: ACCT, chainId: 63, nowMs: NOW, prior })

describe('daoSource (spec 031 + 042)', () => {
  it('first sight records a baseline snapshot and emits no entries', async () => {
    const res = await detect()
    expect(res.ok).toBe(true)
    expect(res.entries).toEqual([])
    expect(res.nextSnapshots[refId].state).toBe(1)
  })

  it('flags an active proposal the user can still vote on as action-needed: vote', async () => {
    expect((await detect()).actionNeededById[refId]).toBe('vote')
  })

  it('honestly degrades vote eligibility (no badge) when the user already voted', async () => {
    m.voter = { hasVoted: true, votingPower: '10', support: 1 }
    expect((await detect()).actionNeededById[refId]).toBeNull()
  })

  it('honestly degrades when the connector cannot confirm eligibility (null power)', async () => {
    m.voter = { hasVoted: null, votingPower: null, support: null }
    expect((await detect()).actionNeededById[refId]).toBeNull()
  })

  it('emits a ready-to-queue entry + action on Active→Succeeded', async () => {
    m.proposals = { ok: true, partial: false, proposals: [{ id: '5', description: '# Fund dev', state: 4, voteStart: '100' }] }
    const res = await detect({ snapshots: { [refId]: { state: 1, snappedAt: 0 } }, aux: {} })
    expect(res.entries.map((e) => e.type)).toEqual(['ready-to-queue'])
    expect(res.entries[0]).toMatchObject({ domain: 'dao', refId, actionable: true })
    expect(res.actionNeededById[refId]).toBe('queue')
  })

  it('emits "queued" (execute only when ETA elapsed) and Executed→finalized (no action)', async () => {
    m.eta = 500 // elapsed: 500*1000 <= NOW
    m.proposals = { ok: true, partial: false, proposals: [{ id: '5', description: '# Fund', state: 5, voteStart: '100' }] }
    let res = await detect({ snapshots: { [refId]: { state: 4 } }, aux: {} })
    expect(res.entries.map((e) => e.type)).toEqual(['queued'])
    expect(res.actionNeededById[refId]).toBe('execute')

    m.proposals = { ok: true, partial: false, proposals: [{ id: '5', description: '# Fund', state: 7, voteStart: '100' }] }
    res = await detect({ snapshots: { [refId]: { state: 5 } }, aux: {} })
    expect(res.entries.map((e) => e.type)).toEqual(['finalized'])
    expect(res.actionNeededById[refId]).toBeNull()
  })

  it('honestly degrades execute when the ETA is unreadable (no faked executability)', async () => {
    m.eta = null
    m.proposals = { ok: true, partial: false, proposals: [{ id: '5', description: '# Fund', state: 5, voteStart: '100' }] }
    const res = await detect({ snapshots: { [refId]: { state: 5 } }, aux: {} })
    expect(res.actionNeededById[refId]).toBeNull()
  })

  it('does not flag execute until the timelock ETA has elapsed', async () => {
    m.eta = Math.floor(NOW / 1000) + 3600 // 1h in the future
    m.proposals = { ok: true, partial: false, proposals: [{ id: '5', description: '# Fund', state: 5, voteStart: '100' }] }
    const res = await detect({ snapshots: { [refId]: { state: 5 } }, aux: {} })
    expect(res.actionNeededById[refId]).toBeNull()
  })

  it('skips a proposal whose state() reverted (null) — no spurious entry, carries prior, marks partial', async () => {
    m.proposals = { ok: true, partial: false, proposals: [{ id: '5', description: '# Fund', state: null }] }
    const res = await detect({ snapshots: { [refId]: { state: 1 } }, aux: {} })
    expect(res.entries).toEqual([])
    expect(res.partial).toBe(true)
    expect(res.nextSnapshots[refId]).toEqual({ state: 1 })
  })

  it('returns ok:false when the registry read fails', async () => {
    m.registry.throws = true
    expect((await detect()).ok).toBe(false)
  })

  it('marks partial when a DAO proposal scan degrades', async () => {
    m.proposals = { ok: true, partial: true, proposals: [] }
    expect((await detect()).partial).toBe(true)
  })

  it('spec 042: includes a device-local tracked DAO even when it is not in the registry', async () => {
    m.registry = { count: 0n, entry: [], throws: false } // registry empty
    m.local = [{ address: LOCAL_DAO, framework: 0, label: 'ENS', addedAt: 1 }]
    m.proposals = { ok: true, partial: false, proposals: [{ id: '9', description: '# Local', state: 1, voteStart: '100' }] }
    const res = await detect()
    expect(res.ok).toBe(true)
    expect(res.nextSnapshots[`${LOCAL_DAO}#9`]).toBeTruthy()
  })
})
