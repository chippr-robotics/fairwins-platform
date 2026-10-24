// Spec 043 (US6 / spec 031) — custodySource snapshot-diff: baseline on first sight, "approval-needed"
// (actionable) when a pending proposal newly needs the member, "executed" and "governance-changed" on diff,
// and a no-op until the hub is configured. The chain reads (readVaultProposalState) are mocked — the source's
// diff logic is the unit under test.
//
// Both mocked reads now report whether their bounded history scan reached the chain head. A stub MUST say
// which it is: an incomplete scan is a live case with its own behaviour (partial, diff nothing), and letting
// it default would let a real caller that forgot to report completeness pass silently.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const H1 = '0x' + '11'.repeat(32)
const OWNER = '0x00000000000000000000000000000000000000a1'
const VAULT = '0x1111111111111111111111111111111111111111'

const readState = vi.fn()
const refs = vi.fn()
const policyCount = vi.fn()

// Mutable so a test can decide what `getCode` answers. The default is a bare object — `getCode`
// is then undefined and calling it throws, which is the "could not even ask" path and keeps a
// failed read classified as unreadable, exactly as before this stub gained a knob.
const providerStub = { current: {} }
vi.mock('../../utils/blockchainService', () => ({ getProvider: () => providerStub.current }))
vi.mock('../../config/safeContracts', () => ({ getSafeContracts: () => ({ multiSendCallOnly: VAULT }) }))
vi.mock('../../config/contracts', () => ({
  getContractAddressForChain: () => '0x000000000000000000000000000000000000abcd',
  getDeploymentBlockForChain: () => 100,
}))
vi.mock('../../lib/custody/vaultReferences', () => ({ loadVaultReferences: (...a) => refs(...a) }))
vi.mock('../../lib/custody/vaultProposalReads', () => ({ readVaultProposalState: (...a) => readState(...a) }))
vi.mock('../../lib/custody/policyEvents', () => ({ readPolicyEventCount: (...a) => policyCount(...a) }))

import { custodySource } from '../../data/notifications/sources/custodySource'

const NOW = 1_700_000_000_000
const base = { owners: [OWNER], threshold: 1, nonce: 5, proposals: [], complete: true }
const pendingNeedingMe = {
  ...base,
  proposals: [{ safeTxHash: H1, status: 'pending', approvers: [], nonce: 5 }],
}

beforeEach(() => {
  providerStub.current = {}
  refs.mockReturnValue([{ chainId: 63, address: VAULT, label: 'Coop', role: 'owner' }])
  readState.mockReset()
  policyCount.mockReset()
  policyCount.mockResolvedValue({ count: 0, complete: true })
})

const sid = `custody:${VAULT}`

