# Research: Predict — live markets

Decisions for [plan.md](plan.md). Venue facts marked **probed** were read from the live public
endpoints on 2026-11-26; the rest come from the venue's documentation and are named as such.

## R1 — Where the list comes from

**Decision**: the venue's events listing (`gamma-api` `/events`), not its markets listing.

**Rationale**: an event already groups its markets, which is the shape FR-001 asks for. **Probed**:
`/events?active=true&closed=false&archived=false&order=volume24hr&ascending=false` returns events
with `slug`, `title`, `description`, `resolutionSource`, `endDate`, `volume`, `volume24hr`,
`liquidity`, `negRisk`, `tags[]` and `markets[]`; each market carries `conditionId`, `question`,
`groupItemTitle` (the short row label inside an event), `outcomes`, `outcomePrices`,
`clobTokenIds`, `bestBid`, `bestAsk`, `lastTradePrice`, `spread`, `orderPriceMinTickSize`,
`orderMinSize`, `acceptingOrders`. `tag_slug=economy` filters by category. `?slug=<slug>` returns
one event with all its markets.

**Alternatives**: grouping the existing `/markets` page client-side (a page of 100 markets does
not contain whole events); a library that unifies venues (adds a 70 MB dependency to a workspace
whose lockfile rules exist for a reason, to call two endpoints).

## R2 — Search

**Decision**: the venue's `public-search` endpoint, proxied.

**Rationale**: **probed**, `/public-search?q=fed%20decision` returns matching events across
categories. Today's search filters one volume-ranked page of 100 markets by substring, so anything
outside the top hundred cannot be found.

## R3 — Categories

**Decision**: a bounded table in the gateway (`polymarket/categories.js`) from our category id to
the venue's tag slug; an unknown category is a 400, never passed through.

**Rationale**: tags at the venue are open-ended and member-visible navigation should not be. A
bounded enumeration also keeps cache keys bounded. First task of slice 1 confirms each slug
returns events.

## R4 — Order book and the headline price

**Decision**: proxy the venue's `/book` per outcome token, normalised best-first and capped at 25
levels a side, with a 2 s single-flight cache. The headline probability follows the venue's rule:
the midpoint while the spread is at most 10¢, else the last trade (FR-015).

**Rationale**: **probed**, `/book?token_id=` returns `bids`, `asks` (worst-first, strings),
`timestamp`, `hash`, `tick_size`, `min_order_size`, `neg_risk`, `last_trade_price`. The venue's
`timestamp` is when that book state came into being, which gives the reading an honest
confirmation time that is not "when we happened to fetch". A 2 s cache means upstream load is one
request per viewed outcome per 2 s however many members are looking.

## R5 — What makes a price live without the feed

**Decision**: a reading's state is computed from **how long ago the gateway last confirmed the
value with the venue**, on the gateway's clock.

