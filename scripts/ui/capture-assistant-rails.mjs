/**
 * Visual capture harness for the assistant rail surfaces (spec 104) — Tools ▸ Assistant, the
 * GutterToken key sheet, and the floating assistant panel. The "actor" half of the actor-critic
 * screenshot loop: it renders the REAL components in a real browser and writes PNGs for the critic
 * to read. Final shots live in `specs/104-guttertoken-assistant-rail/screenshots/`.
 *
 * Usage:
 *   npm run dev --workspace frontend -- --port 5199 --strictPort   # terminal 1 (VITE_RELAYER_URL
 *                                                                     set to the loopback gateway
 *                                                                     this script starts — see below)
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-assistant-rails.mjs
 *
 * Playwright is resolved from wherever the operator installed it, NEVER from a workspace manifest
 * (spec 075). Chromium ships at /opt/pw-browsers; CHROMIUM_PATH overrides.
 *
 * THREE LOOPBACK STUBS, all local:
 *
 *   the wallet     an EIP-1193 provider (account 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
 *                  Hardhat's well-known account #0) whose `eth_signTypedData_v4` is bridged to Node
 *                  via `exposeFunction` and answered with a REAL ethers EIP-712 signature — the
 *                  24-hour read grant in the tool-round shot is one the gateway would actually
 *                  accept, not a hand-painted string.
 *   the membership chain   a loopback JSON-RPC server reached through the spec-069 member endpoint
 *                  override, answering `getMembership(address,bytes32)` (selector 0x91f9dd2a) with
 *                  the same hand-encoded 5-word tuple `frontend/cypress/e2e/fast/47-assistant-rails.cy.js`
 *                  uses, so the app's real `useRoleDetails` read produces each of the three
 *                  membership states on demand.
 *   the relay-gateway   a loopback HTTP server the dev server's `VITE_RELAYER_URL` points at,
 *                  answering `/status` and `/v1/member/wagers` for the client-side tool loop.
 *
 * GutterToken itself (`https://api.guttertokens.com/...`) is intercepted via `context.route` and
 * FULFILLED (never let through) — a real third party that bills a real balance must never be reached
 * by a screenshot run.
 *
 * Every other non-loopback request is aborted, so a shot can never quietly depend on the internet.
 *
 * ONE STATE — the panel's `choose` step for a non-member with no key — is not reachable by
 * navigating the real app: the floating launcher's own gate (`AssistantLauncher.jsx`) never renders
 * an entry point when nothing can answer, by design (spec 104 FR-004). That shot is captured by a
 * SEPARATE small harness (`captureChooserShots`, below) that mounts `AssistantPanel` directly with a
 * controlled `membership` prop, behind a temporary Vite alias of `useWalletManagement` — the same
 * technique `scripts/ui/capture-agentic-access.mjs` uses, trimmed to the one component under review.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Wallet } from 'ethers'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const FRONTEND = join(REPO, 'frontend')
const BASE = process.env.HARNESS_BASE || 'http://127.0.0.1:5199'
const OUT = resolve(REPO, 'specs/104-guttertoken-assistant-rail/screenshots')

const RPC_PORT = 9821
const RPC_ORIGIN = `http://127.0.0.1:${RPC_PORT}`
const GATEWAY_PORT = 9822
const GATEWAY_ORIGIN = `http://127.0.0.1:${GATEWAY_PORT}`
const REFERENCE_CHAIN_ID = 137
const WALLET_CHAIN_ID = 1337

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }

/** Hardhat's well-known account #0 — a throwaway key that signs nothing but harness fixtures. */
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const wallet = new Wallet(PRIVATE_KEY)

/** A key `validateGutterTokenKeyFormat` accepts; redacts to `sk-…wxyz`. Never sent anywhere real. */
const RAW_KEY = 'sk-capture0000000000wxyz'
const GT_MESSAGES_URL = 'https://api.guttertokens.com/v1/messages'
const GT_BILLING_URL = 'https://app.guttertokens.com/billing'

function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  const dir = readdirSync(root).find((name) => /^chromium-\d+$/.test(name))
  if (!dir) return undefined
  const candidates = [join(root, dir, 'chrome-linux', 'chrome'), join(root, dir, 'chrome-linux64', 'chrome')]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

