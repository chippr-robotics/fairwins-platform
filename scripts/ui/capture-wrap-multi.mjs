/**
 * Visual capture harness for spec 108 (multi-currency wrap/unwrap) — the actor half of the
 * actor-critic loop (see .claude/skills/actor-critic-screens). Photographs the Trade ▸ Wrap
 * surface with the coin picker: the landed view, the open picker (read AND unreadable balance
 * rows in one frame), a cross-chain selection with the switch disclosure, and the refused-switch
 * alert naming both chains. Final shots + findings live in
 * `specs/108-multi-currency-wrap/screenshots/`.
 *
 * Usage:
 *   npm run dev --workspace frontend -- --port 5199 --strictPort     # terminal 1
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-wrap-multi.mjs [baseUrl]
 *
 * Real machinery over posed pixels: the picker's balances are REAL reads against two loopback
 * stub chains — Polygon 137 (the wallet's chain) and ETC 61 — routed there by the spec-069
 * member RPC override; the other four mainnet-cohort coins stay unrouted (every non-loopback
 * request is aborted), so their rows photograph the app's own unread state, not a posed dash.
 * The refusal shot is the wallet mock genuinely declining wallet_switchEthereumChain.
 */
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const { Interface, AbiCoder } = createRequire(resolve(process.cwd(), 'package.json'))('ethers')

const BASE = process.argv[2] || 'http://127.0.0.1:5199'
const OUT = resolve(process.cwd(), 'specs/108-multi-currency-wrap/screenshots')

const DESKTOP = { width: 1280, height: 900 }
const MOBILE = { width: 390, height: 844 }

const ACCOUNT = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const ABI = AbiCoder.defaultAbiCoder()
const ERC20 = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function symbol() view returns (string)',
])

// Loopback stub chains. 137 is the wallet's chain; 61 is the cross-chain target. Balances are
// per-chain so the picker's numbers are visibly different reads, not one copied figure.
const CHAINS = {
  137: { port: 9831, native: 12_500_000_000_000_000_000n, wrapped: 4_250_000_000_000_000_000n, wrappedSymbol: 'WPOL' },
  61: { port: 9832, native: 3_200_000_000_000_000_000n, wrapped: 0n, wrappedSymbol: 'WETC' },
}
const WALLET_CHAIN = 137

function startStub(chainId, cfg) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const answerOne = (payload) => {
        const { method, params, id } = payload
        let result
        switch (method) {
          case 'eth_chainId': result = `0x${chainId.toString(16)}`; break
          case 'net_version': result = String(chainId); break
          case 'eth_blockNumber': result = '0x1000000'; break
          case 'eth_getBalance': result = `0x${cfg.native.toString(16)}`; break
          case 'eth_gasPrice': result = '0x6fc23ac0'; break
          case 'eth_maxPriorityFeePerGas': result = '0x59682f00'; break
          case 'eth_getBlockByNumber':
            result = { number: '0x1000000', baseFeePerGas: '0x3b9aca00', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x0', transactions: [] }
            break
          case 'eth_call': {
            const data = String(params?.[0]?.data || '')
            if (data.startsWith(ERC20.getFunction('balanceOf').selector)) {
              result = ABI.encode(['uint256'], [cfg.wrapped])
            } else if (data.startsWith(ERC20.getFunction('symbol').selector)) {
              result = ABI.encode(['string'], [cfg.wrappedSymbol])
            } else {
              result = '0x'
            }
            break
          }
          default: result = '0x'
        }
        return { jsonrpc: '2.0', id, result }
      }
      let payload
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }
      const out = Array.isArray(payload) ? payload.map(answerOne) : answerOne(payload)
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(out))
    })
  })
  return new Promise((ok) => server.listen(cfg.port, '127.0.0.1', () => ok(server)))
}

const endpointsSeed = Object.fromEntries(
  Object.entries(CHAINS).map(([id, c]) => [id, { url: `http://127.0.0.1:${c.port}` }]),
)

