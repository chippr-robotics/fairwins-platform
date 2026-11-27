/**
 * Visual capture harness for spec 115 (Predict live game views) — the actor half of the actor-critic loop
 * (see .claude/skills/actor-critic-screens). Photographs the event page of a football game in every state the
 * view has: live, delayed, last known, not started, ended, play source unreadable, `teams` without home/away,
 * a non-integer score, and the module off (which must look like an event with no game at all).
 *
 * Usage:
 *   cd frontend && VITE_RELAYER_URL=http://localhost:8899 npx vite --port 5199 --strictPort --host 127.0.0.1
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-predict-game.mjs [outDir] [filter] [baseUrl]
 *
 * The gateway is stubbed at the network boundary with the contract's own shapes
 * (specs/115-predict-live-game-views/contracts/gateway-sports-api.md); every non-loopback request is aborted.
 * Besides a screenshot per state, each shot runs axe over the game view and reports overflow and target sizes.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const OUT = resolve(process.argv[2] || 'game-screens')
const FILTER = process.argv[3] ? process.argv[3].split(',').map((p) => p.trim()).filter(Boolean) : null
const wanted = (name) => FILTER === null || FILTER.some((p) => name.includes(p))
const BASE = process.argv[4] || 'http://127.0.0.1:5199'
const SIZES = { desktop: { width: 1280, height: 720 }, phone: { width: 390, height: 844 } }
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const TOKEN_NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'
const SLUG = 'eagles-vs-cowboys'
const AXE = readFileSync(resolve(process.cwd(), '../node_modules/axe-core/axe.min.js'), 'utf8')

const HOME_AWAY = { gameId: 19618, league: 'nfl', startTime: '2026-11-26T21:30:00Z', listed: { status: 'in-progress', scoreText: '10-28', period: 'Q3', clock: '10:39' }, home: { name: 'Cowboys', code: 'DAL' }, away: { name: 'Eagles', code: 'PHI' } }
const TEAMS = { gameId: 19618, league: 'nfl', startTime: '2026-11-26T21:30:00Z', teams: [{ name: 'Eagles', code: 'PHI' }, { name: 'Cowboys', code: 'DAL' }] }
const eventFor = (game) => ({
  slug: SLUG, title: 'Eagles vs. Cowboys', category: 'sports', volume: '2400000.5', volume24h: '120000', endDate: '2030-12-10T12:00:00Z',
  mutuallyExclusive: true, marketCount: 1, description: 'Resolves to the winner of the game.', resolutionSource: 'NFL', status: 'open', live: null, game,
  markets: [{ conditionId: '0xg1', label: 'Cowboys win', tradable: true, negRisk: false,
    outcomes: [{ name: 'Yes', tokenId: TOKEN_YES, price: '0.80' }, { name: 'No', tokenId: TOKEN_NO, price: '0.20' }],
    bestBid: null, bestAsk: null, lastTradePrice: null, volume: '1000', volume24h: '10', displayPrice: '0.80', tickSize: '0.01', minOrderSize: '5' }],
})

const PLAYS = [
  { id: 'p5', period: 'Q3', clock: '10:44', text: 'Dak Prescott pass incomplete short right to CeeDee Lamb.', scoring: false, side: 'home' },
  { id: 'p4', period: 'Q3', clock: '11:02', text: 'Tony Pollard rush up the middle for a loss of 3 yards.', scoring: false, side: 'home' },
  { id: 'p3', period: 'Q3', clock: '11:20', text: 'Jake Elliott 42 yard field goal is GOOD.', scoring: true, side: 'away' },
  { id: 'p2', period: 'Q3', clock: '14:02', text: 'Kickoff returned to the DAL 25.', scoring: false, side: 'home' },
  { id: 'p1', period: 'Q2', clock: '0:00', text: 'End of half.', scoring: false, side: null },
]
const SITUATION = { possession: 'home', yardLine: 37, yardLineText: 'DAL 37', down: 4, distance: 18, downDistanceText: '4th & 18 at DAL 37', lineToGain: 55, redZone: false }

const BASE_ROW = { gameId: 19618, league: 'nfl', source: 'plays', status: 'in-progress', score: { home: 28, away: 10 }, scoreText: null, period: 'Q3', clock: '10:39', possession: 'home', changedAt: null, agree: true, venue: null }
const detailRead = (now, over = {}) => ({ state: 'read', confirmedAt: now - 3000, situation: SITUATION, plays: PLAYS, ...over })
const VENUE_ROW = (now, over = {}) => ({ ...BASE_ROW, source: 'venue', score: { home: 21, away: 10 }, possession: null, confirmedAt: now - 5000, changedAt: now - 40_000, agree: null, detail: { state: 'not-covered', situation: null, plays: [] }, ...over })

/** scenario → { listing, answer(now) } ; answer returns { status, body } or null for "module off". */
const SCENARIOS = [
  { id: 'venue-only', game: HOME_AWAY, answer: (now) => VENUE_ROW(now) },
  { id: 'venue-last-known', game: HOME_AWAY, answer: (now) => VENUE_ROW(now, { confirmedAt: now - 150_000, changedAt: now - 300_000 }) },
  { id: 'disagree', game: HOME_AWAY, answer: (now) => ({ ...BASE_ROW, confirmedAt: now - 2000, agree: false, venue: { status: 'in-progress', score: { home: 21, away: 10 }, scoreText: null, period: 'Q3', clock: '10:39', changedAt: now - 120_000 }, detail: detailRead(now) }) },
  { id: 'listing', game: HOME_AWAY, abort: true },
  { id: 'live', game: HOME_AWAY, answer: (now) => ({ ...BASE_ROW, confirmedAt: now - 2000, detail: detailRead(now) }) },
  { id: 'delayed', game: HOME_AWAY, answer: (now) => ({ ...BASE_ROW, confirmedAt: now - 45_000, detail: detailRead(now, { confirmedAt: now - 45_000 }) }) },
  { id: 'last-known', game: HOME_AWAY, answer: (now) => ({ ...BASE_ROW, confirmedAt: now - 180_000, detail: detailRead(now, { confirmedAt: now - 180_000 }) }) },
  { id: 'plays-unreadable', game: HOME_AWAY, sources: { venue: { state: 'read', label: 'Polymarket' }, plays: { state: 'unreadable', reason: 'upstream_error', label: 'ESPN' } }, answer: (now) => VENUE_ROW(now, { detail: { state: 'unreadable', confirmedAt: null, situation: null, plays: [] } }) },
  { id: 'scheduled', game: HOME_AWAY, answer: (now) => ({ ...BASE_ROW, status: 'scheduled', score: null, period: null, clock: null, possession: null, agree: null, confirmedAt: now - 2000, detail: { state: 'not-covered', situation: null, plays: [] } }) },
  { id: 'ended', game: HOME_AWAY, answer: (now) => ({ ...BASE_ROW, status: 'ended', score: { home: 31, away: 24 }, period: 'Final', clock: null, possession: null, confirmedAt: now - 2000, detail: detailRead(now, { situation: null }) }) },
  { id: 'teams', game: TEAMS, answer: (now) => ({ ...BASE_ROW, confirmedAt: now - 2000, detail: detailRead(now) }) },
  { id: 'score-text', game: { ...HOME_AWAY, league: 'atp' }, answer: (now) => ({ ...BASE_ROW, league: 'atp', score: null, scoreText: '6-4, 3-2', possession: null, confirmedAt: now - 2000, detail: { state: 'not-covered', situation: null, plays: [] } }) },
  { id: 'off', game: HOME_AWAY, off: true },
]

