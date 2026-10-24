/**
 * Visual capture harness for funding pools (spec 103) — the actor half of the actor-critic loop
 * (see .claude/skills/actor-critic-screens). Photographs the Request ▸ Pool form, the share view, the
 * pool page in its member-visible states (open as contributor, open as organizer with the close confirm,
 * refunding with a collectable balance, closed, unreadable), and the My Pools sheet. Final shots live in
 * `specs/103-funding-pools/screenshots/`.
 *
 * REAL DATA OVER POSED DATA: the pools are created and contributed to on the local Hardhat node
 * (`HARDHAT_LOCAL_CHAIN_ID=80002 npx hardhat node` + `npm run setup:e2e`), and the injected wallet
 * proxies every JSON-RPC request to that node, so the screenshots show the real surface reading real
 * state and signing with the node's unlocked accounts. Every non-loopback request is aborted.
 *
 * Usage:
 *   HARDHAT_LOCAL_CHAIN_ID=80002 npx hardhat node &      # terminal 1
 *   npm run setup:e2e                                    # once
 *   npm run dev:e2e --workspace frontend -- --port 5199  # terminal 2 (E2E_AMOY_LOCAL mapping → HARDHAT_CONTRACTS)
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-funding-pools.mjs [baseUrl]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const { ethers } = require('ethers')

const BASE = process.argv[2] || 'http://127.0.0.1:5199'
const RPC = process.env.RPC_URL || 'http://127.0.0.1:8545'
const OUT = resolve(process.cwd(), 'specs/103-funding-pools/screenshots')
const CHAIN_ID = 80002

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }

// Hardhat's unlocked accounts (the node signs eth_sendTransaction for them).
const ORGANIZER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const CONTRIBUTOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const CONTRIBUTOR_2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const KEYS = {
  [ORGANIZER.toLowerCase()]: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  [CONTRIBUTOR.toLowerCase()]: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  [CONTRIBUTOR_2.toLowerCase()]: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
}

function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  const dir = readdirSync(root).find((name) => /^chromium-\d+$/.test(name))
  if (!dir) return undefined
  const candidates = [join(root, dir, 'chrome-linux', 'chrome'), join(root, dir, 'chrome-linux64', 'chrome')]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

// ---- Chain fixtures (real pools on the local node) ---------------------------------------------
const FACTORY_ABI = [
  'function createPool((address token,uint256 goal,string purpose,uint64 contributeDeadline,uint64 settleDeadline) p) returns (uint256, address)',
  'event PoolCreated(uint256 indexed poolId, address indexed pool, address indexed organizer, uint32[4] wordIndices, address token, uint256 goal, string purpose, uint64 contributeDeadline, uint64 settleDeadline)',
]
const POOL_ABI = ['function contribute(uint256)', 'function cancel()', 'function close()', 'function voteRefund()']
const TOKEN_ABI = ['function approve(address,uint256) returns (bool)', 'function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)']

async function fixtures() {
  const provider = new ethers.JsonRpcProvider(RPC)
  const record = JSON.parse(readFileSync(resolve(process.cwd(), 'deployments/localhost-chain80002-v2.json'), 'utf8'))
  const factoryAddr = record.contracts.fundingPoolFactory
  const tokenAddr = record.paymentToken || record.contracts.paymentToken
  if (!factoryAddr || !tokenAddr) throw new Error('fundingPoolFactory / paymentToken missing from the local record — run setup:e2e')
  // NonceManager: Hardhat's automine can report a stale pending count right after a receipt, which
  // the plain Wallet turns into "nonce too low" on the next send (the cypress config manages nonces
  // by hand for the same reason).
  const managers = new Map()
  const wallet = (addr) => {
    const k = addr.toLowerCase()
    if (!managers.has(k)) managers.set(k, new ethers.NonceManager(new ethers.Wallet(KEYS[k], provider)))
    return managers.get(k)
  }
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider)
  const decimals = Number(await token.decimals())
  const amt = (n) => ethers.parseUnits(String(n), decimals)
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, wallet(ORGANIZER))
  const now = (await provider.getBlock('latest')).timestamp

  for (const a of [ORGANIZER, CONTRIBUTOR, CONTRIBUTOR_2]) {
    if ((await token.balanceOf(a)) < amt(1000)) {
      try { await (await token.connect(wallet(ORGANIZER)).mint(a, amt(10000))).wait() } catch { /* not mintable — rely on the seed */ }
    }
  }

  async function create(purpose, goal) {
    const rc = await (await factory.createPool({ token: tokenAddr, goal: amt(goal), purpose, contributeDeadline: now + 5 * 86400, settleDeadline: now + 35 * 86400 })).wait()
    const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l) } catch { return null } }).find((e) => e && e.name === 'PoolCreated')
    return ev.args.pool
  }
  async function contribute(pool, who, n) {
    const w = wallet(who)
    await (await token.connect(w).approve(pool, amt(n))).wait()
    await (await new ethers.Contract(pool, POOL_ABI, w).contribute(amt(n))).wait()
  }

  const open = await create("Dana's surprise party", 120)
  await contribute(open, CONTRIBUTOR, 40)
  await contribute(open, CONTRIBUTOR_2, 12.5)

  const refunding = await create('Ski cabin deposit', 400)
  await contribute(refunding, CONTRIBUTOR, 100)
  await contribute(refunding, CONTRIBUTOR_2, 60)
  await (await new ethers.Contract(refunding, POOL_ABI, wallet(CONTRIBUTOR)).voteRefund()).wait()
  await (await new ethers.Contract(refunding, POOL_ABI, wallet(CONTRIBUTOR_2)).voteRefund()).wait()

  const closed = await create('Office coffee machine', 80)
  await contribute(closed, CONTRIBUTOR, 80)
  await (await new ethers.Contract(closed, POOL_ABI, wallet(ORGANIZER)).close()).wait()

  const empty = await create('Team offsite — bus + lunch', 600)

  return { open, refunding, closed, empty, token: tokenAddr }
}

