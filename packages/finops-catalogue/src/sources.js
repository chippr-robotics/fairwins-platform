/**
 * THE catalogue: every FairWins revenue and cost source, declared exactly once (spec 089, FR-001).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *  IF YOU ADD A REVENUE OR COST SOURCE TO THE PLATFORM, ADD IT HERE. `npm run check:finops` fails
 *  until you do, and the failure names this file. That gate is the whole reason this file exists:
 *  "remember to update the dashboard" is a convention, and conventions decay; a red build does not.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Three consumers read this list and must never disagree about it:
 *   services/finops-exporter        emits the metrics
 *   scripts/finops/generate-dashboards.js   builds the panels
 *   scripts/finops/check-finops-coverage.js the gate
 *
 * What does NOT belong here: endpoints, account ids, zone tags, project names, and above all
 * credentials. `credential` names a Secret Manager secret; it never carries one (FR-003). This file
 * is world-readable in the repository.
 *
 * ── `moneyPath`: how the gate SEES an entry in the platform ───────────────────────────────────
 *
 * An optional field on any source whose money moves through the relay gateway:
 *
 *   moneyPath: { namespace, payeeEnv?, enableEnv? }
 *
 * `namespace` is the config namespace the coverage gate derives from an env-var prefix
 * (`X402_PAY_TO` => `x402`). `payeeEnv` names the variable that configures the recipient WE control;
 * `enableEnv` names the flag that switches the path on in a deployment.
 *
 * It exists because the original gate discovered new revenue by exactly one route — a FeeRouter
 * `serviceId` — and so was structurally blind to a rail that takes money without registering one.
 * The x402 rail below is exactly that, and it sat uncatalogued with CI green. C2 now also
 * enumerates configured platform payees in the gateway and fails on any namespace no entry claims,
 * and refuses to let a `planned` entry stay `planned` once a committed deployment turns its path on.
 */

/** Chain ids, spelled out so a reader does not have to know that 137 is Polygon. */
const POLYGON = 137
const MORDOR = 63

// Poll intervals. Matched to how fast the source actually CHANGES, not to how fresh we wish it were
// (FR-009). Querying the billing export more often does not make it fresher, and it is billable.
const FAST = 60 // on-chain balances: cheap, and runway alerts are only as good as this
const CHAIN_EVENTS = 120 // log scans over a confirmed window
const VENDOR = 3600 // vendor APIs with hourly-or-worse granularity
const DAILY_ISH = 6 * 3600 // BigQuery billing export: lags hours, is billable to query

/**
 * The 8 FeeRouter services (spec 060). These are generated rather than hand-listed so that the id,
 * the label and the on-chain service id cannot drift apart — the gate cross-checks this set against
 * the contracts and against the frontend FEE_SERVICES table.
 *
 * `serviceLabel` IS the keccak preimage. It is the join key to the chain.
 */
const FEE_SERVICES = [
  { id: 'fee-earn-lend', serviceLabel: 'earn.lend', label: 'Earn — lending fee', chains: [POLYGON] },
  { id: 'fee-polymarket-taker', serviceLabel: 'polymarket.taker', label: 'Predict — Polymarket taker (builder fee)', chains: [POLYGON] },
  { id: 'fee-polymarket-maker', serviceLabel: 'polymarket.maker', label: 'Predict — Polymarket maker (builder fee)', chains: [POLYGON] },
  { id: 'fee-stake-lido', serviceLabel: 'stake.lido', label: 'Stake — Lido liquid staking', chains: [POLYGON] },
  { id: 'fee-stake-polygon', serviceLabel: 'stake.polygon', label: 'Stake — Polygon liquid staking', chains: [POLYGON] },
  { id: 'fee-bridge-transfer', serviceLabel: 'bridge.transfer', label: 'Bridge — transfer fee', chains: [POLYGON] },
  { id: 'fee-liquidity-deposit', serviceLabel: 'liquidity.deposit', label: 'Supply — liquidity deposit fee', chains: [POLYGON] },
  { id: 'fee-perps-hl-builder', serviceLabel: 'perps.hyperliquid.builder', label: 'Perps — Hyperliquid builder fee', chains: [POLYGON] },
]

