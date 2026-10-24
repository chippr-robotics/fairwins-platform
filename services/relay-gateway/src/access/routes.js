/**
 * Keyed RPC access issuance (spec 107) — `POST /v1/access/rpc`.
 *
 * Hands a client a short-lived, read-only credential for a dedicated provider endpoint, so keyed
 * read capacity never has to be compiled into a build. The client then reads DIRECTLY from the
 * provider: this route issues, it never carries traffic (FR-030) — the gateway must not become an
 * RPC passthrough, which is the surface spec 106 exists to prevent.
 *
 * ── TIER SHAPES WHAT IS ISSUED, NEVER WHETHER (FR-022) ───────────────────────────────────────
 *
 * Issuance is open to the ANONYMOUS tier. Keyed reads are not a member benefit — a design that
 * leaves logged-out visitors on throttled public capacity has not solved the problem keyed
 * capacity was bought for. What tier buys is lifetime: a proven caller holds a credential longer
 * and re-mints less often. Metering keys on the resolved caller subject, which the caller cannot
 * choose.
 *
 * ── EVERY REFUSAL HERE MEANS "FALL BACK TO PUBLIC CAPACITY" ──────────────────────────────────
 *
 * Including the enforcement refusals. The member-facing outcome of ANY answer other than 200 is a
 * degraded read over public endpoints, disclosed as degraded — never an error surface (FR-028).
 * The distinct codes exist for the operator and the client's fallback logic, not for a member to
 * read.
 *
 * ── DORMANT BY DEFAULT, HONESTLY (FR-015 discipline) ─────────────────────────────────────────
 *
 * The module mounts unconditionally and answers 503 `access_unconfigured` until an endpoint, a
 * signing key and the admin credential are all configured — the platform's standard
 * optional-module pattern, so the answer is always honest and turning it on is config, not a
 * deploy.
 */
import express from 'express'
import { GatewayError } from '../errors.js'
import { TIERS } from '../identity/tiers.js'
import { mintAccessToken } from './jwt.js'

export function createAccessRouter(config, { signingKey, enforcement, mintQuotas, now = () => Math.floor(Date.now() / 1000) }) {
  const access = config.rpcAccess
  const router = express.Router()

  function requireLive() {
    if (!access?.enabled || !signingKey || !access.kid || !enforcement) {
      throw new GatewayError(503, 'access_unconfigured', 'keyed RPC access is not configured on this gateway')
    }
    if (access.killswitch) {
      throw new GatewayError(503, 'access_disabled', 'keyed RPC access is temporarily disabled; the app falls back to public capacity')
    }
  }

  router.post('/v1/access/rpc', async (req, res) => {
    try {
      requireLive()

      const chainId = Number(req.body?.chainId)
      const endpoint = access.endpoints[chainId]
      if (!endpoint) {
        // Not an outage: this chain has no issuance endpoint (the provider serves neither ETC nor
        // Mordor at all). Public capacity is the permanent, correct path there — the client treats
        // 404 as "this chain reads public, and that is normal".
        throw new GatewayError(404, 'chain_unavailable', `no keyed read endpoint is configured for chain ${chainId}`)
      }

      // Metering BEFORE the enforcement check: the check spends an admin-API call on a cache miss,
      // and an unmetered caller must not be able to make this route amplify into the provider's
      // admin API — the same amplification rule the identity middleware applies to itself.
      const subject = req.callerSubject || `unattributed:ip:${req.ip || 'unknown'}`
      const q = mintQuotas.hit(subject)
      if (!q.allowed) {
        throw new GatewayError(429, 'quota_exceeded', `${q.scope} issuance quota exceeded; the current credential remains valid until it expires`, {
          retryAfterSec: q.retryAfterSec,
        })
      }

      // FR-026: verified per endpoint, at the moment access is served. `absent` refuses, and
      // `unverifiable` refuses IDENTICALLY — the one place in this gateway where "could not tell"
      // means "no", because failing open transmits a credential that may be sufficient by itself.
      const verdict = await enforcement.check(endpoint.id)
      if (verdict.enforcement !== 'verified') {
        throw new GatewayError(
          503,
          verdict.enforcement === 'absent' ? 'endpoint_unprotected' : 'endpoint_unverified',
          'the keyed endpoint could not be confirmed as enforcing; the app falls back to public capacity'
        )
      }

      const tier = req.caller?.tier ?? TIERS.ANONYMOUS
      const ttlSec = access.ttlSecByTier[tier] ?? access.ttlSecByTier[TIERS.ANONYMOUS]
      const { token, expiresAt } = mintAccessToken(signingKey, {
        kid: access.kid,
        ttlSec,
        maxTtlSec: access.maxTtlSec,
        nowSec: now(),
      })

      res.json({
        endpoint: endpoint.url,
        credential: token,
        // Absolute UTC, never a duration: a duration is interpreted against the client's clock,
        // and a skewed client would either discard a live credential or keep a dead one.
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        // The provider-enforced whitelist, echoed so the restriction is visible to the client
        // rather than a server-side surprise (and so a client can avoid issuing a doomed call).
        permits: verdict.methods,
        tier,
        keyId: access.kid,
      })
    } catch (err) {
      if (err instanceof GatewayError) {
        if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
        return res.status(err.status).json(err.toBody())
      }
      // Nothing from the mint or the verifier may leak: an internal message can quote key
      // material or an admin response. A generic 500 plus the client's public fallback is honest.
      return res.status(500).json({ error: { code: 'internal', reason: 'issuance failed; the app falls back to public capacity' } })
    }
  })

  return router
}

/** Gated /status contribution — operator telemetry, inside the origin-lock-disclosed portion only. */
export function accessStatus(config, { signingKey, enforcement }) {
  const access = config.rpcAccess
  if (!access?.enabled) return { state: 'not-configured' }
  return {
    state: signingKey && access.kid ? 'configured' : 'not-configured',
    killswitch: access.killswitch === true,
    kid: access.kid ?? null,
    chains: Object.keys(access.endpoints).map(Number),
    // The verifier's live view is per-request; status shows only shape, never a cached "healthy"
    // that could outlive reality.
  }
}
