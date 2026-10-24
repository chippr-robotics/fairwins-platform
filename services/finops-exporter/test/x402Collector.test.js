/**
 * x402 collector (spec 089 + 096).
 *
 * THE ONE THING THESE TESTS EXIST FOR: the treasury is shared. The FeeRouter forwards platform fees
 * to the same address x402 pays into, so a collector that counted arrivals would report fee revenue
 * as agent revenue — a real number attributed to the wrong source, which is worse than no number.
 * The discrimination rule (a `Transfer` into the treasury whose transaction ALSO used an EIP-3009
 * authorization) is therefore the behaviour under test, not an implementation detail.
 */
import { describe, it, expect } from 'vitest'
import { ethers } from 'ethers'
import { createX402Collector } from '../src/collectors/x402.js'

const TREASURY = '0xcf76db7aa9Fb1BFe08E010468F3344bB45830447'
const TOKEN = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
const OTHER = '0x1215185387E70a48b07D73AcB67002A073F18575'

const IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
])

const TRANSFER_TOPIC = IFACE.getEvent('Transfer').topicHash.toLowerCase()
const AUTH_TOPIC = IFACE.getEvent('AuthorizationUsed').topicHash.toLowerCase()

const usdc = (n) => ethers.parseUnits(String(n), 6)

function transferLog({ from = OTHER, to, value, txHash, blockNumber = 900 }) {
  const enc = IFACE.encodeEventLog('Transfer', [from, to, value])
  return { ...enc, address: TOKEN, transactionHash: txHash, blockNumber }
}

function authorizationLog({ authorizer = OTHER, nonce = ethers.id('n'), txHash, blockNumber = 900 }) {
  const enc = IFACE.encodeEventLog('AuthorizationUsed', [authorizer, nonce])
  return { ...enc, address: TOKEN, transactionHash: txHash, blockNumber }
}

/** Minimal cursor store with the surface the collector uses. */
function cursorStore() {
  const at = new Map()
  const totals = new Map()
  return {
    get: (k, fallback) => at.get(k) ?? fallback,
    set: (k, v) => at.set(k, v),
    accumulate: (k, d) => totals.set(k, (totals.get(k) ?? 0n) + d),
    total: (k) => totals.get(k) ?? 0n,
  }
}

/**
 * A provider fake that ACTUALLY APPLIES THE FILTER.
 *
 * The previous fake was `getLogs: async () => logs` — it returned the same array whatever it was
 * asked for. That is why the chain-wide filter this collector used to send shipped and survived a
 * green suite for its whole life: a stub that ignores `topics` cannot tell a filter scoped to the
 * treasury from one that asks for every `Transfer` on Polygon USDC. In production that was ~1.1M
 * logs and ~635 MB of JSON in a 192 MB container, so the exporter was OOM-killed before it ever
 * listened and EVERY FinOps panel read "no data".
 *
 * A fake that honours the filter is not a nicety here; it is the only version of this fake that
 * can fail when the filter is wrong. `asked` records every call so a test can assert on the
 * REQUEST, not just the answer — the memory cost lives in what we ask for, and no assertion about
 * the returned value can see it.
 */
function matchesTopics(logTopics, filterTopics) {
  if (!filterTopics) return true
  return filterTopics.every((want, i) => {
    if (want == null) return true
    const got = (logTopics[i] ?? '').toLowerCase()
    const options = (Array.isArray(want) ? want : [want]).map((t) => String(t).toLowerCase())
    return options.includes(got)
  })
}

function harness(logs, { payTo = TREASURY, paymentToken = TOKEN, head = 1000 } = {}) {
  const config = {
    x402: { payTo, chainId: 137, paymentToken },
    confirmations: { 137: 0 },
    lookbackBlocks: 500,
  }
  const asked = []
  const providers = {
    137: {
      getBlockNumber: async () => head,
      getLogs: async (filter) => {
        asked.push(filter)
        return logs.filter(
          (l) =>
            (!filter.address || l.address.toLowerCase() === filter.address.toLowerCase()) &&
            matchesTopics(l.topics, filter.topics) &&
            (filter.fromBlock == null || l.blockNumber >= filter.fromBlock) &&
            (filter.toBlock == null || l.blockNumber <= filter.toBlock),
        )
      },
    },
  }
  const collect = createX402Collector({ config, providers, cursors: cursorStore(), log: () => {} })
  collect.asked = asked
  return collect
}

const SOURCE = { id: 'x402-agent-payments', chains: [137] }

