/**
 * Visual capture harness for spec 102 (one vault, every network) — the actor half of the
 * actor-critic loop (see .claude/skills/actor-critic-screens). Photographs the compact vault cards
 * in Protect ▸ On chain, the vault sheet's three views (Queue with its chain log, Style, Details),
 * the load-all confirmation copy, and the Wrap form's balance tile. Final shots + findings live in
 * `specs/102-multisig-chain-abstraction/screenshots/`.
 *
 * Usage:
 *   npm run dev --workspace frontend -- --port 5199 --strictPort     # terminal 1
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-vault-sheet.mjs [baseUrl]
 *
 * Real data over posed data: the vault is seeded through the app's own reference store, and TWO
 * loopback stub chains (Polygon 137 + Base 8453, reached through the spec-069 member RPC override)
 * answer the Safe/hub reads the queue actually performs — owners, threshold, nonce, approvedHashes,
 * the hub's `Proposed` logs with VERIFIABLE safeTxHashes, and empty execution outcomes. The
 * connected wallet sits on Polygon; Base is read through its own provider, which is the whole
 * point. Optimism (10) is deliberately NOT stubbed so the "could not be read" state is honest.
 * Every non-loopback request is aborted.
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
// ethers from the repo's own workspace install (never a harness dependency).
const { Interface, TypedDataEncoder, AbiCoder, getAddress, zeroPadValue, keccak256, toUtf8Bytes } = createRequire(
  resolve(process.cwd(), 'package.json'),
)('ethers')

const BASE = process.argv[2] || 'http://127.0.0.1:5199'
const OUT = resolve(process.cwd(), 'specs/102-multisig-chain-abstraction/screenshots')

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }

const ACCOUNT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const OWNER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const OWNER_C = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const VAULT = '0xcf76db7aa9fb1bFE08e010468F3344bB458abCDe'
const OTHER_VAULT = '0x8Cc5000000000000000000000000000000000000'
const HUB = '0x94b5b38C247CE51F7C42C83B63115998b7e970E7'
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

// chainId → { port, headBlock (just past the recorded hub deploy block so the scan is one chunk),
// nonce, proposals }
const CHAINS = {
  137: { port: 9811, head: 90120743 + 40, nonce: 5, version: '1.4.1' },
  8453: { port: 9812, head: 49158472 + 40, nonce: 2, version: '1.4.1' },
}
const WALLET_CHAIN = 137
// Optimism is listed as a vault instance but has no stub: an honest "could not be read".
const UNSTUBBED_CHAIN = 10

const SAFE_IFACE = new Interface([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function isOwner(address owner) view returns (bool)',
  'function VERSION() view returns (string)',
  'function approvedHashes(address owner, bytes32 hash) view returns (uint256)',
])
const HUB_IFACE = new Interface([
  'event Proposed(address indexed safe, address indexed proposer, bytes32 indexed safeTxHash, address to, uint256 value, bytes data, uint8 operation, uint256 nonce)',
])
const SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
}
const ZERO = '0x0000000000000000000000000000000000000000'
const OWNERS = [getAddress(ACCOUNT), OWNER_B, OWNER_C]
const THRESHOLD = 2

function safeTx({ to, value = 0n, data = '0x', nonce }) {
  return { to, value, data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce }
}
function txHash(chainId, tx) {
  return TypedDataEncoder.hash({ chainId, verifyingContract: getAddress(VAULT) }, SAFE_TX_TYPES, tx)
}

// Pending work per chain. Polygon: one at the current nonce with the member's approval already
// recorded (READY once a second owner signs), one queued behind it. Base: one at its nonce, no
// approvals yet (the member is an owner there too).
const ERC20_TRANSFER = new Interface(['function transfer(address to, uint256 amount)'])
const PROPOSALS = {
  137: [
    { tx: safeTx({ to: OWNER_B, value: 1_500_000_000_000_000_000n, nonce: 5 }), approvers: [getAddress(ACCOUNT)], block: 90120743 + 12 },
    {
      tx: safeTx({ to: USDC_POLYGON, data: ERC20_TRANSFER.encodeFunctionData('transfer', [OWNER_C, 250_000_000n]), nonce: 6 }),
      approvers: [],
      block: 90120743 + 20,
    },
  ],
  8453: [{ tx: safeTx({ to: OWNER_C, value: 40_000_000_000_000_000n, nonce: 2 }), approvers: [], block: 49158472 + 9 }],
}
for (const [chainId, list] of Object.entries(PROPOSALS)) {
  for (const p of list) p.hash = txHash(Number(chainId), p.tx)
}

function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  const dir = readdirSync(root).find((name) => /^chromium-\d+$/.test(name))
  if (!dir) return undefined
  const candidates = [join(root, dir, 'chrome-linux', 'chrome'), join(root, dir, 'chrome-linux64', 'chrome')]
  return candidates.find((p) => existsSync(p)) ?? candidates[0]
}

const hex = (n) => `0x${BigInt(n).toString(16)}`
const lower = (s) => String(s || '').toLowerCase()
const PROPOSED_TOPIC = HUB_IFACE.getEvent('Proposed').topicHash

function proposedLog(chainId, p) {
  const { data, topics } = HUB_IFACE.encodeEventLog('Proposed', [
    getAddress(VAULT),
    getAddress(ACCOUNT),
    p.hash,
    p.tx.to,
    p.tx.value,
    p.tx.data,
    p.tx.operation,
    p.tx.nonce,
  ])
  return {
    address: HUB,
    topics,
    data,
    blockNumber: hex(p.block),
    blockHash: keccak256(toUtf8Bytes(`block-${chainId}-${p.block}`)),
    transactionHash: keccak256(toUtf8Bytes(`tx-${chainId}-${p.hash}`)),
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  }
}

const ERC20_IFACE = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'])

function ethCall(chainId, call) {
  const to = lower(call?.to)
  const data = call?.data || '0x'
  const selector = data.slice(0, 10)
  if (to !== lower(VAULT) && to !== lower(OTHER_VAULT)) {
    // Any token contract: a plausible ERC-20 answer, so the Wrap tiles show READ balances rather
    // than "—" (a placeholder would hide a broken read, critic rule 2).
    if (selector === ERC20_IFACE.getFunction('balanceOf').selector) return ERC20_IFACE.encodeFunctionResult('balanceOf', [1_250_000_000_000_000_000n])
    if (selector === ERC20_IFACE.getFunction('decimals').selector) return ERC20_IFACE.encodeFunctionResult('decimals', [18])
    return '0x'
  }
  const fn = SAFE_IFACE.fragments.find((f) => f.type === 'function' && SAFE_IFACE.getFunction(f.name).selector === selector)
  if (!fn) return '0x'
  const cfg = CHAINS[chainId]
  const isOther = to === lower(OTHER_VAULT)
  switch (fn.name) {
    case 'getOwners':
      return SAFE_IFACE.encodeFunctionResult('getOwners', [isOther ? [OWNER_B, OWNER_C] : OWNERS])
    case 'getThreshold':
      return SAFE_IFACE.encodeFunctionResult('getThreshold', [isOther ? 2n : BigInt(THRESHOLD)])
    case 'nonce':
      return SAFE_IFACE.encodeFunctionResult('nonce', [BigInt(isOther ? 0 : cfg.nonce)])
    case 'VERSION':
      return SAFE_IFACE.encodeFunctionResult('VERSION', [cfg.version])
    case 'isOwner': {
      const [owner] = SAFE_IFACE.decodeFunctionData('isOwner', data)
      return SAFE_IFACE.encodeFunctionResult('isOwner', [OWNERS.map(lower).includes(lower(owner))])
    }
    case 'approvedHashes': {
      const [owner, hash] = SAFE_IFACE.decodeFunctionData('approvedHashes', data)
      const p = (PROPOSALS[chainId] || []).find((x) => lower(x.hash) === lower(hash))
      const approved = p?.approvers.map(lower).includes(lower(owner))
      return SAFE_IFACE.encodeFunctionResult('approvedHashes', [approved ? 1n : 0n])
    }
    default:
      return '0x'
  }
}

function getLogs(chainId, filter) {
  const address = Array.isArray(filter?.address) ? filter.address.map(lower) : [lower(filter?.address)]
  if (!address.includes(lower(HUB))) return []
  const topic0 = filter?.topics?.[0]
  const wants = Array.isArray(topic0) ? topic0.map(lower) : topic0 ? [lower(topic0)] : null
  if (wants && !wants.includes(lower(PROPOSED_TOPIC))) return []
  const safeTopic = filter?.topics?.[1]
  const wantSafe = Array.isArray(safeTopic) ? safeTopic.map(lower) : safeTopic ? [lower(safeTopic)] : null
  if (wantSafe && !wantSafe.includes(lower(zeroPadValue(VAULT, 32)))) return []
  return (PROPOSALS[chainId] || []).map((p) => proposedLog(chainId, p))
}

function answer(chainId, call) {
  const [param] = call?.params || []
  switch (call?.method) {
    case 'eth_chainId':
      return hex(chainId)
    case 'net_version':
      return String(chainId)
    case 'eth_blockNumber':
      return hex(CHAINS[chainId].head)
    case 'eth_getBalance':
      // 2.006441459389172406 POL — the staging screenshot's balance; the formatter is what is under review.
      return hex(2006441459389172406n)
    case 'eth_getCode': {
      const a = lower(param)
      return a === lower(VAULT) || a === lower(OTHER_VAULT) || a === lower(HUB) ? '0x6080604052' : '0x'
    }
    case 'eth_getStorageAt':
      return `0x${'0'.repeat(64)}`
    case 'eth_call':
      return ethCall(chainId, param)
    case 'eth_getLogs':
      return getLogs(chainId, param)
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return '0x3b9aca00'
    case 'eth_getBlockByNumber':
      return { number: hex(CHAINS[chainId].head), baseFeePerGas: '0x3b9aca00', timestamp: hex(Math.floor(Date.now() / 1000)), gasLimit: '0x1c9c380', gasUsed: '0x0', hash: keccak256(toUtf8Bytes(`head-${chainId}`)), parentHash: `0x${'0'.repeat(64)}`, transactions: [] }
    default:
      return null
  }
}

function startStubChain(chainId) {
  const { port } = CHAINS[chainId]
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS' })
        return res.end()
      }
      let payload
      try {
        payload = JSON.parse(body)
      } catch {
        res.writeHead(400)
        return res.end('bad json')
      }
      const one = (call) => {
        const result = answer(chainId, call)
        if (process.env.PROBE) console.log(`[rpc ${chainId}] ${call?.method} ${call?.method === 'eth_call' ? String(call.params?.[0]?.data || '').slice(0, 10) : ''} -> ${typeof result === 'string' ? result.slice(0, 20) : JSON.stringify(result)?.slice(0, 40)}`)
        return { jsonrpc: '2.0', id: call?.id ?? 1, result }
      }
      const out = Array.isArray(payload) ? payload.map(one) : one(payload)
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(out))
    })
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)))
}

const SHOTS = [
  { name: 'cards', route: 'custody', note: 'Protect ▸ On chain: one compact card per vault (the 3-network vault + a single-network one), threshold, pending count, policy badge' },
  { name: 'sheet-queue', route: 'custody', sheet: 'queue', fullSheet: true, note: 'Vault sheet ▸ Queue: rows from Polygon AND Base tagged with their network, Optimism named as unreadable, partial total' },
  { name: 'sheet-style', route: 'custody', sheet: 'style', note: 'Vault sheet ▸ Style: the spec-086 customize body against the vault address' },
  { name: 'sheet-details', route: 'custody', sheet: 'details', fullSheet: true, note: 'Vault sheet ▸ Details: networks, owners cross-referenced (You / address book / generated + add), acting account radiogroup, remove' },
  { name: 'sheet-create', route: 'custody', action: 'create', note: 'Vault actions ▸ Create vault: the wizard inside the shared sheet, styled like the rest of the app' },
  { name: 'sheet-load', route: 'custody', action: 'load', note: 'Vault actions ▸ Load vault: address field + label, no network picker' },
  { name: 'wrap-balance', route: 'wrap', note: 'Trade ▸ Wrap with an 18-decimal balance: the tile and Balance line fit the viewport' },
]

function expand() {
  const out = []
  for (const shot of SHOTS) {
    for (const viewport of [DESKTOP, MOBILE]) {
      for (const theme of ['light', 'dark']) {
        out.push({ ...shot, name: `vault-${shot.name}-${viewport === MOBILE ? 'mobile' : 'desktop'}-${theme}`, theme, viewport })
      }
    }
  }
  return out
}

async function seedPage(page, shot) {
  const endpoints = Object.fromEntries(
    Object.entries(CHAINS).map(([id, c]) => [id, { url: `http://127.0.0.1:${c.port}`, failoverUrl: `http://127.0.0.1:${c.port}/failover` }]),
  )
  await page.addInitScript(
    ({ probe, theme, account, chainId, endpoints, vault, otherVault, ownerB, unstubbed, ownedChains }) => {
      window.localStorage.setItem('themeMode', theme)
      window.localStorage.setItem('dev_warning_banner_dismissed', 'true')
      window.localStorage.setItem('fairwins.entryGate.ack.v1', JSON.stringify({ terms: null, risk: null, at: new Date(0).toISOString() }))
      window.localStorage.setItem('fw_global_prefs', JSON.stringify({ network_endpoints: endpoints }))

      // The vault on three networks (two stubbed, one deliberately not) + a second, single-network vault.
      window.localStorage.setItem(
        `fw_user_${account}_custody_vault_references`,
        JSON.stringify([
          ...ownedChains.map((c) => ({ address: vault, chainId: c, label: 'Treasury', addedAt: 1756800000000, role: 'owner' })),
          { address: vault, chainId: unstubbed, label: 'Treasury', addedAt: 1756800000000, role: 'owner' },
          { address: otherVault, chainId: ownedChains[0], label: 'Grants', addedAt: 1756800001000, role: 'watch' },
        ]),
      )
      // Address book: one owner is known as Alice; the vault itself is named (that is where labels live).
      window.localStorage.setItem(
        `fw_user_${account}_addressBook`,
        JSON.stringify({
          version: 1,
          contacts: [
            { id: 'c-alice', nickname: 'Alice', addresses: [{ address: ownerB, chainId: ownedChains[0], notes: '' }] },
            { id: 'c-treasury', nickname: 'Treasury', addresses: ownedChains.concat([unstubbed]).map((c) => ({ address: vault, chainId: c, notes: '' })) },
            { id: 'c-grants', nickname: 'Grants', addresses: [{ address: otherVault, chainId: ownedChains[0], notes: '' }] },
          ],
        }),
      )

      const chainIdHex = `0x${chainId.toString(16)}`
      const rpc = endpoints[chainId].url
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
        async request({ method, params }) {
          if (window.__probe) console.log('[inj]', method, JSON.stringify(params || []).slice(0, 200))
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [account]
            case 'eth_chainId':
              return chainIdHex
            case 'net_version':
              return String(chainId)
            case 'wallet_switchEthereumChain':
              return null
            default: {
              // Everything else goes to the stub chain the wallet is on, like a real wallet would.
              const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
              const json = await res.json()
              return json.result
            }
          }
        },
      }
      window.__probe = probe
      window.ethereum = provider
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({
              info: { uuid: 'c0ffee00-0000-4000-8000-000000000102', name: 'Capture Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'app.fairwins.capture' },
              provider,
            }),
          }),
        )
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    { probe: Boolean(process.env.PROBE), theme: shot.theme, account: ACCOUNT, chainId: WALLET_CHAIN, endpoints, vault: VAULT, otherVault: OTHER_VAULT, ownerB: OWNER_B, unstubbed: UNSTUBBED_CHAIN, ownedChains: Object.keys(CHAINS).map(Number) },
  )
}

async function isolate(context, baseOrigin) {
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith(baseOrigin) || url.startsWith('http://127.0.0.1:98')) return route.continue()
    if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
    return route.abort()
  })
}

async function captureOnce(browser, baseOrigin, shot) {
  const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2 })
  await isolate(context, baseOrigin)
  const page = await context.newPage()
  await seedPage(page, shot)
  const consoleErrors = []
  if (process.env.PROBE) {
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[inj]')) consoleErrors.push(`${m.type()}: ${m.text().slice(0, 400)}`) })
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))
    page.on('requestfailed', (r) => consoleErrors.push(`requestfailed: ${r.method()} ${r.url().slice(0, 120)} ${r.failure()?.errorText}`))
    page.on('request', (r) => {
      if (r.url().includes('127.0.0.1:98')) consoleErrors.push(`request: ${r.url()} ${(r.postData() || '').slice(0, 160)}`)
    })
  }
  try {
    const url = shot.route === 'wrap' ? `${BASE}/wallet?tab=trade&view=wrap` : `${BASE}/wallet?tab=custody`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: '.dev-warning-banner, .notification { display: none !important; }' })
    const connectClose = page.locator('.connect-modal__close')
    if (await connectClose.count()) await connectClose.first().click()
    mkdirSync(OUT, { recursive: true })

    if (shot.route === 'wrap') {
      await page.waitForSelector('.pt-wrap-balance-val', { timeout: 30_000 })
      // The balance must have been READ (not "—") for the shot to show the formatter working.
      await page.waitForFunction(() => /\d/.test(document.querySelector('.pt-wrap-balance-val')?.textContent || ''), null, { timeout: 30_000 })
      await page.waitForTimeout(300)
      await page.screenshot({ path: join(OUT, `${shot.name}.png`) })
    } else {
      await page.waitForSelector('.custody-panel', { timeout: 30_000 })
      const card = page.locator(`[data-testid="vault-card-${VAULT.toLowerCase()}"]`)
      await card.waitFor({ timeout: 30_000 })
      // Wait for the reads to land: the multi-network card states its threshold once an instance is readable.
      await page.waitForFunction(
        (sel) => /\d of \d/.test(document.querySelector(sel)?.textContent || ''),
        `[data-testid="vault-card-${VAULT.toLowerCase()}"]`,
        { timeout: 30_000 },
      )
      if (shot.action) {
        // The four-action door (release 1.14.0) — photographed with one action open.
        await page.locator('[data-testid="custody-open-vault-actions"]').click()
        await page.locator(`[data-testid="vault-action-${shot.action}"]`).click()
        await page.waitForSelector(shot.action === 'create' ? 'form.custody-create' : 'form.custody-load', { timeout: 20_000 })
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(OUT, `${shot.name}.png`) })
        const sheet = page.locator('.action-sheet')
        await sheet.evaluate((el) => (el.style.maxHeight = 'none'))
        await page.waitForTimeout(150)
        await page.screenshot({ path: join(OUT, `${shot.name}-full.png`), fullPage: true })
      } else if (shot.sheet) {
        await page.locator(`[data-testid="vault-menu-${VAULT.toLowerCase()}"]`).click()
        await page.waitForSelector('[data-testid="vault-panel-queue"]', { timeout: 20_000 })
        if (process.env.PROBE) {
          await page.waitForTimeout(12_000)
          console.log('--- panel text ---')
          console.log(await page.locator('.vault-sheet').innerText())
          console.log('--- console ---')
          console.log(consoleErrors.join('\n'))
        }
        if (shot.sheet !== 'queue') {
          await page.locator(`[data-testid="vault-tab-${shot.sheet}"]`).click()
          await page.waitForSelector(`[data-testid="vault-panel-${shot.sheet}"]`, { timeout: 20_000 })
        } else {
          // Rows from both stubbed chains must be present — the shot is about the chain log — and
          // every network must have SETTLED (the unstubbed one to "could not be read"): a shot of
          // "reading…" would photograph neither the working state nor the honest failure.
          await page.waitForFunction(
            () =>
              document.querySelectorAll('[data-testid="vault-queue-row"]').length >= 3 &&
              [...document.querySelectorAll('[data-testid="vault-queue-chain"]')].every((li) => li.dataset.state !== 'loading'),
            null,
            { timeout: 45_000 },
          )
        }
        await page.waitForTimeout(400)
        await page.screenshot({ path: join(OUT, `${shot.name}.png`) })
        if (shot.fullSheet) {
          // The Details view is longer than one screen on mobile: also record its full extent.
          const sheet = page.locator('.action-sheet')
          await sheet.evaluate((el) => (el.style.maxHeight = 'none'))
          await page.waitForTimeout(150)
          await page.screenshot({ path: join(OUT, `${shot.name}-full.png`), fullPage: true })
        }
      } else {
        await page.waitForTimeout(400)
        await page.locator('.custody-onchain').screenshot({ path: join(OUT, `${shot.name}.png`) })
      }
    }
    console.log(`wrote ${shot.name}.png — ${shot.note}`)
  } finally {
    await context.close()
  }
}

async function main() {
  const baseOrigin = new URL(BASE).origin
  const chains = await Promise.all(Object.keys(CHAINS).map((id) => startStubChain(Number(id))))
  const browser = await chromium.launch({ executablePath: chromiumExecutable() })
  try {
    for (const shot of expand()) {
      if (process.env.ONLY && !shot.name.includes(process.env.ONLY)) continue
      try {
        await captureOnce(browser, baseOrigin, shot)
      } catch (error) {
        console.warn(`retrying ${shot.name}: ${String(error?.message ?? error).split('\n')[0]}`)
        await captureOnce(browser, baseOrigin, shot)
      }
    }
  } finally {
    await browser.close()
    for (const c of chains) c.close()
  }
}

await main()