function bookFor(tokenId, venueTime) {
  const mid = tokenId === TOKEN_YES ? 0.8 : 0.2
  const lv = (p, s) => [p.toFixed(3), s]
  return { tokenId, bids: [lv(mid - 0.005, '2846'), lv(mid - 0.015, '5120')], asks: [lv(mid + 0.005, '2200'), lv(mid + 0.015, '1200')], tickSize: '0.001', minOrderSize: '5', lastTradePrice: mid.toFixed(3), venueTime, venueHash: `h-${tokenId.slice(-4)}` }
}

async function newPage(browser, { theme, size, sc }) {
  const context = await browser.newContext({ viewport: SIZES[size] })
  const origin = new URL(BASE).origin
  await context.route('**/*', (route) => {
    const url = route.request().url()
    return url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:') ? route.continue() : route.abort()
  })
  const cors = { 'access-control-allow-origin': '*' }
  await context.route(/publicnode\.com|rivet\.link|etcdesktop\.com|polygon\.technology/, async (route) => {
    let body
    try { body = JSON.parse(route.request().postData() || '{}') } catch { body = {} }
    const one = ({ method, id }) => ({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x89' : method === 'eth_blockNumber' ? '0x4000000' : method === 'eth_getBalance' ? '0x0' : '0x' })
    await route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)) })
  })
  await context.route(/polymarket\.com\/api\/geoblock/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"blocked":false}' }))
  await context.route(/clob\.polymarket\.com/, (r) => r.fulfill({ status: 503, contentType: 'application/json', headers: cors, body: '{}' }))
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) })
  await context.route(/localhost:8899\/v1\/polymarket/, async (route) => {
    const url = route.request().url()
    const now = new Date().toISOString()
    if (/\/discover(\?|$)/.test(url)) return json(route, { live: { count: 0, events: [] }, topics: [], confirmedAt: now, serverNow: now, stale: false })
    if (/\/fee-rate(\?|$)/.test(url)) return json(route, { builderTakerFeeBps: 50, builderMakerFeeBps: 0, polymarketTakerFeeBps: 0, fetchedAt: Date.now() })
    if (/\/events\/[a-z0-9-]+(\?|$)/.test(url)) return json(route, { ...eventFor(sc.game), confirmedAt: now, serverNow: now, stale: false })
    if (/\/books(\?|$)/.test(url)) {
      const ids = (new URL(url).searchParams.get('token_ids') || '').split(',').filter(Boolean)
      return json(route, { books: ids.map((id) => bookFor(id, now)), unreadable: [], confirmedAt: now, serverNow: now, stale: false })
    }
    if (/\/prices-history(\?|$)/.test(url)) {
      const nowSec = Math.floor(Date.now() / 1000)
      return json(route, { tokenId: TOKEN_YES, range: '1d', points: Array.from({ length: 40 }, (_, i) => ({ t: nowSec - (39 - i) * 300, p: (0.7 + 0.1 * Math.sin(i / 5)).toFixed(3) })), confirmedAt: now, serverNow: now, stale: false })
    }
    return json(route, { error: { code: 'not_found' } }, 404)
  })
  await context.route(/localhost:8899\/v1\/sports\//, async (route) => {
    if (sc.abort) return route.abort('failed')
    if (sc.off) return json(route, { error: { code: 'sports_unconfigured', reason: 'sports module is not enabled' } }, 503)
    const now = Date.now()
    return json(route, { serverNow: now, sources: sc.sources ?? { venue: { state: 'read', label: 'Polymarket' }, plays: { state: 'read', label: 'ESPN' } }, games: [sc.answer(now)] })
  })
  const page = await context.newPage()
  await page.addInitScript(({ theme, account }) => {
    window.localStorage.setItem('themeMode', theme)
    window.localStorage.setItem('dev_warning_banner_dismissed', 'true')
    window.localStorage.setItem('fairwins.entryGate.ack.v1', JSON.stringify({ terms: null, risk: null, at: new Date(0).toISOString() }))
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
          case 'wallet_switchEthereumChain': case 'wallet_addEthereumChain': return null
          default: return '0x'
        }
      },
    }
    window.ethereum = provider
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'c0ffee00-0000-4000-8000-000000000115', name: 'Capture Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'app.fairwins.capture' }, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { theme, account: ACCOUNT })
  return { page, context }
}

