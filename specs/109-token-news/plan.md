# Implementation Plan: Token news on portfolio and trade surfaces

**Branch**: `claude/external-data-context-2cec94` | **Date**: 2026-09-06 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/109-token-news/spec.md`; estate evaluation
`docs/research/alphaday-news-agent-context-evaluation.md` (merged, PR #1508); live vendor probes
recorded in [research.md](research.md).

## Summary

Members see recent, attributed news for a selected portfolio token and for the selected trade
pair, and the assistant gains one public `get_token_news` tool — retrieval is tool-pull only.
Technical approach: a fourth instance of the spec-082 read-proxy pattern. A read-only, optional
relay-gateway module (`services/relay-gateway/src/news/`, `NEWS_ENABLED`, default off) proxies the
keyless Alphaday `/items/news/?tags=<slug>` endpoint behind the standard pipeline (killswitch →
enabled → validation → quota → single-flight per-asset TTL cache). Asset identity is a curated
`(chainId, tokenAddress) → tag slug` table on our side — the vendor exposes no contract identity,
and an unmapped or garbage slug fails closed to honest absence. The frontend adds two
tenant-flagged cards (portfolio token detail, trade pair) consuming one three-state client seam;
the assistant tool is one entry in `@fairwins/assistant-contract` plus the MCP snapshot regen. No
datastore, no context-push, no new secret, no fee path; one FinOps cost entry (modelled $0,
free-tier dependency).

## Technical Context

**Language/Version**: Node 22 ESM (gateway), React 18 + Vite (frontend) — existing stack, nothing new

**Primary Dependencies**: none added. Gateway uses global `fetch` (as `perps/client.js` does);
frontend uses existing seams. Lockfile untouched (spec-075 rules).

**Storage**: N/A — in-process TTL cache only (perps `client.js` device). FR-009 forbids a durable
store; nothing durable is introduced.

**Testing**: gateway `node:test` (`services/relay-gateway/test/news.test.js`, fixture-driven like
`test/perps.test.js`); frontend Vitest for the seam + cards; Cypress no-chain tier for the two
member flows (the reservation's matrix rows, `proposedTier: no-chain`); parity gates
(`mcpToolParity.test.js`) pick up the tool automatically.

**Target Platform**: existing gateway deployment (`infra/vm/gateway/docker-compose.yml` env) + web/PWA/native shells

**Project Type**: web service module + frontend feature (existing monorepo workspaces)

**Performance Goals**: news card populated ≤ 3 s on selection (SC-001); upstream requests per
asset bounded by the cache window regardless of concurrent viewers (SC-005)

**Constraints**: cache TTL ≥ 300 s (vendor's own `cache-control: max-age=300` is the freshness
floor — anything lower buys nothing); vendor rate limits unpublished ⇒ conservative single-flight
+ quota + serve-stale-bounded (STALE_FACTOR device); no CORS at the vendor ⇒ ALL reads route
through the gateway, the browser can never call Alphaday directly

**Scale/Scope**: bounded by distinct assets viewed (portfolio registry ≈ dozens of assets/chain ×
8 cohort chains), not by member count — the cache makes vendor load O(assets), not O(members)

## Constitution Check

*GATE: evaluated against constitution v1.1.0 before Phase 0; re-checked after Phase 1.*

| Principle | Verdict | Reasoning |
|---|---|---|
| I. Security-first contracts | PASS (n/a) | No contract changes. No funds, access control, or oracle path touched. News is advisory-only (FR-006) and never gates a value path. |
| II. Test-first, comprehensive | PASS | Gateway module lands with fixture-driven `node:test` suite; frontend seam + cards with Vitest; two no-chain Cypress flows are already reserved in the coverage matrix (`news.portfolio-token-card`, `news.trade-pair-feed`) and get specs in the implement phase. No money path ⇒ no on-chain tier (e2e policy rule 1 *forbids* it). |
| III. Honest state, no mocks in shipped paths | PASS (load-bearing) | The feature's core design IS this principle: three-state readings (`read`/`unreadable`/`not-configured`) with "no recent items" a distinct content state; unmapped assets render honest absence; module off ⇒ surfaces absent; stale age always shown. No fabricated zeros/empties anywhere. Testnet cohort: news is mainnet-asset reality — the card carries the perps-style honest notice on testnet cohorts rather than pretending testnet tokens have news. |
| IV. Fail loudly in CI | PASS | New tests join existing gating jobs (Relay Gateway Tests, Frontend Unit Tests, Cypress fast tier, MCP parity). No `continue-on-error` anywhere. FinOps C2 fails CI if the vendor dependency lands uncatalogued — the entry ships in the same change. |
| V. Accessible, consistent frontend | PASS | Cards use existing tokenized styling (no new colours — spec 090/091 gates), text-only third-party content, `axe` via the fast-tier `cy.a11yScan`. Link-outs follow the perps `linkouts.js` attribution pattern with plain-link fallback. |
| Workflow: spec→plan→tasks→implement | PASS | Number 109 claimed by merged reservation PR #1512; this plan follows the merged spec. |

**No violations — Complexity Tracking is empty.** Post-Phase-1 re-check: design artifacts add no
storage, no dependency, no new credential, no second fee-config store; verdicts unchanged.

## Project Structure

### Documentation (this feature)

```text
specs/109-token-news/
├── spec.md              # merged (reservation #1512) + specified (this PR)
├── plan.md              # this file
├── research.md          # Phase 0 — vendor probes + decisions R1–R7
├── data-model.md        # Phase 1 — NewsItem, AssetNewsMapping, FeedReading
├── quickstart.md        # Phase 1 — end-to-end validation guide
├── contracts/
│   └── gateway-news-api.md   # /v1/news/* route contract + tool contract
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks output (not created here)
```

### Source Code (repository root)

```text
services/relay-gateway/src/news/
├── routes.js            # /v1/news/* — killswitch → enabled → validation → quota → cached fetch
├── client.js            # Alphaday fetch + single-flight TTL cache + STALE_FACTOR (perps device)
└── normalize.js         # vendor item → NewsItem; provenance comments per field (perps rule)
services/relay-gateway/src/config/index.js   # + NEWS_ENABLED, NEWS_BASE_URL, NEWS_CACHE_TTL_MS
services/relay-gateway/src/server.js         # mount the module (unconditional mount, 503 off)
services/relay-gateway/test/news.test.js     # fixture-driven, incl. degraded/empty/unmapped

