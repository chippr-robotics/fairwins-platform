# Data Model: Token news (spec 109)

Three shapes, none persisted. Everything below lives in memory (gateway cache) or in transit; the
only committed data is the curated mapping table, which is configuration, not member data.

## NewsItem

The normalized unit both surfaces and the assistant tool render. Produced by
`services/relay-gateway/src/news/normalize.js` from the vendor item; every field's provenance is
documented at the normalization site (spec-082 rule).

| Field | Type | Source | Rules |
|---|---|---|---|
| `id` | string | vendor `id` | opaque; used only for React keys / dedupe within a response |
| `title` | string | vendor `title` | plain text; rendered as text only, never markup (FR-005) |
| `url` | string | vendor `url` | the ONLY interaction — external link-out with attribution; must be `https:` or the item is dropped |
| `source` | `{ name, slug }` | vendor `source` | attribution line; `icon` deliberately not forwarded (third-party image origin — text-only rule) |
| `publishedAt` | ISO-8601 string | vendor `published_at` | drives the mandatory age display; missing/unparsable ⇒ item dropped (an undated item cannot be honestly aged) |
| `sentiment` | `-1 \| 0 \| 1 \| null` | vendor `sentiment` | forwarded as data; MVP UI does not render it (platform-authored interpretation is out of scope), tool result may state it as the vendor's label |

Dropped vendor fields: `image` (third-party image origin), `author` (frequently `"None"`),
`hash`, `is_bookmarked`, `is_liked`, `likes` (vendor-account concepts we do not have),
`sentiment_score` (a precision the UI must not imply).

## AssetNewsMapping

The curated correspondence `(assetKey) → { slug }` in `frontend/src/config/newsAssets.js`.

- **Key**: `chainId` (EVM numeric) + lowercase `tokenAddress`, with `native` for the chain's base
  coin; Bitcoin uses its spec-061 string network id directly and never enters EVM seams.
- **Value**: `{ slug }` — the Alphaday tag slug, verified by a live read at curation time (the
  spec-021-amendment discipline: a wrong row costs a member the surface silently, so every row is
  probe-verified before it is written).
- **Resolution**: `newsSlugFor(assetKey) → slug | null`. `null` IS the "not covered" outcome
  (FR-004) — there is no fallback, no ticker heuristic, no vendor search. The resolver lives
  beside the table so offered and resolvable cannot drift (spec-108 precedent).
- **Validation rules**: slug shape `^[a-z0-9-]+$`; table is cohort-agnostic (a testnet build maps
  its testnet tokens to the mainnet asset's slug only where the card carries the honest
  cross-cohort notice — see quickstart scenario 6).

## FeedReading

The one shape every consumer sees (spec-089 `reading.js` device: a value exists only in `read`).

```
read           → { state: 'read', items: NewsItem[], fetchedAt }   // items MAY be empty:
                                                                    // "no recent items" is content
unreadable     → { state: 'unreadable', reason }                    // fetch failed / stale beyond
                                                                    // STALE_FACTOR; renders
                                                                    // sentence + retry
not-configured → { state: 'not-configured' }                        // NEWS_ENABLED off / feature
                                                                    // off ⇒ surface absent
```

- Only the `read` constructor carries items, so "empty because the fetch failed" has no code path.
- `read` with `items: []` renders the honest empty state ("No recent items for <asset>"), which is
  visually and verbally distinct from `unreadable` (FR-003, acceptance scenario 1.3).
- The gateway returns this shape on `/v1/news/...`; `frontend/src/lib/news/newsClient.js` passes
  it through without invention; the assistant tool result states the same three outcomes in words.

## State transitions

None persisted. The cache entry lifecycle (fresh → stale-served → gone at 10× TTL) is internal to
`client.js` and surfaces only as `read` (with honest `fetchedAt`) or `unreadable`.

## What deliberately does not exist

- No member-keyed record of views or queries (FR-009) — the gateway logs no asset-per-caller
  association beyond existing quota accounting.
- No stored news, no embeddings, no graph (parked: #1504 lineage / #1513).
- No subgraph entity, no deployment record, no contract.
