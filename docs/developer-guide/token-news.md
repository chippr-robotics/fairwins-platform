# Token News (spec 109)

Token news is the platform's fourth read-proxy (after Collect, Predict, and Perps): recent
headlines for one asset, rendered on the portfolio's asset sheet and under the Trade pair, and
offered to the assistant as exactly one tool-pull tool. It is ADVISORY-ONLY — no value path gates
on it, and no news state may disable, delay, or alter a form.

## Architecture

```
frontend                          relay-gateway                    vendor
─────────                         ─────────────                    ──────
newsAssets.js  (chainId,address)  src/news/routes.js               Alphaday
  → slug | null                     GET /v1/news/:chainId/:asset     /items/news/?tags=<slug>
lib/news/newsClient.js  ──HTTP──▶   killswitch → enabled →           (keyless, no CORS,
TokenNewsCard (both mounts)         validate → quota → cache          no contract identity)
```

- **The gateway proxy is mandatory, not an optimization**: the vendor serves no CORS headers, so
  a browser can never call it directly (research R1). The module is `NEWS_ENABLED` (default off);
  off, the route answers `503 news_unconfigured` and every frontend surface renders nothing.
- **The vendor has no contract identity anywhere** — its tags and coins are slug + ticker only.
  The `(chainId, address) → slug` mapping is therefore OURS, and it is the load-bearing curation
  point (below).

## The mapping table: `frontend/src/config/newsAssets.js`

One curated table beside the asset registry (the spec-108 offered-beside-resolvable precedent).
Rules:

1. **Every row is probe-verified before it is written.** A wrong slug fails closed to `[]`
   upstream — verified live — which renders as honest-empty, i.e. it silently costs the member a
   feed. Record the verification date in the row's comment. The probes that seeded the table are
   in `specs/109-token-news/research.md` (R3), including the non-obvious ones: POL is
   `matic-network` (`polygon`, `matic`, and `pol` all return zero items), USDC is `usd-coin`
   (`usdc` is empty), WBTC is `wrapped-bitcoin`.
2. **A missing row IS "not covered"** — resolved client-side with no network call, rendered as
   the honest absence sentence. Never add a ticker heuristic or a fallback; a guessed slug that
   happens to exist would show a member news about a different asset.
3. Wrapped natives resolve through the registry's `baselineSymbol` (WETC → ETC →
   `ethereum-classic`), so a wrapper never needs its own row.
4. Bitcoin string network ids (spec 061) resolve directly; they never touch EVM-shaped paths.

## The `FeedReading`

Three states plus a distinct honest-empty, and nothing else:

| State | Meaning | Render |
|---|---|---|
| `read` + items | headlines arrived | title/source/age/link-out, text only |
| `read` + `[]` | vendor answered, sparse coverage | "No recent items for X." — content, not failure |
| `not-covered` | no mapping row | "No news source covers X." — no retry, no request |
| `unreadable` | gateway/vendor did not answer | sentence + Retry — never an empty feed |
| `not-configured` | module off, no gateway, or an image without the route (404) | NOTHING renders |

## Layout: the feed is ranked, not listed

The first pass rendered every item as an equally-weighted underlined link. On a real ETC feed that
put a one-hour report and a three-month price-prediction piece at identical visual weight, made the
card a wall of teal, and gave the reader nothing but the age string to tell them apart — on a sheet
whose actual job is Trade and Transfer. The ranking now lives in size, weight and spacing:

- **One featured item** — the NEWEST by published date, larger and unadorned, with source and age on
  one quiet line. Ordering is ours and comes from the dates alone: there is no ranking signal here
  that the vendor did not give us, and none we invented.
- **Compact rows** beneath it — two-line clamp, hairline dividers, `--text-primary` titles that take
  their underline on hover and focus. The link affordance is structural (each row's whole content is
  the link), so nothing here is small text in a brand hue and spec 090's rule (1) never applies.
- **Recency headings** (Today / This week / Earlier) emitted only where the bucket CHANGES, seeded by
  the featured item's bucket — so a feed that all landed today renders no headings at all, and one
  that spans months visibly ends instead of running on.
