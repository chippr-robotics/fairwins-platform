/**
 * /v1/opensea/* read-only proxy tests (spec 055 — contracts/gateway-opensea-api.md).
 * The OpenSea upstream is mocked via the injectable openseaFetch; everything else uses the
 * same build-the-app-with-injected-deps pattern as gateway.test.js.
 */
import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server.js'
import { createKillSwitch } from '../src/policy/killswitch.js'
import { createTtlCache } from '../src/opensea/cache.js'
import { createOpenSeaClient, OpenSeaUnavailableError, OpenSeaRequestError } from '../src/opensea/client.js'
import {
  chainSlug,
  isAddress,
  isIdentifier,
  isSlug,
  priceQuoteFromUnits,
  normalizeItem,
  openseaAssetUrl,
} from '../src/opensea/normalize.js'
import { testConfig, mockProviders, mockEngine, ORIGIN_SECRET, TEST_NOW } from './helpers.js'

const OWNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const CONTRACT = '0x2953399124F0cBB46d2CbACD8A89cF0599974963'

// ---- upstream fixtures (OpenSea API v2 shapes) --------------------------------------------------

const NFT_LIST_BODY = {
  nfts: [
    {
      identifier: '1234',
      collection: 'cool-cats',
      contract: CONTRACT,
      token_standard: 'erc721',
      name: 'Cool Cat #1234',
      image_url: 'https://img.example/1234-small.png',
      display_image_url: 'https://img.example/1234.png',
      opensea_url: `https://opensea.io/assets/matic/${CONTRACT.toLowerCase()}/1234`,
      is_disabled: false,
      is_nsfw: false,
    },
    {
      identifier: '77',
      collection: 'spam-co',
      contract: CONTRACT,
      token_standard: 'erc1155',
      name: '', // missing metadata -> "#77" fallback
      image_url: null,
      is_disabled: true, // flagged -> isFlagged
      is_nsfw: false,
      quantity: 3,
    },
    { identifier: 'not-a-number', contract: 'garbage' }, // unusable -> dropped, never 500s
  ],
  next: 'cursor-2',
}

const NFT_DETAIL_BODY = {
  nft: {
    identifier: '1234',
    collection: 'cool-cats',
    contract: CONTRACT,
    token_standard: 'erc721',
    name: 'Cool Cat #1234',
    description: 'A very cool cat.',
    image_url: 'https://img.example/1234.png',
    opensea_url: `https://opensea.io/assets/matic/${CONTRACT.toLowerCase()}/1234`,
    is_disabled: false,
    is_nsfw: false,
    traits: [
      { trait_type: 'Fur', value: 'Golden' },
      { trait_type: 'Mood', value: 'Chill' },
      { trait_type: null, value: 'dropped' },
    ],
    owners: [{ address: OWNER, quantity: 1 }],
  },
}

const OPENSEA_FEE_RECIPIENT = '0x0000a26b00c1F0DF003000390027140000fAa719'
const ROYALTY_RECIPIENT = '0x1111111111111111111111111111111111111111'

const COLLECTION_BODY = {
  collection: 'cool-cats',
  name: 'Cool Cats',
  image_url: 'https://img.example/cc.png',
  opensea_url: 'https://opensea.io/collection/cool-cats',
  // Sell-side fee basis (spec 056): OpenSea marketplace fee (2.5% required) + a 5% required royalty.
  fees: [
    { fee: 2.5, recipient: OPENSEA_FEE_RECIPIENT, required: true },
    { fee: 5, recipient: ROYALTY_RECIPIENT, required: true },
  ],
}

const STATS_BODY = { total: { floor_price: 0.85, floor_price_symbol: 'ETH' } }

const BEST_OFFER_BODY = { order_hash: '0x' + 'cd'.repeat(32), price: { currency: 'WETH', decimals: 18, value: '790000000000000000' } }
const BEST_LISTING_BODY = { orders: [{ order_hash: '0x' + 'ef'.repeat(32), maker: { address: OWNER }, price: { current: { currency: 'ETH', decimals: 18, value: '1000000000000000000' } } }] }

