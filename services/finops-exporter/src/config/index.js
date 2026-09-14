/**
 * Exporter configuration (spec 089).
 *
 * Every credential arrives as an environment variable delivered from GCP Secret Manager into a
 * per-container tmpfs env file by `infra/vm/common/fetch-secrets.sh` (FR-024). Nothing here reads a
 * file, and nothing here has a committed default that is a secret.
 *
 * ABSENT CONFIG IS NOT AN ERROR. A missing vendor credential makes that source `not-configured`,
 * which is a first-class state that does not alert and does not count as an outage (FR-006). The
 * exporter boots and reports honestly on whatever it can reach; it does not refuse to start because
 * one of four vendors has not been wired up yet.
 */

const num = (v, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * Chainlink POL/USD on Polygon. A PUBLIC on-chain price feed, chosen over a price API on purpose:
 * it needs no credential, it is already reachable over the RPC we have, and `latestRoundData`
 * carries `updatedAt` — so the rate's AGE is a fact we can publish rather than a thing we assume
 * (FR-013). An unset feed means no USD conversion at all, never a guessed rate.
 */
const DEFAULT_POL_USD_FEED = '0xAB594600376Ec9fD91F8e885dADF0CE036862dE0'

export function loadConfig(env = process.env) {
  const cohort = list(env.FINOPS_COHORT_CHAIN_IDS).map(Number).filter(Number.isFinite)

  const rpcUrls = {}
  for (const key of Object.keys(env)) {
    const m = /^RPC_URLS_(\d+)$/.exec(key)
    if (m) rpcUrls[Number(m[1])] = list(env[key])
  }

  // RPC_URL_PRIMARY_<chainId> is a credential-bearing endpoint delivered from Secret Manager by
  // fetch-secrets.sh, so it cannot be written into the compose file the way RPC_URLS_<chainId> is.
  // It is PREPENDED rather than substituted: the public endpoints stay behind it as failover, so a
  // keyed endpoint rate-limiting turns an on-chain source slow, not `unreadable`.
  //
  // De-duplicated, because the same URL twice is one endpoint, and buildProviders would otherwise
  // wrap it in a FallbackProvider that fails over from a host to itself.
  for (const key of Object.keys(env)) {
    const m = /^RPC_URL_PRIMARY_(\d+)$/.exec(key)
    if (!m) continue
    const url = String(env[key] ?? '').trim()
    if (!url) continue
    const chainId = Number(m[1])
    rpcUrls[chainId] = [url, ...(rpcUrls[chainId] ?? []).filter((u) => u !== url)]
  }

  return {
    port: num(env.PORT, 9464),
    // Loopback only. The exporter has no member-facing surface and must not be publicly reachable
    // (FR-027); Alloy scrapes it from inside the same network namespace.
    host: env.FINOPS_BIND_HOST ?? '127.0.0.1',

    // The build's cohort. Reads never cross the testnet/mainnet boundary (FR-008, constitution III).
    cohortChainIds: cohort.length ? cohort : [137],

    rpcUrls,
    confirmations: {
      1: num(env.FINOPS_CONFIRMATIONS_1, 12),
      10: num(env.FINOPS_CONFIRMATIONS_10, 20),
      61: num(env.FINOPS_CONFIRMATIONS_61, 30),
      63: num(env.FINOPS_CONFIRMATIONS_63, 30),
      137: num(env.FINOPS_CONFIRMATIONS_137, 128), // Polygon reorgs deeper than most; R5.
      8453: num(env.FINOPS_CONFIRMATIONS_8453, 20),
      42161: num(env.FINOPS_CONFIRMATIONS_42161, 20),
    },

    /**
     * Outbound RPC pacing and boot fan-out (#1585).
     *
     * `rpcMaxPerSec` defaults to 25 — HALF the keyed Polygon endpoint's 50 req/s, because that
     * budget is SHARED with the gateway and the bundler. A reporting service must not be able to
     * spend a value path's headroom, and taking half by construction is a cheaper guarantee than
     * measuring whether it happened to. 0 disables pacing.
     */
    rpcMaxPerSec: num(env.FINOPS_RPC_MAX_PER_SEC, 25),
    bootConcurrency: num(env.FINOPS_BOOT_CONCURRENCY, 4),

    // How far back a cold start scans for revenue events. Bounded so a boot cannot walk the chain
    // from genesis; the counter is cumulative-since-start, which the dashboard states.
    lookbackBlocks: num(env.FINOPS_LOOKBACK_BLOCKS, 50_000),

    contracts: {
      feeRouter: env.FEE_ROUTER_ADDRESS || null,
      membershipManager: env.MEMBERSHIP_MANAGER_ADDRESS || null,
      paymaster: env.PAYMASTER_ADDRESS_137 || null,
      entryPoint: env.ENTRYPOINT_ADDRESS || '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    },

    /**
     * x402 agent payments (spec 096). READ-ONLY, like everything else here — the treasury the rail
     * pays INTO and the token it pays IN, which is all the collector needs to find settlements on
     * chain. The exporter never holds a key and never settles anything.
     *
     * Unset `payTo` is the honest signal that the rail is not offered, and the collector reports
     * `not-configured` rather than $0 for exactly that reason. These deliberately mirror the
     * gateway's own X402_PAY_TO / X402_CHAIN_ID rather than inferring either: two services reading
     * one address from one name is what stops them disagreeing about where money went.
     */
    x402: {
      payTo: env.X402_PAY_TO || null,
      chainId: num(env.X402_CHAIN_ID, 137),
      paymentToken: env.X402_PAYMENT_TOKEN || null,
    },

    /** Prepaid pool owners. Balances only — the exporter never holds a key (FR-026). */
    pools: {
      'paymaster-137': { kind: 'paymaster', chain: 137, unit: 'POL' },
      'relayer-137': { kind: 'eoa', chain: 137, unit: 'POL', address: env.GAS_WALLET_137 || null },
      'relayer-63': { kind: 'eoa', chain: 63, unit: 'ETC', address: env.GAS_WALLET_63 || null },
      'bundler-137': { kind: 'eoa', chain: 137, unit: 'POL', address: env.BUNDLER_EXECUTOR_137 || null },
    },

    fx: {
      polUsdFeed: env.FINOPS_POL_USD_FEED ?? DEFAULT_POL_USD_FEED,
      feedChain: num(env.FINOPS_FX_FEED_CHAIN, 137),
      // Beyond this the rate is published but flagged stale; a stale rate is visible, never silently applied.
      maxAgeSec: num(env.FINOPS_FX_MAX_AGE_SEC, 6 * 3600),
    },

    gcp: {
      projectId: env.GCP_PROJECT_ID || null,
      // The billing export dataset referenced by docs/runbooks/vm-migration.md.
      billingDataset: env.FINOPS_BILLING_DATASET || 'billing_export',
      billingTablePrefix: env.FINOPS_BILLING_TABLE_PREFIX || 'gcp_billing_export_v1_',
      // Querying is billable; this bounds a single query's scan (FR-029).
      maxBytesBilled: num(env.FINOPS_BQ_MAX_BYTES_BILLED, 2 * 1024 ** 3),
      lookbackDays: num(env.FINOPS_BILLING_LOOKBACK_DAYS, 30),
    },

    cloudflare: {
      apiToken: env.CLOUDFLARE_ANALYTICS_TOKEN || null,
      zoneTag: env.CLOUDFLARE_ZONE_ID || null,
      endpoint: env.CLOUDFLARE_GRAPHQL_URL || 'https://api.cloudflare.com/client/v4/graphql',
      // Research R1: Cloudflare exposes NO dollar figure. This is the declared plan price, and the
      // cost it produces is labelled basis="modelled" so it is never mistaken for an invoice.
      planMonthlyUsd: num(env.FINOPS_CLOUDFLARE_PLAN_USD, null),
    },

    // Spec 106/#1447: the relay-gateway's counters endpoint — an UNPUBLISHED compose-network
    // port (e.g. http://gateway:9091/counters). Unset => the gateway-upstream-usage source reads
    // not-configured, which is the honest state for a deployment that has not wired it.
    gateway: {
      metricsUrl: env.FINOPS_GATEWAY_METRICS_URL || null,
    },
    /**
     * Pinata / IPFS.
     *
     * `readJwt` is deliberately NOT `PINATA_JWT`. That variable (and its `VITE_` twin on the SPA)
     * authorises `pinJSONToIPFS`/`pinFileToIPFS` — a WRITE credential to a member-facing store, in
     * a service whose whole guarantee is that it holds nothing that can change anything (FR-026).
     * This wants a second Pinata key scoped to `data/userPinnedDataTotal` and nothing else.
     *
     * The name is distinct on purpose: `fetch-secrets.sh` emits by name, so two similar variables
     * are two audit trails, and nobody wires the wrong one by reaching for the one that is already
     * in the environment.
     */
    pinata: {
      readJwt: env.FINOPS_PINATA_READ_JWT || null,
      endpoint: env.PINATA_API_URL || 'https://api.pinata.cloud',
      // Unset ⇒ `not-configured`, never 0. Pinata is a PAID vendor — a defaulted zero here would
      // not be a cautious placeholder, it would be an assertion that is known to be false.
      planMonthlyUsd: num(env.FINOPS_PINATA_PLAN_USD, null),
    },

    quicknode: {
      apiKey: env.QUICKNODE_API_KEY || null,
      endpoint: env.QUICKNODE_API_URL || 'https://api.quicknode.com/v0',
      // Preferred when the plan includes it (research R3) — real metrics beat parsing usage JSON.
      prometheusUrl: env.QUICKNODE_PROMETHEUS_URL || null,
      planMonthlyUsd: num(env.FINOPS_QUICKNODE_PLAN_USD, null),
      // Only meaningful on a credit-metered plan. On Flat Rate RPS the subscription IS the cost and
      // credit usage is informational, which is why both numbers exist independently.
      usdPerMillionCredits: num(env.FINOPS_QUICKNODE_USD_PER_MCREDIT, null),
    },

    /**
     * Flat, declared subscriptions with no vendor API at all.
     *
     * EVERY SOURCE WHOSE CATALOGUE ENTRY NAMES THE `quicknode` COLLECTOR AS ITS FLAT-SUBSCRIPTION
     * MODELLER MUST APPEAR HERE. A missing key is not a missing price — it falls through to the
     * QuickNode credit path and reports `not-configured` citing `QUICKNODE_API_KEY`, a message
     * about a vendor the source has nothing to do with. `alphaday-news-api` shipped that way with
     * spec 109 and read as an unwired QuickNode account for its whole life.
     *
     * Grafana Cloud defaults to null, NOT 0. Its free tier really does cost $0, but "the operator
     * confirmed we are on the free tier" and "nobody ever set this" are different facts, and a
     * defaulted 0 renders as the former while meaning the latter. Set `FINOPS_GRAFANA_PLAN_USD=0`
     * explicitly to assert the free tier; until then the source reports `not-configured`,
     * consistent with how every other unset plan price behaves.
     *
     * Alphaday is the one case where the default IS 0, and the reason is that the assertion has
     * nowhere else to live: spec 109's vendor is KEYLESS by construction — there is no account,
     * so there is no tier it could silently be on, and the catalogue entry itself declares the free
     * tier. "Nobody set this" and "we are on the free tier" collapse into the same fact when the
     * integration has no credential to configure.
     */
    flatSubscriptions: {
      'grafana-cloud': num(env.FINOPS_GRAFANA_PLAN_USD, null),
      'alphaday-news-api': num(env.FINOPS_ALPHADAY_PLAN_USD, 0),
      // The Graph. Null by default like everything else: the free tier here is a property of WHICH
      // ENDPOINT the app calls (Studio vs. the decentralized gateway), and that can change in a
      // one-line edit to networks.js, so it must be asserted rather than assumed. `check:finops` C6
      // refuses a zero assertion once a gateway.thegraph.com URL exists.
      thegraph: num(env.FINOPS_THEGRAPH_PLAN_USD, null),
    },

    referral: {
      openSeaAddress: env.OPENSEA_REFERRAL_ADDRESS || null,
      gainsReferrer: env.PERPS_GAINS_REFERRER || null,
      gmxRefCode: env.PERPS_GMX_REF_CODE || null,
      polymarketApiKey: env.POLYMARKET_API_KEY || null,
      polymarketBuilderCode: env.POLYMARKET_BUILDER_CODE || null,
      polymarketApiUrl: env.POLYMARKET_API_URL || 'https://clob.polymarket.com',
    },

    build: {
      version: env.FINOPS_VERSION || 'dev',
      commit: env.FINOPS_COMMIT || 'unknown',
      cohort: cohort.includes(137) || cohort.includes(1) ? 'mainnet' : 'testnet',
    },
  }
}

/**
 * A boot summary safe to log and to serve from /status.
 *
 * Reports whether each credential is PRESENT, never any part of its value (FR-025). Operators need
 * to know which sources are wired, and that question is answerable without printing anything secret.
 */
export function describeConfig(config) {
  return {
    cohort: config.build.cohort,
    chains: config.cohortChainIds,
    rpcConfigured: Object.keys(config.rpcUrls).map(Number),
    contracts: Object.fromEntries(Object.entries(config.contracts).map(([k, v]) => [k, Boolean(v)])),
    pools: Object.fromEntries(
      Object.entries(config.pools).map(([k, v]) => [k, v.kind === 'paymaster' ? Boolean(config.contracts.paymaster) : Boolean(v.address)]),
    ),
    credentials: {
      cloudflare: Boolean(config.cloudflare.apiToken && config.cloudflare.zoneTag),
      quicknode: Boolean(config.quicknode.apiKey || config.quicknode.prometheusUrl),
      pinata: Boolean(config.pinata?.readJwt),
      gcpBilling: Boolean(config.gcp.projectId),
      polymarket: Boolean(config.referral.polymarketApiKey),
    },
    attribution: {
      opensea: Boolean(config.referral.openSeaAddress),
      gains: Boolean(config.referral.gainsReferrer),
      gmx: Boolean(config.referral.gmxRefCode),
      polymarketBuilderCode: Boolean(config.referral.polymarketBuilderCode),
    },
  }
}
