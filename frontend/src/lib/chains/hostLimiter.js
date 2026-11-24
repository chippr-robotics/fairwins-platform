/**
 * One pace and one back-off PER RPC HOST, shared by every request this tab makes to it.
 *
 * WHY. Before this, each request was on its own: a burst of reads (the Protect queue opening, an
 * admin tab mounting, the activity poller) fired all at once, and when the host answered 429 EACH
 * request ran its own retry loop — up to 12 attempts apiece. Thirty concurrent requests meeting a
 * per-second limit became thirty independent retry loops against the same host, which is a request
 * storm that keeps the limit tripped. A 429 is a statement about the HOST, so it now pauses
 * everything bound for that host, and a token bucket keeps a burst inside a rate the host accepts.
 *
 * Loopback (a member's local node, the e2e Hardhat chain) is never paced — it has no limit to
 * respect and the test tiers must not slow down.
 */
import { logScanHostPaces } from '../../config/logScanEndpoints'

/** Pace for a host with no declared limit: generous — this is a guard, not a throttle. */
export const DEFAULT_RPS = 20
/** Longest single host-wide back-off, whatever `retry-after` asks for. */
const MAX_COOLDOWN_MS = 30_000

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const hosts = new Map() // host -> { rps, tokens, last, blockedUntil }
let declared = null

const now = () => Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function hostOf(input) {
  try {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    return new URL(url).host
  } catch {
    return null
  }
}

function stateFor(host) {
  let s = hosts.get(host)
  if (!s) {
    declared ??= logScanHostPaces()
    const rps = declared[host] ?? DEFAULT_RPS
    s = { rps, tokens: rps, last: now(), blockedUntil: 0 }
    hosts.set(host, s)
  }
  return s
}

function exempt(host) {
  if (!host) return true
  return LOOPBACK.has(host.replace(/:\d+$/, ''))
}

/**
 * Wait until this host may be sent one more request: past any host-wide back-off, and within its
 * token bucket (capacity = one second of requests, refilled at `rps`).
 */
export async function acquire(input) {
  const host = hostOf(input)
  if (exempt(host)) return
  const s = stateFor(host)
  for (;;) {
    const t = now()
    if (t < s.blockedUntil) {
      await sleep(s.blockedUntil - t)
      continue
    }
    s.tokens = Math.min(s.rps, s.tokens + ((t - s.last) / 1000) * s.rps)
    s.last = t
    if (s.tokens >= 1) {
      s.tokens -= 1
      return
    }
    await sleep(Math.ceil(((1 - s.tokens) / s.rps) * 1000))
  }
}

/**
 * The host answered 429: back the WHOLE host off for `delayMs` (capped), so every request bound for
 * it waits — not just the one that was refused. The caller decides the delay (`retry-after`, or its
 * own jittered back-off); this only makes it host-wide. Returns the delay applied.
 */
export function penalize(input, delayMs) {
  const host = hostOf(input)
  if (exempt(host)) return 0
  const s = stateFor(host)
  const delay = Math.min(MAX_COOLDOWN_MS, Math.max(0, delayMs))
  s.blockedUntil = Math.max(s.blockedUntil, now() + delay)
  s.tokens = 0
  return delay
}

/** Tests only. */
export function __resetHostLimiter() {
  hosts.clear()
  declared = null
}
