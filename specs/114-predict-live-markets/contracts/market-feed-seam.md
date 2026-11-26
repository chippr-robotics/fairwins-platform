# Contract: the market-data seam (spec 114)

One client module, two sources. Callers never know which is active.

## Client: `frontend/src/lib/markets/feed.js`

```js
const unsubscribe = subscribe(keys, onReadings)
// keys:        string[]  '<venue>:<instrument>', e.g. 'polymarket:1116…'
// onReadings:  (Map<key, PriceReading>) => void   — called with whatever changed
```

- At most **one** network conversation for market data exists however many components subscribe
  (FR-031). Subscriptions are reference-counted; a key nobody holds stops being requested.
- Every value delivered is a `PriceReading` ([data-model.md](../data-model.md)). The seam, not
  the caller, classifies it.
- Readings are re-classified on a one-second tick so that a value ages from live to delayed to
  last-known on screen with no new message arriving (FR-011).
- When the active source fails, the seam switches to the other and the readings it delivers say
  what they are; it never throws into a component.
- Keys are venue-neutral on purpose (FR-030). This module imports nothing from `predict/`.

### Source A — proxy poll (slice 2; always available)

Polls `GET /v1/polymarket/:chainId/books` for the subscribed Polymarket keys, batched ten to a
request, every 2 s while the document is visible and not at all while it is hidden. On an error
it keeps the last readings (which then age) and backs off to 10 s.

### Source B — stream (slice 7; only when the gateway offers it)

`EventSource` on the route below. A new key set reconnects, debounced by 250 ms.

## Gateway: `services/relay-gateway/src/markets/`

### GET `/v1/markets/capabilities`

```json
{ "stream": false, "limits": false }
```

`stream` is true only when the feed's address is configured **and** the gateway currently holds a
healthy upstream connection. Not cached by the client for more than 60 s.

### GET `/v1/markets/stream?keys=polymarket:1116…,polymarket:9448…`

`text/event-stream`. Up to 64 keys (400 `too_many_keys`). 503 `feed_unconfigured` when no feed is
configured; the client then stays on source A. Killswitch and per-caller quota apply to opening a
stream.

```text
event: quote
id: 8841
data: {"key":"polymarket:1116…","state":"live","bestBid":"0.93","bestAsk":"0.94",
       "displayPrice":"0.935","bids":[["0.93","284698.76"]],"asks":[["0.94","220072.89"]],
       "confirmedAt":"2026-11-26T02:10:00.000Z","sequence":51234,"serverNow":"2026-11-26T02:10:00.180Z"}

event: order
data: {"orderId":"0x…","state":"matched","filledSize":"53.2","settledSize":"0","at":"…"}

event: ping
data: {"serverNow":"…"}
```

- `quote` carries the whole current value for its key, never a delta. A client that misses one
  is behind, not wrong.
- `sequence` increases by one per key. A gap means a missed quote: the client holds the key at
  delayed until the next arrives.
- `state` is the feed's own judgement of the value; the client still classifies by age and takes
  the **less** trusting of the two.
- `ping` every 10 s. Thirty seconds without any event and the client treats the stream as down.
- `order` events are sent only for order ids the client named in a `orders=` query parameter;
  an order id is a capability the member already holds, and nothing else about an account is
  streamed.
- A slow client is sent the latest value per key when it can take one. Nothing is queued for it.

The gateway holds one upstream connection to the feed and fans out. It keeps no member state: a
connection's key set lives and dies with the connection. The feed's address is one environment
variable; with it unset this route answers 503 and no upstream connection is attempted.

## What the seam never does

It does not sign, post or cancel an order, and it carries no credential. Eligibility checks that
depend on the member's location are not routed through it (FR-032).
