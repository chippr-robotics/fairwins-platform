/**
 * Visual capture harness for spec 114 (Predict live markets, T045) — the actor half of the actor-critic loop
 * (see .claude/skills/actor-critic-screens). Photographs browse, the event page (every trust state), the
 * amount-first ticket (every step), the fixed-price fallback, order progress and the positions/open-orders lists.
 *
 * Usage:
 *   cd frontend && VITE_RELAYER_URL=http://localhost:8899 npx vite --port 5199 --strictPort --host 127.0.0.1
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-predict-live.mjs [outDir] [filter] [baseUrl]
 *
 * Real machinery over posed pixels: the gateway is stubbed at the network boundary with the SAME rules as
 * frontend/cypress/e2e/fast/52-predict-live.cy.js (fixtures mirrored from it), the wallet is a real EIP-6963
 * provider, and the venue's CLOB answers the order endpoints. Nothing is drawn by hand: every state below is the
 * app's own render. Every non-loopback request is aborted.
 */
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const OUT = resolve(process.argv[2] || 'predict-screens')
// Which states to capture: plain substrings, comma-separated ("ticket,progress"). Deliberately not a pattern —
// a regular expression built from an argument is an injection sink even in a script only a developer runs.
const FILTER = process.argv[3] ? process.argv[3].split(',').map((part) => part.trim()).filter(Boolean) : null
const wanted = (name) => FILTER === null || FILTER.some((part) => name.includes(part))
const BASE = process.argv[4] || 'http://127.0.0.1:5199'

const SIZES = { desktop: { width: 1280, height: 720 }, phone: { width: 390, height: 844 } }
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const TOKEN_NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'
const PAGE_SIZE = 3

// ---- fixtures (mirrored from 52-predict-live.cy.js) -------------------------------------------------
const row = (conditionId, label, displayPrice, volume = '9348387.921928', volume24h = '41200.5') => ({
  conditionId, label, tradable: true, negRisk: false,
  outcomes: [
    { name: 'Yes', tokenId: TOKEN_YES, price: displayPrice },
    { name: 'No', tokenId: TOKEN_NO, price: String(Math.round((1 - Number(displayPrice)) * 1000) / 1000) },
  ],
  bestBid: null, bestAsk: null, lastTradePrice: null, volume, volume24h, displayPrice, tickSize: '0.01', minOrderSize: '5',
})
const event = (slug, title, category, markets, over = {}) => ({
  slug, title, category, volume: '61605847.12', volume24h: '1820443.90', endDate: '2030-12-10T12:00:00Z',
  mutuallyExclusive: markets.length > 1, marketCount: markets.length, markets, ...over,
})
const EVENTS = [
  event('fed-decision-in-december', 'Fed Decision in December?', 'economy', [
    row('0xf1', '25 bps increase', '0.935'), row('0xf2', 'No change', '0.05', '812.4', '0'),
    row('0xf3', '50+ bps decrease', '0.004', null, null), row('0xf4', '25 bps decrease', '0.003'),
  ], { marketCount: 6 }),
  event('bitcoin-above-200k', 'Bitcoin above $200k this year?', 'crypto', [row('0xb1', 'Bitcoin above $200k', '0.31')]),
  event('next-election', 'Who wins the next election?', 'politics', [row('0xe1', 'Incumbent party', '0.48')]),
  event('rain-london', 'Will it rain in London tomorrow?', 'world', [row('0xa1', 'Rain in London', '0.62')], { volume: null }),
]
const TOPICS = [
  { slug: 'bitcoin', label: 'Bitcoin', events: 1, volume24h: '1000.5' },
  { slug: 'elections', label: 'Elections', events: 1, volume24h: '900' },
]
const TOPIC_EVENTS = { bitcoin: ['bitcoin-above-200k'], elections: ['next-election'] }
const IN_PLAY = { score: '91-101', period: 'Q4', elapsed: '06:47' }
const BOOK_AGE_MS = { fresh: 0, 'aged-12': 12_000, 'aged-90': 90_000 }
const tokenFor = (i, side) => `${(side === 'yes' ? TOKEN_YES : TOKEN_NO).slice(0, -2)}${String(i).padStart(2, '0')}`
const withOwnTokens = (rows) => rows.map((r, n) => ({ ...r, outcomes: [{ ...r.outcomes[0], tokenId: tokenFor(n, 'yes') }, { ...r.outcomes[1], tokenId: tokenFor(n, 'no') }] }))
const FED_DETAIL = {
  ...EVENTS[0], marketCount: 4, markets: withOwnTokens(EVENTS[0].markets),
  description: 'Resolves to the FOMC target range announced on the decision date.\nA change of at least 25 bps counts.',
  resolutionSource: 'https://www.federalreserve.gov/monetarypolicy.htm', status: 'open', live: null,
}
const DETAILS = { [FED_DETAIL.slug]: FED_DETAIL }
const PRICE_BY_TOKEN = {}
for (const r of FED_DETAIL.markets) {
  PRICE_BY_TOKEN[r.outcomes[0].tokenId] = Number(r.outcomes[0].price)
  PRICE_BY_TOKEN[r.outcomes[1].tokenId] = Number(r.outcomes[1].price)
}

