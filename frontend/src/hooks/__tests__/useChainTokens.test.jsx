/**
 * useChainTokens — identity stability (issue #1027).
 *
 * Consumers put this hook's return value (and lists derived from it, e.g.
 * useSelectableAssets options) into dependency arrays. A fresh object every
 * render turned those into every-render effects — the Bridge quote debounce
 * re-armed on each render and looped between "getting a price" and the
 * unavailable copy. The return value must keep one identity per chain id.
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

let mockChainId = 137
vi.mock('wagmi', () => ({ useAccount: () => ({ chainId: mockChainId }) }))

import { useChainTokens } from '../useChainTokens'

describe('useChainTokens', () => {
  it('returns the same object identity across re-renders on the same chain', () => {
    mockChainId = 137
    const { result, rerender } = renderHook(() => useChainTokens())
    const first = result.current
    expect(first.chainId).toBe(137)

    rerender()
    expect(result.current).toBe(first)
  })

  it('returns a new value when the chain actually changes', () => {
    mockChainId = 137
    const { result, rerender } = renderHook(() => useChainTokens())
    const first = result.current

    mockChainId = 42161
    rerender()
    expect(result.current).not.toBe(first)
    expect(result.current.chainId).toBe(42161)
  })
})
