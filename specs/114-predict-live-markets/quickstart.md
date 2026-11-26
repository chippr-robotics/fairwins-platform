# Quickstart: proving spec 114

How to check each story. Shapes are in [data-model.md](data-model.md) and
[contracts/](contracts/); this page only says what to run and what to see.

## Prerequisites

- Workspace installed (`npm run deps:reinstall` if an install misbehaves; never plain `npm install`).
- Gateway configured for Predict as under spec 057 (`POLYMARKET_API_KEY` and friends).
- Frontend built with `VITE_RELAYER_URL` pointing at that gateway, wallet on Polygon.

## Gates per slice

```bash
# gateway (slice 1; slice 7's `test/markets.test.js` does not exist until the stream source is built)
(cd services/relay-gateway && npx vitest run test/polymarket.test.js)

# frontend units (scope the run; the full suite is CI-only)
cd frontend && npx vitest run src/test/markets src/test/predict

# brand, nav, e2e policy and mini-app boundary guards touched by new UI
cd frontend && npx vitest run src/test/brand src/test/nav src/test/e2e-policy src/test/miniapps/packageBoundary.test.js

# member flows, both widths. Cypress needs the no-chain dev server: `npm run dev:fast` (port 5173), because
# Predict hides unless VITE_RELAYER_URL is set; 37 covers the fixed-price fallback and the builder-fee lines.
cd frontend && CYPRESS_VIEWPORT_PROFILE=desktop npx cypress run --spec cypress/e2e/fast/52-predict-live.cy.js,cypress/e2e/fast/37-predict-and-collect.cy.js
cd frontend && CYPRESS_VIEWPORT_PROFILE=phone   npx cypress run --spec cypress/e2e/fast/52-predict-live.cy.js,cypress/e2e/fast/37-predict-and-collect.cy.js

# the matrix moves with the tests
npm run e2e:matrix && npm run check:e2e-matrix
```

## Story checks

**US1 — find a market.** Open `/wallet?tab=predict`. Choose a category: the list narrows and the
address gains `cat=`. Search a phrase: events from any category appear. A multi-market event is
one card with its leading rows and a count of the rest. The two chip rows are labelled in words — **Popular now**
(topics and In play) over **Categories** — and each label names its group. Reload the address: the same view returns.

**US2 — understand it.** Open `/wallet?tab=predict&event=<slug>` in a fresh tab. Outcomes, a
chart with five ranges, volume, closing time, resolution source and a depth ladder render. A
resolved event names its winner and shows no order control. Each outcome row shows that market's own traded
volume under its label (nothing when the venue did not state it, never `$0`).

**US3 — trust a price.** On an open event the chip reads Live. Stop the gateway (or block the
books route in dev tools): within 5 s every price is marked Delayed with a growing age, after 30 s
Last known; the ticket shows no figures and says it is waiting. Restore: Live returns without a
reload. Set the device clock an hour wrong and repeat: ages are unaffected (ages are measured on the server's
clock; `src/test/markets/serverClock.test.js` proves it, and it cannot be walked on a real gateway from CI).

**US4 — say how much.** On a live outcome enter `50`. Average price, shares, payout, maximum
loss, each fee line and the share of depth appear and follow the amount. Enter an amount beyond
the visible depth: the ticket says how much is fillable. On an outcome priced at 90¢ or more the
amount at risk is stated beside the gain. Review names the price limit. Nothing has been signed
until Sign. Open **Price tolerance** (collapsed): it offers one tick (the default), 1¢ and 2¢ — never wider, and
only the choices that fit the market's tick and keep the limit inside 0–100¢. Choose 2¢: the review's limit
widens, "The most you can lose" does not (a buy spends the amount typed), and the next ticket you open starts at
one tick again.

**US5 — follow it.** Sign a small marketable order: the tracker advances to Matched with no refresh and says
settlement happens on the blockchain — it **never** shows "Settled", because the app reads the venue, not the chain
(only the reducer can express `settled`, and nothing emits it yet). Reload mid-way: the order is still shown at its
current state. In a test, make the post time out after sending: the order reads "Not confirmed yet", is not a
failure, and neither the ticket nor the list offers to place it again; the only control is "I have checked on
Polymarket — stop tracking this". Open the app in a second tab while one is unconfirmed: both tabs show it, and
neither tab's later write drops it. A passkey session lists its open orders once trading is enabled on the
device, and says "Sign in to trading to see your open orders" before that.

**US6 — limits** (slice 8, **not built**: T041 onward are blocked on the feed backend). There is no Limits entry
yet, so this story cannot be walked. When it lands: with no feed backend the entry says limits are not yet
available; with it, set a daily limit, exceed it at review, see the order declined before signature; raise the
limit and see the old one still apply until the stated time.

## Without the feed (SC-007)

Leave the feed unconfigured, which is the default and the only state that exists today. Every check above for US1
to US5 passes; list prices read Delayed (the list is a 15 s poll and is never Live, so a list confirmed this second
reads "Delayed" with no age rather than "Delayed · 0 s"), and an open event reads Live from the two-second poll.
The gateway's `GET /v1/markets/capabilities` (`{"stream":false,"limits":false}`) is **not built yet** — it is slice
7 (T037), so that part cannot be checked until the stream source exists; the app does not call it today.