// ---- the stubs ---------------------------------------------------------------------------------------
function makeWorld(over = {}) {
  return { liveSlugs: [], books: 'fresh', depth: 'deep', askShift: 0, feeBps: { taker: 50, maker: 0, venueTaker: 0 }, positions: null, openOrders: null, clob: {}, ...over }
}

const bookFor = (world, tokenId, venueTime) => {
  const mid = (PRICE_BY_TOKEN[tokenId] ?? 0.5) + world.askShift
  const half = Math.min(0.005, mid / 2, (1 - mid) / 2)
  const level = (p, s) => [p.toFixed(3), s]
  const thin = world.depth === 'thin'
  const bids = [level(mid - half, thin ? '40' : '284698.76'), level(mid - half - 0.01, thin ? '30' : '5120.00'), level(mid - half - 0.02, thin ? '20' : '40')].filter((l) => Number(l[0]) > 0)
  const asks = [level(mid + half, thin ? '40' : '220072.89'), level(mid + half + 0.01, thin ? '30' : '1200'), level(mid + half + 0.02, thin ? '20' : '12.5')].filter((l) => Number(l[0]) < 1)
  return { tokenId, bids, asks, tickSize: '0.001', minOrderSize: '5', lastTradePrice: mid.toFixed(3), venueTime, venueHash: `hash-${tokenId.slice(-4)}-${world.askShift}` }
}

