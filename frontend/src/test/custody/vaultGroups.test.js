// Spec 102 (T001) — one vault per address, every network folded in. The grouping is a VIEW over the
// unchanged (chainId, address) store, and every field it derives is held to constitution III:
// a threshold comes from a READABLE instance or is null, an unreachable chain is named, and a
// queue count exists only for a chain that was actually read.

import { describe, it, expect } from 'vitest'
import { groupVaults, pickVaultChain, summarizeQueue, listChainNames } from '../../lib/custody/vaultGroups'

const A = '0xAbCdEf0000000000000000000000000000000001'
const B = '0x0000000000000000000000000000000000000B0B'
const ME = '0x1111111111111111111111111111111111111111'
const O2 = '0x2222222222222222222222222222222222222222'
const O3 = '0x3333333333333333333333333333333333333333'

const safe = (address, chainId, extra = {}) => ({
  address,
  chainId,
  label: '',
  isSafe: true,
  reachable: true,
  owners: [ME, O2, O3],
  threshold: 2,
  owner: true,
  ...extra,
})

describe('groupVaults', () => {
  it('folds mixed-case spellings of one address into ONE group, preserving instance order', () => {
    const groups = groupVaults([
      safe(A, 137),
      safe(B, 63),
      safe(A.toLowerCase(), 8453),
      safe(A, 10),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].key).toBe(A.toLowerCase())
    expect(groups[0].address).toBe(A) // first instance's spelling
    expect(groups[0].chainIds).toEqual([137, 8453, 10])
    expect(groups[0].instances.map((i) => i.chainId)).toEqual([137, 8453, 10])
    expect(groups[1].key).toBe(B.toLowerCase())
  })

  it('network line: a single known chain by name, several as a count, an unknown chain as "Chain <id>"', () => {
    expect(groupVaults([safe(A, 137)])[0].networkLine).toBe('Polygon')
    expect(groupVaults([safe(A, 137), safe(A, 8453)])[0].networkLine).toBe('2 networks')
    expect(groupVaults([safe(A, 999)])[0].networkLine).toBe('Chain 999')
  })

  it('takes the threshold from the FIRST readable instance and flags disagreement', () => {
    const agree = groupVaults([safe(A, 137), safe(A, 8453)])[0]
    expect(agree.threshold).toEqual({ value: 2, of: 3 })
    expect(agree.thresholdVaries).toBe(false)

    const unreachableFirst = groupVaults([
      { address: A, chainId: 63, reachable: false, isSafe: undefined, loadError: 'RPC down' },
      safe(A, 137, { threshold: 3 }),
    ])[0]
    expect(unreachableFirst.threshold).toEqual({ value: 3, of: 3 }) // first READABLE, not first instance

    const disagree = groupVaults([safe(A, 137), safe(A, 8453, { threshold: 1, owners: [ME, O2] })])[0]
    expect(disagree.threshold).toEqual({ value: 2, of: 3 })
    expect(disagree.thresholdVaries).toBe(true)
  })

  it('keeps a group whose only instance is unreachable — threshold null, chain named, never "0 of 0"', () => {
    const [g] = groupVaults([{ address: A, chainId: 63, reachable: false, isSafe: undefined, loadError: 'RPC down' }])
    expect(g.threshold).toBeNull()
    expect(g.thresholdVaries).toBe(false)
    expect(g.unreachable).toEqual([63])
    expect(g.readable).toEqual([])
    expect(g.owners).toEqual([])
    expect(g.networkLine).toMatch(/mordor/i)
  })

  it('separates "reachable but not a Safe there" from "unreachable"', () => {
    const [g] = groupVaults([
      safe(A, 137),
      { address: A, chainId: 8453, reachable: true, isSafe: false, reason: 'no-contract' },
      { address: A, chainId: 10, reachable: false, isSafe: undefined },
    ])
    expect(g.unreadable).toEqual([8453])
    expect(g.unreachable).toEqual([10])
    expect(g.chainIds).toEqual([137, 8453, 10]) // nothing dropped
  })

  it('unions owners across readable instances, deduped case-insensitively', () => {
    const [g] = groupVaults([
      safe(A, 137, { owners: [ME, O2] }),
      safe(A, 8453, { owners: [O2.toLowerCase(), O3] }),
      { address: A, chainId: 10, reachable: false, isSafe: undefined, owners: ['0xstale'] },
    ])
    expect(g.owners).toEqual([ME, O2, O3])
  })

  it('reports ownership per chain: anyOwner + ownerChainIds', () => {
    const [g] = groupVaults([safe(A, 137, { owner: false }), safe(A, 8453, { owner: true })])
    expect(g.anyOwner).toBe(true)
    expect(g.ownerChainIds).toEqual([8453])
    expect(groupVaults([safe(A, 137, { owner: false })])[0].anyOwner).toBe(false)
  })

  it('pins the wallet chain when the vault is on it, else the first instance; connectedInstance follows', () => {
    const onWallet = groupVaults([safe(A, 137), safe(A, 8453)], { walletChainId: 8453 })[0]
    expect(onWallet.pinnedChainId).toBe(8453)
    expect(onWallet.connectedInstance?.chainId).toBe(8453)

    const elsewhere = groupVaults([safe(A, 137), safe(A, 8453)], { walletChainId: 1 })[0]
    expect(elsewhere.pinnedChainId).toBe(137)
    expect(elsewhere.connectedInstance).toBeNull()
  })

  it('takes the first non-empty label and the first readable policy badge', () => {
    const [g] = groupVaults([
      safe(A, 137, { label: '' }),
      safe(A, 8453, { label: 'Treasury', policyStatus: 'managed-v2', policySummary: '3 ordered rules' }),
    ])
    expect(g.label).toBe('Treasury')
    expect(g.policyStatus).toBe('managed-v2')
    expect(g.policySummary).toBe('3 ordered rules')
  })

  it('returns no groups for an empty or absent list', () => {
    expect(groupVaults([])).toEqual([])
    expect(groupVaults(undefined)).toEqual([])
  })
})

