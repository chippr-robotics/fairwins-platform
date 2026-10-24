import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CSP_RPC_GRANTS } from '../lib/network/endpointStore'

// Regression guard for the CSP connect-src blockchain RPC allowlist.
//
// The browser blocks fetch/XHR to any host not listed in `connect-src`. The
// app's read-only ethers JsonRpcProvider connects DIRECTLY to each selectable
// network's RPC URL (reads when no wallet is connected, or when the wallet is
// on a different chain than the one being read). If an RPC host is missing from
// connect-src the provider can't detect the network and every read fails with
// "Refused to connect because it violates the document's Content Security
// Policy" — which is exactly how the Mordor network broke in production.
//
// These must match the default `rpcUrl`s in src/config/networks.js and the
// transports in src/wagmi.js. localhost:8545 (Hardhat) is intentionally absent
// from the production policy. Wallet-routed writes go through window.ethereum
// (the wallet's own RPC), so only these read-only endpoints need allowlisting.
//
// Like nginxCameraPolicy.test.js, this asserts BOTH nginx configs stay in sync:
// nginx.conf (frontend/Dockerfile) and nginx.conf.template (root Dockerfile,
// used by the production deploy). The two silently diverged once before.

const __dirname = dirname(fileURLToPath(import.meta.url))

const CONFIGS = [
  resolve(__dirname, '../../nginx.conf'),
  resolve(__dirname, '../../nginx.conf.template'),
]

// Read-only RPC endpoints the frontend fetches directly (one per selectable
// chain). Keep in sync with NETWORKS[*].rpcUrl in src/config/networks.js and
// the transports in src/wagmi.js.
const REQUIRED_RPCS = [
  'https://rpc-amoy.polygon.technology', // Polygon Amoy (80002)
  'https://polygon-bor-rpc.publicnode.com', // Polygon mainnet (137)
  'https://rpc.mordor.etccooperative.org', // Ethereum Classic Mordor (63)
  'https://etc.etcdesktop.com', // Ethereum Classic mainnet (61) — replaced etc.rivet.link, which stopped resolving (NXDOMAIN)
  // Ethereum family (spec 048) — selectable value networks; portfolio reads and
  // earn position reads (spec 050) hit these directly.
  'https://ethereum-rpc.publicnode.com', // Ethereum mainnet (1)
  'https://ethereum-sepolia-rpc.publicnode.com', // Sepolia (11155111)
  'https://ethereum-hoodi-rpc.publicnode.com', // Hoodi (560048)
  // Spec 067 bridge/liquidity networks — portfolio, position and route reads hit these
  // directly, exactly like the chains above.
  'https://arbitrum-one-rpc.publicnode.com', // Arbitrum One (42161)
  'https://base-rpc.publicnode.com', // Base (8453)
  'https://optimism-rpc.publicnode.com', // Optimism (10)
]

// Gasless infrastructure the SPA POSTs to directly (specs 035/036 + 041). Without these in connect-src
// the browser blocks the fetch and every relayed intent silently falls back to self-submit (and the
// ERC-4337 bundler can't be reached at all) — the gasless path is dead in production despite shipping.
const REQUIRED_GASLESS_HOSTS = [
  'https://relay.fairwins.app', // relay-gateway (VITE_RELAYER_URL) — intent submission + status
  'https://bundler.fairwins.app', // alto ERC-4337 bundler (edge-fronted target, spec 041)
]

// Earn data services (spec 050). Without these the vault list and reward balances can never
// load in production — both Earn views permanently show the "temporarily unavailable" state
// even though the services are up (exactly how the section broke on first deploy).
const REQUIRED_EARN_HOSTS = [
  'https://api.morpho.org', // Morpho GraphQL — vault discovery/APY + position enrichment
  'https://api.merkl.xyz', // Merkl REST — reward balances + claim proofs
]

// Predict (spec 057). Authed trading runs CLIENT-DIRECT to the CLOB (CLOB V2 binds each order to its
// signer, so a shared gateway key can't relay orders), and the region gate hits Polymarket's geoblock API.
// Without these, order submit/cancel/open-orders and the geoblock check are blocked by CSP.
const REQUIRED_PREDICT_HOSTS = [
  'https://clob.polymarket.com', // CLOB — derive creds, submit/cancel orders, open orders
  'https://polymarket.com', // geoblock API (/api/geoblock) + market deep links
]

