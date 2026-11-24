/**
 * lib/chains/hostLimiter — a pace and a back-off per RPC HOST, shared by every request to it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { acquire, penalize, __resetHostLimiter, DEFAULT_RPS } from '../../lib/chains/hostLimiter'

beforeEach(() => {
  __resetHostLimiter()
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

async function countWithin(ms, url, n) {
  let done = 0
  for (let i = 0; i < n; i += 1) acquire(url).then(() => (done += 1))
  await vi.advanceTimersByTimeAsync(ms)
  return done
}

describe('hostLimiter', () => {
  it('holds a declared host to its pace (OP Labs public endpoint: 4/s)', async () => {
    expect(await countWithin(0, 'https://mainnet.optimism.io', 10)).toBe(4)
  })

  it('allows a one-second burst at the default pace on an undeclared host', async () => {
    expect(await countWithin(0, 'https://rpc.example/x', DEFAULT_RPS + 5)).toBe(DEFAULT_RPS)
  })

  it('a 429 backs off the WHOLE host — requests that were not refused wait too', async () => {
    await acquire('https://rpc.example/a')
    penalize('https://rpc.example/a', 2000)
    let other = false
    acquire('https://rpc.example/b').then(() => (other = true))
    await vi.advanceTimersByTimeAsync(1999)
    expect(other).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect(other).toBe(true)
  })

  it('a back-off on one host never slows another', async () => {
    penalize('https://rpc.example/a', 10_000)
    let other = false
    acquire('https://other.example/').then(() => (other = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(other).toBe(true)
  })

  it('never paces loopback (a local node, the e2e chain)', async () => {
    penalize('http://127.0.0.1:8545', 10_000)
    expect(await countWithin(0, 'http://127.0.0.1:8545', 500)).toBe(500)
  })
})