// ---- stub membership chain ------------------------------------------------------------------------

/**
 * `membershipMode` decides what `getMembership` answers, which is what separates the three states
 * the Assistant tab and panel are built around:
 *   'active'      Gold tier, expiring in 2100 — a paid member
 *   'none'        tier 0, no expiry — a connected account with no membership
 *   'unreadable'  every RPC call fails — the reference chain would not answer
 */
let membershipMode = 'active'

const GET_MEMBERSHIP_SELECTOR = '0x91f9dd2a'
const word = (value) => BigInt(value).toString(16).padStart(64, '0')
const encodeMembership = ({ tier, expiresAt, monthCount = 0, activeCount = 0, monthAnchor = 0 }) =>
  `0x${word(tier)}${word(expiresAt)}${word(monthCount)}${word(activeCount)}${word(monthAnchor)}`

const ACTIVE_MEMBERSHIP = encodeMembership({ tier: 3, expiresAt: 4102444800 })
const NO_MEMBERSHIP = encodeMembership({ tier: 0, expiresAt: 0 })

function answerRpc(method, params) {
  switch (method) {
    case 'eth_chainId':
      return `0x${REFERENCE_CHAIN_ID.toString(16)}`
    case 'net_version':
      return String(REFERENCE_CHAIN_ID)
    case 'eth_blockNumber':
      return '0x4000000'
    case 'eth_getCode':
      return '0x60806040'
    case 'eth_call':
      return String(params?.[0]?.data || '').slice(0, 10) === GET_MEMBERSHIP_SELECTOR
        ? (membershipMode === 'active' ? ACTIVE_MEMBERSHIP : NO_MEMBERSHIP)
        : '0x'
    default:
      return '0x'
  }
}

function startRpcStub() {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'POST,OPTIONS',
        })
        return res.end()
      }
      if (membershipMode === 'unreadable') {
        // Every call fails — mirrors `useRoleDetails`'s catch branch (`readable: false`), which is
        // the honest "the reference chain would not answer" fact, never "tier 0".
        const one = (call) => ({ jsonrpc: '2.0', id: call?.id ?? 1, error: { code: -32000, message: 'reference chain unreachable' } })
        let payload
        try {
          payload = JSON.parse(body)
        } catch {
          payload = {}
        }
        const out = Array.isArray(payload) ? payload.map(one) : one(payload)
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        return res.end(JSON.stringify(out))
      }
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        res.writeHead(400)
        return res.end('bad json')
      }
      // ethers v6 batches concurrent calls on chains outside NO_BATCH_CHAIN_IDS, and Polygon is not
      // one of them — answering a batch with a single object makes every read fail.
      const one = (call) => ({ jsonrpc: '2.0', id: call?.id ?? 1, result: answerRpc(call?.method, call?.params) })
      const out = Array.isArray(payload) ? payload.map(one) : one(payload)
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(out))
    })
  })
  return new Promise((ok) => server.listen(RPC_PORT, '127.0.0.1', () => ok(server)))
}

// ---- stub relay-gateway (VITE_RELAYER_URL) --------------------------------------------------------

/**
 * Only the two routes the tool-round shot exercises. `wagersMode` separates the honest failure
 * (an indexer that would not answer) from the honest read, so the Sources line can show both chip
 * states side by side — exactly what `47-assistant-rails.cy.js` [GT-06] asserts.
 */
let wagersMode = 'unreadable'

function startGatewayStub() {
  const server = createServer((req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }
    const url = new URL(req.url, GATEWAY_ORIGIN)
    if (url.pathname === '/status') {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ status: 'ok', modules: { memberApi: true } }))
    }
    if (url.pathname === '/v1/member/wagers') {
      if (wagersMode === 'unreadable') {
        res.writeHead(503, { ...cors, 'content-type': 'application/json' })
        return res.end(JSON.stringify({ error: { code: 'indexer_unreadable', reason: 'the Polygon indexer did not answer' } }))
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ chains: { 137: { state: 'read', wagers: [] } } }))
    }
    res.writeHead(404, cors)
    res.end('{}')
  })
  return new Promise((ok) => server.listen(GATEWAY_PORT, '127.0.0.1', () => ok(server)))
}

