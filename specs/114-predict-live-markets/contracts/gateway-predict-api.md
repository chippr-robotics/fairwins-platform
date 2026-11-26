# Contract: gateway Predict read routes (spec 114)

Additions to the spec-057 module (`services/relay-gateway/src/polymarket/`). Same pipeline as its
existing reads: killswitch → configured → Polygon only (404 `unsupported_chain`) → validation →
per-caller read quota → single-flight TTL cache with serve-stale-on-error.

Every success body ends with the same envelope:

```json
{ "confirmedAt": "2026-11-26T02:10:00.000Z", "serverNow": "2026-11-26T02:10:01.200Z", "stale": false }
```

`confirmedAt` is when the gateway fetched the cached copy from the venue. `serverNow` is the
gateway's clock at response time. `stale: true` means the venue could not be reached and the copy
is older than its TTL; the client then classifies by age as usual and can never reach `live`.

Errors use the module's existing shape: `{ "error": { "code", "reason" } }`.

## GET `/v1/polymarket/:chainId/events`

| Query | Values | Default |
|---|---|---|
| `category` | a bounded id from `categories.js` | all |
| `sort` | `volume24h` \| `newest` \| `closing` | `volume24h` |
| `q` | text ≤ 128 chars; when present the venue's search is used and `category`/`sort` are ignored | — |
| `next` | cursor returned by the previous page (digits only) | — |

```json
{
  "events": [{
    "slug": "fed-decision-in-december",
    "title": "Fed Decision in December?",
    "category": "economy",
    "volume": "61605847.12", "volume24h": "1820443.90",
    "endDate": "2026-12-10T04:59:00Z",
    "mutuallyExclusive": true,
    "marketCount": 5,
    "markets": [{
      "conditionId": "0x…", "label": "25 bps increase", "tradable": true,
      "outcomes": [{ "name": "Yes", "tokenId": "1116…", "price": "0.935" }, { "name": "No", "tokenId": "9448…", "price": "0.065" }],
      "bestBid": "0.93", "bestAsk": "0.94", "lastTradePrice": "0.93", "displayPrice": "0.935",
      "tickSize": "0.01", "minOrderSize": "5"
    }]
  }],
  "next": "20",
  "confirmedAt": "…", "serverNow": "…", "stale": false
}
```

- `markets` holds at most four rows, most likely first. Closed events are not listed.
- A number the venue did not give is `null`, never `"0"`.
- `sort=closing` lists only events whose closing time is still ahead.
- TTL: `POLYMARKET_CACHE_TTL_MS` (15 s). Errors: 400 `invalid_category` / `invalid_sort` /
  `invalid_cursor` / `invalid_query`, 429 `quota_exceeded`, 503 `upstream_unavailable`. A `q`
  longer than 128 characters is truncated, as on the existing markets route.

Two further filters, each exclusive with `category` and ignored when `q` is present:

| Query | Values | Effect |
|---|---|---|
| `topic` | a venue tag slug, `^[a-z0-9-]{1,64}$` (400 `invalid_topic`) | events carrying that tag |
| `live` | `1` | events in play only; `sort` is ignored and the order is trading in the last day |

An event in play carries `"live": { "score": "91-101", "period": "Q4", "elapsed": "06:47" }`
(each a string or null, as the venue gives them); every other event carries `"live": null`.

## GET `/v1/polymarket/:chainId/discover`

What is active at the venue now, for the quick filters under search. No parameters.

```json
{
  "live": { "count": 14, "events": [ /* up to 6 EventSummary, most traded first */ ] },
  "topics": [
    { "slug": "nba", "label": "NBA", "events": 9, "volume24h": "10200000.00" },
    { "slug": "nvidia", "label": "Nvidia", "events": 13, "volume24h": "9200000.00" }
  ],
  "confirmedAt": "…", "serverNow": "…", "stale": false
}
```

- `topics` holds at most eight, chosen by marginal trading over the last day so that no two name
  the same events (research R16). `events` and `volume24h` are what the topic **added**, not its
  total. `label` is the venue's text, capped at 40 characters.
- Excluded before counting: the fixed categories' own tags, the mechanics denylist, and events
  that open and close within an hour.
- `live.count` is the number of events in play that the venue returned in one page of fifty.
  When that page was full the object also carries `"more": true`, and the count is shown as
  "50+", never as an exact figure.
- Either half may be unreadable on its own: `"live": null` or `"topics": null`, never an empty
  list standing in for a failure. Both unreadable is 503.
- TTL 60 s.

## GET `/v1/polymarket/:chainId/events/:slug`

The same event with **all** markets, plus `description` (text, ≤ 4,000 chars),
`resolutionSource` (string or null) and `status` (`open` | `closed` | `resolved`); a resolved
market row carries `winner`. 404 `not_found` when the venue does not know the slug. TTL 15 s.
`slug` must match `^[a-z0-9-]{1,160}$` (400 `invalid_event`).

## GET `/v1/polymarket/:chainId/books?token_ids=a,b,c`

One to ten token ids (400 `invalid_token` for a malformed id, `too_many_tokens` beyond ten).

```json
{
  "books": [{
    "tokenId": "1116…",
    "bids": [["0.93", "284698.76"], ["0.92", "5120.00"]],
    "asks": [["0.94", "220072.89"]],
    "tickSize": "0.01", "minOrderSize": "5", "lastTradePrice": "0.93",
    "venueTime": "2026-11-26T02:09:58.114Z", "venueHash": "467331634a…"
  }],
  "unreadable": ["9448…"],
  "confirmedAt": "…", "serverNow": "…", "stale": false
}
```

- Levels are best-first, at most 25 a side, prices and sizes as the venue's strings.
- A token whose book could not be read is listed in `unreadable` and absent from `books`: one
  failure never blanks the others and is never rendered as an empty book. A book with no bids
  or no asks is a real state and is returned as such.
- If **no** requested book could be read the answer is 503 `upstream_unavailable`: nothing was
  confirmed, so there is no `confirmedAt` to state. Duplicate ids are served once.
- Cached per token for `POLYMARKET_BOOK_TTL_MS` (default 2,000, floor 1,000); a request for
  several tokens is served from per-token entries, so ten members watching one outcome cost the
  venue one request per two seconds.

## GET `/v1/polymarket/:chainId/prices-history?token_id=…&range=1d`

`range`: `1h` | `1d` | `1w` | `1m` | `max` (400 `invalid_range`).

```json
{ "tokenId": "1116…", "range": "1d", "points": [{ "t": 1795572611, "p": "0.935" }],
  "confirmedAt": "…", "serverNow": "…", "stale": false }
```

TTL 60 s. `points` may be empty for a new market; that is `[]`, not an error.

## Unchanged

`/markets`, `/markets/:conditionId`, `/fee-rate`, `/positions`, `/builder-sign`. No route in this
contract accepts, forwards or signs an order.
