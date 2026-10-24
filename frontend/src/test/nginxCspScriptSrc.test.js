import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Regression guard for the CSP script-src WebAssembly grant.
//
// Spec 034's Group Pools redesign dropped Semaphore (and its in-browser Groth16 proof generation)
// entirely, so the bundle no longer compiles or instantiates any `.wasm`. The narrow
// `'wasm-unsafe-eval'` token was removed from script-src along with it, re-tightening the production
// CSP. This guard asserts it stays gone: if a future change re-adds a WASM grant it must come with a
// deliberate justification, not silently ride back in.
//
// The broader `'unsafe-eval'` must never ship either — the bundle uses no dynamic eval()/new Function().
//
// Like nginxCspConnectSrc.test.js, this asserts BOTH nginx configs stay in sync: nginx.conf
// (frontend/Dockerfile) and nginx.conf.template (root Dockerfile — the PRODUCTION deploy). They
// diverged once on exactly this token: the fix landed in nginx.conf only, so fairwins.app stayed broken.

const __dirname = dirname(fileURLToPath(import.meta.url))

const CONFIGS = [
  resolve(__dirname, '../../nginx.conf'),
  resolve(__dirname, '../../nginx.conf.template'),
]

/** The script-src directive value of a config's Content-Security-Policy header. */
function scriptSrcOf(path) {
  const conf = readFileSync(path, 'utf8')
  const cspLine = conf
    .split('\n')
    .find((l) => l.includes('add_header Content-Security-Policy'))
  expect(cspLine, `${path} is missing a Content-Security-Policy header`).toBeTruthy()

  const scriptSrc = cspLine.match(/script-src\s+([^;]*)/)?.[1]
  expect(scriptSrc, `${path} CSP has no script-src directive`).toBeTruthy()
  return scriptSrc.trim()
}

describe('nginx CSP script-src WebAssembly grant', () => {
  it.each(CONFIGS)('%s no longer carries a WASM grant (Semaphore removed in spec 034)', (path) => {
    const conf = readFileSync(path, 'utf8')
    const cspLine = conf
      .split('\n')
      .find((l) => l.includes('add_header Content-Security-Policy'))
    expect(cspLine, `${path} is missing a Content-Security-Policy header`).toBeTruthy()

    const scriptSrc = cspLine.match(/script-src\s+([^;]*)/)?.[1]
    expect(scriptSrc, `${path} CSP has no script-src directive`).toBeTruthy()

    // Spec 034 dropped Semaphore + its in-browser Groth16 proofs, so no .wasm is compiled anymore.
    // The narrow 'wasm-unsafe-eval' token was removed with it — re-adding a WASM grant must be a
    // deliberate, justified change, not a silent regression.
    expect(
      scriptSrc,
      `${path} script-src should not carry 'wasm-unsafe-eval' — Semaphore/WASM was removed in spec 034`,
    ).not.toContain("'wasm-unsafe-eval'")

    // The broad grant must never ship — it would also permit eval()/new Function().
    expect(
      scriptSrc,
      `${path} script-src must not contain the broad 'unsafe-eval'`,
    ).not.toContain("'unsafe-eval'")
  })
})

