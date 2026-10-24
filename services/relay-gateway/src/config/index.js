/**
 * Relay-gateway configuration, loaded once at boot.
 *
 * Version-pinned target set (FR-025): the per-chain target contract addresses are read from
 * the repo's `deployments/*-chain<ID>-v2.json` files — the platform's source of truth for
 * on-chain addresses. Startup performs a consistency check: every enabled chain MUST have a
 * deployment record with `wagerRegistry`, `membershipManager`, and `sanctionsGuard` addresses,
 * or the process exits non-zero (fail loudly — never run against a stale/unknown target).
 *
 * Env:
 *   ENABLED_CHAIN_IDS          comma list (default "137,80002,63" — 61's record has custody
 *                              contracts only (no wagerRegistry), so enabling it fails the
 *                              startup check by design until the full target set is pinned)
 *   RPC_URLS_<chainId>         comma list, failover order (default: built-in public pair, FR-007)
 *   RPC_URL_PRIMARY_<chainId>  ONE endpoint, PREPENDED to RPC_URLS_<chainId>. It exists so a
 *                              credential-bearing URL can be delivered from Secret Manager while
 *                              the public failover list stays readable in the compose file. Unset
 *                              => RPC_URLS_<chainId> is used exactly as written
 *   ORIGIN_AUTH_SECRET         origin-lock shared secret (X-Origin-Auth). Unset => lock DISABLED
 *                              (dev only; production must set it — research.md §4 / SC-016)
 *   WEBHOOK_SHARED_SECRET      engine webhook shared secret. Unset => webhook rejects everything (fail closed)
 *   ENGINE_URL                 OpenZeppelin Relayer base URL (default http://localhost:8080)
 *   ENGINE_API_KEY             optional bearer token for the engine API
 *   ENGINE_RELAYER_ID_<id>     engine relayer id per chain (default "<name>-<chainId>", e.g. polygon-137)
 *   KILL_SWITCH                'true' => boot with the kill switch active (FR-015)
 *   SIGNER_QUOTA_PER_MIN       per-signer intents/min (default 12)
 *   GLOBAL_QUOTA_PER_MIN       global intents/min (default 120)
 *   RATE_LIMIT_HEALTH_PER_MIN  outer per-IP limiter on /healthz + /status (default 600; 0 = off)
 *   RATE_LIMIT_INTENTS_PER_MIN outer per-IP limiter on POST /v1/intents (default 300; 0 = off)
 *   MAX_QUEUE_DEPTH            bounded in-flight queue (default 100) — back-pressure past this (FR-009)
 *   GAS_SPEND_CAP_WEI_<id>     per-chain per-window gas spend cap (default 0.5 native / hour, FR-014)
 *   SPEND_WINDOW_MS            spend-cap window (default 3600000)
 *   DEFAULT_GAS_LIMIT          fallback gas limit for estimates (default 300000)
 *   GAS_WALLET_<id>            hot gas wallet address (healthz runway only; the KEY lives in the engine)
 *   PEAK_BURN_WEI_PER_HR_<id>  runway divisor for healthz gasWalletRunwayHrs (default 0.05 native/hr)
 *   PORT                       HTTP port (default 8788)
 *   OPENSEA_API_KEY            OpenSea API v2 key for the read-only /v1/opensea/* proxy (spec 055).
 *                              Unset => those routes fail CLOSED with 503 collectibles_unconfigured
 *                              (the collectibles feature hides; nothing else is affected)
 *   OPENSEA_BASE_URL           OpenSea API base (default https://api.opensea.io)
 *   OPENSEA_TIMEOUT_MS         upstream request timeout (default 5000)
 *   OPENSEA_RETRIES            upstream retries on 5xx/transport (default 1)
 *   OPENSEA_CACHE_TTL_MS       list/detail response cache TTL (default 60000)
 *   OPENSEA_STATS_CACHE_TTL_MS collection-stats cache TTL (default 300000)
 *   OPENSEA_QUOTA_PER_ADDRESS  reads/min counted per requested address|contract|slug (default 60)
 *   OPENSEA_QUOTA_GLOBAL       reads/min across all callers (default 300)
 *   OPENSEA_QUOTA_WINDOW_MS    quota window (default 60000)
 *   OPENSEA_WRITE_QUOTA_PER_ADDRESS  sell-side writes/min per seller address (spec 056; default 20)
 *   OPENSEA_WRITE_QUOTA_GLOBAL       sell-side writes/min across all callers (default 100)
 *   OPENSEA_REFERRAL_ADDRESS   FairWins beneficiary of OpenSea's referral/affiliate reward (spec 056,
 *                              public address; unset => attribution off, a safe default). Never a surcharge.
 *   OPENSEA_REFERRAL_ADDRESS_<chainId>  per-network referral beneficiary override
 *   POLYMARKET_API_KEY         Polymarket CLOB API key for the /v1/polymarket/* Predict proxy (spec 057).
 *                              Unset => those routes fail CLOSED with 503 predict_unconfigured
 *                              (the Predict feature hides; nothing else is affected)
 *   POLYMARKET_BASE_URL        Polymarket CLOB base (default https://clob.polymarket.com)
 *   POLYMARKET_TIMEOUT_MS      upstream request timeout (default 5000)
 *   POLYMARKET_RETRIES         upstream retries on 5xx/transport for reads (default 1; writes never retry)
 *   POLYMARKET_CACHE_TTL_MS    market/fee read cache TTL (default 15000 — prices move fast)
 *   POLYMARKET_QUOTA_PER_ADDRESS reads/min counted per requested address (default 60)
 *   POLYMARKET_QUOTA_GLOBAL    reads/min across all callers (default 300)
 *   POLYMARKET_QUOTA_WINDOW_MS quota window (default 60000)
 *   POLYMARKET_WRITE_QUOTA_PER_ADDRESS order/cancel writes/min per trader address (default 20)
 *   POLYMARKET_WRITE_QUOTA_GLOBAL      order/cancel writes/min across all callers (default 100)
 *   POLYMARKET_BUILDER_CODE    FairWins bytes32 builder code (spec 057, public; unset => unattributed,
 *                              orders still post — never stranded). Attaches to every order for fee + rewards.
 *   POLYMARKET_BUILDER_TAKER_FEE_BPS  builder fee on taker orders (default 50; hard cap 100 — fails boot if over).
 *                              Since spec 060 this is the FALLBACK served when the FeeRouter is
 *                              unset/unreachable; the on-chain rate is the source of truth.
 *   POLYMARKET_BUILDER_MAKER_FEE_BPS  builder fee on maker orders (default 0; hard cap 50 — fails boot if over).
 *                              Fallback since spec 060, same as the taker fee.
 *   BTC_ENABLED                'true' enables the /v1/bitcoin/* proxy (spec 061). Default false =>
 *                              routes answer 503 bitcoin_disabled and the SPA soft-fails the capability
 *   BTC_ESPLORA_URL            Esplora-compatible mainnet upstream (default https://mempool.space/api;
 *                              swappable to blockstream.info or self-hosted electrs)
 *   BTC_ESPLORA_TESTNET_URL    Esplora-compatible testnet4 upstream (default https://mempool.space/testnet4/api)
 *   BTC_STAMPS_URL             stampchain.io-compatible Stamps indexer base. Unset => the stamps route
 *                              answers degraded:true and the client fail-safes (protects unverified coins)
 *   BTC_MAX_FEE_RATE           sat/vB clamp on fee responses (default 500; must be >= 1 when enabled)
 *   BTC_TIMEOUT_MS             upstream request timeout (default 5000)
 *   BTC_RETRIES                upstream retries on 5xx/transport for reads (default 1; broadcast never retries)
 *   BTC_QUOTA_PER_IP           reads/min per caller IP (default 60 — polymarket parity)
 *   BTC_QUOTA_GLOBAL           reads/min across all callers (default 300 — polymarket parity)
 *   BTC_QUOTA_WINDOW_MS        quota window (default 60000)
 *   BTC_WRITE_QUOTA_PER_IP     broadcasts/min per caller IP (default 20 — stricter than reads)
 *   BTC_WRITE_QUOTA_GLOBAL     broadcasts/min across all callers (default 100)
 *   BTC_KILLSWITCH             'true' => all /v1/bitcoin/* routes answer 503 bitcoin_killed (ops kill)
 *   BRIDGE_ENABLED             'true' enables the /v1/bridge/* Across proxy (spec 067). Default false =>
 *                              routes answer 503 bridge_disabled and the SPA hides the Bridge tab
 *   BRIDGE_API_URL             Across API base (default https://app.across.to/api)
 *   BRIDGE_CHAIN_IDS           comma list of chains bridging is offered between (default the spec-067
 *                              five: 1,10,137,8453,42161 — all carry an Across SpokePool)
 *   BRIDGE_TIMEOUT_MS          upstream request timeout (default 5000)
 *   BRIDGE_RETRIES             upstream retries on 5xx/transport (default 1; all routes are reads)
 *   BRIDGE_QUOTE_TTL_MS        quote cache TTL (default 10000 — single-flight only; a quote is NEVER
 *                              served stale, the route 503s instead)
 *   BRIDGE_STATUS_TTL_MS       deposit-status cache TTL (default 15000; stale IS served, marked)
 *   BRIDGE_QUOTA_PER_IP        reads/min per caller IP (default 60 — polymarket parity)
 *   BRIDGE_QUOTA_GLOBAL        reads/min across all callers (default 300)
 *   BRIDGE_QUOTA_WINDOW_MS     quota window (default 60000)
 *   BRIDGE_KILLSWITCH          'true' => all /v1/bridge/* routes answer 503 bridge_killed (ops kill)
 *   PERPS_ENABLED              'true' enables the /v1/perps/* read proxy (spec 082; default false)
 *   PERPS_GAINS_URL_*          Gains Network per-chain backends (ARBITRUM/BASE/POLYGON; '' disables one)
 *   PERPS_GAINS_PRICING_URL    Gains global pair-price snapshot host
 *   PERPS_GMX_URL              GMX v2 REST host (default arbitrum-api.gmxinfra.io); PERPS_GMX_CHAIN_ID
 *   PERPS_HL_URL               Hyperliquid public info API host
 *   PERPS_TIMEOUT_MS / PERPS_RETRIES / PERPS_CACHE_TTL_MS   read plumbing (defaults 8000/1/15000)
 *   PERPS_HL_DEX_LIST_TTL_MS / PERPS_HL_DEX_MAX   Hyperliquid perp-dex (HIP-3) fan-out: how long
 *                              the discovered dex list is cached (default 1h) and how many dexes
 *                              one read may fan out to (default 24). Dexes past the cap are NAMED
 *                              in sources.hyperliquid.unreadDexes, never silently dropped.
 *   PERPS_QUOTA_PER_IP/_GLOBAL/_WINDOW_MS   read quotas (defaults 60/300/60000)
 *   PERPS_KILLSWITCH           'true' => all /v1/perps/* routes answer 503 (ops kill)
 *   NEWS_ENABLED               'true' enables the /v1/news/* read proxy (spec 109; default false)
 *   NEWS_BASE_URL              Alphaday API host (keyless — no credential exists for this module)
 *   NEWS_CACHE_TTL_MS          per-slug cache TTL, clamped >= 300000 (the vendor's own cache floor)
 *   NEWS_TIMEOUT_MS / NEWS_RETRIES / NEWS_QUOTA_* / NEWS_KILLSWITCH   read plumbing (perps defaults)
 *   PERPS_GAINS_REFERRER       PUBLIC attribution: FairWins gains referrer address
 *   PERPS_GMX_REF_CODE         PUBLIC attribution: GMX referral code (1-20 [A-Za-z0-9_])
 *   PERPS_HL_BUILDER_ADDRESS   PUBLIC attribution: FairWins Hyperliquid builder wallet
 *   PERPS_HL_BUILDER_FEE_BPS   HL builder fee FALLBACK bps (live source: FeeRouter
 *                              perps.hyperliquid.builder). Boot fails above the 10 bps HL perps cap.
 *   MEMBER_API_ENABLED         'true' enables the /v1/member/* member API (spec 095; default false).
 *                              Disabled => every route answers 503 member_api_unconfigured, including
 *                              the OpenAPI document, so a client can tell "turned off" from "too old"
 *   MEMBER_API_KILLSWITCH      'true' => all /v1/member/* routes answer 503 member_api_killed (ops kill)
 *   MEMBER_API_MAX_TTL_DAYS    longest lifetime a member-signed key may claim (default 90). A grant
 *                              asking for more is refused with 401 token_ttl_exceeded. This is the
 *                              REAL bound on a leaked key: revocations are in-process (Phase 1) and do
 *                              not survive a restart, and every revocation answer says `durable:false`
 *   MEMBER_API_REFERENCE_CHAIN_ID  chain membership + ERC-1271 signature checks are read on. Defaults
 *                              to the first enabled chain with a membershipManager recorded. Membership
 *                              has ONE home per cohort — reading the caller's chain would let a testnet
 *                              answer stand in for a mainnet fact
 *   MEMBER_API_MEMBERSHIP_CACHE_MS  per-account membership cache (default 60000). Successes only —
 *                              caching a failure would turn one bad moment into a minute of them
 *   MEMBER_API_CLOCK_SKEW_SEC  tolerance for a client clock ahead of ours (default 300)
 *   MEMBER_API_REVOCATION_MAX  revocation records held in memory (default 50000)
 *   MEMBER_API_SUBGRAPH_<chainId>  wager indexer (The Graph) endpoint per chain. UNSET => that chain
 *                              answers `not-configured` — which is NOT an empty wager list; the
 *                              question was never asked
 *   MEMBER_API_TIMEOUT_MS      upstream (subgraph) request timeout (default 5000)
 *   MEMBER_API_QUOTA_PER_ACCOUNT / _GLOBAL / _WINDOW_MS   read quotas keyed by the RECOVERED account
 *                              (defaults 120/600/60000) — not by IP, which is the proxy in production
 *   MEMBER_API_PUBLIC_QUOTA    requests/window for the UNAUTHENTICATED routes, in a window of their
 *                              own (default 240). Separate from the authenticated global on purpose:
 *                              `trust proxy` is unset, so anonymous callers all key to the nginx IP,
 *                              and sharing one global let a flood of them lock every member out
 *   MEMBER_API_REVOKE_QUOTA    requests/window for POST /v1/member/keys/revoke ALONE (default 60).
 *                              An emergency control with a budget nothing else can spend — a member
 *                              withdraws a leaked key exactly when this module may be under load
 *   ASSISTANT_ENABLED          'true' enables POST /v1/member/assistant/chat (default false)
 *   ANTHROPIC_API_KEY          SECRET. Model-provider credential for the assistant. Unset => that one
 *                              route answers 503 assistant_unconfigured; nothing else is affected
 *   ASSISTANT_BASE_URL         model provider base (default https://api.anthropic.com)
 *   ASSISTANT_MODEL            model id (default claude-sonnet-5)
 *   ASSISTANT_MAX_TOKENS       per-turn output ceiling (default 1024). HARD-CAPPED at 4096 in code —
 *                              boot fails above it. This is the only bound on what one request can
 *                              cost, so it is not something an env file may raise without limit
 *   ASSISTANT_MAX_ROUNDS       tool rounds per member turn (default 4; spec 104). HARD-CAPPED at 8 in
 *                              code — the browser runs the tool loop and each round is its own
 *                              request here, so this multiplies what one question can cost. Exported
 *                              on /status as memberApi.assistant.maxRounds
 *   ASSISTANT_TIMEOUT_MS       upstream request timeout (default 30000)
 *   ASSISTANT_QUOTA_PER_ACCOUNT / _GLOBAL   model calls/window, in a class of their own, tighter than
 *                              the module's general read quota (defaults 20/60). A read and a model
 *                              call are not the same permission, so they are not the same budget
 *   ASSISTANT_TOKEN_BUDGET_PER_ACCOUNT / _GLOBAL / _WINDOW_MS   the ceiling on MONEY rather than
 *                              traffic (defaults 200000 / 2000000 tokens per 3600000 ms). Request
 *                              counts are a poor proxy for spend; these count the thing that is
 *                              billed. A turn RESERVES its worst case up front and settles down to
 *                              the measured usage, so requests already in flight cannot overshoot.
 *                              Exhausted => 429 assistant_budget_exhausted, never a truncated reply
 *                              and never a 500. Boot refuses a per-account budget below one turn
 *   X402_ENABLED               'true' enables the x402 pay-per-request rail on the member API's PRICED
 *                              operations (spec 096; default false). Disabled => byte-identical
 *                              behaviour to a pre-096 gateway: an unauthenticated priced request
 *                              answers 401 exactly as before, and nothing ever answers 402
 *   X402_KILLSWITCH            'true' => the paid rail stops being OFFERED (ops kill). Member bearer
 *                              requests are unaffected — they were never charged in the first place
 *   X402_CHAIN_ID              chain payments are signed on and settled on. MUST be an enabled chain
 *                              that supports EIP-3009 (a recorded paymentToken + a token EIP-712
 *                              domain) — boot fails otherwise, because a rail that can never settle
 *                              must not advertise a price. Defaults to the first enabled such chain
 *   X402_PAY_TO                the platform treasury every payment is made to. REQUIRED when enabled,
 *                              with NO DEFAULT ON PURPOSE: a defaulted treasury address would send
 *                              agents' money somewhere nobody chose
 *   X402_SETTLE_BUFFER_SECONDS how much validity an authorization must have LEFT to be accepted
 *                              (default 60). One that expires mid-settlement would be accepted here
 *                              and refused by the token — refusing it now costs the payer nothing
 *   X402_MAX_TIMEOUT_SECONDS   `maxTimeoutSeconds` published in the 402 offer (default 300)
 *   X402_PRICE_READ            price of a priced READ op, in USDC base units (default 10000 = $0.01)
 *   X402_PRICE_BUILD           price of a typed-data BUILD (default 50000 = $0.05)
 *   X402_PRICE_ASSISTANT       price of one assistant message (default 100000 = $0.10)
 *                              EACH PRICE AT 0 MEANS "NOT OFFERED", never "free": that op class is
 *                              simply absent from the paid rail and answers 401 as it does today
 *   X402_NONCE_MAX             bound on the in-process replay set (default 50000). Phase 1: the
 *                              TOKEN's own authorization state is the real uniqueness guarantee — a
 *                              replay reverts on chain — so this only saves the gas of finding out
 *   FEE_ROUTER_ADDRESS         FeeRouter proxy (spec 060) serving the LIVE polymarket.taker/.maker bps.
 *                              Defaults to the deployment record's feeRouter for FEE_ROUTER_CHAIN_ID;
 *                              a set value that CONTRADICTS the record fails boot loudly. Unset and not
 *                              in the record => env-fallback mode (pre-060 behavior).
 *   FEE_ROUTER_CHAIN_ID        chain the FeeRouter is read on (default 137)
 *   FEE_ROUTER_CACHE_TTL_MS    on-chain rate cache TTL (default 30000 — bounds admin-change latency)
 *
 * The gateway NEVER holds the gas key — that is the engine's (Secret-Manager-held) concern.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHAIN_DEFS } from './chains.js'
import { actionsForContract } from '../intent/intentTypes.js'
import { MAX_ROUNDS_CEILING, MAX_TOKENS_CEILING, MAX_TOOL_ROUNDS, maxTurnTokens } from '../memberApi/assistant.js'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_DEPLOYMENTS_DIR = path.resolve(__dirname, '../../../../deployments')

function opt(env, name, fallback) {
  const v = env[name]
  return v == null || String(v).trim() === '' ? fallback : String(v).trim()
}

function int(env, name, fallback) {
  const v = opt(env, name, undefined)
  if (v == null) return fallback
  const n = Number.parseInt(v, 10)
  if (!Number.isInteger(n) || n < 0) throw new Error(`[relay-gateway] invalid integer env ${name}=${v}`)
  return n
}

function bigInt(env, name, fallback) {
  const v = opt(env, name, undefined)
  if (v == null) return fallback
  try {
    return BigInt(v)
  } catch {
    throw new Error(`[relay-gateway] invalid bigint env ${name}=${v}`)
  }
}

/** Locate + parse the deployment record for a chain (source of truth for addresses). */
function loadDeployment(deploymentsDir, chainId) {
  let entries
  try {
    entries = fs.readdirSync(deploymentsDir)
  } catch (e) {
    throw new Error(`[relay-gateway] cannot read deployments dir ${deploymentsDir}: ${e.message}`)
  }
  const file = entries.find((f) => f.endsWith(`-chain${chainId}-v2.json`))
  if (!file) return null
  const parsed = JSON.parse(fs.readFileSync(path.join(deploymentsDir, file), 'utf8'))
  return { file: path.join(deploymentsDir, file), ...parsed }
}

