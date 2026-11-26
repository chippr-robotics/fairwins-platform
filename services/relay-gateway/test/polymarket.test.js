/**
 * /v1/polymarket/* Predict proxy tests (spec 057 — contracts/gateway-predict-api.md).
 * The Polymarket upstream is mocked via the injectable polymarketFetch; everything else uses the
 * same build-the-app-with-injected-deps pattern as opensea.test.js.
 */
import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../src/server.js'
import { createKillSwitch } from '../src/policy/killswitch.js'
import { l2Headers } from '../src/polymarket/client.js'
import { attachBuilderCode, ZERO_BYTES32 } from '../src/polymarket/builderCode.js'
import {
  isSupportedChain,
  isTokenId,
  normalizeMarket,
  normalizeGammaMarket,
  normalizeFeeRate,
  normalizePosition,
  validateOrderBody,
  normalizeEvent,
  normalizeMarketRow,
  normalizeBook,
  normalizeHistory,
  displayPrice,
  isEventSlug,
  isRange,
  isSort,
} from '../src/polymarket/normalize.js'
import { isCategory, tagSlugFor, categoryForTags } from '../src/polymarket/categories.js'
import { testConfig, mockProviders, mockEngine, ORIGIN_SECRET, TEST_NOW } from './helpers.js'

const TRADER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const BUILDER_CODE = '0x6e0316783960e149b53466f0f2c5fdbaf5ce11ba15669491de980f6dedc493a3'
const TOKEN = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const CONDITION = '0x' + 'ab'.repeat(32)

// ---- upstream fixtures (Polymarket CLOB shapes) -------------------------------------------------

// CLOB /markets shape (used by the normalizeMarket unit test).
const MARKETS_BODY = {
  data: [
    {
      condition_id: CONDITION,
      question: 'Will it rain tomorrow?',
      category: 'Weather',
      market_slug: 'will-it-rain-tomorrow',
      closed: false,
      volume: '12345.67',
      neg_risk: false,
      tokens: [
        { token_id: TOKEN, outcome: 'Yes', price: '0.55' },
        { token_id: '1', outcome: 'No', price: '0.45' },
      ],
    },
    { foo: 'junk' }, // unusable (no condition id) -> dropped, never 500s
  ],
  next_cursor: 'cursor-2',
}
// Gamma /markets shape (the browse/detail source): outcomes/prices/token-ids are stringified arrays.
const GAMMA_MARKETS = [
  {
    conditionId: CONDITION,
    question: 'Will it rain tomorrow?',
    slug: 'will-it-rain-tomorrow',
    category: 'Weather',
    active: true,
    closed: false,
    negRisk: false,
    volumeNum: 12345.67,
    outcomes: JSON.stringify(['Yes', 'No']),
    clobTokenIds: JSON.stringify([TOKEN, '1']),
    outcomePrices: JSON.stringify(['0.55', '0.45']),
  },
  { foo: 'junk' }, // unusable -> dropped
]
const FEE_BODY = { base_fee: 1000 } // real CLOB /fee-rate shape
// Data-API positions shape (public; camelCase currentValue/curPrice/negativeRisk).
const POSITIONS_BODY = [
  { asset: TOKEN, size: 10, outcome: 'Yes', currentValue: 5.5, curPrice: 0.55, conditionId: CONDITION, negativeRisk: false },
]
const OPEN_ORDERS_BODY = {
  data: [{ id: '0xorder1', asset_id: TOKEN, side: 'BUY', price: '0.5', original_size: '10', size_remaining: '4' }],
}
const ORDER_POST_RESPONSE = { orderID: '0xneworder', status: 'matched', success: true }
const CANCEL_RESPONSE = { canceled: true }

/** A structurally-valid signed CLOB order body the client would POST (attributed). */
const signedOrder = (overrides = {}) => ({
  order: {
    maker: TRADER,
    signer: TRADER,
    tokenId: TOKEN,
    side: 'BUY',
    makerAmount: '55000000',
    takerAmount: '100000000',
    builder: BUILDER_CODE,
    isMaker: false,
    ...overrides,
  },
  signature: '0x' + '11'.repeat(65),
})

// ---- test scaffolding ---------------------------------------------------------------------------

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
})

function mockPolymarketFetch(overrides = {}) {
  const calls = []
  const impl = async (url, opts) => {
    let body
    try {
      body = opts?.body ? JSON.parse(opts.body) : null
    } catch {
      body = opts?.body ?? null
    }
    calls.push({ url, method: opts?.method ?? 'GET', headers: opts?.headers ?? {}, body })
    if (impl.failWith) return jsonRes({ error: 'down' }, impl.failWith)
    for (const [needle, resp] of Object.entries(overrides)) {
      if (url.includes(needle)) return typeof resp === 'function' ? resp(url) : jsonRes(resp)
    }
    // Host-routed: Gamma (discovery), Data-API (positions), CLOB (everything else).
    if (url.includes('gamma-api')) return jsonRes(GAMMA_MARKETS)
    if (url.includes('data-api')) return jsonRes(POSITIONS_BODY)
    if (url.includes('/order/cancel')) return jsonRes(CANCEL_RESPONSE)
    if (url.includes('/order')) return jsonRes(ORDER_POST_RESPONSE)
    if (url.includes('/data/orders')) return jsonRes(OPEN_ORDERS_BODY)
    if (url.includes('/fee-rate')) return jsonRes(FEE_BODY)
    return jsonRes({ error: 'not found' }, 404)
  }
  impl.calls = calls
  impl.failWith = null
  return impl
}

const PM_ENV = {
  POLYMARKET_API_KEY: 'test-pm-key',
  POLYMARKET_API_SECRET: Buffer.from('test-secret').toString('base64url'),
  POLYMARKET_API_PASSPHRASE: 'test-pass',
  POLYMARKET_API_ADDRESS: '0x1111111111111111111111111111111111111111',
  POLYMARKET_BUILDER_CODE: BUILDER_CODE,
}

function build({ env = {}, polymarketFetch = mockPolymarketFetch(), killSwitch = createKillSwitch(false), noRouter = false } = {}) {
  const config = testConfig({ ...PM_ENV, ...env })
  // The FeeRouter is deployed on every network now (issue #966); tests about the ENV builder
  // fees must construct the record-less state explicitly instead of inheriting it.
  if (noRouter) config.feeRouter = { ...config.feeRouter, address: null }
  const clock = { t: TEST_NOW }
  const { app } = createApp(config, {
    providers: mockProviders(config),
    engineClient: mockEngine(),
    now: () => clock.t,
    killSwitch,
    polymarketFetch,
  })
  return { app, config, clock, polymarketFetch, killSwitch }
}

