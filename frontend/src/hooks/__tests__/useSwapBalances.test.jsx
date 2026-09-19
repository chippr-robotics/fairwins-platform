import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { NETWORKS } from '../../config/networks'

// useSwapBalances reads a couple of ERC-20 balances on ONE network — the pair's
// network, which is not necessarily the wallet's. The behavior that matters:
//   - it NAMES the pair's chain on every read (answering a Base pair with Polygon
//     state is silently wrong, never an error). Since spec 110 the chain is an
//     argument to the read itself, so that is asserted directly rather than through
//     which URL a provider was built from;
//   - a failed read is `null`, never `0` (constitution III): nobody may be told
//     they hold nothing because an RPC hiccuped;
//   - switching network or account clears figures that belong to someone else.

const { readChainIds, balanceOf } = vi.hoisted(() => ({
  readChainIds: [],
  balanceOf: vi.fn(),
}))

vi.mock('../useRpcEndpoints', () => ({ useEndpointsRevision: () => 0 }))
vi.mock('../../lib/chains/readContract', async (orig) => {
  const actual = await orig()
  return {
    ...actual,
    readContract: (chainId, { address, functionName, args }) => {
      readChainIds.push(chainId)
      if (functionName !== 'balanceOf') throw new Error('unexpected read: ' + functionName)
      return balanceOf(address, args[0])
    },
  }
})

import { useSwapBalances } from '../useSwapBalances'

const HOLDER = '0x1111222233334444555566667777888899990000'
const BASE_WETH = NETWORKS[8453].dex.wnative
const BASE_USDC = NETWORKS[8453].stablecoin.address
const TOKENS = [
  { address: BASE_WETH, decimals: 18 },
  { address: BASE_USDC, decimals: 6 },
]

beforeEach(() => {
  vi.clearAllMocks()
  // The suite-wide VITE_SKIP_BLOCKCHAIN_CALLS flag exists so component tests
  // never hit RPC; this hook IS the RPC read, so it is exercised with the flag off.
  vi.stubEnv('VITE_SKIP_BLOCKCHAIN_CALLS', 'false')
  readChainIds.length = 0
  balanceOf.mockImplementation(async (address) =>
    address === BASE_WETH ? 2_000000000000000000n : 40_000000n,
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('useSwapBalances', () => {
  it('reads the pair network’s balances, naming that network on every read', async () => {
    const { result } = renderHook(() =>
      useSwapBalances({ chainId: 8453, address: HOLDER, tokens: TOKENS }),
    )

    await waitFor(() => expect(result.current.balances[BASE_WETH.toLowerCase()]).toBe('2.0'))
    expect(result.current.balances[BASE_USDC.toLowerCase()]).toBe('40.0')
    // Every read named the PAIR's chain — not the wallet's, and not a default.
    expect(readChainIds.length).toBeGreaterThan(0)
    expect([...new Set(readChainIds)]).toEqual([8453])
    expect(balanceOf).toHaveBeenCalledWith(BASE_WETH, HOLDER)
  })

  it('reports a failed read as unknown, never as zero', async () => {
    balanceOf.mockImplementation(async (address) => {
      if (address === BASE_WETH) throw new Error('rpc down')
      return 40_000000n
    })
    const { result } = renderHook(() =>
      useSwapBalances({ chainId: 8453, address: HOLDER, tokens: TOKENS }),
    )

    await waitFor(() => expect(result.current.balances[BASE_USDC.toLowerCase()]).toBe('40.0'))
    expect(result.current.balances[BASE_WETH.toLowerCase()]).toBeNull()
  })

  it('keeps the last known figure when a later read fails', async () => {
    const { result } = renderHook(() =>
      useSwapBalances({ chainId: 8453, address: HOLDER, tokens: TOKENS }),
    )
    await waitFor(() => expect(result.current.balances[BASE_WETH.toLowerCase()]).toBe('2.0'))

    balanceOf.mockRejectedValue(new Error('rpc down'))
    await result.current.refresh()
    expect(result.current.balances[BASE_WETH.toLowerCase()]).toBe('2.0')
  })

  it('clears figures when the network changes — they belong to another chain', async () => {
    const { result, rerender } = renderHook((props) => useSwapBalances(props), {
      initialProps: { chainId: 8453, address: HOLDER, tokens: TOKENS },
    })
    await waitFor(() => expect(result.current.balances[BASE_WETH.toLowerCase()]).toBe('2.0'))

    balanceOf.mockImplementation(async () => 7_000000000000000000n)
    rerender({
      chainId: 137,
      address: HOLDER,
      tokens: [{ address: NETWORKS[137].dex.wnative, decimals: 18 }],
    })

    await waitFor(() =>
      expect(result.current.balances[NETWORKS[137].dex.wnative.toLowerCase()]).toBe('7.0'),
    )
    // No Base leftovers standing in for Polygon holdings, and the later reads named Polygon.
    expect(result.current.balances[BASE_WETH.toLowerCase()]).toBeUndefined()
    expect(readChainIds.at(-1)).toBe(137)
  })

  it('reads nothing without an account, a network, or any legs', async () => {
    renderHook(() => useSwapBalances({ chainId: 8453, address: null, tokens: TOKENS }))
    renderHook(() => useSwapBalances({ chainId: 999999, address: HOLDER, tokens: TOKENS }))
    renderHook(() => useSwapBalances({ chainId: 8453, address: HOLDER, tokens: [] }))

    await waitFor(() => expect(balanceOf).not.toHaveBeenCalled())
  })
})
