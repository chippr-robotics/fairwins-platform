/**
 * Minimal JWT minting for issued RPC access (spec 107, FR-021/FR-025/FR-027).
 *
 * ── WHY THIS IS HAND-ROLLED ──────────────────────────────────────────────────────────────────
 *
 * The gateway takes no new npm dependency for this, deliberately. Adding one re-resolves the root
 * lockfile, and an incremental re-resolve is the exact mechanism that drops the platform build
 * binary (npm/cli#4828) and breaks every Vite build including the on-chain mini-app release path.
 * A JWT is two base64url-encoded JSON objects and one signature; Node's own crypto signs both
 * algorithms the provider accepts. Forty lines beats a lockfile event.
 *
 * ── WHAT IT REFUSES TO MINT ──────────────────────────────────────────────────────────────────
 *
 * A credential with no expiry, or one beyond the configured cap. The provider enforces NO maximum
 * lifetime — "You can set any expiration date in the future you'd like" — so this bound has no
 * upstream backstop: a bug here would put a long-lived bearer credential in every browser and
 * nothing anywhere would complain. That is why the refusal is STRUCTURAL (the function throws)
 * rather than a validation someone can configure off (FR-021 / SC-009).
 *
 * ── WHAT GOES IN THE TOKEN, AND WHAT DELIBERATELY DOES NOT ───────────────────────────────────
 *
 * `kid` is set from day one, not at first rotation: rotation-by-succession means two keys are
 * simultaneously valid during a window, and the provider warns that an ambiguous key lookup is an
 * authorization error. Shipping without `kid` would make the FIRST rotation a breaking change.
 *
 * No claim scopes the token — the provider verifies no `iss`/`aud`/`sub`/`jti`, so putting them in
 * would be decoration that reads as security. Scoping lives where it is real: which endpoint holds
 * the public key, and what that endpoint's request filter permits.
 */
import crypto from 'node:crypto'

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/**
 * @param {string} pem  PKCS#8/SEC1 private key. RSA keys sign RS256; P-256 EC keys sign ES256.
 * @returns {{alg: 'RS256'|'ES256', sign: (data: Buffer) => Buffer}}
 */
export function loadSigningKey(pem) {
  const key = crypto.createPrivateKey(pem)
  const type = key.asymmetricKeyType
  if (type === 'rsa') {
    return { alg: 'RS256', sign: (data) => crypto.sign('sha256', data, key) }
  }
  if (type === 'ec') {
    const curve = key.asymmetricKeyDetails?.namedCurve
    if (curve !== 'prime256v1' && curve !== 'P-256') {
      throw new Error(`ES256 requires a P-256 key; got ${curve || 'unknown curve'}`)
    }
    // JOSE wants the raw r||s form, not DER — node emits it directly with ieee-p1363.
    return { alg: 'ES256', sign: (data) => crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' }) }
  }
  throw new Error(`unsupported key type for JWT signing: ${type} (RS256 needs rsa, ES256 needs ec/P-256)`)
}

/**
 * Mint one expiring access token.
 *
 * @param {{alg: string, sign: Function}} signingKey  from loadSigningKey
 * @param {string} kid       registered key id at the provider — REQUIRED, see header comment
 * @param {number} ttlSec    lifetime; must be > 0 and <= maxTtlSec
 * @param {number} maxTtlSec the structural cap
 * @param {number} nowSec    unix seconds
 * @returns {{token: string, expiresAt: number}}
 */
export function mintAccessToken(signingKey, { kid, ttlSec, maxTtlSec, nowSec }) {
  if (!kid) throw new Error('refusing to mint a token without a kid: the first key rotation would break every client')
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
    throw new Error('refusing to mint a non-expiring credential: the provider enforces no maximum lifetime, so this bound has no upstream backstop')
  }
  if (!Number.isFinite(maxTtlSec) || maxTtlSec <= 0 || ttlSec > maxTtlSec) {
    throw new Error(`refusing to mint: ttl ${ttlSec}s exceeds the configured cap of ${maxTtlSec}s`)
  }
  const expiresAt = nowSec + ttlSec
  const header = b64url(JSON.stringify({ alg: signingKey.alg, typ: 'JWT', kid }))
  const payload = b64url(JSON.stringify({ iat: nowSec, exp: expiresAt }))
  const signature = b64url(signingKey.sign(Buffer.from(`${header}.${payload}`)))
  return { token: `${header}.${payload}.${signature}`, expiresAt }
}