// ---- GutterToken turn stubbing (Playwright route, per-context) -------------------------------------

/** The Anthropic-shaped text reply body `providers/guttertoken.js` reads. */
const gtText = (text, extra = {}) => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    model: 'claude-opus-5',
    usage: { input_tokens: 120, output_tokens: 45 },
    ...extra,
  }),
})

const gtToolUse = () => ({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({
    content: [
      { type: 'tool_use', id: 'toolu_wagers', name: 'get_wagers', input: {} },
      { type: 'tool_use', id: 'toolu_status', name: 'get_gateway_status', input: {} },
    ],
    stop_reason: 'tool_use',
    model: 'claude-opus-5',
    usage: { input_tokens: 200, output_tokens: 40 },
  }),
})

const gtError = (status, type) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify({ error: { type } }),
})

/** Register the GutterToken messages intercept for one context; each call in order, last repeats. */
async function stubGutterTokenTurns(context, responses) {
  let call = 0
  await context.route(GT_MESSAGES_URL, (route) => {
    const answer = responses[Math.min(call, responses.length - 1)]
    call += 1
    route.fulfill(answer)
  })
}

// ---- page seeding ----------------------------------------------------------------------------------

async function seedWallet(page) {
  // The bridge: the page asks, Node signs with the real key — a REAL EIP-712 signature over the
  // grant the panel actually builds, so the 24-hour read grant in the tool-round shot is one the
  // gateway would accept.
  await page.exposeFunction('__fwSignTyped', async (payload) => {
    const { domain, types, message } = JSON.parse(payload)
    const clean = { ...types }
    delete clean.EIP712Domain
    return wallet.signTypedData(domain, clean, message)
  })

  await page.addInitScript(
    ({ account, chainIdHex, chainId }) => {
      const provider = {
        isMetaMask: true,
        selectedAddress: account,
        chainId: chainIdHex,
        _callbacks: {},
        on(event, cb) {
          ;(this._callbacks[event] = this._callbacks[event] || []).push(cb)
        },
        removeListener(event, cb) {
          this._callbacks[event] = (this._callbacks[event] || []).filter((f) => f !== cb)
        },
        request({ method, params }) {
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return Promise.resolve([account])
            case 'eth_chainId':
              return Promise.resolve(chainIdHex)
            case 'net_version':
              return Promise.resolve(String(chainId))
            case 'eth_blockNumber':
              return Promise.resolve('0x1')
            case 'eth_getBalance':
              return Promise.resolve('0xde0b6b3a7640000')
            case 'eth_getCode':
              return Promise.resolve('0x')
            case 'eth_signTypedData_v4':
              return window.__fwSignTyped(params[1])
            case 'eth_call':
            case 'eth_estimateGas':
              return Promise.resolve('0x')
            default:
              return Promise.resolve(null)
          }
        },
      }
      window.ethereum = provider
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({
              info: {
                uuid: 'c0ffee00-0000-4000-8000-000000000104',
                name: 'Capture Wallet',
                icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
                rdns: 'app.fairwins.capture',
              },
              provider,
            }),
          }),
        )
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    { account: ACCOUNT.toLowerCase(), chainIdHex: `0x${WALLET_CHAIN_ID.toString(16)}`, chainId: WALLET_CHAIN_ID },
  )
}

/** Wallet-scoped storage the assistant surfaces read, per `utils/userStorage.js`. */
function seedStorage({ theme, prefs, key }) {
  const lower = ACCOUNT.toLowerCase()
  return {
    theme,
    dismissAck: true,
    prefix: `fw_user_${lower}_`,
    prefs,
    key,
    chainId: REFERENCE_CHAIN_ID,
    rpcOrigin: RPC_ORIGIN,
  }
}

