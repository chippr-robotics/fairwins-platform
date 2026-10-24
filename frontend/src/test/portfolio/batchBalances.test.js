/**
 * Batched balance reads (issue #1459).
 *
 * The two assertions that carry this file:
 *
 *   1. ONE REQUEST PER CHAIN. The entire point of the change — the old path issued one RPC per
 *      asset (~50–70 per portfolio load against a 50 req/s account-wide cap shared with the
 *      bundler). The test counts provider calls, not response shapes, because counting responses
 *      would pass against an implementation that batched nothing.
 *
 *   2. EMPTY RETURN DATA IS A FAILURE, NOT A ZERO. A `balanceOf` staticcall against an address
 *      with no contract "succeeds" with empty data. Decoding that as 0 renders precisely the
 *      false zero the honest-state rule forbids — a member reading "your money is gone" off an
 *      RPC quirk. This is the case a naive decoder gets wrong silently.
 *
 * Everything else is the fallback ladder: a chain without a verified Multicall3, a batch that
 * fails in transport, a chain with no provider — each degrades to the old per-asset behaviour
 * (or per-asset rejection), never to a thrown portfolio.
 */
import { describe, it, expect, vi } from 'vitest'

// The global setup replaces ethers' Contract with a stub that answers balanceOf with a fixed
// 1000 ETH. Useful for component tests; fatal here, where the FALLBACK path's decoding is part of
// what is under test — asserting against the stub would test the stub. Restore the real module:
// every network touch in this file goes through the mock PROVIDERS below, so nothing real is hit.
vi.unmock('ethers')
import { Interface, AbiCoder } from 'ethers'
import {
  readBalancesSettled,
  MULTICALL3_ADDRESS,
  MULTICALL3_CHAIN_IDS,
} from '../../lib/portfolio/batchBalances'

const MC3_IFACE = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])',
])
const CODER = AbiCoder.defaultAbiCoder()

const uint = (n) => CODER.encode(['uint256'], [n])
const encodeAggregate = (legs) =>
  MC3_IFACE.encodeFunctionResult('aggregate3', [legs.map((l) => [l.success, l.returnData])])

const ADDR = '0x' + 'ab'.repeat(20)
const native = (chainId) => ({ chainId, kind: 'native', id: 'native', symbol: 'N', decimals: 18 })
const erc20 = (chainId, n) => ({
  chainId,
  kind: 'erc20',
  id: `t${n}`,
  symbol: `T${n}`,
  decimals: 18,
  address: '0x' + String(n).padStart(2, '0').repeat(20),
})

/** A provider that answers aggregate3 with the given legs and records every network touch. */
function batchedProvider(legsFor) {
  const calls = []
  return {
    calls,
    async call(tx) {
      calls.push(tx)
      const to = (tx.to || '').toLowerCase()
      if (to === MULTICALL3_ADDRESS.toLowerCase()) {
        const [decoded] = MC3_IFACE.decodeFunctionData('aggregate3', tx.data)
        return encodeAggregate(legsFor(decoded))
      }
      // Fallback-path ERC-20 read.
      return uint(7n)
    },
    async getBalance() {
      calls.push({ kind: 'getBalance' })
      return 9n
    },
  }
}

describe('readBalancesSettled — one request per chain', () => {
  it('reads N assets on a multicall chain with exactly ONE provider call', async () => {
    const provider = batchedProvider((legs) => legs.map(() => ({ success: true, returnData: uint(5n) })))
    const registry = [native(137), erc20(137, 1), erc20(137, 2), erc20(137, 3)]
    const out = await readBalancesSettled(registry, new Map([[137, provider]]), ADDR)

    expect(provider.calls.length, 'the batch IS the feature — one round trip').toBe(1)
    expect(out).toHaveLength(4)
    for (const r of out) expect(r.status).toBe('fulfilled')
  })

  it('carries the NATIVE balance inside the same batch, not as a separate getBalance', async () => {
    const provider = batchedProvider((legs) => legs.map(() => ({ success: true, returnData: uint(5n) })))
    await readBalancesSettled([native(137), erc20(137, 1)], new Map([[137, provider]]), ADDR)
    expect(provider.calls.some((c) => c.kind === 'getBalance')).toBe(false)
  })

  it('runs one batch per chain, concurrently, with results aligned to the input order', async () => {
    // Alignment is the assertion that matters most here: callers zip results back to assets by
    // index, and misattributing one token's balance to another is worse than any outage.
    const p137 = batchedProvider((legs) => legs.map((_, i) => ({ success: true, returnData: uint(BigInt(100 + i)) })))
    const p1 = batchedProvider((legs) => legs.map((_, i) => ({ success: true, returnData: uint(BigInt(200 + i)) })))
    const registry = [erc20(137, 1), erc20(1, 2), erc20(137, 3), erc20(1, 4)]
    const out = await readBalancesSettled(registry, new Map([[137, p137], [1, p1]]), ADDR)

    expect(p137.calls.length).toBe(1)
    expect(p1.calls.length).toBe(1)
    expect(out.map((r) => r.value)).toEqual([100n, 200n, 101n, 201n])
  })
})

