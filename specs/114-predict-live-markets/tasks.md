# Tasks: Predict — live markets, market pages and an amount-first order ticket

**Input**: Design documents from `/specs/114-predict-live-markets/` (spec.md, plan.md, research.md,
data-model.md, contracts/gateway-predict-api.md, contracts/market-feed-seam.md, quickstart.md)

**Tests**: included — constitution II is non-negotiable here. Every behaviour task is paired with
the suite that proves it, and a matrix row moves from `absent` to `covered` only in the PR that
adds its Cypress test.

**Organization**: by slice, each one PR into `staging` (plan.md § Slices). Slices 1–6 need nothing
that does not exist today. Slices 7–8 are blocked on the market feed's backend and are listed so
the seam they plug into is right from the start.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [X] T001 Verify the workspace install (`node scripts/deps/check-dependency-hygiene.js`); if
      `node_modules` is absent run `npm run deps:reinstall` (never plain `npm install`, spec 075).
      This feature adds no dependency; the lockfile must end byte-identical.

## Phase 2: Slice 1 — gateway reads (blocks everything)

- [X] T002 Add `POLYMARKET_BOOK_TTL_MS` (default 2000, floor 1000, one boot log line on clamp) and
      `POLYMARKET_HISTORY_TTL_MS` (default 60000) to `services/relay-gateway/src/config/index.js`
      beside the existing `POLYMARKET_*` block, with its comment style.
- [X] T003 [P] Create `services/relay-gateway/src/polymarket/categories.js`: the bounded category
      id → venue tag slug table (research R3) and `isCategory()`. Confirm each slug returns events
      against the live venue and record the check in the PR.
- [X] T004 Extend `services/relay-gateway/src/polymarket/normalize.js` with `normalizeEvent`
      (summary and detail), `normalizeMarketRow` (label from `groupItemTitle`, `displayPrice` by
      the venue's spread rule, numbers the venue omits → `null`), `normalizeBook` (flip to
      best-first, cap 25, strings preserved, `venueTime`, `venueHash`) and `normalizeHistory`.
      Text only: drop `image`, `icon` and any markup field (research R14). Comment each field's
      provenance.
- [X] T005 Add to `services/relay-gateway/src/polymarket/routes.js` the four routes of
      contracts/gateway-predict-api.md: `/events`, `/events/:slug`, `/books`, `/prices-history`,
      each through `cache.fetchThrough` with the contract's TTLs and the
      `confirmedAt`/`serverNow`/`stale` envelope. `/books` caches per token and reports
      `unreadable` tokens instead of failing the batch.
- [X] T006 Tests in `services/relay-gateway/test/polymarket.test.js`, fixture-driven from the
      probed payloads: each route's happy path; every 400 in the contract; a `null` volume stays
      `null`; a worst-first venue book comes back best-first; one unreadable token in a batch
      leaves the others intact; a stale copy is flagged; the request the gateway **sends**
      upstream is asserted (tag slug, order, interval and fidelity), not only what it returns.
- [X] T007 Run `npx vitest run` in `services/relay-gateway`; update
      `docs/developer-guide/predict-polymarket.md` with the four routes. Open the slice PR.

## Phase 3: Slice 2 — client foundation (US3: trust state)

- [X] T008 [P] [US3] `frontend/src/lib/markets/serverClock.js`: age from `confirmedAt`,
      `serverNow` and a monotonic receipt time; never reads the device wall clock. Tests in
      `frontend/src/test/markets/serverClock.test.js` include a device clock set an hour wrong.
- [X] T009 [P] [US3] `frontend/src/lib/markets/priceReading.js` per data-model.md: four
      constructors, `classify`, bounds in one exported constant, only `live` is `plannable`.
      Tests in `frontend/src/test/markets/priceReading.test.js`: each boundary, `stale: true` can
      never classify live, `unknown` carries no price.
- [X] T010 [P] [US4] `frontend/src/lib/predict/orderPlan.js` per data-model.md, BigInt
      micro-units. Tests in `frontend/src/test/predict/orderPlan.test.js`: single level, several
      levels, amount beyond depth (`unfilled` > 0), below minimum, limit on the tick grid and
      ≤ 0.99, sell side, a non-plannable reading returns `price-not-live`, and no float appears in
      any result.
