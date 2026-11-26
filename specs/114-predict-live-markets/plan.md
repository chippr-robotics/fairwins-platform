# Implementation Plan: Predict — live markets, market pages and an amount-first order ticket

**Branch**: one branch per slice into `staging` | **Date**: 2026-11-26 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/114-predict-live-markets/spec.md` (issue #1747);
live venue probes recorded in [research.md](research.md).

## Summary

Predict becomes navigable and honest about time. Markets are listed by event with categories,
search and sort; an event has its own address and a page with history, depth and resolution
rules; every price carries a trust state; the order ticket takes an amount and shows what it
means before signature; an order's progress is followed without a refresh.

Technical approach: extend the spec-057 read proxy with four cached routes (events, one event,
order book, price history), and build the surface on **one client seam for market data** that has
two sources behind it. The first source polls the proxy and ships now. The second is a
FairWins-operated market feed reached through the gateway as a server-sent event stream; it is
optional, off by default, and slots in without the surface changing. Order placement keeps the
spec-057 rail exactly: the member's wallet signs, the browser posts to the venue. What changes is
that the order is **planned from the depth on offer** and carries a price limit the member is
shown.

Self-limits (US6) are held by FairWins against the account (spec Clarifications). They need the
feed's backend and are the last slice; until it exists the surface says limits are not yet
available rather than keeping a weaker copy on the device.

## Technical Context

**Language/Version**: Node 22 ESM (gateway), React 18 + Vite (frontend) — existing stack

**Primary Dependencies**: none added. `recharts` (already a frontend dependency) draws the
history chart; `@polymarket/clob-client` (already present) places orders; the gateway uses global
`fetch` and Express's own response stream for SSE. Lockfile untouched (spec-075 rules).

**Storage**: none on the server in this plan. Orders in progress are kept on the device in
`userStorage` (`predict_orders_v1`, deliberately absent from `syncedObjects.js`) so they survive a
reload (FR-025). Self-limits are server-held and out of the slices that ship first.

**Testing**: gateway `node:test` (`services/relay-gateway/test/polymarket.test.js`, fixture-driven);
frontend Vitest for the reading type, the plan arithmetic, the feed seam and each component;
Cypress no-chain tier, both viewport profiles, for the six matrix rows; `cy.a11yScan` on the new
surfaces.

**Target Platform**: existing gateway deployment + web/PWA/native shells

**Project Type**: web service module + frontend feature (existing monorepo workspaces)

**Performance Goals**: an event reachable in under 15 s from opening Predict (SC-001); with the
feed, a venue price change visible within 2 s at p95 (SC-002); without it, an open market's book
no older than about 3 s and list prices honestly marked delayed. Upstream requests bounded by
distinct markets viewed, not by members (single-flight TTL cache).

**Constraints**: custody and signing unchanged (FR-022, FR-035); fee disclosure unchanged (FR-034);
no price is used for a plan unless its reading is live (FR-013); ages are measured on the
gateway's clock, never the device's; no vendor image or markup is rendered (text only, the
spec-109 posture); `connect-src` is not widened (EventSource is plain HTTPS).

**Scale/Scope**: about 12 new frontend modules and 6 reworked, 4 gateway routes plus 2 for the
stream seam; one new Cypress spec file.

## Constitution Check

*GATE: evaluated against constitution v1.1.0 before Phase 0; re-checked after Phase 1.*

| Principle | Verdict | Reasoning |
|---|---|---|
| I. Security-first contracts | PASS (n/a) | No contract change. Custody, access control and oracle paths untouched. |
| II. Test-first | PASS | Each slice lands with its tests: reading and plan arithmetic are pure and unit-tested first; routes are fixture-tested; each member flow gets a Cypress test that can fail (no unconditional truths, spec 094). |
| III. Honest state | PASS, and the point of the feature | Three trust states derived from confirmation time; unknown shown as unknown; matched distinct from settled; unconfirmed distinct from failed. No mock in a shipped path: the stream route proxies a real upstream or answers `feed_unconfigured`. |
| IV. Fail loudly in CI | PASS | No `continue-on-error`. Matrix rows move from `absent` to `covered` only with the test that covers them. |
| V. Accessible frontend | PASS | WCAG 2.1 AA at both widths and themes; price movement signalled by glyph and text as well as colour; live regions announce state changes, not every tick; reduced motion respected. Colours only from `theme.css` tokens (specs 090/091). |
| Workflow 4. Simplicity | PASS | No new dependency, no new store, no new route outside the existing tab. The feed seam is one module with two sources because the surface must work without the feed (FR-029); that is the requirement, not speculation. |
| Workflow 5. Multi-agent | PASS | Number claimed by merged reservation #1748. Work is tracked on #1747; each slice is its own PR into `staging`. |

No violations. Complexity Tracking is empty.

## Project Structure

### Documentation (this feature)

```text
specs/114-predict-live-markets/
├── plan.md              # this file
├── research.md          # Phase 0: decisions and live probes
├── data-model.md        # Phase 1: readings, plans, order progress
├── quickstart.md        # Phase 1: how to prove each story
├── contracts/
│   ├── gateway-predict-api.md   # the four new read routes
│   └── market-feed-seam.md      # the client seam and the stream route
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
services/relay-gateway/
├── src/polymarket/
│   ├── routes.js            # + events, events/:slug, book, prices-history
│   ├── normalize.js         # + event, market row, book, history normalizers
│   └── categories.js        # NEW bounded category → venue tag table
├── src/markets/             # NEW venue-neutral stream seam (slice 7)
│   ├── routes.js            # capabilities + SSE relay of the optional feed
│   └── upstream.js          # one upstream connection, fan-out, conflation
└── test/polymarket.test.js  # + fixtures for every new route