async function installGateway(context, world) {
  await context.route(/localhost:8899\/v1\/polymarket/, async (route) => {
    const req = route.request()
    if (req.method() !== 'GET') return route.fulfill({ status: 404, body: '{}' })
    const url = req.url()
    const now = new Date().toISOString()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
    if (/\/discover(\?|$)/.test(url)) return json({ live: { count: world.liveSlugs.length, events: [] }, topics: TOPICS, confirmedAt: now, serverNow: now, stale: false })
    if (/\/fee-rate(\?|$)/.test(url)) return json({ builderTakerFeeBps: world.feeBps.taker, builderMakerFeeBps: world.feeBps.maker, polymarketTakerFeeBps: world.feeBps.venueTaker, feeRateBps: world.feeBps.venueTaker, fetchedAt: Date.now() })
    if (/\/positions(\?|$)/.test(url)) {
      if (world.positions === 'fail') return json({ error: { code: 'upstream_unavailable' } }, 503)
      return json({ positions: world.positions || [] })
    }
    const detail = /\/events\/([a-z0-9-]+)(\?|$)/.exec(url)
    if (detail) {
      if (world.eventsRoute === 'missing') return json({ error: { code: 'not_found' } }, 404)
      const found = DETAILS[detail[1]]
      return found ? json({ ...found, confirmedAt: now, serverNow: now, stale: false }) : json({ error: { code: 'not_found', reason: 'unknown' } }, 404)
    }
    if (/\/books(\?|$)/.test(url)) {
      if (world.books === 'missing') return json({ error: { code: 'not_found' } }, 404)
      if (world.books === 'fail') return json({ error: { code: 'upstream_unavailable', reason: 'books unreachable' } }, 503)
      const ids = (new URL(url).searchParams.get('token_ids') || '').split(',').filter(Boolean)
      const confirmedAt = new Date(Date.parse(now) - BOOK_AGE_MS[world.books]).toISOString()
      return json({ books: ids.map((id) => bookFor(world, id, confirmedAt)), unreadable: [], confirmedAt, serverNow: now, stale: false })
    }
    if (/\/prices-history(\?|$)/.test(url)) {
      const p = new URL(url).searchParams
      const nowSec = Math.floor(Date.parse(now) / 1000)
      const base = 0.2 + (Number(String(p.get('token_id')).slice(-2)) % 5) * 0.15
      const points = Array.from({ length: 40 }, (_, i) => ({ t: nowSec - (39 - i) * 300, p: (base + 0.05 * Math.sin(i / 4)).toFixed(3) }))
      return json({ tokenId: p.get('token_id'), range: p.get('range'), points, confirmedAt: now, serverNow: now, stale: false })
    }
    if (!/\/events(\?|$)/.test(url)) return json({ error: { code: 'not_found' } }, 404)
    if (world.eventsRoute === 'missing') return json({ error: { code: 'not_found' } }, 404)
    const p = new URL(url).searchParams
    const q = (p.get('q') || '').toLowerCase()
    const category = p.get('category') || ''
    const topic = p.get('topic') || ''
    const live = p.get('live') === '1'
    const offset = Number(p.get('next') || 0)
    const all = q ? EVENTS.filter((e) => e.title.toLowerCase().includes(q))
      : live ? EVENTS.filter((e) => world.liveSlugs.includes(e.slug))
      : topic ? EVENTS.filter((e) => (TOPIC_EVENTS[topic] || []).includes(e.slug))
      : category ? EVENTS.filter((e) => e.category === category) : EVENTS
    const events = all.slice(offset, offset + PAGE_SIZE).map((e) => ({ ...e, live: world.liveSlugs.includes(e.slug) ? IN_PLAY : null }))
    const next = offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : null
    return json({ events, next, confirmedAt: now, serverNow: now, stale: false })
  })
}

async function installOthers(context, world) {
  await context.route(/publicnode\.com|rivet\.link|etcdesktop\.com|polygon\.technology/, async (route) => {
    let body
    try { body = JSON.parse(route.request().postData() || '{}') } catch { body = {} }
    const one = ({ method, id }) => ({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x89' : method === 'eth_blockNumber' ? '0x4000000' : method === 'eth_getBalance' ? '0x0' : '0x' })
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) })
  })
  await context.route(/polymarket\.com\/api\/geoblock/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"blocked":false}' }))
  // The venue. `world.clob.post`: 'ok' | 'drop' (answer never arrives) | 'down'.
  await context.route(/clob\.polymarket\.com/, async (route) => {
    const req = route.request()
    const url = new URL(req.url())
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (url.pathname === '/order' && req.method() === 'POST') {
      world.posted = (world.posted || 0) + 1
      if (world.clob.post === 'drop') return route.abort('connectionreset')
      if (world.clob.post === 'down') return json({ error: 'down' }, 503)
      return json({ success: true, orderID: `0x${'cd'.repeat(32)}`, status: 'matched', makingAmount: '50', takingAmount: '53.19', errorMsg: '' })
    }
    if (url.pathname === '/data/orders') return json({ data: world.openOrders || [], next_cursor: 'LTE=', count: (world.openOrders || []).length, limit: 100 })
    if (url.pathname.startsWith('/data/order/')) {
      const id = url.pathname.split('/').pop().toLowerCase()
      const v = world.venueOrders?.[id]
      if (!v || v === 'missing') return json({ error: 'order not found' }, 404)
      return json({ id, status: v.status, owner: 'k', maker_address: ACCOUNT, market: '0xf1', asset_id: TOKEN_YES, side: 'BUY', original_size: '10', size_matched: v.matched ?? '0', price: '0.4', associate_trades: [], outcome: 'Yes', created_at: 1, expiration: '0', order_type: 'GTC' })
    }
    if (url.pathname === '/data/trades') return json({ data: [], next_cursor: 'LTE=', count: 0, limit: 100 })
    if (url.pathname === '/time') return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: String(Math.floor(Date.now() / 1000)) })
    if (/neg-risk/.test(url.pathname)) return json({ neg_risk: false })
    if (/tick-size/.test(url.pathname)) return json({ minimum_tick_size: 0.001 })
    if (/fee-rate/.test(url.pathname)) return json({ base_fee: 0 })
    if (/auth\/(derive-)?api-key/.test(url.pathname)) return json({ apiKey: 'k', secret: 'c2VjcmV0c2VjcmV0', passphrase: 'p' })
    return json({}, 200)
  })
}

