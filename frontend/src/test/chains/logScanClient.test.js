/**
 * getLogScanClient — where event history is read from. The build-default rail on most public
 * providers refuses historical eth_getLogs, so history has its own public endpoint per chain;
 * a member's own endpoint (spec 069) still wins.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.unmock('../../lib/chains/publicClient')
const { AUTH_MODES, saveEndpointSettings, __resetEndpointStoreForTests } = await import('../../lib/network/endpointStore')
const { getLogScanClient, __resetPublicClientCache } = await import('../../lib/chains/publicClient')

beforeEach(() => {
  localStorage.clear()
  __resetEndpointStoreForTests()
  __resetPublicClientCache()
})

describe('getLogScanClient', () => {
  it('Arbitrum history goes to the Offchain Labs public endpoint at its measured width', () => {
    const s = getLogScanClient(42161)
    expect(s.source).toBe('logs')
    expect(s.client.transport.url).toBe('https://arb1.arbitrum.io/rpc')
    expect(s.maxRange).toBe(100_000)
  })

  it('Optimism uses the OP Labs public endpoint at its 10k cap', () => {
    expect(getLogScanClient(10).client.transport.url).toBe('https://mainnet.optimism.io')
    expect(getLogScanClient(10).maxRange).toBe(10_000)
  })

  it('Base has NO public history endpoint (none was verified) — it keeps the normal route', () => {
    expect(getLogScanClient(8453).client).toBeNull()
  })

  it('the dedicated log client makes ONE attempt per request (429 pacing is the limiter\'s job)', () => {
    // viem exposes neither `batch` nor `fetchFn` on the transport object, so only the retry count is
    // observable here; the batching choice is pinned by reading the source, not asserted vacuously.
    expect(getLogScanClient(10).client.transport.retryCount).toBe(0)
  })

  it('a MEMBER endpoint wins — no dedicated client, default width to adapt from', () => {
    saveEndpointSettings(42161, { url: 'https://arb-mainnet.g.alchemy.com/v2/member-key', authMode: AUTH_MODES.NONE })
    const s = getLogScanClient(42161)
    expect(s.source).toBe('member')
    expect(s.client).toBeNull()
    expect(s.maxRange).toBe(10_000)
  })

  it('a chain with no public log endpoint keeps its normal route (Polygon: issued keyed access)', () => {
    const s = getLogScanClient(137)
    expect(s.client).toBeNull()
    expect(s.maxRange).toBe(10_000)
  })

  it('ETC/Mordor keep their defaults but at the width they accept', () => {
    expect(getLogScanClient(63).client).toBeNull()
    expect(getLogScanClient(63).maxRange).toBe(1_000_000)
  })
})
