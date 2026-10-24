import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const screenAddressMock = vi.fn()
vi.mock('../../utils/sanctionsScreen', () => ({
  screenAddress: (...args) => screenAddressMock(...args),
}))

let walletState = { provider: {}, chainId: 137 }
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => walletState,
}))

import { useAddressScreening, __clearScreeningCache } from '../../hooks/useAddressScreening'

const ADDR = '0x1111111111111111111111111111111111111111'

describe('useAddressScreening', () => {
  beforeEach(() => {
    __clearScreeningCache()
    screenAddressMock.mockReset()
    walletState = { provider: {}, chainId: 137 }
  })

  it('maps allowed → clear and disallowed → restricted', async () => {
    screenAddressMock.mockResolvedValueOnce({ allowed: true, available: true })
    const { result } = renderHook(() => useAddressScreening())
    await act(async () => {
      await result.current.screen([{ address: ADDR, chainId: 137 }])
    })
    expect(result.current.getStatus(ADDR, 137)).toBe('clear')

    __clearScreeningCache()
    screenAddressMock.mockResolvedValueOnce({ allowed: false, available: true })
    await act(async () => {
      await result.current.screen([{ address: ADDR, chainId: 137 }])
    })
    expect(result.current.getStatus(ADDR, 137)).toBe('restricted')
  })

  it('is fail-closed: unavailable → uncertain, never clear (FR-011)', async () => {
    screenAddressMock.mockResolvedValueOnce({ allowed: false, available: false })
    const { result } = renderHook(() => useAddressScreening())
    await act(async () => {
      await result.current.screen([{ address: ADDR, chainId: 137 }])
    })
    expect(result.current.getStatus(ADDR, 137)).toBe('uncertain')
  })

  it('reports uncertain for an entry on a different network (FR-014)', async () => {
    const { result } = renderHook(() => useAddressScreening())
    await act(async () => {
      await result.current.screen([{ address: ADDR, chainId: 63 }]) // active is 137
    })
    expect(result.current.getStatus(ADDR, 63)).toBe('uncertain')
    expect(screenAddressMock).not.toHaveBeenCalled()
  })

  it('caches results and de-dupes concurrent reads', async () => {
    screenAddressMock.mockResolvedValue({ allowed: true, available: true })
    const { result } = renderHook(() => useAddressScreening())
    await act(async () => {
      await Promise.all([
        result.current.screen([{ address: ADDR, chainId: 137 }]),
        result.current.screen([{ address: ADDR, chainId: 137 }]),
      ])
    })
    expect(screenAddressMock).toHaveBeenCalledTimes(1)
    expect(result.current.anyRestricted([{ address: ADDR, chainId: 137 }])).toBe(false)
  })

  it('getStatus returns loading then resolves', async () => {
    screenAddressMock.mockResolvedValue({ allowed: false, available: true })
    const { result } = renderHook(() => useAddressScreening())
    let initial
    act(() => {
      initial = result.current.getStatus(ADDR, 137)
    })
    expect(initial).toBe('loading')
    await waitFor(() => expect(result.current.getStatus(ADDR, 137)).toBe('restricted'))
  })

  it('exposes screenOne for direct screening callers', async () => {
    screenAddressMock.mockResolvedValue({ allowed: true, available: true })
    const { result } = renderHook(() => useAddressScreening())
    await expect(result.current.screenOne(ADDR, 137)).resolves.toBe('clear')
    // The entry's chain is NAMED, not inferred from the provider (spec 110): the guard that
    // answers is decided by the chain the address belongs to, not by whatever the connection is.
    expect(screenAddressMock).toHaveBeenCalledWith(ADDR, walletState.provider, 137)

    screenAddressMock.mockClear()
    await expect(result.current.screenOne(ADDR, 63)).resolves.toBe('uncertain')
    expect(screenAddressMock).not.toHaveBeenCalled()
  })
})