const feeSources = FEE_SERVICES.map(({ id, serviceLabel, label, chains }) => ({
  id,
  kind: 'revenue',
  status: 'live',
  label,
  metric: 'fairwins_finops_revenue_total',
  unit: 'USDC',
  collector: 'feeRouter',
  chains,
  serviceLabel,
  interval: CHAIN_EVENTS,
  credential: null,
  docs: 'finops-operations.md#fee-revenue',
  meaning:
    `Gross platform fee actually charged for \`${serviceLabel}\`, summed from FeeRouter FeeCharged events over finalized blocks. ` +
    `It is what the treasury RECEIVED, not what was quoted and not what was billed to a member elsewhere. ` +
    `Several of these services ship at a rate of 0 bps, so a genuine 0 here is expected and is NOT the same as an unread source.`,
}))

/**
 * Fee revenue we did NOT earn because no treasury was set. Invisible in every other view, and the
 * only signal that a fee path is live but misconfigured. Worth a panel of its own.
 */
const feeWaived = {
  id: 'fee-waived-no-treasury',
  kind: 'revenue',
  status: 'live',
  label: 'Fees waived (no treasury configured)',
  metric: 'fairwins_finops_revenue_waived_total',
  unit: 'USDC',
  collector: 'feeRouter',
  chains: [POLYGON],
  interval: CHAIN_EVENTS,
  credential: null,
  docs: 'finops-operations.md#fees-waived',
  meaning:
    'Fee amounts skipped because the FeeRouter had no treasury set (FeeSkippedNoTreasury). This is revenue ' +
    'forgone for a fixable configuration reason. It is NOT earned revenue and is never added to any revenue total — ' +
    'it is displayed so that a silently misconfigured fee path stops looking like a quiet day.',
}

/** Membership (spec 071 home chain). Accrued and received are two numbers and are never summed. */
const membership = [
  {
    id: 'membership-received',
    kind: 'revenue',
    status: 'live',
    label: 'Membership — received by treasury',
    metric: 'fairwins_finops_revenue_total',
    unit: 'USDC',
    collector: 'membership',
    chains: [POLYGON],
    interval: CHAIN_EVENTS,
    credential: null,
    docs: 'finops-operations.md#membership-revenue',
    meaning:
      'Membership fees WITHDRAWN to the treasury (FeesWithdrawn). This is money that has arrived. ' +
      'It is deliberately not the same number as membership-accrued, and the two are never summed (spec 071).',
  },
  {
    id: 'membership-accrued',
    kind: 'revenue',
    status: 'live',
    label: 'Membership — accrued, not yet withdrawn',
    metric: 'fairwins_finops_revenue_accrued',
    unit: 'USDC',
    collector: 'membership',
    chains: [POLYGON],
    interval: CHAIN_EVENTS,
    credential: null,
    docs: 'finops-operations.md#membership-revenue',
    meaning:
      'Membership fees earned (MembershipPurchased/Upgraded/Extended) and still sitting in the contract. ' +
      'Earned but NOT received. Adding this to membership-received would double-count every fee that has since ' +
      'been withdrawn, which is exactly why they are separate metric families.',
  },
]

/**
 * Venue-paid referral. Research R7: OpenSea's referral address and the Gains/GMX codes are
 * deliberately UNSET in production today, so these collect `not-configured` — which says "we have
 * not wired this up" (actionable) rather than "$0" (untrue).
 */
