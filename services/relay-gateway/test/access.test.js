/**
 * Keyed RPC access issuance (spec 107).
 *
 * The assertions that carry this file, in order of how expensive their absence would be:
 *
 *   1. `unverifiable` REFUSES here. Everywhere else in the gateway "could not tell" is a
 *      retryable 503 that must never read as a denial; at this route it refuses identically to
 *      "not enforcing", because failing open transmits a credential that may be sufficient by
 *      itself. The asymmetry is the design (spec 107 US3), and a future reader normalising it
 *      to match FR-009 would reopen the exact hole FR-026 closes.
 *
 *   2. The issuer is STRUCTURALLY incapable of minting a non-expiring credential. The provider
 *      enforces no maximum lifetime, so this bound has no upstream backstop — it must be a throw,
 *      not a validation someone can configure off (SC-009).
 *
 *   3. A whitelist that EXISTS but is switched off refuses. That is the silent failure mode:
 *      an endpoint whose filter is configured-but-disabled looks enforced in every casual read.
 */
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import request from 'supertest'
import { createApp } from '../src/server.js'
import { loadSigningKey, mintAccessToken } from '../src/access/jwt.js'
import { createEnforcementVerifier, READ_METHOD_ALLOWLIST } from '../src/access/enforcement.js'
import { testConfig, mockEngine, mockProviders, ORIGIN_SECRET, TEST_NOW } from './helpers.js'

const { privateKey: RSA_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})
const { privateKey: EC_PEM } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'P-256',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

const ACCESS_ENV = {
  RPC_ACCESS_ENABLED: 'true',
  RPC_ACCESS_SIGNING_KEY: RSA_PEM,
  RPC_ACCESS_SIGNING_KID: 'k1',
  RPC_ACCESS_ADMIN_KEY: 'test-admin-key',
  RPC_ACCESS_ENDPOINT_URL_137: 'https://issuance.example.quiknode.pro',
  RPC_ACCESS_ENDPOINT_ID_137: '999001',
  IDENTITY_ENABLED: 'true',
}

/** Admin-API stub with a configurable security answer. */
function adminFetch(security) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    if (typeof security === 'function') return security()
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: security }),
    }
  }
  impl.calls = calls
  return impl
}

const ENFORCING = {
  options: { jwts: true, tokens: false, requestFilters: true },
  request_filters: [{ method: ['eth_call', 'eth_getBalance', 'eth_getLogs'] }],
  // The real response ALSO carries live tokens; present here so a leak test can look for it.
  tokens: [{ token: 'live-endpoint-token-DO-NOT-LEAK' }],
}

function build({ env = {}, security = ENFORCING } = {}) {
  const config = testConfig({ ...ACCESS_ENV, ...env })
  const fetchImpl = adminFetch(security)
  const { app } = createApp(config, {
    providers: mockProviders(config),
    engineClient: mockEngine(),
    now: () => TEST_NOW,
    accessFetch: fetchImpl,
  })
  return { app, fetchImpl }
}

const mint = (app, body = { chainId: 137 }) =>
  request(app).post('/v1/access/rpc').set('X-Origin-Auth', ORIGIN_SECRET).send(body)

describe('issuance — the happy path', () => {
  it('issues an expiring, kid-bearing credential for a verified endpoint', async () => {
    const { app } = build()
    const res = await mint(app)
    expect(res.status).toBe(200)
    expect(res.body.endpoint).toBe('https://issuance.example.quiknode.pro')
    expect(res.body.keyId).toBe('k1')
    expect(res.body.permits).toEqual(['eth_call', 'eth_getBalance', 'eth_getLogs'])
    // Absolute UTC expiry, never a duration.
    expect(new Date(res.body.expiresAt).getTime() / 1000).toBe(TEST_NOW + 300)
    // A real three-part JWT whose header carries the kid from day one.
    const [h, p] = res.body.credential.split('.')
    expect(JSON.parse(Buffer.from(h, 'base64url'))).toMatchObject({ alg: 'RS256', kid: 'k1' })
    expect(JSON.parse(Buffer.from(p, 'base64url'))).toMatchObject({ exp: TEST_NOW + 300 })
  })

  it('issues to the ANONYMOUS tier — keyed reads are not a member benefit (FR-022)', async () => {
    const { app } = build()
    const res = await mint(app)
    expect(res.status).toBe(200)
    expect(res.body.tier).toBe('anonymous')
  })
})

describe('issuance — enforcement is checked per endpoint, at the moment access is served', () => {
  it('refuses when the endpoint does not demand the credential (jwts off)', async () => {
    const { app } = build({ security: { ...ENFORCING, options: { ...ENFORCING.options, jwts: false } } })
    const res = await mint(app)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('endpoint_unprotected')
  })

  it('refuses a whitelist that EXISTS but is switched off — the silent failure mode', async () => {
    const { app } = build({
      security: { ...ENFORCING, options: { ...ENFORCING.options, requestFilters: false } },
    })
    const res = await mint(app)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('endpoint_unprotected')
  })

  it('refuses a whitelist containing a non-read method, whatever else it contains', async () => {
    const { app } = build({
      security: { ...ENFORCING, request_filters: [{ method: ['eth_call', 'eth_sendRawTransaction'] }] },
    })
    const res = await mint(app)
    expect(res.body.error.code).toBe('endpoint_unprotected')
  })

  it('refuses UNVERIFIABLE identically — the one place "could not tell" means "no"', async () => {
    // Everywhere else unverifiable is retryable and never a denial (FR-009). Here failing open
    // transmits a credential that may be sufficient on its own, so the asymmetry inverts, on
    // purpose. Do not "fix" this to match the rest of the gateway.
    const { app } = build({ security: () => { throw new Error('admin api down') } })
    const res = await mint(app)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('endpoint_unverified')
  })

  it('never leaks the admin response, which carries live endpoint tokens in plaintext', async () => {
    const { app } = build({ security: { ...ENFORCING, options: { ...ENFORCING.options, jwts: false } } })
    const res = await mint(app)
    expect(JSON.stringify(res.body)).not.toContain('live-endpoint-token')
  })
})

