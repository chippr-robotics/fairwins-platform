/**
 * `lib/evm/revertParser.js#errorParser` — the viem-backed `parseError` that `lib/chain/revertError.js`
 * takes as a duck type (spec 110 T023/T028).
 *
 * `revertError.js` imports nothing on purpose, so the only thing holding its contract together is
 * that whatever gets passed in behaves like the `Interface` that used to be. ethers is the oracle
 * here: a live cross-library check over the exact method that was replaced. (src/test/**, outside
 * the import ratchet.)
 *
 * The assertions that matter are the two places viem's `decodeErrorResult` has a DIFFERENT SHAPE
 * from ethers' `parseError`. Both currently "work" through `extractRevert`'s catch and
 * `describeRevert`'s `?? []` — that is, by accident — and both stop working the moment somebody
 * writes a caller that trusts the declared signature.
 */
import { describe, it, expect } from 'vitest'
import { Interface } from 'ethers'
import { errorParser } from '../../lib/evm/revertParser'
import { extractRevert, describeRevert } from '../../lib/chain/revertError'

const ABI = [
  'error StaleProposal(bytes32 expected, bytes32 actual)',
  'error NotAuthorized()',
  'error Bounded(uint256 max)',
]
const iface = new Interface(ABI)
const parser = errorParser(ABI)

const B32 = (b) => '0x' + b.repeat(32)

describe('errorParser', () => {
  it('decodes a named error to the same name and args ethers produced', () => {
    const data = iface.encodeErrorResult('StaleProposal', [B32('ab'), B32('cd')])
    const e = iface.parseError(data)
    const v = parser.parseError(data)
    expect(v.name).toBe(e.name)
    expect(v.args).toEqual(Array.from(e.args))
  })

  it('returns [] for a no-argument error, where viem alone gives undefined', () => {
    const data = iface.encodeErrorResult('NotAuthorized', [])
    const v = parser.parseError(data)
    expect(v).toEqual({ name: 'NotAuthorized', args: [] })
    // The consequence: the operator sees the bare name, not "NotAuthorized(undefined)".
    expect(describeRevert(v)).toBe('NotAuthorized')
  })

  it('returns NULL for an unknown selector, where viem alone throws', () => {
    // ethers returned null here, `revertError.js` documents null, and extractRevert walks five
    // candidate payloads — a helper that throws on every miss works only through its catch.
    expect(parser.parseError('0xdeadbeef' + '00'.repeat(32))).toBeNull()
    expect(parser.parseError('0xdeadbeef')).toBeNull()
    expect(iface.parseError('0xdeadbeef')).toBeNull()
  })

  it('returns null rather than throwing for data that is not a revert payload at all', () => {
    for (const bad of ['0x', '0x12', 'nothex', '', null, undefined]) {
      expect(parser.parseError(bad)).toBeNull()
    }
  })

  it('decodes the builtins the ABI does not declare, exactly as ethers did', () => {
    const errStr = new Interface(['error Error(string)']).encodeErrorResult('Error', ['boom'])
    expect(parser.parseError(errStr)).toEqual({ name: 'Error', args: ['boom'] })
    const panic = new Interface(['error Panic(uint256)']).encodeErrorResult('Panic', [0x11n])
    expect(parser.parseError(panic)).toEqual({ name: 'Panic', args: [0x11n] })
  })

  it('gives args their NAMES back, which viem drops (divergence 13)', () => {
    // The error-path twin of the multi-output read defect. `CallsignPanel.describeError` reads
    // `revert.args.nextAllowedAt`; with a bare array that is `undefined` — no error, no failed
    // decode, just a field that quietly is not there, and the member is told "try again later"
    // instead of when.
    const iface = new Interface(['error ChangeCooldownActive(uint64 nextAllowedAt)'])
    const parserWithNames = errorParser(['error ChangeCooldownActive(uint64 nextAllowedAt)'])
    const data = iface.encodeErrorResult('ChangeCooldownActive', [1893456000n])

    const e = iface.parseError(data)
    const v = parserWithNames.parseError(data)
    expect(v.args.nextAllowedAt).toBe(e.args.nextAllowedAt)
    expect(v.args[0]).toBe(e.args[0])
  })

  it('leaves the args behaving as the plain array they are', () => {
    // Non-enumerable, so nothing that spreads, serializes or deep-equals them changes shape.
    const iface = new Interface(['error Two(uint256 a, address b)'])
    const who = '0x' + '11'.repeat(20)
    const data = iface.encodeErrorResult('Two', [7n, who])
    const { args } = errorParser(['error Two(uint256 a, address b)']).parseError(data)

    expect(args).toEqual([7n, who])
    expect([...args]).toEqual([7n, who])
    expect(Object.keys(args)).toEqual(['0', '1'])
    expect(JSON.parse(JSON.stringify(args, (k, x) => (typeof x === 'bigint' ? String(x) : x)))).toEqual(['7', who])
    expect(args.a).toBe(7n)
    expect(args.b).toBe(who)
  })

  it('does not invent names for an error whose parameters have none', () => {
    const iface = new Interface(['error Anon(uint256)'])
    const data = iface.encodeErrorResult('Anon', [5n])
    const { args } = errorParser(['error Anon(uint256)']).parseError(data)
    expect(args).toEqual([5n])
    expect(Object.keys(args)).toEqual(['0'])
  })

  it('reads a revert out of every payload shape a wallet nests it in', () => {
    // The whole point of issue #1267: the write path through an injected wallet leaves raw bytes
    // buried in the RPC payload, and ethers never lifts them onto `.revert`.
    const data = iface.encodeErrorResult('Bounded', [250n])
    const shapes = [
      { data },
      { data: { data } },
      { info: { error: { data } } },
      { error: { data } },
      { error: { error: { data } } },
    ]
    for (const err of shapes) {
      expect(extractRevert(err, parser)).toEqual({ name: 'Bounded', args: [250n] })
    }
    expect(describeRevert(extractRevert(shapes[1], parser))).toBe('Bounded(250)')
  })

  it('does not name an error that is not one of this ABI’s — an operator must not be told something specific that did not happen', () => {
    const foreign = new Interface(['error SomethingElse(uint256 x)']).encodeErrorResult('SomethingElse', [1n])
    expect(extractRevert({ data: foreign }, parser)).toBeNull()
  })
})