const get = (app, path) => request(app).get(path).set('X-Origin-Auth', ORIGIN_SECRET)
const post = (app, path, body) => request(app).post(path).set('X-Origin-Auth', ORIGIN_SECRET).send(body)

const MARKETS_PATH = '/v1/polymarket/137/markets'
const MARKET_PATH = `/v1/polymarket/137/markets/${CONDITION}`
const FEE_PATH = `/v1/polymarket/137/fee-rate?token_id=${TOKEN}`
const POSITIONS_PATH = `/v1/polymarket/137/positions?address=${TRADER}`
const BUILDER_SIGN_PATH = '/v1/polymarket/137/builder-sign'

// ---- unit: normalize ----------------------------------------------------------------------------

describe('polymarket normalize', () => {
  it('supports Polygon only', () => {
    expect(isSupportedChain(137)).toBe(true)
    expect(isSupportedChain(1)).toBe(false)
    expect(isSupportedChain(80002)).toBe(false)
  })

  it('validates token ids', () => {
    expect(isTokenId(TOKEN)).toBe(true)
    expect(isTokenId('0x123')).toBe(false)
    expect(isTokenId('')).toBe(false)
  })

  it('maps a market with outcomes and a non-tradable flag', () => {
    const m = normalizeMarket(MARKETS_BODY.data[0])
    expect(m.conditionId).toBe(CONDITION)
    expect(m.question).toBe('Will it rain tomorrow?')
    expect(m.outcomes).toHaveLength(2)
    expect(m.outcomes[0]).toMatchObject({ name: 'Yes', tokenId: TOKEN, price: '0.55' })
    expect(m.tradable).toBe(true)
    expect(normalizeMarket({ condition_id: CONDITION, closed: true, tokens: [] }).tradable).toBe(false)
    expect(normalizeMarket({ junk: true })).toBeNull()
  })

  it('reads the platform fee live (base_fee) and returns null when absent', () => {
    expect(normalizeFeeRate(FEE_BODY, TOKEN)).toMatchObject({ tokenId: TOKEN, feeRateBps: 1000 })
    expect(normalizeFeeRate({}, TOKEN)).toBeNull()
  })

  it('maps a Data-API position, dropping zero-size records', () => {
    expect(normalizePosition(POSITIONS_BODY[0])).toMatchObject({
      tokenId: TOKEN,
      size: '10',
      outcome: 'Yes',
      value: { amount: '5.5', currency: 'USDC' },
      bestBid: { amount: '0.55', currency: 'USDC' },
    })
    expect(normalizePosition({ asset: TOKEN, size: '0' })).toBeNull()
  })

  it('maps a Gamma market, zipping outcomes/token-ids/prices and dropping untradable', () => {
    const m = normalizeGammaMarket(GAMMA_MARKETS[0])
    expect(m.conditionId).toBe(CONDITION)
    expect(m.outcomes).toEqual([
      { name: 'Yes', tokenId: TOKEN, price: '0.55' },
      { name: 'No', tokenId: '1', price: '0.45' },
    ])
    expect(m.tradable).toBe(true)
    expect(m.negRisk).toBe(false)
    expect(normalizeGammaMarket({ foo: 'junk' })).toBeNull()
    expect(normalizeGammaMarket({ conditionId: CONDITION, closed: true, outcomes: '[]', clobTokenIds: '[]' }).tradable).toBe(false)
  })

  it('rejects a malformed order and a stripped/altered builder code', () => {
    expect(validateOrderBody(signedOrder(), BUILDER_CODE)).toBeNull()
    expect(validateOrderBody({ order: { maker: 'nope' }, signature: '0x11' }, BUILDER_CODE)).toBe('invalid_order')
    // Attribution altered to a different code -> rejected (client can't redirect the builder fee).
    expect(validateOrderBody(signedOrder({ builder: ZERO_BYTES32 }), BUILDER_CODE)).toBe('builder_mismatch')
  })
})

// ---- unit: builder-code seam --------------------------------------------------------------------

describe('attachBuilderCode', () => {
  it('attaches the configured code + additive taker fee, zero for makers', () => {
    const config = { polymarket: { builderCode: BUILDER_CODE, takerFeeBps: 50, makerFeeBps: 0 } }
    expect(attachBuilderCode(config, { chainId: 137, isMaker: false })).toMatchObject({
      builderCode: BUILDER_CODE,
      feeBps: 50,
      source: 'attributed',
    })
    expect(attachBuilderCode(config, { chainId: 137, isMaker: true }).feeBps).toBe(0)
  })

  it('is unattributed (zero code, zero fee) when no builder code is configured — never stranded', () => {
    const r = attachBuilderCode({ polymarket: { takerFeeBps: 50 } }, { chainId: 137 })
    expect(r).toMatchObject({ builderCode: ZERO_BYTES32, feeBps: 0, source: 'none' })
  })
})

// ---- unit: L2 auth ------------------------------------------------------------------------------

describe('l2Headers', () => {
  it('signs with SECONDS timestamps and omits headers without creds', () => {
    const h = l2Headers(
      { apiKey: 'k', apiSecret: Buffer.from('s').toString('base64url'), apiPassphrase: 'p', apiAddress: TRADER },
      { method: 'POST', path: '/order', body: '{}', nowSec: 1_700_000_000 }
    )
    expect(h.POLY_TIMESTAMP).toBe('1700000000')
    expect(h.POLY_API_KEY).toBe('k')
    expect(h.POLY_SIGNATURE).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(l2Headers({}, { method: 'GET', path: '/x', body: '', nowSec: 1 })).toEqual({})
  })
})

// ---- config: fee-cap boot validation (SC-010) ---------------------------------------------------

describe('builder-fee config caps', () => {
  it('fails boot loudly when the taker fee exceeds 100 bps', () => {
    expect(() => testConfig({ ...PM_ENV, POLYMARKET_BUILDER_TAKER_FEE_BPS: '200' })).toThrow(/100 bps cap/)
  })
  it('fails boot loudly when the maker fee exceeds 50 bps', () => {
    expect(() => testConfig({ ...PM_ENV, POLYMARKET_BUILDER_MAKER_FEE_BPS: '80' })).toThrow(/50 bps cap/)
  })
  it('rejects a non-bytes32 builder code', () => {
    expect(() => testConfig({ ...PM_ENV, POLYMARKET_BUILDER_CODE: '0x1234' })).toThrow(/bytes32/)
  })
})

// ---- cross-cutting: origin lock / killswitch / fail-closed / quota / chain ----------------------

