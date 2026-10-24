# Configuration

System parameters: on-chain bounds, frontend defaults, and environment
variables.

## On-chain bounds (`WagerRegistry`)

```solidity
uint64 public constant MAX_ACCEPT_WINDOW  = 30 days;   // acceptDeadline must be within
uint64 public constant MAX_RESOLVE_WINDOW = 180 days;  // resolveDeadline must be within
```

Stake tokens must be allow-listed (`isAllowedToken`); USDC is the standard
stake token on both networks.

## Membership tiers (`MembershipManager`)

Tier configs are stored on-chain per role (`getTierConfig(role, tier)`) and
adjustable by `DEFAULT_ADMIN_ROLE`. Current production values for
`WAGER_PARTICIPANT_ROLE` (all 30-day durations, priced in USDC):

| Tier | Price | Wagers / month | Open wagers at once |
|------|-------|----------------|---------------------|
| Bronze   | $2   | 15        | 5         |
| Silver   | $8   | 30        | 10        |
| Gold     | $25  | 100       | 30        |
| Platinum | $100 | Unlimited | Unlimited |

See [Roles and Tiers](../system-overview/roles-and-tiers.md).

## Frontend defaults (`frontend/src/constants/wagerDefaults.js`)

The canonical source for UI defaults and the resolution-type enum:

| Constant | Value | Meaning |
|----------|-------|---------|
| `STAKE_AMOUNT` | 10 | Default stake (USDC) |
| `MAX_STAKE` | 1,000 | Form validation cap |
| `WAGER_END_DAYS` | 1 day | Default end time |
| `ACCEPTANCE_DEADLINE_HOURS` | 6 h | Default acceptance window |
| `MIN_TRADING_PERIOD_SECONDS` | 3,600 (1 h) | Minimum wager duration |
| `MAX_TRADING_PERIOD_SECONDS` | 1,814,400 (21 d) | Maximum wager duration |
| `RESOLUTION_WINDOW_SECONDS` | 172,800 (48 h) | Default resolve window after end time |
| `MAX_ACCEPT_WINDOW_SECONDS` | 2,592,000 (30 d) | Mirrors the on-chain cap |
| `MAX_RESOLVE_WINDOW_SECONDS` | 15,552,000 (180 d) | Mirrors the on-chain cap |
| `ODDS_MULTIPLIER` | 200 | Even-money payout (2×, basis 100) |

## Environment variables (frontend)

Public configuration is baked into the bundle at build time (Vite). Key
variables:

| Variable | Purpose |
|----------|---------|
| `VITE_NETWORK_ID` | Default chain: `137` (production) or `80002` (testnet) |
| `VITE_RPC_URL` / `VITE_RPC_URL_POLYGON` / `VITE_RPC_URL_AMOY` | RPC endpoints |
| `VITE_WALLETCONNECT_PROJECT_ID` | WalletConnect cloud project |
| `VITE_APP_URL` | Canonical app origin (used in share links) |
| `VITE_IPFS_GATEWAY` / `VITE_PINATA_GATEWAY` | IPFS read gateway |
| `VITE_ORACLE_MODELS` | `polymarket-only` (default) or `all` — which oracle resolution types the UI exposes |
| `VITE_POLYMARKET_GAMMA_URL` | Polymarket Gamma API for market search |
| `VITE_POLYGON_USDC` / `VITE_AMOY_USDC` | Stake-token overrides |
| `VITE_POLYGON_POLYMARKET_CTF` / `VITE_AMOY_POLYMARKET_CTF` | Polymarket CTF addresses |
| `VITE_AMOY_UNISWAP_*` | Optional testnet DEX wiring (Swap tab hidden without it) |

!!! warning "Secrets"
    `VITE_PINATA_JWT` and other secrets are **never** build args — they are
    injected at runtime on Cloud Run from Secret Manager. Anything passed as
    a `VITE_` build arg ends up readable in the shipped JS bundle.

Contract addresses are **not** environment variables — they're generated into
`frontend/src/config/contracts.js` from `deployments/` records via
`npm run sync:frontend-contracts`.

## Member API and assistant (gateway)