const referral = [
  {
    id: 'referral-opensea',
    kind: 'revenue',
    status: 'live',
    label: 'Collect — OpenSea referral',
    metric: 'fairwins_finops_revenue_total',
    unit: 'USD',
    collector: 'referral',
    interval: VENDOR,
    credential: null,
    docs: 'finops-operations.md#referral-revenue',
    moneyPath: { namespace: 'opensea', payeeEnv: 'OPENSEA_REFERRAL_ADDRESS' },
    meaning:
      'Referral share attributable to FairWins-routed OpenSea volume. OPENSEA_REFERRAL_ADDRESS is unset in ' +
      'production, so this reports not-configured rather than zero: no code is registered, so there is nothing to earn.',
  },
  {
    id: 'referral-gains',
    kind: 'revenue',
    status: 'live',
    label: 'Perps — Gains referral',
    metric: 'fairwins_finops_revenue_total',
    unit: 'USD',
    collector: 'referral',
    interval: VENDOR,
    credential: null,
    docs: 'finops-operations.md#referral-revenue',
    moneyPath: { namespace: 'perps-gains', payeeEnv: 'PERPS_GAINS_REFERRER' },
    meaning:
      'Venue-paid referral share from Gains Network. Gains has not whitelisted a referrer, so link-outs go ' +
      'unattributed and this reports not-configured.',
  },
  {
    id: 'referral-gmx',
    kind: 'revenue',
    status: 'live',
    label: 'Perps — GMX referral',
    metric: 'fairwins_finops_revenue_total',
    unit: 'USD',
    collector: 'referral',
    interval: VENDOR,
    credential: null,
    docs: 'finops-operations.md#referral-revenue',
    moneyPath: { namespace: 'perps-gmx', payeeEnv: 'PERPS_GMX_REF_CODE' },
    meaning:
      'Venue-paid GMX referral share (which also discounts the trader). No ref code is registered, so this ' +
      'reports not-configured.',
  },
  {
    id: 'referral-polymarket-rewards',
    kind: 'revenue',
    status: 'live',
    label: 'Predict — Polymarket weekly builder rewards',
    metric: 'fairwins_finops_revenue_total',
    unit: 'USD',
    collector: 'referral',
    interval: VENDOR,
    credential: 'polymarket-api-key',
    docs: 'finops-operations.md#referral-revenue',
    moneyPath: { namespace: 'polymarket', payeeEnv: 'POLYMARKET_BUILDER_CODE' },
    meaning:
      'Weekly rewards from the Polymarket builder-code programme, separate from the per-order builder fee ' +
      'captured by fee-polymarket-taker/maker. The builder code IS registered, so unlike the other referral ' +
      'sources this one is expected to report a real value once the credential is provisioned.',
  },
  /**
   * GutterToken referral (spec 104). Catalogued ON PURPOSE, not because a gate demanded it: C2b
   * enumerates payee env reads in `services/relay-gateway/src/**` only, and this referral code lives
   * in the TENANT MANIFEST (`settings.assistant.guttertokenReferralCode`) and ships in the frontend's
   * signup link — the gateway never reads it, so the gate is structurally blind to this one. That is
   * exactly the "a gate that cannot see the source is not protection" case the x402 rail taught, and
   * the remedy is the same: name it here so it is visible.
   *
   * `planned` and NOT `live`+`not-configured`, unlike the other referral entries, because there is a
   * real difference: those have a collector that CAN read a value once an env var is set. This one
   * has no collector that could ever read one — GutterToken exposes no balance, usage, or referral
   * endpoint (research §1, verified negative), and the credit lands on FairWins' own GutterToken
   * account, visible only on GutterToken's billing page. `moneyPath` carries the namespace alone:
   * there is no `payeeEnv` because no gateway variable holds the code (declaring one the gateway
   * does not read would trip the stale-claim rule), and no `enableEnv` because the rail is switched
   * by the tenant feature flag `assistant-byok`, not by deployment config.
   */
  {
    id: 'referral-guttertoken',
    kind: 'revenue',
    status: 'planned',
    label: 'Assistant — GutterToken referral credit',
    metric: null,
    collector: 'none',
    interval: VENDOR,
    credential: null,
    docs: 'finops-operations.md#planned-sources',
    moneyPath: { namespace: 'guttertoken' },
    meaning:
      'PLANNED, NOT LIVE — and NOT CASH. When a member opens and funds a GutterToken account through the ' +
      'referral-coded signup link on the Assistant tab (spec 104), GutterToken credits FairWins’ own ' +
      'GutterToken account with prepaid usage credit (docs: 15% of the referee’s FIRST deposit, capped at $50; ' +
      'non-refundable, non-cashable, self-referral void). It is in-kind credit that can only be spent on model ' +
      'calls from that account, so it is never revenue in USD and must never be summed with the cash sources. ' +
      'No referral code is registered yet and, more fundamentally, nothing can read the figure: GutterToken ' +
      'publishes no balance or referral endpoint, so no collector could ever report it — the honest state is ' +
      'not-yet-live with no metric, and it is excluded from every total. If P3 (a FairWins-owned GutterToken ' +
      'account as the FairWins rail’s upstream) is adopted, this credit accrues on the same account that ' +
      'assistant-model-api would then be billed to, and offsets that cost; the two entries should be promoted ' +
      'together, with this one staying an in-kind offset rather than becoming a revenue line.',
  },
]