describe('predict proxy cross-cutting', () => {
  it('requires the origin-auth header', async () => {
    const { app } = build()
    await request(app).get(MARKETS_PATH).expect(403)
  })

  it('fails closed with 503 predict_unconfigured when no key is set', async () => {
    const { app } = build({ env: { POLYMARKET_API_KEY: '' } })
    const res = await get(app, MARKETS_PATH).expect(503)
    expect(res.body.error.code).toBe('predict_unconfigured')
  })

  it('503s when the killswitch is engaged', async () => {
    const { app } = build({ killSwitch: createKillSwitch(true) })
    const res = await get(app, MARKETS_PATH).expect(503)
    expect(res.body.error.code).toBe('killswitch_active')
  })

  it('404s on any non-Polygon chain', async () => {
    const { app } = build()
    const res = await get(app, `/v1/polymarket/1/markets`).expect(404)
    expect(res.body.error.code).toBe('unsupported_chain')
  })

  it('enforces the write quota on builder-sign with Retry-After', async () => {
    const { app } = build({ env: { POLYMARKET_WRITE_QUOTA_PER_ADDRESS: '1', POLYMARKET_WRITE_QUOTA_GLOBAL: '100' } })
    const sign = () => post(app, BUILDER_SIGN_PATH, { method: 'POST', path: '/order', body: '{}' })
    await sign().expect(200)
    const res = await sign().expect(429)
    expect(res.body.error.code).toBe('quota_exceeded')
    expect(res.headers['retry-after']).toBeDefined()
  })
})

// ---- reads --------------------------------------------------------------------------------------

describe('predict reads', () => {
  it('lists live tradable markets from Gamma, dropping unusable records', async () => {
    const { app, polymarketFetch } = build()
    const res = await get(app, MARKETS_PATH).expect(200)
    expect(res.body.markets).toHaveLength(1)
    expect(res.body.markets[0].conditionId).toBe(CONDITION)
    expect(res.body.markets[0].outcomes[0]).toMatchObject({ name: 'Yes', tokenId: TOKEN })
    expect(res.body.stale).toBe(false)
    // Browse hits the Gamma host, not the CLOB.
    expect(polymarketFetch.calls.some((c) => c.url.includes('gamma-api') && c.url.includes('/markets'))).toBe(true)
  })

  it('returns a market detail from Gamma', async () => {
    const { app } = build()
    const res = await get(app, MARKET_PATH).expect(200)
    expect(res.body.question).toBe('Will it rain tomorrow?')
  })

  it('returns the configured builder fee + code with the live platform rate', async () => {
    const { app } = build({ noRouter: true }) // env-fallback builder bps (50/0 defaults)
    const res = await get(app, FEE_PATH).expect(200)
    expect(res.body).toMatchObject({ feeRateBps: 1000, builderTakerFeeBps: 50, builderMakerFeeBps: 0, builderCode: BUILDER_CODE })
  })

  it('still returns builder info (no block) when the CLOB fee rate is unavailable — trading not stranded', async () => {
    const { app } = build({ noRouter: true, polymarketFetch: mockPolymarketFetch({ '/fee-rate': {} }) })
    const res = await get(app, FEE_PATH).expect(200)
    expect(res.body).toMatchObject({ feeRateBps: null, builderTakerFeeBps: 50, builderCode: BUILDER_CODE })
  })

  it('reads positions from the public Data API (no auth — the gateway holds no per-user creds)', async () => {
    const { app, polymarketFetch } = build()
    const posRes = await get(app, POSITIONS_PATH).expect(200)
    expect(posRes.body.positions[0]).toMatchObject({ tokenId: TOKEN, outcome: 'Yes' })
    // Positions: public Data API, no POLY auth headers. (Open orders now run browser->CLOB directly with
    // each member's OWN L2 creds — no gateway route.)
    const posCall = polymarketFetch.calls.find((c) => c.url.includes('data-api') && c.url.includes('/positions'))
    expect(posCall.headers.POLY_API_KEY).toBeUndefined()
  })
})

// ---- builder attribution (POLY_BUILDER_* remote signing) ---------------------------------------
// Order submit/cancel/open-orders run browser->CLOB directly with each member's OWN derived L2 creds
// (CLOB V2 binds every order to its signer, so a shared key can't relay other wallets' orders). The
// gateway only signs the four POLY_BUILDER_* attribution headers from the shared builder creds.

describe('predict builder-sign (attribution)', () => {
  const signReq = { method: 'POST', path: '/order', body: '{"orderType":"GTC"}' }

  it('returns the four POLY_BUILDER_* headers for an order request', async () => {
    const { app } = build()
    const res = await post(app, BUILDER_SIGN_PATH, signReq).expect(200)
    expect(res.body).toMatchObject({ POLY_BUILDER_API_KEY: 'test-pm-key', POLY_BUILDER_PASSPHRASE: 'test-pass' })
    expect(res.body.POLY_BUILDER_SIGNATURE).toEqual(expect.any(String))
    expect(res.body.POLY_BUILDER_TIMESTAMP).toEqual(expect.any(String))
  })

  it('rejects a malformed builder-sign request (missing method/path)', async () => {
    const { app } = build()
    const res = await post(app, BUILDER_SIGN_PATH, { path: '/order' }).expect(400)
    expect(res.body.error.code).toBe('invalid_builder_sign')
  })

  it('503s builder_unconfigured when builder creds are absent — the SPA posts unattributed (never stranded)', async () => {
    const { app } = build({ env: { POLYMARKET_API_KEY: '', POLYMARKET_API_SECRET: '', POLYMARKET_API_PASSPHRASE: '' } })
    const res = await post(app, BUILDER_SIGN_PATH, signReq).expect(503)
    expect(res.body.error.code).toBe('builder_unconfigured')
  })

  it('honors the killswitch', async () => {
    const { app } = build({ killSwitch: createKillSwitch(true) })
    await post(app, BUILDER_SIGN_PATH, signReq).expect(503)
  })
})

// ==== spec 114: live-markets reads (events, event detail, books, prices-history) ==================
// Fixtures are trimmed from payloads probed live on 2026-11-26. Every route test asserts the REQUEST
// the gateway sent upstream (path + query), because a fake that answers any request with the same
// body cannot tell a correct proxy from a wrong one.

const T_YES = '17640596861394454242836532536014033416733783473450136742726948856144855149507'
const T_NO = '104236736263775307891497202874191911203963566711959725788584750440530976742193'
const T_A = '111'
const T_B = '222'
const T_C = '333'

const gammaRow = (over = {}) => ({
  conditionId: '0x' + '01'.repeat(32),
  question: 'Will the Fed decrease interest rates by 50+ bps after the December 2026 meeting?',
  groupItemTitle: '50+ bps decrease',
  image: 'https://example.invalid/row.jpg',
  icon: 'https://example.invalid/row-icon.jpg',
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.0015", "0.9985"]',
  clobTokenIds: JSON.stringify([T_YES, T_NO]),
  bestBid: 0.001,
  bestAsk: 0.002,
  lastTradePrice: 0.002,
  spread: 0.001,
  orderPriceMinTickSize: 0.001,
  orderMinSize: 5,
  acceptingOrders: true,
  active: true,
  closed: false,
  ...over,
})