// ---- Shots ---------------------------------------------------------------------------------
function shots(fx) {
  return [
    { name: 'request-pool-form', path: '/app?kind=pool', account: ORGANIZER, wait: '[data-testid="funding-create-form"]', frame: '.home-screen', note: 'Request ▸ Pool: purpose, goal pad, window pills, public-purpose note, Create + My Pools' },
    { name: 'my-pools-sheet', path: '/app?kind=pool', account: CONTRIBUTOR, records: [fx.open, fx.refunding, fx.closed, fx.empty], wait: '[data-testid="funding-create-form"]', click: '[data-testid="my-pools-open"]', waitAfter: '[data-testid="my-pools-row"]', full: true, note: 'My Pools: active/finished rows with role, progress and the next action' },
    { name: 'pool-open-contributor', path: `/fund/${fx.open}`, account: CONTRIBUTOR, wait: '[data-testid="feed-entry"]', frame: '.fp-page', note: 'Open pool as a contributor: progress, contribute pad, vote, refund votes, share, feed' },
    { name: 'pool-open-organizer', path: `/fund/${fx.open}`, account: ORGANIZER, wait: '[data-testid="close-pool"]', frame: '.fp-page', note: 'Open pool as the organizer: Close & collect + Refund everyone' },
    { name: 'pool-close-confirm', path: `/fund/${fx.open}`, account: ORGANIZER, wait: '[data-testid="close-pool"]', click: '[data-testid="close-pool"]', waitAfter: '[data-testid="confirm-close"]', frame: '.fp-page', note: 'The close confirm: amount, destination, goal-not-met, finality' },
    { name: 'pool-empty', path: `/fund/${fx.empty}`, account: CONTRIBUTOR, wait: '[data-testid="feed-empty"]', frame: '.fp-page', note: 'A fresh pool: 0%, empty feed says what to do next' },
    { name: 'pool-refunding', path: `/fund/${fx.refunding}`, account: CONTRIBUTOR, wait: '[data-testid="claim-refund"]', frame: '.fp-page', note: 'Refunding by majority: collect button, collected-of-total bar, reason' },
    { name: 'pool-closed', path: `/fund/${fx.closed}`, account: CONTRIBUTOR, wait: '[data-testid="funding-closed"]', frame: '.fp-page', note: 'Closed: goal met chip, closed sentence, no controls, feed shows the close' },
    { name: 'pool-unreadable', path: '/fund/0x00000000000000000000000000000000000000AA', account: CONTRIBUTOR, wait: '[data-testid="funding-unreadable"], [data-testid="funding-not-found"]', frame: '.fp-page', note: 'A link the chain cannot answer: a sentence + retry, no bar, no zeros' },
  ]
}

function expand(list) {
  const out = []
  for (const shot of list) for (const viewport of [DESKTOP, MOBILE]) for (const theme of ['light', 'dark']) {
    out.push({ ...shot, name: `funding-${shot.name}-${viewport === MOBILE ? 'mobile' : 'desktop'}-${theme}`, theme, viewport })
  }
  return out
}

