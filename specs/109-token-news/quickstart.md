# Quickstart: validating token news (spec 109)

End-to-end validation scenarios proving the feature against the spec's success criteria. Shapes
and rules referenced, not restated: [contracts/gateway-news-api.md](contracts/gateway-news-api.md),
[data-model.md](data-model.md).

## Prerequisites

- `npm run deps:reinstall` completed (never plain `npm install` — spec 075).
- Gateway running locally with `NEWS_ENABLED=true` (all other `NEWS_*` defaults);
  `npm run frontend` for the SPA. No key material needed anywhere (research R1).
- For fixture-driven runs, point `NEWS_BASE_URL` at the test fixture server the gateway tests
  ship (live-vendor runs work too but are not what CI does).

## Scenario 1 — Covered portfolio token (SC-001, US1.1)

1. Open the portfolio, select a token with a row in `newsAssets.js` (e.g. the chain's native coin).
2. **Expect**: the news card populates within 3 s — headline, source name, age, link-out per item;
   opening an item leaves the app with the original article.
3. Gateway check: `curl "localhost:8788/v1/news/137/native?slug=polygon&limit=3"` → `state:"read"`
   with items.

## Scenario 2 — Unmapped asset = honest absence, zero network (US1.2)

1. Select a portfolio token with **no** `newsAssets.js` row.
2. **Expect**: "no news source covers this asset" — instantly, with **no** `/v1/news` request in
   the network tab (the seam short-circuits on `null` slug).
3. Negative control (SC-002): temporarily map two fixture assets whose tickers collide to their
   distinct correct slugs; each card shows only its own asset's items.

## Scenario 3 — Unreadable ≠ empty (US1.3, FR-003)

1. Stop the gateway (or set an unreachable `NEWS_BASE_URL`) and select a covered token.
2. **Expect**: "the feed could not be read" + retry — worded and styled distinctly from
   Scenario 5's empty state. Retry after restoring the gateway recovers without reload.

## Scenario 4 — Module/feature off = surfaces absent (SC-006, US1.4)

1. Set `NEWS_ENABLED=false` (gateway answers `503 news_unconfigured`) — **expect** no news card
   anywhere, no broken affordance.
2. Same with the tenant feature `news` removed from the manifest: both mounts absent at build.

## Scenario 5 — Sparse coverage is content, not failure (R3)

1. Select a covered long-tail asset whose slug returns few/old items (probe fixture:
   `ethereum-classic`).
2. **Expect**: items render with honest ages (months-old reads as months-old); zero items renders
   "No recent items for <asset>" — not an error, no retry offered.

## Scenario 6 — Trade pair feed (US2)

1. Trade ▸ Swap, select a pair with one mapped and one unmapped token.
2. **Expect**: feed below the amount entry shows the mapped token's items and names the unmapped
   token as not covered (partial labelled). The amount entry, quoting, and submission are
   untouched in every news state (FR-006) — including Scenario 3's unreadable.

## Scenario 7 — Assistant tool-pull only (US3, SC-004)

1. Open the assistant (either rail), ask "what's the news on POL?"
2. **Expect**: one `get_token_news` round; reply cites fetched items with sources, labelled as
   third-party reporting.
3. Ask about an unmapped asset → the assistant states non-coverage; stop the gateway and ask →
   states unreadability. It never invents items.
4. Control (FR-008): a conversation that never mentions news makes zero `/v1/news` calls, and the
   thread's system prompt contains no news content (inspect the request in dev tools).
5. MCP: `services/mcp-server` lists `get_token_news`; parity test green both directions.

## Scenario 8 — Load coalescing (SC-005, FR-010)

1. With the gateway's debug logging on, open the same covered token in 3 tabs within the TTL.
2. **Expect**: exactly one upstream request for the slug per TTL window (single-flight + cache);
   `stale:true` appears only inside the serve-stale window, `unreadable` beyond it.

## Test commands

```bash
node --test services/relay-gateway/test/news.test.js        # gateway module, fixture-driven
npx vitest run frontend/src/test/news/                      # seam + card + mapping resolver
npx cypress run --spec frontend/cypress/e2e/fast/49-token-news.cy.js   # both reserved flows
node scripts/e2e/generate-coverage-matrix.js --check        # matrix rows flipped in same PR
npm run check:finops                                        # catalogue entry present
npm run tenants:validate                                    # feature flag valid
```

CI: the two Cypress flows ride the no-chain tier at both viewports automatically (global
beforeEach); no on-chain coverage exists or is admissible (no money path — e2e policy rule 1).