async function newPage(browser, { theme, size, world, seed }) {
  const context = await browser.newContext({ viewport: SIZES[size] })
  const origin = new URL(BASE).origin
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
    return route.abort()
  })
  await installOthers(context, world)
  await installGateway(context, world)
  const page = await context.newPage()
  await page.addInitScript(({ theme, account, seed }) => {
    const set = (k, v) => window.localStorage.setItem(k, v)
    set('themeMode', theme)
    set('dev_warning_banner_dismissed', 'true')
    set('fairwins.entryGate.ack.v1', JSON.stringify({ terms: null, risk: null, at: new Date(0).toISOString() }))
    if (seed) {
      if (seed.orders) set(`fw_user_${account.toLowerCase()}_predict_orders_v1`, JSON.stringify({ v: 1, orders: seed.orders, idScheme: 'unknown' }))
      if (seed.creds) window.sessionStorage.setItem(`predict.clob.creds.${account.toLowerCase()}`, JSON.stringify({ key: 'k', secret: 'c2VjcmV0c2VjcmV0', passphrase: 'p' }))
    }
    const provider = {
      isMetaMask: true, selectedAddress: account, chainId: '0x89', networkVersion: '137', _callbacks: {},
      on(e, cb) { (this._callbacks[e] = this._callbacks[e] || []).push(cb) },
      removeListener(e, cb) { this._callbacks[e] = (this._callbacks[e] || []).filter((f) => f !== cb) },
      async request({ method }) {
        switch (method) {
          case 'eth_accounts': case 'eth_requestAccounts': return [account]
          case 'eth_chainId': return '0x89'
          case 'net_version': return '137'
          case 'eth_getBalance': return '0x0'
          case 'personal_sign': case 'eth_sign': return '0x' + account.slice(2).toLowerCase().repeat(4).slice(0, 130)
          case 'eth_signTypedData_v4': case 'eth_signTypedData': return '0x' + account.slice(2).toLowerCase().repeat(4).slice(0, 128) + '1b'
          case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': return null
          default: return '0x'
        }
      },
    }
    window.ethereum = provider
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'c0ffee00-0000-4000-8000-000000000114', name: 'Capture Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'app.fairwins.capture' }, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { theme, account: ACCOUNT, seed })
  return { page, context }
}

async function openPredict(page, search = '') {
  await page.goto(`${BASE}/wallet?tab=predict${search}`, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: '.dev-warning-banner,.notification{display:none!important}' })
  await page.waitForSelector('[aria-label="Predict"]', { timeout: 60_000 })
}

const FED = '&event=fed-decision-in-december'
const ticketLoc = (page) => page.locator('.order-ticket')
const amount = (page) => page.locator('.order-ticket label', { hasText: /Amount to spend/ }).locator('input')
async function waitLive(page) {
  await page.waitForFunction(() => /Live/.test(document.querySelector('.event-page .predict-trust-chip')?.textContent || ''), null, { timeout: 40_000 })
}
async function openYes(page) {
  await openPredict(page, FED)
  await page.waitForSelector('.event-page h2', { timeout: 30_000 })
  await waitLive(page)
  await page.locator('.event-page-row').first().locator('.event-page-side--yes').click()
  await ticketLoc(page).waitFor({ timeout: 20_000 })
}
const settle = (page, ms = 700) => page.waitForTimeout(ms)