/**
 * Build the validated config. Throws (=> non-zero exit at boot) on any inconsistency between
 * the enabled chains and the deployments records — FR-025's startup consistency check.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{deploymentsDir?: string}} [opts]
 */
export function loadConfig(env = process.env, opts = {}) {
  // Tenant scope (spec 072, T023): one gateway process serves ONE tenant.
  // TENANT_ID resolves the records dir to the tenant's dedicated estate
  // (deployments/tenants/<id>/, same schema) — the FR-025 allowlist below then
  // IS the tenant boundary: an intent targeting another tenant's contracts is
  // refused because those addresses are simply not in this process's records.
  // Unset (or the default tenant) reads the shared estate, exactly as before.
  const tenantId = opt(env, 'TENANT_ID', '')
  if (tenantId && !/^[a-z][a-z0-9-]{1,30}$/.test(tenantId)) {
    throw new Error(`[relay-gateway] invalid TENANT_ID "${tenantId}" — must match ^[a-z][a-z0-9-]{1,30}$`)
  }
  const tenantScoped = Boolean(tenantId) && tenantId !== 'fairwins'
  const defaultDir = tenantScoped
    ? path.join(DEFAULT_DEPLOYMENTS_DIR, 'tenants', tenantId)
    : DEFAULT_DEPLOYMENTS_DIR
  const deploymentsDir = opts.deploymentsDir || opt(env, 'DEPLOYMENTS_DIR', defaultDir)

  const enabledChainIds = opt(env, 'ENABLED_CHAIN_IDS', '137,80002,63')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number.parseInt(s, 10)
      if (!Number.isInteger(n) || n <= 0) throw new Error(`[relay-gateway] invalid chainId in ENABLED_CHAIN_IDS: ${s}`)
      return n
    })
  if (enabledChainIds.length === 0) throw new Error('[relay-gateway] ENABLED_CHAIN_IDS must list at least one chainId')

  const chains = {}
  for (const chainId of enabledChainIds) {
    const def = CHAIN_DEFS[chainId]
    if (!def) {
      throw new Error(
        `[relay-gateway] chainId ${chainId} is not a supported network (supported: ${Object.keys(CHAIN_DEFS).join(', ')})`
      )
    }

    // --- FR-025 startup consistency check: pin targets to the recorded deployment ---
    const deployment = loadDeployment(deploymentsDir, chainId)
    if (!deployment) {
      throw new Error(
        `[relay-gateway] no deployment record (*-chain${chainId}-v2.json) in ${deploymentsDir} for enabled chain ${chainId}. ` +
          'Refusing to start: target addresses must be version-pinned to deployments/ (FR-025).'
      )
    }
    if (Number(deployment.chainId) !== chainId) {
      throw new Error(`[relay-gateway] ${deployment.file} declares chainId ${deployment.chainId}, expected ${chainId}`)
    }
    const c = deployment.contracts || {}
    for (const key of ['wagerRegistry', 'membershipManager', 'sanctionsGuard']) {
      if (!ADDRESS_RE.test(c[key] || '')) {
        throw new Error(
          `[relay-gateway] deployment record for chain ${chainId} (${deployment.file}) is missing a valid "${key}" address — ` +
            'cannot pin the target set (FR-025).'
        )
      }
    }
    if (def.paymentSupported && !ADDRESS_RE.test(deployment.paymentToken || '')) {
      throw new Error(
        `[relay-gateway] chain ${chainId} is payment-enabled but the deployment record has no paymentToken address`
      )
    }

    // Version-pinned target map: address (lowercase) -> { key, allowedActions }
    const targets = {
      [c.wagerRegistry.toLowerCase()]: { key: 'wagerRegistry', address: c.wagerRegistry, allowedActions: actionsForContract('wagerRegistry') },
      [c.membershipManager.toLowerCase()]: { key: 'membershipManager', address: c.membershipManager, allowedActions: actionsForContract('membershipManager') },
    }
    const targetsByKey = { wagerRegistry: c.wagerRegistry, membershipManager: c.membershipManager }

    // Tier-2 group pools (spec 035/036) are OPTIONAL per chain: only pin the WagerPoolFactory where the
    // deployment record has one (Mordor/Polygon), so chains without pools still boot (pool actions there
    // just self-submit). The factory is the only pool target the engine whitelists — clones are reached
    // via its forwarders and proven on-chain (poolAddressToId), so no clone address is ever pinned.
    if (ADDRESS_RE.test(c.wagerPoolFactory || '')) {
      targets[c.wagerPoolFactory.toLowerCase()] = {
        key: 'wagerPoolFactory',
        address: c.wagerPoolFactory,
        allowedActions: actionsForContract('wagerPoolFactory'),
      }
      targetsByKey.wagerPoolFactory = c.wagerPoolFactory
    }

    const listedRpcUrls = opt(env, `RPC_URLS_${chainId}`, def.defaultRpcUrls.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    // A credential-bearing primary, delivered by fetch-secrets.sh rather than written into the
    // compose file. Prepending it (instead of replacing the list) is what keeps FR-007 true: the
    // public endpoints stay behind it as failover, so a keyed endpoint rate-limiting or expiring
    // degrades to a slower route rather than taking the chain down.
    //
    // De-duplicated, because the same URL appearing twice is not two independent endpoints — it is
    // one endpoint that would be retried against itself and would make the `< 2` warning below lie.
    const primaryRpcUrl = opt(env, `RPC_URL_PRIMARY_${chainId}`, null)
    const rpcUrls = primaryRpcUrl
      ? [primaryRpcUrl, ...listedRpcUrls.filter((u) => u !== primaryRpcUrl)]
      : listedRpcUrls
    if (rpcUrls.length === 0) throw new Error(`[relay-gateway] RPC_URLS_${chainId} must list at least one endpoint`)
    if (rpcUrls.length < 2) {
      // FR-007 wants >=2 independent endpoints; tolerate 1 for local dev but say so loudly.
      console.warn(`[relay-gateway] WARN chain ${chainId}: only 1 RPC endpoint configured; FR-007 expects >=2 for failover`)
    }

    const gasWallet = opt(env, `GAS_WALLET_${chainId}`, null)
    if (gasWallet && !ADDRESS_RE.test(gasWallet)) throw new Error(`[relay-gateway] GAS_WALLET_${chainId} is not an address`)

    chains[chainId] = {
      chainId,
      name: def.name,
      gasType: def.gasType,
      noBatch: def.noBatch,
      paymentSupported: def.paymentSupported,
      tokenDomain: def.paymentSupported
        ? {
            name: opt(env, `TOKEN_DOMAIN_NAME_${chainId}`, def.tokenDomain.name),
            version: opt(env, `TOKEN_DOMAIN_VERSION_${chainId}`, def.tokenDomain.version),
          }
        : null,
      paymentToken: deployment.paymentToken || null,
      sanctionsGuard: c.sanctionsGuard,
      targets,
      targetsByKey,
      rpcUrls,
      fundingMode: opt(env, `FUNDING_MODE_${chainId}`, 'sponsored'), // 'sponsored' | 'fee-netted'
      gasSpendCapWei: bigInt(env, `GAS_SPEND_CAP_WEI_${chainId}`, 500_000_000_000_000_000n), // 0.5 native / window
      gasPriceFallbackWei: def.gasPriceFallbackWei,
      gasWallet,
      peakBurnWeiPerHour: bigInt(env, `PEAK_BURN_WEI_PER_HR_${chainId}`, 50_000_000_000_000_000n), // 0.05 native/hr
      engineRelayerId: opt(env, `ENGINE_RELAYER_ID_${chainId}`, `${def.name}-${chainId}`),
      deploymentFile: deployment.file,
      // Sponsored-paymaster (spec 050): set PER CHAIN, so sponsorship is enabled ONLY where a
      // paymaster is deployed (e.g. Polygon-only = set PAYMASTER_ADDRESS_137 alone). null => the
      // /v1/paymaster endpoint refuses this chain and the SPA self-funds (never-stranded).
      paymaster: (() => {
        const addr = opt(env, `PAYMASTER_ADDRESS_${chainId}`, null)
        if (!addr) return null
        if (!ADDRESS_RE.test(addr)) throw new Error(`[relay-gateway] PAYMASTER_ADDRESS_${chainId} is not an address`)
        return {
          address: addr,
          entryPoint: opt(env, `ENTRYPOINT_V06_${chainId}`, '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789'),
        }
      })(),
    }
  }

  return {
    // Tenant this process serves (spec 072). null = the shared/default estate.
    tenantId: tenantScoped ? tenantId : null,
    deploymentsDir,
    enabledChainIds,
    chains,
    port: int(env, 'PORT', 8788),
    originAuthSecret: opt(env, 'ORIGIN_AUTH_SECRET', null),
    // Operator-only disclosure secret (#1505). The origin lock CANNOT serve this purpose: the
    // zone-wide Transform Rule injects X-Origin-Auth on EVERY request, so "behind the edge gate"
    // means "not readable on the raw origin IP" and public to everyone else. This is a separate
    // INBOUND, operator-held secret. Unset means the fields it guards are absent for everyone —
    // honest, and never a silent fallback to public.
    opsStatusSecret: opt(env, 'OPS_STATUS_SECRET', null),
    webhookSecret: opt(env, 'WEBHOOK_SHARED_SECRET', null),
    // Browser origins allowed to call the gateway cross-origin (CORS). The SPA lives on a different
    // host than the relay subdomain (fairwins.app -> relay.fairwins.app), so it needs an explicit
    // allow-list. Comma-separated; unset => no CORS headers (same-origin / server-to-server only).
    allowedOrigins: (() => {
      const configured = opt(env, 'ALLOWED_ORIGINS', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      // The native shells (spec 102/103) are NOT on https://fairwins.app. Capacitor serves the
      // bundle from `capacitor://localhost` (iOS) and `https://localhost` (Android), and the
      // WebView's fetch is subject to CORS like any browser's. Without these, the CORS middleware
      // emits no Access-Control-Allow-* at all for a shell, so a native caller cannot send the
      // Authorization header — which would put spec 106's member-grant requirement on Bitcoin
      // broadcast (a passkey-only, native-bridged flow) onto a channel physically unable to carry
      // a credential. They are appended rather than defaulted so an explicit ALLOWED_ORIGINS still
      // gets them; an operator who genuinely wants web-only must remove them here, deliberately.
      const NATIVE_SHELL_ORIGINS = ['capacitor://localhost', 'https://localhost']
      return [...new Set([...configured, ...(configured.length ? NATIVE_SHELL_ORIGINS : [])])]
    })(),
    // --- Caller identity (spec 106) ---
    // Unset/false => the layer is INERT: every caller resolves anonymous, no status changes, and
    // the state is disclosed at boot and in the gated /status. FR-015 — a disabled control must
    // never be indistinguishable from an enforcing one.
    identity: {
      enabled: opt(env, 'IDENTITY_ENABLED', 'false').toLowerCase() === 'true',
      // SEPARATE from `enabled`, deliberately. `enabled` without `enforce` is OBSERVE mode: the
      // tier resolves and is reported, and no status code changes — so the model can be validated
      // against real traffic before anything depends on it. A safety layer that starts refusing the
      // moment it deploys fails in the shape "the product is broken", which is the worst way for
      // this particular change to be wrong.
      enforce: opt(env, 'IDENTITY_ENFORCE', 'false').toLowerCase() === 'true',
      killswitch: opt(env, 'IDENTITY_KILLSWITCH', 'false').toLowerCase() === 'true',
      // Per-upstream ceilings (FR-013), checked BEFORE the outbound call. UNSET = UNLIMITED, and
      // that absence is honest rather than a hidden default: inventing a cap an operator did not
      // choose would refuse traffic in the name of a budget nobody set.
      upstreamCeilings: {
        opensea: int(env, 'UPSTREAM_CEILING_OPENSEA', 0),
        polymarket: int(env, 'UPSTREAM_CEILING_POLYMARKET', 0),
        bitcoin: int(env, 'UPSTREAM_CEILING_BITCOIN', 0),
        perps: int(env, 'UPSTREAM_CEILING_PERPS', 0),
        bridge: int(env, 'UPSTREAM_CEILING_BRIDGE', 0),
      },
      upstreamCeilingWindowMs: int(env, 'UPSTREAM_CEILING_WINDOW_MS', 60_000),
      challenge: {
        // Unset => the challenge verifier ABSTAINS (returns `absent`), never rejects. An
        // unconfigured bot-check must not deny every anonymous caller.
        secret: (() => {
          const secret = opt(env, 'CHALLENGE_SECRET', null)
          // Cloudflare's PUBLISHED test secrets always pass (1x…) or always fail (2x…/3x…).
          // In development they are the right tool; in production the always-pass one turns the
          // human tier into a stamp anyone can print — a mock in a shipped path (constitution
          // III), invisible in every log. Boot refuses rather than warns: a warning here is a
          // production incident someone reads later (T014).
          const TEST_SECRETS = [
            '1x0000000000000000000000000000000AA',
            '2x0000000000000000000000000000000AA',
            '3x0000000000000000000000000000000AA',
          ]
          if (secret && TEST_SECRETS.includes(secret) && env.NODE_ENV === 'production') {
            throw new Error(
              'CHALLENGE_SECRET is a published Turnstile TEST secret; in production this makes the human tier a mock. Configure a real secret or unset it.'
            )
          }
          return secret
        })(),
        verifyUrl: opt(env, 'CHALLENGE_VERIFY_URL', 'https://challenges.cloudflare.com/turnstile/v0/siteverify'),
        ttlSec: int(env, 'CHALLENGE_TTL_SEC', 900),
        timeoutMs: int(env, 'CHALLENGE_TIMEOUT_MS', 3000),
      },
    },
    // --- Keyed RPC access issuance (spec 107) ---
    // DORMANT until an endpoint pair, a signing key and the admin credential are all present; the
    // module mounts regardless and answers 503 access_unconfigured, so absence stays honest.
    // RPC_ACCESS_SIGNING_KEY is KEY MATERIAL (spec 097 rule 3): it arrives from Secret Manager via
    // fetch-secrets.sh and must never be committed, logged, or echoed.
    rpcAccess: (() => {
      const endpoints = {}
      for (const key of Object.keys(env)) {
        const m = key.match(/^RPC_ACCESS_ENDPOINT_URL_(\d+)$/)
        if (!m) continue
        const chainId = Number(m[1])
        const url = String(env[key]).trim()
        const id = opt(env, `RPC_ACCESS_ENDPOINT_ID_${chainId}`, null)
        // A URL without its admin-API id is refused AS A PAIR: without the id the FR-026
        // enforcement check cannot run, and serving that endpoint would mean transmitting a
        // credential whose protection was never confirmed.
        if (url && id) endpoints[chainId] = { url, id: String(id).trim() }
      }
      return {
        enabled: opt(env, 'RPC_ACCESS_ENABLED', 'false').toLowerCase() === 'true',
        killswitch: opt(env, 'RPC_ACCESS_KILLSWITCH', 'false').toLowerCase() === 'true',
        signingKeyPem: opt(env, 'RPC_ACCESS_SIGNING_KEY', null),
        kid: opt(env, 'RPC_ACCESS_SIGNING_KID', null),
        adminKey: opt(env, 'RPC_ACCESS_ADMIN_KEY', null),
        adminBaseUrl: opt(env, 'RPC_ACCESS_ADMIN_URL', 'https://api.quicknode.com'),
        endpoints,
        // Tier shapes LIFETIME, never whether (FR-022): anonymous mints short and re-mints often,
        // which is itself the metering pressure that makes proving something worthwhile.
        ttlSecByTier: {
          anonymous: int(env, 'RPC_ACCESS_TTL_ANONYMOUS_SEC', 300),
          human: int(env, 'RPC_ACCESS_TTL_HUMAN_SEC', 900),
          address: int(env, 'RPC_ACCESS_TTL_ADDRESS_SEC', 900),
          member: int(env, 'RPC_ACCESS_TTL_MEMBER_SEC', 1800),
        },
        maxTtlSec: int(env, 'RPC_ACCESS_MAX_TTL_SEC', 3600),
        mintQuotaPerSubject: int(env, 'RPC_ACCESS_MINT_QUOTA_PER_SUBJECT', 12),
        mintQuotaGlobal: int(env, 'RPC_ACCESS_MINT_QUOTA_GLOBAL', 600),
        mintQuotaWindowMs: int(env, 'RPC_ACCESS_MINT_QUOTA_WINDOW_MS', 60_000),
        enforcementCacheTtlMs: int(env, 'RPC_ACCESS_ENFORCEMENT_CACHE_MS', 60_000),
        adminTimeoutMs: int(env, 'RPC_ACCESS_ADMIN_TIMEOUT_MS', 5000),
      }
    })(),
    engine: {
      url: opt(env, 'ENGINE_URL', 'http://localhost:8080'),
      apiKey: opt(env, 'ENGINE_API_KEY', null),
      timeoutMs: int(env, 'ENGINE_TIMEOUT_MS', 5000),
      retries: int(env, 'ENGINE_RETRIES', 2),
    },
    killSwitch: opt(env, 'KILL_SWITCH', 'false').toLowerCase() === 'true',
    // SIGHUP re-reads allowlisted operational switches from this file (spec 106 FR-014, #1446).
    // Unset => SIGHUP answers honestly that nothing can reload. The process env is frozen at
    // exec, which is why the source is a FILE — the same mounted env file the deploy delivers.
    reloadEnvFile: opt(env, 'RELOAD_ENV_FILE', null),
    // Counters endpoint for the FinOps exporter (spec 106/#1447). 0/unset = off. The compose file
    // must NEVER publish this port to the host — it is compose-network-internal by design.
    metricsPort: int(env, 'METRICS_PORT', 0),
    quotas: {
      signerPerWindow: int(env, 'SIGNER_QUOTA_PER_MIN', 12),
      globalPerWindow: int(env, 'GLOBAL_QUOTA_PER_MIN', 120),
      windowMs: int(env, 'QUOTA_WINDOW_MS', 60_000),
    },
    // Coarse per-IP route limiters (express-rate-limit) in FRONT of the fine-grained quotas above.
    // The quotas remain the real per-member control (they key on the RECOVERED SIGNER, which an
    // attacker cannot vary for free); these middlewares are an outer DoS bound on the routes that
    // do work before any quota can key — the health snapshot's edge-auth comparison and the intent
    // pipeline's signature recovery. NOTE the production caveat from the module docs: `trust proxy`
    // is deliberately unset and nginx fronts the VM container, so `req.ip` is the proxy there and
    // each limiter is effectively an AGGREGATE ceiling — defaults are sized for that, and set to 0
    // to disable a limiter entirely.
    rateLimit: {
      healthPerMin: int(env, 'RATE_LIMIT_HEALTH_PER_MIN', 600),
      intentsPerMin: int(env, 'RATE_LIMIT_INTENTS_PER_MIN', 300),
    },
    // Sponsored-paymaster (spec 050): sponsorship signer + per-op ceilings + burst quotas. The
    // killswitch and sanctions screen are shared with the intent path; these are the paymaster-only
    // knobs. Signer: dev/CI uses PM_SIGNER_PRIVATE_KEY (never a prod secret); prod uses the KMS key.
    paymaster: {
      signerPrivateKey: opt(env, 'PM_SIGNER_PRIVATE_KEY', null),
      kmsKeyName: opt(env, 'PM_SIGNER_KMS_KEY', null),
      maxCostWei: bigInt(env, 'PM_MAX_COST_WEI', 2_000_000_000_000_000_000n), // 2 native / op ceiling
      maxGas: BigInt(int(env, 'PM_MAX_GAS', 3_000_000)),
      approvalTtlSec: int(env, 'PM_APPROVAL_TTL_SEC', 180),
      accountPerWindow: int(env, 'PM_ACCOUNT_QUOTA_PER_MIN', 6),
      globalPerWindow: int(env, 'PM_GLOBAL_QUOTA_PER_MIN', 60),
      windowMs: int(env, 'PM_QUOTA_WINDOW_MS', 60_000),
      runwayWarnHrs: int(env, 'PM_RUNWAY_WARN_HRS', 48),
    },
    // OpenSea proxy (spec 055 read-only + spec 056 sell-side): optional like the paymaster — no key
    // means the /v1/opensea/* routes 503 fail-closed and the SPA hides the feature; boot is unaffected
    // (the collectibles surface must never couple to the value paths).
    opensea: {
      apiKey: opt(env, 'OPENSEA_API_KEY', null),
      baseUrl: opt(env, 'OPENSEA_BASE_URL', 'https://api.opensea.io'),
      timeoutMs: int(env, 'OPENSEA_TIMEOUT_MS', 5000),
      retries: int(env, 'OPENSEA_RETRIES', 1),
      cacheTtlMs: int(env, 'OPENSEA_CACHE_TTL_MS', 60_000),
      statsCacheTtlMs: int(env, 'OPENSEA_STATS_CACHE_TTL_MS', 300_000),
      quotaPerAddress: int(env, 'OPENSEA_QUOTA_PER_ADDRESS', 60),
      quotaGlobal: int(env, 'OPENSEA_QUOTA_GLOBAL', 300),
      quotaWindowMs: int(env, 'OPENSEA_QUOTA_WINDOW_MS', 60_000),
      // Sell-side writes (spec 056): tighter, separate quota so publishing a listing can't drain the
      // shared key's read budget; keyed by the seller's account address.
      writeQuotaPerAddress: int(env, 'OPENSEA_WRITE_QUOTA_PER_ADDRESS', 20),
      writeQuotaGlobal: int(env, 'OPENSEA_WRITE_QUOTA_GLOBAL', 100),
      // FairWins referral/affiliate beneficiary (spec 056). Public address (validated if set); a
      // per-chain override wins over the global. Unset => attribution disabled (safe default). This is
      // OpenSea's own reward, never a FairWins surcharge (FR-013/FR-015).
      referralAddress: (() => {
        const a = opt(env, 'OPENSEA_REFERRAL_ADDRESS', null)
        if (a && !ADDRESS_RE.test(a)) throw new Error(`[relay-gateway] OPENSEA_REFERRAL_ADDRESS is not an address`)
        return a
      })(),
      referralAddressByChain: (() => {
        const map = {}
        for (const chainId of [1, 137]) {
          const a = opt(env, `OPENSEA_REFERRAL_ADDRESS_${chainId}`, null)
          if (a && !ADDRESS_RE.test(a)) throw new Error(`[relay-gateway] OPENSEA_REFERRAL_ADDRESS_${chainId} is not an address`)
          if (a) map[chainId] = a
        }
        return map
      })(),
    },
    // Polymarket / Predict proxy (spec 057): optional like the OpenSea proxy — no key means the
    // /v1/polymarket/* routes 503 fail-closed and the SPA hides the Predict tab; boot is unaffected
    // (Predict must never couple to the value paths). Polygon-only (Polymarket runs only on 137).
    polymarket: {
      apiKey: opt(env, 'POLYMARKET_API_KEY', null),
      // FairWins BUILDER credentials (key/secret/passphrase) from the Polymarket builder page — NOT
      // per-user trading creds. They sign the POLY_BUILDER_* attribution headers at /builder-sign so
      // orders routed through FairWins credit our builder profile. They CANNOT place orders: CLOB V2
      // binds every order to its signer, so each member submits browser->CLOB with their OWN derived L2
      // creds (the gateway never sees those). Absent => /builder-sign 503s and orders post unattributed.
      apiSecret: opt(env, 'POLYMARKET_API_SECRET', null),
      apiPassphrase: opt(env, 'POLYMARKET_API_PASSPHRASE', null),
      // The builder wallet the creds belong to (public); validated if set. Informational only — the
      // builder HMAC uses key/secret/passphrase, not this address.
      apiAddress: (() => {
        const a = opt(env, 'POLYMARKET_API_ADDRESS', null)
        if (a && !ADDRESS_RE.test(a)) throw new Error(`[relay-gateway] POLYMARKET_API_ADDRESS is not an address`)
        return a
      })(),
      baseUrl: opt(env, 'POLYMARKET_BASE_URL', 'https://clob.polymarket.com'),
      // Polymarket splits across three public hosts: the CLOB (orders/fees/auth), the Gamma API
      // (market discovery + search), and the Data API (positions). Browse hits Gamma, positions hit
      // Data — both public (no L2 creds); only the CLOB path is authed.
      gammaBaseUrl: opt(env, 'POLYMARKET_GAMMA_URL', 'https://gamma-api.polymarket.com'),
      dataBaseUrl: opt(env, 'POLYMARKET_DATA_URL', 'https://data-api.polymarket.com'),
      timeoutMs: int(env, 'POLYMARKET_TIMEOUT_MS', 5000),
      retries: int(env, 'POLYMARKET_RETRIES', 1),
      cacheTtlMs: int(env, 'POLYMARKET_CACHE_TTL_MS', 15_000),
      quotaPerAddress: int(env, 'POLYMARKET_QUOTA_PER_ADDRESS', 60),
      quotaGlobal: int(env, 'POLYMARKET_QUOTA_GLOBAL', 300),
      quotaWindowMs: int(env, 'POLYMARKET_QUOTA_WINDOW_MS', 60_000),
      // Order/cancel writes: tighter, separate quota keyed by the trader's address so submitting an
      // order can't drain the shared key's read budget.
      writeQuotaPerAddress: int(env, 'POLYMARKET_WRITE_QUOTA_PER_ADDRESS', 20),
      writeQuotaGlobal: int(env, 'POLYMARKET_WRITE_QUOTA_GLOBAL', 100),
      // FairWins builder code (spec 057). Public bytes32 (validated if set); unset => attribution off
      // and orders post UNATTRIBUTED rather than being blocked (never-stranded, FR-015).
      builderCode: (() => {
        const c = opt(env, 'POLYMARKET_BUILDER_CODE', null)
        if (c && !BYTES32_RE.test(c)) throw new Error(`[relay-gateway] POLYMARKET_BUILDER_CODE must be a 32-byte hex (bytes32)`)
        return c
      })(),
      // Builder fee, additive on top of Polymarket's platform taker fee (a REAL user cost, unlike the
      // OpenSea referral). Config, never hardcoded in the client. Hard-capped at Polymarket's limits
      // (100 bps taker / 50 bps maker) — an out-of-range value fails boot loudly (FR-014/SC-010).
      takerFeeBps: (() => {
        const bps = int(env, 'POLYMARKET_BUILDER_TAKER_FEE_BPS', 50)
        if (bps > 100) throw new Error(`[relay-gateway] POLYMARKET_BUILDER_TAKER_FEE_BPS=${bps} exceeds the 100 bps cap`)
        return bps
      })(),
      makerFeeBps: (() => {
        const bps = int(env, 'POLYMARKET_BUILDER_MAKER_FEE_BPS', 0)
        if (bps > 50) throw new Error(`[relay-gateway] POLYMARKET_BUILDER_MAKER_FEE_BPS=${bps} exceeds the 50 bps cap`)
        return bps
      })(),
    },
    // Bitcoin proxy (spec 061): optional like the OpenSea/Polymarket proxies — disabled means the
    // /v1/bitcoin/* routes 503 fail-closed (bitcoin_disabled) and the SPA soft-fails the capability;
    // boot is unaffected. Fail-loud validation applies only when the module is ENABLED: a malformed
    // upstream URL or a nonsensical fee clamp must stop the boot rather than serve garbage
    // (same philosophy as the polymarket fee-cap boot check).
    bitcoin: (() => {
      const enabled = opt(env, 'BTC_ENABLED', 'false').toLowerCase() === 'true'
      const esploraUrl = opt(env, 'BTC_ESPLORA_URL', 'https://mempool.space/api')
      const esploraTestnetUrl = opt(env, 'BTC_ESPLORA_TESTNET_URL', 'https://mempool.space/testnet4/api')
      const stampsUrl = opt(env, 'BTC_STAMPS_URL', null)
      const maxFeeRate = int(env, 'BTC_MAX_FEE_RATE', 500)
      if (enabled) {
        const urls = [
          ['BTC_ESPLORA_URL', esploraUrl],
          ['BTC_ESPLORA_TESTNET_URL', esploraTestnetUrl],
          ...(stampsUrl ? [['BTC_STAMPS_URL', stampsUrl]] : []),
        ]
        for (const [name, url] of urls) {
          let ok = false
          try {
            ok = ['http:', 'https:'].includes(new URL(url).protocol)
          } catch {
            ok = false
          }
          if (!ok) throw new Error(`[relay-gateway] ${name}=${url} is not a valid http(s) URL`)
        }
        // Clamp sanity (contract: min >= 1, max >= min; the lower bound is the fixed 1 sat/vB floor).
        if (maxFeeRate < 1) throw new Error(`[relay-gateway] BTC_MAX_FEE_RATE=${maxFeeRate} must be >= 1 sat/vB`)
      }
      return {
        enabled,
        esploraUrl,
        esploraTestnetUrl,
        stampsUrl,
        maxFeeRate,
        timeoutMs: int(env, 'BTC_TIMEOUT_MS', 5000),
        retries: int(env, 'BTC_RETRIES', 1),
        quotaPerIp: int(env, 'BTC_QUOTA_PER_IP', 60),
        quotaGlobal: int(env, 'BTC_QUOTA_GLOBAL', 300),
        quotaWindowMs: int(env, 'BTC_QUOTA_WINDOW_MS', 60_000),
        // Broadcast: a separate, tighter per-IP quota (contract: stricter than reads).
        writeQuotaPerIp: int(env, 'BTC_WRITE_QUOTA_PER_IP', 20),
        writeQuotaGlobal: int(env, 'BTC_WRITE_QUOTA_GLOBAL', 100),
        killSwitch: opt(env, 'BTC_KILLSWITCH', 'false').toLowerCase() === 'true',
      }
    })(),
    // Cross-chain bridge proxy (spec 067): optional like the Bitcoin/Polymarket proxies — disabled
    // means the /v1/bridge/* routes 503 fail-closed (bridge_disabled) and the SPA hides the Bridge
    // tab for a stated reason (FR-053); boot is unaffected. Fail-loud validation applies only when
    // the module is ENABLED, because a bad upstream URL or a one-chain route set cannot produce a
    // single valid bridge and must stop the boot rather than 502 every request.
    bridge: (() => {
      const enabled = opt(env, 'BRIDGE_ENABLED', 'false').toLowerCase() === 'true'
      const apiUrl = opt(env, 'BRIDGE_API_URL', 'https://app.across.to/api')
      // The spec-067 launch matrix (research R8): every one of these carries an Across SpokePool.
      // ETC/Mordor/Amoy are absent on purpose — no Across deployment exists there (FR-006c).
      const chainIds = opt(env, 'BRIDGE_CHAIN_IDS', '1,10,137,8453,42161')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const n = Number.parseInt(s, 10)
          if (!Number.isInteger(n) || n <= 0) throw new Error(`[relay-gateway] invalid chainId in BRIDGE_CHAIN_IDS: ${s}`)
          return n
        })
      if (enabled) {
        let ok = false
        try {
          ok = ['http:', 'https:'].includes(new URL(apiUrl).protocol)
        } catch {
          ok = false
        }
        if (!ok) throw new Error(`[relay-gateway] BRIDGE_API_URL=${apiUrl} is not a valid http(s) URL`)
        // A bridge needs two endpoints; one chain can only ever produce same-chain "routes".
        if (new Set(chainIds).size < 2) {
          throw new Error('[relay-gateway] BRIDGE_CHAIN_IDS must list at least two distinct chainIds when BRIDGE_ENABLED=true')
        }
      }
      return {
        enabled,
        apiUrl,
        chainIds,
        timeoutMs: int(env, 'BRIDGE_TIMEOUT_MS', 5000),
        retries: int(env, 'BRIDGE_RETRIES', 1),
        // Quotes move with gas and relayer capital, so the window is short and the cache is used
        // for single-flight de-dup only — routes.js refuses to serve a stale quote at all (FR-008).
        quoteTtlMs: int(env, 'BRIDGE_QUOTE_TTL_MS', 10_000),
        statusTtlMs: int(env, 'BRIDGE_STATUS_TTL_MS', 15_000),
        quotaPerIp: int(env, 'BRIDGE_QUOTA_PER_IP', 60),
        quotaGlobal: int(env, 'BRIDGE_QUOTA_GLOBAL', 300),
        quotaWindowMs: int(env, 'BRIDGE_QUOTA_WINDOW_MS', 60_000),
        killSwitch: opt(env, 'BRIDGE_KILLSWITCH', 'false').toLowerCase() === 'true',
      }
    })(),
    // Perps read proxy (spec 082): optional like the Bitcoin/Bridge proxies — disabled means the
    // /v1/perps/* routes 503 fail-closed (perps_unconfigured) and the SPA hides the Perps view for
    // a stated reason; boot is unaffected (perps must never couple to the value paths, FR-016).
    // READ-ONLY: three public venue APIs, no credentials anywhere. Attribution identifiers are
    // PUBLIC config. Fail-loud validation applies only when the module is ENABLED (same philosophy
    // as the bitcoin/bridge blocks). The Hyperliquid builder fee is hard-capped at Hyperliquid's
    // own 10 bps perps limit — an out-of-range fallback value fails boot loudly (FR-008), exactly
    // like the Polymarket builder-fee caps above.
    perps: (() => {
      const enabled = opt(env, 'PERPS_ENABLED', 'false').toLowerCase() === 'true'
      const HL_BUILDER_FEE_CAP_BPS = 10
      // An explicitly EMPTY env var disables one gains chain without disabling the venue —
      // so the unset check is `undefined`, not the falsy `opt()` treatment (which would silently
      // re-enable a chain an operator turned off).
      const gainsUrl = (name, fallback) => (env[name] === undefined ? fallback : String(env[name]).trim())
      const gainsUrls = {
        42161: gainsUrl('PERPS_GAINS_URL_ARBITRUM', 'https://backend-arbitrum.gains.trade'),
        8453: gainsUrl('PERPS_GAINS_URL_BASE', 'https://backend-base.gains.trade'),
        137: gainsUrl('PERPS_GAINS_URL_POLYGON', 'https://backend-polygon.gains.trade'),
      }
      for (const key of Object.keys(gainsUrls)) if (!gainsUrls[key]) delete gainsUrls[key]
      const gainsPricingUrl = opt(env, 'PERPS_GAINS_PRICING_URL', 'https://backend-pricing.eu.gains.trade')
      const gmxUrl = opt(env, 'PERPS_GMX_URL', 'https://arbitrum-api.gmxinfra.io')
      const hlUrl = opt(env, 'PERPS_HL_URL', 'https://api.hyperliquid.xyz')
      const gainsReferrer = opt(env, 'PERPS_GAINS_REFERRER', null)
      const hlBuilderAddress = opt(env, 'PERPS_HL_BUILDER_ADDRESS', null)
      const gmxRefCode = opt(env, 'PERPS_GMX_REF_CODE', null)
      const hlBuilderFeeBps = int(env, 'PERPS_HL_BUILDER_FEE_BPS', 0)
      if (enabled) {
        for (const [name, url] of [
          ...Object.entries(gainsUrls).map(([id, u]) => [`PERPS_GAINS_URL(chain ${id})`, u]),
          ...(gainsPricingUrl ? [['PERPS_GAINS_PRICING_URL', gainsPricingUrl]] : []),
          ...(gmxUrl ? [['PERPS_GMX_URL', gmxUrl]] : []),
          ...(hlUrl ? [['PERPS_HL_URL', hlUrl]] : []),
        ]) {
          let ok = false
          try {
            ok = new URL(url).protocol === 'https:'
          } catch {
            ok = false
          }
          if (!ok) throw new Error(`[relay-gateway] ${name}=${url} is not a valid https URL`)
        }
        if (Object.keys(gainsUrls).length === 0 && !gmxUrl && !hlUrl) {
          throw new Error('[relay-gateway] PERPS_ENABLED=true but every venue URL is unset')
        }
        if (gainsReferrer && !ADDRESS_RE.test(gainsReferrer)) {
          throw new Error('[relay-gateway] PERPS_GAINS_REFERRER is not an address')
        }
        if (hlBuilderAddress && !ADDRESS_RE.test(hlBuilderAddress)) {
          throw new Error('[relay-gateway] PERPS_HL_BUILDER_ADDRESS is not an address')
        }
        // GMX referral codes: <= 20 chars of [A-Za-z0-9_] (stored on-chain as bytes32).
        if (gmxRefCode && !/^[A-Za-z0-9_]{1,20}$/.test(gmxRefCode)) {
          throw new Error('[relay-gateway] PERPS_GMX_REF_CODE must be 1-20 chars of [A-Za-z0-9_]')
        }
        if (hlBuilderFeeBps < 0 || hlBuilderFeeBps > HL_BUILDER_FEE_CAP_BPS) {
          throw new Error(
            `[relay-gateway] PERPS_HL_BUILDER_FEE_BPS=${hlBuilderFeeBps} exceeds Hyperliquid's ${HL_BUILDER_FEE_CAP_BPS} bps perps cap`
          )
        }
      }
      return {
        enabled,
        gainsUrls,
        gainsPricingUrl,
        gmxUrl,
        gmxChainId: int(env, 'PERPS_GMX_CHAIN_ID', 42161),
        hlUrl,
        gainsReferrer,
        gmxRefCode,
        hlBuilderAddress,
        hlBuilderFeeBps,
        hlBuilderFeeCapBps: HL_BUILDER_FEE_CAP_BPS,
        timeoutMs: int(env, 'PERPS_TIMEOUT_MS', 8000),
        retries: int(env, 'PERPS_RETRIES', 1),
        cacheTtlMs: int(env, 'PERPS_CACHE_TTL_MS', 15_000),
        /**
         * Hyperliquid perp dexes (HIP-3), spec 083 / hyperliquid-decision.md §5.2.
         *
         * `hlDexListTtlMs` — how long the DISCOVERED dex list is cached. It is global (not
         * per-member) and changes only when Hyperliquid onboards a deployer, so an hour is
         * generous; re-reading it per request would spend weight-20 calls on a constant.
         *
         * `hlDexMax` — the most dexes one fan-out will read. Hyperliquid served 10 on 2026-08-12
         * and the list only grows, so this bounds the venue's per-IP weight budget against a list
         * we do not control. It NEVER silences anything: dexes past the cap are named in
         * `sources.hyperliquid.unreadDexes`, so the absence stays qualified.
         */
        hlDexListTtlMs: int(env, 'PERPS_HL_DEX_LIST_TTL_MS', 3_600_000),
        hlDexMax: int(env, 'PERPS_HL_DEX_MAX', 24),
        quotaPerIp: int(env, 'PERPS_QUOTA_PER_IP', 60),
        quotaGlobal: int(env, 'PERPS_QUOTA_GLOBAL', 300),
        quotaWindowMs: int(env, 'PERPS_QUOTA_WINDOW_MS', 60_000),
        killSwitch: opt(env, 'PERPS_KILLSWITCH', 'false').toLowerCase() === 'true',
      }
    })(),

    // Token news read proxy (spec 109) — the fourth read-only proxy, on the perps template.
    // Keyless by design: Alphaday's public API takes no credential (research R1), so there is
    // deliberately NO key variable here and nothing for the secrets registry to hold.
    news: (() => {
      const enabled = opt(env, 'NEWS_ENABLED', 'false').toLowerCase() === 'true'
      const baseUrl = opt(env, 'NEWS_BASE_URL', 'https://api.alphaday.com')
      if (enabled) {
        let ok = false
        try {
          const proto = new URL(baseUrl).protocol
          // http is admitted for the fixture server in tests; production config is https.
          ok = proto === 'https:' || proto === 'http:'
        } catch {
          ok = false
        }
        if (!ok) throw new Error(`[relay-gateway] NEWS_BASE_URL=${baseUrl} is not a valid URL`)
      }
      /**
       * TTL floor 300s: the vendor itself serves `cache-control: max-age=300` (research R5), so a
       * shorter TTL buys upstream load without buying freshness. A mis-set value is a tuning
       * error, not a lie to members — clamp and log once rather than failing boot.
       */
      const NEWS_TTL_FLOOR_MS = 300_000
      const rawTtl = int(env, 'NEWS_CACHE_TTL_MS', NEWS_TTL_FLOOR_MS)
      const cacheTtlMs = Math.max(rawTtl, NEWS_TTL_FLOOR_MS)
      if (rawTtl < NEWS_TTL_FLOOR_MS) {
        console.warn(
          `[relay-gateway] NEWS_CACHE_TTL_MS=${rawTtl} is below the vendor's 300s cache floor; clamped to ${NEWS_TTL_FLOOR_MS}`
        )
      }
      return {
        enabled,
        baseUrl,
        cacheTtlMs,
        timeoutMs: int(env, 'NEWS_TIMEOUT_MS', 8000),
        retries: int(env, 'NEWS_RETRIES', 1),
        quotaPerIp: int(env, 'NEWS_QUOTA_PER_IP', 60),
        quotaGlobal: int(env, 'NEWS_QUOTA_GLOBAL', 300),
        quotaWindowMs: int(env, 'NEWS_QUOTA_WINDOW_MS', 60_000),
        killSwitch: opt(env, 'NEWS_KILLSWITCH', 'false').toLowerCase() === 'true',
      }
    })(),
    // Member API (spec 095): member-signed capability tokens granting custody-free, scoped access to
    // a member's OWN data plus unsigned typed-data quotes. Optional like the bitcoin/bridge/perps
    // proxies — disabled means every /v1/member/* route (including the OpenAPI document) answers
    // 503 member_api_unconfigured, and boot is unaffected. Fail-loud validation applies only when
    // the module is ENABLED, same philosophy as the blocks above.
    //
    // THE GATEWAY STORES NOTHING TO ISSUE A KEY. A key is an EIP-712 grant the MEMBER signs; this
    // process verifies the signature on every request and keeps no copy. That is why there is no
    // key-store config here — and why MEMBER_API_MAX_TTL_DAYS matters: the grant's own expiry is
    // the real bound on a leaked token, since revocations are in-process (Phase 1) and every
    // revocation response says `durable: false` rather than implying otherwise.
    memberApi: (() => {
      const enabled = opt(env, 'MEMBER_API_ENABLED', 'false').toLowerCase() === 'true'
      const maxTtlDays = int(env, 'MEMBER_API_MAX_TTL_DAYS', 90)

      // Membership has ONE home per environment cohort, so signature fallback (ERC-1271) and the
      // tier read both happen on ONE named chain. Default: the first enabled chain that records a
      // membershipManager — FR-025 requires every enabled chain to have one, so this is simply the
      // first enabled chain unless an operator names another.
      const defaultReference = enabledChainIds.find((id) => Boolean(chains[id]?.targetsByKey?.membershipManager))
      const referenceChainId = int(env, 'MEMBER_API_REFERENCE_CHAIN_ID', defaultReference ?? enabledChainIds[0])

      // Per-chain wager indexers. An UNSET chain resolves `not-configured`, which is a different
      // fact from an empty wager list — the question was never asked (never `[]`).
      const subgraphUrls = {}
      for (const chainId of enabledChainIds) {
        const url = opt(env, `MEMBER_API_SUBGRAPH_${chainId}`, null)
        if (url) subgraphUrls[chainId] = url
      }

      const assistantEnabled = opt(env, 'ASSISTANT_ENABLED', 'false').toLowerCase() === 'true'
      const assistantBaseUrl = opt(env, 'ASSISTANT_BASE_URL', 'https://api.anthropic.com')
      const assistantMaxTokens = int(env, 'ASSISTANT_MAX_TOKENS', 1024)
      // Tool rounds per member turn (spec 104). The browser runs the loop and each round is its own
      // request here, so this is the multiplier on everything the per-turn ceiling bounds; capped
      // in code by MAX_ROUNDS_CEILING for the same reason ASSISTANT_MAX_TOKENS is.
      const assistantMaxRounds = int(env, 'ASSISTANT_MAX_ROUNDS', MAX_TOOL_ROUNDS)
      // Model spend. The per-turn output ceiling is capped by MAX_TOKENS_CEILING (imported rather
      // than restated — a duplicated ceiling is two ceilings that agree today), and the rest of this
      // block bounds what SPEND may accumulate. The request quotas above bound TRAFFIC; only these
      // bound MONEY, because two turns inside one window can differ by orders of magnitude in cost.
      const assistantQuotaPerAccount = int(env, 'ASSISTANT_QUOTA_PER_ACCOUNT', 20)
      const assistantQuotaGlobal = int(env, 'ASSISTANT_QUOTA_GLOBAL', 60)
      const assistantTokenBudgetPerAccount = int(env, 'ASSISTANT_TOKEN_BUDGET_PER_ACCOUNT', 200_000)
      const assistantTokenBudgetGlobal = int(env, 'ASSISTANT_TOKEN_BUDGET_GLOBAL', 2_000_000)
      const assistantTokenBudgetWindowMs = int(env, 'ASSISTANT_TOKEN_BUDGET_WINDOW_MS', 3_600_000)

      // Unauthenticated member-API traffic gets its OWN windows, never the members' shared one:
      // `trust proxy` is unset by design, so every anonymous caller keys to the same nginx IP, and
      // pooling that bucket with the authenticated global let one flood lock every member out of
      // the whole module. Revocation then gets a window of its own again — see below.
      const publicQuota = int(env, 'MEMBER_API_PUBLIC_QUOTA', 240)
      const revokeQuota = int(env, 'MEMBER_API_REVOKE_QUOTA', 60)

      if (enabled) {
        if (maxTtlDays < 1) {
          throw new Error(`[relay-gateway] MEMBER_API_MAX_TTL_DAYS=${maxTtlDays} must be >= 1 day`)
        }
        // A zero here is not "unlimited" and not "off" — createQuotas would refuse EVERY request,
        // and for the revocation window that means a member cannot withdraw a leaked key. Refuse
        // the value rather than booting into that.
        if (publicQuota < 1) {
          throw new Error(
            `[relay-gateway] MEMBER_API_PUBLIC_QUOTA=${publicQuota} must be >= 1; 0 would refuse every ` +
              'unauthenticated request, including the OpenAPI document a client needs before it can mint a key'
          )
        }
        if (revokeQuota < 1) {
          throw new Error(
            `[relay-gateway] MEMBER_API_REVOKE_QUOTA=${revokeQuota} must be >= 1; 0 would refuse every key ` +
              'revocation, which is the one member action that must work during a token compromise'
          )
        }
        // A reference chain that is not enabled, or has no membershipManager, means EVERY request
        // would 503 membership_unreadable — a module that cannot authenticate anyone must not boot
        // pretending it can.
        if (!chains[referenceChainId]?.targetsByKey?.membershipManager) {
          throw new Error(
            `[relay-gateway] MEMBER_API_REFERENCE_CHAIN_ID=${referenceChainId} is not an enabled chain with a recorded ` +
              `membershipManager (enabled: ${enabledChainIds.join(', ')}). Refusing to start: no member could be authenticated.`
          )
        }
        for (const [chainId, url] of Object.entries(subgraphUrls)) {
          let ok = false
          try {
            ok = ['http:', 'https:'].includes(new URL(url).protocol)
          } catch {
            ok = false
          }
          if (!ok) throw new Error(`[relay-gateway] MEMBER_API_SUBGRAPH_${chainId}=${url} is not a valid http(s) URL`)
        }
        if (assistantEnabled) {
          let ok = false
          try {
            ok = ['http:', 'https:'].includes(new URL(assistantBaseUrl).protocol)
          } catch {
            ok = false
          }
          if (!ok) throw new Error(`[relay-gateway] ASSISTANT_BASE_URL=${assistantBaseUrl} is not a valid http(s) URL`)
          if (assistantMaxTokens < 1 || assistantMaxTokens > MAX_TOKENS_CEILING) {
            throw new Error(
              `[relay-gateway] ASSISTANT_MAX_TOKENS=${assistantMaxTokens} must be between 1 and ` +
                `${MAX_TOKENS_CEILING}. This is the per-turn output ceiling — the only bound on what a ` +
                'SINGLE request can cost — so it is capped in code rather than left to the env file.'
            )
          }
          if (assistantMaxRounds < 1 || assistantMaxRounds > MAX_ROUNDS_CEILING) {
            throw new Error(
              `[relay-gateway] ASSISTANT_MAX_ROUNDS=${assistantMaxRounds} must be between 1 and ` +
                `${MAX_ROUNDS_CEILING}. Each tool round is a separate model call, so this multiplies what ` +
                'one member question can cost; it is capped in code rather than left to the env file.'
            )
          }
          if (assistantQuotaPerAccount < 1 || assistantQuotaGlobal < 1) {
            throw new Error(
              `[relay-gateway] ASSISTANT_QUOTA_PER_ACCOUNT=${assistantQuotaPerAccount} and ` +
                `ASSISTANT_QUOTA_GLOBAL=${assistantQuotaGlobal} must each be >= 1; use ASSISTANT_ENABLED=false ` +
                'to switch the assistant off, which is an honest 503 rather than a 429 nobody can clear'
            )
          }
          if (assistantTokenBudgetWindowMs < 1000) {
            throw new Error(`[relay-gateway] ASSISTANT_TOKEN_BUDGET_WINDOW_MS=${assistantTokenBudgetWindowMs} must be >= 1000`)
          }
          // A budget below ONE MAXIMAL TURN is a size limit wearing a budget's name: a well-formed
          // request would be refused for being long rather than for the budget being spent, which
          // is a confusing thing to tell a member and an impossible one to act on. `maxTurnTokens`
          // derives the bound from the request caps parseChatRequest already enforces, so the two
          // cannot drift apart.
          const oneTurn = maxTurnTokens(assistantMaxTokens)
          if (assistantTokenBudgetPerAccount < oneTurn) {
            throw new Error(
              `[relay-gateway] ASSISTANT_TOKEN_BUDGET_PER_ACCOUNT=${assistantTokenBudgetPerAccount} is below ` +
                `${oneTurn}, the most one admissible turn can reserve at ASSISTANT_MAX_TOKENS=${assistantMaxTokens}. ` +
                'A member could then be refused for asking a long question rather than for spending their budget. ' +
                'Raise the budget or lower the per-turn ceiling.'
            )
          }
          if (assistantTokenBudgetGlobal < assistantTokenBudgetPerAccount) {
            throw new Error(
              `[relay-gateway] ASSISTANT_TOKEN_BUDGET_GLOBAL=${assistantTokenBudgetGlobal} is below ` +
                `ASSISTANT_TOKEN_BUDGET_PER_ACCOUNT=${assistantTokenBudgetPerAccount}; the gateway-wide ceiling ` +
                'would bite before any member reached their own, which is not what either number claims to mean'
            )
          }
          // A missing ANTHROPIC_API_KEY is deliberately NOT a boot failure: it is an optional
          // feature credential, so that one route fails closed with 503 assistant_unconfigured
          // exactly like the OpenSea/Polymarket keys — losing the assistant must never take down
          // the gateway (fetch-secrets.sh invariant 5).
        }
      }

      return {
        enabled,
        killSwitch: opt(env, 'MEMBER_API_KILLSWITCH', 'false').toLowerCase() === 'true',
        maxTtlDays,
        referenceChainId,
        subgraphUrls,
        membershipCacheTtlMs: int(env, 'MEMBER_API_MEMBERSHIP_CACHE_MS', 60_000),
        clockSkewSec: int(env, 'MEMBER_API_CLOCK_SKEW_SEC', 300),
        revocationMaxEntries: int(env, 'MEMBER_API_REVOCATION_MAX', 50_000),
        timeoutMs: int(env, 'MEMBER_API_TIMEOUT_MS', 5000),
        // Keyed by the RECOVERED account, not by caller IP: `trust proxy` is unset and nginx fronts
        // the container, so an IP key would pool every member into one bucket. Reads are cheap and
        // an agent polls, so the per-account allowance is more generous than the intent quota.
        quotaPerAccount: int(env, 'MEMBER_API_QUOTA_PER_ACCOUNT', 120),
        quotaGlobal: int(env, 'MEMBER_API_QUOTA_GLOBAL', 600),
        quotaWindowMs: int(env, 'MEMBER_API_QUOTA_WINDOW_MS', 60_000),
        // Its OWN window, not a slice of the authenticated one. Because `trust proxy` is unset the
        // per-key and aggregate bounds coincide on the VM (every anonymous caller is the nginx IP),
        // so one number configures both — and if an operator ever did trust the proxy, the per-IP
        // key would simply become the finer of two real bounds rather than needing a new variable.
        publicQuota,
        // Revocation's own window again, one level down. `keys/revoke` is the emergency control: a
        // member reaches for it exactly when their token is loose, which is also exactly when
        // something may be hammering this module. It is BUDGETED rather than EXEMPTED because the
        // endpoint does an ECDSA recovery and possibly an ERC-1271 chain call per request, so an
        // unlimited one is its own amplifier — but nothing else may spend from this window, so no
        // volume of other traffic can starve it.
        revokeQuota,
        assistant: {
          enabled: assistantEnabled,
          // SECRET. Never logged, never echoed, never part of any response.
          apiKey: opt(env, 'ANTHROPIC_API_KEY', null),
          baseUrl: assistantBaseUrl,
          model: opt(env, 'ASSISTANT_MODEL', 'claude-sonnet-5'),
          maxTokens: assistantMaxTokens,
          // Public config, exported on /status as `maxRounds` so the browser loop reads its ceiling
          // from the gateway it is talking to rather than assuming the package default.
          maxRounds: assistantMaxRounds,
          timeoutMs: int(env, 'ASSISTANT_TIMEOUT_MS', 30_000),
          // A tighter request class than the module's general read quota: an assistant turn costs
          // real money, so 120 reads/min and 120 model calls/min are not the same permission.
          quotaPerAccount: assistantQuotaPerAccount,
          quotaGlobal: assistantQuotaGlobal,
          // The ceiling on MONEY rather than traffic. Hourly by default, matching SPEND_WINDOW_MS's
          // philosophy for the gas cap: spend is judged over a period a human would recognise.
          tokenBudgetPerAccount: assistantTokenBudgetPerAccount,
          tokenBudgetGlobal: assistantTokenBudgetGlobal,
          tokenBudgetWindowMs: assistantTokenBudgetWindowMs,
        },
      }
    })(),
    // x402 agentic payments (spec 096): a pay-per-request rail on the member API's PRICED
    // operations, for an agent that holds no member key. Optional exactly like the blocks above —
    // disabled (the default) means no route ever answers 402 and an unauthenticated priced request
    // gets the same 401 it got before this module existed.
    //
    // THE PAID RAIL SUBSTITUTES MEMBERSHIP FOR ONE OPERATION, and never applies to a member whose
    // bearer token works: routes.js checks the token FIRST. Payment is an EIP-3009
    // `TransferWithAuthorization` the PAYER signs on the chain's own USDC to X402_PAY_TO; this
    // gateway verifies it and hands the settlement to the SAME engine the intent rail uses. No key
    // is held here, and nothing is signed server-side — as everywhere else in this service.
    //
    // Fail-loud validation applies ONLY when the module is ENABLED, same philosophy as the
    // bitcoin/bridge/perps/memberApi blocks — with one addition that matters more than the others:
    // X402_PAY_TO has no default, because a defaulted treasury is money sent somewhere nobody chose.
    x402: (() => {
      const enabled = opt(env, 'X402_ENABLED', 'false').toLowerCase() === 'true'

      // EIP-3009 is the whole settlement mechanism, so the only candidate chains are the ones this
      // gateway already knows carry an EIP-3009 token (`paymentSupported` + a recorded paymentToken).
      // On 61/63 the live token is permit-only and there is nothing to settle with.
      const defaultChain = enabledChainIds.find((id) => chains[id]?.paymentSupported && chains[id]?.paymentToken)
      const chainId = int(env, 'X402_CHAIN_ID', defaultChain ?? enabledChainIds[0])
      const payTo = opt(env, 'X402_PAY_TO', null)
      const prices = {
        read: int(env, 'X402_PRICE_READ', 10_000),
        build: int(env, 'X402_PRICE_BUILD', 50_000),
        assistant: int(env, 'X402_PRICE_ASSISTANT', 100_000),
      }
      const settleBufferSeconds = int(env, 'X402_SETTLE_BUFFER_SECONDS', 60)
      const maxTimeoutSeconds = int(env, 'X402_MAX_TIMEOUT_SECONDS', 300)

      if (enabled) {
        const chain = chains[chainId]
        if (!chain) {
          throw new Error(
            `[relay-gateway] X402_CHAIN_ID=${chainId} is not an enabled chain (enabled: ${enabledChainIds.join(', ')}). ` +
              'Refusing to start: the paid rail would advertise a price it could never settle.'
          )
        }
        if (!chain.paymentSupported || !ADDRESS_RE.test(chain.paymentToken || '')) {
          throw new Error(
            `[relay-gateway] X402_CHAIN_ID=${chainId} has no EIP-3009 payment token recorded, so an x402 payment ` +
              'could never be settled there. Refusing to start.'
          )
        }
        if (!chain.tokenDomain?.name || !chain.tokenDomain?.version) {
          throw new Error(
            `[relay-gateway] chain ${chainId} has no payment-token EIP-712 domain, so a payment signature could ` +
              'never be verified. Refusing to start.'
          )
        }
        if (!chain.engineRelayerId) {
          throw new Error(`[relay-gateway] chain ${chainId} has no engine relayer id; x402 settlement has no lane`)
        }
        // REQUIRED, and validated. There is deliberately no fallback: an unset treasury must stop
        // the boot, never quietly resolve to an address an operator did not choose.
        if (!payTo) {
          throw new Error(
            '[relay-gateway] X402_ENABLED=true requires X402_PAY_TO (the treasury every payment is made to). ' +
              'It has no default on purpose — refusing to start.'
          )
        }
        if (!ADDRESS_RE.test(payTo)) throw new Error(`[relay-gateway] X402_PAY_TO=${payTo} is not an address`)
        if (Object.values(prices).every((p) => p <= 0)) {
          throw new Error(
            '[relay-gateway] X402_ENABLED=true but every X402_PRICE_* is 0, so no operation is offered over the ' +
              'paid rail. Refusing to start: the module would be on and do nothing.'
          )
        }
        if (settleBufferSeconds < 1) {
          throw new Error(`[relay-gateway] X402_SETTLE_BUFFER_SECONDS=${settleBufferSeconds} must be >= 1`)
        }
        if (maxTimeoutSeconds < settleBufferSeconds) {
          throw new Error(
            `[relay-gateway] X402_MAX_TIMEOUT_SECONDS=${maxTimeoutSeconds} is below X402_SETTLE_BUFFER_SECONDS=` +
              `${settleBufferSeconds}; the offer would promise less time than settlement demands`
          )
        }
      }

      return {
        enabled,
        killSwitch: opt(env, 'X402_KILLSWITCH', 'false').toLowerCase() === 'true',
        chainId,
        payTo,
        prices,
        settleBufferSeconds,
        maxTimeoutSeconds,
        nonceMaxEntries: int(env, 'X402_NONCE_MAX', 50_000),
      }
    })(),
    // FeeRouter (spec 060): the on-chain source of truth for the Polymarket builder bps. The env
    // takerFeeBps/makerFeeBps above become the FALLBACK when the router is unset or unreachable.
    // The address defaults to the deployment record's feeRouter (same pinning philosophy as
    // FR-025); an env override that CONTRADICTS the record fails boot loudly.
    feeRouter: (() => {
      const chainId = int(env, 'FEE_ROUTER_CHAIN_ID', 137)
      const cacheTtlMs = int(env, 'FEE_ROUTER_CACHE_TTL_MS', 30_000)
      const envAddress = opt(env, 'FEE_ROUTER_ADDRESS', null)
      if (envAddress && !ADDRESS_RE.test(envAddress)) {
        throw new Error('[relay-gateway] FEE_ROUTER_ADDRESS is not an address')
      }
      const deployment = loadDeployment(deploymentsDir, chainId)
      const recorded = deployment?.contracts?.feeRouter && ADDRESS_RE.test(deployment.contracts.feeRouter)
        ? deployment.contracts.feeRouter
        : null
      if (envAddress && recorded && envAddress.toLowerCase() !== recorded.toLowerCase()) {
        throw new Error(
          `[relay-gateway] FEE_ROUTER_ADDRESS=${envAddress} contradicts the deployment record's feeRouter ` +
            `${recorded} for chain ${chainId} (${deployment.file}). Refusing to start.`
        )
      }
      return { address: envAddress || recorded, chainId, cacheTtlMs }
    })(),
    maxQueueDepth: int(env, 'MAX_QUEUE_DEPTH', 100),
    spendWindowMs: int(env, 'SPEND_WINDOW_MS', 3_600_000),
    defaultGasLimit: bigInt(env, 'DEFAULT_GAS_LIMIT', 300_000n),
    rpcTimeoutMs: int(env, 'RPC_TIMEOUT_MS', 4000),
    // /healthz + /status cache window: caps upstream RPC fan-out from the origin-lock-exempt health
    // route so it can't be looped to amplify load onto the operator's public RPCs.
    healthCacheMs: int(env, 'HEALTH_CACHE_MS', 5000),
    // Build identity (spec 076, FR-030). Set by the deploy pipeline; absent on any build that is
    // not a published release, in which case the health surface reports `unreleased+<sha>` rather
    // than the nearest tag (FR-031). Public, non-secret — see the health handler in server.js.
    build: {
      version: opt(env, 'APP_VERSION', null),
      gitSha: opt(env, 'GIT_SHA', null),
    },
  }
}
