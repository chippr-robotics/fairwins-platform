/**
 * #1535 — the bundler failover the config always advertised.
 *
 * The load-bearing pair: a bundler that did not ANSWER must fall over; a bundler that answered and
 * REJECTED the UserOp must not. The second is the one that is easy to get wrong and expensive when
 * wrong — every bundler rejects an invalid UserOp identically, so fanning out multiplies latency on
 * a path the member is waiting on and re-submits their operation to several third parties for no
 * possible gain.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  bundlerTransport,
  isTerminalBundlerError,
  TERMINAL_BUNDLER_CODES,
} from '../../lib/passkey/bundlerTransport.js'

const rpcError = (code, message = 'nope') => Object.assign(new Error(message), { code })

describe('isTerminalBundlerError — what must NOT fan out', () => {
  it('stops on every ERC-4337 validation rejection', () => {
    for (const code of TERMINAL_BUNDLER_CODES) {
      expect(isTerminalBundlerError(rpcError(code)), `code ${code} must be terminal`).toBe(true)
    }
  })

  it('finds the code through viem\'s wrapping — it is rarely on the outermost error', () => {
    const wrapped = Object.assign(new Error('UserOperation reverted'), {
      cause: Object.assign(new Error('rpc'), { cause: rpcError(-32500) }),
    })
    expect(isTerminalBundlerError(wrapped)).toBe(true)
  })

  it('FAILS OVER on a transport error — no code at all', () => {
    expect(isTerminalBundlerError(new Error('fetch failed'))).toBe(false)
  })

  it('FAILS OVER on an unrecognised code — an unknown error may be this bundler being broken', () => {
    // Erring toward failover is deliberate: trying the next costs a round trip, wrongly stopping
    // costs the member their transaction.
    expect(isTerminalBundlerError(rpcError(-32000))).toBe(false)
    expect(isTerminalBundlerError(rpcError(429))).toBe(false)
  })

  it('is false for null/undefined rather than throwing', () => {
    expect(isTerminalBundlerError(null)).toBe(false)
    expect(isTerminalBundlerError(undefined)).toBe(false)
  })
})

describe('bundlerTransport', () => {
  it('a single URL is a plain http transport — unchanged from before #1535', () => {
    const httpImpl = vi.fn((u) => ({ url: u }))
    const fallbackImpl = vi.fn()
    const t = bundlerTransport(['https://one.example'], { httpImpl, fallbackImpl })
    expect(httpImpl).toHaveBeenCalledWith('https://one.example')
    expect(fallbackImpl).not.toHaveBeenCalled()
    expect(t).toEqual({ url: 'https://one.example' })
  })

  it('two URLs build a fallback in DECLARED ORDER, never re-ranked', () => {
    // rank:false matters — re-ranking by latency would silently move submissions onto a third
    // party we deliberately listed as the backup.
    const httpImpl = vi.fn((u) => ({ url: u }))
    const fallbackImpl = vi.fn((transports, opts) => ({ transports, opts }))
    const t = bundlerTransport(['https://ours.example', 'https://backup.example'], { httpImpl, fallbackImpl })
    expect(t.transports).toEqual([{ url: 'https://ours.example' }, { url: 'https://backup.example' }])
    expect(t.opts.rank).toBe(false)
    expect(t.opts.shouldThrow).toBe(isTerminalBundlerError)
  })

  it('drops empty entries — a trailing comma in the env var is not a bundler', () => {
    const httpImpl = vi.fn((u) => ({ url: u }))
    const fallbackImpl = vi.fn((transports) => ({ transports }))
    bundlerTransport(['https://one.example', '', null], { httpImpl, fallbackImpl })
    expect(httpImpl).toHaveBeenCalledTimes(1)
    expect(fallbackImpl).not.toHaveBeenCalled()
  })

  it('throws on an empty list rather than building a client that cannot submit', () => {
    expect(() => bundlerTransport([])).toThrow(/no bundler URL/)
    expect(() => bundlerTransport(undefined)).toThrow(/no bundler URL/)
  })

  it('does not rely on viem\'s default shouldThrow, which stops only on user-rejection', () => {
    // The reason this module exists: viem's default would treat a -32500 EntryPoint validation
    // rejection as retryable and fan it out to every configured bundler. Asserted as a property of
    // OUR predicate rather than by importing viem's internals, which are not a public contract.
    expect(isTerminalBundlerError(rpcError(-32500))).toBe(true)
    expect(isTerminalBundlerError(rpcError(-32507))).toBe(true) // invalid signature — same op, same answer
  })
})