describe('x402 collector — telling settlements apart from every other USDC arrival', () => {
  it('counts a transfer into the treasury whose transaction used an authorization', async () => {
    const collect = harness([
      transferLog({ to: TREASURY, value: usdc('0.05'), txHash: '0xaa' }),
      authorizationLog({ txHash: '0xaa' }),
    ])
    const r = await collect(SOURCE)
    expect(r.state).toBe('read')
    expect(r.value).toBeCloseTo(0.05, 9)
    expect(r.unit).toBe('USDC')
  })

  it('IGNORES a plain transfer into the same treasury — this is the FeeRouter forwarding a fee', async () => {
    const collect = harness([transferLog({ to: TREASURY, value: usdc('100'), txHash: '0xbb' })])
    const r = await collect(SOURCE)
    expect(r.state).toBe('read')
    // Counting this would report $100 of fee revenue as agent revenue.
    expect(r.value).toBe(0)
  })

  it('IGNORES an authorization-settled transfer to somewhere else — the intent rail', async () => {
    const collect = harness([
      transferLog({ to: OTHER, value: usdc('7'), txHash: '0xcc' }),
      authorizationLog({ txHash: '0xcc' }),
    ])
    const r = await collect(SOURCE)
    expect(r.value).toBe(0)
  })

  it('does not let an authorization in ONE transaction qualify a plain transfer in ANOTHER', async () => {
    const collect = harness([
      authorizationLog({ txHash: '0xdd' }),
      transferLog({ to: TREASURY, value: usdc('42'), txHash: '0xee' }),
    ])
    const r = await collect(SOURCE)
    expect(r.value).toBe(0)
  })

  it('sums several settlements and keeps a mixed batch honest', async () => {
    const collect = harness([
      transferLog({ to: TREASURY, value: usdc('0.01'), txHash: '0x01' }),
      authorizationLog({ txHash: '0x01' }),
      transferLog({ to: TREASURY, value: usdc('0.10'), txHash: '0x02' }),
      authorizationLog({ txHash: '0x02' }),
      transferLog({ to: TREASURY, value: usdc('500'), txHash: '0x03' }), // a fee arrival
      transferLog({ to: OTHER, value: usdc('9'), txHash: '0x04' }), // not ours
      authorizationLog({ txHash: '0x04' }),
    ])
    const r = await collect(SOURCE)
    expect(r.value).toBeCloseTo(0.11, 9)
  })

  /**
   * THE REGRESSION GUARD, and the reason it asserts on the REQUEST.
   *
   * Every test above passes with a chain-wide filter, because they all check the number that comes
   * out — and the number was always right. What was wrong was what we ASKED FOR: `topics:
   * [[Transfer, AuthorizationUsed]]` against Polygon USDC pulls the token's entire traffic into one
   * array before discarding ~99.99% of it. That is invisible to any assertion about the result, and
   * it is the whole failure: the exporter was OOM-killed before `app.listen()` on every boot, so it
   * published nothing at all and the dashboards showed "no data" for sources that were fine.
   */
  it('asks the chain for transfers INTO THE TREASURY, never for the token\'s whole traffic', async () => {
    const collect = harness([
      transferLog({ to: TREASURY, value: usdc('0.05'), txHash: '0xaa' }),
      authorizationLog({ txHash: '0xaa' }),
    ])
    await collect(SOURCE)

    const treasuryTopic = ethers.zeroPadValue(ethers.getAddress(TREASURY), 32).toLowerCase()
    const transferScans = collect.asked.filter(
      (f) => String(f.topics?.[0] ?? '').toLowerCase() === TRANSFER_TOPIC,
    )
    expect(transferScans.length).toBeGreaterThan(0)
    for (const f of transferScans) {
      // topics[2] is the indexed `to`. Narrowed here means the RPC does the discarding, not us.
      expect(String(f.topics?.[2] ?? '').toLowerCase()).toBe(treasuryTopic)
      expect(f.address.toLowerCase()).toBe(TOKEN.toLowerCase())
    }
  })

  it('reads the authorization leg only in blocks a treasury transfer actually landed in', async () => {
    const collect = harness([
      transferLog({ to: TREASURY, value: usdc('0.05'), txHash: '0xaa', blockNumber: 700 }),
      authorizationLog({ txHash: '0xaa', blockNumber: 700 }),
    ])
    await collect(SOURCE)

    const authScans = collect.asked.filter(
      (f) => String(f.topics?.[0] ?? '').toLowerCase() === AUTH_TOPIC,
    )
    // One block had a candidate; the other ~500 in the lookback are never asked about. A
    // chain-wide authorization scan has exactly the same memory profile as the transfer one did.
    expect(authScans).toHaveLength(1)
    expect(authScans[0].fromBlock).toBe(700)
    expect(authScans[0].toBlock).toBe(700)
  })

  it('asks for NOTHING on the authorization leg when no treasury transfer landed', async () => {
    const collect = harness([transferLog({ to: OTHER, value: usdc('9'), txHash: '0x04' })])
    const r = await collect(SOURCE)
    expect(r.value).toBe(0)
    expect(collect.asked.filter((f) => String(f.topics?.[0] ?? '').toLowerCase() === AUTH_TOPIC)).toHaveLength(0)
  })

  it('reports not-configured — never $0 — when the rail is not offered', async () => {
    const r = await harness([], { payTo: null })(SOURCE)
    expect(r.state).toBe('not-configured')
    expect(r.value).toBeNull()
  })

  it('reports not-configured when the chain records no EIP-3009 token', async () => {
    const r = await harness([], { paymentToken: null })(SOURCE)
    expect(r.state).toBe('not-configured')
  })

  it('reports unreadable — never a smaller-but-plausible number — when the scan fails', async () => {
    const collect = createX402Collector({
      config: { x402: { payTo: TREASURY, chainId: 137, paymentToken: TOKEN }, confirmations: { 137: 0 }, lookbackBlocks: 500 },
      providers: {
        137: {
          getBlockNumber: async () => 1000,
          getLogs: async () => {
            throw new Error('range too wide')
          },
        },
      },
      cursors: cursorStore(),
      log: () => {},
    })
    const r = await collect(SOURCE)
    expect(r.state).toBe('unreadable')
    expect(r.value).toBeNull()
  })
})
