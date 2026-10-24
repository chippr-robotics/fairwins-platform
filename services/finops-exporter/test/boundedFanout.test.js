/**
 * The boot fan-out is bounded, and outbound RPC is paced (spec 089, #1585).
 *
 * Both exist because #1577 made the exporter actually run, and a working exporter immediately put
 * ~25 sources onto the wire at once — each chunking `eth_getLogs` up to 25 times — which took
 * eleven sources `unreadable` with the vendor's `-32007 50/second request limit reached` for about
 * two minutes on every restart. The budget it was spending is SHARED with the gateway and bundler.
 *
 * These assert on the SHAPE OF THE LOAD, not on outcomes: peak concurrency and request spacing are
 * the properties the vendor actually measures, and no assertion about a returned value can see
 * either.
 */
import { describe, it, expect } from 'vitest'
import { createScheduler } from '../src/scheduler.js'
import { createRateLimiter } from '../src/chain/rateLimit.js'
import { scanLogs } from '../src/chain/logs.js'
import { read } from '../src/reading.js'

const sourcesOf = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: 'cost', status: 'live', collector: 'x', interval: 600 }))

describe('collectAll is bounded', () => {
  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const collectors = {
      x: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight -= 1
        return read(1, 'USD')
      },
    }
    const scheduler = createScheduler({ sources: sourcesOf(25), collectors, log: () => {}, bootConcurrency: 4 })
    await scheduler.collectAll()

    expect(peak).toBeLessThanOrEqual(4)
    // The old behaviour: 25. Asserted so a revert to Promise.all fails here rather than in prod.
    expect(peak).toBeGreaterThan(1)
  })

  it('still collects EVERY source — a bound must not drop work', async () => {
    const seen = []
    const scheduler = createScheduler({
      sources: sourcesOf(25),
      collectors: { x: async (s) => { seen.push(s.id); return read(1, 'USD') } },
      log: () => {},
      bootConcurrency: 3,
    })
    await scheduler.collectAll()
    expect(seen).toHaveLength(25)
    expect(new Set(seen).size).toBe(25)
  })

  it('one slow source does not stop the others finishing', async () => {
    const done = []
    const scheduler = createScheduler({
      sources: sourcesOf(8),
      collectors: {
        x: async (s) => {
          if (s.id === 's0') await new Promise((r) => setTimeout(r, 40))
          done.push(s.id)
          return read(1, 'USD')
        },
      },
      log: () => {},
      bootConcurrency: 3,
    })
    await scheduler.collectAll()
    expect(done).toHaveLength(8)
    // The slow one finishes late; the pool keeps moving rather than blocking on it.
    expect(done[done.length - 1]).not.toBe('s1')
  })
})

describe('outbound RPC is paced', () => {
  it('spaces requests even when callers are concurrent', async () => {
    // The property that matters: a concurrency bound does NOT bound rate. Five callers arriving at
    // once must still be spread across time.
    const limiter = createRateLimiter({ perSecond: 100 }) // 10ms apart
    const started = Date.now()
    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()))
    expect(Date.now() - started).toBeGreaterThanOrEqual(35)
  })

  it('paces scanLogs between chunks', async () => {
    const at = []
    const provider = { getLogs: async () => { at.push(Date.now()); return [] } }
    const limiter = createRateLimiter({ perSecond: 100 })

    await scanLogs(provider, { address: '0xa', topics: ['0xb'] }, 0, 7_999, { chunk: 2_000, limiter })

    expect(at).toHaveLength(4)
    const gaps = at.slice(1).map((t, i) => t - at[i])
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(8)
  })

  it('an unset rate disables pacing rather than deadlocking on zero', async () => {
    // A misconfigured limiter that silently stopped every read would be a worse outage than the
    // burst it prevents, so 0 must mean "off", never "never".
    const limiter = createRateLimiter({ perSecond: 0 })
    const started = Date.now()
    for (let i = 0; i < 50; i += 1) await limiter.acquire()
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('resolves its delay without the event loop being held open elsewhere', async () => {
    // The pacing timer must NOT be unref()ed: it sits inside in-flight work, and an unref'd timer
    // lets the process exit mid-collection with acquire() never resolving.
    const limiter = createRateLimiter({ perSecond: 200 })
    await expect(limiter.acquire()).resolves.toBeUndefined()
  })
})