async function applySeed(page, seed) {
  await page.addInitScript((s) => {
    window.localStorage.setItem('themeMode', s.theme)
    window.localStorage.setItem('dev_warning_banner_dismissed', 'true')
    window.localStorage.setItem(
      'fairwins.entryGate.ack.v1',
      JSON.stringify({ terms: null, risk: null, at: new Date(0).toISOString() }),
    )
    // The member's own RPC route (spec 069) — the ONLY supported way to point the membership read
    // at the stub chain.
    window.localStorage.setItem(
      'fw_global_prefs',
      JSON.stringify({ network_endpoints: { [s.chainId]: { url: s.rpcOrigin, failoverUrl: `${s.rpcOrigin}/failover` } } }),
    )
    window.localStorage.setItem(`${s.prefix}assistant_prefs`, JSON.stringify(s.prefs))
    if (s.key) {
      window.localStorage.setItem(`${s.prefix}assistant_guttertoken_key_v1`, JSON.stringify(s.key))
    }
  }, seed)
}

/** Nothing may leave this machine, except the two GutterToken endpoints an individual shot fulfills. */
async function isolate(context) {
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(BASE) || url.startsWith(RPC_ORIGIN) || url.startsWith(GATEWAY_ORIGIN)) return route.continue()
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
    return route.abort()
  })
}

// ---- shot matrix ------------------------------------------------------------------------------------

const TAB_TARGET = '[data-testid="assistant-tools-panel"]'

const SCENARIOS = [
  {
    name: 'tab-member-key-guttertoken',
    membership: 'active',
    key: RAW_KEY,
    prefs: { enabled: true, retainMemory: true, provider: 'guttertoken' },
    hash: 'assistant-prefs',
    target: TAB_TARGET,
    waitFor: async (page) => {
      await page.waitForSelector('[data-testid="assistant-provider-effective"]', { timeout: 20_000 })
    },
    note: 'Assistant tab, paid member with a saved key, GutterToken selected — both radios live, the effective line names GutterToken, the key card summary shows the redaction',
  },
  {
    name: 'tab-nonmember-nokey',
    membership: 'none',
    key: null,
    prefs: { enabled: true, retainMemory: true, provider: 'fairwins' },
    hash: 'assistant-prefs',
    target: TAB_TARGET,
    waitFor: async (page) => {
      await page.waitForSelector('[data-testid="assistant-provider-fairwins-reason"]', { timeout: 20_000 })
      await page.waitForSelector('[data-testid="assistant-provider-guttertoken-reason"]', { timeout: 20_000 })
    },
    note: 'Non-member, no key — FairWins disabled with "requires an active membership", GutterToken disabled with "add a GutterToken key below"',
  },
  {
    name: 'tab-membership-unreadable',
    membership: 'unreadable',
    key: null,
    prefs: { enabled: true, retainMemory: true, provider: 'fairwins' },
    hash: 'assistant-prefs',
    target: TAB_TARGET,
    waitFor: async (page) => {
      await page.waitForSelector('[data-testid="assistant-provider-fairwins-reason"]', { timeout: 20_000 })
    },
    assertText: { selector: '[data-testid="assistant-provider-fairwins-reason"]', contains: 'could not be read' },
    note: 'Membership unreadable — the FairWins option stays OFFERED with the reason, never hidden or denied',
  },
  {
    name: 'keysheet-empty',
    membership: 'none',
    key: null,
    prefs: { enabled: true, retainMemory: true, provider: 'guttertoken' },
    hash: 'guttertoken-key',
    fullViewport: true,
    act: async (page) => {
      await page.locator('[data-testid="guttertoken-key-add"]').scrollIntoViewIfNeeded()
      await page.locator('[data-testid="guttertoken-key-add"]').click()
      await page.waitForSelector('[data-testid="guttertoken-key-sheet"]', { timeout: 20_000 })
    },
    note: 'Key sheet open, nothing pasted yet — the lead copy that says what the key authorises before the paste field',
  },
  {
    name: 'keysheet-invalid-format',
    membership: 'none',
    key: null,
    prefs: { enabled: true, retainMemory: true, provider: 'guttertoken' },
    hash: 'guttertoken-key',
    fullViewport: true,
    act: async (page) => {
      await page.locator('[data-testid="guttertoken-key-add"]').scrollIntoViewIfNeeded()
      await page.locator('[data-testid="guttertoken-key-add"]').click()
      await page.waitForSelector('[data-testid="guttertoken-key-sheet"]', { timeout: 20_000 })
      await page.locator('[data-testid="guttertoken-key-input"]').fill('not-a-real-key')
      await page.waitForSelector('[data-testid="guttertoken-key-format-error"]', { timeout: 10_000 })
    },
    note: 'Key sheet, an invalid paste — the inline format error, live as the member types',
  },
  {
    name: 'panel-guttertoken-tool-round',
    membership: 'active',
    key: RAW_KEY,
    prefs: { enabled: true, retainMemory: true, provider: 'guttertoken' },
    hash: null,
    fullViewport: true,
    gutterToken: [gtToolUse(), gtText('Your wagers could not be read just now; the service itself is up.')],
    wagersMode: 'unreadable',
    act: async (page) => {
      await page.locator('[data-testid="assistant-launcher"]').click()
      await page.waitForSelector('.assistant-sheet[role="dialog"]', { timeout: 20_000 })
      await page.waitForSelector('[data-testid="assistant-grant-offer"]', { timeout: 20_000 })
      await page.locator('[data-testid="assistant-grant-offer-sign"]').click()
      await page.waitForSelector('[data-testid="assistant-grant-offer"]', { state: 'detached', timeout: 20_000 })
      await page.locator('#assistant-input').fill('do I have any open wagers')
      await page.getByRole('button', { name: /^Send$/ }).click()
      await page.waitForSelector('[data-testid="assistant-tool-result"]', { timeout: 30_000 })
      await page.waitForSelector('.assistant-panel__message--assistant', { timeout: 20_000 })
    },
    note: 'Panel on the GutterToken rail after a tool round: the provider badge, both Sources chips (one read, one could-not-be-read), the completed reply and its per-reply disclaimer',
  },
  {
    name: 'panel-out-of-credit',
    membership: 'none',
    key: RAW_KEY,
    prefs: { enabled: true, retainMemory: false, provider: 'guttertoken' },
    hash: null,
    fullViewport: true,
    gutterToken: [gtError(403, 'insufficient_quota')],
    act: async (page) => {
      await page.locator('[data-testid="assistant-launcher"]').click()
      await page.waitForSelector('.assistant-sheet[role="dialog"]', { timeout: 20_000 })
      await page.locator('#assistant-input').fill('what do I owe')
      await page.getByRole('button', { name: /^Send$/ }).click()
      await page.waitForSelector('[data-testid="assistant-error"]', { timeout: 20_000 })
    },
    note: 'GutterToken balance empty — a named sentence, a top-up link and a retry, never an assistant bubble',
  },
  {
    name: 'launcher-over-home',
    membership: 'active',
    key: RAW_KEY,
    prefs: { enabled: true, retainMemory: true, provider: 'guttertoken' },
    path: '/app',
    fullViewport: true,
    act: async (page) => {
      await page.waitForSelector('[data-testid="assistant-launcher"]', { timeout: 40_000 })
      await page.waitForTimeout(500)
    },
    note: 'The floating launcher over the wallet home, tethered above the real bottom nav',
  },
]

