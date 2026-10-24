/**
 * lib/chain/revertError — reading a named custom error off a failed call (issue #1267).
 *
 * The bug this module exists to close is not "we could not decode it" — the ABI decodes it fine.
 * It is that the decoded error is only ever HANDED to us on some paths: a `staticCall` through a
 * JsonRpcProvider arrives with `error.revert` populated, while the same revert on the write path
 * through an injected wallet arrives as raw selector bytes nested in the RPC payload. A caller
 * reading `.revert` alone therefore behaves differently depending on how the call was made, which
 * is how the curator console lost its `StaleProposal` explanation.
 *
 * So these pin three things:
 *   1. every shape a revert has been observed to arrive in resolves to the same {name, args};
 *   2. bytes that do NOT belong to the supplied ABI resolve to `null` — widening what we read must
 *      never widen what we claim, because naming the wrong error is worse than naming none;
 *   3. no chain, no provider, nothing async — decoding is arithmetic over an ABI.
 */
import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'

import { describeRevert, extractRevert, rawRevertData } from '../../lib/chain/revertError'

const IFACE = new ethers.Interface([
  'error StaleProposal(bytes32 expected, bytes32 actual)',
  'error AppNotFound()',
])
const EXPECTED = `0x${'bb'.repeat(32)}`
const ACTUAL = `0x${'cc'.repeat(32)}`
const STALE_DATA = IFACE.encodeErrorResult('StaleProposal', [EXPECTED, ACTUAL])
const NOT_FOUND_DATA = IFACE.encodeErrorResult('AppNotFound', [])

/** A revert from a contract this ABI knows nothing about. */
const FOREIGN_DATA = new ethers.Interface(['error SomebodyElsesProblem(uint256 id)']).encodeErrorResult(
  'SomebodyElsesProblem',
  [7n],
)

describe('extractRevert', () => {
  it('reads a revert ethers already decoded onto `.revert`', () => {
    const revert = extractRevert({ revert: { name: 'StaleProposal', args: [EXPECTED, ACTUAL] } }, IFACE)
    expect(revert.name).toBe('StaleProposal')
    expect(Array.from(revert.args)).toEqual([EXPECTED, ACTUAL])
  })

  it('reads the older errorName/errorArgs pair', () => {
    const revert = extractRevert({ errorName: 'AppNotFound', errorArgs: [] }, IFACE)
    expect(revert).toEqual({ name: 'AppNotFound', args: [] })
  })

  // The write path. Each of these is a real shape: `data` is what an injected wallet hands back,
  // `data.data` is MetaMask's nested node payload, and the two `error.*` forms are what a passkey
  // UserOp failure and a wrapped provider produce.
  it.each([
    ['error.data', (data) => ({ data })],
    ['error.data.data', (data) => ({ data: { code: -32000, message: 'reverted', data } })],
    ['error.info.error.data', (data) => ({ info: { error: { data } } })],
    ['error.error.data', (data) => ({ error: { data } })],
    ['error.error.error.data', (data) => ({ error: { error: { data } } })],
  ])('decodes raw revert bytes at %s', (_label, wrap) => {
    const err = Object.assign(new Error('execution reverted (unknown custom error)'), wrap(STALE_DATA))
    const revert = extractRevert(err, IFACE)
    expect(revert.name).toBe('StaleProposal')
    expect(Array.from(revert.args)).toEqual([EXPECTED, ACTUAL])
  })

  it('decodes a zero-argument custom error too', () => {
    expect(extractRevert({ data: NOT_FOUND_DATA }, IFACE).name).toBe('AppNotFound')
  })

  it('returns null for bytes that belong to a different ABI', () => {
    expect(extractRevert({ data: FOREIGN_DATA }, IFACE)).toBeNull()
  })

  it.each([
    ['an ordinary failure with nothing to decode', new Error('insufficient funds')],
    ['a rejected wallet prompt', Object.assign(new Error('denied'), { code: 'ACTION_REJECTED' })],
    ['a truncated selector', { data: '0xdead' }],
    ['a non-hex payload', { data: 'reverted' }],
    ['a null error', null],
  ])('returns null for %s', (_label, error) => {
    expect(extractRevert(error, IFACE)).toBeNull()
  })

  it('returns null for raw bytes when it is given no ABI — bytes alone name nothing', () => {
    expect(extractRevert({ data: STALE_DATA })).toBeNull()
    // …but a pre-decoded revert still reads, because nothing had to be decoded.
    expect(extractRevert({ revert: { name: 'StaleProposal', args: [] } })).toEqual({
      name: 'StaleProposal',
      args: [],
    })
  })

  it('is synchronous — no provider, no promise', () => {
    expect(extractRevert({ data: STALE_DATA }, IFACE)).not.toBeInstanceOf(Promise)
  })
})