const EVENT_SLUG = 'fed-decision-in-december'
const gammaEvent = (over = {}) => ({
  id: '1',
  slug: EVENT_SLUG,
  title: 'Fed Decision in December?',
  description: 'Resolves to the FOMC decision.',
  resolutionSource: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  endDate: '2026-12-10T04:59:00Z',
  image: 'https://example.invalid/event.jpg',
  icon: 'https://example.invalid/event-icon.jpg',
  active: true,
  closed: false,
  volume: '61605847.12',
  volume24hr: 1820443.9,
  liquidity: 100,
  negRisk: true,
  tags: [{ slug: 'fed', label: 'Fed' }, { slug: 'economy', label: 'Economy' }],
  markets: [
    gammaRow({ conditionId: '0x' + '01'.repeat(32), groupItemTitle: '50+ bps decrease' }),
    gammaRow({
      conditionId: '0x' + '02'.repeat(32),
      groupItemTitle: '25 bps increase',
      outcomePrices: '["0.935", "0.065"]',
      bestBid: 0.93,
      bestAsk: 0.94,
      lastTradePrice: 0.93,
    }),
    gammaRow({ conditionId: '0x' + '03'.repeat(32), groupItemTitle: 'No change', outcomePrices: '["0.5", "0.5"]' }),
    gammaRow({ conditionId: '0x' + '04'.repeat(32), groupItemTitle: 'Closed row', closed: true, acceptingOrders: false, outcomePrices: '["0.99", "0.01"]' }),
    gammaRow({ conditionId: '0x' + '05'.repeat(32), groupItemTitle: '25 bps decrease', outcomePrices: '["0.2", "0.8"]' }),
  ],
  ...over,
})

// CLOB /book: bids and asks arrive WORST-FIRST (best is the LAST element). Strings are the venue's.
const clobBook = (assetId, over = {}) => ({
  market: CONDITION,
  asset_id: assetId,
  timestamp: '1795659205677',
  hash: 'f67c3666d8b90cfb48a29861679cc3e0a93af60a',
  bids: [
    { price: '0.90', size: '10.50' },
    { price: '0.92', size: '5120.00' },
    { price: '0.93', size: '284698.76' },
  ],
  asks: [
    { price: '0.99', size: '1' },
    { price: '0.95', size: '220072.890' },
    { price: '0.94', size: '7' },
  ],
  min_order_size: '5',
  tick_size: '0.01',
  neg_risk: true,
  last_trade_price: '0.93',
  ...over,
})

const EVENTS_PATH = '/v1/polymarket/137/events'
const EVENT_PATH = `/v1/polymarket/137/events/${EVENT_SLUG}`
const BOOKS_PATH = '/v1/polymarket/137/books'
const HISTORY_PATH = '/v1/polymarket/137/prices-history'

/** The query the gateway sent on the LAST upstream call whose URL contains `needle`. */
function lastQuery(fetchFake, needle) {
  const call = [...fetchFake.calls].reverse().find((c) => c.url.includes(needle))
  expect(call, `no upstream call containing ${needle}`).toBeDefined()
  const u = new URL(call.url)
  return { path: u.pathname, q: Object.fromEntries(u.searchParams) }
}
const callsTo = (fetchFake, needle) => fetchFake.calls.filter((c) => c.url.includes(needle))

describe('spec 114 normalize: categories and validators', () => {
  it('maps only bounded ids to venue tag slugs', () => {
    expect(isCategory('economy')).toBe(true)
    expect(isCategory('toString')).toBe(false)
    expect(isCategory('nope')).toBe(false)
    expect(tagSlugFor('economy')).toBe('economy')
    expect(tagSlugFor('culture')).toBe('pop-culture')
    expect(tagSlugFor('nope')).toBeNull()
    expect(categoryForTags([{ slug: 'fed' }, { slug: 'economy' }, { slug: 'politics' }])).toBe('economy')
    expect(categoryForTags([{ slug: 'fed' }])).toBeNull()
  })

  it('validates slug, range and sort', () => {
    expect(isEventSlug('a-b-1')).toBe(true)
    expect(isEventSlug('A')).toBe(false)
    expect(isEventSlug('a/b')).toBe(false)
    expect(isEventSlug('a'.repeat(161))).toBe(false)
    expect(isRange('1d')).toBe(true)
    expect(isRange('1y')).toBe(false)
    expect(isSort('newest')).toBe(true)
    expect(isSort('volume')).toBe(false)
  })
})

describe('spec 114 normalize: display price', () => {
  it('is the midpoint without float drift while spread <= 0.10, else the last trade', () => {
    expect(displayPrice('0.93', '0.94', '0.5')).toBe('0.935')
    expect(displayPrice('0.1', '0.2', '0.5')).toBe('0.15') // spread exactly 0.10 still uses the midpoint
    expect(displayPrice('0.1', '0.21', '0.5')).toBe('0.5')
    expect(displayPrice('0.93', null, '0.5')).toBe('0.5')
    expect(displayPrice(null, null, null)).toBeNull()
    expect(displayPrice('0.3', '0.4', null)).toBe('0.35') // 0.3+0.4 is 0.7000000000000001 in floats
  })
})