/**
 * Named in the brief as revenue streams; neither exists on chain (research R8). MiniAppRegistry has
 * no fee, no price and no payable function; WagerRegistry takes no platform cut.
 *
 * They are catalogued so they are VISIBLE as not-yet-live and so the gate already knows their names
 * the day they ship. They declare no metric and emit no value: a `planned` source showing $0 is
 * indistinguishable from a shipped source earning nothing (FR-014).
 */
const planned = [
  {
    id: 'miniapp-licenses',
    kind: 'revenue',
    status: 'planned',
    label: 'Mini-app licenses',
    metric: null,
    collector: 'none',
    interval: DAILY_ISH,
    credential: null,
    docs: 'finops-operations.md#planned-sources',
    meaning:
      'PLANNED, NOT LIVE. contracts/apps/MiniAppRegistry.sol has no fee, price or payable function as of spec 089, ' +
      'so there is no licensing revenue to read. Shown as not-yet-live and excluded from every total.',
  },
  {
    id: 'wager-platform-fee',
    kind: 'revenue',
    status: 'planned',
    label: 'Wager platform fee',
    metric: null,
    collector: 'none',
    interval: DAILY_ISH,
    credential: null,
    docs: 'finops-operations.md#planned-sources',
    meaning:
      'PLANNED, NOT LIVE. WagerRegistry escrows stakes and takes no platform cut, so wagers currently generate ' +
      'volume but no direct revenue. Shown as not-yet-live and excluded from every total.',
  },
]

/**
 * x402 agent payments (spec 096) — LIVE since 2026-08-28.
 *
 * Promoted together with the deployment that switched the rail on, which is the sequencing the C2b
 * gate exists to force: a revenue path and the thing that watches it ship in one change, so there
 * is never a window where money can arrive unobserved.
 *
 * The collector reads settlements FROM CHAIN, not from the gateway, and that is deliberate. A
 * gateway counter would reset on every restart and vanish entirely if the container were replaced —
 * for a revenue figure that is an undercount which still looks like a number. The chain is the
 * durable record, and `collectors/x402.js` documents how a settlement is told apart from every
 * other USDC arrival at the same treasury (a `Transfer` into it whose transaction ALSO used an
 * EIP-3009 authorization — a shape only `transferWithAuthorization` produces).
 */
const x402 = [
  {
    id: 'x402-agent-payments',
    kind: 'revenue',
    status: 'live',
    label: 'Member API — x402 agent payments',
    metric: 'fairwins_finops_revenue_total',
    collector: 'x402',
    chains: [POLYGON],
    interval: CHAIN_EVENTS,
    credential: null,
    docs: 'finops-operations.md#x402-agent-payments',
    moneyPath: { namespace: 'x402', payeeEnv: 'X402_PAY_TO', enableEnv: 'X402_ENABLED' },
    meaning:
      'An agent holding no membership pays per request: it signs an EIP-3009 USDC authorization to the platform ' +
      'treasury (X402_PAY_TO) and the gateway settles it — $0.01 a read, $0.05 a typed-data build, $0.10 an ' +
      'assistant message. Unambiguously revenue, and it routes around the FeeRouter entirely, which is why the ' +
      'coverage gate could not see it until C2 learned to look for configured platform payees. The treasury is the ' +
      'admin Safe, which the FeeRouter also pays into on most chains — so counting arrivals at that address would ' +
      'attribute fee revenue to agents. The collector counts only authorization-settled transfers, which nothing ' +
      'else in this estate produces at this address. Counters are cumulative SINCE EXPORTER START, not all-time: ' +
      'cursors are in memory by design (owning a datastore whose corruption silently understates revenue is the ' +
      'worse failure), and the dashboard states that rather than implying a lifetime total.',
  },
]


