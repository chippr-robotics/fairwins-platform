import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'

const getBalance = vi.fn()
const rpcGetBalance = vi.fn()
const tokenBalanceOf = vi.fn()
const makeReadProvider = vi.fn()
const tokenReads = []

/**
 * Spec 110 — this file's `vi.mock('ethers')` is gone, and with it the one assertion in the suite
 * that pinned WHICH provider the ERC-20 balance was read through: it checked that
 * `new Contract(token, ABI, runner)` got the WALLET's provider on a classic session and the RPC
 * provider on a passkey one.
 *
 * That routing is what changed, deliberately (the read-routing decision). The token balance is
 * read by CHAIN now, through the one seam, so the member's own endpoint (spec 069) applies to it
 * and an unreachable chain fails honestly instead of quietly answering with the home network's
 * state. The consequence is worth asserting rather than deleting: the token read is now IDENTICAL
 * across session kinds, where it used to depend on how you logged in.
 *
 * The NATIVE balance still goes through `readProvider`, so the wallet-vs-RPC preference is still
 * pinned below — by `getBalance` / `rpcGetBalance`, which is where it actually lives.
 */
vi.mock('../lib/chains/readContract', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    readContract: async (chainId, { address, functionName, args = [] }) => {
      tokenReads.push({ chainId, address, functionName, args })
      if (functionName === 'balanceOf') return tokenBalanceOf(args[0])
      throw new Error(`unexpected read: ${functionName}`)
    },
  }
})

// EIP-55 form, frozen. The fixture was '0xAaAa…0001' — a MIS-CHECKSUMMED address that ethers'
// own `getAddress` rejects outright. It survived because nothing in this suite ever checksummed
// it: the read went through a fake `Contract` constructor that took the address and ignored it.
const ACCOUNT = '0xAAaA000000000000000000000000000000000001'

const wallet = {
  address: ACCOUNT,
  chainId: 137,
  signer: {},
  provider: { getBalance },
  loginMethod: 'eoa',
  sendCalls: vi.fn(),
}

vi.mock('../hooks/useWalletManagement', () => ({ useWallet: () => wallet }))
vi.mock('../hooks/useActiveAccount', () => ({
  useActiveAccount: () => ({ isVault: false, canActAsVault: false, submit: vi.fn() }),
}))
vi.mock('../hooks/useChainTokens', () => ({
  useChainTokens: () => ({
    native: 'MATIC',
    nativeName: 'Matic',
    nativeDecimals: 18,
    stable: 'USDC',
    stableName: 'USD Coin',
    stableDecimals: 6,
    stableAddress: '0xToken000000000000000000000000000000000001',
  }),
}))
// Partial mock: only `getNetwork` is stubbed (a stablecoin with no EIP-3009 domain version, so the
// classic path stays self-submit, plus a deterministic rpcUrl to assert the read-provider wiring).
// Everything else stays REAL — modules pulled in transitively (constants/dex.js via data/wagers)
// call `getCurrentChainId`/`NETWORKS` at module load, and hand-listing those exports here just
// re-breaks the file the next time an import graph grows. The real module is safe to load: its
// import-time `assertReferenceChainInCohort()` passes for the default (mainnet) build.
vi.mock('../config/networks', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getNetwork: () => ({ stablecoin: { domainVersion: null }, rpcUrl: 'https://rpc.test' }),
  }
})
vi.mock('../utils/rpcProvider', () => ({ makeReadProvider: (...args) => makeReadProvider(...args) }))
vi.mock('../lib/transfer/eip3009Transfer', () => ({
  TRANSFER_ABI: ['function balanceOf(address) view returns (uint256)'],
  signTransferAuthorization: vi.fn(),
  getTransferRelayer: () => null,
  relayGaslessTransfer: vi.fn(),
}))
vi.mock('../lib/transfer/transferStore', () => ({
  recordTransfer: vi.fn(),
  updateTransfer: vi.fn(),
  TRANSFER_STATUS: { COMPLETE: 'complete', FAILED: 'failed' },
}))

import { useTransfer, TRANSFER_KIND } from '../hooks/useTransfer'

describe('useTransfer balances', () => {
  beforeEach(() => {
    wallet.loginMethod = 'eoa'
    wallet.provider = { getBalance }
    getBalance.mockReset()
    rpcGetBalance.mockReset()
    tokenBalanceOf.mockReset()
    makeReadProvider.mockReset()
    tokenReads.length = 0
    makeReadProvider.mockReturnValue({ getBalance: rpcGetBalance })
    getBalance.mockResolvedValue(2500000000000000000n)
    rpcGetBalance.mockResolvedValue(3500000000000000000n)
    tokenBalanceOf.mockResolvedValue(123450000n)
  })

  it('reads balances from the RPC provider and exposes them by asset kind', async () => {
    const { result } = renderHook(() => useTransfer())

    await waitFor(() => expect(getBalance).toHaveBeenCalledWith(wallet.address))
    await waitFor(() => expect(tokenBalanceOf).toHaveBeenCalled())
    expect(tokenReads).toEqual([
      {
        chainId: wallet.chainId,
        address: '0xToken000000000000000000000000000000000001',
        functionName: 'balanceOf',
        args: [ACCOUNT],
      },
    ])
    expect(result.current.balanceOf(TRANSFER_KIND.NATIVE)).toBe('2.5')
    expect(result.current.balanceOf(TRANSFER_KIND.STABLE)).toBe('123.45')

    await act(async () => {
      await result.current.refreshBalances()
    })
    expect(getBalance).toHaveBeenCalledTimes(2)
    expect(tokenBalanceOf).toHaveBeenCalledTimes(2)
  })

  it('uses the network RPC read provider for passkey sessions', async () => {
    wallet.loginMethod = 'passkey'
    wallet.provider = null

    const { result } = renderHook(() => useTransfer())

    await waitFor(() => expect(makeReadProvider).toHaveBeenCalledWith('https://rpc.test', wallet.chainId))
    await waitFor(() => expect(rpcGetBalance).toHaveBeenCalledWith(wallet.address))
    await waitFor(() => expect(tokenBalanceOf).toHaveBeenCalled())
    // BYTE-IDENTICAL to the classic session above: the token read does not depend on how the
    // member signed in. Only the NATIVE balance follows the wallet-vs-RPC preference, asserted
    // by `rpcGetBalance` on the line above.
    expect(tokenReads).toEqual([
      {
        chainId: wallet.chainId,
        address: '0xToken000000000000000000000000000000000001',
        functionName: 'balanceOf',
        args: [ACCOUNT],
      },
    ])
    expect(result.current.balanceOf(TRANSFER_KIND.NATIVE)).toBe('3.5')
  })
})