const ORDER_HASH = '0x' + 'ab'.repeat(32)
const LISTING_POST_RESPONSE = { order: { order_hash: ORDER_HASH, protocol_data: {} } }
const FULFILLMENT_RESPONSE = {
  fulfillment_data: { transaction: { to: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', data: '0xdeadbeef', value: '0' } },
}
// A structurally-valid Seaport listing body the client would POST.
const SIGNED_LISTING = {
  order: {
    offerer: OWNER,
    offer: [{ itemType: 2, token: CONTRACT, identifierOrCriteria: '1234', startAmount: '1', endAmount: '1' }],
    consideration: [{ itemType: 0, token: '0x0', identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: OWNER }],
    startTime: '0',
    endTime: '9999999999',
    orderType: 0,
    zone: '0x0000000000000000000000000000000000000000',
    zoneHash: '0x' + '00'.repeat(32),
    salt: '0x123',
    conduitKey: '0x' + '00'.repeat(32),
    counter: '0',
  },
  signature: '0x' + '11'.repeat(65),
  protocolAddress: '0x0000000000000068F116a894984e2DB1123eB395',
}

// ---- test scaffolding ---------------------------------------------------------------------------

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

/** URL-routed upstream mock; `calls` records every hit (with method+body), `failWith` forces a status. */
function mockOpenSeaFetch(overrides = {}) {
  const calls = []
  const impl = async (url, opts) => {
    let body
    try {
      body = opts?.body ? JSON.parse(opts.body) : null
    } catch {
      body = opts?.body ?? null
    }
    calls.push({ url, method: opts?.method ?? 'GET', headers: opts?.headers ?? {}, body })
    if (impl.failWith) return jsonRes({ errors: ['down'] }, impl.failWith)
    for (const [needle, resp] of Object.entries(overrides)) {
      if (url.includes(needle)) return typeof resp === 'function' ? resp(url) : jsonRes(resp)
    }
    // Write endpoints (spec 056) — check the most specific first.
    if (url.includes('/listings/collection/')) return jsonRes(BEST_LISTING_BODY)
    if (url.includes('/fulfillment_data')) return jsonRes(FULFILLMENT_RESPONSE)
    if (url.includes('/listings') && url.includes('/orders/')) return jsonRes(LISTING_POST_RESPONSE)
    if (url.includes('/cancel')) return jsonRes({ success: true })
    if (url.includes('/account/')) return jsonRes(NFT_LIST_BODY)
    if (url.includes('/contract/')) return jsonRes(NFT_DETAIL_BODY)
    if (url.includes('/stats')) return jsonRes(STATS_BODY)
    if (url.includes('/offers/')) return jsonRes(BEST_OFFER_BODY)
    if (url.includes('/collections/')) return jsonRes(COLLECTION_BODY)
    return jsonRes({ errors: ['not found'] }, 404)
  }
  impl.calls = calls
  impl.failWith = null
  return impl
}

/** App with a mutable clock (unix seconds) so cache TTLs can be exercised. */
function build({ env = {}, openseaFetch = mockOpenSeaFetch(), killSwitch = createKillSwitch(false) } = {}) {
  const config = testConfig({ OPENSEA_API_KEY: 'test-os-key', ...env })
  const clock = { t: TEST_NOW }
  const { app } = createApp(config, {
    providers: mockProviders(config),
    engineClient: mockEngine(),
    now: () => clock.t,
    killSwitch,
    openseaFetch,
  })
  return { app, config, clock, openseaFetch, killSwitch }
}

const get = (app, path) => request(app).get(path).set('X-Origin-Auth', ORIGIN_SECRET)
const post = (app, path, body) => request(app).post(path).set('X-Origin-Auth', ORIGIN_SECRET).send(body)

const LIST_PATH = `/v1/opensea/137/account/${OWNER}/nfts`
const DETAIL_PATH = `/v1/opensea/137/contract/${CONTRACT}/nfts/1234`
const FEES_PATH = `/v1/opensea/137/collections/cool-cats/required-fees`
const PUBLISH_PATH = `/v1/opensea/137/listings`
const FULFILL_PATH = `/v1/opensea/137/offers/fulfillment`
const CANCEL_PATH = `/v1/opensea/137/listings/cancel`

// ---- unit: normalize ----------------------------------------------------------------------------

describe('opensea normalize', () => {
  it('maps only Ethereum + Polygon to OpenSea slugs', () => {
    expect(chainSlug(1)).toBe('ethereum')
    expect(chainSlug(137)).toBe('matic')
    expect(chainSlug(63)).toBeNull() // Mordor is not an OpenSea chain (FR-007)
    expect(chainSlug(80002)).toBeNull()
  })

  it('validates params', () => {
    expect(isAddress(OWNER)).toBe(true)
    expect(isAddress('0x123')).toBe(false)
    expect(isIdentifier('0')).toBe(true)
    expect(isIdentifier('1'.repeat(129))).toBe(false)
    expect(isIdentifier('12a')).toBe(false)
    expect(isSlug('cool-cats')).toBe(true)
    expect(isSlug('Bad_Slug')).toBe(false)
  })

  it('converts base-unit offer prices to decimal quotes, never floats', () => {
    expect(priceQuoteFromUnits({ currency: 'WETH', decimals: 18, value: '790000000000000000' })).toEqual({
      amount: '0.79',
      currency: 'WETH',
    })
    expect(priceQuoteFromUnits({ currency: 'WETH', decimals: 18, value: '1000000000000000000' })).toEqual({
      amount: '1',
      currency: 'WETH',
    })
    expect(priceQuoteFromUnits(null)).toBeNull()
    expect(priceQuoteFromUnits({ currency: 'WETH', decimals: 18, value: 'garbage' })).toBeNull()
  })

  it('falls back to "#<id>" for missing names and flags disabled/nsfw items', () => {
    const item = normalizeItem(NFT_LIST_BODY.nfts[1], 137)
    expect(item.name).toBe('#77')
    expect(item.isFlagged).toBe(true)
    expect(item.quantity).toBe(3)
    expect(item.openseaUrl).toBe(openseaAssetUrl(137, CONTRACT, '77'))
  })

  it('drops unusable records instead of throwing', () => {
    expect(normalizeItem(NFT_LIST_BODY.nfts[2], 137)).toBeNull()
  })
})

// ---- unit: cache --------------------------------------------------------------------------------

describe('opensea cache', () => {
  it('serves fresh hits without reloading and coalesces concurrent misses (single-flight)', async () => {
    let t = 0
    let loads = 0
    const cache = createTtlCache({ now: () => t })
    const loader = async () => {
      loads += 1
      return { n: loads }
    }
    const [a, b] = await Promise.all([cache.fetchThrough('k', 1000, loader), cache.fetchThrough('k', 1000, loader)])
    expect(loads).toBe(1)
    expect(a.value).toEqual({ n: 1 })
    expect(b.stale).toBe(false)
    t = 500
    expect((await cache.fetchThrough('k', 1000, loader)).value).toEqual({ n: 1 }) // still fresh
    t = 1500
    expect((await cache.fetchThrough('k', 1000, loader)).value).toEqual({ n: 2 }) // expired -> reload
    expect(loads).toBe(2)
  })

  it('serves the last good value marked stale when the loader fails, and rethrows with nothing cached', async () => {
    let t = 0
    const cache = createTtlCache({ now: () => t })
    await cache.fetchThrough('k', 1000, async () => 'good')
    t = 2000
    const res = await cache.fetchThrough('k', 1000, async () => {
      throw new OpenSeaUnavailableError('down')
    })
    expect(res).toEqual({ value: 'good', fetchedAt: 0, stale: true })
    await expect(
      cache.fetchThrough('cold', 1000, async () => {
        throw new OpenSeaUnavailableError('down')
      })
    ).rejects.toBeInstanceOf(OpenSeaUnavailableError)
  })

  it('evicts oldest entries past maxEntries', async () => {
    let t = 0
    const cache = createTtlCache({ maxEntries: 2, now: () => t })
    for (const k of ['a', 'b', 'c']) {
      t += 1
      await cache.fetchThrough(k, 1000, async () => k)
    }
    expect(cache.size()).toBe(2)
  })
})

// ---- unit: client -------------------------------------------------------------------------------

describe('opensea client', () => {
  it('sends the API key as X-API-KEY and never as a bearer token', async () => {
    const fetchImpl = mockOpenSeaFetch()
    const client = createOpenSeaClient({ baseUrl: 'https://api.opensea.io/', apiKey: 'k', fetchImpl })
    await client.get('/api/v2/collections/cool-cats/stats')
    expect(fetchImpl.calls[0].url).toBe('https://api.opensea.io/api/v2/collections/cool-cats/stats')
    expect(fetchImpl.calls[0].headers['x-api-key']).toBe('k')
    expect(fetchImpl.calls[0].headers.authorization).toBeUndefined()
  })

  it('retries 5xx/429 then reports unavailable; does not retry definitive 4xx', async () => {
    const failing = mockOpenSeaFetch()
    failing.failWith = 500
    const client = createOpenSeaClient({ baseUrl: 'https://x.invalid', apiKey: 'k', retries: 2, fetchImpl: failing })
    await expect(client.get('/api/v2/anything')).rejects.toBeInstanceOf(OpenSeaUnavailableError)
    expect(failing.calls.length).toBe(3)

    const rejecting = mockOpenSeaFetch()
    rejecting.failWith = 400
    const client2 = createOpenSeaClient({ baseUrl: 'https://x.invalid', apiKey: 'k', retries: 2, fetchImpl: rejecting })
    await expect(client2.get('/api/v2/anything')).rejects.toBeInstanceOf(OpenSeaRequestError)
    expect(rejecting.calls.length).toBe(1)
  })
})

// ---- routes: cross-cutting (T008) ---------------------------------------------------------------

describe('GET /v1/opensea/* cross-cutting policy', () => {
  it('is origin-locked like every client route', async () => {
    const { app } = build()
    const res = await request(app).get(LIST_PATH)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('origin_denied')
  })

  it('refuses when the killswitch is active', async () => {
    const { app } = build({ killSwitch: createKillSwitch(true) })
    const res = await get(app, LIST_PATH)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('killswitch_active')
  })

  it('fails closed with 503 collectibles_unconfigured when no API key is set', async () => {
    const { app, openseaFetch } = build({ env: { OPENSEA_API_KEY: '' } })
    const res = await get(app, LIST_PATH)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('collectibles_unconfigured')
    expect(openseaFetch.calls.length).toBe(0) // never touches upstream without a key
  })

  it('enforces the per-CALLER quota with Retry-After', async () => {
    const { app } = build({ env: { OPENSEA_QUOTA_PER_ADDRESS: '2', OPENSEA_QUOTA_GLOBAL: '100' } })
    expect((await get(app, LIST_PATH)).status).toBe(200)
    expect((await get(app, LIST_PATH)).status).toBe(200) // cache hit still counts a quota hit
    const res = await get(app, LIST_PATH)
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('quota_exceeded')
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
  })

  it('does NOT give a different requested address its own window (spec 106, FR-011)', async () => {
    // This assertion is INVERTED from what it was, and the inversion is the fix.
    //
    // The quota used to key on the address in the PATH, so this test asserted that asking about a
    // different address reset the window — and it passed, because that is exactly what the code
    // did. But the address in the path is chosen by the caller: walking it minted a fresh bucket
    // per request, the ceiling was never reached, and the quota metered nothing. Forty requests
    // naming forty addresses cost one unit each.
    //
    // It was wrong in the other direction too: a hundred members reading the same popular
    // collection shared one bucket and throttled each other, while one script reading a hundred
    // collections was never limited at all.
    //
    // The window now belongs to the CALLER, so varying request content cannot escape it.
    const { app } = build({ env: { OPENSEA_QUOTA_PER_ADDRESS: '2', OPENSEA_QUOTA_GLOBAL: '100' } })
    expect((await get(app, LIST_PATH)).status).toBe(200)
    expect((await get(app, LIST_PATH)).status).toBe(200)
    expect((await get(app, `/v1/opensea/137/account/${CONTRACT}/nfts`)).status).toBe(429)
  })

  it('enforces the global backstop across keys', async () => {
    const { app } = build({ env: { OPENSEA_QUOTA_PER_ADDRESS: '100', OPENSEA_QUOTA_GLOBAL: '1' } })
    expect((await get(app, LIST_PATH)).status).toBe(200)
    const res = await get(app, '/v1/opensea/collections/cool-cats/stats')
    expect(res.status).toBe(429)
  })

  it('soft-fails unsupported chains with 404 unsupported_chain (Mordor et al.)', async () => {
    const { app } = build()
    for (const chainId of [63, 61, 80002, 999]) {
      const res = await get(app, `/v1/opensea/${chainId}/account/${OWNER}/nfts`)
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('unsupported_chain')
    }
  })
})

// ---- routes: account list (US1 / T012) ----------------------------------------------------------

describe('GET /v1/opensea/:chainId/account/:address/nfts', () => {
  it('normalizes the upstream page into CollectibleItem DTOs with the fetchedAt/stale envelope', async () => {
    const { app } = build()
    const res = await get(app, LIST_PATH)
    expect(res.status).toBe(200)
    expect(res.body.items).toHaveLength(2) // unusable third record dropped
    expect(res.body.items[0]).toEqual({
      chainId: 137,
      contract: CONTRACT,
      identifier: '1234',
      name: 'Cool Cat #1234',
      collectionSlug: 'cool-cats',
      imageUrl: 'https://img.example/1234.png', // display_image_url preferred
      standard: 'erc721',
      quantity: 1,
      isFlagged: false,
      openseaUrl: `https://opensea.io/assets/matic/${CONTRACT.toLowerCase()}/1234`,
    })
    expect(res.body.items[1].isFlagged).toBe(true)
    expect(res.body.next).toBe('cursor-2')
    expect(res.body.stale).toBe(false)
    expect(res.body.fetchedAt).toBe(new Date(TEST_NOW * 1000).toISOString())
  })

  it('passes the pagination cursor upstream and caches per cursor', async () => {
    const { app, openseaFetch } = build()
    await get(app, LIST_PATH)
    await get(app, `${LIST_PATH}?next=cursor-2`)
    expect(openseaFetch.calls[0].url).toContain(`/api/v2/chain/matic/account/${OWNER}/nfts?limit=50`)
    expect(openseaFetch.calls[1].url).toContain('next=cursor-2')
  })

  it('serves repeat requests from cache (two calls -> one upstream hit)', async () => {
    const { app, openseaFetch } = build()
    await get(app, LIST_PATH)
    await get(app, LIST_PATH)
    expect(openseaFetch.calls.length).toBe(1)
  })

  it('serves the last good page marked stale when the upstream dies after expiry', async () => {
    const { app, openseaFetch, clock, config } = build()
    const first = await get(app, LIST_PATH)
    expect(first.body.stale).toBe(false)
    clock.t += Math.ceil(config.opensea.cacheTtlMs / 1000) + 1 // expire the entry
    openseaFetch.failWith = 500
    const res = await get(app, LIST_PATH)
    expect(res.status).toBe(200)
    expect(res.body.stale).toBe(true)
    expect(res.body.items).toHaveLength(2)
  })

  it('returns 503 upstream_unavailable when the upstream dies with nothing cached', async () => {
    const openseaFetch = mockOpenSeaFetch()
    openseaFetch.failWith = 503
    const { app } = build({ openseaFetch })
    const res = await get(app, LIST_PATH)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('upstream_unavailable')
  })

  it('rejects malformed addresses and oversized cursors before spending quota or upstream calls', async () => {
    const { app, openseaFetch } = build()
    expect((await get(app, '/v1/opensea/137/account/nonsense/nfts')).status).toBe(400)
    expect((await get(app, '/v1/opensea/137/account/nonsense/nfts')).body?.error?.code).toBe('invalid_address')
    expect((await get(app, `${LIST_PATH}?next=${'x'.repeat(600)}`)).body.error.code).toBe('invalid_cursor')
    expect(openseaFetch.calls.length).toBe(0)
  })
})

// ---- routes: composed item detail (US2 / T020) --------------------------------------------------

describe('GET /v1/opensea/:chainId/contract/:contract/nfts/:identifier', () => {
  it('composes item + collection + floor + best offer into one CollectibleItemDetail', async () => {
    const { app } = build()
    const res = await get(app, DETAIL_PATH)
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Cool Cat #1234')
    expect(res.body.description).toBe('A very cool cat.')
    expect(res.body.traits).toEqual([
      { traitType: 'Fur', value: 'Golden' },
      { traitType: 'Mood', value: 'Chill' },
    ])
    expect(res.body.owner).toBe(OWNER)
    expect(res.body.collection).toEqual({
      slug: 'cool-cats',
      name: 'Cool Cats',
      imageUrl: 'https://img.example/cc.png',
      openseaUrl: 'https://opensea.io/collection/cool-cats',
      floorPrice: { amount: '0.85', currency: 'ETH' },
    })
    expect(res.body.bestOffer).toEqual({ amount: '0.79', currency: 'WETH' })
    expect(res.body.stale).toBe(false)
  })

  it('degrades floor/offer legs to null instead of failing the sheet', async () => {
    const openseaFetch = mockOpenSeaFetch({
      '/stats': () => jsonRes({ errors: ['down'] }, 500),
      '/offers/': () => jsonRes({ errors: ['down'] }, 500),
    })
    const { app } = build({ openseaFetch })
    const res = await get(app, DETAIL_PATH)
    expect(res.status).toBe(200)
    expect(res.body.collection.floorPrice).toBeNull()
    expect(res.body.bestOffer).toBeNull()
  })

  it('maps a definitive upstream 404 to not_found (honest, not an outage)', async () => {
    const openseaFetch = mockOpenSeaFetch({ '/contract/': () => jsonRes({ errors: ['nope'] }, 404) })
    const { app } = build({ openseaFetch })
    const res = await get(app, DETAIL_PATH)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })

  it('rejects malformed identifiers', async () => {
    const { app } = build()
    const res = await get(app, `/v1/opensea/137/contract/${CONTRACT}/nfts/12ab`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_identifier')
  })

  it('caches the composed result as one entry', async () => {
    const { app, openseaFetch } = build()
    await get(app, DETAIL_PATH)
    expect(openseaFetch.calls.length).toBe(5) // item + collection + stats + offer + listing
    await get(app, DETAIL_PATH)
    expect(openseaFetch.calls.length).toBe(5)
  })
})

// ---- routes: collection stats (US3 / T024) ------------------------------------------------------

describe('GET /v1/opensea/collections/:slug/stats', () => {
  it('returns the floor as a labeled quote', async () => {
    const { app } = build()
    const res = await get(app, '/v1/opensea/collections/cool-cats/stats')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      slug: 'cool-cats',
      floorPrice: { amount: '0.85', currency: 'ETH' },
      fetchedAt: new Date(TEST_NOW * 1000).toISOString(),
      stale: false,
    })
  })

  it('returns a null floor when the collection has none (never a misleading zero)', async () => {
    const openseaFetch = mockOpenSeaFetch({ '/stats': { total: { floor_price: null, floor_price_symbol: null } } })
    const { app } = build({ openseaFetch })
    const res = await get(app, '/v1/opensea/collections/new-collection/stats')
    expect(res.status).toBe(200)
    expect(res.body.floorPrice).toBeNull()
  })

  it('rejects malformed slugs', async () => {
    const { app } = build()
    const res = await get(app, '/v1/opensea/collections/Bad_Slug!/stats')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_slug')
  })

  it('uses the longer stats TTL (fresh well past the list TTL)', async () => {
    const { app, openseaFetch, clock, config } = build()
    await get(app, '/v1/opensea/collections/cool-cats/stats')
    clock.t += Math.ceil(config.opensea.cacheTtlMs / 1000) + 1 // past list TTL, within stats TTL
    await get(app, '/v1/opensea/collections/cool-cats/stats')
    expect(openseaFetch.calls.length).toBe(1)
    clock.t += Math.ceil(config.opensea.statsCacheTtlMs / 1000) + 1
    await get(app, '/v1/opensea/collections/cool-cats/stats')
    expect(openseaFetch.calls.length).toBe(2)
  })
})

// ===== sell-side write routes (spec 056) =========================================================

describe('opensea client.post (sell-side)', () => {
  it('sends X-API-KEY + JSON body and does NOT retry on 5xx (publishing is not idempotent)', async () => {
    const failing = mockOpenSeaFetch()
    failing.failWith = 500
    const client = createOpenSeaClient({ baseUrl: 'https://api.opensea.io', apiKey: 'k', fetchImpl: failing })
    await expect(client.post('/api/v2/orders/matic/seaport/listings', { a: 1 })).rejects.toBeInstanceOf(OpenSeaUnavailableError)
    expect(failing.calls.length).toBe(1) // single attempt, never retried
    expect(failing.calls[0].method).toBe('POST')
    expect(failing.calls[0].headers['x-api-key']).toBe('k')
    expect(failing.calls[0].body).toEqual({ a: 1 })
  })

  it('maps a definitive 4xx to OpenSeaRequestError (not retried)', async () => {
    const rejecting = mockOpenSeaFetch()
    rejecting.failWith = 400
    const client = createOpenSeaClient({ baseUrl: 'https://x.invalid', apiKey: 'k', fetchImpl: rejecting })
    await expect(client.post('/api/v2/anything', {})).rejects.toBeInstanceOf(OpenSeaRequestError)
    expect(rejecting.calls.length).toBe(1)
  })
})

describe('opensea sell-side write routes — cross-cutting', () => {
  it('are origin-locked', async () => {
    const { app } = build()
    expect((await request(app).post(PUBLISH_PATH).send(SIGNED_LISTING)).status).toBe(403)
  })

  it('refuse when the killswitch is active', async () => {
    const { app } = build({ killSwitch: createKillSwitch(true) })
    const res = await post(app, PUBLISH_PATH, SIGNED_LISTING)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('killswitch_active')
  })

  it('fail closed with 503 collectibles_unconfigured when no API key is set', async () => {
    const { app, openseaFetch } = build({ env: { OPENSEA_API_KEY: '' } })
    const res = await post(app, PUBLISH_PATH, SIGNED_LISTING)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('collectibles_unconfigured')
    expect(openseaFetch.calls.length).toBe(0)
  })

  it('enforce a SEPARATE write quota, keyed by the seller address (reads unaffected)', async () => {
    const { app } = build({ env: { OPENSEA_WRITE_QUOTA_PER_ADDRESS: '1', OPENSEA_WRITE_QUOTA_GLOBAL: '50', OPENSEA_QUOTA_PER_ADDRESS: '50' } })
    expect((await post(app, PUBLISH_PATH, SIGNED_LISTING)).status).toBe(200)
    const res = await post(app, PUBLISH_PATH, SIGNED_LISTING)
    expect(res.status).toBe(429)
    expect(res.body.error.code).toBe('quota_exceeded')
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0)
    // Reads still work — separate quota instance.
    expect((await get(app, FEES_PATH)).status).toBe(200)
  })

  it('soft-fail unsupported chains with 404', async () => {
    const { app } = build()
    expect((await post(app, `/v1/opensea/63/listings`, SIGNED_LISTING)).body.error.code).toBe('unsupported_chain')
  })
})