describe('spec 114 normalize: event rows', () => {
  it('summarises at most four rows, tradable first then by Yes price, keeping the total', () => {
    const e = normalizeEvent(gammaEvent())
    expect(e).toMatchObject({
      slug: EVENT_SLUG,
      title: 'Fed Decision in December?',
      category: 'economy',
      volume: '61605847.12',
      volume24h: '1820443.9',
      endDate: '2026-12-10T04:59:00Z',
      mutuallyExclusive: true,
      marketCount: 5,
    })
    expect(e.markets).toHaveLength(4)
    expect(e.markets.map((m) => m.label)).toEqual(['25 bps increase', 'No change', '25 bps decrease', '50+ bps decrease'])
    // The closed row is the one cut, even though its Yes price (0.99) is the highest.
    expect(e.markets.some((m) => m.label === 'Closed row')).toBe(false)
    expect(e.description).toBeUndefined()
    expect(e.status).toBeUndefined()
  })

  it('shapes a row from the venue fields, as strings, with a midpoint display price', () => {
    const row = normalizeEvent(gammaEvent()).markets[0]
    expect(row).toEqual({
      conditionId: '0x' + '02'.repeat(32),
      label: '25 bps increase',
      tradable: true,
      outcomes: [
        { name: 'Yes', tokenId: T_YES, price: '0.935' },
        { name: 'No', tokenId: T_NO, price: '0.065' },
      ],
      bestBid: '0.93',
      bestAsk: '0.94',
      lastTradePrice: '0.93',
      displayPrice: '0.935',
      tickSize: '0.001',
      minOrderSize: '5',
    })
  })

  it('keeps an omitted number null — never "0" — and falls back to the question for the label', () => {
    const e = normalizeEvent(gammaEvent({ volume: undefined, volume24hr: null, markets: [gammaRow({ groupItemTitle: undefined, bestBid: undefined, bestAsk: undefined, lastTradePrice: null, orderMinSize: undefined })] }))
    expect(e.volume).toBeNull()
    expect(e.volume24h).toBeNull()
    const row = e.markets[0]
    expect(row.label).toMatch(/^Will the Fed decrease/)
    expect(row).toMatchObject({ bestBid: null, bestAsk: null, lastTradePrice: null, displayPrice: null, minOrderSize: null })
  })

  it('never forwards an image, icon or markup field, and drops a category it does not own', () => {
    const e = normalizeEvent(gammaEvent({ tags: [{ slug: 'fed' }] }), { detail: true })
    expect(e.category).toBeNull()
    expect(JSON.stringify(e)).not.toMatch(/example\.invalid|"image"|"icon"/)
    expect(JSON.stringify(normalizeMarketRow(gammaRow()))).not.toMatch(/image|icon/)
  })

  it('caps the description at 4,000 characters of plain text', () => {
    const e = normalizeEvent(gammaEvent({ description: 'x'.repeat(5000) }), { detail: true })
    expect(e.description).toHaveLength(4000)
  })

  it('reads the resolution source from the event, else from a market, else null', () => {
    expect(normalizeEvent(gammaEvent(), { detail: true }).resolutionSource).toMatch(/^https:\/\/www\.federalreserve/)
    expect(normalizeEvent(gammaEvent({ resolutionSource: '', markets: [gammaRow({ resolutionSource: 'AP' })] }), { detail: true }).resolutionSource).toBe('AP')
    expect(normalizeEvent(gammaEvent({ resolutionSource: '' }), { detail: true }).resolutionSource).toBeNull()
  })

  it('names the winner of a resolved row only when exactly one outcome settled at 1', () => {
    const resolved = gammaRow({ closed: true, active: false, umaResolutionStatus: 'resolved', outcomePrices: '["0", "1"]' })
    const e = normalizeEvent(gammaEvent({ closed: true, markets: [resolved] }), { detail: true })
    expect(e.status).toBe('resolved')
    expect(e.markets[0]).toMatchObject({ tradable: false, winner: 'No' })

    // Resolved but the prices do not say who won (an even split): null, never a guess.
    const split = gammaRow({ closed: true, umaResolutionStatus: 'resolved', outcomePrices: '["0.5", "0.5"]' })
    expect(normalizeEvent(gammaEvent({ closed: true, markets: [split] }), { detail: true }).markets[0].winner).toBeNull()

    // Closed but not yet resolved: no winner key at all, and the event is `closed`, not `resolved`.
    const pending = gammaRow({ closed: true, umaResolutionStatus: 'proposed', outcomePrices: '["1", "0"]' })
    const p = normalizeEvent(gammaEvent({ closed: true, markets: [pending] }), { detail: true })
    expect(p.status).toBe('closed')
    expect('winner' in p.markets[0]).toBe(false)
    // An open event's rows never carry a winner.
    expect('winner' in normalizeEvent(gammaEvent(), { detail: true }).markets[0]).toBe(false)
  })

  it('drops unusable events and unusable rows instead of failing', () => {
    expect(normalizeEvent({ title: 'no slug' })).toBeNull()
    expect(normalizeEvent(null)).toBeNull()
    expect(normalizeEvent(gammaEvent({ markets: [{ junk: true }, gammaRow()] })).marketCount).toBe(1)
  })
})

describe('spec 114 normalize: books and history', () => {
  it('returns levels best-first, capped at 25, with the venue strings byte-identical', () => {
    const b = normalizeBook(clobBook(T_A))
    expect(b.bids).toEqual([['0.93', '284698.76'], ['0.92', '5120.00'], ['0.90', '10.50']])
    expect(b.asks).toEqual([['0.94', '7'], ['0.95', '220072.890'], ['0.99', '1']])
    expect(b).toMatchObject({
      tokenId: T_A,
      tickSize: '0.01',
      minOrderSize: '5',
      lastTradePrice: '0.93',
      venueTime: new Date(1795659205677).toISOString(),
      venueHash: 'f67c3666d8b90cfb48a29861679cc3e0a93af60a',
    })
    const deep = normalizeBook(clobBook(T_A, { bids: Array.from({ length: 40 }, (_, i) => ({ price: (0.01 + i / 100).toFixed(2), size: '1' })) }))
    expect(deep.bids).toHaveLength(25)
    expect(deep.bids[0][0]).toBe('0.40') // the 25 BEST of 40, not the 25 worst
  })

  it('treats a body that is not a book as unreadable (null), and a real empty book as empty', () => {
    expect(normalizeBook(null)).toBeNull()
    expect(normalizeBook({ asset_id: T_A, bids: 'nope', asks: [] })).toBeNull()
    expect(normalizeBook({ bids: [], asks: [] })).toBeNull()
    expect(normalizeBook(clobBook(T_A, { bids: [], asks: [] }))).toMatchObject({ bids: [], asks: [] })
  })

  it('maps history to {t, p} with p as a string and drops malformed points', () => {
    expect(normalizeHistory({ history: [{ t: 1795572611, p: 0.935 }, { t: 'x', p: 0.1 }, { t: 5, p: null }, { t: 6, p: 7 }] })).toEqual([{ t: 1795572611, p: '0.935' }])
    expect(normalizeHistory({ history: [] })).toEqual([])
    expect(normalizeHistory(undefined)).toEqual([])
  })
})

