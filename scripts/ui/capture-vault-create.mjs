/**
 * Visual capture harness for spec 105 (guided multichain vault creation) — the actor half of the
 * actor-critic loop (see .claude/skills/actor-critic-screens), round 2: the surfaces the first
 * round could not reach without seeded chains. Photographs the deployment orchestration (one
 * network reaching Live with rules installed, one failing HONESTLY with a stated reason + Retry),
 * the done sheet with its pending list, the ONE Details card (network rows incl. an unreadable
 * chain, drift NAMED, record-gated deploy-later with the original-arrangement disclosure, and the
 * honest no-record reason), the Queue's chips + decoded rows, and the refreshed Load sheet.
 * Final shots + findings live in `specs/105-multichain-vault-creation/screenshots/`.
 *
 * Usage:
 *   npm run dev --workspace frontend -- --port 5199 --strictPort     # terminal 1
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-vault-create.mjs [baseUrl]
 *
 * Real machinery over posed pixels: the create flow runs the REAL orchestrator against two
 * loopback stub chains (Polygon 137 + Base 8453 via the spec-069 member RPC override). Polygon
 * answers the whole journey — proxyCreationCode, the create receipt, both direct-install
 * receipts — while Base refuses eth_sendTransaction with a real JSON-RPC error, so the Failed row
 * photographs the app's own failure isolation, not a mock label. Optimism (10) is referenced but
 * deliberately unstubbed so Details' "could not be read" row is honest. Every non-loopback
 * request is aborted.
 */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const { Interface, TypedDataEncoder, AbiCoder, getAddress, zeroPadValue, keccak256, toUtf8Bytes } = createRequire(
  resolve(process.cwd(), 'package.json'),
)('ethers')

const BASE = process.argv[2] || 'http://127.0.0.1:5199'
const OUT = resolve(process.cwd(), 'specs/105-multichain-vault-creation/screenshots')

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }

const ACCOUNT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const OWNER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const OWNER_C = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
const VAULT = '0xcf76db7aa9fb1bFE08e010468F3344bB458abCDe'
const HUB = '0x94b5b38C247CE51F7C42C83B63115998b7e970E7'
const FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67'
const USDC_POLYGON = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'

const CHAINS = {
  137: { port: 9821, head: 90120743 + 40, nonce: 5, version: '1.4.1', sendFails: false },
  // Base refuses to broadcast: the create flow's Failed row must come from a REAL refusal.
  8453: { port: 9822, head: 49158472 + 40, nonce: 2, version: '1.4.1', sendFails: true },
}
const WALLET_CHAIN = 137
const UNSTUBBED_CHAIN = 10 // referenced, never answered: Details' honest "could not be read" row

/*
 * Live owner sets DIVERGE on purpose (FR-013): Polygon evolved to 3-of-3 after creation, Base
 * still holds the original 2-of-2 — Details must state the shared fact as drifted and NAME the
 * networks, and the deploy-later panel must disclose the ORIGINAL arrangement (the record's),
 * because that is what a replayed initializer deploys.
 */
const OWNERS_BY_CHAIN = {
  137: { owners: [getAddress(ACCOUNT), OWNER_B, OWNER_C], threshold: 3 },
  8453: { owners: [getAddress(ACCOUNT), OWNER_B], threshold: 2 },
}
const RECORD = { owners: [getAddress(ACCOUNT), OWNER_B], threshold: 2, saltNonce: '1756800000000', presetType: 'controlled' }

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

function safeTx({ to, value = 0n, data = '0x', nonce }) {
  return { to, value, data, operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce }
}
function txHash(chainId, tx) {
  return TypedDataEncoder.hash({ chainId, verifyingContract: getAddress(VAULT) }, SAFE_TX_TYPES, tx)
}

// Queue content: a decoded USDC send that still NEEDS the member (the primary-action chip case),
// a native send the member already approved ("waiting on other owners"), and one row on Base.
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

// A plausible (nonsense but stable) proxy creation head: the flow only needs SOME bytes to hash
// into a deterministic CREATE2 prediction — nothing on a stub chain ever executes them.
const CREATION_CODE = '0x608060405234801561001057600080fd5b50610100806100206000396000f3fe'