async function gotoAndSuppress(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: '.dev-warning-banner, .notification { display: none !important; }' })
  const connectClose = page.locator('.connect-modal__close')
  if (await connectClose.count()) await connectClose.first().click()
}

async function captureOnce(browser, shot, viewportLabel, viewport, theme) {
  membershipMode = shot.membership
  wagersMode = shot.wagersMode || 'unreadable'
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  await isolate(context)
  if (shot.gutterToken) await stubGutterTokenTurns(context, shot.gutterToken)
  const page = await context.newPage()
  page.on('pageerror', (err) => console.error(`[pageerror] ${shot.name}: ${err.message}`))
  await seedWallet(page)
  await applySeed(page, seedStorage({ theme, prefs: shot.prefs, key: shot.key ? { v: 1, key: shot.key, savedAt: 1750000000000 } : null }))

  try {
    const path = shot.path || `/wallet?tab=assistant${shot.hash ? `#${shot.hash}` : ''}`
    await gotoAndSuppress(page, path)

    if (shot.hash) {
      await page.waitForSelector(`[data-attention="${shot.hash}"][data-open="true"]`, { timeout: 40_000 })
    } else if (!shot.path) {
      await page.waitForSelector(TAB_TARGET, { timeout: 40_000 })
    }

    if (shot.waitFor) await shot.waitFor(page)
    if (shot.act) await shot.act(page)
    if (shot.assertText) {
      const text = await page.locator(shot.assertText.selector).innerText()
      if (!text.includes(shot.assertText.contains)) {
        throw new Error(`${shot.name}: expected "${shot.assertText.contains}" in "${text}"`)
      }
    }

    await page.waitForTimeout(350) // sheet/accordion transitions settle
    mkdirSync(OUT, { recursive: true })
    const file = join(OUT, `${shot.name}-${viewportLabel}-${theme}.png`)
    if (shot.fullViewport || !shot.target) {
      await page.screenshot({ path: file })
    } else {
      // An ELEMENT screenshot taller than the viewport is stitched from several scrolled tiles, and
      // any `position: sticky`/`fixed` chrome (the sticky `.site-header`, the fixed mobile
      // `.section-icon-nav`) repaints at the same screen coordinates in every tile — Playwright then
      // composites it into the final PNG once per tile, so it appears to "ghost" over the card
      // content partway down a tall mobile card. That is a capture-stitching artifact, not something
      // a member ever sees (a real scroll moves sticky/fixed chrome exactly once), so it is hidden
      // here rather than "fixed" in the component.
      await page.addStyleTag({ content: '.site-header, .section-icon-nav { display: none !important; }' })
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.bottom > window.innerHeight) window.scrollBy(0, Math.ceil(rect.bottom - window.innerHeight) + 8)
      }, shot.target)
      await page.waitForTimeout(150)
      await page.locator(shot.target).screenshot({ path: file })
    }
    console.log(`wrote ${file.replace(REPO + '/', '')} — ${shot.note}`)
  } finally {
    await context.close()
  }
}

