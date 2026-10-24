/**
 * useEarnSend tests (spec 050 — network-transparent sending). The switch to
 * a transaction's network happens automatically as part of submitting (no
 * separate in-app confirmation), the send waits for the session to settle on
 * the target chain, and passkey sessions are honestly gated to chains with
 * an ERC-4337 rail.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const mockWallet = vi.hoisted(() => ({ current: {} }))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => mockWallet.current,
}))

const mockSwitch = vi.hoisted(() => ({ switchChainAsync: vi.fn() }))
vi.mock('wagmi', () => ({
  useSwitchChain: () => ({ switchChainAsync: mockSwitch.switchChainAsync }),
}))

import { useEarnSend } from '../../hooks/useEarnSend'

const CALLS = [{ target: '0x' + 'a'.repeat(40), data: '0x01', value: 0n }]

beforeEach(() => {
  mockWallet.current = {
    chainId: 137,
    signer: {},
    sendCalls: vi.fn().mockResolvedValue({ route: 'direct', txHash: '0xtx' }),
    loginMethod: 'wallet',
  }
  mockSwitch.switchChainAsync.mockReset().mockResolvedValue({})
})

describe('useEarnSend', () => {
  it('sends directly with no switch when already on the target chain', async () => {
    const { result } = renderHook(() => useEarnSend())
    const sent = await act(() => result.current.sendOnChain(137, CALLS))
    expect(mockSwitch.switchChainAsync).not.toHaveBeenCalled()
    expect(mockWallet.current.sendCalls).toHaveBeenCalledWith(CALLS)
    expect(sent.txHash).toBe('0xtx')
  })

  it('switches automatically, waits for the session to settle, then sends', async () => {
    const states = []
    const { result, rerender } = renderHook(() => useEarnSend())
    const pending = result.current.sendOnChain(1, CALLS, { onState: (s) => states.push(s.step) })

    // The switch was requested without any in-app confirmation step…
    await act(async () => {
      await Promise.resolve()
    })
    expect(mockSwitch.switchChainAsync).toHaveBeenCalledWith({ chainId: 1 })

    // …and the send waits until the wallet snapshot reflects the new chain
    // (and, for classic wallets, a rebuilt signer).
    mockWallet.current = { ...mockWallet.current, chainId: 1, signer: {} }
    rerender()
    const sent = await act(() => pending)
    expect(states).toEqual(['switching', 'sending'])
    expect(mockWallet.current.sendCalls).toHaveBeenCalledWith(CALLS)
    expect(sent.txHash).toBe('0xtx')
  })

  it('fails with a member-facing message naming BOTH chains when the wallet refuses the switch', async () => {
    mockSwitch.switchChainAsync.mockRejectedValue(new Error('user rejected'))
    const { result } = renderHook(() => useEarnSend())
    // Spec 110 T026 — this hook's own wording was "Could not switch to Ethereum — approve the
    // network change and try again", which named neither where the wallet actually was nor that
    // nothing had been signed. The shared loop's sentence carries both, so that is what is asserted.
    const err = await result.current.sendOnChain(1, CALLS).catch((e) => e)
    expect(err.message).toMatch(/Ethereum/)
    expect(err.message).toMatch(/Polygon/)
    expect(err.message).toMatch(/nothing has been signed/i)
    expect(mockWallet.current.sendCalls).not.toHaveBeenCalled()
  })

  it('gates passkey sessions honestly on chains without an ERC-4337 rail', async () => {
    mockWallet.current = { ...mockWallet.current, loginMethod: 'passkey', signer: null }
    const { result } = renderHook(() => useEarnSend())
    // Ethereum mainnet has no passkey bundler configured (spec 048 cut).
    expect(result.current.canTransactOn(1)).toBe(false)
    expect(result.current.cannotTransactReason(1)).toMatch(/passkey accounts can't send transactions on ethereum/i)
    await expect(result.current.sendOnChain(1, CALLS)).rejects.toThrow(/passkey accounts/i)
    expect(mockSwitch.switchChainAsync).not.toHaveBeenCalled()
  })
})
