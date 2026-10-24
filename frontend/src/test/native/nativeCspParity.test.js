import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Spec 102 R7 — the native CSP parity gate.
//
// The native channels' CSP is DERIVED from frontend/nginx.conf (there is no
// second hand-written policy), so what this gate pins is the TRANSFORM:
//  · script-src keeps `blob:` (verified mini-app bytes, spec 073 R1) and
//    NEVER gains `https:` — the one widening spec 073 forbids outright.
//  · connect-src keeps the spec-069 grants (`https:` scheme-wide + loopback
//    http) so bring-your-own-node works identically in the apps.
//  · Only the declared meta-incompatible directives may be dropped; anything
//    else in the web policy must survive verbatim.
// Both nginx configs are checked — they diverged silently once before
// (nginxCspConnectSrc.test.js history).
import {
  META_UNSUPPORTED,
  parseNginxCsp,
  parsePolicy,
  buildNativePolicy,
  injectMetaCsp,
} from '../../../../scripts/native/nativeCsp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CONFIGS = [
  resolve(__dirname, '../../../nginx.conf'),
  resolve(__dirname, '../../../nginx.conf.template'),
]

describe('native CSP derivation (spec 102 R7)', () => {
  for (const config of CONFIGS) {
    const label = config.split('/').pop()
    const webPolicy = parseNginxCsp(readFileSync(config, 'utf8'))
    const nativePolicy = buildNativePolicy(webPolicy)
    const web = parsePolicy(webPolicy)
    const native = parsePolicy(nativePolicy)

    it(`${label}: every meta-expressible directive survives verbatim`, () => {
      for (const [name, sources] of web.entries()) {
        if (META_UNSUPPORTED.includes(name)) continue
        expect(native.get(name), name).toBe(sources)
      }
      // And nothing was invented.
      for (const name of native.keys()) {
        expect(web.has(name), `${name} exists in the web policy`).toBe(true)
      }
    })

    it(`${label}: script-src keeps blob: and never gains https:`, () => {
      const scriptSrc = native.get('script-src') || ''
      expect(scriptSrc).toContain('blob:')
      expect(scriptSrc.split(/\s+/)).not.toContain('https:')
    })

    it(`${label}: connect-src keeps the spec-069 bring-your-own-node grants`, () => {
      const connectSrc = (native.get('connect-src') || '').split(/\s+/)
      expect(connectSrc).toContain('https:')
      expect(connectSrc).toContain('http://localhost:*')
      expect(connectSrc).toContain('http://127.0.0.1:*')
    })
  }

  it('injects exactly one meta tag, idempotently, and refuses a head-less page', () => {
    const html = '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n</head>\n<body></body>\n</html>'
    const once = injectMetaCsp(html, "default-src 'self'")
    expect(once.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1)
    const twice = injectMetaCsp(once, "default-src 'self'; script-src 'self'")
    expect(twice.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1)
    expect(twice).toContain("script-src 'self'")
    expect(() => injectMetaCsp('<html><body></body></html>', "default-src 'self'")).toThrow(/no <head>/)
  })
})