- [X] T011 [US3] Add `fetchEvents`, `fetchEvent`, `fetchBooks`, `fetchHistory` to
      `frontend/src/lib/predict/predictClient.js`; extend `frontend/src/test/predict/predictClient.test.js`.
- [X] T012 [US3] `frontend/src/lib/markets/feed.js` with the proxy-poll source
      (contracts/market-feed-seam.md): reference-counted keys, one poller, ten keys a request,
      paused while the document is hidden, back-off on error, re-classification on a one-second
      tick. Tests in `frontend/src/test/markets/feed.test.js` with fake timers: two subscribers
      share one request; the last unsubscribe stops polling; a value ages live → delayed →
      last-known with no new response; an `unreadable` token yields `unknown`, not an empty book.
- [X] T013 [US3] `frontend/src/hooks/useMarketReadings.js` over `feed.js`, and
      `frontend/src/components/predict/TrustChip.jsx` (+ `.css`, tokens only): Live / Delayed · age
      / Last known · age, `role="status"`, announced on state change only. Tests in
      `frontend/src/test/predict/TrustChip.test.jsx`.
- [X] T014 [US3] Scoped Vitest (`src/test/markets src/test/predict src/test/brand`). Open the
      slice PR.

## Phase 4: Slice 3 — browse by event (US1) 🎯 first member-visible change

- [X] T015 [US1] `frontend/src/hooks/usePredictEvents.js`: category, sort, search and paging
      against `/events`, race-safe as `usePredictMarkets` is, refreshed every 15 s while visible.
- [X] T016 [P] [US1] `frontend/src/components/predict/EventCard.jsx` (+ `.css`): title, category,
      leading rows with probability, Yes/No prices, movement glyph that is not colour alone, "N
      more", volume, closing date, and a trust label when not live. Targets ≥ 44 px.
- [X] T017 [US1] Rework `frontend/src/components/predict/PredictPanel.jsx`: category chips
      (`aria-pressed`), sort control, search, event cards, address state via `useSearchParams`
      (`cat`, `sort`, `q`), honest empty and degraded states kept. Remove the manual Refresh.
- [X] T018 [US1] Vitest: `frontend/src/test/predict/PredictPanel.test.jsx` (reworked),
      `EventCard.test.jsx`, `usePredictEvents.test.jsx`.
- [X] T019 [US1] `frontend/cypress/e2e/fast/52-predict-live.cy.js`: PL-01 category narrows the
      list and sets the address; PL-02 search finds an event outside the first page; PL-03 a
      multi-market event is one card; PL-04 `cy.a11yScan`. Flip `predict.browse-by-event` to
      `covered` in `frontend/cypress/coverage/matrix.json`; `npm run e2e:matrix`.
- [X] T020 [US1] Update `frontend/src/config/navSearchIndex.js` synonyms for Predict if category
      names warrant; run `src/test/nav/navSearchIndex.test.jsx`. Open the slice PR.

## Phase 4b: Slice 3b — quick filters (US1, FR-002a–c)

- [X] T020a [US1] Gateway `GET /v1/polymarket/:chainId/discover` and the `topic` / `live`
      parameters on `/events` per contracts/gateway-predict-api.md: topic selection by marginal
      day volume (research R16) as a pure, separately tested function; the mechanics denylist and
      the one-hour floor as configuration; `live` on `EventSummary`. Tests assert the upstream
      requests, the de-duplication (two tags naming the same events yield one topic), the
      exclusion of sub-hour events, and each half failing on its own.
- [X] T020b [US1] `fetchDiscover` in `predictClient.js`; `usePredictDiscover` (60 s refresh,
      paused while hidden); a quick-filter row under search in `PredictPanel` — an in-play chip
      with its count, then topic chips — absent when there is nothing behind it; `topic` and
      `live` in the address; an in-play card shows the venue's score and period as text.
- [X] T020c [US1] Vitest for the hook and the row; Cypress PL-04b a topic chip narrows the list
      and sets the address, PL-04c the in-play chip is absent when nothing is in play. Open the
      slice PR.

## Phase 5: Slice 4 — the event page (US2)