async function runMainMatrix(browser) {
  for (const theme of ['light', 'dark']) {
    for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
      for (const shot of SCENARIOS) {
        try {
          await captureOnce(browser, shot, label, viewport, theme)
        } catch (error) {
          console.warn(`retrying ${shot.name}-${label}-${theme}: ${String(error?.message ?? error).split('\n')[0]}`)
          await captureOnce(browser, shot, label, viewport, theme)
        }
      }
    }
  }
}

// ---- the chooser shot: mounted directly, behind a temporary Vite alias -----------------------------
//
// `AssistantPanel`'s `step === 'choose'` (add a key, or become a member) is real, member-facing UI —
// but the floating launcher that is its only real-app entry point never renders when nothing can
// answer (spec 104 FR-004: no key, no active membership ⇒ no button). So this state is captured by
// mounting the component directly, exactly `capture-agentic-access.mjs`'s technique: a temporary Vite
// config aliases `hooks/useWalletManagement` to a static stub (identity only — this shot never signs
// anything), and a temporary harness page renders `<AssistantPanel open membership={...} />` with the
// real component, its real CSS, and a real `ActionSheet` shell.

const CHOOSER_PORT = 5198
const CHOOSER_BASE = `http://127.0.0.1:${CHOOSER_PORT}`

const CHOOSER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Assistant chooser harness</title></head><body><div id="root"></div>
<script type="module" src="/src/dev/__assistantChooserHarness.jsx"></script></body></html>
`

const CHOOSER_STUB_WALLET = `/* Written by capture-assistant-rails.mjs; deleted on exit. Identity only — the chooser step
   never signs anything, so no bridged signer is needed here. */
