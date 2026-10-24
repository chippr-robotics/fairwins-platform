/**
 * /v1/news/* read-proxy tests (spec 109 — contracts/gateway-news-api.md).
 * The vendor upstream is mocked via the injectable newsFetch; fixtures mirror the REAL Alphaday
 * payload shape captured by live probe on 2026-09-06 (research R3). Same
 * build-the-app-with-injected-deps pattern as perps.test.js.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server.js'
import { createKillSwitch } from '../src/policy/killswitch.js'
import { normalizeNewsItem, normalizeNewsResponse, SLUG_RE } from '../src/news/normalize.js'
import { testConfig, mockProviders, mockEngine, ORIGIN_SECRET, TEST_NOW } from './helpers.js'

// ---- upstream fixture (real vendor payload shape, trimmed; research R3) -------------------------

const VENDOR_ITEM = {
  id: '409910',
  hash: '632f4899dc287e9508a81924c85a996b38573008bfa84945aea5d65e43f8b77f',
  title: 'Cryptoquant: BTC-to-Altcoin Rotation Has Collapsed',
  url: 'https://news.bitcoin.com/cryptoquant-altcoin-rotation-collapsed-2026/',
  image: 'https://static.news.bitcoin.com/wp-content/uploads/2022/06/cropped-favicon-32x32.png',
  author: 'None',
  published_at: '2026-06-20T16:53:00Z',
  source: { name: 'Bitcoin.com', slug: 'bitcoin_com_news', icon: 'https://cdn.alphaday.com/media/icon.png' },
  is_bookmarked: false,
  is_liked: false,
  sentiment: -1,
  sentiment_score: -0.08,
  likes: 0,
}

const VENDOR_OK = { links: { next: null, previous: null }, results: [VENDOR_ITEM] }
const VENDOR_EMPTY = { links: { next: null, previous: null }, results: [] }

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function makeApp({ env = {}, fetchImpl } = {}) {
  const config = testConfig({ NEWS_ENABLED: 'true', ...env })
  // deps.now is UNIX SECONDS (server.js: nowMs = () => now() * 1000) — advance in seconds.
  const clock = { t: TEST_NOW }
  const calls = []
  const newsFetch =
    fetchImpl ??
    (async (url) => {
      calls.push(String(url))
      return jsonResponse(VENDOR_OK)
    })
  const killSwitch = createKillSwitch(false)
  const { app } = createApp(config, {
    providers: mockProviders(config),
    engineClient: mockEngine(),
    now: () => clock.t,
    killSwitch,
    newsFetch,
  })
  return { app, config, clock, calls, killSwitch }
}

const get = (app, path) => request(app).get(path).set('X-Origin-Auth', ORIGIN_SECRET)

const ROUTE = '/v1/news/137/native?slug=polygon'

// ---- unit: normalize ----------------------------------------------------------------------------

describe('news normalize', () => {
  it('maps the vendor item to the NewsItem shape and drops account/image fields', () => {
    const item = normalizeNewsItem(VENDOR_ITEM)
    expect(item).toEqual({
      id: '409910',
      title: 'Cryptoquant: BTC-to-Altcoin Rotation Has Collapsed',
      url: 'https://news.bitcoin.com/cryptoquant-altcoin-rotation-collapsed-2026/',
      source: { name: 'Bitcoin.com', slug: 'bitcoin_com_news' },
      publishedAt: '2026-06-20T16:53:00Z',
      sentiment: -1,
    })
    // Text-only rule (FR-005): no image, no icon, no vendor-account fields survive.
    expect(Object.keys(item)).not.toContain('image')
    expect(Object.keys(item.source)).not.toContain('icon')
  })

  it('drops an item with a non-https url — the link IS the interaction, so it must be safe', () => {
    expect(normalizeNewsItem({ ...VENDOR_ITEM, url: 'http://plain.example/a' })).toBeNull()
    expect(normalizeNewsItem({ ...VENDOR_ITEM, url: 'javascript:alert(1)' })).toBeNull()
  })

  it('drops an undated item — the mandatory age display cannot be honest without a date', () => {
    expect(normalizeNewsItem({ ...VENDOR_ITEM, published_at: null })).toBeNull()
    expect(normalizeNewsItem({ ...VENDOR_ITEM, published_at: 'not-a-date' })).toBeNull()
  })

  it('forwards only the coarse sentiment label, never the score', () => {
    expect(normalizeNewsItem({ ...VENDOR_ITEM, sentiment: 2 }).sentiment).toBeNull()
    expect(normalizeNewsItem({ ...VENDOR_ITEM, sentiment: null }).sentiment).toBeNull()
  })

  it('normalizes a whole response and tolerates junk entries', () => {
    const items = normalizeNewsResponse({ results: [VENDOR_ITEM, null, { title: 'x' }] })
    expect(items).toHaveLength(1)
    expect(normalizeNewsResponse({})).toEqual([])
  })

  it('slug shape is bounded lowercase kebab', () => {
    expect(SLUG_RE.test('ethereum-classic')).toBe(true)
    expect(SLUG_RE.test('UPPER')).toBe(false)
    expect(SLUG_RE.test('a'.repeat(65))).toBe(false)
    expect(SLUG_RE.test('')).toBe(false)
  })
})

// ---- routes -------------------------------------------------------------------------------------

describe('GET /v1/news/:chainId/:asset', () => {
  it('answers read with normalized items for a covered slug', async () => {
    const { app } = makeApp()
    const res = await get(app, ROUTE)
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('read')
    expect(res.body.stale).toBe(false)
    expect(res.body.items).toHaveLength(1)
    expect(res.body.items[0].source.name).toBe('Bitcoin.com')
  })

  it('honest-empty: a vendor [] answers read with items: [] — distinct from unreadable', async () => {
    const { app } = makeApp({ fetchImpl: async () => jsonResponse(VENDOR_EMPTY) })
    const res = await get(app, ROUTE)
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('read')
    expect(res.body.items).toEqual([])
  })

  it('unreadable: vendor 5xx with nothing cached answers state unreadable, never an empty read', async () => {
    const { app } = makeApp({ fetchImpl: async () => jsonResponse({ detail: 'boom' }, 500) })
    const res = await get(app, ROUTE)
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('unreadable')
    expect(res.body.items).toBeUndefined()
  })

  it('unreadable: vendor unreachable (transport error) degrades the same way', async () => {
    const { app } = makeApp({
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    const res = await get(app, ROUTE)
    expect(res.body.state).toBe('unreadable')
  })

  it('requires the slug — the firehose is not a member surface', async () => {
    const { app } = makeApp()
    const res = await get(app, '/v1/news/137/native')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_params')
  })

  it('validates slug shape, limit bounds, chainId and asset segments locally (never proxied)', async () => {
    const { app, calls } = makeApp()
    expect((await get(app, '/v1/news/137/native?slug=BAD_SLUG')).status).toBe(400)
    expect((await get(app, `${ROUTE}&limit=0`)).status).toBe(400)
    expect((await get(app, `${ROUTE}&limit=21`)).status).toBe(400)
    expect((await get(app, '/v1/news/notachain/native?slug=polygon')).status).toBe(400)
    expect((await get(app, '/v1/news/137/NOTANASSET?slug=polygon')).status).toBe(400)
    // Mixed-case address is refused too — the mapping emits lowercase, and shape is the contract.
    expect((await get(app, '/v1/news/137/0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?slug=polygon')).status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('accepts the spec-061 Bitcoin string network id without touching EVM shapes', async () => {
    const { app } = makeApp()
    const res = await get(app, '/v1/news/bitcoin/native?slug=bitcoin')
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('read')
  })

  it('module off answers 503 news_unconfigured (mounted unconditionally, never a bare 404)', async () => {
    const { app } = makeApp({ env: { NEWS_ENABLED: 'false' } })
    const res = await get(app, ROUTE)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('news_unconfigured')
  })

  it('module killswitch answers 503 news_killed before anything else', async () => {
    const { app } = makeApp({ env: { NEWS_KILLSWITCH: 'true' } })
    const res = await get(app, ROUTE)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('news_killed')
  })

  it('single-flight + cache: N concurrent viewers of one asset produce exactly 1 upstream request (SC-005)', async () => {
    const { app, calls } = makeApp()
    await Promise.all([get(app, ROUTE), get(app, ROUTE), get(app, ROUTE)])
    await get(app, ROUTE) // a fourth read inside the TTL window is a pure cache hit
    expect(calls).toHaveLength(1)
  })

  it('distinct slugs are distinct cache keys', async () => {
    const { app, calls } = makeApp()
    await get(app, ROUTE)
    await get(app, '/v1/news/61/native?slug=ethereum-classic')
    expect(calls).toHaveLength(2)
  })

  it('serve-stale is marked, and beyond STALE_FACTOR x TTL degrades to unreadable — never stale-as-live', async () => {
    let fail = false
    const { app, clock, config } = makeApp({
      fetchImpl: async () => {
        if (fail) return jsonResponse({ detail: 'down' }, 500)
        return jsonResponse(VENDOR_OK)
      },
    })
    expect((await get(app, ROUTE)).body.stale).toBe(false)
    fail = true
    clock.t += config.news.cacheTtlMs / 1000 + 1 // past TTL, inside the stale window (seconds)
    const staleRes = await get(app, ROUTE)
    expect(staleRes.body.state).toBe('read')
    expect(staleRes.body.stale).toBe(true)
    clock.t += (config.news.cacheTtlMs / 1000) * 10 // past STALE_FACTOR x TTL: gone, not served
    const goneRes = await get(app, ROUTE)
    expect(goneRes.body.state).toBe('unreadable')
  })

  it('clamps NEWS_CACHE_TTL_MS to the vendor 300s floor', () => {
    const config = testConfig({ NEWS_ENABLED: 'true', NEWS_CACHE_TTL_MS: '1000' })
    expect(config.news.cacheTtlMs).toBe(300_000)
    const config2 = testConfig({ NEWS_ENABLED: 'true', NEWS_CACHE_TTL_MS: '600000' })
    expect(config2.news.cacheTtlMs).toBe(600_000)
  })

  it('quota answers 429 with Retry-After', async () => {
    const { app } = makeApp({ env: { NEWS_QUOTA_PER_IP: '1', NEWS_QUOTA_GLOBAL: '1' } })
    await get(app, ROUTE)
    const res = await get(app, ROUTE)
    expect(res.status).toBe(429)
    expect(res.headers['retry-after']).toBeDefined()
  })

  /*
   * PIPELINE ORDER, pinned.
   *
   * The module-off and killswitch tests above pass valid params, and the validation tests run
   * against an ENABLED module — so both orders (liveness-then-validation and the reverse) satisfy
   * every assertion above, and the documented order lived only in a comment. It was wrong: a
   * killed or unconfigured module answered 400 invalid_params, which tells a caller their request
   * was malformed when the truth is the module was never going to serve it. The frontend seam maps
   * the 503 module-off codes to `not-configured` and a 400 to nothing of the sort, so the two are
   * different member-visible states.
   *
   * The malformed request is the ONLY way to tell the orders apart, which is why it is the test.
   */
  it('answers liveness BEFORE validation: a killed or off module 503s even on a malformed request', async () => {
    const off = makeApp({ env: { NEWS_ENABLED: 'false' } })
    const offRes = await get(off.app, '/v1/news/notachain/NOTANASSET?slug=BAD_SLUG&limit=999')
    expect(offRes.status).toBe(503)
    expect(offRes.body.error.code).toBe('news_unconfigured')

    const killed = makeApp({ env: { NEWS_KILLSWITCH: 'true' } })
    const killedRes = await get(killed.app, '/v1/news/notachain/NOTANASSET?slug=BAD_SLUG')
    expect(killedRes.status).toBe(503)
    expect(killedRes.body.error.code).toBe('news_killed')

    // And nothing reached the vendor on either path.
    expect(off.calls).toHaveLength(0)
    expect(killed.calls).toHaveLength(0)
  })

  it('does not spend quota on a request the killswitch already refused', async () => {
    // Quota is a scarce per-caller budget; a killed module must not consume it. With a budget of
    // one, two killed requests both answer 503 — a spent budget would surface as a 429.
    const { app } = makeApp({ env: { NEWS_KILLSWITCH: 'true', NEWS_QUOTA_PER_IP: '1', NEWS_QUOTA_GLOBAL: '1' } })
    expect((await get(app, ROUTE)).body.error.code).toBe('news_killed')
    const second = await get(app, ROUTE)
    expect(second.status).toBe(503)
    expect(second.body.error.code).toBe('news_killed')
  })
})