const ORDER = (n) => `0x${String(n).repeat(64).slice(0, 64)}`
const record = (n, state, extra = {}) => {
  const now = Date.now()
  return { orderId: ORDER(n), idKnown: true, tokenId: TOKEN_YES, side: 'BUY', kind: 'resting', size: '10', sizeUnit: 'shares', limitPrice: '0.4', label: 'Buy Yes — Fed Decision in December?', state, filledSize: '0', settledSize: null, averageFillPrice: null, createdAt: now - n * 60_000, updatedAt: now, reason: null, absentSince: null, absentReads: 0, ...extra }
}

// ---- scenarios -----------------------------------------------------------------------------------
// shot(name) takes the page; `full` frames the viewport (sheets), else the predict panel.
const SCENARIOS = [
  { id: 'browse', world: { liveSlugs: ['next-election'] }, run: async (page, shot) => {
    await openPredict(page); await page.waitForSelector('.event-card'); await page.waitForSelector('.predict-chip-label'); await settle(page)
    await shot('browse')
    await page.getByRole('group', { name: 'Categories' }).getByRole('button', { name: 'Crypto' }).click(); await page.waitForTimeout(900)
    await shot('browse-category')
    await page.getByRole('group', { name: 'Popular now' }).getByRole('button', { name: /In play/ }).click(); await page.waitForTimeout(900)
    await shot('browse-in-play')
    await page.locator('[aria-label="Search markets"]').fill('zzzz'); await page.waitForTimeout(1200)
    await shot('browse-search-empty')
  } },
  { id: 'event', world: {}, run: async (page, shot) => {
    await openPredict(page, FED); await page.waitForSelector('.event-page h2'); await waitLive(page)
    await page.waitForSelector('.event-chart-plot path.recharts-line-curve'); await page.waitForSelector('.event-depth-table'); await settle(page, 900)
    await shot('event-live', { full: true })
    await shot('event-live-top')
  } },
  { id: 'event-delayed', world: {}, run: async (page, shot, world) => {
    await openPredict(page, FED); await page.waitForSelector('.event-page h2'); await waitLive(page)
    world.books = 'aged-12'
    await page.waitForFunction(() => /Delayed · \d+ s/.test(document.querySelector('.event-page .predict-trust-chip')?.textContent || ''), null, { timeout: 30_000 }); await settle(page)
    await shot('event-delayed', { full: true })
    world.books = 'aged-90'
    await page.waitForFunction(() => /Last known/.test(document.querySelector('.event-page .predict-trust-chip')?.textContent || ''), null, { timeout: 30_000 }); await settle(page)
    await shot('event-last-known', { full: true })
  } },
  { id: 'ticket', world: {}, run: async (page, shot, world) => {
    await openYes(page); await settle(page)
    await shot('ticket-empty', { full: true })
    await amount(page).fill('50'); await page.waitForSelector('[data-testid="figure-average"]'); await settle(page)
    await shot('ticket-figures', { full: true })
    await page.getByRole('button', { name: 'Set my own price' }).click(); await page.locator('.order-ticket-own-body input').fill('90'); await settle(page, 900)
    await shot('ticket-resting', { full: true })
    await page.getByRole('button', { name: 'Use the market price instead' }).click(); await settle(page)
    await amount(page).fill('50'); await page.waitForSelector('[data-testid="figure-average"]')
    world.books = 'aged-12'
    await page.waitForFunction(() => /Waiting for a current price/.test(document.querySelector('.order-ticket')?.textContent || ''), null, { timeout: 30_000 }); await settle(page)
    await shot('ticket-waiting', { full: true })
    world.books = 'fresh'
    await page.waitForSelector('[data-testid="figure-average"]', { timeout: 30_000 })
    await ticketLoc(page).getByRole('button', { name: 'Review order' }).click(); await page.getByText('Review your order').waitFor(); await settle(page)
    await shot('ticket-review', { full: true })
  } },
  { id: 'focus', world: {}, run: async (page, shot) => {
    await openYes(page); await amount(page).fill('50'); await page.waitForSelector('[data-testid="figure-average"]')
    // Keyboard: Tab from the amount to the first quick amount, then on to the outcome toggle's sibling controls.
    await page.keyboard.press('Tab'); await settle(page, 300)
    await shot('focus-chip', { full: true })
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab'); await settle(page, 300)
    await shot('focus-outcome', { full: true })
  } },
  { id: 'tolerance', world: {}, run: async (page, shot) => {
    await openYes(page); await amount(page).fill('50'); await page.waitForSelector('[data-testid="figure-average"]'); await settle(page)
    await page.getByRole('button', { name: /^Price tolerance/ }).scrollIntoViewIfNeeded()
    await shot('tolerance-collapsed', { full: true })
    await page.getByRole('button', { name: /^Price tolerance/ }).click(); await settle(page, 400)
    await page.getByRole('button', { name: /^Price tolerance/ }).scrollIntoViewIfNeeded()
    await shot('tolerance-open', { full: true })
    await page.getByRole('group', { name: 'Price tolerance' }).getByRole('button', { name: '2¢' }).click(); await settle(page, 400)
    await shot('tolerance-chosen', { full: true })
    await ticketLoc(page).getByRole('button', { name: 'Review order' }).click(); await page.getByText('Review your order').waitFor(); await settle(page)
    await page.getByText(/Price limit:/).scrollIntoViewIfNeeded()
    await shot('tolerance-review', { full: true })
  } },
  { id: 'ticket-moved', world: {}, run: async (page, shot, world) => {
    await openYes(page); await amount(page).fill('50'); await page.waitForSelector('[data-testid="figure-average"]')
    await ticketLoc(page).getByRole('button', { name: 'Review order' }).click(); await page.getByText('Review your order').waitFor()
    world.askShift = 0.03; await page.waitForTimeout(3500) // let the seam read the moved book
    await ticketLoc(page).getByRole('button', { name: /^Sign buy/ }).click()
    await page.waitForFunction(() => /moved|Check the figures/.test(document.querySelector('.order-ticket')?.textContent || ''), null, { timeout: 30_000 }).catch(() => {})
    await settle(page, 1200)
    await shot('ticket-moved', { full: true })
  } },
  { id: 'ticket-unknown', world: { clob: { post: 'drop' } }, seed: { creds: true }, run: async (page, shot) => {
    await openYes(page); await amount(page).fill('50'); await page.waitForSelector('[data-testid="figure-average"]')
    await ticketLoc(page).getByRole('button', { name: 'Review order' }).click(); await page.getByText('Review your order').waitFor()
    await ticketLoc(page).getByRole('button', { name: /^Sign buy/ }).click()
    await page.waitForSelector('.order-ticket [role="alert"]', { timeout: 40_000 }).catch(() => {}); await settle(page, 1200)
    await shot('ticket-unknown', { full: true })
  } },
  { id: 'ticket-done', world: { clob: { post: 'ok' } }, seed: { creds: true }, run: async (page, shot) => {
    await openYes(page); await amount(page).fill('50'); await page.waitForSelector('[data-testid="figure-average"]')
    await ticketLoc(page).getByRole('button', { name: 'Review order' }).click(); await page.getByText('Review your order').waitFor()
    await ticketLoc(page).getByRole('button', { name: /^Sign buy/ }).click()
    await page.waitForSelector('.order-ticket [role="status"]:has-text("Polymarket")', { timeout: 40_000 }).catch(() => {}); await settle(page, 1200)
    await shot('ticket-done', { full: true })
  } },
  { id: 'ticket-fee', world: { feeBps: { taker: 50, maker: 0, venueTaker: 100 } }, run: async (page, shot) => {
    await openYes(page); await amount(page).fill('50'); await page.waitForSelector('[data-testid="figure-average"]'); await settle(page)
    await shot('ticket-venue-fee', { full: true })
    await ticketLoc(page).getByRole('button', { name: 'Review order' }).click(); await page.getByText('Review your order').waitFor(); await settle(page)
    await shot('ticket-venue-fee-review', { full: true })
  } },
  { id: 'fallback', world: { books: 'missing' }, run: async (page, shot) => {
    await openPredict(page, FED); await page.waitForSelector('.event-page h2'); await settle(page, 1500)
    await page.locator('.event-page-row').first().locator('.event-page-side--yes').click()
    await page.waitForSelector('.market-detail'); await settle(page)
    await shot('fallback-sheet', { full: true })
    await page.locator('.market-detail-buy').first().click(); await page.waitForSelector('.trade-confirm [aria-label^="Number of"]'); await settle(page, 900)
    await shot('fallback-confirm-empty', { full: true })
    await page.locator('.trade-confirm [aria-label^="Number of"]').fill('10'); await page.waitForSelector('.trade-confirm-breakdown'); await settle(page)
    await shot('fallback-confirm', { full: true })
  } },
  { id: 'fallback-unknown', world: { books: 'missing', clob: { post: 'drop' } }, seed: { creds: true }, run: async (page, shot) => {
    await openPredict(page, FED); await page.waitForSelector('.event-page h2'); await settle(page, 1500)
    await page.locator('.event-page-row').first().locator('.event-page-side--yes').click()
    await page.waitForSelector('.market-detail'); await page.locator('.market-detail-buy').first().click()
    await page.locator('.trade-confirm [aria-label^="Number of"]').fill('10'); await page.waitForSelector('.trade-confirm-breakdown')
    await page.locator('.trade-confirm-submit').click()
    await page.waitForSelector('.trade-confirm-error', { timeout: 40_000 }); await settle(page, 800)
    await shot('fallback-unknown', { full: true })
  } },
  { id: 'progress', world: {}, seed: (w) => ({ creds: true, orders: [
      record(1, 'resting'), record(2, 'partial', { filledSize: '4' }), record(3, 'matched', { filledSize: '10' }),
      record(4, 'unconfirmed', { reason: 'Polymarket did not confirm whether it received this order.', filledSize: null }), record(5, 'cancelled') ] }),
    venue: { [ORDER(1)]: { status: 'LIVE', matched: '0' }, [ORDER(2)]: { status: 'LIVE', matched: '4' }, [ORDER(3)]: { status: 'MATCHED', matched: '10' }, [ORDER(4)]: 'missing', [ORDER(5)]: { status: 'CANCELED', matched: '0' } },
    run: async (page, shot) => {
      await openPredict(page); await page.waitForSelector('.order-progress', { timeout: 40_000 }); await settle(page, 2500)
      await page.locator('.order-progress').scrollIntoViewIfNeeded()
      await shot('progress', { el: '.order-progress' })
      await shot('progress-page')
    } },
  { id: 'progress-locked', world: {}, seed: () => ({ creds: false, orders: [record(1, 'resting')] }), run: async (page, shot) => {
    await openPredict(page); await page.waitForSelector('.order-progress', { timeout: 40_000 }); await settle(page, 1500)
    await shot('progress-locked', { el: '.order-progress' })
  } },
  { id: 'portfolio', world: {
      positions: [{ tokenId: TOKEN_YES, outcome: 'Yes', size: '53.19', bestBid: { amount: '0.935' } }, { tokenId: TOKEN_NO, outcome: 'No', size: '12', bestBid: null }],
      openOrders: [{ id: ORDER(9), status: 'LIVE', owner: 'k', maker_address: ACCOUNT, market: '0xf1', asset_id: TOKEN_YES, side: 'BUY', original_size: '100', size_matched: '60', price: '0.4', outcome: 'Yes', created_at: 1, expiration: '0', order_type: 'GTC' }] },
    seed: () => ({ creds: true }), run: async (page, shot) => {
    await openPredict(page); await page.waitForSelector('.predict-positions', { timeout: 40_000 }); await page.waitForTimeout(2500)
    await page.locator('.predict-positions').scrollIntoViewIfNeeded()
    await shot('positions-orders', { el: '.predict-panel' })
    await shot('positions-orders-view')
  } },
]