function proposedLog(chainId, p) {
  const { data, topics } = HUB_IFACE.encodeEventLog('Proposed', [
    getAddress(VAULT), getAddress(ACCOUNT), p.hash, p.tx.to, p.tx.value, p.tx.data, p.tx.operation, p.tx.nonce,
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

const ERC20_IFACE = new Interface(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'])

function ethCall(chainId, call) {
  const to = lower(call?.to)
  const data = call?.data || '0x'
  const selector = data.slice(0, 10)
  // proxyCreationCode() on the canonical factory — what lets the flow predict the address (FR-007).
  if (to === lower(FACTORY) && selector === '0x53e5d935') {
    return AbiCoder.defaultAbiCoder().encode(['bytes'], [CREATION_CODE])
  }
  if (to !== lower(VAULT)) {
    if (selector === ERC20_IFACE.getFunction('balanceOf').selector) return ERC20_IFACE.encodeFunctionResult('balanceOf', [1_250_000_000_000_000_000n])
    if (selector === ERC20_IFACE.getFunction('decimals').selector) return ERC20_IFACE.encodeFunctionResult('decimals', [18])
    return '0x'
  }
  const fn = SAFE_IFACE.fragments.find((f) => f.type === 'function' && SAFE_IFACE.getFunction(f.name).selector === selector)
  if (!fn) return '0x'
  const cfg = CHAINS[chainId]
  const arrangement = OWNERS_BY_CHAIN[chainId]
  switch (fn.name) {
    case 'getOwners':
      return SAFE_IFACE.encodeFunctionResult('getOwners', [arrangement.owners])
    case 'getThreshold':
      return SAFE_IFACE.encodeFunctionResult('getThreshold', [BigInt(arrangement.threshold)])
    case 'nonce':
      return SAFE_IFACE.encodeFunctionResult('nonce', [BigInt(cfg.nonce)])
    case 'VERSION':
      return SAFE_IFACE.encodeFunctionResult('VERSION', [cfg.version])
    case 'isOwner': {
      const [owner] = SAFE_IFACE.decodeFunctionData('isOwner', data)
      return SAFE_IFACE.encodeFunctionResult('isOwner', [arrangement.owners.map(lower).includes(lower(owner))])
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

/**
 * Broadcast bookkeeping so the REAL orchestrator completes (or honestly fails) its journey:
 * a send answers with a hash, the receipt reports success, and the transaction can be read
 * back — enough for ethers' signer path, nothing more.
 */
function makeTxLedger(chainId) {
  const txs = new Map()
  let minted = 0
  return {
    send(param) {
      if (CHAINS[chainId].sendFails) {
        return { error: { code: -32000, message: 'insufficient funds for gas * price + value' } }
      }
      minted += 1
      const hash = keccak256(toUtf8Bytes(`sent-${chainId}-${minted}`))
      txs.set(hash, { param, block: CHAINS[chainId].head + minted })
      return { result: hash }
    },
    byHash(hash) {
      const t = txs.get(hash)
      if (!t) return null
      return {
        hash,
        from: t.param?.from || ACCOUNT,
        to: t.param?.to || null,
        input: t.param?.data || '0x',
        value: t.param?.value || '0x0',
        nonce: '0x0',
        gas: '0x30000',
        gasPrice: '0x3b9aca00',
        maxFeePerGas: '0x3b9aca00',
        maxPriorityFeePerGas: '0x3b9aca00',
        chainId: hex(chainId),
        type: '0x2',
        accessList: [],
        blockNumber: hex(t.block),
        blockHash: keccak256(toUtf8Bytes(`block-${chainId}-${t.block}`)),
        transactionIndex: '0x0',
        v: '0x1',
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
        yParity: '0x1',
      }
    },
    receipt(hash) {
      const t = txs.get(hash)
      if (!t) return null
      return {
        transactionHash: hash,
        transactionIndex: '0x0',
        blockNumber: hex(t.block),
        blockHash: keccak256(toUtf8Bytes(`block-${chainId}-${t.block}`)),
        from: t.param?.from || ACCOUNT,
        to: t.param?.to || null,
        contractAddress: null,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x3b9aca00',
        logs: [],
        logsBloom: `0x${'0'.repeat(512)}`,
        status: '0x1',
        type: '0x2',
      }
    },
  }
}

function answer(chainId, call, ledger) {
  const [param] = call?.params || []
  switch (call?.method) {
    case 'eth_chainId':
      return { result: hex(chainId) }
    case 'net_version':
      return { result: String(chainId) }
    case 'eth_blockNumber':
      return { result: hex(CHAINS[chainId].head) }
    case 'eth_getBalance':
      return { result: hex(2006441459389172406n) }
    case 'eth_getTransactionCount':
      return { result: '0x0' }
    case 'eth_estimateGas':
      return { result: '0x30000' }
    case 'eth_getCode': {
      const a = lower(param)
      return { result: a === lower(VAULT) || a === lower(HUB) || a === lower(FACTORY) ? '0x6080604052' : '0x' }
    }
    case 'eth_getStorageAt':
      return { result: `0x${'0'.repeat(64)}` }
    case 'eth_call':
      return { result: ethCall(chainId, param) }
    case 'eth_getLogs':
      return { result: getLogs(chainId, param) }
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return { result: '0x3b9aca00' }
    case 'eth_feeHistory':
      return { result: { oldestBlock: hex(CHAINS[chainId].head - 4), baseFeePerGas: Array(5).fill('0x3b9aca00'), gasUsedRatio: Array(4).fill(0.5), reward: Array(4).fill(['0x3b9aca00']) } }
    case 'eth_getBlockByNumber':
      return { result: { number: hex(CHAINS[chainId].head), baseFeePerGas: '0x3b9aca00', timestamp: hex(Math.floor(Date.now() / 1000)), gasLimit: '0x1c9c380', gasUsed: '0x0', hash: keccak256(toUtf8Bytes(`head-${chainId}`)), parentHash: `0x${'0'.repeat(64)}`, transactions: [] } }
    case 'eth_sendTransaction':
      return ledger.send(param)
    case 'eth_getTransactionByHash':
      return { result: ledger.byHash(param) }
    case 'eth_getTransactionReceipt':
      return { result: ledger.receipt(param) }
    default:
      return { result: null }
  }
}

function startStubChain(chainId) {
  const { port } = CHAINS[chainId]
  const ledger = makeTxLedger(chainId)
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
        const out = answer(chainId, call, ledger)
        if (process.env.PROBE) console.log(`[rpc ${chainId}] ${call?.method} -> ${JSON.stringify(out).slice(0, 80)}`)
        return { jsonrpc: '2.0', id: call?.id ?? 1, ...out }
      }
      const out = Array.isArray(payload) ? payload.map(one) : one(payload)
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(out))
    })
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)))
}

