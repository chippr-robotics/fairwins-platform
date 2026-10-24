/**
 * Visual capture harness for the nav drawer (spec 081).
 *
 * Drives a real browser against a running dev server and writes one screenshot per drawer state
 * to `specs/081-nav-drawer-density/screenshots/`. This is a DEV-TIME script: Playwright is
 * resolved from wherever the operator installed it (see below), never from a workspace manifest.
 * Spec 075 documents that a lockfile re-resolve in this repo can silently drop an optional
 * platform binary and break every Vite build, including the mini-app release path whose output
 * bytes are keccak-committed on-chain. A screenshot harness does not justify that exposure.
 *
 * Usage:
 *   npm run dev --workspace frontend -- --port 5199        # terminal 1
 *   mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && \
 *     PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright  # once
 *   NODE_PATH=/tmp/pw/node_modules node scripts/ui/capture-nav-drawer.mjs [baseUrl]
 *
 * The environment already ships Chromium at /opt/pw-browsers, so no browser download is needed;
 * set CHROMIUM_PATH to override.
 */
import { mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const BASE = process.argv[2] || 'http://127.0.0.1:5199'
const OUT = resolve(process.cwd(), 'specs/081-nav-drawer-density/screenshots')
const VIEWPORT = { width: 390, height: 844 } // a phone, where the crowding actually bites

/** The pre-installed Chromium; the launcher's own default would want a download. */
function chromiumExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers'
  const dir = readdirSync(root).find((name) => /^chromium-\d+$/.test(name))
  return dir ? join(root, dir, 'chrome-linux', 'chrome') : undefined
}

/** Seed the device-scoped preference blob before the app's first paint. */
function seed({ favorites = 0, density = 'comfortable', sections = null } = {}) {
  const prefs = {}
  if (favorites > 0) {
    // The first two carry the REAL slugs of the two published packages, so the strip shows their
    // curated store artwork; the rest are uncurated on purpose, to photograph the generic
    // illustration an unknown app actually gets.
    const seeded = [
      ['token-mint', 'Token Mint'],
      ['clearpath', 'ClearPath'],
      ['payroll', 'Payroll'],
      ['reconcile', 'Reconcile'],
      ['ledger-sync', 'Ledger Sync'],
      ['treasury', 'Treasury'],
      ['audit-trail', 'Audit Trail'],
      ['vault-ops', 'Vault Ops'],
    ]
    prefs.miniapp_favorites = Array.from({ length: favorites }, (_, i) => ({
      id: i + 1,
      slug: seeded[i]?.[0] || `app-${i + 1}`,
      name: seeded[i]?.[1] || `App ${i + 1}`,
    }))
  }
  prefs.nav_density = density
  if (sections) prefs.nav_sections = sections
  return prefs
}

const SHOTS = [
  { name: '01-default', prefs: seed({ favorites: 2 }), note: 'default: Tools folded, 2 pins' },
  { name: '02-all-expanded', prefs: seed({ favorites: 2, sections: { tools: true } }) },
  { name: '03-pins-capped', prefs: seed({ favorites: 8 }) },
  { name: '04-pins-expanded', prefs: seed({ favorites: 8 }), click: '.pinned-app-more' },
  { name: '05-filter-active', prefs: seed({ favorites: 8 }), type: 'r' },
  { name: '06-filter-no-match', prefs: seed({ favorites: 2 }), type: 'zzzz' },
  { name: '07-compact', prefs: seed({ favorites: 8, density: 'compact', sections: { tools: true } }) },
  {
    name: '08-before-unbounded-pins',
    prefs: seed({ favorites: 8, sections: { tools: true } }),
    unbounded: true,
    note: 'what 8 pins looked like as rows, for comparison',
  },
]

mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ executablePath: chromiumExecutable() })

for (const shot of SHOTS) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 })
  const page = await context.newPage()

  await page.addInitScript((prefs) => {
    localStorage.setItem('fw_global_prefs', JSON.stringify(prefs))
    // Pre-acknowledge the first-touch eligibility gate (spec 007) — it is a modal over the whole
    // app and would otherwise be the only thing in every screenshot.
    localStorage.setItem(
      'fairwins.entryGate.ack.v1',
      JSON.stringify({ terms: null, risk: null, at: new Date(0).toISOString() }),
    )
  }, shot.prefs)

  // `domcontentloaded`, not `networkidle`: the dev server keeps an HMR socket open, so the page
  // is never idle and the wait would always time out.
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' })
  // Attached, not visible: on a phone the drawer starts off-canvas, which is the whole point.
  await page.waitForSelector('#app-nav-drawer', { state: 'attached', timeout: 30_000 })

  // The dev server's build-warning banner is fixed over the header and would both swallow the
  // click and photobomb every shot. It exists only in a dev build.
  await page.addStyleTag({ content: '.dev-warning-banner { display: none !important; }' })

  // The auto-connect prompt opens on entry once the gate clears. Dismiss it — this harness is
  // photographing the menu, not the connect flow.
  const connectClose = page.locator('.connect-modal__close')
  if (await connectClose.count()) await connectClose.first().click()

  // The clover logo IS the menu button in app mode (Header.jsx).
  await page.getByRole('button', { name: 'Open menu' }).click()
  await page.waitForSelector('#app-nav-drawer.open', { timeout: 10_000 })

  if (shot.unbounded) {
    // Re-render the pins as full-width rows, i.e. the pre-081 shape, purely so the two
    // screenshots can be compared side by side. Nothing in the app does this.
    await page.evaluate(() => {
      const strip = document.querySelector('.pinned-apps-strip')
      const nav = document.querySelector('#app-nav-drawer .portal-nav')
      if (!strip || !nav) return
      const anchor = nav.querySelector('.portal-nav-group-items')
      // Built node by node rather than through innerHTML: the initial and the label are
      // app-supplied text (a mini-app's own name), and interpolating them into markup
      // reinterprets whatever they contain as HTML.
      const span = (className, text) => {
        const el = document.createElement('span')
        el.className = className
        if (text !== undefined) el.textContent = text
        return el
      }
      for (const tile of strip.querySelectorAll('.pinned-app-tile')) {
        const row = document.createElement('button')
        row.className = 'portal-nav-item'
        const icon = span('portal-nav-item-icon')
        icon.appendChild(span('portal-nav-item-initial', tile.textContent[0]))
        row.appendChild(icon)
        row.appendChild(span('portal-nav-item-label', tile.getAttribute('aria-label')))
        anchor?.appendChild(row)
      }
      strip.remove()
    })
  }

  if (shot.click) await page.locator(shot.click).click()
  if (shot.type) await page.locator('#app-nav-search-input').fill(shot.type)

  await page.waitForTimeout(350) // let the chevron/expand transitions settle
  await page.screenshot({ path: join(OUT, `${shot.name}.png`) })
  console.log(`captured ${shot.name}.png${shot.note ? ` — ${shot.note}` : ''}`)

  await context.close()
}

await browser.close()
console.log(`\nScreenshots in ${OUT}`)