describe('spec 114 GET /events', () => {
  const eventsFetch = (body = [gammaEvent()], extra = {}) => mockPolymarketFetch({ 'gamma-api.polymarket.com/events': body, ...extra })

  it('lists events by 24h volume by default and sends exactly that query upstream', async () => {
    const { app, polymarketFetch } = build({ polymarketFetch: eventsFetch() })
    const res = await get(app, EVENTS_PATH).expect(200)
    expect(res.body.events).toHaveLength(1)
    expect(res.body.events[0]).toMatchObject({ slug: EVENT_SLUG, category: 'economy', marketCount: 5 })
    expect(res.body.next).toBeNull() // one event is not a full page
    expect(lastQuery(polymarketFetch, '/events')).toEqual({
      path: '/events',
      q: { active: 'true', closed: 'false', archived: 'false', order: 'volume24hr', ascending: 'false', limit: '20', offset: '0' },
    })
  })

  it('filters by the venue tag slug of the category and passes the offset cursor', async () => {
    const { app, polymarketFetch } = build({ polymarketFetch: eventsFetch() })
    await get(app, `${EVENTS_PATH}?category=culture&next=40`).expect(200)
    expect(lastQuery(polymarketFetch, '/events').q).toMatchObject({ tag_slug: 'pop-culture', offset: '40', order: 'volume24hr' })
  })

  it('maps each sort to the venue ordering', async () => {
    const { app, polymarketFetch } = build({ polymarketFetch: eventsFetch() })
    await get(app, `${EVENTS_PATH}?sort=newest`).expect(200)
    expect(lastQuery(polymarketFetch, '/events').q).toMatchObject({ order: 'startDate', ascending: 'false' })
    await get(app, `${EVENTS_PATH}?sort=closing`).expect(200)
    // "closing" starts at the gateway's clock, so events past their end date but unsettled do not lead.
    expect(lastQuery(polymarketFetch, '/events').q).toMatchObject({
      order: 'endDate',
      ascending: 'true',
      end_date_min: new Date(TEST_NOW * 1000).toISOString().replace('.000Z', 'Z'),
    })
  })

  it('offers the next cursor only when the venue returned a full page, and never lists closed events', async () => {
    const page = Array.from({ length: 20 }, (_, i) => gammaEvent({ slug: `e-${i}`, closed: i === 0 }))
    const { app } = build({ polymarketFetch: eventsFetch(page) })
    const res = await get(app, `${EVENTS_PATH}?next=20`).expect(200)
    expect(res.body.next).toBe('40')
    expect(res.body.events).toHaveLength(19)
    expect(res.body.events.some((e) => e.slug === 'e-0')).toBe(false)
  })

  it('uses the venue search for q and ignores category and sort', async () => {
    const search = { events: [gammaEvent()], pagination: { hasMore: true, totalResults: 50 } }
    const { app, polymarketFetch } = build({ polymarketFetch: mockPolymarketFetch({ '/public-search': search }) })
    const res = await get(app, `${EVENTS_PATH}?q=fed%20decision&category=crypto&sort=closing&next=20`).expect(200)
    expect(res.body.events[0].slug).toBe(EVENT_SLUG)
    expect(res.body.next).toBe('40')
    const sent = lastQuery(polymarketFetch, 'gamma-api')
    expect(sent.path).toBe('/public-search')
    expect(sent.q).toMatchObject({ q: 'fed decision', limit_per_type: '20', page: '2' })
    expect(sent.q.tag_slug).toBeUndefined()
    expect(sent.q.order).toBeUndefined()
    expect(callsTo(polymarketFetch, '/events')).toHaveLength(0)
  })

  it('caps q at 128 characters before it reaches the venue', async () => {
    const { app, polymarketFetch } = build({ polymarketFetch: mockPolymarketFetch({ '/public-search': { events: [], pagination: { hasMore: false } } }) })
    await get(app, `${EVENTS_PATH}?q=${'a'.repeat(300)}`).expect(200)
    expect(lastQuery(polymarketFetch, '/public-search').q.q).toHaveLength(128)
  })

  it('carries the confirmedAt / serverNow / stale envelope from the gateway clock', async () => {
    const { app } = build({ polymarketFetch: eventsFetch() })
    const res = await get(app, EVENTS_PATH).expect(200)
    const iso = new Date(TEST_NOW * 1000).toISOString()
    expect(res.body).toMatchObject({ confirmedAt: iso, serverNow: iso, stale: false })
  })

  it('serves the last good copy flagged stale when the venue goes down, and 503s with nothing cached', async () => {
    const fake = eventsFetch()
    const { app, clock } = build({ polymarketFetch: fake })
    await get(app, EVENTS_PATH).expect(200)
    clock.t += 60 // beyond the 15 s TTL
    fake.failWith = 503
    const res = await get(app, EVENTS_PATH).expect(200)
    expect(res.body.stale).toBe(true)
    expect(res.body.confirmedAt).toBe(new Date(TEST_NOW * 1000).toISOString()) // when WE last confirmed it
    expect(res.body.serverNow).toBe(new Date((TEST_NOW + 60) * 1000).toISOString())

    const cold = build({ polymarketFetch: Object.assign(eventsFetch(), { failWith: 503 }) })
    const down = await get(cold.app, EVENTS_PATH).expect(503)
    expect(down.body.error.code).toBe('upstream_unavailable')
  })

  it('rejects bad parameters with the contract codes, before any upstream call', async () => {
    const { app, polymarketFetch } = build({ polymarketFetch: eventsFetch() })
    expect((await get(app, `${EVENTS_PATH}?category=nope`).expect(400)).body.error.code).toBe('invalid_category')
    expect((await get(app, `${EVENTS_PATH}?category=`).expect(400)).body.error.code).toBe('invalid_category')
    expect((await get(app, `${EVENTS_PATH}?sort=best`).expect(400)).body.error.code).toBe('invalid_sort')
    expect((await get(app, `${EVENTS_PATH}?next=abc`).expect(400)).body.error.code).toBe('invalid_cursor')
    expect((await get(app, `${EVENTS_PATH}?next=-1`).expect(400)).body.error.code).toBe('invalid_cursor')
    expect(polymarketFetch.calls).toHaveLength(0)
  })

  it('validates before the read quota is spent', async () => {
    const { app } = build({ env: { POLYMARKET_QUOTA_PER_ADDRESS: '1', POLYMARKET_QUOTA_GLOBAL: '100' }, polymarketFetch: eventsFetch() })
    await get(app, `${EVENTS_PATH}?category=nope`).expect(400)
    await get(app, `${EVENTS_PATH}?category=nope`).expect(400)
    await get(app, EVENTS_PATH).expect(200) // the 400s consumed nothing
    expect((await get(app, EVENTS_PATH).expect(429)).body.error.code).toBe('quota_exceeded')
  })

  it('honours the killswitch and 404s off Polygon', async () => {
    expect((await get(build({ killSwitch: createKillSwitch(true) }).app, EVENTS_PATH).expect(503)).body.error.code).toBe('killswitch_active')
    expect((await get(build().app, '/v1/polymarket/1/events').expect(404)).body.error.code).toBe('unsupported_chain')
  })
})