- [X] T021 [US2] `frontend/src/hooks/usePredictEvent.js` and `frontend/src/hooks/usePriceHistory.js`.
- [X] T022 [P] [US2] `frontend/src/components/predict/PriceHistoryChart.jsx` (recharts, lazy
      loaded): five ranges, at most four series from `--chart-series-*`, gaps as gaps, live tail
      from the current reading, a text alternative naming each outcome's current value.
- [X] T023 [P] [US2] `frontend/src/components/predict/DepthLadder.jsx`: nearest levels both sides
      from the reading; an empty side says there is nothing on offer.
- [X] T024 [US2] `frontend/src/components/predict/EventPage.jsx` (+ `.css`) replacing
      `MarketDetailSheet`: header, TrustChip, outcomes with Yes/No, chart, depth, rules and
      resolution source as text (https link only), closed and resolved states with no order
      control; addressed by `event=<slug>`; independent markets never drawn as a distribution.
- [X] T025 [US2] Vitest for the three components and two hooks; Cypress PL-05 open by address in
      a fresh session, PL-06 resolved event shows the winner and no order control, PL-07 a11y.
      Flip `predict.market-page` and `predict.price-trust-state` (PL-08: block the books route,
      see Delayed then Last known, and the ticket's refusal). Open the slice PR.

- [ ] T025a [US2] Per-outcome traded volume (FR-005): the gateway's market row carries no
      volume, so the event page shows the event's volume only. Add `volume` to `MarketRow` from the
      venue's per-market figure and show it on each outcome row.
- [X] T025b [US3] The ticket's refusal on a non-live price (the last clause of PL-08) lands with
      the ticket itself in slice 5; PL-08 covers the chip and the depth ladder today.

## Phase 6: Slice 5 — the amount-first ticket (US4)

- [X] T026 [US4] **Verify first** (research R7): `@polymarket/clob-client` places a fill-and-kill
      order with an explicit price for the wallet signer and the passkey (ERC-1271) signer.
      Record the result in research.md; if it cannot, implement the named fallback.
- [X] T027 [US4] Extend `frontend/src/lib/predict/clobSession.js` with the marketable order call
      carrying `limitPrice`; keep `createAndPostOrder` for resting orders. Tests beside the
      existing session tests.
- [X] T028 [US4] Rework `frontend/src/hooks/usePredictTrade.js` to plan-first: reading → plan →
      fees → review → sign, re-planning at sign time and returning to review when the plan moved
      beyond tolerance (FR-021). Geoblock, network and fee-unconfirmed gates unchanged.
- [X] T029 [P] [US4] `frontend/src/components/predict/OrderTicket.jsx` (+ `.css`): amount input,
      quick amounts, Yes/No, the figures of FR-017, the near-certainty statement, the waiting
      state when the reading is not live, optional "set a price" for a resting order.
- [X] T030 [P] [US4] `frontend/src/components/predict/OrderReview.jsx`: repeats the figures,
      names the price limit, states what happens to an unfilled remainder.
- [X] T031 [US4] Vitest: `OrderTicket.test.jsx`, `OrderReview.test.jsx`, reworked
      `usePredictTrade.test.jsx` (no signature requested before review; non-live reading yields
      no figures; plan moved ⇒ back to review). Retire `TradeConfirm` and its test once nothing
      imports it.
- [X] T032 [US4] Cypress PL-09 amount drives the figures, PL-10 amount beyond depth, PL-11 fee
      lines present and the builder fee its own line, PL-12 a11y on the open sheet. Flip
      `predict.amount-first-ticket`. `teller` reviews the disclosure; `latch` reviews the passkey
      path. Open the slice PR.

- [ ] T032a [US4] A member-adjustable price tolerance (research R7 allows up to 2¢). The ticket
      ships with it fixed at one tick.
- [ ] T032b The spec-057 ticket, kept as the fallback for a gateway without the new routes, passes
      `negRisk: false` for a sell opened from a position. On a neg-risk market that order is
      signed for the wrong exchange and the venue rejects it. The new ticket passes the flag only
      when it is stated and otherwise lets the order SDK ask the venue; fix the old path the same
      way or retire it once every gateway serves the new routes.
- [ ] T032c The spec-057 ticket's `submitOrder` reports a venue refusal as an order sent (it reads
      no error from the answer) and cannot tell a refusal from an answer that never arrived. The
      new ticket's two submit functions classify the answer (`readPostFailure`); move the old path
      onto the same reading, with the `unknown` state on `TradeConfirm`, or retire it.