async function seedPage(page, shot) {
  await page.addInitScript(({ theme, account, chainId, rpc, records }) => {
    window.localStorage.setItem('themeMode', theme)
    // The My Pools sheet lists DEVICE-recorded pools (FR-023). The fixtures were created over RPC, so
    // seed the record the app itself would have written had this device organized/contributed.
    if (records && records.length) {
      window.localStorage.setItem(
        `fairwins_funding_pools_v1_${account.toLowerCase()}`,
        JSON.stringify(records.map((address, i) => ({ address: address.toLowerCase(), role: i === 3 ? 'organizer' : 'contributor' }))),
      )
    }
    window.localStorage.setItem('dev_warning_banner_dismissed', 'true')
    window.localStorage.setItem('fairwins.entryGate.ack.v1', JSON.stringify({ terms: null, risk: null, at: new Date(0).toISOString() }))
    const hex = `0x${chainId.toString(16)}`
    let id = 1
    // Every request — reads AND eth_sendTransaction — goes to the node, which signs for its unlocked accounts.
    const forward = async (method, params) => {
      const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params: params ?? [] }) })
      const json = await res.json()
      if (json.error) { const e = new Error(json.error.message); e.code = json.error.code; e.data = json.error.data; throw e }
      return json.result
    }
    const provider = {
      isMetaMask: true,
      selectedAddress: account,
      chainId: hex,
      _callbacks: {},
      on(event, cb) { (this._callbacks[event] = this._callbacks[event] || []).push(cb) },
      removeListener(event, cb) { this._callbacks[event] = (this._callbacks[event] || []).filter((f) => f !== cb) },
      async request({ method, params }) {
        switch (method) {
          case 'eth_accounts':
          case 'eth_requestAccounts':
            return [account]
          case 'eth_chainId':
            return hex
          case 'net_version':
            return String(chainId)
          case 'wallet_switchEthereumChain':
            return null
          case 'eth_sendTransaction': {
            const tx = { ...(params?.[0] || {}) }
            tx.from = account
            delete tx.gas
            delete tx.gasPrice
            delete tx.maxFeePerGas
            delete tx.maxPriorityFeePerGas
            return forward(method, [tx])
          }
          default:
            return forward(method, params)
        }
      },
    }
    window.ethereum = provider
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
      detail: Object.freeze({ info: { uuid: 'c0ffee00-0000-4000-8000-000000000102', name: 'Capture Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'app.fairwins.capture' }, provider }),
    }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { theme: shot.theme, account: shot.account, chainId: CHAIN_ID, rpc: RPC, records: shot.records || [] })
}

async function isolate(context, baseOrigin) {
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(baseOrigin) || url.startsWith(RPC) || url.startsWith('http://localhost:8545')) return route.continue()
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
    return route.abort()
  })
}

async function connectIfNeeded(page) {
  const connect = page.locator('.wallet-connect-button, button[aria-label="Connect Wallet"]')
  if (await connect.count()) {
    await connect.first().click()
    const opt = page.locator('.connect-modal__option:not(.unavailable)').filter({ hasText: /metamask|browser wallet|injected|capture/i })
    if (await opt.count()) await opt.first().click()
    await page.waitForSelector('.wallet-account-button, button[aria-label="Wallet Account"]', { timeout: 30_000 })
  }
}

async function captureOnce(browser, baseOrigin, shot) {
  const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2 })
  await isolate(context, baseOrigin)
  const page = await context.newPage()
  await seedPage(page, shot)
  try {
    await page.goto(`${BASE}${shot.path}`, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: '.dev-warning-banner, .notification, .staging-banner { display: none !important; }' })
    await connectIfNeeded(page)
    await page.waitForSelector(shot.wait, { timeout: 45_000 })
    if (shot.click) {
      await page.locator(shot.click).first().click()
      if (shot.waitAfter) await page.waitForSelector(shot.waitAfter, { timeout: 45_000 })
    }
    mkdirSync(OUT, { recursive: true })
    await page.waitForTimeout(500)
    if (shot.full || !shot.frame) {
      await page.screenshot({ path: join(OUT, `${shot.name}.png`) })
    } else {
      await page.locator(shot.frame).first().screenshot({ path: join(OUT, `${shot.name}.png`) })
    }
    console.log(`wrote ${shot.name}.png — ${shot.note}`)
  } finally {
    await context.close()
  }
}

async function main() {
  const baseOrigin = new URL(BASE).origin
  const fx = await fixtures()
  console.log('fixtures', fx)
  const browser = await chromium.launch({ executablePath: chromiumExecutable() })
  try {
    const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null
    for (const shot of expand(shots(fx))) {
      if (only && !only.test(shot.name)) continue
      try {
        await captureOnce(browser, baseOrigin, shot)
      } catch (error) {
        console.warn(`retrying ${shot.name}: ${String(error?.message ?? error).split('\n')[0]}`)
        await captureOnce(browser, baseOrigin, shot)
      }
    }
  } finally {
    await browser.close()
  }
}

await main()