describe('nginx CSP connect-src blockchain RPC allowlist', () => {
  it.each(CONFIGS)('%s allowlists every production RPC endpoint', (path) => {
    const conf = readFileSync(path, 'utf8')
    const cspLine = conf
      .split('\n')
      .find((l) => l.includes('add_header Content-Security-Policy'))
    expect(cspLine, `${path} is missing a Content-Security-Policy header`).toBeTruthy()

    // Isolate the connect-src directive so a host listed only under img-src
    // (e.g. an IPFS gateway) can't satisfy the assertion.
    const connectSrc = cspLine.match(/connect-src\s+([^;]*)/)?.[1]
    expect(connectSrc, `${path} CSP has no connect-src directive`).toBeTruthy()

    for (const rpc of REQUIRED_RPCS) {
      expect(
        connectSrc,
        `${path} connect-src is missing ${rpc} — reads on that chain will be blocked by CSP`,
      ).toContain(rpc)
    }

    for (const host of REQUIRED_GASLESS_HOSTS) {
      expect(
        connectSrc,
        `${path} connect-src is missing ${host} — the gasless relay/bundler call will be blocked by CSP`,
      ).toContain(host)
    }

    for (const host of REQUIRED_EARN_HOSTS) {
      expect(
        connectSrc,
        `${path} connect-src is missing ${host} — the Earn section's data fetch will be blocked by CSP`,
      ).toContain(host)
    }

    for (const host of REQUIRED_PREDICT_HOSTS) {
      expect(
        connectSrc,
        `${path} connect-src is missing ${host} — Predict trading / the region check will be blocked by CSP`,
      ).toContain(host)
    }

    // Loopback IS allowed now (spec 069: a member may run their own node on this device).
    // What must never ship is a DEFAULT pointed at localhost — that is config, asserted in
    // networks.mainnet.test.js, not something this header can express.
    expect(connectSrc).toContain('http://localhost:*')
  })

  // The web font stylesheet is @imported by src/components/tokens/tokens.css, so it is a
  // STYLE source, not merely a font source. Listing fonts.googleapis.com under font-src
  // alone blocked the stylesheet outright and dropped the app to system fonts — visible on
  // every page, and silent apart from one CSP console error.
  it.each(CONFIGS)('%s allows the web font stylesheet as a style source', (path) => {
    const conf = readFileSync(path, 'utf8')
    const cspLine = conf
      .split('\n')
      .find((l) => l.includes('add_header Content-Security-Policy'))
    const styleSrc = cspLine.match(/style-src\s+([^;]*)/)?.[1]
    expect(styleSrc, `${path} CSP has no style-src directive`).toBeTruthy()
    expect(
      styleSrc,
      `${path} style-src is missing https://fonts.googleapis.com — the IBM Plex stylesheet is blocked`,
    ).toContain('https://fonts.googleapis.com')
  })

  // Spec 069 — members may point a network at their OWN node, self-hosted on a domain we
  // cannot know at build time or running locally. That is only true if the shipped policy
  // grants it, and the endpoint form decides what to warn about from CSP_RPC_GRANTS; if the
  // header and that object drift, the form starts lying in one direction or the other
  // (promising an endpoint the browser blocks, or warning about one that works).
  describe('member-configurable endpoints (spec 069)', () => {
    const connectSrcOf = (path) => {
      const conf = readFileSync(path, 'utf8')
      const cspLine = conf
        .split('\n')
        .find((l) => l.includes('add_header Content-Security-Policy'))
      const connectSrc = cspLine.match(/connect-src\s+([^;]*)/)?.[1]
      expect(connectSrc, `${path} CSP has no connect-src directive`).toBeTruthy()
      return connectSrc
    }

    it.each(CONFIGS)('%s grants every scheme the endpoint form accepts', (path) => {
      const connectSrc = connectSrcOf(path)
      for (const scheme of CSP_RPC_GRANTS.schemes) {
        // `https:` (scheme-source, no host) — a curated host list cannot serve self-hosted nodes.
        expect(
          connectSrc.split(/\s+/),
          `${path} connect-src does not grant ${scheme} — self-hosted member endpoints would be blocked`,
        ).toContain(scheme)
      }
    })

    it.each(CONFIGS)('%s grants the loopback origins a local node runs on', (path) => {
      const connectSrc = connectSrcOf(path)
      for (const host of CSP_RPC_GRANTS.httpHosts) {
        expect(
          connectSrc,
          `${path} connect-src is missing http://${host}:* — a member's local node would be blocked`,
        ).toContain(`http://${host}:*`)
      }
    })

    // CSP's host-source grammar cannot express a bracketed IPv6 literal, so `http://[::1]:*`
    // is rejected as an invalid source: the browser drops it, logs an error on every page
    // load, and grants nothing. Listing it made the endpoint form promise a route the
    // browser always blocks.
    it.each(CONFIGS)('%s does not list an ungrantable IPv6 loopback source', (path) => {
      expect(connectSrcOf(path)).not.toContain('[::1]')
    })

    it.each(CONFIGS)('%s keeps the broad grant scoped to connect-src only', (path) => {
      const conf = readFileSync(path, 'utf8')
      const cspLine = conf
        .split('\n')
        .find((l) => l.includes('add_header Content-Security-Policy'))
      // The cost of `https:` is accepted for connect-src alone. Script, frame and image
      // sources must stay narrow — a scheme-wide grant there is a different class of risk.
      for (const directive of ['script-src', 'frame-src', 'img-src']) {
        const value = cspLine.match(new RegExp(`${directive}\\s+([^;]*)`))?.[1] || ''
        expect(value.split(/\s+/), `${path} ${directive} must not carry a bare https: grant`).not.toContain(
          'https:',
        )
      }
    })
  })
})