describe('spec 114 GET /events/:slug', () => {
  it('returns every market plus description, resolution source and status', async () => {
    const { app, polymarketFetch } = build({ polymarketFetch: mockPolymarketFetch({ 'gamma-api.polymarket.com/events': [gammaEvent()] }) })
    const res = await get(app, EVENT_PATH).expect(200)
    expect(res.body).toMatchObject({ slug: EVENT_SLUG, status: 'open', description: 'Resolves to the FOMC decision.', marketCount: 5 })
    expect(res.body.resolutionSource).toMatch(/^https:/)
    expect(res.body.markets).toHaveLength(5)
    expect(res.body.markets.map((m) => m.label)).toContain('Closed row')
    expect(res.body.stale).toBe(false)
    expect(lastQuery(polymarketFetch, '/events')).toEqual({ path: '/events', q: { slug: EVENT_SLUG } })
  })

  it('carries the winner of a resolved market', async () => {
    const resolved = gammaEvent({
      closed: true,
      markets: [gammaRow({ closed: true, active: false, umaResolutionStatus: 'resolved', outcomePrices: '["1", "0"]' })],
    })
    const { app } = build({ polymarketFetch: mockPolymarketFetch({ 'gamma-api.polymarket.com/events': [resolved] }) })
    const res = await get(app, EVENT_PATH).expect(200)
    expect(res.body.status).toBe('resolved')
    expect(res.body.markets[0].winner).toBe('Yes')
  })

  it('404s not_found when the venue returns no event for the slug', async () => {
    const { app } = build({ polymarketFetch: mockPolymarketFetch({ 'gamma-api.polymarket.com/events': [] }) })
    expect((await get(app, EVENT_PATH).expect(404)).body.error.code).toBe('not_found')
  })

  it('rejects a malformed slug with invalid_event and never calls the venue', async () => {
    const { app, polymarketFetch } = build()
    expect((await get(app, '/v1/polymarket/137/events/Bad_Slug').expect(400)).body.error.code).toBe('invalid_event')
    expect((await get(app, `/v1/polymarket/137/events/${'a'.repeat(161)}`).expect(400)).body.error.code).toBe('invalid_event')
    expect(polymarketFetch.calls).toHaveLength(0)
  })

  it('honours the killswitch and 404s off Polygon', async () => {
    expect((await get(build({ killSwitch: createKillSwitch(true) }).app, EVENT_PATH).expect(503)).body.error.code).toBe('killswitch_active')
    expect((await get(build().app, `/v1/polymarket/1/events/${EVENT_SLUG}`).expect(404)).body.error.code).toBe('unsupported_chain')
  })
})

describe('spec 114 GET /books', () => {
  /** CLOB /book fake: answers per token_id; a token mapped to `null` fails with a venue 404. */
  const bookFetch = (perToken) =>
    mockPolymarketFetch({
      '/book': (url) => {
        const id = new URL(url).searchParams.get('token_id')
        const b = perToken[id]
        return b == null ? jsonRes({ error: 'No orderbook exists for the requested token id' }, 404) : jsonRes(b)
      },
    })

  it('returns best-first books for the requested tokens and asks the venue per token', async () => {
    const fake = bookFetch({ [T_A]: clobBook(T_A), [T_B]: clobBook(T_B, { last_trade_price: '0.05' }) })
    const { app } = build({ polymarketFetch: fake })
    const res = await get(app, `${BOOKS_PATH}?token_ids=${T_A},${T_B}`).expect(200)
    expect(res.body.books.map((b) => b.tokenId)).toEqual([T_A, T_B])
    expect(res.body.books[0].bids[0]).toEqual(['0.93', '284698.76'])
    expect(res.body.books[0].asks[0]).toEqual(['0.94', '7'])
    expect(res.body.unreadable).toEqual([])
    expect(res.body.stale).toBe(false)
    const sent = callsTo(fake, '/book').map((c) => ({ path: new URL(c.url).pathname, token: new URL(c.url).searchParams.get('token_id') }))
    expect(sent).toEqual([
      { path: '/book', token: T_A },
      { path: '/book', token: T_B },
    ])
  })

  it('lists one failing token as unreadable without blanking the others or inventing an empty book', async () => {
    const fake = bookFetch({ [T_A]: clobBook(T_A), [T_B]: null, [T_C]: clobBook(T_C) })
    const { app } = build({ polymarketFetch: fake })
    const res = await get(app, `${BOOKS_PATH}?token_ids=${T_A},${T_B},${T_C}`).expect(200)
    expect(res.body.books.map((b) => b.tokenId)).toEqual([T_A, T_C])
    expect(res.body.unreadable).toEqual([T_B])
    expect(res.body.books.some((b) => b.tokenId === T_B)).toBe(false)
  })

  it('treats a 200 body that is not a book as unreadable too', async () => {
    const fake = bookFetch({ [T_A]: clobBook(T_A), [T_B]: { error: 'weird' } })
    const { app } = build({ polymarketFetch: fake })
    const res = await get(app, `${BOOKS_PATH}?token_ids=${T_A},${T_B}`).expect(200)
    expect(res.body.unreadable).toEqual([T_B])
  })

  it('503s when no requested token could be read (nothing was confirmed)', async () => {
    const { app } = build({ polymarketFetch: bookFetch({ [T_A]: null }) })
    expect((await get(app, `${BOOKS_PATH}?token_ids=${T_A}`).expect(503)).body.error.code).toBe('upstream_unavailable')
  })

  it('caches per token: an overlapping request only asks the venue for the new token', async () => {
    const fake = bookFetch({ [T_A]: clobBook(T_A), [T_B]: clobBook(T_B), [T_C]: clobBook(T_C) })
    const { app } = build({ polymarketFetch: fake })
    await get(app, `${BOOKS_PATH}?token_ids=${T_A},${T_B}`).expect(200)
    await get(app, `${BOOKS_PATH}?token_ids=${T_B},${T_C}`).expect(200)
    const tokens = callsTo(fake, '/book').map((c) => new URL(c.url).searchParams.get('token_id'))
    expect(tokens.sort()).toEqual([T_A, T_B, T_C]) // B fetched once, though requested twice
  })

  it('refetches after the book TTL, and stamps confirmedAt with the OLDEST token served', async () => {
    const fake = bookFetch({ [T_A]: clobBook(T_A), [T_B]: clobBook(T_B) })
    const { app, clock } = build({ polymarketFetch: fake })
    await get(app, `${BOOKS_PATH}?token_ids=${T_A}`).expect(200)
    clock.t += 1 // 1 s: inside the 2 s book TTL for A; B is new
    const res = await get(app, `${BOOKS_PATH}?token_ids=${T_A},${T_B}`).expect(200)
    expect(callsTo(fake, '/book')).toHaveLength(2)
    expect(res.body.confirmedAt).toBe(new Date(TEST_NOW * 1000).toISOString()) // A's, the older
    expect(res.body.serverNow).toBe(new Date((TEST_NOW + 1) * 1000).toISOString())
    clock.t += 5
    await get(app, `${BOOKS_PATH}?token_ids=${T_A}`).expect(200)
    expect(callsTo(fake, '/book')).toHaveLength(3)
  })

  it('flags stale when a token is served from a copy older than its TTL because the venue failed', async () => {
    const fake = bookFetch({ [T_A]: clobBook(T_A), [T_B]: clobBook(T_B) })
    const { app, clock } = build({ polymarketFetch: fake })
    await get(app, `${BOOKS_PATH}?token_ids=${T_A},${T_B}`).expect(200)
    clock.t += 30
    fake.failWith = 503
    const res = await get(app, `${BOOKS_PATH}?token_ids=${T_A},${T_B}`).expect(200)
    expect(res.body.stale).toBe(true)
    expect(res.body.books).toHaveLength(2)
    expect(res.body.confirmedAt).toBe(new Date(TEST_NOW * 1000).toISOString())
  })

  it('floors the book TTL at 1 s, with one boot warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(testConfig({ ...PM_ENV, POLYMARKET_BOOK_TTL_MS: '10' }).polymarket.bookTtlMs).toBe(1000)
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('POLYMARKET_BOOK_TTL_MS'))).toHaveLength(1)
      expect(testConfig({ ...PM_ENV }).polymarket).toMatchObject({ bookTtlMs: 2000, historyTtlMs: 60000 })
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects malformed, missing and excess token ids', async () => {
    const { app, polymarketFetch } = build()
    expect((await get(app, BOOKS_PATH).expect(400)).body.error.code).toBe('invalid_token')
    expect((await get(app, `${BOOKS_PATH}?token_ids=`).expect(400)).body.error.code).toBe('invalid_token')
    expect((await get(app, `${BOOKS_PATH}?token_ids=${T_A},0xabc`).expect(400)).body.error.code).toBe('invalid_token')
    expect((await get(app, `${BOOKS_PATH}?token_ids=${T_A},,${T_B}`).expect(400)).body.error.code).toBe('invalid_token')
    const eleven = Array.from({ length: 11 }, (_, i) => String(i + 1)).join(',')
    expect((await get(app, `${BOOKS_PATH}?token_ids=${eleven}`).expect(400)).body.error.code).toBe('too_many_tokens')
    expect(polymarketFetch.calls).toHaveLength(0)
  })

  it('accepts exactly ten tokens', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1))
    const fake = bookFetch(Object.fromEntries(ids.map((id) => [id, clobBook(id)])))
    const { app } = build({ polymarketFetch: fake })
    const res = await get(app, `${BOOKS_PATH}?token_ids=${ids.join(',')}`).expect(200)
    expect(res.body.books).toHaveLength(10)
  })

  it('honours the killswitch and 404s off Polygon', async () => {
    expect((await get(build({ killSwitch: createKillSwitch(true) }).app, `${BOOKS_PATH}?token_ids=${T_A}`).expect(503)).body.error.code).toBe('killswitch_active')
    expect((await get(build().app, `/v1/polymarket/1/books?token_ids=${T_A}`).expect(404)).body.error.code).toBe('unsupported_chain')
  })
})