/**
 * BUILT, NOT OFFERED. Two money paths whose code is complete and whose deployment is switched off.
 *
 * These are a different thing from the `planned` block above, and the difference is worth stating
 * because it decides how they are watched. Mini-app licenses and the wager platform fee do not exist
 * ANYWHERE: no contract has a fee, so nothing could ever be read. These two exist entirely, are
 * tested, and are one uncommented line in `infra/vm/gateway/docker-compose.yml` away from moving
 * real money.
 *
 * They still carry `status: 'planned'`, because status describes what there is to READ and there is
 * nothing: no deployment offers either path, so not one payment and not one billed token exists.
 * Reporting `$0` would say "offered, and nobody used it" — untrue, and it would close a question
 * that is still open.
 *
 * What keeps that from rotting is `moneyPath`. C2 fails the build the moment a committed deployment
 * sets X402_PAY_TO or ASSISTANT_ENABLED while these entries still claim to be not-yet-live. The
 * enable step is where a promotion to `live` (with a collector) becomes non-optional — which is the
 * whole point, because switching on a revenue rail is precisely the moment nobody remembers the
 * dashboard.
 */
const dormant = [
  {
    id: 'assistant-model-api',
    kind: 'cost',
    status: 'planned',
    label: 'Member assistant — model provider',
    metric: null,
    basis: 'modelled',
    collector: 'none',
    interval: VENDOR,
    credential: 'anthropic-api-key',
    docs: 'finops-operations.md#planned-sources',
    moneyPath: { namespace: 'assistant', enableEnv: 'ASSISTANT_ENABLED' },
    meaning:
      'BUILT, NOT OFFERED. `POST /v1/member/assistant/chat` (spec 095) calls the Anthropic Messages API, which ' +
      'bills per input and output token — a real vendor cost, and the only uncatalogued one. It is enabled on no ' +
      'deployment (ASSISTANT_ENABLED, and MEMBER_API_ENABLED above it, are commented out), so not one token has ' +
      'been billed. `basis` is declared `modelled` NOW, while nothing is at stake, and it is not negotiable later: ' +
      'this exporter holds no Anthropic billing credential, so any dollar figure it ever publishes will be token ' +
      'counts times a rate typed into a config file. Only GCP is `billed` (research R1). The token counts ' +
      'themselves are a fact and belong in vendor usage; the dollars are our arithmetic and must always say so.',
  },
]

/** Prepaid gas pools. These are costs AND the runway alerts (FR-015) — the estate's sharpest edge. */
const gasPools = [
  {
    id: 'paymaster-gas',
    kind: 'cost',
    status: 'live',
    label: 'Paymaster — sponsored gas',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'POL',
    basis: 'modelled',
    collector: 'pools',
    chains: [POLYGON],
    pool: 'paymaster-137',
    interval: FAST,
    credential: null,
    docs: 'finops-operations.md#prepaid-pools',
    meaning:
      'Gas spent sponsoring member UserOps, measured as drawdown of the paymaster EntryPoint deposit. ' +
      'The USD figure is MODELLED: the chain charges POL, and converting needs a price. The POL drawdown itself ' +
      'is exact. When this deposit empties, sponsorship stops and members see failures — which is why its runway, ' +
      'not its balance, is what alerts.',
  },
  {
    id: 'relayer-gas-polygon',
    kind: 'cost',
    status: 'live',
    label: 'Relayer gas — Polygon',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'POL',
    basis: 'modelled',
    collector: 'pools',
    chains: [POLYGON],
    pool: 'relayer-137',
    interval: FAST,
    credential: null,
    docs: 'finops-operations.md#prepaid-pools',
    meaning: 'Gas spent relaying intents on Polygon, measured as executor EOA balance drawdown. USD is modelled from a POL price.',
  },
  {
    id: 'relayer-gas-mordor',
    kind: 'cost',
    status: 'live',
    label: 'Relayer gas — Mordor',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'ETC',
    basis: 'modelled',
    collector: 'pools',
    chains: [MORDOR],
    pool: 'relayer-63',
    interval: FAST,
    credential: null,
    docs: 'finops-operations.md#prepaid-pools',
    meaning:
      'Gas spent relaying intents on Mordor, in native units. NO USD figure is produced: there is no ETC price ' +
      'feed, and valuing it at 0 would both understate a real cost and mean that Ethereum Classic MAINNET gas ' +
      'was priced at nothing too. Only the native drawdown and the runway are meaningful here — which is all that ' +
      'was ever needed, since running out still breaks the testnet cohort.',
  },
  {
    id: 'bundler-gas-polygon',
    kind: 'cost',
    status: 'live',
    label: 'Bundler gas — Polygon',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'POL',
    basis: 'modelled',
    collector: 'pools',
    chains: [POLYGON],
    pool: 'bundler-137',
    interval: FAST,
    credential: null,
    docs: 'finops-operations.md#prepaid-pools',
    meaning: 'Gas spent by the alto bundler executor EOA submitting bundles. USD is modelled from a POL price.',
  },
]