- Each response carries `confirmedAt` (when the gateway's cached copy was fetched) and `serverNow`.
- The client computes age as `(serverNow − confirmedAt) + (time since the response arrived)`,
  using a monotonic local timer for the second term. The device's wall clock is never read.
- Live ≤ 5 s, delayed ≤ 30 s, last known beyond (FR-011 starting bounds; constants in one module).

**Consequence, stated to the member**: the list polls every 15 s, so list prices are *delayed* by
construction on the proxy source and say so; an open event polls its books every 2 s and is
*live*. The feed removes that difference later. A book whose venue `timestamp` is old is not
stale: nothing changed, and we confirmed that two seconds ago.

**Alternatives**: treating `fetchedAt` from the device clock as the age (wrong on a device with a
wrong clock, the spec's own edge case); calling every polled value live (the thing FR-010 forbids).

## R6 — The reading type

**Decision**: `lib/markets/priceReading.js` with four constructors — `live`, `delayed`,
`lastKnown`, `unknown` — where only `live` returns an object whose `plannable` is true and the
plan arithmetic refuses anything else by type, not by convention.

**Rationale**: the spec-089 `reading.js` device: if only one constructor can produce a usable
value, "plan from a stale price" has no code path. `lib/chains/chainReadResult.js` is not reused;
its states are about deployment (`not-deployed`), not time.

## R7 — Planning an order from depth

**Decision**: `lib/predict/orderPlan.js`, pure, in integer micro-units (BigInt), walks the far
side of the book for the member's amount and returns average price, shares, worst level touched,
the price limit, and the share of visible depth consumed.

- Limit = worst level touched plus a tolerance (default one tick, member-adjustable up to 2¢),
  clamped to the tick grid and to 0.99.
- A marketable order is sent fill-and-kill with that limit; a member-named price is sent to rest.
- If the amount exceeds visible depth the plan says how much is fillable and does not pretend the
  rest has a price.

**Rationale**: FR-016 to FR-018. The limit is the only number the venue enforces on the member's
behalf, so it is computed in one tested place and shown verbatim.

**Verify in slice 5, first task**: that the installed `@polymarket/clob-client` (^5.8.1) places a
fill-and-kill market order with an explicit price, for both the wallet signer and the passkey
(ERC-1271) signer path. If it cannot, the fallback is a resting limit order at the limit price
with a short expiry, and the review step says the order rests.

## R8 — The chart

**Decision**: `recharts` line chart of the venue's price history, one series per outcome, at most
four series with the rest reachable; gaps are drawn as gaps.

**Rationale**: `recharts` is already installed. **Probed**, `/prices-history?market=<token>&interval=1d&fidelity=5`
returns `{history:[{t,p}]}` (277 points for a day at 5 min; 231 for `max` at 12 h). Range to
`interval`/`fidelity`: 1H→`1h`/1, 1D→`1d`/5, 1W→`1w`/30, 1M→`1m`/180, MAX→`max`/720. Colours from
the `--chart-series-*` tokens, which differ in lightness as well as hue. The live tail is the
current reading appended; a period with no reading is `null`, never interpolated.

## R9 — Addresses

**Decision**: state lives in the query string of the existing tab:
`/wallet?tab=predict&cat=<id>&sort=<id>&q=<text>&event=<slug>`.

**Rationale**: FR-003. The tab id and drawer-search deep links stay valid (spec 081 rules); the
app's convention for a view inside a tab is a query parameter (`?view=`), not a new route.

## R10 — One seam for market data

**Decision**: `lib/markets/feed.js` exposes `subscribe(keys, onReadings) → unsubscribe` with keys
of the form `<venue>:<instrument>`. Two sources implement it: **proxy-poll** (ships in slice 2)
and **stream** (slice 7, `EventSource` to the gateway). The gateway's `/v1/markets/capabilities`
decides which; a stream that drops falls back to polling without the caller knowing.

**Rationale**: FR-029 to FR-031. Keys are venue-neutral so Perps and Trade can subscribe later.
`EventSource` is plain HTTPS, so the content-security policy is unchanged (it grants `https:` and
no bare `wss:`), it reconnects on its own, and one connection carries every key on screen.

## R11 — Order progress without the feed

**Decision**: after signing, the client records the order id on the device and polls the venue
for that order with the member's own session (the credentials already derived on the device for
spec 057), reducing what it sees into the states of [data-model.md](data-model.md). An ambiguous
post (timeout after send) becomes **unconfirmed** and is resolved by looking the order up, never
by posting again.

**Rationale**: FR-023 to FR-025 with nothing new on the server. When the feed exists the same
reducer takes its events instead of the poll.

## R12 — Self-limits

**Decision**: server-held (spec Clarifications), delivered in slice 8 with the feed's backend.
Until then the limits entry point states that limits are not yet available. No device-only
stand-in ships.

**Rationale**: a limit that clearing the browser removes would be presented as the control the
spec promises and would not be it. FR-027c in miniature: absent is said to be absent.

## R13 — Fees

**Decision**: unchanged. The builder rate comes from the existing `/fee-rate` route (FeeRouter
first, environment fallback), `computeCost` runs over the planned notional, each fee is its own
line, signing is blocked when the rate cannot be confirmed (057 FR-010).

## R14 — Text only

**Decision**: event titles, descriptions and resolution sources are rendered as text. No venue
image, icon or markup is forwarded by the gateway. A resolution source that parses as an `https`
URL is shown as a link with `rel="noopener noreferrer"`; anything else is plain text.

**Rationale**: counterparty-authored content (spec 109's posture), and no `img-src` change.

## R15 — FinOps and infrastructure

No new revenue or cost source: the same public venue API, called more efficiently. No catalogue
entry is needed and `check:finops` is unaffected. Slice 7 adds one gateway environment variable
for the feed's address, which is not a payee, and one nginx change (response buffering off for the
stream location) that belongs to that slice.

## R16 — Quick filters: what is active now

**Decision**: one gateway route, `/discover`, computed from two venue reads and cached for 60 s:
the hundred events with the most trading in the last day, and the events in play. It returns the
count and leading events in play, and up to eight **topics** — venue tags ranked by the trading
they carry, chosen so that each adds events the earlier ones did not.

**Probed (2026-11-26)**:

- The venue has no "trending" endpoint and its tags carry no usable flag (`forceShow` was set on
  none of the first hundred). Trending has to be derived.
- An event carries `volume24hr`, `volume1wk`, `openInterest`, `competitive`, `commentCount`,
  `featured` with `featuredOrder`, `new`, and for a match `live`, `ended`, `score`, `period`,
  `elapsed`, `startTime`, `seriesSlug`. `?live=true` returns only events in play (fifty at the
  time, with scores); `?featured=true&order=featuredOrder` returns the venue's own curated list;
  `?tag_slug=<any tag>` filters by any tag, not only our categories.
- A listing with `limit` above 50 is served only compressed. The gateway's `fetch` asks for that
  by default; a client that does not gets `gzip_required`.
- Summed over the top hundred events, the heaviest tags were `sports`, `games`, `recurring`,
  `basketball`, `nba`, `tech`, `finance`, `nvidia`, `nfl`, … and `fed`, `fed-rates`, `fomc`,
  `economic-policy` each named the same three events.

**How topics are chosen**:

1. Drop the fixed categories' own tags, and a short denylist of tags that describe a market's
   mechanics rather than its subject (`recurring`, `games`, `hit-price`, `crypto-prices`, reward
   programme tags).
2. Drop events that open and close within an hour before counting anything. **Probed**: the venue
   runs five- and fifteen-minute "up or down" markets, marked by a series `recurrence` of `5m` or
   `15m` and by an end time minutes after their start time. None was among the hundred most traded
   events when probed, so this is a guard rather than a large exclusion; they are the nearest
   thing on the venue to a slot machine, and FR-002c keeps them findable by search and category
   and out of the row that says "look here". A match has a start time and an end date days later
   (or equal), so the test is "ends more than zero and at most sixty minutes after it starts".
3. Pick greedily by **marginal** day volume: take the tag carrying the most, remove its events,
   repeat. `nba` then leaves `basketball` nearly empty and four names for one Fed meeting become
   one, with no list of synonyms to maintain.
4. Stop at eight, or when a tag adds less than a floor.

**Rationale**: volume in the last day is the one signal that is both honest and hard to fake
cheaply. Two tempting alternatives fail on inspection. *Surge* (a day against the week's average)
saturated at exactly 7× for every event younger than a week, so it ranks newness, which already
has its own sort. *Biggest price moves* was led entirely by matches that had just finished and
gone to 0.999; it measures resolution, not news.

**What it produced on the day it was built** (2026-11-26, real venue data through the gateway's
own client): Basketball, Finance, NFL, Trump, Soccer, Bitcoin, Global Elections, Hockey, with
fifty or more events in play. Sensible, and broader than the venue's own chips: summing volume
favours a wide tag (`finance`, seventeen events) over a narrow hot one (`fed`, three events
carrying nearly as much). Ranking by marginal volume divided by the square root of the events
added would put NFL, Fed and Jensen Huang ahead of Finance. That is a tuning choice left open; the
selection is one pure function, so its ranking can change without the route or the client changing.

**What it is not**: a recommendation. The row ranks by what the venue's traders did, never by
fee, and FairWins' own members' activity is not an input (that would need a record of who looked
at what, which this feature does not keep).

**Alternatives**: the venue's curated `featured` list (available, and worth showing as the
default order of the unfiltered list, but it is someone else's editorial choice and changes
slowly); a fixed list of topics (stale within a week).

## Open items carried into slices

| Item | Slice | How it closes |
|---|---|---|
| Category slugs each return events | 1 | fixture + live check in the PR |
| SDK fill-and-kill with a price, both signer paths | 5 | first task; fallback named in R7 |
| Poll cadence against the gateway's read quota (60/min per caller) | 2 | one batched book route call per tick, not one per outcome |
| Whether an unreadable limit blocks or warns | 8 | owner's decision before that slice |
| The denylist and the one-hour floor for topics | 3b | confirmed by the owner; both are configuration |
