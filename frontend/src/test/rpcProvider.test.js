/**
 * makeReadProvider — disables ethers JSON-RPC request batching on chains whose
 * public RPCs mishandle batch responses (Ethereum Classic mainnet 61 + Mordor
 * 63). Batching is what made every Mordor read (My Wagers, membership banner)
 * silently fail, since ethers batches concurrent eth_calls by default.
 */
import { describe, it, expect } from 'vitest'
import { makeReadProvider, chainNeedsUnbatchedRpc } from '../utils/rpcProvider'

describe('chainNeedsUnbatchedRpc', () => {
  it('flags Ethereum Classic chains (61, 63)', () => {
    expect(chainNeedsUnbatchedRpc(61)).toBe(true)
    expect(chainNeedsUnbatchedRpc(63)).toBe(true)
    expect(chainNeedsUnbatchedRpc('63')).toBe(true)
  })

  it('leaves batching enabled for Polygon / Amoy / unknown', () => {
    expect(chainNeedsUnbatchedRpc(137)).toBe(false)
    expect(chainNeedsUnbatchedRpc(80002)).toBe(false)
    expect(chainNeedsUnbatchedRpc(null)).toBe(false)
    expect(chainNeedsUnbatchedRpc(undefined)).toBe(false)
  })
})

describe('makeReadProvider', () => {
  it('disables batching (batchMaxCount=1) for Mordor', () => {
    const p = makeReadProvider('https://rpc.mordor.etccooperative.org', 63)
    // ethers v6 exposes the configured batch cap on the provider options.
    expect(p._getOption('batchMaxCount')).toBe(1)
  })

  it('keeps default batching for Polygon-family chains', () => {
    // Amoy (80002), not Polygon mainnet: 137 now declares a build-curated rpcFailoverUrl
    // (release 1.14.0 task 8, generalizing beyond ETC), so makeReadProvider(137) legitimately
    // returns a FallbackProvider — this assertion is about the batch-cap OPTION, which needs a
    // plain JsonRpcProvider with `_getOption` to inspect directly.
    const p = makeReadProvider('https://rpc-amoy.polygon.technology', 80002)
    expect(p._getOption('batchMaxCount')).toBeGreaterThan(1)
  })
})

describe('makeReadProvider — provider caching', () => {
  // Each `ethers` provider runs its own perpetual `_detectNetwork` retry loop when the
  // endpoint is unreachable. Building a fresh one per call means every read from every
  // hook piles up one more never-terminated loop hammering the same endpoint — this is
  // what turned one flaky chain into a flood of parallel retries. One provider per
  // resolved route caps that to a single loop per chain.
  it('reuses the same provider instance for repeated calls with the same route', () => {
    const a = makeReadProvider('https://example.invalid/rpc', 900001)
    const b = makeReadProvider('https://example.invalid/rpc', 900001)
    expect(b).toBe(a)
  })

  it('builds a fresh provider — and keeps it cached — when the resolved route changes', () => {
    const a = makeReadProvider('https://example.invalid/rpc', 900002)
    const b = makeReadProvider('https://example.invalid/other-rpc', 900002)
    expect(b).not.toBe(a)
    expect(makeReadProvider('https://example.invalid/other-rpc', 900002)).toBe(b)
  })
})