const SHOTS = [
  { name: 'details-one-card', kind: 'details', note: 'Details as ONE card: Live rows for Polygon (wallet here) + Base, Optimism honestly unreadable, missing cohort networks with record-gated Deploy, shared facts with drift NAMING the networks' },
  { name: 'details-deploy-later', kind: 'details-deploy', note: 'Deploy-later panel open for a missing network: the ORIGINAL-arrangement disclosure renders before any signature (FR-017)' },
  { name: 'details-no-record', kind: 'details', noRecord: true, note: 'The same missing rows WITHOUT a creation record: the honest reason, never a dead control (FR-018)' },
  { name: 'queue-chips', kind: 'queue', note: 'Queue chips (All / Needs you / per-network) over decoded rows — "Send 250 USDC", needs-you badges, Optimism named as unreadable' },
  { name: 'queue-needs-you', kind: 'queue', chip: 'needs-you', note: 'The Needs-you chip filters to rows awaiting THIS member without touching the per-chain read disclosure' },
  { name: 'load-sheet', kind: 'action', action: 'load', note: 'Load a vault: address + label, app-styled, no network picker (loading probes every network)' },
  { name: 'create-status', kind: 'create', note: 'Deployment orchestration: Polygon reaches Live through real receipts while Base states ITS refusal (insufficient funds) with Retry — isolation, not a shared error' },
  { name: 'create-done', kind: 'create', done: true, note: 'Done sheet: one address, the networks that made it, and the pending one listed honestly' },
]

