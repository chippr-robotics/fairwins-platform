import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Regression guard for the authenticated Pinata pinning proxy in the SPA's nginx.
//
// This route injects a PLATFORM CREDENTIAL server-side, so it spends FairWins' Pinata account on
// behalf of whoever calls it. It previously proxied `/api/pinata/` -> `.../pinning/` with a
// trailing slash (a path-wildcard passthrough into Pinata's whole `pinning/` namespace, `unpin`
// and `pinList` included) and set `Access-Control-Allow-Origin: *`, so any website's JavaScript
// could drive it. Its only control was the origin lock, which proves a request transited
// Cloudflare and nothing about who sent it.
//
// Runtime behaviour was verified against a real nginx during implementation, with the upstream
// redirected to a local sink so nothing reached Pinata:
//   POST /api/pinata/pinJSONToIPFS + origin header  -> 200, upstream saw `Authorization: Bearer <jwt>`
//   POST same, no origin header                     -> 403
//   GET  same                                       -> 403  (limit_except ... deny all)
//   POST /api/pinata/unpin/<cid>, /pinList          -> 405, never proxied (falls to the SPA route)
//   12 rapid POSTs                                  -> 200 x5 then 429 x7  (rate=1r/s burst=5)
//   512 KB body                                     -> 413  (client_max_body_size 256k)
//
// These assertions pin the config that produced those results. They are deliberately about the
// SHAPE of the guards, not their exact numbers, except where a number is the guard.

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = resolve(__dirname, '../../nginx.conf.template')
const tpl = () => readFileSync(TEMPLATE, 'utf8')

/** The Pinata location block, from its `location` line to its closing brace. */
function pinataBlock(s) {
  const start = s.indexOf('location = /api/pinata/')
  expect(start, 'the Pinata proxy must be an EXACT location match').toBeGreaterThan(-1)
  let depth = 0
  for (let i = s.indexOf('{', start); i < s.length; i++) {
    if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return s.slice(start, i + 1)
  }
  throw new Error('unterminated Pinata location block')
}

describe('Pinata proxy hardening', () => {
  it('is scoped to exactly one upstream operation, with no wildcard passthrough', () => {
    const s = tpl()
    // An `=` location cannot prefix-match, so sibling paths can never reach the credential.
    expect(s).toContain('location = /api/pinata/pinJSONToIPFS')
    // The upstream is a full path. A trailing slash here is what reopens the whole namespace.
    expect(pinataBlock(s)).toContain('proxy_pass https://api.pinata.cloud/pinning/pinJSONToIPFS;')
    expect(s).not.toMatch(/proxy_pass\s+https:\/\/api\.pinata\.cloud\/pinning\/\s*;/)
    // The old prefix location must not come back alongside it.
    expect(s).not.toMatch(/location\s+\/api\/pinata\/\s*\{/)
  })

  it('sends no CORS headers at all — the client calls it same-origin', () => {
    const block = pinataBlock(tpl())
    // `ACAO: *` on a credential-injecting route is an invitation, and this route never needed it:
    // the client fetches the relative path `/api/pinata` (src/constants/ipfs.js).
    expect(block).not.toMatch(/add_header\s+Access-Control-Allow-Origin/i)
    expect(block).not.toContain('*')
    // Any add_header here would also suppress inheritance of the server-level security headers.
    expect(block).not.toMatch(/^\s*add_header/m)
  })

  it('hides any CORS headers the upstream returns', () => {
    const block = pinataBlock(tpl())
    expect(block).toMatch(/proxy_hide_header\s+Access-Control-Allow-Origin\s*;/)
  })

  it('accepts POST only', () => {
    expect(pinataBlock(tpl())).toMatch(/limit_except\s+POST\s*\{\s*deny all;\s*\}/)
  })

  it('is rate limited on the real client IP, not on Cloudflare', () => {
    const s = tpl()
    // Behind the edge every request shares a Cloudflare egress IP, so limiting on $remote_addr
    // would throttle every visitor on Earth as one bucket.
    expect(s).toMatch(/limit_req_zone\s+\$limit_client_ip\s+zone=pinata_pin:/)
    expect(s).toMatch(/map\s+\$http_cf_connecting_ip\s+\$limit_client_ip/)
    expect(pinataBlock(s)).toMatch(/limit_req\s+zone=pinata_pin\b/)
  })

  it('caps the request body', () => {
    expect(pinataBlock(tpl())).toMatch(/client_max_body_size\s+\d+[km]?;/i)
  })

  it('still enforces the origin lock as a first filter', () => {
    // Necessary, and explicitly NOT sufficient — which is why everything above exists.
    expect(pinataBlock(tpl())).toContain('if ($origin_denied) { return 403; }')
  })

  it('does not forward the caller Origin or Referer upstream', () => {
    const block = pinataBlock(tpl())
    expect(block).toMatch(/proxy_set_header\s+Origin\s+""\s*;/)
    expect(block).toMatch(/proxy_set_header\s+Referer\s+""\s*;/)
  })

  it('injects the credential server-side and never from the client', () => {
    const block = pinataBlock(tpl())
    expect(block).toMatch(/proxy_set_header\s+Authorization\s+"Bearer \$\{VITE_PINATA_JWT\}"/)
  })
})
