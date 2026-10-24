// Spec 105 (T-004/T-005) — plain-language proposal decode. The null cases are the feature: an
// unknown calldata or an unknown token's amount is NEVER guessed — the caller keeps the honest
// raw rendering (constitution III).

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config/contracts', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    getContractAddressForChain: vi.fn((name) => {
      if (name === 'safePolicyGuardV2') return '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c'
      if (name === 'policyGuardSetup') return '0xD0CB9D0ca2E56e9552cb833eC6D16F86ce818C2b'
      return null
    }),
  }
})

import { Interface } from 'ethers'
import { describeProposal, needsYou } from '../../lib/custody/describeProposal'

const VAULT = '0xaBCdEf0000000000000000000000000000000001'
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const ME = '0x1111111111111111111111111111111111111111'
const O2 = '0x2222222222222222222222222222222222222222'
const GUARD = '0xf18B813Ad8C01249FE904A732543A1b8E6CAfd0c'

const erc20 = new Interface(['function transfer(address,uint256)'])
const mgmt = new Interface([
  'function addOwnerWithThreshold(address,uint256)',
  'function changeThreshold(uint256)',
])
const guardIface = new Interface([
  'function setRules((address,uint128,uint128,uint8,bool,address[],address[])[] rules, uint32 cooldown)',
])

const meta = { [USDC]: { symbol: 'USDC', decimals: 6 } }

describe('describeProposal', () => {
  it('describes an ERC-20 transfer with known meta as amount + recipient', () => {
    const d = describeProposal(
      { to: USDC, value: 0n, data: erc20.encodeFunctionData('transfer', [O2, 200_000000n]) },
      { chainId: 137, vaultAddress: VAULT, assetMeta: meta },
    )
    expect(d.kind).toBe('transfer-erc20')
    expect(d.title).toBe('Send 200 USDC')
    expect(d.detail).toMatch(/^to 0x2222/)
  })
  it('resolves the recipient through the caller identity seam', () => {
    const d = describeProposal(
      { to: USDC, value: 0n, data: erc20.encodeFunctionData('transfer', [O2, 5_000000n]) },
      { chainId: 137, assetMeta: meta, resolveName: () => 'Studio treasury' },
    )
    expect(d.detail).toBe('to Studio treasury')
  })
  it('an UNKNOWN token transfer returns null — a wrong-decimals amount is worse than calldata', () => {
    const d = describeProposal(
      { to: O2, value: 0n, data: erc20.encodeFunctionData('transfer', [ME, 1n]) },
      { chainId: 137, assetMeta: meta },
    )
    expect(d).toBeNull()
  })
  it('describes a native send only when the symbol is knowable', () => {
    const withSymbol = describeProposal({ to: O2, value: 1500000000000000000n, data: '0x' }, { nativeSymbol: 'POL' })
    expect(withSymbol.title).toBe('Send 1.5 POL')
    expect(describeProposal({ to: O2, value: 1n, data: '0x' }, {})).toBeNull()
  })
  it('describes owner management on the vault itself', () => {
    const add = describeProposal(
      { to: VAULT, value: 0n, data: mgmt.encodeFunctionData('addOwnerWithThreshold', [O2, 2n]) },
      { vaultAddress: VAULT },
    )
    expect(add).toMatchObject({ kind: 'add-owner', title: 'Add owner' })
    const thr = describeProposal(
      { to: VAULT, value: 0n, data: mgmt.encodeFunctionData('changeThreshold', [3n]) },
      { vaultAddress: VAULT },
    )
    expect(thr).toMatchObject({ kind: 'change-threshold', detail: '3 required' })
  })
  it('the same management calldata on ANOTHER contract is NOT described as governance', () => {
    const d = describeProposal(
      { to: O2, value: 0n, data: mgmt.encodeFunctionData('changeThreshold', [3n]) },
      { vaultAddress: VAULT },
    )
    expect(d).toBeNull()
  })
  it('classifies policy transactions through the existing classifier', () => {
    const d = describeProposal(
      { to: GUARD, value: 0n, data: guardIface.encodeFunctionData('setRules', [[], 0]) },
      { chainId: 137, vaultAddress: VAULT },
    )
    expect(d).toMatchObject({ kind: 'policy', title: 'Change the vault rules' })
  })
  it('unknown calldata ⇒ null, never a guess', () => {
    expect(describeProposal({ to: O2, value: 0n, data: '0xdeadbeef' }, { chainId: 137 })).toBeNull()
  })
})

describe('needsYou', () => {
  const base = { status: 'pending', owners: [ME, O2], approvers: [] }
  it('true when pending, an owner, and not yet approved', () => {
    expect(needsYou(base, ME)).toBe(true)
  })
  it('false once the member has approved (then it waits on others)', () => {
    expect(needsYou({ ...base, approvers: [ME] }, ME)).toBe(false)
  })
  it('false for a non-owner and for a settled item', () => {
    expect(needsYou(base, '0x9999999999999999999999999999999999999999')).toBe(false)
    expect(needsYou({ ...base, status: 'executed' }, ME)).toBe(false)
  })
  it('case-insensitive on addresses', () => {
    expect(needsYou({ ...base, approvers: [ME.toLowerCase()] }, ME)).toBe(false)
  })
})