describe('rawRevertData', () => {
  it('returns the payload from every observed nesting, outermost first', () => {
    expect(rawRevertData({ data: STALE_DATA })).toBe(STALE_DATA)
    expect(rawRevertData({ data: { data: STALE_DATA } })).toBe(STALE_DATA)
    expect(rawRevertData({ info: { error: { data: STALE_DATA } } })).toBe(STALE_DATA)
    expect(rawRevertData({ error: { data: STALE_DATA } })).toBe(STALE_DATA)
    expect(rawRevertData({ error: { error: { data: STALE_DATA } } })).toBe(STALE_DATA)
  })

  it('skips non-hex and sub-selector payloads rather than returning them', () => {
    expect(rawRevertData({ data: 'execution reverted' })).toBeNull()
    expect(rawRevertData({ data: '0x1234' })).toBeNull()
    expect(rawRevertData({})).toBeNull()
    expect(rawRevertData(null)).toBeNull()
  })
})

describe('describeRevert', () => {
  it('names the error and shortens long hex so a toast stays one line', () => {
    const text = describeRevert(extractRevert({ data: STALE_DATA }, IFACE))
    expect(text).toBe('StaleProposal(0xbbbbbbbb…bbbbbbbb, 0xcccccccc…cccccccc)')
  })

  it('renders a zero-argument error as the bare name', () => {
    expect(describeRevert({ name: 'AppNotFound', args: [] })).toBe('AppNotFound')
  })

  it('returns null when there is nothing to describe', () => {
    expect(describeRevert(null)).toBeNull()
    expect(describeRevert({ args: [1] })).toBeNull()
  })
})

/*
 * DIVERGENCE 22 (spec 110). The five shapes above are five FIXED EXPRESSIONS because that is what
 * ethers and the wallets produce. viem is not like that: it wraps every layer in a typed error and
 * chains them through `cause`, so the revert bytes sit at a depth that varies with the transport,
 * under `raw` in one shape and `data` in another. The hand-listed paths reached NONE of them.
 *
 * The errors here are REAL viem errors, produced by driving a real `readContract` against a
 * transport that throws — not objects shaped the way this file remembers viem. That distinction is
 * the whole point: a hand-built fixture would have agreed with whatever the walk was written to
 * expect, which is exactly how the original list came to miss every viem shape.
 */
describe('rawRevertData reaches a viem error', () => {
  const STALE = IFACE.encodeErrorResult('StaleProposal', [
    '0x' + '11'.repeat(32),
    '0x' + '22'.repeat(32),
  ])

  /** Drive a real viem readContract against a transport that throws `thrown`. */
  async function viemRevert(thrown) {
    const { createPublicClient, custom, parseAbi } = await import('viem')
    const client = createPublicClient({
      chain: {
        id: 137,
        name: 'probe',
        nativeCurrency: { name: 'n', symbol: 'n', decimals: 18 },
        rpcUrls: { default: { http: [] } },
      },
      transport: custom({
        async request({ method }) {
          if (method === 'eth_chainId') return '0x89'
          throw thrown()
        },
      }),
    })
    try {
      await client.readContract({
        address: '0x' + '11'.repeat(20),
        abi: parseAbi(['function doThing() returns (uint256)']),
        functionName: 'doThing',
      })
      throw new Error('expected the read to revert')
    } catch (e) {
      return e
    }
  }

  it('finds the bytes when the node error carries them bare (deep `cause` chain)', async () => {
    const err = await viemRevert(() => Object.assign(new Error('execution reverted'), { data: STALE }))
    expect(err.name).toBe('ContractFunctionExecutionError')
    expect(rawRevertData(err)).toBe(STALE)
    expect(extractRevert(err, IFACE)).toMatchObject({ name: 'StaleProposal' })
  })

  it('finds the bytes when viem pre-decodes them onto `cause.raw`', async () => {
    const err = await viemRevert(() =>
      Object.assign(new Error('execution reverted'), { code: 3, data: { data: STALE } }),
    )
    expect(rawRevertData(err)).toBe(STALE)
    expect(extractRevert(err, IFACE)).toMatchObject({ name: 'StaleProposal' })
  })

  it('still resolves to null for bytes this ABI does not describe', async () => {
    const foreign = '0x' + 'ab'.repeat(4) + '00'.repeat(32)
    const err = await viemRevert(() => Object.assign(new Error('execution reverted'), { data: foreign }))
    expect(rawRevertData(err)).toBe(foreign) // the walk found it…
    expect(extractRevert(err, IFACE)).toBeNull() // …and refused to name it
  })

  it('terminates on a cyclic error chain', () => {
    const a = new Error('a')
    const b = new Error('b')
    a.cause = b
    b.cause = a
    a.data = STALE
    expect(rawRevertData(a)).toBe(STALE)
  })
})
