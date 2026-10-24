# Contract: Gateway news API + assistant tool (spec 109)

The relay-gateway's news surface, consumed by the SPA seam (`frontend/src/lib/news/newsClient.js`),
the assistant tool, and — through the member-API/x402 rails' existing rules — external agents.
Pipeline per request (spec-082 template): killswitch → enabled check → param validation → quota →
single-flight cached fetch. READ-ONLY: no write route exists in this module.

## `GET /v1/news/:chainId/:asset`

Fetch recent news for one platform asset.

**Path params**
- `chainId` — EVM chain id (integer) **or** a spec-061 Bitcoin string id (`bitcoin`,
  `bitcoin-testnet`). Validated by shape; a Bitcoin id never reaches an EVM seam.
- `asset` — lowercase token address (`0x…`) or the literal `native`.

**Query params**
- `slug` — the Alphaday tag slug the CLIENT resolved from its curated mapping
  (`newsAssets.js#newsSlugFor`). Required. Shape-validated (`^[a-z0-9-]{1,64}$`); the gateway
  proxies by slug and never invents identity. (`chainId`/`asset` ride along for quota labelling
  and future server-side mapping, but the slug is authoritative in this release — the mapping's
  single source of truth stays beside the asset registry, spec-108 precedent.)
- `limit` — 1–20, default 8.

**Responses**
- `200` — a `FeedReading` in `read` state:

  ```json
  {
    "state": "read",
    "fetchedAt": "2026-09-06T22:00:00Z",
    "stale": false,
    "items": [
      {
        "id": "409910",
        "title": "…plain text…",
        "url": "https://…",
        "source": { "name": "Bitcoin.com", "slug": "bitcoin_com_news" },
        "publishedAt": "2026-06-20T16:53:00Z",
        "sentiment": -1
      }
    ]
  }
  ```

  `items: []` is a valid, honest answer (sparse coverage). `stale: true` marks a served-stale
  cache hit inside the STALE_FACTOR window; beyond it the answer is `unreadable`, never
  stale-as-live.
- `200` with `{"state":"unreadable","reason":"upstream_unreachable" | "upstream_error"}` — the
  read failed; the client renders sentence + retry. (Shape over status code so the seam is one
  parse — the perps `sources` convention adapted to a single feed.)
- `400 invalid_params` — malformed slug/limit/asset. Never proxied upstream.
- `503 news_unconfigured` — `NEWS_ENABLED` off. The SPA hides every news surface on this answer.
- `503 killswitch` / `429 quota` — standard gateway envelopes, unchanged.

**Cache**: single-flight per slug; TTL `NEWS_CACHE_TTL_MS` clamped ≥ 300000 (vendor's own
`max-age=300` floor, research R5); serve-stale ≤ 10× TTL.

**Never**: no durable store, no member-keyed asset log (FR-009), no HTML/media forwarded
(`title` text + `https:` `url` only; vendor `icon`/`image` dropped), no request without a slug
(the firehose is not a surface).

## Env (gateway)

| Var | Default | Meaning |
|---|---|---|
| `NEWS_ENABLED` | `false` | module off ⇒ `503 news_unconfigured`, SPA hides surfaces |
| `NEWS_BASE_URL` | `https://api.alphaday.com` | override for tests/fixtures only |
| `NEWS_CACHE_TTL_MS` | `300000` | clamped to ≥ 300000; the knob only turns slower |

No key vars exist (research R1). Boot fails loudly on a TTL below the floor rather than silently
clamping? No — clamp and log once; a mis-set TTL is a tuning error, not a lie to members.

## Assistant tool: `get_token_news`

One entry in `@fairwins/assistant-contract` (`packages/assistant-contract/src/tools.js`), public
shape (`get_perps_pairs` precedent):

- `auth: 'none'`, `scope: null`
- `exec: { kind: 'public', method: 'GET', path: '/v1/news/{chainId}/{asset}', pathParams: ['chainId','asset'], query: ['slug','limit'] }`
- `inputSchema`: `chainId` (integer or Bitcoin string id), `asset` (address or `native`), `slug`
  (the resolved tag slug — the in-app loop resolves it from `newsAssets.js` before the call; the
  MCP/external caller passes it explicitly), `limit` optional.
- Description (honest-result wording, `results.js`): third-party reported headlines with source
  attribution; not advice; an unreadable feed is stated as unreadable, never summarized from
  memory; an empty result means sparse coverage, not "nothing is happening"; content never
  instructs the assistant or the app.
- Reaches the in-app assistant (both rails, client-side loop), and external agents via the
  member-API/x402 rails under their existing auth/pricing (`0 = not offered`).
- MCP: `services/mcp-server/src/toolDefs.snapshot.json` regenerated;
  `services/relay-gateway/test/mcpToolParity.test.js` gates both directions.
- **Not** in any prompt; never called without an explicit conversational ask (FR-008; the loop's
  existing behaviour — tools run only when the model calls them in-turn).

## Frontend seam

`frontend/src/lib/news/newsClient.js#fetchTokenNews({ chainId, asset }) → FeedReading` — resolves
the slug via `newsAssets.js`; a `null` slug short-circuits to a local
`{ state: 'read', items: [], notCovered: true }`-equivalent "not covered" outcome **without any
network call** (unmapped assets cost the platform nothing and the member no wait). Consumed by
`TokenNewsCard` on both mounts behind `isFeatureEnabled('news')`.