async function preparePage(context, { theme, rejectSwitch }) {
  const page = await context.newPage()
  await page.addInitScript(
    ({ theme, account, chainId, endpoints, rejectSwitch }) => {
      window.localStorage.setItem('themeMode', theme)
      window.localStorage.setItem('dev_warning_banner_dismissed', 'true')
      window.localStorage.setItem('fairwins.entryGate.ack.v1', JSON.stringify({ terms: null, risk: null, at: new Date(0).toISOString() }))
      window.localStorage.setItem('fw_global_prefs', JSON.stringify({ network_endpoints: endpoints }))

      let currentChain = chainId
      const provider = {
        isMetaMask: true,
        selectedAddress: account,
        get chainId() { return `0x${currentChain.toString(16)}` },
        _callbacks: {},
        on(event, cb) { ;(this._callbacks[event] = this._callbacks[event] || []).push(cb) },
        removeListener(event, cb) { this._callbacks[event] = (this._callbacks[event] || []).filter((f) => f !== cb) },
        _emit(event, payload) { for (const cb of this._callbacks[event] || []) cb(payload) },
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
              if (rejectSwitch) {
                const err = new Error('User rejected the request')
                err.code = 4001
                throw err
              }
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
              info: { uuid: 'c0ffee00-0000-4000-8000-000000000108', name: 'Capture Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'app.fairwins.capture' },
              provider,
            }),
          }),
        )
      window.addEventListener('eip6963:requestProvider', announce)
      announce()
    },
    { theme, account: ACCOUNT, chainId: WALLET_CHAIN, endpoints: endpointsSeed, rejectSwitch: Boolean(rejectSwitch) },
  )
  return page
}

async function landOnWrap(page) {
  await page.goto(`${BASE}/wallet?tab=trade&view=wrap`, { waitUntil: 'domcontentloaded' })
  await page.addStyleTag({ content: '.dev-warning-banner,.notification{display:none!important}' })
  await page.waitForSelector('[data-testid="wrap-coin-field"]', { timeout: 30_000 })
  // Let the loopback balance reads land so the shot shows numbers, not spinners.
  await page.waitForTimeout(1500)
}

const shots = []
async function shoot(page, name, { fullPage = false } = {}) {
  const path = `${OUT}/${name}.png`
  await page.screenshot({ path, fullPage })
  shots.push(name)
  console.log(`  📸 ${name}`)
}

async function scenarioSet(context, theme, sizeName) {
  // 1. Landed view — default coin is the wallet's chain, balances are real loopback reads.
  let page = await preparePage(context, { theme })
  await landOnWrap(page)
  await shoot(page, `wrap-default-${sizeName}-${theme}`)

  // 2. Picker open — read rows (137, 61) beside honestly-unread rows (the unrouted chains).
  await page.locator('[data-testid="wrap-coin-field"] button[aria-haspopup="listbox"]').click()
  await page.waitForSelector('[role="listbox"]', { timeout: 10_000 })
  await shoot(page, `wrap-picker-${sizeName}-${theme}`)

  // 3. Cross-chain selection — ETC picked while the wallet sits on Polygon: switch disclosure
  //    in the preview and on the button.
  await page.locator('[role="option"]', { hasText: 'Ethereum Classic' }).first().click()
  await page.waitForTimeout(800)
  await page.locator('#pt-wrap-amount').fill('1.25')
  await page.waitForTimeout(300)
  await shoot(page, `wrap-cross-chain-${sizeName}-${theme}`)
  await page.close()

  // 4. Refused switch — the wallet declines; the alert names BOTH chains, nothing sent.
  page = await preparePage(context, { theme, rejectSwitch: true })
  await landOnWrap(page)
  await page.locator('[data-testid="wrap-coin-field"] button[aria-haspopup="listbox"]').click()
  await page.locator('[role="option"]', { hasText: 'Ethereum Classic' }).first().click()
  await page.waitForTimeout(800)
  await page.locator('#pt-wrap-amount').fill('0.5')
  await page.getByRole('button', { name: /Wrap ETC on Ethereum Classic/ }).click()
  await page.waitForSelector('[role="alert"]', { timeout: 15_000 })
  await shoot(page, `wrap-refused-switch-${sizeName}-${theme}`)
  await page.close()
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const servers = await Promise.all(Object.entries(CHAINS).map(([id, c]) => startStub(Number(id), c)))
  // The image pins one Chromium under /opt/pw-browsers; the operator-scoped playwright may
  // expect a different revision, so point at the binary directly rather than downloading.
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

  for (const [sizeName, viewport] of [['desktop', DESKTOP], ['mobile', MOBILE]]) {
    for (const theme of ['light', 'dark']) {
      console.log(`— ${sizeName} / ${theme}`)
      const context = await browser.newContext({ viewport })
      const baseOrigin = new URL(BASE).origin
      await context.route('**/*', (route) => {
        const url = route.request().url()
        if (url.startsWith(baseOrigin) || url.startsWith('http://127.0.0.1:98')) return route.continue()
        if (url.startsWith('data:') || url.startsWith('blob:')) return route.continue()
        return route.abort()
      })
      try {
        await scenarioSet(context, theme, sizeName)
      } catch (err) {
        console.error(`  retrying ${sizeName}/${theme} once:`, err.message)
        await scenarioSet(context, theme, sizeName)
      }
      await context.close()
    }
  }

  await browser.close()
  for (const s of servers) s.close()
  console.log(`\n${shots.length} shots → ${OUT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