const REPORT = []
async function inspect(page, name) {
  await page.addScriptTag({ content: AXE })
  const res = await page.evaluate(async () => {
    const view = document.querySelector('.game-view')
    if (!view) return { present: false }
    const a = await window.axe.run(view, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] })
    const r = view.getBoundingClientRect()
    const clipped = Array.from(view.querySelectorAll('*')).filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible' && !(el instanceof SVGElement)).map((el) => el.className)
    return {
      present: true,
      violations: a.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
      pageOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      viewRightOverflow: r.right > window.innerWidth + 1,
      clipped,
      interactive: view.querySelectorAll('button,a[href],input,select,[tabindex]').length,
      chip: view.querySelector('[data-testid="game-trust-chip"]')?.textContent ?? null,
    }
  })
  REPORT.push({ name, ...res })
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
  for (const size of Object.keys(SIZES)) {
    for (const theme of ['light', 'dark']) {
      for (const sc of SCENARIOS) {
        if (!wanted(sc.id)) continue
        const name = `game-${sc.id}-${theme}-${size}`
        const { page, context } = await newPage(browser, { theme, size, sc })
        try {
          await page.goto(`${BASE}/wallet?tab=predict&event=${SLUG}`, { waitUntil: 'domcontentloaded' })
          await page.addStyleTag({ content: '.dev-warning-banner,.notification{display:none!important}' })
          await page.waitForSelector('.event-page h2', { timeout: 60_000 })
          if (sc.off) await page.waitForTimeout(1500)
          else await page.waitForSelector('.game-view', { timeout: 20_000 })
          await page.waitForTimeout(900)
          const box = await page.locator('.predict-panel').first().evaluate((el) => { const r = el.getBoundingClientRect(); return { y: Math.max(0, r.top + window.scrollY - 70), h: Math.min(r.height + 70, 1500) } })
          await page.screenshot({ path: `${OUT}/${name}-page.png`, fullPage: true, clip: { x: 0, y: box.y, width: SIZES[size].width, height: box.h } })
          if (!sc.off) await page.locator('.game-view').screenshot({ path: `${OUT}/${name}.png` })
          await inspect(page, name)
          console.log('  shot', name)
        } catch (e) {
          console.error('  FAILED', name, e.message.split('\n')[0])
          REPORT.push({ name, failed: e.message.split('\n')[0] })
        } finally { await context.close() }
      }
    }
  }
  await browser.close()
  writeFileSync(`${OUT}/report.json`, JSON.stringify(REPORT, null, 1))
  console.log(`\n${REPORT.length} states -> ${OUT}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