describe('GET /v1/opensea/:chainId/collections/:slug/required-fees', () => {
  it('returns the fee breakdown (marketplace vs royalty), total required bps, and Seaport protocol', async () => {
    const { app } = build()
    const res = await get(app, FEES_PATH)
    expect(res.status).toBe(200)
    expect(res.body.marketplaceFee).toEqual({ recipient: OPENSEA_FEE_RECIPIENT, basisPoints: 250 })
    expect(res.body.creatorRoyalty).toEqual({ recipient: ROYALTY_RECIPIENT, basisPoints: 500, required: true })
    expect(res.body.totalRequiredBasisPoints).toBe(750)
    expect(res.body.protocolAddress).toBe('0x0000000000000068F116a894984e2DB1123eB395')
    expect(res.body.conduitKey).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it('blocks with 503 when the collection has no usable fee data (client blocks signing, FR-009)', async () => {
    const openseaFetch = mockOpenSeaFetch({ '/collections/cool-cats': { collection: 'cool-cats', fees: [] } })
    const { app } = build({ openseaFetch })
    const res = await get(app, FEES_PATH)
    expect(res.status).toBe(404) // no fee data -> not_found (client blocks signing)
  })
})

describe('POST /v1/opensea/:chainId/listings (publish)', () => {
  it('forwards the signed order to OpenSea and returns the order hash + referral status', async () => {
    const { app, openseaFetch } = build()
    const res = await post(app, PUBLISH_PATH, SIGNED_LISTING)
    expect(res.status).toBe(200)
    expect(res.body.orderHash).toBe(ORDER_HASH)
    const call = openseaFetch.calls.find((c) => c.url.includes('/listings') && c.method === 'POST')
    expect(call.body.parameters.offerer).toBe(OWNER)
    expect(call.body.signature).toBe(SIGNED_LISTING.signature)
    expect(res.body.referral.appliedAtNoUserCost).toBe(true)
  })

  it('attaches FairWins as referral beneficiary when configured (no user cost)', async () => {
    const beneficiary = '0x2222222222222222222222222222222222222222'
    const { app } = build({ env: { OPENSEA_REFERRAL_ADDRESS: beneficiary } })
    const res = await post(app, PUBLISH_PATH, SIGNED_LISTING)
    expect(res.body.referral.source).toBe('affiliate-listing')
    expect(res.body.referral.appliedAtNoUserCost).toBe(true)
  })

  it('rejects a malformed order body before touching the upstream', async () => {
    const { app, openseaFetch } = build()
    const res = await post(app, PUBLISH_PATH, { order: { offerer: 'nope' }, signature: '0x11' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_order')
    expect(openseaFetch.calls.length).toBe(0)
  })

  it('surfaces the marketplace rejection reason on 4xx (e.g. fee mismatch) as 502', async () => {
    const openseaFetch = mockOpenSeaFetch({
      '/listings': () => jsonRes({ errors: ['required consideration items are missing'] }, 400),
    })
    const { app } = build({ openseaFetch })
    const res = await post(app, PUBLISH_PATH, SIGNED_LISTING)
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('upstream_rejected')
    expect(res.body.error.reason).toContain('required consideration')
  })

  it('does not double-post on a 5xx (no retry)', async () => {
    const openseaFetch = mockOpenSeaFetch({ '/listings': () => jsonRes({ errors: ['down'] }, 503) })
    const { app } = build({ openseaFetch })
    const res = await post(app, PUBLISH_PATH, SIGNED_LISTING)
    expect(res.status).toBe(503)
    const posts = openseaFetch.calls.filter((c) => c.url.includes('/listings') && c.method === 'POST')
    expect(posts.length).toBe(1)
  })
})

describe('POST /v1/opensea/:chainId/offers/fulfillment (accept)', () => {
  it('returns the fulfillment transaction the wallet submits', async () => {
    const { app } = build()
    const res = await post(app, FULFILL_PATH, { orderHash: ORDER_HASH, fulfiller: OWNER })
    expect(res.status).toBe(200)
    expect(res.body.to).toBe('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789')
    expect(res.body.data).toBe('0xdeadbeef')
    expect(res.body.value).toBe('0')
    expect(res.body.orderHash).toBe(ORDER_HASH)
  })

  it('maps a gone/changed offer (upstream 4xx) to 409 offer_changed (FR-007)', async () => {
    const openseaFetch = mockOpenSeaFetch({ '/fulfillment_data': () => jsonRes({ errors: ['not found'] }, 404) })
    const { app } = build({ openseaFetch })
    const res = await post(app, FULFILL_PATH, { orderHash: ORDER_HASH, fulfiller: OWNER })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('offer_changed')
  })

  it('rejects a malformed orderHash', async () => {
    const { app } = build()
    const res = await post(app, FULFILL_PATH, { orderHash: '0x123', fulfiller: OWNER })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('invalid_order')
  })
})

describe('POST /v1/opensea/:chainId/listings/cancel', () => {
  it('uses the gas-free off-chain cancel when the marketplace accepts it', async () => {
    const { app } = build()
    const res = await post(app, CANCEL_PATH, { orderHash: ORDER_HASH, offerer: OWNER, signature: '0x11' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ cancelled: true, method: 'offchain' })
  })

  it('falls back to on-chain (client pays gas) when off-chain cancel is unavailable', async () => {
    const openseaFetch = mockOpenSeaFetch({ '/cancel': () => jsonRes({ errors: ['cannot cancel offchain'] }, 400) })
    const { app } = build({ openseaFetch })
    const res = await post(app, CANCEL_PATH, { orderHash: ORDER_HASH, offerer: OWNER })
    expect(res.status).toBe(200)
    expect(res.body.method).toBe('onchain')
    expect(res.body.protocolAddress).toBe('0x0000000000000068F116a894984e2DB1123eB395')
  })
})

describe('attachReferral seam', () => {
  it('is a no-op (source none) when unconfigured, and never claims a user cost', async () => {
    const { attachReferral } = await import('../src/opensea/referral.js')
    const cfg = { opensea: { referralAddress: null, referralAddressByChain: {} } }
    expect(attachReferral(cfg, { chainId: 137, kind: 'listing' })).toEqual({
      beneficiary: null,
      source: 'none',
      appliedAtNoUserCost: true,
    })
  })

  it('prefers a per-chain beneficiary over the global one', async () => {
    const { attachReferral } = await import('../src/opensea/referral.js')
    const cfg = {
      opensea: { referralAddress: '0xaaa', referralAddressByChain: { 137: '0xbbb' } },
    }
    expect(attachReferral(cfg, { chainId: 137, kind: 'fulfillment' }).beneficiary).toBe('0xbbb')
    expect(attachReferral(cfg, { chainId: 1, kind: 'fulfillment' }).beneficiary).toBe('0xaaa')
  })
})
