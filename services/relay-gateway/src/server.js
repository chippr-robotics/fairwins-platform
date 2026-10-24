/**
 * FairWins relay gateway — HTTP entrypoint (spec 036).
 *
 * The policy front-end for gasless intent submission: recovers + screens the SIGNER, validates
 * intent binding, dedups, rate-limits and fee-gates, then hands built calldata to the OSS
 * submission engine (OpenZeppelin Relayer) which owns nonces/gas/inclusion. Untrusted-by-design:
 * this service can censor, never steal — every response leaves self-submit available (FR-002/FR-003).
 *
 * Routes (contracts/relay-gateway-api.md — implemented faithfully):
 *   POST /v1/intents          submit a signed intent           (origin-locked)
 *   GET  /v1/intents/:id      honest status                    (origin-locked)
 *   POST /v1/engine/webhook   engine status callback           (shared-secret)
 *   GET  /healthz             liveness/readiness               (origin-lock EXEMPT)
 *   GET  /v1/opensea/*        read-only collectibles proxy     (origin-locked; spec 055)
 *   GET  /v1/bridge/*         read-only Across quote/status    (origin-locked; spec 067)
 *   GET/POST /v1/member/*     member API: capability tokens    (origin-locked; spec 095)
 *                             …and, on its PRICED ops only, x402 pay-per-request (spec 096):
 *                             no token => 402 + PaymentRequirements; X-PAYMENT => verify, settle
 *                             through the SAME engine, then serve. A valid token is never charged.
 */
import crypto from 'node:crypto'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import helmet from 'helmet'
import { loadConfig } from './config/index.js'
import { assertChainEndpoints, buildProviders } from './config/providers.js'
import { createFeeRouterReader } from './fees/onchain.js'
import { parseIntent, verifyIntent } from './intent/verify.js'
import { createIntentStore } from './intent/store.js'
import { createSanctionsScreen } from './policy/sanctions.js'
import { createDedupStore } from './policy/dedup.js'
import { createQuotas, createSpendTracker, createTokenBudget } from './policy/quotas.js'
import { createIdentityMiddleware } from './identity/middleware.js'
import { describeIdentityMode } from './identity/mode.js'
import { createAttestationVerifier } from './identity/verifiers/attestation.js'
import { createChallengeVerifier } from './identity/verifiers/challenge.js'
import { createGrantVerifier } from './identity/verifiers/grant.js'
import { createUpstreamCeilings, withUpstreamCeiling } from './identity/upstreamCeiling.js'
import { createAccessRouter, accessStatus } from './access/routes.js'
import { createEnforcementVerifier } from './access/enforcement.js'
import { loadSigningKey } from './access/jwt.js'
import { createBackpressure } from './policy/backpressure.js'
import { createKillSwitch } from './policy/killswitch.js'
import { createReloadHandler } from './policy/reload.js'
import { createIdentityCounters, createSponsorshipCounters, startCountersServer } from './metrics/counters.js'
import { createEngineClient } from './engine/client.js'
import { applyEngineEvent } from './engine/webhook.js'
import { createOpenSeaClient } from './opensea/client.js'
import { createTtlCache } from './opensea/cache.js'
import { createOpenSeaRouter } from './opensea/routes.js'
import { createPolymarketClient } from './polymarket/client.js'
import { createPolymarketRouter } from './polymarket/routes.js'
import { createEsploraClient, createStampsClient } from './bitcoin/client.js'
import { createBitcoinRouter } from './bitcoin/routes.js'
import { createPerpsClients } from './perps/client.js'
import { createPerpsRouter, perpsStatus } from './perps/routes.js'
import { createNewsClient } from './news/client.js'
import { createNewsRouter, newsStatus } from './news/routes.js'
import { createAcrossClient } from './bridge/quotes.js'
import { createBridgeRouter } from './bridge/routes.js'
import { createMemberApiRouter, memberApiStatus } from './memberApi/routes.js'
import { createMemberAuth } from './memberApi/auth.js'
import { createRevocationStore } from './memberApi/revocation.js'
import { createMembershipReader } from './memberApi/membership.js'
import { createWagerReader } from './memberApi/wagers.js'
import { createAssistantClient } from './memberApi/assistant.js'
import { createPaywall } from './x402/paywall.js'
import { createAuditLogger } from './audit/log.js'
import { GatewayError, EngineUnavailableError } from './errors.js'
import { getHash, packPaymasterAndData, stubPaymasterAndData } from './paymaster/build.js'
import { checkOpLimits, createDepositGate } from './paymaster/policy.js'
import { createLocalSigner, createKmsSigner } from './paymaster/sign.js'

/** Resolve the sponsorship signer (spec 050): dev/CI raw key, else lazy KMS, else null (disabled). */
function buildPaymasterSigner(pm) {
  if (pm?.signerPrivateKey) return createLocalSigner(pm.signerPrivateKey)
  if (pm?.kmsKeyName) {
    let resolving = null // createKmsSigner is async; resolve once, on first use
    return {
      address: null,
      async sign(hash) {
        resolving ??= createKmsSigner(pm.kmsKeyName)
        return (await resolving).sign(hash)
      },
    }
  }
  return null
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result })
function rpcError(res, id, code, reason, extra = {}) {
  if (extra.retryAfterSec != null) res.set('Retry-After', String(extra.retryAfterSec))
  return res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: reason, data: { code, ...extra } } })
}

/** Constant-time secret comparison over fixed-length digests (no length leak). */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const da = crypto.createHash('sha256').update(a).digest()
  const db = crypto.createHash('sha256').update(b).digest()
  return crypto.timingSafeEqual(da, db)
}

/** Estimated gas cost in wei for spend-cap + fee-netting checks. Estimation failures fall back
 * to configured defaults — the ENGINE owns real pricing; this is a policy-side bound only. */
async function estimateCostWei(provider, chainCfg, { to, data }, defaultGasLimit) {
  let gasLimit = defaultGasLimit
  try {
    if (provider?.estimateGas) gasLimit = BigInt(await provider.estimateGas({ to, data }))
  } catch {
    /* keep fallback */
  }
  let gasPrice = chainCfg.gasPriceFallbackWei
  try {
    if (provider?.getFeeData) {
      const fee = await provider.getFeeData()
      // Legacy chains (61/63) price on gasPrice only; EIP-1559 chains use maxFeePerGas.
      const p = chainCfg.gasType === 'legacy' ? fee?.gasPrice : (fee?.maxFeePerGas ?? fee?.gasPrice)
      if (p != null) gasPrice = BigInt(p)
    }
  } catch {
    /* keep fallback */
  }
  return gasLimit * gasPrice
}

/**
 * Build the Express app. All collaborators are injectable for tests
 * ({providers, engineClient, now, killSwitch, auditSink}).
 *
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{
 *   providers?: Record<number, object>,
 *   engineClient?: {submitTransaction: Function},
 *   now?: () => number,            // unix seconds
 *   killSwitch?: ReturnType<typeof createKillSwitch>,
 *   auditSink?: (line: string) => void,
 *   memberApiFetch?: typeof fetch,     // spec 095: subgraph + assistant upstreams
 *   memberApiRevocations?: object,
 *   memberApiMembership?: object,
 *   memberApiWagers?: object,
 *   memberApiAssistant?: object,
 *   paywall?: object,                  // spec 096: the x402 paid rail seam
 * }} [deps]
 */