// ---- the critic's measurements: contrast and tap targets, taken from the rendered page, not eyeballed ----
const AUDIT = []
async function audit(page, name, scopeSel) {
  await page.waitForTimeout(450) // let colour transitions finish: a mid-transition read is not the resting state
  const found = await page.evaluate((scopeSel) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 1
    const ctx = cv.getContext('2d', { willReadFrequently: true })
    const rgba = (css) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = css; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255] }
    const over = (top, bot) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + bot[i] * (1 - a)).concat([1]) }
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) }
    const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e); let acc = rgba(getComputedStyle(document.documentElement).backgroundColor); if (acc[3] === 0) acc = [255, 255, 255, 1]; let grad = false
      for (const e of chain.reverse()) { const cs = getComputedStyle(e); if (cs.backgroundImage && cs.backgroundImage !== 'none') grad = true; const c = rgba(cs.backgroundColor); if (c[3] > 0) acc = over(c, acc) } return { acc, grad } }
    const scope = document.querySelector(scopeSel) || document.body
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0' }
    const sel = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
    const out = { contrast: [], targets: [], overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }
    const seen = new Set()
    for (const el of scope.querySelectorAll('*')) {
      if (!visible(el)) continue
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ')
      if (own && !el.closest('.sr-only')) {
        const cs = getComputedStyle(el); const fg = rgba(cs.color); const { acc, grad } = bgOf(el)
        const eff = over(fg, acc); const r = ratio(eff, acc)
        const px = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700
        const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5
        const disabled = el.closest('button:disabled,[aria-disabled="true"]')
        const key = sel(el) + own.slice(0, 20)
        if (r < need && !seen.has(key)) { seen.add(key); out.contrast.push({ el: sel(el), fg: cs.color, bg: `rgb(${acc.slice(0, 3).map(Math.round)})`, text: own.slice(0, 40), ratio: Math.round(r * 100) / 100, need, px, grad, disabled: Boolean(disabled) }) }
      }
      if (el.matches('button,a[href],input,select,[role="button"]') && !el.closest('.sr-only')) {
        const b = el.getBoundingClientRect(); const inline = el.matches('a') && el.closest('p,li,span') && getComputedStyle(el).display === 'inline'
        if ((b.width < 44 || b.height < 44) && !inline) { const key = sel(el) + (el.textContent || '').slice(0, 20); if (!seen.has(key)) { seen.add(key); out.targets.push({ el: sel(el), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30), w: Math.round(b.width), h: Math.round(b.height) }) } }
      }
    }
    return out
  }, scopeSel)
  AUDIT.push({ name, ...found })
}