describe('issuance — honest absence and honest bounds', () => {
  it('answers 503 access_unconfigured when the module is off, mounted regardless', async () => {
    const { app } = build({ env: { RPC_ACCESS_ENABLED: 'false' } })
    const res = await mint(app)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('access_unconfigured')
  })

  it('answers 404 chain_unavailable for a chain with no issuance endpoint — normal, not degraded', async () => {
    // The provider serves neither ETC nor Mordor at all; public capacity is the permanent and
    // correct path there, and the client renders it as normal.
    const { app } = build()
    const res = await mint(app, { chainId: 63 })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('chain_unavailable')
  })

  it('refuses an endpoint URL configured WITHOUT its admin-API id — the pair is the unit', async () => {
    const { app } = build({
      env: { RPC_ACCESS_ENDPOINT_URL_1: 'https://x.example', /* no RPC_ACCESS_ENDPOINT_ID_1 */ },
    })
    const res = await mint(app, { chainId: 1 })
    expect(res.status).toBe(404) // without the id the FR-026 check cannot run, so the chain does not exist here
  })

  it('meters minting per subject and keeps the current credential honest in the refusal', async () => {
    const { app } = build({ env: { RPC_ACCESS_MINT_QUOTA_PER_SUBJECT: '2' } })
    expect((await mint(app)).status).toBe(200)
    expect((await mint(app)).status).toBe(200)
    const res = await mint(app)
    expect(res.status).toBe(429)
    expect(res.body.error.reason).toMatch(/remains valid/i)
  })
})

describe('the mint itself — structural bounds (SC-009)', () => {
  const key = loadSigningKey(RSA_PEM)

  it('THROWS on a zero or missing TTL — no configuration can produce a non-expiring credential', () => {
    expect(() => mintAccessToken(key, { kid: 'k1', ttlSec: 0, maxTtlSec: 3600, nowSec: TEST_NOW })).toThrow(/non-expiring/)
    expect(() => mintAccessToken(key, { kid: 'k1', ttlSec: NaN, maxTtlSec: 3600, nowSec: TEST_NOW })).toThrow()
  })

  it('THROWS past the cap — the provider accepts any expiry, so the cap has no upstream backstop', () => {
    expect(() => mintAccessToken(key, { kid: 'k1', ttlSec: 7200, maxTtlSec: 3600, nowSec: TEST_NOW })).toThrow(/cap/)
  })

  it('THROWS without a kid — shipping without one makes the FIRST rotation a breaking change', () => {
    expect(() => mintAccessToken(key, { kid: '', ttlSec: 300, maxTtlSec: 3600, nowSec: TEST_NOW })).toThrow(/kid/)
  })

  it('signs ES256 with a P-256 key and RS256 with an RSA key, verifiably', () => {
    for (const [pem, alg] of [[RSA_PEM, 'RS256'], [EC_PEM, 'ES256']]) {
      const k = loadSigningKey(pem)
      expect(k.alg).toBe(alg)
      const { token } = mintAccessToken(k, { kid: 'k1', ttlSec: 300, maxTtlSec: 3600, nowSec: TEST_NOW })
      const [h, p, sig] = token.split('.')
      const pub = crypto.createPublicKey(pem)
      const ok = crypto.verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        alg === 'ES256' ? { key: pub, dsaEncoding: 'ieee-p1363' } : pub,
        Buffer.from(sig, 'base64url')
      )
      expect(ok, `${alg} signature must verify against the public half`).toBe(true)
    }
  })
})

describe('the enforcement verifier — caching direction', () => {
  it('caches a VERIFIED verdict but re-checks a refusal every time', async () => {
    // Caching a refusal would stretch an operator's fix into a mystery; caching verification is
    // just economy. The direction matters and is easy to invert by accident.
    let jwts = false
    const fetchImpl = adminFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ...ENFORCING, options: { ...ENFORCING.options, jwts } } }),
    }))
    const v = createEnforcementVerifier({ adminBaseUrl: 'https://api.example', adminKey: 'k', fetchImpl, cacheTtlMs: 60_000 })
    expect((await v.check('e1')).enforcement).toBe('absent')
    jwts = true // operator turns enforcement on
    expect((await v.check('e1')).enforcement).toBe('verified') // seen immediately — refusals are not cached
    jwts = false
    expect((await v.check('e1')).enforcement).toBe('verified') // the verified verdict IS cached for its TTL
  })

  it('exposes a read-only allowlist that contains no write or debug method', () => {
    for (const m of READ_METHOD_ALLOWLIST) {
      expect(m).not.toMatch(/send|sign|debug|trace|admin|personal/i)
    }
  })
})
