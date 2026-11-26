# Data Model: Predict — live markets

Shapes used by the client and returned by the gateway. Nothing here is stored on the server.
Amounts are decimal **strings** end to end; arithmetic happens in integer micro-units.

## PriceReading (`lib/markets/priceReading.js`)

The only way a price reaches a component or the plan arithmetic.

| Field | Type | Notes |
|---|---|---|
| `state` | `'live' \| 'delayed' \| 'last-known' \| 'unknown'` | derived, never stored |
| `price` | string \| absent | absent only in `unknown` |
| `bids`, `asks` | `[price, size][]` best-first \| absent | present when a book was read |
| `confirmedAt` | number (gateway ms) | when the gateway last confirmed the value with the venue |
| `ageMs()` | function | `(serverNow − confirmedAt) + monotonic time since receipt` |
| `plannable` | boolean | `true` only for `live` |

Rules: constructed only by `live()`, `delayed()`, `lastKnown()`, `unknown()`, and by
`classify(raw, now)` which picks among them from age (≤ 5 s, ≤ 30 s, beyond). `orderPlan`
accepts a reading and returns `{ ok: false, reason: 'price-not-live' }` unless `plannable`.
A sequence gap from the stream source demotes the key to `delayed` until the next value.

## EventSummary / EventDetail

| Field | Type | Notes |
|---|---|---|
| `slug` | string | the event's address |
| `title` | string | text only |
| `category` | string \| null | our bounded category id |
| `volume`, `volume24h` | string \| null | USDC; `null` is unknown, never `"0"` |
| `endDate` | ISO string \| null | when trading closes |
| `mutuallyExclusive` | boolean | only then may rows be read as one distribution (FR-008) |
| `marketCount` | number | |
| `markets` | `MarketRow[]` | summary: the four most likely; detail: all |
| `description` | string | detail only; text, capped at 4,000 characters |
| `resolutionSource` | string \| null | detail only; text, or a link if it is an `https` URL |
| `status` | `'open' \| 'closed' \| 'resolved'` | detail |

## MarketRow

| Field | Type | Notes |
|---|---|---|
| `conditionId` | string | |
| `label` | string | the row's short label inside its event, else the question |
| `tradable` | boolean | |
| `outcomes` | `{ name, tokenId, price }[]` | `tokenId` a string, never a number |
| `bestBid`, `bestAsk`, `lastTradePrice` | string \| null | |
| `displayPrice` | string \| null | midpoint while spread ≤ 0.10, else last trade (FR-015) |
| `tickSize`, `minOrderSize` | string \| null | |
| `winner` | string \| null | winning outcome name when resolved |

## Book

| Field | Type | Notes |
|---|---|---|
| `tokenId` | string | |
| `bids`, `asks` | `[price, size][]` | best-first, at most 25 a side |
| `tickSize`, `minOrderSize` | string | |
| `lastTradePrice` | string \| null | |
| `venueTime` | ISO string | when this book state came into being at the venue |
| `venueHash` | string | the venue's identifier for the state; equal hashes mean an unchanged book |

## OrderPlan (`lib/predict/orderPlan.js`)

Input: a plannable reading, side, the amount (USDC to spend, or shares to sell), tolerance, tick.

| Field | Type | Notes |
|---|---|---|
| `ok` | boolean | false with `reason`: `price-not-live` (checked first), `no-depth`, `below-minimum`, `invalid-amount`, `invalid-tick`, `invalid-tolerance`, `invalid-limit` |
| `shares` | string | what the amount buys at current depth |
| `averagePrice` | string | cost ÷ shares |
| `worstPrice` | string | deepest level touched |
| `limitPrice` | string | buy: worst + tolerance, snapped up to the tick grid, at most one tick below 1; sell: worst − tolerance, snapped down, at least one tick. A member-named price must already be on the grid |
| `cost` | string | buy: USDC the fill costs; sell: USDC it returns. Less than the amount when depth runs out |
| `unfilled` | string | what had no offer at any shown price: USDC for a buy, shares for a sell. Only when every visible level was consumed; rounding dust left inside a level is not unfilled |
| `depthShare` | number 0–1 | fraction of visible far-side size consumed |
| `payoutIfRight` | string \| null | shares × 1 for a buy; `null` for a sell, which gives the payout up |
| `kind` | `'marketable' \| 'resting'` | resting when the member names a price |

Validation: amount > 0; shares ≥ `minOrderSize`; limit within (0, 1); never produced from a
non-live reading. Rounding is always against the member: a buy's level cost and average round
up, a sell's proceeds and average round down.

Fees and maximum loss are not computed here. `planNotional(plan)` hands the cost to the existing
`computeCost` (spec 057), and the ticket shows `cost + fees` as the most that can be lost.

## OrderProgress (`lib/predict/orderProgress.js`)

Device record, keyed by order id, in `userStorage` under `predict_orders_v1`.

| Field | Type | Notes |
|---|---|---|
| `orderId` | string | the venue's id |
| `tokenId`, `side`, `size`, `limitPrice` | strings | what was signed |
| `state` | see below | |
| `filledSize`, `settledSize` | strings | matched is the venue's word; settled is the chain's |
| `averageFillPrice` | string \| null | |
| `updatedAt` | number | |
| `reason` | string \| null | for the ending states and for `unconfirmed` |

```text
signed → sent → resting → partial → matched → settled
            ↘ matched            ↘ cancelled | expired   (fills so far still settle)
signed → unconfirmed → sent | not-delivered
signed → rejected
matched → failed
```

Terminal: `settled`, `rejected`, `not-delivered`, `cancelled`, `expired`, `failed`.
`unconfirmed` is never terminal and never rendered as a failure (FR-024). Records in a terminal
state are pruned after 7 days.

## SelfLimit (slice 8; shape only)

| Field | Type | Notes |
|---|---|---|
| `kind` | `'daily' \| 'weekly' \| 'pause'` | |
| `amount` | string \| null | ceiling in force |
| `used` | string | committed in the current window |
| `resetsAt` | ISO string | |
| `pending` | `{ amount, effectiveAt } \| null` | a relaxation waiting out its period |
| `pauseUntil` | ISO string \| null | |
| `state` | `'read' \| 'unreadable' \| 'unavailable'` | `unreadable` is never treated as no limit (FR-027c) |
