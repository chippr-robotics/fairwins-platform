/**
 * useVouchers — passkey rail (spec 041/050). A passkey smart-account session has no ethers signer,
 * so buy/gift/redeem/transfer must route through WalletContext.sendCalls (one sponsored UserOp,
 * approve+action batched) instead of throwing "Connect a wallet". Reads go through the chain seam.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

vi.mock('../hooks/useWalletManagement', () => ({ useWallet: vi.fn() }))
vi.mock('../config/contracts', () => ({
  getContractAddressForChain: vi.fn(
    (key) =>
      ({
        membershipVoucher: '0x' + 'a1'.repeat(20),
        membershipManager: '0x' + 'b2'.repeat(20),
        voucherBatchMinter: '0x' + 'c3'.repeat(20),
        paymentToken: '0x' + 'd4'.repeat(20),
      }[key] ?? null)
  ),
  getDeploymentBlockForChain: vi.fn(() => 0),
}))
// The redeem gasless seam is signer-only; stub it so the passkey branch (which bypasses it) is isolated.
vi.mock('../lib/relay/useGaslessWrite', () => ({ useGaslessWrite: () => ({ run: vi.fn() }) }))

/**
 * Spec 110: the reads go through the chain seam, so the seam is what is faked. The
 * `vi.mock('ethers')` that stood here installed a `FakeContract(_addr, abi)` — note the
 * underscore: it discarded the address, so a tier-config read against the TOKEN or an allowance
 * read against the MANAGER would have satisfied every assertion below. Each read is recorded with
 * its chain, address and arguments now, and the purchase path asserts them.
 *
 * ethers stays imported, unmocked, as the calldata oracle: the redeem tests decode what this hook
 * encoded with `Interface.decodeFunctionData`, which only means something if it is the real one.
 */
const reads = []
vi.mock('../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      reads.push({ chainId, address, functionName, args })
      if (functionName === 'getTierConfig') return { active: true, priceUSDC: 1_000000n }
      if (functionName === 'allowance') return 0n
      throw new Error(`unexpected read: ${functionName}`)
    },
  }
})

import { getAddress } from 'ethers'
import { useWallet } from '../hooks/useWalletManagement'
import { useVouchers } from '../hooks/useVouchers'
import { MEMBERSHIP_MANAGER_ABI } from '../abis/MembershipManager'
import { getCurrentDocument } from '../utils/legalDocs'

const MANAGER = '0x' + 'b2'.repeat(20)
const VOUCHER = '0x' + 'a1'.repeat(20)
const MINTER = '0x' + 'c3'.repeat(20)
const TOKEN = '0x' + 'd4'.repeat(20)
const ACCOUNT = '0x' + '11'.repeat(20)
const OTHER = '0x' + '22'.repeat(20)
const ROLE = '0x' + '00'.repeat(31) + '01'

function passkeyWallet(sendCalls) {
  return { account: ACCOUNT, signer: null, provider: {}, chainId: 137, sendCalls, loginMethod: 'passkey' }
}