Set on the **relay gateway** (`services/relay-gateway`), spec 095. The module is
mounted unconditionally and gates itself: disabled means `503
member_api_unconfigured`, never a 404. Boot-failing validation runs only when the
module is enabled, so an unconfigured module can never take the gateway down.

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMBER_API_ENABLED` | `false` | Master switch for `/v1/member/*` |
| `MEMBER_API_KILLSWITCH` | `false` | Module-scoped stop → `503 member_api_killed` (distinct from the gateway-wide `killswitch_active`) |
| `MEMBER_API_MAX_TTL_DAYS` | `90` | Ceiling on a capability grant's lifetime; a longer grant is rejected `401 token_ttl_exceeded` |
| `MEMBER_API_SUBGRAPH_<chainId>` | unset | Subgraph URL used by `/v1/member/wagers` for that chain. Unset ⇒ that chain reports `not-configured` (an honest absence, not an outage) |
| `MEMBER_API_QUOTA_PER_ACCOUNT` | `120` | Requests per window for one **authenticated** account, keyed by the account recovered from the token signature — never by IP |
| `MEMBER_API_QUOTA_GLOBAL` | `600` | Requests per window across all authenticated callers |
| `MEMBER_API_QUOTA_WINDOW_MS` | `60000` | The window all four member-API request quotas roll over |
| `MEMBER_API_PUBLIC_QUOTA` | `240` | Requests per window for the **unauthenticated** routes (`openapi.json`, and the x402 402-challenge path), in a window of their own. Separate from the authenticated numbers on purpose: `trust proxy` is unset, so every anonymous caller keys to the nginx address — one shared bucket — and while it drew on the authenticated global a flood of them answered `429` to every member. `0` fails the boot |
| `MEMBER_API_REVOKE_QUOTA` | `60` | Requests per window for `POST /v1/member/keys/revoke` **alone**. An emergency control with a budget nothing else can spend: a member withdraws a leaked key exactly when this module may be under load. Budgeted rather than exempt — the handler does an ECDSA recovery and possibly an ERC-1271 chain call per request. `0` fails the boot |
| `ASSISTANT_ENABLED` | `false` | Sub-config of the Member API module. Off ⇒ `503 assistant_unconfigured` |
| `ASSISTANT_MODEL` | `claude-sonnet-5` | Model id for the assistant proxy |
| `ASSISTANT_MAX_TOKENS` | `1024` | Output ceiling per chat turn. **Hard-capped at 4096 in code** — a higher value fails the boot by name. Together with `ASSISTANT_MAX_ROUNDS` it bounds what a single member turn can cost, so it is not something an env file may raise without limit |
| `ASSISTANT_MAX_ROUNDS` | `4` | Spec 104. Tool rounds the gateway will serve per member turn on the FairWins rail — each round is a separate request drawing on the same token budget, so this is the multiplier on `ASSISTANT_MAX_TOKENS`. **Ceiling 8 in code**; a higher value fails the boot by name, and `4 × worst-case turn` must fit the per-account token budget or the boot check refuses the pair. The browser loop stops at the package's `MAX_TOOL_ROUNDS` (4) on both rails regardless; this variable can only lower what the gateway accepts, never raise what a client attempts. Tools themselves are attached server-side from `@fairwins/assistant-contract` — a client-supplied `tools` array is refused |
| `ASSISTANT_QUOTA_PER_ACCOUNT` | `20` | Model **calls** per window for one account — a tighter class than the module's reads, because a read and a model call are not the same permission |
| `ASSISTANT_QUOTA_GLOBAL` | `60` | Model calls per window across the gateway |
| `ASSISTANT_TOKEN_BUDGET_PER_ACCOUNT` | `200000` | Model **tokens** per account per budget window — the ceiling on money rather than traffic. Exhausted ⇒ `429 assistant_budget_exhausted`, never a truncated reply. Boot refuses a value below one maximal turn (a smaller number would be a size limit wearing a budget's name) |
| `ASSISTANT_TOKEN_BUDGET_GLOBAL` | `2000000` | Model tokens per window across the gateway. Boot refuses a value below the per-account budget |
| `ASSISTANT_TOKEN_BUDGET_WINDOW_MS` | `3600000` | The token-budget window — hourly, matching how the gas spend cap is judged. Independent of the request-quota window |
| `ANTHROPIC_API_KEY` | — | **SECRET.** Model-provider credential. Missing ⇒ `503 assistant_unconfigured` |
| `RATE_LIMIT_HEALTH_PER_MIN` | `600` | Coarse per-IP limiter on `/healthz` + `/status` (`0` = off). The signer-keyed quotas remain the real per-member control; on the VM deployment nginx fronts the container and `trust proxy` is unset, so this acts as an aggregate ceiling there |
| `RATE_LIMIT_INTENTS_PER_MIN` | `300` | Coarse per-IP limiter on `POST /v1/intents` (`0` = off), bounding signature-recovery work ahead of the signer quota; same aggregate-ceiling caveat |

!!! danger "`ANTHROPIC_API_KEY` is the only secret this feature adds"
    Deliver it through Secret Manager and `infra/vm/common/fetch-secrets.sh`
    (declared **optional**, so a missing key degrades the assistant instead of
    aborting the gateway boot). Never place it in `docker-compose.yml`, a build
    arg, a Terraform variable, or any `VITE_` variable. Secrets are read at boot —
    a new version does nothing until the unit restarts. See
    [Member API Operations](../runbooks/member-api-operations.md#32-enable-the-assistant).

!!! warning "The quota windows are separate on purpose — do not merge them"
    `/v1/member/*` is **not** behind `express-rate-limit` (that middleware covers
    `/healthz`, `/status` and `POST /v1/intents`), so these four windows are the
    module's whole limiter. They are four `createQuotas` instances rather than one
    because they make four different promises: an authenticated member's budget, a
    single shared anonymous budget, an unstarvable budget for key revocation, and a
    tighter class for model calls. Pointing two of them at one instance re-pools the
    counters and lets the cheapest traffic on the module deny the most important —
    which is exactly the state this configuration replaced.

Member API tokens are **not** configuration: a member signs their own EIP-712
capability grant in the app and the gateway stores nothing. There is no key,
table, or credential on the server side to configure, back up, or rotate.

## x402 pay-per-request (gateway)

Set on the **relay gateway**, spec 096. A sub-module of the Member API: it cannot
answer while `MEMBER_API_ENABLED` is false, and with `X402_ENABLED=false` the
member API behaves exactly as it did before spec 096. **None of these are
secrets** — the treasury, the network and the prices are published to every
unauthenticated caller by design, in every `402` answer and at `/status`.

| Variable | Default | Purpose |
|----------|---------|---------|
| `X402_ENABLED` | `false` | Master switch for the paid rail. A valid capability token is checked first and is **never** charged |
| `X402_KILLSWITCH` | `false` | On ⇒ the offer is withdrawn: priced routes refuse exactly as unpriced ones do and no payment is taken; member-authenticated traffic unaffected |
| `X402_CHAIN_ID` | the gateway's default chain | Chain payments are signed on and settle on. When enabled it must be an enabled chain with a payment token, a token domain and an engine lane — anything else fails the boot by name |
| `X402_PAY_TO` | — | Treasury address payments are made to. **Required when enabled, and deliberately has no default** — a default is a default destination for other people's money, and a stale one is money sent to an address nobody holds |
| `X402_SETTLE_BUFFER_SECONDS` | `60` | Minimum remaining validity a payment must carry, so a payer is not charged for a race between the check and the submission |
| `X402_MAX_TIMEOUT_SECONDS` | `300` | The `maxTimeoutSeconds` published in each offer |
| `X402_PRICE_READ` | `10000` | Read class, in USDC base units (6 decimals, so `10000` = $0.01). **`0` ⇒ that class is not offered at all** — zero is off, not free |
| `X402_PRICE_BUILD` | `50000` | Typed-data build class. `0` ⇒ not offered |
| `X402_PRICE_ASSISTANT` | `100000` | Assistant turn. `0` ⇒ not offered |
| `X402_NONCE_MAX` | `50000` | Bound on the in-process replay set (Phase 1 — the durable guarantee is the token's own authorisation state) |

!!! warning "An enabled rail with no `X402_PAY_TO` fails to boot, on purpose"
    Boot-failing validation runs **only** inside the enabled branch, so an
    unconfigured optional module can never take the gateway's relay path down —
    but an *enabled* one missing a treasury, a payment token or an engine lane
    refuses to start rather than guessing. Do not resolve that by adding a
    default address. See
    [Member API Operations](../runbooks/member-api-operations.md#33-enable-pay-per-request-x402-spec-096).

A payment itself is never configuration: it is a single-use, per-request
`X-PAYMENT` header signed by the payer. A payload replayable out of an
environment variable would be a standing withdrawal rather than a payment.

## MCP server

Set on the `fairwins-mcp-server` service (`services/mcp-server`), or in a member's
own MCP client configuration when they run it locally.

| Variable | Default | Purpose |
|----------|---------|---------|
| `FAIRWINS_API_URL` | — | Gateway base URL (e.g. `https://relay.fairwins.app`). Unset ⇒ the server still starts and lists tools, and each call returns an honest error |
| `FAIRWINS_API_TOKEN` | — | **SECRET (the member's own token).** In `--http` mode a per-request `Authorization: Bearer` header overrides it, which is what lets one hosted instance serve several members without holding anyone's credential |
| `FAIRWINS_TIMEOUT_MS` | `15000` | Per-request upstream timeout |
| `PORT` | `8790` | Default port for `--http` when none is given on the command line |

The service holds no other secret and no service account of its own — authorization
arrives with each request. There is deliberately **no variable for an x402 payment**:
a payment is single-use and per-request, so it travels as an `X-PAYMENT` header in
`--http` mode and is forwarded upstream unaltered.

## Updating configuration

- **Tier prices/limits** — `DEFAULT_ADMIN_ROLE` on `MembershipManager`
- **Oracle adapters** — `DEFAULT_ADMIN_ROLE` sets per-type adapter slots on
  `WagerRegistry` (`OracleAdapterUpdated`)
- **Sanctions oracle / deny list** — see [Contract Interfaces](contracts.md#isanctionsguard)
- **Frontend defaults** — edit `wagerDefaults.js` (keep in sync with on-chain
  caps)