frontend/src/config/newsAssets.js            # curated (chainId,address)→{slug} map + resolver
                                             # (beside assetTaxonomy.js; absence = not covered)
frontend/src/lib/news/newsClient.js          # one seam: three-state FeedReading fetch from gateway
frontend/src/components/news/TokenNewsCard.jsx   # shared card (used by both surfaces)
frontend/src/components/news/TokenNewsCard.css
frontend/src/…portfolio token detail…        # mount card behind tenant feature (exact file per tasks)
frontend/src/…TradeSection swap pane…        # mount feed below amount entry
frontend/src/test/news/*.test.jsx            # seam + card Vitest
frontend/cypress/e2e/fast/49-token-news.cy.js  # the two reserved no-chain flows

packages/assistant-contract/src/tools.js     # + get_token_news (public, GET /v1/news/{chainId}/{address})
packages/assistant-contract/src/results.js   # honest wording: reported/third-party/not-advice
services/mcp-server/src/toolDefs.snapshot.json  # regenerated (parity-gated both directions)

packages/finops-catalogue/src/sources.js     # + cost entry: alphaday-news-api (modelled, $0 free tier)
tenants/fairwins/manifest.json               # + feature "news" (validator-gated)
frontend/src/config/… tenant feature gate    # isFeatureEnabled('news') on both mounts
frontend/cypress/coverage/matrix.json        # rows flip absent→covered in the implement phase
```

**Structure Decision**: the perps module layout verbatim (routes/client/normalize + config +
test), because the pattern's failure isolation, cache device, and copy conventions are the
reviewed, shipped shape for exactly this class of feature. The mapping table lives in
`frontend/src/config/` beside the asset taxonomy so "offered" and "resolvable" sit in one place
(the spec-108 `wrappedNative.js` precedent) — the gateway proxies by slug and never guesses
identity; identity is resolved client-side where the canonical asset records live, and travels to
the gateway as an explicit slug parameter that the gateway validates against shape only.

Two deliberate deviations from perps, each smaller than the template:
1. **No venue fan-out** — one vendor, so `sources` reporting collapses to the single feed's
   three-state reading; the per-venue isolation machinery is not copied in dead.
2. **No FeeRouter service** — there is no revenue or fee path (evaluation §2.4); adding a
   `ConfigOnly` service would be a second untruth, not future-proofing.

## Complexity Tracking

*No constitution violations — intentionally empty.*
