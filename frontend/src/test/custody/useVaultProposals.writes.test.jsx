/**
 * `useVaultProposals` — what the CLASSIC rail actually puts on the wire (spec 110 T028).
 *
 * WHY THIS FILE EXISTS. Every existing test that touches this hook MOCKS IT
 * (`VaultQueueView`, `VaultActionSheet`, `VaultDetailsView` all do
 * `vi.mock('../../hooks/useVaultProposals')`), so the calldata it builds had no coverage at all —
 * on the path that moves funds out of a multisig. The conversion off ethers' `Interface` was
 * checked in a probe before it was made, but a probe is not a regression guard.
 *
 * The selectors below are FROZEN literals from the Safe v1.4.1 ABI, not recomputed here: an
 * assertion that hashes the signature with the same library the code uses would prove only that
 * it equals itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { ethers as realEthers } from 'ethers'
import { SAFE_ABI } from '../../abis/Safe'

const VAULT = '0x1111111111111111111111111111111111111111'
const OWNER_A = '0x52502d049571C7893447b86c4d8B38e6184bF6e1'
const CHAIN = 137
const SAFE_TX_HASH = `0x${'ab'.repeat(32)}`

/** keccak256("approveHash(bytes32)")[0..4] and execTransaction(...)[0..4], from the Safe ABI. */
const APPROVE_HASH_SELECTOR = '0xd4d9bdcd'
const EXEC_TRANSACTION_SELECTOR = '0x6a761202'

const sent = []
const signer = {
  sendTransaction: vi.fn(async (tx) => {
    sent.push(tx)
    return { hash: '0xdeadbeef', wait: async () => ({ hash: '0xdeadbeef' }) }
  }),
}

let walletCtx
vi.mock('../../hooks', () => ({ useWallet: () => walletCtx }))
vi.mock('../../config/contracts', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    getContractAddressForChain: (name) =>
      name === 'safeProposalHub' ? '0x3333333333333333333333333333333333333333' : '',
    getDeploymentBlockForChain: () => 1,
  }
})
// The hook's reads are not what this file is about; it asserts on the WRITES.
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return { ...actual, readContract: async () => undefined }
})
vi.mock('../../lib/chains/eventScan', () => ({ eventScanHandle: () => null }))
vi.mock('../../lib/custody/vaultProposalReads', () => ({
  readVerifiedProposals: async () => ({ proposals: [], complete: true }),
  readExecutionOutcomes: async () => ({ executed: new Set(), failed: new Set(), complete: true }),
  emitProposal: vi.fn(async () => {}),
  cancelProposal: vi.fn(async () => {}),
  emitProposalCall: () => ({ target: VAULT, data: '0x', value: 0n }),
  cancelProposalCall: () => ({ target: VAULT, data: '0x', value: 0n }),
}))

import { useVaultProposals } from '../../hooks/useVaultProposals'
import { buildPrevalidatedSignatures, encodeExecTransaction } from '../../lib/custody/vaultTransaction'

const decode = (tx) => new realEthers.Interface(SAFE_ABI).parseTransaction({ data: tx.data })

describe('useVaultProposals — classic-rail calldata', () => {
  beforeEach(() => {
    sent.length = 0
    signer.sendTransaction.mockClear()
    walletCtx = {
      chainId: CHAIN,
      signer,
      provider: {},
      sendCalls: vi.fn(),
      loginMethod: 'injected',
    }
  })

  it('approve() sends approveHash(safeTxHash) TO THE VAULT', async () => {
    const { result } = renderHook(() => useVaultProposals({ isSafe: true, address: VAULT }))
    await act(async () => {
      await result.current.approve(SAFE_TX_HASH)
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe(VAULT) // an ethers Contract fake would have ignored this
    expect(sent[0].data.slice(0, 10)).toBe(APPROVE_HASH_SELECTOR)
    const parsed = decode(sent[0])
    expect(parsed.name).toBe('approveHash')
    expect(parsed.args[0]).toBe(SAFE_TX_HASH)
  })

  it('execute() sends execTransaction with the ten ordered args and the signature blob', async () => {
    const safeTx = {
      to: OWNER_A,
      value: 0n,
      data: '0x',
      operation: 0,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: `0x${'0'.repeat(40)}`,
      refundReceiver: `0x${'0'.repeat(40)}`,
    }
    const { result } = renderHook(() => useVaultProposals({ isSafe: true, address: VAULT }))
    await act(async () => {
      await result.current.execute({ status: 'ready', safeTx, approvers: [OWNER_A] })
    })

    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe(VAULT)
    expect(sent[0].data.slice(0, 10)).toBe(EXEC_TRANSACTION_SELECTOR)
    const parsed = decode(sent[0])
    expect(parsed.name).toBe('execTransaction')
    expect(Array.from(parsed.args)).toHaveLength(10)

    // ── THE BYTES, AGAINST ETHERS ───────────────────────────────────────────────────────────
    // The calldata is built by viem now; this encodes the identical call with ethers and compares.
    // It is what caught divergence 17 in this path: viem preserves the hex CASE it is handed, and
    // the signature blob is built from a CHECKSUMMED address, so the two strings differed until
    // `buildPrevalidatedSignatures` lowercased its padded owner. The bytes were always the same —
    // this pins the string too, so a future byte comparison is not a surprise.
    const expected = new realEthers.Interface(SAFE_ABI).encodeFunctionData(
      'execTransaction',
      encodeExecTransaction(safeTx, buildPrevalidatedSignatures([OWNER_A])),
    )
    expect(sent[0].data).toBe(expected)
  })

  it('refuses to execute a proposal that is not ready, before touching the wallet', async () => {
    const { result } = renderHook(() => useVaultProposals({ isSafe: true, address: VAULT }))
    await expect(
      result.current.execute({ status: 'pending', safeTx: {}, approvers: [OWNER_A] }),
    ).rejects.toThrow(/not ready/i)
    expect(sent).toEqual([])
  })
})