frontend/src/
├── lib/markets/             # NEW, venue-neutral
│   ├── priceReading.js      # the three-state reading; only `live` is plannable
│   ├── feed.js              # subscribe(keys, cb): proxy-poll source, stream source
│   └── serverClock.js       # age on the gateway's clock
├── lib/predict/
│   ├── predictClient.js     # + fetchEvents, fetchEvent, fetchBook, fetchHistory
│   ├── orderPlan.js         # NEW walk the depth: average, worst, limit, share of depth
│   ├── orderProgress.js     # NEW state reducer + device store
│   └── clobSession.js       # market (fill-and-kill) orders with a price limit
├── hooks/
│   ├── usePredictEvents.js  # NEW list by category/sort/search
│   ├── usePredictEvent.js   # NEW one event
│   ├── useMarketReadings.js # NEW readings for a set of keys via feed.js
│   ├── usePriceHistory.js   # NEW
│   └── usePredictTrade.js   # plan-first flow
└── components/predict/
    ├── PredictPanel.jsx     # browse: chips, sort, search, event cards (reworked)
    ├── EventCard.jsx        # NEW
    ├── EventPage.jsx        # NEW replaces MarketDetailSheet
    ├── PriceHistoryChart.jsx# NEW
    ├── DepthLadder.jsx      # NEW
    ├── TrustChip.jsx        # NEW the one place a trust state is drawn
    ├── OrderTicket.jsx      # NEW amount-first; replaces TradeConfirm's entry step
    ├── OrderReview.jsx      # NEW names the price limit
    ├── OrderProgress.jsx    # NEW
    └── PositionsList.jsx / OpenOrdersList.jsx   # auto-refresh, no manual button

frontend/cypress/e2e/fast/52-predict-live.cy.js    # NEW
```

**Structure Decision**: stay inside the two existing workspaces. Venue-neutral pieces go under
`lib/markets/` and `src/markets/` so Perps and Trade can adopt them (FR-030) without importing
from `predict/`; everything that knows about Polymarket stays under `polymarket/` and `predict/`.

## Slices

Each is one PR into `staging`, green on its own, and leaves the product working.

| # | Slice | Stories | Depends on | Owner agents |
|---|---|---|---|---|
| 1 | Gateway reads: events, event, book, history | — | — | relay, witness |
| 2 | Client foundation: reading, server clock, feed seam (poll source), plan arithmetic | US3 | 1 | glass, witness |
| 3 | Browse by event: chips, sort, search, cards, address state | US1, US3 | 2 | glass, witness |
| 4 | Event page: outcomes, chart, depth, rules | US2 | 3 | glass, witness |
| 5 | Amount-first ticket and review | US4 | 4 | glass, teller, latch (passkey signer path), witness |
| 6 | Order progress and live positions/orders | US5 | 5 | glass, witness |
| 7 | Stream seam: gateway relay + `feed.js` stream source | US3 (SC-002) | 2, and the feed existing | relay, mark (nginx buffering), witness |
| 8 | Self-limits | US6 | 7's backend | relay, glass, witness |

Slices 1–6 need nothing that does not exist today. Slices 7 and 8 need the feed's backend, which
is built outside this repository; they are specified here so the seam they plug into is right
from slice 2.

## Phase 0 — Research

See [research.md](research.md). Every unknown is resolved or assigned to a slice as a
first-task verification; none blocks slice 1.

## Phase 1 — Design

- [data-model.md](data-model.md): `PriceReading`, `EventSummary`, `MarketRow`, `Book`,
  `OrderPlan`, `OrderProgress`, `SelfLimit`.
- [contracts/gateway-predict-api.md](contracts/gateway-predict-api.md): request, response and
  error shape of each new route.
- [contracts/market-feed-seam.md](contracts/market-feed-seam.md): `feed.js`'s interface, the two
  sources, and the stream route.
- [quickstart.md](quickstart.md): the commands and observations that prove each story.

**Constitution re-check after design**: unchanged, PASS. The design adds no store, no dependency
and no path that signs.

## Complexity Tracking

None.