/** Vendor infrastructure. Only GCP can tell us what we were actually charged (research R1). */
const vendors = [
  {
    id: 'gcp',
    kind: 'cost',
    status: 'live',
    label: 'GCP',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'USD',
    basis: 'billed',
    collector: 'gcpBilling',
    interval: DAILY_ISH,
    credential: null, // Workload identity on the node's service account, not a stored token.
    docs: 'finops-operations.md#gcp-cost',
    meaning:
      'Actual charged GCP cost, per service, from the BigQuery billing export. The ONLY billed (as opposed to ' +
      'modelled) cost source we have. It LAGS by hours and holds nothing from before the export was enabled, ' +
      'so its panels state the lag rather than sitting next to a 60-second-old chain read as if equally fresh.',
  },
  {
    id: 'cloudflare',
    kind: 'cost',
    status: 'live',
    label: 'Cloudflare',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'USD',
    basis: 'modelled',
    collector: 'cloudflare',
    interval: VENDOR,
    credential: 'cloudflare-analytics-token',
    docs: 'finops-operations.md#cloudflare-cost',
    meaning:
      'Cloudflare spend MODELLED from the declared plan subscription. Research R1: the GraphQL Analytics API ' +
      'returns requests and bytes but no dollar figure, and there is no public billing API for the plan. ' +
      'The usage it DOES return is exported separately as vendor usage, which is a fact; this dollar figure is our arithmetic.',
  },
  {
    id: 'quicknode',
    kind: 'cost',
    status: 'live',
    label: 'QuickNode',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'USD',
    basis: 'modelled',
    collector: 'quicknode',
    interval: VENDOR,
    credential: 'quicknode-api-key',
    docs: 'finops-operations.md#quicknode-cost',
    meaning:
      'QuickNode spend MODELLED from API-credit consumption times the declared plan rate. Research R1: the Admin ' +
      'API reports credits, not dollars, and a Flat Rate RPS plan decouples spend from usage entirely — under that ' +
      'plan the modelled figure is the flat subscription and credit usage is informational only.',
  },
  {
    id: 'pinata',
    kind: 'cost',
    status: 'live',
    label: 'Pinata (IPFS pinning)',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'USD',
    basis: 'modelled',
    collector: 'pinata',
    interval: VENDOR,
    // A SEPARATE, READ-SCOPED key — never the pinning JWT, which is a write credential and has no
    // business in a service that is read-only by construction (FR-026).
    credential: 'finops-pinata-read-jwt',
    docs: 'finops-operations.md#pinata-cost',
    meaning:
      'Pinata spend MODELLED from the declared plan subscription; storage is read separately and exported as ' +
      'measured vendor usage. This is a PAID vendor on the member write path — wager creation, open challenges ' +
      'and encrypted backup pin JSON with no fallback, and mini-app packages are published here under CIDs that ' +
      'are keccak-committed on chain — so an outage is a member-facing incident, not a reporting one. Neither ' +
      'check:finops discovery route could ever have found it (no FeeRouter serviceId, no gateway payee env: the ' +
      'money flows the other way), which is why it sat uncatalogued while the vendor workbook recorded "we pay ' +
      'them" the whole time. The vendor publishes no billing API on our plan, so the dollar figure is arithmetic ' +
      'over a declared rate and the bytes beside it are the fact.',
  },
  {
    id: 'alphaday-news-api',
    kind: 'cost',
    status: 'live',
    label: 'Alphaday news API',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'USD',
    basis: 'modelled',
    collector: 'flatSubscription', // keyless vendor, no billing API — the declared plan IS the model
    interval: VENDOR,
    credential: null,
    docs: 'finops-operations.md#alphaday-news-cost',
    meaning:
      'The token-news vendor behind the relay-gateway news proxy (spec 109). Keyless public API on a free ' +
      'tier: the modelled figure is $0 by declared plan rate, and the entry exists so the dependency is ' +
      'VISIBLE — if Alphaday ever prices the tier, this line is where the change lands rather than a ' +
      'surprise (research R7). No revenue entry pairs with it: the module carries no fee, no referral, no ' +
      'payee env, so C2b has nothing to claim. Gateway request volume shows in gateway-upstream-usage ' +
      'under the news upstream label.',
  },
  {
    id: 'gateway-upstream-usage',
    kind: 'usage',
    status: 'live',
    label: 'Gateway upstream usage',
    metric: 'fairwins_finops_vendor_usage',
    collector: 'gateway',
    interval: VENDOR,
    docs: 'finops-operations.md#gateway-upstream-usage',
    meaning:
      'MEASURED request counts from the relay-gateway, per assurance tier and per upstream (spec 106, #1447): ' +
      'who is consuming the platform-held vendor credentials, in whose name. It is context for the vendor cost ' +
      'sources beside it — the QuickNode account is capped at 50 req/s shared with the gasless bundler, so this ' +
      'is the series that says WHERE that budget went. It is NOT a dollar and never joins a money total; counters ' +
      'are cumulative-since-boot on the gateway (rate() over them survives restarts the way any Prometheus ' +
      'counter does), and the labels are bounded by construction: tiers come from the fixed ladder, upstreams ' +
      'from the route table.',
  },
  {
    id: 'thegraph',
    kind: 'cost',
    status: 'live',
    label: 'The Graph (subgraph queries)',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'USD',
    basis: 'modelled',
    collector: 'flatSubscription',
    interval: VENDOR,
    credential: null,
    docs: 'finops-operations.md#thegraph-cost',
    meaning:
      'Subgraph query spend, MODELLED from the declared plan rate. THE TIER IS WHICH ENDPOINT THE APP CALLS, not ' +
      'a setting: `api.studio.thegraph.com` is Subgraph Studio, the free development tier, where the cost really ' +
      'is $0 and no GRT is consumed. Publishing to the decentralized network and switching a `subgraphUrl` to ' +
      '`gateway.thegraph.com` changes that in one edit — query fees are then paid in GRT from a billing balance ' +
      'held on ARBITRUM ONE (GRT on Ethereum L1 does not pay them). The free allowance does not bill over, it ' +
      'FAILS, so this line is about a dependency as much as a dollar. `check:finops` C6 fails if a gateway URL ' +
      'appears while the plan price is still asserted at zero, because that transition is a one-character edit ' +
      'that would otherwise leave a confidently wrong $0 on the dashboard.',
  },
  {
    id: 'grafana-cloud',
    kind: 'cost',
    status: 'live',
    label: 'Grafana Cloud (this system)',
    metric: 'fairwins_finops_cost_usd_total',
    unit: 'USD',
    basis: 'modelled',
    collector: 'flatSubscription', // no vendor API is polled; the declared plan IS the model
    interval: VENDOR,
    credential: null,
    docs: 'finops-operations.md#self-cost',
    meaning:
      'What the FinOps system itself costs: the Grafana Cloud plan plus the BigQuery query spend this exporter ' +
      'incurs reading the billing export. FR-029 — a FinOps system that hides its own cost is not credible. ' +
      'The free tier really is $0, but assert that by setting FINOPS_GRAFANA_PLAN_USD=0: unset reports ' +
      'not-configured, because "we are on the free tier" and "nobody set this" are different facts.',
  },
]

/** The catalogue. Order is display order on the overview dashboard. */
export const SOURCES = [
  ...feeSources,
  feeWaived,
  ...membership,
  ...referral,
  ...planned,
  ...x402,
  ...dormant,
  ...gasPools,
  ...vendors,
]

/** Prepaid pools, derived from the catalogue so a pool cannot exist without a catalogued cost. */
export const POOLS = gasPools.map((s) => ({ id: s.pool, sourceId: s.id, unit: s.unit, chain: s.chains[0] }))

/** The keccak preimages of the on-chain fee services, for the gate's contract cross-check. */
export const FEE_SERVICE_LABELS = FEE_SERVICES.map((s) => s.serviceLabel)