describe('spec 114 GET /prices-history', () => {
  const HISTORY = { history: [{ t: 1795572611, p: 0.935 }, { t: 1795572911, p: 0.94 }] }
  const historyFetch = (body = HISTORY) => mockPolymarketFetch({ '/prices-history': body })

  it.each([
    ['1h', '1h', '1'],
    ['1d', '1d', '5'],
    ['1w', '1w', '30'],
    ['1m', '1m', '180'],
    ['max', 'max', '720'],
  ])('maps range %s to interval=%s fidelity=%s upstream', async (range, interval, fidelity) => {
    const fake = historyFetch()
    const { app } = build({ polymarketFetch: fake })
    const res = await get(app, `${HISTORY_PATH}?token_id=${T_A}&range=${range}`).expect(200)
    expect(res.body).toMatchObject({ tokenId: T_A, range, stale: false })
    expect(res.body.points).toEqual([{ t: 1795572611, p: '0.935' }, { t: 1795572911, p: '0.94' }])
    expect(lastQuery(fake, '/prices-history')).toEqual({ path: '/prices-history', q: { market: T_A, interval, fidelity } })
  })

  it('returns an empty list, not an error, for a market with no history', async () => {
    const { app } = build({ polymarketFetch: historyFetch({ history: [] }) })
    const res = await get(app, `${HISTORY_PATH}?token_id=${T_A}&range=1d`).expect(200)
    expect(res.body.points).toEqual([])
  })

  it('caches for the history TTL (60 s) and then flags a stale copy when the venue is down', async () => {
    const fake = historyFetch()
    const { app, clock } = build({ polymarketFetch: fake })
    await get(app, `${HISTORY_PATH}?token_id=${T_A}&range=1d`).expect(200)
    clock.t += 30
    await get(app, `${HISTORY_PATH}?token_id=${T_A}&range=1d`).expect(200)
    expect(callsTo(fake, '/prices-history')).toHaveLength(1)
    clock.t += 60
    fake.failWith = 503
    const res = await get(app, `${HISTORY_PATH}?token_id=${T_A}&range=1d`).expect(200)
    expect(res.body.stale).toBe(true)
  })

  it('rejects a malformed token or range', async () => {
    const { app, polymarketFetch } = build()
    expect((await get(app, `${HISTORY_PATH}?range=1d`).expect(400)).body.error.code).toBe('invalid_token')
    expect((await get(app, `${HISTORY_PATH}?token_id=0xabc&range=1d`).expect(400)).body.error.code).toBe('invalid_token')
    expect((await get(app, `${HISTORY_PATH}?token_id=${T_A}&range=1y`).expect(400)).body.error.code).toBe('invalid_range')
    expect((await get(app, `${HISTORY_PATH}?token_id=${T_A}`).expect(400)).body.error.code).toBe('invalid_range')
    expect(polymarketFetch.calls).toHaveLength(0)
  })

  it('honours the killswitch and 404s off Polygon', async () => {
    expect((await get(build({ killSwitch: createKillSwitch(true) }).app, `${HISTORY_PATH}?token_id=${T_A}&range=1d`).expect(503)).body.error.code).toBe('killswitch_active')
    expect((await get(build().app, `/v1/polymarket/1/prices-history?token_id=${T_A}&range=1d`).expect(404)).body.error.code).toBe('unsupported_chain')
  })
})

describe('spec 114 is read-only', () => {
  it('exposes no order, cancel or write route among the new paths', async () => {
    const { app } = build()
    for (const path of [EVENTS_PATH, EVENT_PATH, BOOKS_PATH, HISTORY_PATH]) {
      await post(app, path, { order: {} }).expect((r) => expect([404, 405]).toContain(r.status))
    }
  })
})