// Spec 073 (T019) — the mini-app package grant.
//
// Mini-app packages are fetched as BYTES over connect-src, verified against the on-chain
// manifestHash and the manifest's per-file sha256 digests, and only then wrapped in a Blob and
// dynamically imported (src/lib/miniapps/loader.js, research R1). Without `blob:` in script-src the
// browser blocks that import and every launch dies on a CSP violation the member cannot act on.
//
// The more important half is what script-src must NEVER carry. A bare `https:` scheme-source here
// would mean ANY origin may serve executable code to this app — turning a compromised or hostile
// gateway into remote code execution and dissolving the whole verify-before-execute chain the loader
// exists to enforce. Spec 069 accepted the scheme-wide grant for `connect-src` alone (members run
// their own RPC nodes); script-src is where that line is drawn, and this is what keeps it drawn.
// `blob:` is safe in a way `https:` is not: a blob URL can only be minted by this app's own code,
// after verification, so it admits no third party at all.
describe('nginx CSP script-src mini-app package grant (spec 073)', () => {
  it.each(CONFIGS)('%s grants blob: so verified mini-app packages can be imported', (path) => {
    expect(
      scriptSrcOf(path).split(/\s+/),
      `${path} script-src is missing blob: — every mini-app launch would be blocked by CSP`,
    ).toContain('blob:')
  })

  it.each(CONFIGS)('%s never grants a scheme-wide script source', (path) => {
    const sources = scriptSrcOf(path).split(/\s+/)
    // Scheme-sources (no host) let any origin serve script. Named hosts such as
    // https://*.cloudflareinsights.com are a different thing and unaffected by this assertion.
    for (const scheme of ['https:', 'http:', 'data:', '*']) {
      expect(
        sources,
        `${path} script-src must not carry a bare ${scheme} grant — any origin could serve executable code`,
      ).not.toContain(scheme)
    }
  })

  it('keeps script-src byte-identical across both configs', () => {
    const [first, ...rest] = CONFIGS.map(scriptSrcOf)
    for (const value of rest) expect(value).toBe(first)
  })

  it.each(CONFIGS)('%s adds blob: to script-src only, not to frame-src', (path) => {
    // img-src already carries blob: (avatars/QR codes render from object URLs). frame-src must stay
    // narrow: spec 073 sandboxes nothing in an iframe, so a blob: frame source could only be an
    // unreviewed new capability riding in on this change.
    const conf = readFileSync(path, 'utf8')
    const cspLine = conf
      .split('\n')
      .find((l) => l.includes('add_header Content-Security-Policy'))
    const frameSrc = cspLine.match(/frame-src\s+([^;]*)/)?.[1] || ''
    expect(frameSrc.split(/\s+/), `${path} frame-src must not carry blob:`).not.toContain('blob:')
  })
})

// Spec 106 (FR-018) — script-src is a PINNED ALLOWLIST, and this block is the pin.
//
// Before this gate existed, the assertions above were purely NEGATIVE: no scheme-wide grants, no
// eval, no wasm. Verified during spec 106's research: a change adding one more NAMED host to
// script-src broke none of them — the invariant everyone believed ("script-src never widens
// silently") was unguarded against exactly the kind of change most likely to happen. So every
// source in script-src is now enumerated, WITH ITS REASON, and any addition fails this test until
// it is added here deliberately, reason attached. The exception stays countable, which is the
// difference between an allowlist and an accumulation.
describe('nginx CSP script-src pinned allowlist (spec 106, FR-018)', () => {
  const PINNED_SCRIPT_SOURCES = {
    "'self'": 'the application bundle itself',
    "'unsafe-inline'": 'legacy inline bootstrapping; predates this gate, tracked by the brand/CSP work',
    'blob:': 'verified mini-app packages, imported from Blob URLs AFTER hash verification (spec 073)',
    'https://*.cloudflareinsights.com': 'Cloudflare Web Analytics beacon',
    'https://challenges.cloudflare.com':
      'Turnstile — proof-of-human for the caller-identity tiers (spec 106). ONE named host, ' +
      'operated by the edge provider already fronting the app; the opposite of a scheme grant.',
  }

  it.each(CONFIGS)('%s script-src contains EXACTLY the pinned sources, no more, no fewer', (path) => {
    const actual = scriptSrcOf(path).split(/\s+/).filter(Boolean).sort()
    const pinned = Object.keys(PINNED_SCRIPT_SOURCES).sort()
    // Not toContain: an EXACT match in both directions. A source added without a pinned reason
    // fails (that is the widening this gate exists to catch); a pinned source that disappears
    // fails too, because a silent removal breaks a feature and reads as nothing in review.
    expect(actual, `${path} script-src diverged from the pinned allowlist`).toEqual(pinned)
  })

  it.each(CONFIGS)('%s frame-src carries the challenge iframe host alongside the wallet/trezor frames', (path) => {
    const conf = readFileSync(path, 'utf8')
    const cspLine = conf.split('\n').find((l) => l.includes('add_header Content-Security-Policy'))
    const frameSrc = (cspLine.match(/frame-src\s+([^;]*)/)?.[1] || '').split(/\s+/).filter(Boolean).sort()
    expect(frameSrc).toEqual(
      [
        'https://challenges.cloudflare.com',
        'https://verify.walletconnect.com',
        'https://verify.walletconnect.org',
        'https://connect.trezor.io',
      ].sort(),
    )
  })

  it('every pinned source carries a written reason — countable means explained', () => {
    for (const [source, reason] of Object.entries(PINNED_SCRIPT_SOURCES)) {
      expect(reason.length, `${source} is pinned without a reason`).toBeGreaterThan(10)
    }
  })
})