export function createApp(config, deps = {}) {
  const providers = deps.providers ?? buildProviders(config)
  const engineClient = deps.engineClient ?? createEngineClient(config.engine)
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  const killSwitch = deps.killSwitch ?? createKillSwitch(config.killSwitch)
  const audit = createAuditLogger(deps.auditSink ? { sink: deps.auditSink } : {})
  // Live platform-fee rates from the FeeRouter contract (spec 060); env bps are the fallback.
  const feeRates = deps.feeRates ?? createFeeRouterReader(config, providers)

  const nowMs = () => now() * 1000
  const store = createIntentStore({ now: nowMs })
  const dedup = createDedupStore({ now: nowMs })
  const quotas = createQuotas({
    signerPerWindow: config.quotas.signerPerWindow,
    globalPerWindow: config.quotas.globalPerWindow,
    windowMs: config.quotas.windowMs,
    now: nowMs,
  })
  const spend = createSpendTracker({ chains: config.chains, windowMs: config.spendWindowMs, now: nowMs })
  const backpressure = createBackpressure({
    maxQueueDepth: config.maxQueueDepth,
    // The current request's own record is already in the store when this runs — exclude it,
    // the bound applies to work ALREADY in flight (FR-009).
    depthFn: () => Math.max(0, store.inFlightCount() - 1),
  })
  const screen = createSanctionsScreen({ providers, chains: config.chains })
  // Sponsored-paymaster (spec 050): its own burst quotas keyed by the smart account, and the
  // sponsorship signer (injectable for tests; local key or lazy KMS in prod; null => disabled).
  const pmQuotas = createQuotas({
    signerPerWindow: config.paymaster.accountPerWindow,
    globalPerWindow: config.paymaster.globalPerWindow,
    windowMs: config.paymaster.windowMs,
    now: nowMs,
  })
  const paymasterSigner = deps.paymasterSigner ?? buildPaymasterSigner(config.paymaster)
  // Refuses sponsorship the pool cannot pay for, so the SPA self-funds instead of hitting the
  // bundler's AA31 (see createDepositGate for the incident this answers). Injectable in tests.
  const paymasterDepositGate = deps.paymasterDepositGate ?? createDepositGate({ providers, chains: config.chains, now: nowMs })

  const app = express()
  app.disable('x-powered-by')
  app.use(helmet())

  // ---- Coarse per-IP route limiters (spec 095 hardening). These sit in FRONT of the fine-grained
  // quota layer, which stays the real per-member control (it keys on the RECOVERED SIGNER — a fact
  // an attacker cannot vary for free — where an IP is spoof-cheap and, on the VM deployment, the
  // nginx proxy's address for every caller). What these buy is an outer bound on the two places
  // that do real work BEFORE any quota can key: the health snapshot's edge-auth comparison and the
  // intent pipeline's signature recovery. A limit of 0 disables that limiter (an empty middleware
  // keeps the registration sites uniform). 429s use the gateway's error body + Retry-After.
  const makeRouteLimiter = (perMin, scope) =>
    perMin > 0
      ? rateLimit({
          windowMs: 60_000,
          limit: perMin,
          standardHeaders: 'draft-7',
          legacyHeaders: false,
          // `trust proxy` is deliberately unset (changing it would re-key every IP-scoped quota in
          // one move — see the bitcoin/bridge/perps modules), and nginx sets X-Forwarded-For on the
          // VM. Without this, express-rate-limit's startup validation refuses that combination.
          validate: { xForwardedForHeader: false },
          handler: (_req, res) =>
            res
              .status(429)
              .json({ error: { code: 'rate_limited', reason: `${scope} rate limit exceeded — retry shortly` } }),
        })
      : (_req, _res, next) => next()
  const healthLimiter = makeRouteLimiter(config.rateLimit.healthPerMin, 'health')
  const intentsLimiter = makeRouteLimiter(config.rateLimit.intentsPerMin, 'intents')

  // ---- CORS: the SPA calls the gateway cross-origin (fairwins.app -> relay.fairwins.app). Echo an
  // allow-listed Origin and answer preflight BEFORE the origin lock — browsers cannot attach
  // X-Origin-Auth (Cloudflare injects it in transit) and preflight OPTIONS carry no credentials.
  app.use((req, res, next) => {
    const origin = req.get('origin')
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      // `Authorization` is here for the spec-095 member API: a browser cannot send a bearer token
      // at all unless preflight allows the header, and the SPA's own API-access console and
      // assistant call these routes cross-origin. It changes nothing for the existing modules —
      // no route added it as a requirement, no credentials mode is enabled, no cookie is ever set,
      // the origin allow-list is unchanged, and the X-Origin-Auth edge lock still applies to every
      // client route. Allowing a request header only permits a browser to SEND it; what it
      // authorises is decided entirely by the member-signed grant it carries.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.setHeader('Access-Control-Max-Age', '600')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
  })
  // Capture the raw body so the engine-webhook route can verify the HMAC over the exact bytes
  // the engine signed (re-serializing could reorder keys and break the signature).
  const jsonSmall = express.json({ limit: '32kb', verify: (req, _res, buf) => { req.rawBody = buf } }) // intents are small fixed-shape JSON; nothing large is legitimate
  // Exception: the Bitcoin broadcast route (spec 061) carries a raw signed transaction as hex —
  // the contract caps it at 100 kB of tx bytes (200k hex chars), so it gets a larger parse limit;
  // the route itself enforces the exact cap and hex validity.
  const jsonBtcTx = express.json({ limit: '256kb' })
  const BTC_TX_PATH_RE = /^\/v1\/bitcoin\/[^/]+\/tx$/
  app.use((req, res, next) => (req.method === 'POST' && BTC_TX_PATH_RE.test(req.path) ? jsonBtcTx : jsonSmall)(req, res, next))

  // ---- Origin-lock middleware (FR-029, SC-016): client-facing routes require X-Origin-Auth.
  // The Cloudflare Transform Rule injects the header zone-wide; a direct *.run.app hit lacks it.
  // Exempt: /healthz (probes) and /v1/engine/webhook — the engine calls from inside the private
  // network (not through the edge) and authenticates with its own timing-safe shared secret.
  app.use((req, res, next) => {
    if (req.path === '/healthz' || req.path === '/status' || req.path === '/v1/engine/webhook') return next()
    if (!config.originAuthSecret) return next() // dev only; loudly warned at boot
    const header = req.get('x-origin-auth')
    if (!header || !timingSafeEqual(header, config.originAuthSecret)) {
      res.status(403).json({ error: { code: 'origin_denied', reason: 'request did not arrive through the platform edge' } })
      return
    }
    next()
  })

  // ---- Caller identity (spec 106) ---------------------------------------------------------
  // Placed HERE on purpose: after the origin lock, before route dispatch.
  //
  //   After the lock, because the lock is a string comparison that rejects non-edge traffic while
  //   resolution may make a network call — resolving first would let an off-edge caller cost us an
  //   upstream round trip per request, turning an identity layer into an amplifier.
  //
  //   Before dispatch, because identity must resolve for a route that does not exist. Otherwise an
  //   unauthenticated prober could enumerate the route surface from the difference between a 404
  //   and a 403, which is a map of which paths are worth attacking.
  //
  // Preflight never reaches this: OPTIONS short-circuits at the CORS middleware above, because a
  // browser cannot attach credentials to a preflight. If resolution saw one it would resolve
  // anonymous every time and pollute the metering it exists to make honest.
  //
  // This slice RESOLVES ONLY — it attaches req.caller and the X-FairWins-Tier header and changes
  // no status code, so the tier model can be validated against real traffic before anything depends
  // on it. Enforcement lands in a later slice.
  // Deliberately NOT wired to the global kill switch. That one stops the relayer during an
  // incident; identity is a safety layer, and turning it off mid-incident is the wrong direction.
  // IDENTITY_KILLSWITCH is its own switch, for the case where this layer itself misbehaves.
  //
  // The verifier list is a LIVE ARRAY, registered into below once the member-API dependencies it
  // needs (the revocation store, the membership reader) have been constructed further down. The
  // resolver reads it per request, so registration order does not matter — but MOUNT order does,
  // which is why the middleware is installed here and populated later rather than moved.
  // Per-upstream ceilings (FR-013). Wraps each upstream CLIENT rather than the route, so a cache
  // hit — which never touches the vendor — does not spend against a budget it is not using.
  const upstreamCeilings =
    deps.upstreamCeilings ??
    createUpstreamCeilings(
      config.identity?.upstreamCeilings ?? {},
      config.identity?.upstreamCeilingWindowMs ?? 60_000,
      nowMs
    )

  // ---- Keyed RPC access issuance (spec 107) — mounted unconditionally, dormant until config ----
  // The signing key loads at BOOT, not per request: a malformed key must fail the deploy loudly
  // rather than fail the first member quietly. Load failure with the module enabled is fatal —
  // an enabled issuer that cannot sign is a misconfiguration, not a degraded mode.
  let accessSigningKey = null
  if (config.rpcAccess?.signingKeyPem) {
    try {
      accessSigningKey = loadSigningKey(config.rpcAccess.signingKeyPem)
    } catch (err) {
      if (config.rpcAccess.enabled) {
        throw new Error(`RPC_ACCESS_SIGNING_KEY is present but unusable: ${err.message}`)
      }
      // Disabled module + broken key: boot continues, the route answers unconfigured, and the
      // warning names the problem instead of hiding it behind a healthy-looking start.
      console.warn('[relay-gateway] WARN: RPC_ACCESS_SIGNING_KEY present but unusable while module disabled:', err.message)
    }
  }
  const accessEnforcement =
    deps.accessEnforcement ??
    (config.rpcAccess?.adminKey
      ? createEnforcementVerifier({
          adminBaseUrl: config.rpcAccess.adminBaseUrl,
          adminKey: config.rpcAccess.adminKey,
          cacheTtlMs: config.rpcAccess.enforcementCacheTtlMs,
          timeoutMs: config.rpcAccess.adminTimeoutMs,
          now: nowMs,
          ...(deps.accessFetch ? { fetchImpl: deps.accessFetch } : {}),
        })
      : null)
  const accessMintQuotas =
    deps.accessMintQuotas ??
    createQuotas({
      signerPerWindow: config.rpcAccess?.mintQuotaPerSubject ?? 12,
      globalPerWindow: config.rpcAccess?.mintQuotaGlobal ?? 600,
      windowMs: config.rpcAccess?.mintQuotaWindowMs ?? 60_000,
      now: nowMs,
    })

  // The challenge verifier registers unconditionally and ABSTAINS when unconfigured — the
  // registered-but-abstaining shape is what keeps /status able to say "not-configured" honestly
  // instead of omitting a tier the ladder declares.
  const identityCounters = deps.identityCounters ?? createIdentityCounters()
  // Demand, so nonce staleness is interpretable (#1539): staleness WHILE sponsorship was granted is
  // a stall; the same staleness with no grants is a quiet night. Bounded to the configured chains.
  const sponsorshipCounters = deps.sponsorshipCounters ?? createSponsorshipCounters(Object.keys(config.chains ?? {}))
  const identityVerifiers = [
    createAttestationVerifier(),
    createChallengeVerifier(config.identity?.challenge ?? {}, {
      now: nowMs,
      ...(deps.challengeFetch ? { fetchImpl: deps.challengeFetch } : {}),
    }),
  ]
  // Live getters, not captured booleans: SIGHUP reload (policy/reload.js) mutates config in
  // place, and the middleware reads these per request so a reload takes effect on the next
  // request without a restart.
  app.use(
    createIdentityMiddleware(
      {
        get enabled() {
          return config.identity?.enabled === true && config.identity?.killswitch !== true
        },
        get enforce() {
          return config.identity?.enforce === true
        },
        counters: identityCounters,
      },
      identityVerifiers
    )
  )

  // Issuance sits AFTER identity resolution (it reads req.caller for tier and metering subject)
  // and before the module routers, like everything client-facing.
  app.use(
    createAccessRouter(config, {
      signingKey: accessSigningKey,
      enforcement: accessEnforcement,
      mintQuotas: accessMintQuotas,
      now,
    })
  )

  // ---- GET /healthz + /status (origin-lock exempt) ----------------------------------------
  // Google's GFE intercepts the literal `/healthz` on *.run.app (it never reaches the container),
  // so `/status` is the externally reachable alias used by the client self-submit probe and the
  // Cloudflare-fronted URL. `/healthz` stays for the in-container Docker HEALTHCHECK / TCP probe.
  //
  // Because /status is origin-lock exempt AND (unlike /healthz) not GFE-intercepted, it is reachable
  // unauthenticated on the raw *.run.app URL. Two hardenings so that exposure can't be abused:
  //  1. The upstream RPC fan-out (getBlockNumber + getBalance per chain) is CACHED for a short window
  //     and de-duped across concurrent callers — a client looping GET can't amplify load onto the
  //     operator's public RPCs (at most one fan-out per HEALTH_CACHE_MS regardless of request rate).
  //  2. gasWalletRunwayHrs is operator telemetry (burn rate + time-to-empty) the SPA probe never reads;
  //     it is disclosed ONLY to callers that present a valid X-Origin-Auth (i.e. arrived via the trusted
  //     edge, or the lock is disabled in dev). Public callers see only per-chain rpc up/down.
  const computeHealthChains = async () => {
    const chains = {}
    await Promise.all(
      config.enabledChainIds.map(async (chainId) => {
        const chainCfg = config.chains[chainId]
        const provider = providers[chainId]
        let rpc = 'down'
        try {
          await provider.getBlockNumber()
          rpc = 'up'
        } catch {
          rpc = 'down'
        }
        let gasWalletRunwayHrs = null
        if (chainCfg.gasWallet && rpc === 'up') {
          try {
            const balance = BigInt(await provider.getBalance(chainCfg.gasWallet))
            gasWalletRunwayHrs = Number(balance / chainCfg.peakBurnWeiPerHour)
          } catch {
            gasWalletRunwayHrs = null
          }
        }
        // Sponsored-paymaster deposit runway (spec 050 / FR-019, US4): the EntryPoint deposit funds
        // every sponsored UserOp — a drained deposit silently fails sponsorship (falls open to
        // self-submit, but the "free" promise stops). Surfaced beside the gas-wallet runway so
        // operators top up before it empties. balanceOf(paymaster) on the EntryPoint (selector
        // 0x70a08231), reusing the chain's peak-burn divisor.
        let paymasterDepositRunwayHrs = null
        if (chainCfg.paymaster && rpc === 'up') {
          try {
            const data = '0x70a08231' + chainCfg.paymaster.address.slice(2).toLowerCase().padStart(64, '0')
            const deposit = BigInt(await provider.call({ to: chainCfg.paymaster.entryPoint, data }))
            paymasterDepositRunwayHrs = Number(deposit / chainCfg.peakBurnWeiPerHour)
          } catch {
            paymasterDepositRunwayHrs = null
          }
        }
        chains[chainId] = { rpc, gasWalletRunwayHrs, paymasterDepositRunwayHrs }
      })
    )
    return chains
  }
  let healthCache = { at: 0, chains: null }
  let healthInflight = null
  const refreshHealth = () => {
    if (!healthInflight) {
      healthInflight = computeHealthChains().then(
        (chains) => {
          healthCache = { at: Date.now(), chains }
          healthInflight = null
          return chains
        },
        (err) => {
          healthInflight = null
          throw err
        }
      )
    }
    return healthInflight
  }
  const edgeAuthorized = (req) => {
    if (!config.originAuthSecret) return true // lock disabled (dev) — nothing to protect
    const header = req.get('x-origin-auth')
    return !!header && timingSafeEqual(header, config.originAuthSecret)
  }
  /**
   * Operator-only disclosure (#1505).
   *
   * `edgeAuthorized` above is NOT an authorization check and must never be mistaken for one: the
   * zone-wide Cloudflare Transform Rule injects `X-Origin-Auth` on every request, which is spec
   * 106's own founding premise. It proves the request did not arrive on the raw origin IP, and
   * nothing else. Measured in production on 2026-09-06: the identity blocks were readable by
   * anyone curling the public hostname.
   *
   * This is a SEPARATE inbound secret held by operators. Unset ⇒ false, so the guarded field is
   * absent for everyone rather than falling back to public — the failure direction matters, and
   * "nobody sees it" is recoverable where "everybody sees it" is not.
   */
  const operatorAuthorized = (req) => {
    if (!config.opsStatusSecret) return false
    const header = req.get('x-fairwins-ops')
    return !!header && timingSafeEqual(header, config.opsStatusSecret)
  }
  /**
   * Build identity (spec 076, FR-030/FR-031).
   *
   * Deliberately OUTSIDE the `disclose` gate below: an operator matching a member's bug report to a
   * running build needs this exactly when they cannot reach the trusted edge, and a version string
   * is not a secret (gasWalletRunwayHrs is, which is why THAT stays gated).
   *
   * When the deploy did not supply a version, this reports `unreleased+<sha>` — never the nearest
   * tag. Reporting a release the process is not running would make the release record untrustworthy
   * (constitution III).
   */
  const buildIdentity = () => {
    const { version, gitSha } = config.build || {}
    const short = gitSha ? String(gitSha).slice(0, 7) : null
    const released = typeof version === 'string' && /^v\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version)
    return {
      version: released ? version : short ? `unreleased+${short}` : 'unreleased',
      gitSha: short,
      released,
    }
  }

  const healthHandler = async (req, res) => {
    if (!healthCache.chains || Date.now() - healthCache.at >= config.healthCacheMs) {
      try {
        await refreshHealth()
      } catch {
        // upstream RPC hiccup — serve the last good snapshot (or empty on cold start) rather than 500
      }
    }
    const disclose = edgeAuthorized(req)
    const chains = {}
    for (const [id, c] of Object.entries(healthCache.chains || {})) {
      chains[id] = disclose ? c : { rpc: c.rpc }
    }
    // Platform-fee summary (spec 060): where each fee system's live rate comes from. Public,
    // read-only telemetry — rates are already public on-chain and in every confirm UI; the
    // Fees admin tab renders this for the gateway-enforced rows.
    const liveBps = await feeRates.getPolymarketBps()
    const fees = {
      feeRouter: feeRates.address,
      polymarket: {
        takerBps: liveBps?.takerBps ?? config.polymarket.takerFeeBps,
        makerBps: liveBps?.makerBps ?? config.polymarket.makerFeeBps,
        source: liveBps ? 'chain' : 'env-fallback',
      },
      opensea: {
        referralConfigured: Boolean(
          config.opensea.referralAddress || Object.keys(config.opensea.referralAddressByChain || {}).length
        ),
        beneficiary: config.opensea.referralAddress ?? null,
      },
    }
    // Perps read-proxy visibility (spec 082, FR-014): venue/attribution config state only —
    // no member data, and the live HL builder bps already surfaces via /v1/perps/config.
    const perps = perpsStatus(config, { killSwitch })
    // Token-news read-proxy visibility (spec 109). The routes mount unconditionally, so this block
    // is the ONLY way to tell an image that carries the module from one that predates it: without
    // it, `NEWS_ENABLED` on a stale pin and a live module look identical from outside. That is the
    // pre-pin check `infra/vm/gateway/docker-compose.yml` and docs/developer-guide/token-news.md
    // both instruct an operator to run, so it has to be here for them to be able to run it.
    // Config state only — no member data, no credential (the vendor is keyless).
    const news = newsStatus(config, { killSwitch })
    // Member API visibility (spec 095): module state + which chains can answer a wager read + whether
    // the assistant has a credential. No member data, no key material, nothing about any token.
    // `memberApiAssistant` is declared further down; this closure only runs at request time.
    const memberApi = memberApiStatus(config, { killSwitch, assistantConfigured: memberApiAssistant.configured })
    // ---- Caller identity + keyed access (specs 106/107) — GATED, deliberately -----------------
    // /status is origin-lock EXEMPT (see above), so anything in the public body is world-readable
    // on the raw origin URL. These blocks are operator telemetry and sit behind `disclose`, next
    // to gasWalletRunwayHrs, for the same reason. Inside them, honesty rules bind:
    //   - `enforcing` is EXPLICIT either way (FR-015): a layer running with checks off must never
    //     be indistinguishable from one enforcing them, and both flags read the LIVE config so a
    //     SIGHUP reload is reflected on the next poll.
    //   - attestation reports "not-built" — not `false`, not "disabled", which would imply a
    //     switch exists that could turn it on.
    //   - upstream labels come from the bounded table (FR-036), never from request content.
    const operatorDisclose = operatorAuthorized(req)
    const identityGated = disclose
      ? {
          callerIdentity: {
            enabled: config.identity?.enabled === true && config.identity?.killswitch !== true,
            // `enforcing` is OPERATOR-ONLY (#1505). It is the single most useful fact an abuser can
            // learn about this gateway — observe mode says the door is open — and the edge gate it
            // used to sit behind admits everyone. It is still reported unconditionally at BOOT and
            // on every SIGHUP reload, which is where FR-015's "disabled must be legible" is now
            // satisfied. Absent here means "you are not an operator", never "not enforcing".
            ...(operatorDisclose
              ? {
                  enforcing:
                    config.identity?.enabled === true &&
                    config.identity?.killswitch !== true &&
                    config.identity?.enforce === true,
                }
              : {}),
            verifiers: Object.fromEntries(
              identityVerifiers.map((v) => [v.kind, v.state ?? 'configured'])
            ),
          },
          upstreams: {
            state: 'read', // in-process counters: readable by construction, volatile by design
            windowCalls: upstreamCeilings.snapshot(),
            cumulativeCalls: upstreamCeilings.cumulative(),
            ceilings: config.identity?.upstreamCeilings ?? {},
          },
          tierRequests: identityCounters.snapshot(),
          access: accessStatus(config, { signingKey: accessSigningKey, enforcement: accessEnforcement }),
        }
      : {}
    res.json({ status: 'ok', build: buildIdentity(), chains, killSwitch: killSwitch.isActive(), fees, perps, news, memberApi, ...identityGated })
  }
  app.get('/healthz', healthLimiter, healthHandler)
  app.get('/status', healthLimiter, healthHandler)

  // ---- POST /v1/intents --------------------------------------------------------------------
  app.post('/v1/intents', intentsLimiter, async (req, res) => {
    let reserved = null // {chainId, marker} released on any post-reservation rejection
    try {
      // Kill switch first: when active the gateway cleanly stops ACCEPTING intents (FR-015).
      if (killSwitch.isActive()) {
        throw new GatewayError(503, 'killswitch_active', 'relaying is temporarily disabled; use self-submit')
      }

      const intent = parseIntent(req.body)

      // Chain active + matches config (FR-024).
      const chainCfg = config.chains[intent.chainId]
      if (!chainCfg) {
        throw new GatewayError(400, 'chain_mismatch', `chainId ${intent.chainId} is not an active configured network`)
      }

      // Payment class on a chain without EIP-3009 (ETC/Mordor: USC is permit-only).
      if (intent.intentClass === 'payment' && !chainCfg.paymentSupported) {
        throw new GatewayError(
          503,
          'payment_unsupported_on_chain',
          'gasless payment is not available on this network (token lacks EIP-3009); use self-submit'
        )
      }

      // Allow-list -> signer recovery (ECDSA, then ERC-1271 for contract accounts) ->
      // param binding -> validity window -> calldata.
      const { signer, calldata } = await verifyIntent(intent, chainCfg, config, now(), providers[intent.chainId])

      // Dedup by uniquenessMarker (FR-008): completed -> 200 original result; in-flight -> 409.
      const existing = dedup.check(intent.chainId, intent.uniquenessMarker)
      if (existing.state === 'completed') {
        const original = store.get(existing.intentId)
        res.status(200).json({
          intentId: existing.intentId,
          status: 'confirmed',
          ...(original?.txHash ? { txHash: original.txHash } : {}),
        })
        return
      }
      if (existing.state === 'inflight') {
        throw new GatewayError(409, 'duplicate_in_flight', 'an identical intent is already being relayed')
      }

      // Reserve the marker so concurrent duplicates coalesce from here on.
      const record = store.create({
        chainId: intent.chainId,
        signer,
        action: intent.action,
        targetContract: intent.targetContract,
        uniquenessMarker: intent.uniquenessMarker,
      })
      const reservation = dedup.reserve(intent.chainId, intent.uniquenessMarker, record.intentId)
      if (!reservation.ok) {
        store.remove(record.intentId)
        if (reservation.state === 'completed') {
          const original = store.get(reservation.intentId)
          res.status(200).json({
            intentId: reservation.intentId,
            status: 'confirmed',
            ...(original?.txHash ? { txHash: original.txHash } : {}),
          })
          return
        }
        throw new GatewayError(409, 'duplicate_in_flight', 'an identical intent is already being relayed')
      }
      reserved = { chainId: intent.chainId, marker: intent.uniquenessMarker, intentId: record.intentId }

      // Sanctions re-screen of the RECOVERED signer — fail-closed (FR-013).
      await screen.screen(intent.chainId, signer)

      // Per-signer + global quotas (FR-014).
      const q = quotas.hit(signer)
      if (!q.allowed) {
        throw new GatewayError(429, 'quota_exceeded', `${q.scope} relay quota exceeded; retry later or self-submit`, {
          retryAfterSec: q.retryAfterSec,
        })
      }

      // Bounded queue back-pressure (FR-009).
      const bp = backpressure.check()
      if (!bp.allowed) {
        throw new GatewayError(429, 'backpressure', 'relayer is at capacity; retry later or self-submit', {
          retryAfterSec: bp.retryAfterSec,
        })
      }

      // Per-chain per-window gas spend cap (FR-014/FR-018) + fee-netted decline (FR-023).
      const estimatedCostWei = await estimateCostWei(
        providers[intent.chainId],
        chainCfg,
        { to: intent.targetContract, data: calldata },
        config.defaultGasLimit
      )
      const fundingMode = intent.fundingMode ?? chainCfg.fundingMode
      if (fundingMode === 'fee-netted') {
        if (intent.maxFee == null || estimatedCostWei > intent.maxFee) {
          throw new GatewayError(
            402,
            'fee_exceeds_cap',
            `estimated gas cost ${estimatedCostWei} exceeds the intent's maxFee; no funds moved`
          )
        }
      }
      const sp = spend.tryAdd(intent.chainId, estimatedCostWei)
      if (!sp.allowed) {
        throw new GatewayError(429, 'quota_exceeded', 'per-chain gas spend cap reached for this window; retry later or self-submit', {
          retryAfterSec: sp.retryAfterSec,
        })
      }

      // Hand the built call to the engine (contracts/engine-integration.md).
      let engineTx
      try {
        engineTx = await engineClient.submitTransaction({
          relayerId: chainCfg.engineRelayerId,
          to: intent.targetContract,
          data: calldata,
        })
      } catch (e) {
        if (e instanceof EngineUnavailableError) {
          // Surface WHY the engine was unavailable (auth, non-2xx, timeout) — the client only ever
          // sees the generic 503, so without this an engine outage is invisible in the logs.
          console.error('[relay-gateway] engine submission failed:', e.message, e.cause ? `| cause: ${e.cause?.message ?? e.cause}` : '')
          throw new GatewayError(503, 'chain_unavailable', 'submission engine unavailable; use self-submit')
        }
        throw e
      }

      store.attachEngineTx(record.intentId, engineTx.id, engineTx.hash)
      const status = engineTx.hash ? 'submitted' : 'queued'
      reserved = null // submission handed off; marker stays reserved until a terminal webhook

      audit({
        signer,
        chainId: intent.chainId,
        action: intent.action,
        targetContract: intent.targetContract,
        uniquenessMarker: intent.uniquenessMarker,
        txHash: engineTx.hash ?? null,
        outcome: status === 'submitted' ? 'submitted' : 'accepted',
      })

      res.status(202).json({
        intentId: record.intentId,
        status,
        ...(engineTx.hash ? { txHash: engineTx.hash } : {}),
      })
    } catch (err) {
      if (reserved) {
        dedup.release(reserved.chainId, reserved.marker)
        store.remove(reserved.intentId)
      }
      if (err instanceof GatewayError) {
        // Terminal rejection -> audit record (FR-021): every outcome is reviewable.
        const body = req.body ?? {}
        audit({
          // signer is omitted when rejection happened before recovery — never trust a client-asserted one
          chainId: typeof body.chainId === 'number' ? body.chainId : undefined,
          action: typeof body.action === 'string' ? body.action : undefined,
          targetContract: typeof body.targetContract === 'string' ? body.targetContract : undefined,
          uniquenessMarker: typeof body.uniquenessMarker === 'string' ? body.uniquenessMarker : undefined,
          outcome: `rejected(${err.code})`,
        })
        if (err.retryAfterSec != null) res.set('Retry-After', String(err.retryAfterSec))
        res.status(err.status).json(err.toBody())
        return
      }
      console.error('[relay-gateway] unexpected error', err) // never leak internals to clients
      res.status(500).json({ error: { code: 'internal', reason: 'internal error' } })
    }
  })

  // ---- GET /v1/intents/:id -------------------------------------------------------------------
  app.get('/v1/intents/:id', (req, res) => {
    const rec = store.get(req.params.id)
    if (!rec) {
      res.status(404).json({ error: { code: 'not_found', reason: 'unknown intentId' } })
      return
    }
    res.json({
      intentId: rec.intentId,
      status: rec.status,
      ...(rec.txHash ? { txHash: rec.txHash } : {}),
      ...(rec.reason ? { reason: rec.reason } : {}),
    })
  })

  // ---- POST /v1/paymaster (ERC-7677 sponsorship; spec 050) -----------------------------------
  // pm_getPaymasterStubData (gas estimation, no policy/signing) + pm_getPaymasterData (policy
  // pipeline then KMS-signed sponsorship). Origin-locked like /v1/intents. Fails CLOSED for policy,
  // OPEN for the client: any error => the SPA rebuilds the UserOp without a paymaster and self-funds
  // (never-stranded). Sponsorship is enabled ONLY on chains with a configured paymaster address.
  app.post('/v1/paymaster', async (req, res) => {
    const body = req.body ?? {}
    const id = body.id ?? 1
    const [userOp, entryPoint, chainIdParam] = Array.isArray(body.params) ? body.params : []
    try {
      const chainId = typeof chainIdParam === 'string' ? parseInt(chainIdParam, 16) : Number(chainIdParam)
      const chainCfg = config.chains[chainId]
      if (!chainCfg?.paymaster) {
        return rpcError(res, id, 'paymaster_unsupported_chain', 'sponsorship is not available on this network; self-submit')
      }
      if (entryPoint && String(entryPoint).toLowerCase() !== chainCfg.paymaster.entryPoint.toLowerCase()) {
        return rpcError(res, id, 'entrypoint_mismatch', 'unexpected EntryPoint for this network')
      }
      if (!userOp || typeof userOp.sender !== 'string') {
        return rpcError(res, id, 'invalid_userop', 'missing or malformed userOperation')
      }

      const pm = chainCfg.paymaster.address
      const validAfter = 0
      const validUntil = now() + config.paymaster.approvalTtlSec

      // Estimation stub: no policy, no signing (a health probe can't cost the pool anything).
      if (body.method === 'pm_getPaymasterStubData') {
        return res.json(rpcResult(id, { paymasterAndData: stubPaymasterAndData({ paymaster: pm, validUntil, validAfter }) }))
      }
      if (body.method !== 'pm_getPaymasterData') {
        return rpcError(res, id, 'method_not_found', `unknown method ${body.method}`)
      }

      // ---- grant path: killswitch -> per-op ceilings -> sanctions -> quotas -> sign ----
      if (killSwitch.isActive()) {
        return rpcError(res, id, 'killswitch_active', 'sponsorship is temporarily paused; self-submit')
      }
      const limit = checkOpLimits(userOp, { maxCostWei: config.paymaster.maxCostWei, maxGas: config.paymaster.maxGas })
      if (!limit.ok) return rpcError(res, id, limit.code, limit.detail)

      await screen.screen(chainId, userOp.sender) // fail-closed; throws GatewayError 403/503

      // A definite "pool can't cover this op" refuses HERE, where the client's answer is an
      // honest self-funded rebuild; an unreadable deposit does not refuse (an RPC blip is not
      // an empty pool — the bundler's AA31 stays the backstop). AFTER the sanctions screen (a
      // sanctioned signer is told so, never masked by an ops condition) and BEFORE quotas (an
      // empty pool must not consume the member's sponsorship quota).
      const dep = await paymasterDepositGate.check(chainId, userOp)
      if (!dep.ok) {
        audit({ chainId, action: 'sponsor', targetContract: pm, outcome: `rejected(${dep.code})` })
        return rpcError(res, id, dep.code, 'sponsorship pool cannot cover this operation; self-submit')
      }

      const q = pmQuotas.hit(userOp.sender)
      if (!q.allowed) {
        return rpcError(res, id, 'quota_exceeded', `${q.scope} sponsorship quota exceeded`, { retryAfterSec: q.retryAfterSec })
      }
      if (!paymasterSigner) {
        return rpcError(res, id, 'paymaster_unconfigured', 'sponsorship signer not configured; self-submit')
      }

      const hash = getHash(userOp, { paymaster: pm, chainId, validUntil, validAfter })
      const signature = await paymasterSigner.sign(hash)
      const paymasterAndData = packPaymasterAndData({ paymaster: pm, validUntil, validAfter, signature })
      audit({ chainId, action: 'sponsor', targetContract: pm, outcome: 'granted' })
      sponsorshipCounters.grant(chainId)
      return res.json(rpcResult(id, { paymasterAndData }))
    } catch (err) {
      if (err instanceof GatewayError) {
        audit({ action: 'sponsor', outcome: `rejected(${err.code})` })
        return rpcError(res, id, err.code, err.reason, err.retryAfterSec != null ? { retryAfterSec: err.retryAfterSec } : {})
      }
      console.error('[relay-gateway] paymaster error', err) // never leak internals
      return rpcError(res, id, 'internal', 'internal error')
    }
  })

  // ---- GET /v1/opensea/* (spec 055 collectibles; read-only, origin-locked via middleware) ----
  // Third quota instance: reads are keyed by the REQUESTED address/contract/slug (no signature to
  // recover on a GET — research D4); the global window is the real backstop for the shared key.
  const osQuotas = createQuotas({
    signerPerWindow: config.opensea.quotaPerAddress,
    globalPerWindow: config.opensea.quotaGlobal,
    windowMs: config.opensea.quotaWindowMs,
    now: nowMs,
  })
  // Sell-side writes (spec 056): a separate, tighter quota keyed by the seller's account address, so
  // publishing a listing can't drain the shared key's read budget.
  const osWriteQuotas = createQuotas({
    signerPerWindow: config.opensea.writeQuotaPerAddress,
    globalPerWindow: config.opensea.writeQuotaGlobal,
    windowMs: config.opensea.quotaWindowMs,
    now: nowMs,
  })
  const openseaClient =
    withUpstreamCeiling(
      deps.openseaClient ?? createOpenSeaClient({ ...config.opensea, ...(deps.openseaFetch ? { fetchImpl: deps.openseaFetch } : {}) }),
      'opensea',
      upstreamCeilings
    )
  app.use(
    createOpenSeaRouter(config, {
      client: openseaClient,
      cache: deps.openseaCache ?? createTtlCache({ now: nowMs }),
      quotas: osQuotas,
      writeQuotas: osWriteQuotas,
      killSwitch,
    })
  )

  // ---- GET/POST /v1/polymarket/* (spec 057 Predict; origin-locked via middleware) -------------
  // Reads keyed by requested market/address; a separate tighter write quota keyed by the trader
  // address so submitting an order can't drain the shared Polymarket key's read budget.
  const pmReadQuotas = createQuotas({
    signerPerWindow: config.polymarket.quotaPerAddress,
    globalPerWindow: config.polymarket.quotaGlobal,
    windowMs: config.polymarket.quotaWindowMs,
    now: nowMs,
  })
  const pmWriteQuotas = createQuotas({
    signerPerWindow: config.polymarket.writeQuotaPerAddress,
    globalPerWindow: config.polymarket.writeQuotaGlobal,
    windowMs: config.polymarket.quotaWindowMs,
    now: nowMs,
  })
  const pmFetch = deps.polymarketFetch ? { fetchImpl: deps.polymarketFetch } : {}
  const polymarketClient =
    withUpstreamCeiling(
      deps.polymarketClient ?? createPolymarketClient({ ...config.polymarket, now: nowMs, ...pmFetch }),
      'polymarket',
      upstreamCeilings
    )
  // Discovery (Gamma) + positions (Data API) hosts — both PUBLIC, so no creds (no L2 auth headers).
  const polymarketGammaClient =
    deps.polymarketGammaClient ??
    createPolymarketClient({ baseUrl: config.polymarket.gammaBaseUrl, timeoutMs: config.polymarket.timeoutMs, retries: config.polymarket.retries, now: nowMs, ...pmFetch })
  const polymarketDataClient =
    deps.polymarketDataClient ??
    createPolymarketClient({ baseUrl: config.polymarket.dataBaseUrl, timeoutMs: config.polymarket.timeoutMs, retries: config.polymarket.retries, now: nowMs, ...pmFetch })
  app.use(
    createPolymarketRouter(config, {
      client: polymarketClient,
      gammaClient: polymarketGammaClient,
      dataClient: polymarketDataClient,
      cache: deps.polymarketCache ?? createTtlCache({ now: nowMs }),
      quotas: pmReadQuotas,
      writeQuotas: pmWriteQuotas,
      killSwitch,
      feeRates,
    })
  )

  // ---- GET/POST /v1/bitcoin/* (spec 061 Bitcoin proxy; origin-locked via middleware) ----------
  // Esplora-compatible reads (balances/UTXOs/fees/tx status) + raw-tx broadcast + Stamps
  // recognition. Quotas are keyed per caller IP (no signature to recover on these routes); the
  // broadcast write gets its own tighter quota. The routes 503 fail-closed (bitcoin_disabled)
  // until BTC_ENABLED=true — mounting is unconditional so the answer is always honest.
  const btcReadQuotas = createQuotas({
    signerPerWindow: config.bitcoin.quotaPerIp,
    globalPerWindow: config.bitcoin.quotaGlobal,
    windowMs: config.bitcoin.quotaWindowMs,
    now: nowMs,
  })
  const btcWriteQuotas = createQuotas({
    signerPerWindow: config.bitcoin.writeQuotaPerIp,
    globalPerWindow: config.bitcoin.writeQuotaGlobal,
    windowMs: config.bitcoin.quotaWindowMs,
    now: nowMs,
  })
  const btcFetch = deps.bitcoinFetch ? { fetchImpl: deps.bitcoinFetch } : {}
  const btcClientOpts = { timeoutMs: config.bitcoin.timeoutMs, retries: config.bitcoin.retries, ...btcFetch }
  const esploraClients = deps.esploraClients ?? {
    mainnet: createEsploraClient({ baseUrl: config.bitcoin.esploraUrl, ...btcClientOpts }),
    testnet: createEsploraClient({ baseUrl: config.bitcoin.esploraTestnetUrl, ...btcClientOpts }),
  }
  const stampsClient =
    deps.stampsClient !== undefined
      ? deps.stampsClient
      : config.bitcoin.stampsUrl
        ? createStampsClient({ baseUrl: config.bitcoin.stampsUrl, ...btcClientOpts })
        : null
  app.use(
    createBitcoinRouter(config, {
      esploraClients,
      stampsClient,
      cache: deps.bitcoinCache ?? createTtlCache({ now: nowMs }),
      quotas: btcReadQuotas,
      writeQuotas: btcWriteQuotas,
      killSwitch,
      now: nowMs,
    })
  )

  // ---- GET /v1/bridge/* (spec 067 cross-chain bridge; origin-locked via middleware) ------------
  // Across suggested-fees + deposit-status reads. Quotas are keyed per caller IP (nothing to sign on
  // a GET); there is no write route — the member's wallet submits the deposit itself (FR-013), so
  // the gateway is a quoting and status convenience only. Mounting is unconditional so a disabled
  // module answers 503 bridge_disabled with a machine-readable code the SPA can hide on, rather
  // than a bare 404 (FR-053).
  const bridgeQuotas = createQuotas({
    signerPerWindow: config.bridge.quotaPerIp,
    globalPerWindow: config.bridge.quotaGlobal,
    windowMs: config.bridge.quotaWindowMs,
    now: nowMs,
  })
  const acrossClient =
    deps.acrossClient ??
    createAcrossClient({
      baseUrl: config.bridge.apiUrl,
      timeoutMs: config.bridge.timeoutMs,
      retries: config.bridge.retries,
      ...(deps.bridgeFetch ? { fetchImpl: deps.bridgeFetch } : {}),
    })
  app.use(
    createBridgeRouter(config, {
      client: acrossClient,
      cache: deps.bridgeCache ?? createTtlCache({ now: nowMs }),
      quotas: bridgeQuotas,
      killSwitch,
    })
  )

  // ---- GET /v1/perps/* (spec 082 perps read proxy; origin-locked via middleware) ---------------
  // Read-only market data + positions from Gains Network / GMX / Hyperliquid, plus the public
  // attribution config and the live Hyperliquid builder-fee bps. Quotas are keyed per caller IP
  // (nothing to sign on a GET); there are NO write routes — no execution ships this release
  // (FR-018), so a total perps outage leaves every value path intact (FR-016). Mounting is
  // unconditional so a disabled module answers 503 perps_unconfigured, never a bare 404.
  const perpsQuotas = createQuotas({
    signerPerWindow: config.perps.quotaPerIp,
    globalPerWindow: config.perps.quotaGlobal,
    windowMs: config.perps.quotaWindowMs,
    now: nowMs,
  })
  const perpsClients =
    deps.perpsClients ??
    createPerpsClients(config.perps, deps.perpsFetch ? { fetchImpl: deps.perpsFetch } : {})
  app.use(
    createPerpsRouter(config, {
      clients: perpsClients,
      cache: deps.perpsCache ?? createTtlCache({ now: nowMs }),
      quotas: perpsQuotas,
      killSwitch,
      feeRates,
      now: nowMs,
    })
  )

  // ---- GET /v1/news/* (spec 109 token-news read proxy; origin-locked via middleware) -----------
  // Read-only, keyless Alphaday proxy: recent items for one curated tag slug, single-flight cached
  // per slug so vendor load is O(distinct assets), never O(members). News is ADVISORY-ONLY — no
  // value path routes through here, and there are NO write routes. Mounting is unconditional so a
  // disabled module answers 503 news_unconfigured, never a bare 404 (the SPA hides every news
  // surface on that answer).
  const newsQuotas = createQuotas({
    signerPerWindow: config.news.quotaPerIp,
    globalPerWindow: config.news.quotaGlobal,
    windowMs: config.news.quotaWindowMs,
    now: nowMs,
  })
  const newsClient =
    deps.newsClient ??
    createNewsClient({
      baseUrl: config.news.baseUrl,
      timeoutMs: config.news.timeoutMs,
      retries: config.news.retries,
      ...(deps.newsFetch ? { fetchImpl: deps.newsFetch } : {}),
    })
  app.use(
    createNewsRouter(config, {
      client: newsClient,
      cache: deps.newsCache ?? createTtlCache({ now: nowMs }),
      quotas: newsQuotas,
      killSwitch,
      now: nowMs,
    })
  )

  // ---- GET/POST /v1/member/* (spec 095 member API; origin-locked via middleware) ---------------
  // Member-signed capability tokens granting custody-free, scoped access to a member's OWN data,
  // plus unsigned typed-data quotes and a conversational assistant. NOTHING here moves value: the
  // strongest response is a payload the MEMBER then signs, and relaying a signed intent stays on
  // the existing public POST /v1/intents, which recovers the signer itself.
  //
  // Quotas are keyed by the RECOVERED ACCOUNT rather than caller IP — `trust proxy` is unset and
  // nginx fronts this container, so an IP key would pool every member into one bucket.
  //
  // FOUR INSTANCES, BECAUSE ONE WINDOW CANNOT SERVE FOUR DIFFERENT PROMISES. The unauthenticated
  // routes can only key on the proxy's IP, so they are ONE caller as far as any counter can tell;
  // sharing an instance with the members meant they shared the GLOBAL counter too, and a flood of
  // anonymous GETs would answer 429 to every authenticated member on every route of this module —
  // including `keys/revoke`, the one endpoint that has to work while a token is loose. So:
  //   · memberApiQuotas   — authenticated traffic, keyed by the account behind a verified signature
  //   · memberApiPublic   — every unauthenticated route (and the x402 402-challenge path)
  //   · memberApiRevoke   — POST /v1/member/keys/revoke and nothing else (see routes.js for why it
  //                         is budgeted rather than exempted)
  //   · memberApiAssistantQuotas — model CALLS, tighter than the general read class
  // and, separately, a TOKEN budget, because a request count is not a spend ceiling.
  //
  // Mounting is unconditional so a disabled module answers 503 member_api_unconfigured with a
  // machine-readable code, never a bare 404 — same reasoning as the bitcoin/bridge/perps proxies.
  const memberApiQuotas = createQuotas({
    signerPerWindow: config.memberApi.quotaPerAccount,
    globalPerWindow: config.memberApi.quotaGlobal,
    windowMs: config.memberApi.quotaWindowMs,
    now: nowMs,
  })
  // One number configures both bounds: with `trust proxy` unset the per-key and aggregate windows
  // coincide (every anonymous caller is the same nginx IP), and if an operator ever did trust the
  // proxy the per-IP key simply becomes the finer of two real bounds.
  const memberApiPublicQuotas = createQuotas({
    signerPerWindow: config.memberApi.publicQuota,
    globalPerWindow: config.memberApi.publicQuota,
    windowMs: config.memberApi.quotaWindowMs,
    now: nowMs,
  })
  const memberApiRevokeQuotas = createQuotas({
    signerPerWindow: config.memberApi.revokeQuota,
    globalPerWindow: config.memberApi.revokeQuota,
    windowMs: config.memberApi.quotaWindowMs,
    now: nowMs,
  })
  const memberApiAssistantQuotas = createQuotas({
    signerPerWindow: config.memberApi.assistant.quotaPerAccount,
    globalPerWindow: config.memberApi.assistant.quotaGlobal,
    windowMs: config.memberApi.quotaWindowMs,
    now: nowMs,
  })
  // The ceiling on MONEY. Its own window (hourly by default) because spend is judged over a period
  // a human would recognise, the way the gas spend cap already is.
  const memberApiAssistantBudget =
    deps.memberApiAssistantBudget ??
    createTokenBudget({
      perAccountPerWindow: config.memberApi.assistant.tokenBudgetPerAccount,
      globalPerWindow: config.memberApi.assistant.tokenBudgetGlobal,
      windowMs: config.memberApi.assistant.tokenBudgetWindowMs,
      now: nowMs,
    })
  const memberApiRevocations =
    deps.memberApiRevocations ??
    createRevocationStore({
      maxTtlDays: config.memberApi.maxTtlDays,
      maxEntries: config.memberApi.revocationMaxEntries,
      now: nowMs,
    })
  const memberApiMembership =
    deps.memberApiMembership ?? createMembershipReader(config, providers, { now: nowMs })
  // ---- Register the grant verifier (spec 106) ----------------------------------------------
  // Deliberately AFTER the revocation store and membership reader exist, and deliberately sharing
  // them: a second revocation store would let a key revoked on one path keep working on the other.
  //
  // `membership` is passed so the verifier can OFFER the `member` upgrade, never to require it. A
  // valid signature alone is accepted at `address` — which is what keeps trading from silently
  // requiring a paid membership (see verifiers/grant.js).
  identityVerifiers.push(
    createGrantVerifier({
      referenceProvider: providers?.[config.memberApi.referenceChainId] ?? null,
      revocations: memberApiRevocations,
      membership: memberApiMembership,
      clockSkewSec: config.memberApi.clockSkewSec,
      maxTtlDays: config.memberApi.maxTtlDays,
      now: () => Math.floor(nowMs() / 1000),
    })
  )

  const memberApiWagers =
    deps.memberApiWagers ??
    createWagerReader(config, deps.memberApiFetch ? { fetchImpl: deps.memberApiFetch } : {})
  const memberApiAssistant =
    deps.memberApiAssistant ??
    createAssistantClient(config, deps.memberApiFetch ? { fetchImpl: deps.memberApiFetch } : {})
  app.use(
    createMemberApiRouter(config, {
      auth: createMemberAuth(config, {
        providers,
        screen,
        revocations: memberApiRevocations,
        membership: memberApiMembership,
        quotas: memberApiQuotas,
        now,
      }),
      revocations: memberApiRevocations,
      wagerReader: memberApiWagers,
      assistant: memberApiAssistant,
      providers,
      quotas: memberApiQuotas,
      publicQuotas: memberApiPublicQuotas,
      revokeQuotas: memberApiRevokeQuotas,
      assistantQuotas: memberApiAssistantQuotas,
      assistantBudget: memberApiAssistantBudget,
      killSwitch,
      // x402 pay-per-request (spec 096). Reuses THIS gateway's engine client, sanctions screen and
      // member-API quotas — no second submission rail, no second screen, no key. Disabled by
      // default, in which case `offers()` is false everywhere and the routes behave exactly as they
      // did before the module existed.
      paywall:
        deps.paywall ??
        createPaywall(config, {
          providers,
          screen,
          engineClient,
          quotas: memberApiQuotas,
          publicQuotas: memberApiPublicQuotas,
          killSwitch,
          audit,
          now,
        }),
      feeRates,
      audit,
      now,
    })
  )

  // ---- POST /v1/engine/webhook ----------------------------------------------------------------
  app.post('/v1/engine/webhook', (req, res) => {
    // Engine authenticity: the OZ Relayer signs each webhook as `X-Signature:
    // base64(HMAC-SHA256(rawBody, signing_key))` (services/oz-relayer — notification signing_key ===
    // our WEBHOOK_SHARED_SECRET). Verify timing-safe over the exact received bytes. Fail closed:
    // no configured secret, no header, or mismatch => nothing is accepted.
    const presented = req.get('x-signature') ?? ''
    const expected = config.webhookSecret
      ? crypto.createHmac('sha256', config.webhookSecret).update(req.rawBody ?? Buffer.alloc(0)).digest('base64')
      : ''
    if (!config.webhookSecret || !presented || !timingSafeEqual(presented, expected)) {
      res.status(403).json({ error: { code: 'origin_denied', reason: 'invalid webhook credentials' } })
      return
    }
    const result = applyEngineEvent({ store, dedup, audit }, req.body ?? {})
    if (!result.ok) {
      const status = result.code === 'unknown_transaction' ? 404 : 400
      res.status(status).json({ error: { code: result.code, reason: 'webhook event not applicable' } })
      return
    }
    res.json({ ok: true })
  })

  // JSON parse errors and other middleware failures.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'too_large', reason: 'request body too large' } })
      return
    }
    res.status(400).json({ error: { code: 'bad_request', reason: 'invalid request body' } })
  })

  return { app, killSwitch, identityCounters, upstreamCeilings, store, dedup }
}