describe('pickVaultChain', () => {
  it('honours preferred > wallet chain > first, but only among chains the vault is on', () => {
    expect(pickVaultChain({ chainIds: [137, 8453], walletChainId: 8453, preferred: 137 })).toBe(137)
    expect(pickVaultChain({ chainIds: [137, 8453], walletChainId: 8453 })).toBe(8453)
    expect(pickVaultChain({ chainIds: [137, 8453], walletChainId: 1 })).toBe(137)
    // A preferred chain the vault is NOT on is ignored, not trusted.
    expect(pickVaultChain({ chainIds: [137, 8453], walletChainId: 8453, preferred: 1 })).toBe(8453)
    expect(pickVaultChain({ chainIds: ['137'], walletChainId: '137' })).toBe(137)
    expect(pickVaultChain({ chainIds: [] })).toBeNull()
    expect(pickVaultChain({})).toBeNull()
  })
})

describe('summarizeQueue', () => {
  const queued = (n) => Array.from({ length: n }, (_, i) => ({ safeTxHash: `0x${i}`, status: i % 2 ? 'ready' : 'pending' }))

  it('counts queued proposals across read chains and names the network count', () => {
    const s = summarizeQueue({
      137: { state: 'read', proposals: [...queued(2), { safeTxHash: '0xdone', status: 'executed' }] },
      8453: { state: 'read', proposals: queued(1) },
    })
    expect(s.pending).toBe(3)
    expect(s.networks).toBe(2)
    expect(s.missing).toEqual([])
    expect(s.partial).toBe(false)
    expect(s.line).toBe('3 pending across 2 networks')
  })

  it('names a chain that was not read and marks the total partial — never a count for it', () => {
    const s = summarizeQueue({
      137: { state: 'read', proposals: queued(2) },
      10: { state: 'unreadable', error: 'RPC down', proposals: [] },
    })
    expect(s.pending).toBe(2)
    expect(s.networks).toBe(1)
    expect(s.missing).toEqual([10])
    expect(s.partial).toBe(true)
    expect(s.line).toBe('2 pending · Optimism not read')
  })

  it('treats not-configured and not-supported as missing too, and never counts their proposals', () => {
    const s = summarizeQueue({
      137: { state: 'read', proposals: queued(1) },
      61: { state: 'not-configured', proposals: queued(5) }, // a stray count must not leak in
      999: { state: 'not-supported' },
    })
    expect(s.pending).toBe(1)
    expect(s.missing).toEqual([61, 999])
    expect(s.line).toBe('1 pending · Ethereum Classic, Chain 999 not read')
  })

  it('reports a loading chain separately rather than calling it "not read"', () => {
    const s = summarizeQueue({ 137: { state: 'read', proposals: [] }, 8453: { state: 'loading' } })
    expect(s.loading).toEqual([8453])
    expect(s.missing).toEqual([])
    expect(s.line).toBe('0 pending')
  })

  it('flags an incomplete backfill as partial and says so', () => {
    const s = summarizeQueue({ 137: { state: 'read', proposals: queued(1), partial: true } })
    expect(s.partial).toBe(true)
    expect(s.line).toBe('1 pending · Polygon still catching up')
  })

  it('handles an empty map', () => {
    expect(summarizeQueue({})).toMatchObject({ pending: 0, networks: 0, missing: [], partial: false, line: '0 pending' })
    expect(summarizeQueue(undefined).pending).toBe(0)
  })
})

describe('listChainNames', () => {
  it('joins with commas and a final "and", no Oxford comma; unknown chains by id', () => {
    expect(listChainNames([137])).toBe('Polygon')
    expect(listChainNames([137, 8453])).toBe('Polygon and Base')
    expect(listChainNames([137, 8453, 10])).toBe('Polygon, Base and Optimism')
    expect(listChainNames([137, 999])).toBe('Polygon and Chain 999')
    expect(listChainNames([])).toBe('')
  })
})