- [ ] T032d Positions: the gateway reports `negRisk: false` when the venue's answer carries no
      flag. Report `null` there instead, so an absent flag is not readable as a stated one. (The
      ticket already treats a position's `false` as unstated.)
- [X] T032e Review fixes before the slice PR. Signing path: an answer that never arrived is
      `unknown` and offers no re-send; a balance shortfall is an error, not "the market moved";
      ref-based locks against a double press; the ticket is not swapped out mid-sign; a resting
      order carries its reviewed tick; `negRisk` unstated is asked of the venue. Fees: lines and
      total from one quote; USDC on every figure; "before Polymarket's fee" unless the rate was
      read as zero; the maker or taker rate named on a named-price order.

## Phase 7: Slice 6 — order progress (US5)

- [ ] T033 [US5] `frontend/src/lib/predict/orderProgress.js`: the reducer of data-model.md and
      the `predict_orders_v1` device store; add a test asserting the key is absent from
      `lib/backup/syncedObjects.js`. Tests cover every transition and that `unconfirmed` is never
      terminal.
- [ ] T034 [US5] `frontend/src/hooks/usePredictOrders.js`: polls the venue for tracked orders
      with the member's on-device session, resolves `unconfirmed` by lookup, never re-posts.
- [ ] T035 [US5] `frontend/src/components/predict/OrderProgress.jsx`; make `PositionsList` and
      `OpenOrdersList` refresh on their own and drop their Refresh buttons.
- [ ] T036 [US5] Vitest for reducer, hook and component; Cypress PL-13 progress advances without
      refresh, PL-14 survives a reload, PL-15 a timed-out post shows unconfirmed and offers no
      resubmit. Flip `predict.order-progress`. Open the slice PR.

## Phase 8: Slice 7 — the stream source (blocked on the feed backend)

- [ ] T037 `services/relay-gateway/src/markets/{routes,upstream}.js` per
      contracts/market-feed-seam.md: capabilities, SSE relay with one upstream connection,
      per-key conflation, 64-key cap, ping, `feed_unconfigured` when unset. Mounted
      unconditionally. Tests with a local upstream in the test file only.
- [ ] T038 `infra/`: response buffering off for the stream location in the gateway's nginx
      (`mark`); the feed's address added to the gateway compose file, commented out.
- [ ] T039 Stream source in `frontend/src/lib/markets/feed.js`: EventSource, sequence-gap rule,
      30 s silence ⇒ fall back to polling, less-trusting-of-two classification. Tests with a fake
      EventSource.
- [ ] T040 Cypress PL-16 (stream drops ⇒ readings degrade then recover on the poll source).

## Phase 9: Slice 8 — self-limits (US6; blocked on the feed backend)

- [ ] T041 [US6] Owner decision recorded in spec.md: an unreadable limit blocks or warns.
- [ ] T042 [US6] Gateway limit routes and the member-signed change (struct in
      `@fairwins/intent-types/offchain`, outside `CONTRACT_VERIFIED_TYPES`), with its own gate
      test in the spec-095 pattern.
- [ ] T043 [US6] Limits surface, the meter in `OrderTicket`, refusal at review; Vitest and Cypress
      PL-17/PL-18. Flip `predict.self-limit`.

## Phase 10: Polish

- [ ] T044 [P] `docs/developer-guide/predict-polymarket.md` rewritten for the new surface; a
      CLAUDE.md guardrail paragraph for spec 114 (the reading type, the seam, what stays on the
      device).
- [ ] T045 Capture harness and actor-critic screenshot pass for browse, event page, ticket and
      progress in both themes and both widths (`actor-critic-screens` skill).
- [ ] T046 Walk quickstart.md end to end, including "Without the feed".

## Dependencies

T002–T007 → T008–T014 → T015–T020 → T020a–T020c → T021–T025 → T026–T032 → T033–T036.
T037–T040 need T012 and the feed. T041–T043 need T037's backend. Within a phase, `[P]` tasks touch
different files and can run together.

## MVP

Slices 1–3 (T001–T020): members find markets by event and category with honest price ages. Each
later slice adds one story and none of them changes who signs.
