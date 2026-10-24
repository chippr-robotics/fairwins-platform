# Research: Token news (spec 109)

**Date**: 2026-09-06. All vendor claims below were verified by live probes of
`https://api.alphaday.com` on this date from this repository's tooling; nothing is quoted from
marketing copy. The evaluation (`docs/research/alphaday-news-agent-context-evaluation.md` §4)
listed these as the questions gating this plan; each is answered here.

## R1 — Vendor access model: keyless, public, self-documenting

**Decision**: integrate keyless; introduce no credential surface (spec FR-013's keyless branch).

**Measured**: every probed read answered `200` with no auth header: `/get-started/` (endpoint
enumeration), `/openapi.json` (255,960 bytes, full parameter schemas), `/items/news/` (+
`trending`, `last_24_hours`, `summary` variants), `/tags/`, `/market/coins/`. No 401/403 anywhere;
no key issuance flow advertised. The root document states the API is public and lists an
unauthenticated MCP server (`POST /mcp`, streamable-http) with a server card at
`/.well-known/mcp/server-card.json` (verified present, `version 2.31.13`).

**Consequence**: no `scripts/secrets/registry.js` entry, no tfvars, no spec-097 work. If a keyed
tier ever appears, FR-013 governs and it is a config-only follow-up.

**Alternatives considered**: none needed — the keyless claim was the risk, and it verified.

## R2 — No CORS: the gateway proxy is REQUIRED, not stylistic

**Decision**: every browser read routes through `services/relay-gateway/src/news/`; the frontend
never calls the vendor.

**Measured**: `OPTIONS /items/news/` with `Origin: https://app.fairwins.io` +
`Access-Control-Request-Method: GET` → `200` with **zero** `Access-Control-*` headers; a plain
`GET` with an `Origin` header likewise returns no `Access-Control-Allow-Origin`. A browser fetch
would be blocked by CORS on every deployment.

**Consequence**: the evaluation's recommended architecture is also the only working one. The
module-off behaviour (`503 news_unconfigured`, SPA hides surfaces) is therefore total: off means
no news anywhere, honestly.

## R3 — News-by-asset: tag slugs, fail-closed

**Decision**: query `/items/news/?tags=<slug>&limit=N`; treat the tag slug as the sole asset key
the vendor understands.

**Measured**:
- `?tags=ethereum-classic&limit=2` → relevant items (each: `id`, `hash`, `title`, `url`, `image`,
  `author`, `published_at` ISO-8601 Z, `source{name,slug,icon}`, `sentiment`, `sentiment_score`,
  `likes`). Pagination by `links.next`, no total count.
- `?tags=zzzz-not-a-real-tag-9x` → `results: []` — **a garbage slug returns nothing, never the
  firehose.** The wrong-news hazard has no vendor-side path; our only hazard is mapping a real
  asset to the *wrong real* slug, which is why the mapping is curated and reviewed (R4).
- No `tags` param → the global firehose (fresh: latest item was 25 min old at probe time). The
  gateway therefore **requires** the slug parameter on the asset route — the firehose is not a
  member surface in this release.
- Other filters exist (`period`, `sources`, `search`, `sentiment`) — noted, unused in MVP.
- Freshness varies by tag: ETC's newest item was ~2.5 months old at probe time. This validates
  spec FR-001's mandatory age display and the "no recent items" honest state — sparse coverage is
  normal for long-tail assets and must read as sparse, not broken.

## R4 — Asset identity: the vendor has NO contract identity; the mapping is ours

**Decision**: a curated, reviewed `(chainId, tokenAddress) → { slug }` table in
`frontend/src/config/newsAssets.js`, resolved beside the canonical asset records
(`assetTaxonomy.js#getPortfolioRegistry`); absence of an entry IS the "not covered" outcome
(spec FR-004). Native coins map per chain (e.g. Polygon native → `polygon`). Bitcoin's string
network ids (spec 061) map directly (`bitcoin`) and never touch EVM seams.

**Measured**: tag records are `{id, name, slug, keywords[], parents[]}` — names/keywords/parent
slugs only. Coin records are `{id, name, ticker, slug, icon, rank, price…}` — the icon URL is a
CoinMarketCap asset but no CMC/CoinGecko id, contract address, or chain field is exposed anywhere
in the schema (confirmed against the full `openapi.json`). There is **nothing to join on** except
human-curated correspondence. 3,590 coin-type tags exist; tickers collide freely in that space.

**Rationale**: a curated table bounded by our own portfolio registry (dozens of rows) with honest
absence beats any heuristic (symbol match would be exactly the collision bug the spec forbids).
`wrappedNative.js#listWrappableCoins` (spec 108) is the precedent: the offer-list lives beside the
resolver so "offered" and "resolvable" cannot drift.

**Alternatives considered**: symbol-based lookup against `/market/coins/` (rejected: collisions,
and ticker→slug is still a guess); asking the vendor's `search` (rejected: full-text over
articles, not identity).

## R5 — Caching and load: vendor sets a 300 s floor; single-flight per asset

**Decision**: in-process TTL cache keyed by slug, TTL default 300 s (env `NEWS_CACHE_TTL_MS`,
clamped ≥ 300 s), single-flight per key, serve-stale bounded by the perps `STALE_FACTOR` device
(stale beyond 10× TTL degrades to `unreadable`, never stale-as-live — ages are displayed anyway).

**Measured**: responses carry `cache-control: public, max-age=300, must-revalidate` — the vendor
itself serves 5-minute-cached content, so a shorter client TTL cannot increase freshness, only
load. **No rate-limit headers** are exposed and no limits are published; the budget is unknown, so
the design must make vendor load a function of distinct assets (cache + single-flight), not
members (spec FR-010/SC-005), and the standard gateway quota bounds any single caller.

## R6 — Assistant tool: one public entry, existing rails, nothing new to secure

**Decision**: `get_token_news` joins `@fairwins/assistant-contract` as a **public** tool
(`auth: 'none'`, `exec: { kind: 'public', method: 'GET', path: '/v1/news/{chainId}/{address}' }`),
shaped like `get_perps_pairs`/`get_prediction_markets`. Input: `chainId` (integer, or the string
`bitcoin` id per spec-061 rules — validated, never passed to EVM seams), `address` (token address
or `native`). The description carries the honest-result wording: third-party reported content,
attributed, not advice, never an instruction. MCP snapshot regenerated; `mcpToolParity.test.js`
gates both directions. x402/member-API pricing applies through the existing per-op-class env
config with `0 = not offered` — no new pricing machinery.

**Measured/verified in-repo**: the tool table's public-tool shape (read from
`packages/assistant-contract/src/tools.js`); the vendor's own MCP server exists for external
agents who want deeper Alphaday access directly — we deliberately do not wrap or embed it
(evaluation §2.4): FairWins exposes only its own asset-scoped read.

## R7 — FinOps: one cost entry, `modelled` $0, visible from day one

**Decision**: catalogue entry `alphaday-news-api` as a cost source, `basis: modelled` over the
free tier ($0), status live-with-the-module; no revenue entry (no fee, no referral — C2b has
nothing to claim and no `_PAY_TO`/`_REF_CODE` env exists). Spec FR-012 satisfied at introduction,
which is exactly the moment spec-089 demands.

**Rationale**: "free dependency we rely on" is a fact FinOps must see — if the vendor ever prices
the tier, the entry is where that lands, not a surprise.