function expand() {
  const out = []
  for (const shot of SHOTS) {
    for (const viewport of [DESKTOP, MOBILE]) {
      for (const theme of ['light', 'dark']) {
        out.push({ ...shot, name: `${shot.name}-${viewport === MOBILE ? 'mobile' : 'desktop'}-${theme}`, theme, viewport })
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
    ({ theme, account, chainId, endpoints, vault, ownerB, unstubbed, ownedChains, record, seedVault }) => {
      window.localStorage.setItem('themeMode', theme)
      window.localStorage.setItem('dev_warning_banner_dismissed', 'true')
      window.localStorage.setItem('fairwins.entryGate.ack.v1', JSON.stringify({ terms: null, risk: null, at: new Date(0).toISOString() }))
      window.localStorage.setItem('fw_global_prefs', JSON.stringify({ network_endpoints: endpoints }))

      if (seedVault) {
        window.localStorage.setItem(
          `fw_user_${account}_custody_vault_references`,
          JSON.stringify([
            ...ownedChains.map((c) => ({ address: vault, chainId: c, label: 'Treasury', addedAt: 1756800000000, role: 'owner' })),
            { address: vault, chainId: unstubbed, label: 'Treasury', addedAt: 1756800000000, role: 'owner' },
          ]),
        )
        window.localStorage.setItem(
          `fw_user_${account}_addressBook`,
          JSON.stringify({
            version: 1,
            contacts: [{ id: 'c-alice', nickname: 'Alice', addresses: [{ address: ownerB, chainId: ownedChains[0], notes: '' }] }],
          }),
        )
        if (record) {
          window.localStorage.setItem(
            `fw_user_${account}_vault_creation_records`,
            JSON.stringify([{ address: vault, createdAt: 1756800000000, rules: null, v: 1, ...record }]),
          )
        }
      }

      let currentChain = chainId
      const provider = {
        isMetaMask: true,
        selectedAddress: account,
        get chainId() {
          return `0x${currentChain.toString(16)}`
        },
        _callbacks: {},
        on(event, cb) {
          ;(this._callbacks[event] = this._callbacks[event] || []).push(cb)
        },
        removeListener(event, cb) {
          this._callbacks[event] = (this._callbacks[event] || []).filter((f) => f !== cb)
        },
        _emit(event, payload) {
          for (const cb of this._callbacks[event] || []) cb(payload)
        },
        async request({ method, params }) {
          switch (method) {
            case 'eth_accounts':
            case 'eth_requestAccounts':
              return [account]
            case 'eth_chainId':
              return `0x${currentChain.toString(16)}`
            case 'net_version':
              return String(currentChain)
            case 'wallet_switchEthereumChain': {
              // A real wallet switches and ANNOUNCES it — the spec-102 settle loop waits on this.
              const wanted = parseInt(params?.[0]?.chainId, 16)
              if (!endpoints[wanted]) {
                const err = new Error('Unrecognized chain')
                err.code = 4902
                throw err
              }
              currentChain = wanted
              this._emit('chainChanged', `0x${currentChain.toString(16)}`)
              return null
            }
            default: {
              const rpc = endpoints[currentChain].url
              const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
              const json = await res.json()
              if (json.error) {
                const err = new Error(json.error.message || 'RPC error')
                err.code = json.error.code
                err.data = json.error.data
                throw err
              }
              return json.result
            }
          }
        },
      }
      window.ethereum = provider
      const announce = () =>
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({
              info: { uuid: 'c0ffee00-0000-4000-8000-000000000105', name: 'Capture Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'app.fairwins.capture' },
              provider,
            }),
          }),
        )
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    {
      theme: shot.theme,
      account: ACCOUNT,
      chainId: WALLET_CHAIN,
      endpoints,
      vault: VAULT,
      ownerB: OWNER_B,
      unstubbed: UNSTUBBED_CHAIN,
      ownedChains: Object.keys(CHAINS).map(Number),
      record: shot.noRecord ? null : RECORD,
      seedVault: shot.kind !== 'create',
    },
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

async function openSheet(page, view) {
  await page.waitForSelector('.custody-panel', { timeout: 30_000 })
  await page.locator(`[data-testid="vault-menu-${VAULT.toLowerCase()}"]`).click()
  await page.waitForSelector('[data-testid="vault-panel-queue"]', { timeout: 20_000 })
  if (view !== 'queue') {
    await page.locator(`[data-testid="vault-tab-${view}"]`).click()
    await page.waitForSelector(`[data-testid="vault-panel-${view}"]`, { timeout: 20_000 })
  }
}

async function captureOnce(browser, baseOrigin, shot) {
  const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2 })
  await isolate(context, baseOrigin)
  const page = await context.newPage()
  await seedPage(page, shot)
  try {
    await page.goto(`${BASE}/wallet?tab=custody`, { waitUntil: 'domcontentloaded' })
    await page.addStyleTag({ content: '.dev-warning-banner, .notification { display: none !important; }' })
    const connectClose = page.locator('.connect-modal__close')
    if (await connectClose.count()) await connectClose.first().click()
    mkdirSync(OUT, { recursive: true })
    const snap = async (name, { full = false } = {}) => {
      await page.waitForTimeout(400)
      await page.screenshot({ path: join(OUT, `${name}.png`) })
      if (full) {
        const sheet = page.locator('.action-sheet')
        if (await sheet.count()) {
          await sheet.first().evaluate((el) => (el.style.maxHeight = 'none'))
          await page.waitForTimeout(150)
        }
        await page.screenshot({ path: join(OUT, `${name}-full.png`), fullPage: true })
      }
    }

    if (shot.kind === 'details' || shot.kind === 'details-deploy') {
      await openSheet(page, 'details')
      // Every network row must have SETTLED — Live where stubbed, the honest failure where not —
      // before the card is photographed; "reading…" would photograph neither state.
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="vault-network"]').length + document.querySelectorAll('[data-testid="vault-network-missing"]').length >= 4,
        null,
        { timeout: 45_000 },
      )
      if (shot.kind === 'details-deploy') {
        const btn = page.locator('[data-testid^="vault-deploy-"]').first()
        await btn.click()
        await page.waitForSelector('[data-testid="vault-deploy-panel"]', { timeout: 20_000 })
        await page.locator('[data-testid="vault-deploy-panel"]').scrollIntoViewIfNeeded()
      }
      if (shot.noRecord) {
        // FR-018: no record ⇒ the reason, and NO deploy control anywhere on the card.
        await page.waitForFunction(
          () => !document.querySelector('[data-testid^="vault-deploy-"]') && (document.body.textContent || '').includes('creation details'),
          null,
          { timeout: 20_000 },
        )
      }
      await snap(shot.name, { full: true })
    } else if (shot.kind === 'queue') {
      await openSheet(page, 'queue')
      await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="vault-queue-row"]').length >= 3,
        null,
        { timeout: 45_000 },
      )
      if (shot.chip) {
        await page.locator(`[data-testid="vault-queue-chip-${shot.chip}"]`).click()
      }
      await snap(shot.name, { full: true })
    } else if (shot.kind === 'action') {
      await page.waitForSelector('.custody-panel', { timeout: 30_000 })
      await page.locator('[data-testid="custody-open-vault-actions"]').click()
      await page.locator(`[data-testid="vault-action-${shot.action}"]`).click()
      await page.waitForSelector('form.custody-load', { timeout: 20_000 })
      await snap(shot.name)
    } else if (shot.kind === 'create') {
      await page.waitForSelector('.custody-panel', { timeout: 30_000 })
      await page.locator('[data-testid="custody-open-vault-actions"]').click()
      await page.locator('[data-testid="vault-action-create"]').click()
      await page.waitForSelector('[data-testid="create-step-type"]', { timeout: 20_000 })
      // Controlled 2-of-2 (matches the seeded record's story), default rules, two networks.
      await page.locator('[data-testid="create-step-type"] [role="radio"]', { hasText: 'Controlled' }).click()
      await page.locator('#create-owner-0').fill(getAddress(ACCOUNT))
      await page.locator('#create-owner-1').fill(OWNER_B)
      await page.locator('#create-vault-label').fill('Treasury')
      await page.getByRole('button', { name: 'Next: set rules' }).click()
      await page.waitForSelector('[data-testid="create-step-rules"]', { timeout: 20_000 })
      await page.getByRole('button', { name: 'Next: pick networks' }).click()
      await page.waitForSelector('[data-testid="create-step-networks"]', { timeout: 20_000 })
      await page.locator('[data-testid="network-chip-8453"]').click()
      await page.locator('[data-testid="deploy-button"]').click()
      // The finish line is the pair of TERMINAL states: Polygon Live (with its rules note),
      // Base failed with the refusal text — photographed only once both are true.
      await page.waitForFunction(
        () => {
          const t137 = document.querySelector('[data-testid="deploy-status-137"]')?.textContent || ''
          const t8453 = document.querySelector('[data-testid="deploy-status-8453"]')?.textContent || ''
          return /Live/.test(t137) && /Failed|insufficient/i.test(t8453)
        },
        null,
        { timeout: 90_000 },
      )
      if (!shot.done) {
        await snap(shot.name, { full: true })
      } else {
        await page.getByRole('button', { name: 'Continue' }).click()
        await page.waitForSelector('[data-testid="create-step-done"]', { timeout: 20_000 })
        await snap(shot.name, { full: true })
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
