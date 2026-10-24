/**
 * `lib/chains/readContract.js` — the read seam, and specifically `withOutputNames` (spec 110).
 *
 * WHY THIS EXISTS. `withOutputNames` is the single mechanism standing between this migration and
 * divergence (a), which is the worst of the nineteen because it is SILENT: ethers returned a
 * multi-output call as a Result addressable both positionally and BY NAME, viem returns a bare
 * array, so `result.token0` becomes `undefined` — not an error, not a failed read, just a field
 * that quietly is not there. It already shipped once that way: a caller read `raw.token0`, got
 * undefined, treated the position as unreadable, and rendered an EMPTY LIST, which is
 * indistinguishable from "you have no positions".
 *
 * That mechanism had no direct test. Every existing consumer mocks `readContract` wholesale, so a
 * regression in the naming would surface as `NaN` counters on a dashboard rather than a red suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const client = vi.hoisted(() => ({ readContract: vi.fn(), available: true }))
vi.mock('../../lib/chains/publicClient', async (orig) => {
  const actual = await orig()
  return { ...actual, getPublicClient: () => (client.available ? client : null) }
})

import { readContract, normalizeAbi, NoRpcEndpointError } from '../../lib/chains/readContract'

// A five-output view, the shape that actually bit: NullifierRegistry.getStats, read BY NAME at
// its call site as `stats.markets`, `stats.addresses`, …
const STATS_ABI = [
  {
    type: 'function',
    name: 'getStats',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'markets', type: 'uint256' },
      { name: 'addresses', type: 'uint256' },
      { name: 'nullifications', type: 'uint256' },
      { name: 'reinstatements', type: 'uint256' },
      { name: 'lastUpdate', type: 'uint256' },
    ],
  },
]

const CHAIN = 137
const ADDRESS = `0x${'ab'.repeat(20)}`

describe('readContract — multi-output results keep their NAMES', () => {
  beforeEach(() => {
    client.available = true
    client.readContract.mockReset()
  })

  it('attaches every output name, and positional access still works', async () => {
    client.readContract.mockResolvedValue([1n, 2n, 3n, 4n, 5n])
    const stats = await readContract(CHAIN, { address: ADDRESS, abi: STATS_ABI, functionName: 'getStats' })

    // By name — what ethers gave and what the call sites read.
    expect(stats.markets).toBe(1n)
    expect(stats.addresses).toBe(2n)
    expect(stats.nullifications).toBe(3n)
    expect(stats.reinstatements).toBe(4n)
    expect(stats.lastUpdate).toBe(5n)
    // And positionally — destructuring call sites must not break.
    const [a, b] = stats
    expect([a, b]).toEqual([1n, 2n])
  })

  it('is still the ARRAY it was — spreads, deep-equals and serialises unchanged', async () => {
    // The names are attached non-enumerably ON PURPOSE. If they enumerated, every `toEqual`
    // against a plain array in every existing test would start failing, and anything that
    // JSON-serialises a read result would silently change shape.
    client.readContract.mockResolvedValue([1n, 2n, 3n, 4n, 5n])
    const stats = await readContract(CHAIN, { address: ADDRESS, abi: STATS_ABI, functionName: 'getStats' })

    expect(stats).toEqual([1n, 2n, 3n, 4n, 5n])
    expect([...stats]).toEqual([1n, 2n, 3n, 4n, 5n])
    expect(Object.keys(stats)).toEqual(['0', '1', '2', '3', '4'])
    expect(Array.isArray(stats)).toBe(true)
  })

  it('leaves a SINGLE output exactly as viem returned it', async () => {
    // A lone tuple already arrives as an object with its component names; wrapping it would change
    // every caller. A lone scalar is a scalar.
    const single = [{ type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }]
    client.readContract.mockResolvedValue(ADDRESS)
    await expect(readContract(CHAIN, { address: ADDRESS, abi: single, functionName: 'owner' })).resolves.toBe(ADDRESS)
  })

  it('does not invent a name for an UNNAMED output', async () => {
    const unnamed = [{
      type: 'function', name: 'pair', stateMutability: 'view', inputs: [],
      outputs: [{ name: '', type: 'address' }, { name: 'fee', type: 'uint24' }],
    }]
    client.readContract.mockResolvedValue([ADDRESS, 3000])
    const r = await readContract(CHAIN, { address: ADDRESS, abi: unnamed, functionName: 'pair' })
    expect(r.fee).toBe(3000)
    expect(r[0]).toBe(ADDRESS)
    // Nothing was guessed for the anonymous one.
    expect(Object.getOwnPropertyNames(r).filter((k) => Number.isNaN(Number(k)) && k !== 'length')).toEqual(['fee'])
  })

  it('leaves the result alone when the ABI and the result disagree on arity', async () => {
    // Attaching names positionally to a result of a different length would mislabel values, which
    // is worse than leaving them positional.
    client.readContract.mockResolvedValue([1n, 2n])
    const r = await readContract(CHAIN, { address: ADDRESS, abi: STATS_ABI, functionName: 'getStats' })
    expect(r.markets).toBeUndefined()
    expect(r).toEqual([1n, 2n])
  })
})

describe('readContract — the chain is an argument, and a missing endpoint is LOUD', () => {
  beforeEach(() => {
    client.available = true
    client.readContract.mockReset()
    client.readContract.mockResolvedValue(0n)
  })

  it('throws NoRpcEndpointError rather than returning a default', async () => {
    client.available = false
    await expect(
      readContract(CHAIN, { address: ADDRESS, abi: STATS_ABI, functionName: 'getStats' }),
    ).rejects.toBeInstanceOf(NoRpcEndpointError)
  })

  it('passes args, account and a pinned block through as viem expects', async () => {
    await readContract(CHAIN, {
      address: ADDRESS, abi: STATS_ABI, functionName: 'getStats',
      args: [1n], account: ADDRESS, blockNumber: 123n,
    })
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDRESS, args: [1n], account: ADDRESS, blockNumber: 123n }),
    )
  })

  it('sends a non-bigint block as a TAG, not a number', async () => {
    await readContract(CHAIN, { address: ADDRESS, abi: STATS_ABI, functionName: 'getStats', blockNumber: 'latest' })
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockTag: 'latest' }))
  })

  it('omits args entirely when none were given', async () => {
    await readContract(CHAIN, { address: ADDRESS, abi: STATS_ABI, functionName: 'getStats' })
    expect(client.readContract.mock.calls[0][0]).not.toHaveProperty('args')
  })
})

describe('normalizeAbi', () => {
  it('parses ethers-v6 human-readable signatures, including `tuple(...)`', () => {
    const parsed = normalizeAbi([
      'function getRoute(bytes32 id) view returns (tuple(address token, bool enabled) route)',
    ])
    expect(parsed[0].name).toBe('getRoute')
    expect(parsed[0].outputs[0].type).toBe('tuple')
    expect(parsed[0].outputs[0].components.map((c) => c.name)).toEqual(['token', 'enabled'])
  })

  it('passes a JSON ABI through untouched, by identity', () => {
    expect(normalizeAbi(STATS_ABI)).toBe(STATS_ABI)
  })

  it('caches per array identity, so a memo dependency on it stays stable', () => {
    const human = ['function owner() view returns (address)']
    expect(normalizeAbi(human)).toBe(normalizeAbi(human))
  })
})
