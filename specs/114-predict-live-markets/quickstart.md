# Quickstart: proving spec 114

How to check each story. Shapes are in [data-model.md](data-model.md) and
[contracts/](contracts/); this page only says what to run and what to see.

## Prerequisites

- Workspace installed (`npm run deps:reinstall` if an install misbehaves; never plain `npm install`).
- Gateway configured for Predict as under spec 057 (`POLYMARKET_API_KEY` and friends).
- Frontend built with `VITE_RELAYER_URL` pointing at that gateway, wallet on Polygon.

## Gates per slice

```bash
# gateway (slices 1, 7)
(cd services/relay-gateway && npx vitest run test/polymarket.test.js test/markets.test.js)

# frontend units (scope the run; the full suite is CI-only)
cd frontend && npx vitest run src/test/markets src/test/predict

# brand and e2e policy guards touched by new UI
cd frontend && npx vitest run src/test/brand src/test/e2e-policy

# member flows, both widths
cd frontend && CYPRESS_VIEWPORT_PROFILE=desktop npx cypress run --spec cypress/e2e/fast/52-predict-live.cy.js
cd frontend && CYPRESS_VIEWPORT_PROFILE=phone   npx cypress run --spec cypress/e2e/fast/52-predict-live.cy.js

# the matrix moves with the tests
npm run e2e:matrix && npm run check:e2e-matrix
```

## Story checks

**US1 — find a market.** Open `/wallet?tab=predict`. Choose a category: the list narrows and the
address gains `cat=`. Search a phrase: events from any category appear. A multi-market event is
one card with its leading rows and a count of the rest. Reload the address: the same view returns.

**US2 — understand it.** Open `/wallet?tab=predict&event=<slug>` in a fresh tab. Outcomes, a
chart with five ranges, volume, closing time, resolution source and a depth ladder render. A
resolved event names its winner and shows no order control.

**US3 — trust a price.** On an open event the chip reads Live. Stop the gateway (or block the
books route in dev tools): within 5 s every price is marked Delayed with a growing age, after 30 s
Last known; the ticket shows no figures and says it is waiting. Restore: Live returns without a
reload. Set the device clock an hour wrong and repeat: ages are unaffected.

**US4 — say how much.** On a live outcome enter `50`. Average price, shares, payout, maximum
loss, each fee line and the share of depth appear and follow the amount. Enter an amount beyond
the visible depth: the ticket says how much is fillable. On an outcome priced at 90¢ or more the
amount at risk is stated beside the gain. Review names the price limit. Nothing has been signed
until Sign.

**US5 — follow it.** Sign a small marketable order: the tracker advances to Matched and then
Settled with no refresh. Reload mid-way: the order is still shown at its current state. In a
test, make the post time out after sending: the order shows Sent, not yet confirmed, and the
ticket does not offer to place it again.

**US6 — limits** (slice 8). With no feed backend the Limits entry says limits are not yet
available. With it: set a daily limit, exceed it at review, see the order declined before
signature; raise the limit and see the old one still apply until the stated time.

## Without the feed (SC-007)

Leave the feed unconfigured, which is the default. Every check above for US1 to US5 passes; list
prices read Delayed, an open event reads Live from the two-second poll, and
`GET /v1/markets/capabilities` answers `{"stream":false,"limits":false}`.