const shots = []
async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  for (const size of Object.keys(SIZES)) {
    for (const theme of ['light', 'dark']) {
      for (const sc of SCENARIOS) {
        if (!wanted(sc.id)) continue
        const attempt = async () => {
          const world = makeWorld(sc.world)
          world.venueOrders = sc.venue
          const seed = typeof sc.seed === 'function' ? sc.seed(world) : sc.seed
          const { page, context } = await newPage(browser, { theme, size, world, seed })
          const shot = async (name, o = {}) => {
            const file = `${OUT}/${name}-${theme}-${size}.png`
            if (o.full) await page.screenshot({ path: file })
            else {
              // The PAGE as a member sees it: the panel's full height, at the full viewport width (an element
              // screenshot clips to the panel's own box and hides the page's side gutter).
              const box = await page.locator('.predict-panel').first().evaluate((el) => { const r = el.getBoundingClientRect(); return { y: Math.max(0, r.top + window.scrollY - 70), h: r.height + 70 } })
              await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: box.y, width: SIZES[size].width, height: box.h } })
            }
            shots.push(file); console.log('  shot', `${name}-${theme}-${size}`)
            await audit(page, `${name}-${theme}-${size}`, o.full ? (await page.locator('.order-ticket,.trade-confirm,.market-detail').count() ? '.order-ticket,.trade-confirm,.market-detail' : 'body') : (o.el || 'body'))
          }
          try { await sc.run(page, shot, world) } finally { await context.close() }
        }
        try { await attempt() } catch (err) {
          console.error(`  retry ${sc.id}/${theme}/${size}:`, err.message.split('\n')[0])
          try { await attempt() } catch (e2) { console.error(`  FAILED ${sc.id}/${theme}/${size}:`, e2.message.split('\n')[0]) }
        }
      }
    }
  }
  await browser.close()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(`${OUT}/audit${FILTER ? '-' + process.argv[3].replace(/[^a-z]/gi, '') : ''}.json`, JSON.stringify(AUDIT, null, 1))
  console.log(`\n${shots.length} shots -> ${OUT}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