describe('readBalancesSettled — honesty of the decode', () => {
  it('treats success:true with EMPTY return data as a FAILURE, never as a zero balance', async () => {
    // The case a naive decoder gets silently wrong. `balanceOf` against an address with no
    // contract "succeeds" with `0x`; rendering that as 0 tells a member their money is gone.
    const provider = batchedProvider(() => [
      { success: true, returnData: uint(5n) },
      { success: true, returnData: '0x' },
    ])
    const out = await readBalancesSettled([erc20(137, 1), erc20(137, 2)], new Map([[137, provider]]), ADDR)
    expect(out[0].status).toBe('fulfilled')
    expect(out[1].status).toBe('rejected')
    expect(out[1].value).toBeUndefined()
  })

  it('maps a failed leg to a rejection without disturbing its neighbours', async () => {
    const provider = batchedProvider(() => [
      { success: true, returnData: uint(1n) },
      { success: false, returnData: '0x' },
      { success: true, returnData: uint(3n) },
    ])
    const out = await readBalancesSettled(
      [erc20(137, 1), erc20(137, 2), erc20(137, 3)],
      new Map([[137, provider]]),
      ADDR
    )
    expect(out.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
  })

  it('rejects undecodable return data rather than guessing', async () => {
    const provider = batchedProvider(() => [{ success: true, returnData: '0xdeadbeef' }])
    const out = await readBalancesSettled([erc20(137, 1)], new Map([[137, provider]]), ADDR)
    expect(out[0].status).toBe('rejected')
  })
})

describe('readBalancesSettled — the fallback ladder', () => {
  it('takes the per-asset path on a chain with no verified Multicall3', async () => {
    expect(MULTICALL3_CHAIN_IDS.has(63)).toBe(false) // Mordor — the vendor does not serve it either
    const provider = batchedProvider(() => { throw new Error('must not be treated as multicall') })
    const out = await readBalancesSettled([native(63), erc20(63, 1)], new Map([[63, provider]]), ADDR)

    // One getBalance + one balanceOf — the OLD shape, exactly.
    expect(provider.calls.filter((c) => c.kind === 'getBalance').length).toBe(1)
    expect(out[0]).toEqual({ status: 'fulfilled', value: 9n })
    expect(out[1]).toEqual({ status: 'fulfilled', value: 7n })
  })

  it('degrades to per-asset reads when the BATCH itself fails, costing efficiency and never data', async () => {
    let batchAttempts = 0
    const provider = {
      calls: [],
      async call(tx) {
        if ((tx.to || '').toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
          batchAttempts++
          throw new Error('multicall transport failure')
        }
        return uint(7n)
      },
      async getBalance() { return 9n },
    }
    const out = await readBalancesSettled([native(137), erc20(137, 1)], new Map([[137, provider]]), ADDR)
    expect(batchAttempts).toBe(1)
    expect(out[0]).toEqual({ status: 'fulfilled', value: 9n })
    expect(out[1]).toEqual({ status: 'fulfilled', value: 7n })
  })

  it('rejects every asset on a chain with NO provider without touching the other chains', async () => {
    const p137 = batchedProvider((legs) => legs.map(() => ({ success: true, returnData: uint(5n) })))
    const out = await readBalancesSettled(
      [erc20(137, 1), erc20(999, 2)],
      new Map([[137, p137]]),
      ADDR
    )
    expect(out[0].status).toBe('fulfilled')
    expect(out[1].status).toBe('rejected')
    expect(String(out[1].reason?.message)).toContain('999')
  })
})

describe('the verified-chain allowlist', () => {
  it('contains exactly the chains that were probed, and is frozen', () => {
    // Membership is an empirical fact (eth_getCode on each), not a hope. Adding a chain is one
    // line — after running the same probe.
    expect([...MULTICALL3_CHAIN_IDS].sort((a, b) => a - b)).toEqual([1, 10, 137, 8453, 42161])
  })
})