describe('useVouchers passkey rail (sendCalls, no signer)', () => {
  let sendCalls
  beforeEach(() => {
    sendCalls = vi.fn().mockResolvedValue({ txHash: '0xdead', sponsored: true })
    useWallet.mockReturnValue(passkeyWallet(sendCalls))
    reads.length = 0
  })

  it('buy one for yourself → sendCalls([approve, mint]); never "Connect a wallet"', async () => {
    const { result } = renderHook(() => useVouchers())
    let res
    await act(async () => {
      res = await result.current.mintVouchers(ROLE, 1, 1, '')
    })
    expect(sendCalls).toHaveBeenCalledTimes(1)
    const calls = sendCalls.mock.calls[0][0]
    expect(calls).toHaveLength(2)
    expect(calls[0].target).toBe(TOKEN) // approve
    expect(calls[1].target).toBe(VOUCHER) // mint on the immutable voucher
    expect(res.txHash).toBe('0xdead')
    expect(res.gift).toBe(false)
    // The price came from the MANAGER and the allowance from the PAYMENT TOKEN, both on the
    // session's chain — the two facts the address-discarding Contract fake could not distinguish.
    expect(reads).toEqual([
      { chainId: 137, address: MANAGER, functionName: 'getTierConfig', args: [ROLE, 1] },
      // Checksummed: the hook normalises every address before it reaches an encoder or the seam
      // (divergence 16), so the raw-config casing is not what the read is made with.
      { chainId: 137, address: TOKEN, functionName: 'allowance', args: [getAddress(ACCOUNT), getAddress(VOUCHER)] },
    ])
  })

  it('gift / quantity>1 → sendCalls([approve(minter), mintBatch])', async () => {
    const { result } = renderHook(() => useVouchers())
    await act(async () => {
      await result.current.mintVouchers(ROLE, 1, 2, OTHER)
    })
    const calls = sendCalls.mock.calls[0][0]
    expect(calls[0].target).toBe(TOKEN) // approve the batch minter
    expect(calls[1].target).toBe(MINTER) // mintBatch
    // A gift approves the MINTER, not the voucher — the spender is what the allowance is read for.
    expect(reads[1]).toEqual({
      chainId: 137, address: TOKEN, functionName: 'allowance',
      args: [getAddress(ACCOUNT), getAddress(MINTER)],
    })
  })

  it('redeem → sendCalls([redeemVoucher on the manager])', async () => {
    const { result } = renderHook(() => useVouchers())
    await act(async () => {
      await result.current.redeemVoucher('7', undefined)
    })
    expect(sendCalls).toHaveBeenCalledTimes(1)
    expect(sendCalls.mock.calls[0][0][0].target).toBe(MANAGER)
  })

  // Spec 026 FR-013/SC-005 (audit finding): passing no termsHash must still no-op honestly
  // (ZeroHash), never crash — but the real fix is the next test, which proves a resolved
  // hash actually reaches the contract call instead of being dropped.
  it('redeem with no termsHash encodes the zero hash (contract-side no-op), not garbage', async () => {
    const { result } = renderHook(() => useVouchers())
    await act(async () => {
      await result.current.redeemVoucher('7', undefined)
    })
    const iface = new (await vi.importActual('ethers')).ethers.Interface(MEMBERSHIP_MANAGER_ABI)
    const [voucherId, acceptedTermsHash] = iface.decodeFunctionData(
      'redeemVoucher',
      sendCalls.mock.calls[0][0][0].data,
    )
    expect(voucherId.toString()).toBe('7')
    expect(acceptedTermsHash).toBe('0x' + '00'.repeat(32))
  })

  // This is the actual regression the audit finding named: VouchersPage used to call
  // redeemVoucher(id, undefined), so no rail — including this passkey one — ever recorded
  // Terms acceptance. Assert the SAME hash the purchase rail resolves
  // (getCurrentDocument('terms').hash, see PremiumPurchaseModal.jsx) reaches the encoded
  // contract call, normalized to 0x-bytes32, when the caller supplies it.
  it('redeem with the current in-force terms hash encodes that hash, not the zero hash', async () => {
    const acceptedTermsHash = getCurrentDocument('terms').hash // bare 64-char hex, no 0x
    const { result } = renderHook(() => useVouchers())
    await act(async () => {
      await result.current.redeemVoucher('7', acceptedTermsHash)
    })
    const iface = new (await vi.importActual('ethers')).ethers.Interface(MEMBERSHIP_MANAGER_ABI)
    const [voucherId, encodedTermsHash] = iface.decodeFunctionData(
      'redeemVoucher',
      sendCalls.mock.calls[0][0][0].data,
    )
    expect(voucherId.toString()).toBe('7')
    expect(encodedTermsHash).toBe(`0x${acceptedTermsHash}`)
    expect(encodedTermsHash).not.toBe('0x' + '00'.repeat(32))
  })

  it('transfer → sendCalls([safeTransferFrom on the voucher])', async () => {
    const { result } = renderHook(() => useVouchers())
    await act(async () => {
      await result.current.transferVoucher('7', OTHER)
    })
    expect(sendCalls).toHaveBeenCalledTimes(1)
    expect(sendCalls.mock.calls[0][0][0].target).toBe(VOUCHER)
  })
})