// ---- boot (only when run directly; tests import createApp) -----------------------------------
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  let config
  try {
    config = loadConfig() // throws on any deployments-pin inconsistency (FR-025) -> non-zero exit
  } catch (e) {
    console.error(String(e?.message ?? e))
    process.exit(1)
  }
  if (!config.originAuthSecret) {
    console.warn('[relay-gateway] WARN: ORIGIN_AUTH_SECRET unset — origin lock DISABLED (dev only; SC-016)')
  }
  if (!config.webhookSecret) {
    console.warn('[relay-gateway] WARN: WEBHOOK_SHARED_SECRET unset — engine webhooks will be REJECTED')
  }

  // Every configured endpoint must agree about which chain it serves. A mismatch is FATAL: the
  // providers are built with `staticNetwork`, so nothing downstream would ever notice, and every
  // sanctions screen, gas estimate and paymaster read would be answered from the wrong chain while
  // /status reported rpc:"up". An UNREACHABLE endpoint is not a mismatch and does not stop the
  // boot — see assertChainEndpoints for why those two must stay separate.
  const endpointCheck = await assertChainEndpoints(config)
  if (!endpointCheck.ok) {
    console.error(
      '[relay-gateway] refusing to start: an RPC endpoint serves a different chain than it is ' +
        'configured for. Fix RPC_URL_PRIMARY_<chainId> / RPC_URLS_<chainId> for the chains named above.'
    )
    process.exit(1)
  }

  const { app, killSwitch, identityCounters, upstreamCeilings } = createApp(config)
  // Usage counters endpoint (spec 106/#1447): an UNPUBLISHED compose-network port the FinOps
  // exporter scrapes. Unset => not started; the exporter's source reads not-configured, honestly.
  if (config.metricsPort) {
    startCountersServer({ port: config.metricsPort, counters: identityCounters, upstreamCeilings, sponsorship: sponsorshipCounters })
  }
  // Runtime kill switch: `kill -USR2 <pid>` toggles accept/refuse (FR-015).
  process.on('SIGUSR2', () => {
    const active = killSwitch.toggle()
    console.warn(`[relay-gateway] kill switch ${active ? 'ACTIVATED' : 'cleared'} via SIGUSR2`)
  })
  // Runtime config reload (spec 106 FR-014, #1446): `kill -HUP <pid>` re-reads the allowlisted
  // operational switches from RELOAD_ENV_FILE. A reload, not a remote control — and deliberately
  // a DIFFERENT signal from the kill switch: changing a gesture operators use during incidents
  // is how an incident gets worse.
  process.on('SIGHUP', createReloadHandler(config, killSwitch))
  app.listen(config.port, () => {
    console.log(
      `[relay-gateway] listening on :${config.port} | chains=${config.enabledChainIds.join(',')} | ` +
        `killSwitch=${killSwitch.isActive()} | originLock=${Boolean(config.originAuthSecret)}`
    )
    // FR-015's other half, and until #1505 it existed only in prose: the API contract and the
    // config both said the identity state is disclosed "loudly at boot", and nothing printed it.
    // That mattered little while `enforcing` was in the (widely readable) gated /status; now that
    // it is operator-only, this line is the disclosure that is always available — to anyone who
    // can read the journal, which is the audience FR-015 was written for.
    console.log(`[relay-gateway] ${describeIdentityMode(config)}`)
  })
}
