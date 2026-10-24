/**
 * News client seam tests (spec 109): three-state honesty + honest-empty, the zero-network
 * short-circuit for unmapped assets, and pass-through without invention.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchTokenNews } from '../../lib/news/newsClient'

const GATEWAY = 'https://relay.test.invalid'

const READ_BODY = {
  state: 'read',
  fetchedAt: '2026-09-07T00:00:00Z',
  stale: false,
  items: [
    {
      id: '1',
      title: 'Headline',
      url: 'https://news.example/a',
      source: { name: 'Example', slug: 'example' },
      publishedAt: '2026-09-06T12:00:00Z',
      sentiment: 0,
    },
  ],
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.stubEnv('VITE_RELAYER_URL', GATEWAY)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('fetchTokenNews', () => {
  it('returns read with items for a mapped asset, passing the gateway body through', async () => {
    const fetchImpl = vi.fn(async () => json(READ_BODY))
    const reading = await fetchTokenNews({ chainId: 137, fetchImpl })
    expect(reading.state).toBe('read')
    expect(reading.items).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/v1/news/137/native')
    expect(url).toContain('slug=matic-network')
  })

  it('honest-empty passes through: read with items [] stays read, never becomes a failure', async () => {
    const fetchImpl = vi.fn(async () => json({ ...READ_BODY, items: [] }))
    const reading = await fetchTokenNews({ chainId: 137, fetchImpl })
    expect(reading.state).toBe('read')
    expect(reading.items).toEqual([])
  })

  it('unmapped asset short-circuits to not-covered with ZERO network calls', async () => {
    const fetchImpl = vi.fn()
    const reading = await fetchTokenNews({ chainId: 137, address: '0x' + 'ab'.repeat(20), fetchImpl })
    expect(reading.state).toBe('not-covered')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('no gateway configured resolves not-configured without a network call', async () => {
    vi.stubEnv('VITE_RELAYER_URL', '')
    const fetchImpl = vi.fn()
    const reading = await fetchTokenNews({ chainId: 137, fetchImpl })
    expect(reading.state).toBe('not-configured')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('503 news_unconfigured resolves not-configured (the surface hides); other errors are unreadable', async () => {
    const off = await fetchTokenNews({
      chainId: 137,
      fetchImpl: async () => json({ error: { code: 'news_unconfigured' } }, 503),
    })
    expect(off.state).toBe('not-configured')

    const flaky = await fetchTokenNews({ chainId: 137, fetchImpl: async () => json({ nonsense: true }, 500) })
    expect(flaky.state).toBe('unreadable')
  })

  it('404 resolves not-configured: a gateway image without the module is ABSENCE, not a failure', async () => {
    /*
     * The SPA and the gateway deploy independently, so there is a window where the news card is
     * live and the gateway image still predates the module. Its routes then 404. Reading that as
     * `unreadable` put a sentence and a Retry the member cannot act on onto every asset sheet and
     * every trade pair; the surface is simply not there yet, and absence renders nothing.
     *
     * Unambiguous by construction: the module mounts unconditionally, so an image carrying it
     * answers 503 when switched off and never 404s.
     */
    const reading = await fetchTokenNews({ chainId: 137, fetchImpl: async () => json({}, 404) })
    expect(reading.state).toBe('not-configured')
    expect(reading.reason).toBeUndefined()
  })

  it('transport failure is unreadable — never an empty read', async () => {
    const reading = await fetchTokenNews({
      chainId: 137,
      fetchImpl: async () => {
        throw new Error('offline')
      },
    })
    expect(reading.state).toBe('unreadable')
    expect(reading.items).toBeUndefined()
  })

  it("passes the gateway's unreadable through with its reason, and treats unknown shapes as unreadable", async () => {
    const up = await fetchTokenNews({
      chainId: 137,
      fetchImpl: async () => json({ state: 'unreadable', reason: 'upstream_unreachable' }),
    })
    expect(up).toEqual({ state: 'unreadable', reason: 'upstream_unreachable' })

    const weird = await fetchTokenNews({ chainId: 137, fetchImpl: async () => json({ state: '???' }) })
    expect(weird.state).toBe('unreadable')
  })

  it('Bitcoin string ids ride the bitcoin slug and never an EVM-shaped path segment', async () => {
    const fetchImpl = vi.fn(async () => json(READ_BODY))
    await fetchTokenNews({ chainId: 'bitcoin', fetchImpl })
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('/v1/news/bitcoin/native')
    expect(url).toContain('slug=bitcoin')
  })
})