const ACCOUNT = '${ACCOUNT}'
const wallet = { address: ACCOUNT, account: ACCOUNT, isConnected: true, loginMethod: 'injected', chainId: 137, signer: null, provider: null, balances: {}, hasRole: () => false }
export const useWallet = () => wallet
export const useWalletAddress = () => ({ address: ACCOUNT, account: ACCOUNT, isConnected: true })
export default useWallet
`

const CHOOSER_CONFIG = `import { mergeConfig } from 'vite'
import base from './vite.config.js'
export default async (env) => {
  const resolved = typeof base === 'function' ? await base(env) : base
  return mergeConfig(resolved, {
    resolve: { alias: [{ find: /^.*hooks\\/useWalletManagement$/, replacement: '/src/dev/__chooserStubWallet.js' }] },
  })
}
`

const CHOOSER_PAGE = `/* Written by capture-assistant-rails.mjs; deleted when it exits. */
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { ThemeProvider } from '../contexts/ThemeContext.jsx'
import AssistantPanel from '../components/assistant/AssistantPanel'
import '../theme.css'
import '../index.css'
import '../App.css'

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const params = new URLSearchParams(window.location.search)
window.localStorage.setItem('themeMode', params.get('theme') || 'light')
// Enabled, default (FairWins) preference, no key: resolveProvider yields reason 'not-member' for
// this inactive membership, which is what puts the panel on its 'choose' step.
window.localStorage.setItem(
  \`fw_user_\${ACCOUNT.toLowerCase()}_assistant_prefs\`,
  JSON.stringify({ enabled: true, retainMemory: true, provider: 'fairwins' }),
)

function Root() {
  const [open] = useState(true)
  return (
    <AssistantPanel
      open={open}
      onClose={() => {}}
      membership={{ isActive: false, readable: true }}
    />
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <MemoryRouter initialEntries={['/wallet?tab=assistant']}>
        <Root />
      </MemoryRouter>
    </ThemeProvider>
  </StrictMode>,
)
`

const CHOOSER_FILES = [
  [join(FRONTEND, 'assistant-chooser-harness.html'), CHOOSER_HTML],
  [join(FRONTEND, 'vite.assistant-chooser.config.js'), CHOOSER_CONFIG],
  [join(FRONTEND, 'src/dev/__assistantChooserHarness.jsx'), CHOOSER_PAGE],
  [join(FRONTEND, 'src/dev/__chooserStubWallet.js'), CHOOSER_STUB_WALLET],
]

function writeChooserFiles() {
  mkdirSync(join(FRONTEND, 'src/dev'), { recursive: true })
  for (const [path, body] of CHOOSER_FILES) writeFileSync(path, body)
}
function removeChooserFiles() {
  for (const [path] of CHOOSER_FILES) rmSync(path, { force: true })
}

async function waitForServer(base, path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}${path}`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`harness server never came up on ${base}`)
}

async function captureChooserShots(browser) {
  writeChooserFiles()
  // The vite binary directly, not `npx vite` — npx spawns vite as a GRANDCHILD process, and killing
  // the npx wrapper in `finally` below leaves that grandchild orphaned on the port (round 1's bug:
  // the chooser server outlived the run and the next invocation of this script had nothing to bind).
  const viteBin = join(REPO, 'node_modules/.bin/vite')
  const server = spawn(
    viteBin,
    ['--config', 'vite.assistant-chooser.config.js', '--port', String(CHOOSER_PORT), '--strictPort'],
    { cwd: FRONTEND, stdio: 'ignore' },
  )
  try {
    await waitForServer(CHOOSER_BASE, '/assistant-chooser-harness.html')
    for (const theme of ['light', 'dark']) {
      for (const [label, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 2 })
        await context.route('**/*', (route) => {
          const url = route.request().url()
          if (url.startsWith(CHOOSER_BASE) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
          return route.abort()
        })
        const page = await context.newPage()
        page.on('pageerror', (err) => console.error(`[pageerror] panel-chooser-nonmember-nokey: ${err.message}`))
        try {
          await page.goto(`${CHOOSER_BASE}/assistant-chooser-harness.html?theme=${theme}`, { waitUntil: 'domcontentloaded' })
          await page.waitForSelector('[data-testid="assistant-choose"]', { timeout: 20_000 })
          await page.waitForTimeout(300)
          const file = join(OUT, `panel-chooser-nonmember-nokey-${label}-${theme}.png`)
          await page.screenshot({ path: file })
          console.log(`wrote ${file.replace(REPO + '/', '')} — non-member, no key: the chooser step (add a key, or become a member)`)
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    server.kill()
    removeChooserFiles()
  }
}

// ---- run --------------------------------------------------------------------------------------------

async function main() {
  const rpc = await startRpcStub()
  const gateway = await startGatewayStub()
  const browser = await chromium.launch({ executablePath: chromiumExecutable() })
  try {
    mkdirSync(OUT, { recursive: true })
    await runMainMatrix(browser)
    await captureChooserShots(browser)
  } finally {
    await browser.close()
    rpc.close()
    gateway.close()
  }
}

await main()