- **First paint is capped** at the featured item plus three; the tail sits behind ONE disclosure whose
  collapsed rows are **unmounted, not hidden** (a control claiming `aria-expanded="false"` over rows
  still in the tab order is claiming something untrue — the spec-081 drawer lesson). Its label reports
  what is actually in the tail: `Earlier · N` only when every hidden item really is older than a week,
  otherwise `Show N older`.

All of it is presentation over the same reading. Nothing is dropped, no item is summarized or
re-titled, and every row still carries its source and its age — including inside the disclosure.
Ages and buckets are both measured from the instant the feed landed, so the card reads one clock.

Items are **text only**: the normalizer (`services/relay-gateway/src/news/normalize.js`) forwards
`id/title/url/source{name,slug}/publishedAt/sentiment` and drops `image`, `icon`, vendor-account
fields, and the raw `sentiment_score`; non-`https:` URLs and undated items are dropped whole (the
mandatory age display cannot be honest without a date). Ages are always shown.

## Cache discipline

The vendor itself serves `cache-control: max-age=300`, so `NEWS_CACHE_TTL_MS` is **clamped to
≥ 300 000** — a lower value buys load, not freshness (one boot log line on clamp, never a silent
lie). The cache is single-flight per slug (N concurrent viewers of one asset = 1 upstream
request, SC-005), serves stale marked `stale: true` up to 10× TTL, and beyond that answers
`unreadable` — never stale-as-live.

## The assistant tool

Exactly one public tool, `get_token_news` (`@fairwins/assistant-contract`, MCP snapshot
re-vendored and parity-gated). **Tool-pull only**: news is never in a prompt and never pre-loaded
— the spec-104 injection posture, because headline text is counterparty-authored content. The
description carries the honest wording the model reads: third-party reported with attribution,
never advice; unreadable stated, never summarized from memory; empty means sparse coverage. The
in-app loop resolves `slug` from the mapping before the call; MCP/external callers pass it
explicitly. No `navigate`, no `build_intent` — a news result never makes the app do anything.

## What deliberately does not exist

- **No datastore, no graph layer, no member-keyed interest record** — the parked
  retrieval/graph-context layer is issue #1513 (see
  `docs/research/alphaday-news-agent-context-evaluation.md`); do not reintroduce it here.
- **No key, no credential** — the vendor API is keyless (nothing for spec 097 to hold).
- **No FeeRouter service, no payee** — news carries no fee; FinOps entry `alphaday-news-api`
  (`modelled`, $0 free tier) exists so the dependency is visible, not because money moves.

## Operations

Two switches, and **both** must be on for a member to see anything: the `news` tenant feature
(on for `fairwins`) and `NEWS_ENABLED` on the gateway (set `true` in
`infra/vm/gateway/docker-compose.yml`). Either one off is honest absence — the surface renders
nothing rather than an error. Quotas ride the standard gateway knobs (`NEWS_QUOTA_PER_IP` /
`NEWS_QUOTA_GLOBAL` / `NEWS_QUOTA_WINDOW_MS`), and `NEWS_KILLSWITCH=true` answers
`503 news_killed` ahead of everything else.

### The flag is not the whole enablement

**A gateway image that predates spec 109 has no `/v1/news/*` route at all**, so `NEWS_ENABLED`
does nothing there — the same trap the `PERPS_ENABLED` note in that compose file records. The
enablement is therefore two steps, in this order:

1. Build and publish a relay-gateway image from a commit containing `services/relay-gateway/src/news/`,
   and pin that tag in `infra/vm/gateway/docker-compose.yml`. **Verify before pinning**: the
   image's `/status` must carry a `news` block. (The gateway image is an operator build — CI only
   builds and boots it as a check, and `cloudbuild.yaml` builds the SPA, not this image.)
2. Deploy the stack (`systemctl restart fairwins-stack@gateway` — never a single container; the
   sidecars share the gateway's network namespace).

The SPA and the gateway deploy independently, so the frontend card can be live while the module
is not. That window is deliberately silent: `newsClient.js` reads a **404 as `not-configured`**,
because the module mounts unconditionally and so an image carrying it answers `503` when switched
off and never `404`s. Without that branch every asset sheet and trade pair would show "The news
feed could not be read right now." plus a Retry, for a surface that simply has not shipped yet.

See `specs/109-token-news/` (research.md carries the probe evidence) and
`contracts/gateway-news-api.md` for the route contract.
