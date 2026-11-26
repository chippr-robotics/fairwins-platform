/**
 * predictClient (spec 057) — the SPA side of the /v1/polymarket/* proxy for the PUBLIC read surface.
 * Verifies gateway-unset soft-fail, success mapping, and fee-fetch failure. (Authed trading is
 * client-direct via clobSession — not this module.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  predictGatewayUrl,
  predictAvailable,
  fetchMarkets,
  fetchFeeRate,
  fetchEvents,
  fetchEvent,
  fetchDiscover,
  fetchBooks,
  fetchHistory,
  PredictUnavailable,
} from '../../lib/predict/predictClient'

const BASE = 'https://gw.test'
const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

beforeEach(() => {
  import.meta.env.VITE_RELAYER_URL = BASE
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => {
  vi.unstubAllGlobals()
  delete import.meta.env.VITE_RELAYER_URL
})

describe('predictGatewayUrl / predictAvailable', () => {
  it('reads the env and strips a trailing slash', () => {
    import.meta.env.VITE_RELAYER_URL = `${BASE}/`
    expect(predictGatewayUrl()).toBe(BASE)
  })
  it('is unavailable off Polygon (capability false) even with a gateway', () => {
    expect(predictAvailable(137)).toBe(true)
    expect(predictAvailable(1)).toBe(false)
  })
  it('is unavailable when no gateway is configured', () => {
    delete import.meta.env.VITE_RELAYER_URL
    expect(predictAvailable(137)).toBe(false)
  })
})

describe('reads/writes', () => {
  it('lists markets on success', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ markets: [{ conditionId: '0xabc' }], next: null }))
    const r = await fetchMarkets(137, { q: 'rain' })
    expect(r.markets[0].conditionId).toBe('0xabc')
    expect(fetch.mock.calls[0][0]).toContain('/v1/polymarket/137/markets?q=rain')
  })

  it('throws PredictUnavailable when the fee schedule cannot be confirmed', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ error: { code: 'fee_unavailable', reason: 'try again' } }, 503))
    await expect(fetchFeeRate(137, '123')).rejects.toMatchObject({ name: 'PredictUnavailable', code: 'fee_unavailable' })
  })

  it('soft-fails when the gateway is unconfigured', async () => {
    delete import.meta.env.VITE_RELAYER_URL
    await expect(fetchMarkets(137)).rejects.toBeInstanceOf(PredictUnavailable)
  })
})

describe('spec 114 reads', () => {
  it('fetchEvents sends only the filters it was given', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ events: [], next: null }))
    await fetchEvents(137, { category: 'economy', sort: 'closing', next: '20' })
    expect(fetch.mock.calls[0][0]).toBe(`${BASE}/v1/polymarket/137/events?category=economy&sort=closing&next=20`)
    fetch.mockResolvedValueOnce(jsonRes({ events: [] }))
    await fetchEvents(137, { q: 'fed rate' })
    expect(fetch.mock.calls[1][0]).toBe(`${BASE}/v1/polymarket/137/events?q=fed+rate`)
    fetch.mockResolvedValueOnce(jsonRes({ events: [] }))
    await fetchEvents(137)
    expect(fetch.mock.calls[2][0]).toBe(`${BASE}/v1/polymarket/137/events`)
  })

  it('fetchEvents passes topic, and live=1 only when true', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ events: [] }))
    await fetchEvents(137, { topic: 'NBA-finals', sort: 'newest' })
    expect(fetch.mock.calls[0][0]).toBe(`${BASE}/v1/polymarket/137/events?topic=NBA-finals&sort=newest`)
    fetch.mockResolvedValueOnce(jsonRes({ events: [] }))
    await fetchEvents(137, { live: true })
    expect(fetch.mock.calls[1][0]).toBe(`${BASE}/v1/polymarket/137/events?live=1`)
    fetch.mockResolvedValueOnce(jsonRes({ events: [] }))
    await fetchEvents(137, { live: false, topic: '' })
    expect(fetch.mock.calls[2][0]).toBe(`${BASE}/v1/polymarket/137/events`)
  })

  it('fetchDiscover reads /discover and keeps a null half null', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ live: null, topics: [{ slug: 'nfl', label: 'NFL', events: 3, volume24h: '1' }] }))
    const r = await fetchDiscover(137)
    expect(fetch.mock.calls[0][0]).toBe(`${BASE}/v1/polymarket/137/discover`)
    expect(r.live).toBeNull()
    expect(r.topics).toHaveLength(1)
  })

  it('fetchDiscover carries the status of a missing route', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ error: { code: 'not_found', reason: 'nope' } }, 404))
    await expect(fetchDiscover(137)).rejects.toMatchObject({ status: 404 })
  })

  it('fetchEvent encodes the slug', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ slug: 'a-b' }))
    const r = await fetchEvent(137, 'a-b/../x')
    expect(r.slug).toBe('a-b')
    expect(fetch.mock.calls[0][0]).toBe(`${BASE}/v1/polymarket/137/events/a-b%2F..%2Fx`)
  })

  it('fetchBooks joins token ids with commas', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ books: [], unreadable: [] }))
    await fetchBooks(137, ['111', '222'])
    expect(fetch.mock.calls[0][0]).toBe(`${BASE}/v1/polymarket/137/books?token_ids=111,222`)
  })

  it('fetchHistory passes token and range', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ points: [] }))
    await fetchHistory(137, '111', '1w')
    expect(fetch.mock.calls[0][0]).toBe(`${BASE}/v1/polymarket/137/prices-history?token_id=111&range=1w`)
  })

  it('surfaces a gateway error code from a books read', async () => {
    fetch.mockResolvedValueOnce(jsonRes({ error: { code: 'upstream_unavailable', reason: 'down' } }, 503))
    await expect(fetchBooks(137, ['1'])).rejects.toMatchObject({ name: 'PredictUnavailable', code: 'upstream_unavailable', status: 503 })
  })
})