describe('custodySource', () => {
  it('is a no-op with no vaults', async () => {
    refs.mockReturnValue([])
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior: {} })
    expect(out.entries).toEqual([])
    expect(out.currentIds).toEqual([])
  })

  it('sets a baseline on first sight without emitting', async () => {
    readState.mockResolvedValue(pendingNeedingMe)
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior: {} })
    expect(out.entries).toEqual([]) // first sight = baseline
    expect(out.nextSnapshots[sid].needMe).toEqual([H1.toLowerCase()])
    expect(out.actionNeededById[sid]).toBe('approve') // still flags action-needed for the badge
  })

  it('emits approval-needed when a new pending proposal needs the member', async () => {
    readState.mockResolvedValue(pendingNeedingMe)
    const prior = { snapshots: { [sid]: { needMe: [], executedCount: 0, govKey: '1:1' } } }
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior })
    const e = out.entries.find((x) => x.type === 'approval-needed')
    expect(e).toBeTruthy()
    expect(e.actionable).toBe(true)
    expect(e.link).toEqual({ to: '/wallet', state: { tab: 'custody', vault: VAULT } })
  })

  it('emits executed and governance-changed on diff', async () => {
    readState.mockResolvedValue({
      owners: [OWNER, '0x00000000000000000000000000000000000000b2'],
      threshold: 2,
      nonce: 6,
      proposals: [{ safeTxHash: H1, status: 'executed', approvers: [OWNER], nonce: 5 }],
      complete: true,
    })
    const prior = { snapshots: { [sid]: { needMe: [], executedCount: 0, govKey: '1:1' } } }
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior })
    expect(out.entries.map((e) => e.type).sort()).toEqual(['executed', 'governance-changed'])
  })

  it('degrades to ok:false when the only vault read fails', async () => {
    readState.mockRejectedValue(new Error('rpc down'))
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior: {} })
    expect(out.ok).toBe(false)
  })

  /*
   * ABSENCE IS NOT AN OUTAGE. A saved reference whose address holds no code on the connected chain
   * is stale or belongs to another chain — it will never resolve, so announcing "will keep
   * retrying" about it is a promise the app cannot keep. The read still fails (a Safe call against
   * a codeless address throws), so the only thing separating the two is the code check.
   */
  it('treats a vault with no code on this chain as absence, not a failure', async () => {
    readState.mockRejectedValue(new Error('could not decode result data'))
    providerStub.current = { getCode: vi.fn().mockResolvedValue('0x') }

    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior: {} })

    expect(out.ok).toBe(true)
    expect(out.entries).toEqual([])
    expect(providerStub.current.getCode).toHaveBeenCalledWith(VAULT)
  })

  it('still reports ok:false when the address IS a contract and the read failed', async () => {
    readState.mockRejectedValue(new Error('rpc down'))
    providerStub.current = { getCode: vi.fn().mockResolvedValue('0x6080604052') }

    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior: {} })

    expect(out.ok).toBe(false)
  })

  // Spec 049 (FR-016) — guard rule events join the same snapshot-diff.
  it('baselines the policy event count on first sight without emitting', async () => {
    readState.mockResolvedValue(base)
    policyCount.mockResolvedValue({ count: 3, complete: true })
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior: {} })
    expect(out.entries).toEqual([])
    expect(out.nextSnapshots[sid].policyEventCount).toBe(3)
  })

  it('emits policy-changed when new guard events appear for a member vault', async () => {
    readState.mockResolvedValue(base)
    policyCount.mockResolvedValue({ count: 4, complete: true })
    const prior = { snapshots: { [sid]: { needMe: [], executedCount: 0, govKey: '1:1', policyEventCount: 2 } } }
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior })
    const e = out.entries.find((x) => x.type === 'policy-changed')
    expect(e).toBeTruthy()
    expect(e.domain).toBe('custody')
    expect(e.message).toMatch(/policy rules on “Coop” changed/i)
    expect(out.nextSnapshots[sid].policyEventCount).toBe(4)
  })

  // The regression this whole change exists for: a bounded history scan that has not finished is NOT a
  // failed read. Reporting ok:false here is what put "Couldn't refresh some activity" in front of every
  // Polygon member with a vault, on every session.
  it('reports partial (not ok:false) while a vault history backfill is still catching up', async () => {
    readState.mockResolvedValue({ ...base, complete: false })
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior: {} })
    expect(out.ok).toBe(true)
    expect(out.partial).toBe(true)
  })

  it('diffs nothing off an incomplete scan, and keeps the prior snapshot + action flag', async () => {
    readState.mockResolvedValue({ ...base, complete: false })
    const prior = { snapshots: { [sid]: { needMe: [H1.toLowerCase()], executedCount: 3, govKey: '1:1' } } }
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior })
    expect(out.entries).toEqual([]) // a half-read history must not look like proposals disappearing
    expect(out.nextSnapshots[sid]).toEqual(prior.snapshots[sid])
    expect(out.actionNeededById[sid]).toBe('approve') // the badge keeps what it knew
  })

  it('keeps the prior policy count while the guard scan is incomplete (no phantom policy-changed)', async () => {
    readState.mockResolvedValue(base)
    policyCount.mockResolvedValue({ count: 4, complete: false })
    const prior = { snapshots: { [sid]: { needMe: [], executedCount: 0, govKey: '1:1', policyEventCount: 2 } } }
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior })
    expect(out.entries.find((x) => x.type === 'policy-changed')).toBeFalsy()
    expect(out.nextSnapshots[sid].policyEventCount).toBe(2)
    expect(out.partial).toBe(true)
  })

  it('keeps the prior policy baseline when the guard read fails (no false diff later)', async () => {
    readState.mockResolvedValue(base)
    policyCount.mockRejectedValue(new Error('rpc down'))
    const prior = { snapshots: { [sid]: { needMe: [], executedCount: 0, govKey: '1:1', policyEventCount: 2 } } }
    const out = await custodySource.detect({ account: OWNER, chainId: 63, nowMs: NOW, prior })
    expect(out.entries.find((x) => x.type === 'policy-changed')).toBeFalsy()
    expect(out.nextSnapshots[sid].policyEventCount).toBe(2)
  })
})
