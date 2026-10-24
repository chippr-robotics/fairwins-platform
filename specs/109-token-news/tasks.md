# Tasks: Token news on portfolio and trade surfaces

**Input**: Design documents from `/specs/109-token-news/` (spec.md, plan.md, research.md,
data-model.md, contracts/gateway-news-api.md, quickstart.md — all merged via PR #1518)

**Tests**: included — constitution II (test-first) is non-negotiable in this repo; every behavior
task pairs with the suite that proves it, and the reserved matrix rows flip `absent → covered`
only when their Cypress specs exist.

**Organization**: grouped by user story; US1 alone is a viable MVP. Foundational phase carries the
gateway module + mapping + seam because all three stories consume the same `FeedReading`.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Verify workspace install is healthy (`node scripts/deps/check-dependency-hygiene.js`);
      if node_modules is absent run `npm run deps:reinstall` (NEVER plain `npm install` — spec 075).
      No new dependencies exist anywhere in this feature; the lockfile must end byte-identical.
- [X] T002 [P] Add `NEWS_ENABLED` (default false), `NEWS_BASE_URL` (default
      `https://api.alphaday.com`), `NEWS_CACHE_TTL_MS` (default 300000, clamped ≥ 300000 with one
      boot log line on clamp) to `services/relay-gateway/src/config/index.js`, following the
      `PERPS_*` block's shape and comments.

## Phase 2: Foundational (blocking — all three stories consume these)

- [X] T003 Create `services/relay-gateway/src/news/normalize.js`: vendor item → `NewsItem` per
      data-model.md (id/title/url/source{name,slug}/publishedAt/sentiment; drop image, icon,
      author, hash, likes, sentiment_score; drop items with non-`https:` url or missing/unparsable
      `published_at`). Document each field's provenance in comments (spec-082 normalizer rule).
- [X] T004 Create `services/relay-gateway/src/news/client.js`: keyless fetch of
      `{NEWS_BASE_URL}/items/news/?tags=<slug>&limit=<n>` with single-flight per slug, TTL cache
      (`NEWS_CACHE_TTL_MS`), `stale` marking, and STALE_FACTOR=10 beyond which the entry is gone
      (answer becomes `unreadable`, never stale-as-live). Copy the perps `client.js` cache device;
      no venue fan-out (research R3/R5, plan deviation 1).
- [X] T005 Create `services/relay-gateway/src/news/routes.js`: `GET /v1/news/:chainId/:asset`
      per contracts/gateway-news-api.md — pipeline killswitch → enabled (`503 news_unconfigured`
      off) → param validation (`slug` required, `^[a-z0-9-]{1,64}$`; `limit` 1–20 default 8;
      `chainId` integer or spec-061 Bitcoin string id; `asset` `0x…`-lowercase or `native`;
      `400 invalid_params` locally, never proxied) → quota (`callerQuotaKey`) → cached fetch
      returning the `FeedReading` shapes (`read` with possibly-empty `items`,
      `unreadable` with reason). Read-only: no write route in the module.
- [X] T006 Mount the news module unconditionally in `services/relay-gateway/src/server.js`
      beside the perps mount (off ⇒ the route itself answers 503).
- [X] T007 Create `services/relay-gateway/test/news.test.js` (node:test, fixture server like
      `test/perps.test.js`): read-with-items, honest-empty (`read`+`[]`), upstream 5xx/unreachable
      ⇒ `unreadable`, garbage-slug fixture ⇒ `read`+`[]` (fail-closed, research R3), missing slug ⇒
      400, module off ⇒ 503 `news_unconfigured`, single-flight (N concurrent = 1 upstream call —
      SC-005), TTL-clamp boot behaviour, normalize drops (http url, undated item, image/icon never
      forwarded).
- [X] T008 [P] Create `frontend/src/config/newsAssets.js`: curated `(chainId,address)→{slug}` +
      Bitcoin string-id entries, `newsSlugFor(assetKey) → slug | null` resolver (null IS
      "not covered"; no ticker heuristic, no fallback — data-model.md AssetNewsMapping). Seed rows
      probe-verified against live tags for: each cohort chain's native coin, the portfolio
      registry's majors (USDC, USDT, WETH, WBTC…), `bitcoin`, `ethereum-classic`. Record the
      verification date per row in a comment (spec-021-amendment discipline).
- [X] T009 [P] Create `frontend/src/lib/news/newsClient.js`: `fetchTokenNews({ chainId, asset })`
      → resolves slug via `newsAssets.js`; null slug short-circuits to the local not-covered
      outcome with NO network call; otherwise fetches the gateway route and passes the
      `FeedReading` through without invention; 503 `news_unconfigured` ⇒ `not-configured`.
- [X] T010 Create `frontend/src/test/news/newsClient.test.js` + `newsAssets.test.js` (Vitest):
      resolver null-for-unmapped, zero-network short-circuit (fetch spy), three states + honest
      empty passthrough, not-configured on 503, Bitcoin ids never hit EVM-shaped paths.

**Checkpoint**: gateway + seam proven by unit suites; stories can proceed (US1/US2/US3 in
parallel if staffed).

## Phase 3: User Story 1 — Portfolio token news card (P1) 🎯 MVP

**Goal**: selecting a portfolio token shows attributed, dated news with link-outs, under full
three-state + honest-empty honesty. **Independent test**: quickstart scenarios 1–5.

- [X] T011 [US1] Create `frontend/src/components/news/TokenNewsCard.jsx` +
      `TokenNewsCard.css`: consumes one `FeedReading`; renders items as TEXT (headline, source
      name, relative age, external link with attribution and plain-link fallback — perps
      `linkouts.js` pattern); `unreadable` ⇒ sentence + retry button; `read`+`[]` ⇒
      "No recent items for <asset>"; not-covered ⇒ "No news source covers this asset";
      `not-configured` ⇒ renders nothing. All colours via existing theme tokens (specs 090/091 —
      no new colour anywhere); component states carry accessible roles (a11y scanned in T021).
- [X] T012 [US1] Mount `TokenNewsCard` in `frontend/src/components/wallet/AssetDetailSheet.jsx`
      behind `isFeatureEnabled('news')`, fed by `fetchTokenNews` for the sheet's asset; on a
      testnet cohort render the perps-style honest notice (news describes the mainnet asset).
- [X] T013 [P] [US1] Add tenant feature `news` to `tenants/fairwins/manifest.json` and confirm
      `npm run tenants:validate` passes (feature list is validator-gated).
- [X] T014 [US1] Create `frontend/src/test/news/TokenNewsCard.test.jsx` (Vitest): each state
      renders its distinct copy; empty ≠ unreadable wording/style; no `<img>`/HTML from vendor
      fields; retry re-invokes the seam; feature-off renders nothing.

## Phase 4: User Story 2 — Trade-pair feed (P2)

**Goal**: the selected pair's news below the amount entry; partial coverage labelled; trading
never gated. **Independent test**: quickstart scenario 6.

- [X] T015 [US2] Mount a two-asset news feed (reusing `TokenNewsCard` per token) below the amount
      entry in `frontend/src/components/fairwins/TradePanel.jsx`, behind `isFeatureEnabled('news')`:
      mapped token renders its card, unmapped token renders the not-covered line (partial is
      labelled, never silently completed); every news state leaves the amount entry, quoting and
      submission untouched (FR-006).
- [X] T016 [US2] Extend `frontend/src/test/news/` with `TradePanelNews.test.jsx`: one-mapped/
      one-unmapped labelling; unreadable feed does not disable or delay the swap form.

## Phase 5: User Story 3 — Assistant `get_token_news` (P3)

**Goal**: tool-pull news on both rails and the MCP/external paths; never context-push.
**Independent test**: quickstart scenario 7 + parity gates.

- [X] T017 [US3] Add `get_token_news` to `packages/assistant-contract/src/tools.js` per
      contracts/gateway-news-api.md (`auth: 'none'`, public exec on
      `/v1/news/{chainId}/{asset}` with `slug`/`limit` query; inputSchema per contract) and the
      honest-result wording to `packages/assistant-contract/src/results.js` (third-party reported,
      attributed, not advice; unreadable stated, never summarized from memory; empty = sparse
      coverage). In-app loop resolves `slug` via `newsAssets.js` before the call.
- [X] T018 [US3] Regenerate `services/mcp-server/src/toolDefs.snapshot.json` by the repo's
      snapshot mechanism and run `node --test services/relay-gateway/test/mcpToolParity.test.js`
      green both directions. The MCP server itself gains no dependency and no code beyond the
      snapshot (spec 095 rule).
- [X] T019 [US3] Extend `services/relay-gateway/test/` assistant/tool coverage: the tool table
      entry round-trips through the gateway's public-tool executor; no `navigate`/`build_intent`
      added to the in-app table; the prompt (frozen per thread) contains no news content (FR-008).

## Phase 6: Polish & cross-cutting closers

- [X] T020 [P] Add FinOps cost entry `alphaday-news-api` to
      `packages/finops-catalogue/src/sources.js` (`basis: modelled`, $0 free tier, live with the
      module — research R7); `npm run check:finops` + `npm run test:finops-gate` green.
- [X] T021 Create `frontend/cypress/e2e/fast/49-token-news.cy.js` (no-chain tier; global
      beforeEach covers both viewports): TN-01 covered-token card renders items with attribution
      via a stubbed gateway; TN-02 unmapped asset ⇒ not-covered with zero `/v1/news` requests;
      TN-03 unreadable ⇒ sentence + retry, visually distinct from TN-04 honest-empty; TN-05
      trade-pair partial labelling with the swap form untouched; `cy.a11yScan` on the card. Every
      assertion must be able to fail (no guarded `expect(true)` — spec 094).
- [X] T022 Flip both `109-token-news` rows in `frontend/cypress/coverage/matrix.json` to
      `covered` (tier `no-chain`, depth `flow`, tests listed) and regenerate
      `docs/developer-guide/e2e-coverage-matrix.md` (`npm run e2e:matrix`); confirm the fast-tier
      splitter picks the spec up (`frontend/src/test/e2e-policy/tierSharding.test.js`).
- [X] T023 [P] Write `docs/developer-guide/token-news.md`: the module, the mapping table's
      curation rule (probe-verify every row, absence = not covered), the TTL floor's reason, the
      tool's posture; link from the spec-109 bullet's "See" line if wording drifts.
- [X] T024 Add `news` synonyms to `frontend/src/config/navSearchIndex.js` only if the card gets a
      nav-reachable home requiring it (likely none — cards live inside existing surfaces; skip
      with a note if so). DONE AS A SKIP: TokenNewsCard has no nav-reachable home — it renders
      inside AssetDetailSheet and TradePanel, both already indexed — so no entry was added.
- [X] T025 Full verification pass per quickstart.md: scoped Vitest dirs, gateway node:test,
      Cypress spec locally, `check:specs`, `check:e2e-matrix`, `check:finops`,
      `tenants:validate`, and the monorepo-verify gates for anything the diff touched.
      Deployment note (not a code task): enabling `NEWS_ENABLED` in
      `infra/vm/gateway/docker-compose.yml` is a separate, deliberate ops change — the FinOps
      entry is already live-with-module so no C2b promotion race exists (no payee, no fee).

## Dependencies

- Phase 2 blocks all stories (T003→T005→T006→T007 sequential; T008/T009→T010 parallel to gateway).
- US1 (T011→T012→T014; T013 parallel) blocks nothing else; US2 (T015→T016) needs T011's card;
  US3 (T017→T018→T019) needs only Phase 2's route.
- Phase 6: T020/T023 any time after Phase 2; T021→T022 need US1+US2 mounted; T025 last.

## Parallel opportunities

- After Phase 2: US1, US3 and T020/T023 can proceed concurrently (disjoint files); US2 starts
  once T011 exists.
- Within Phase 2: gateway chain (T003–T007) ∥ frontend seam chain (T008–T010).

## Implementation strategy

MVP = Phases 1–3 (gateway + seam + portfolio card): shippable behind `NEWS_ENABLED=false` +
tenant flag with zero member-visible change until both are on. US2 and US3 are additive
increments; Phase 6 closes the gates the estate requires before merge (matrix rows may not stay
`absent` once the flows exist).
