# Live game views (gateway side) — spec 115, slices 1 and 2

The fifth relay-gateway read proxy, shaped like `news/` (spec 109): `services/relay-gateway/src/sports/`,
mounted unconditionally, `SPORTS_ENABLED` default **off** (⇒ `503 sports_unconfigured`), own quotas,
module + global killswitch, a `sports` block on `/status`. Read-only: nothing is signed, nothing moves
value, no value path consults it. Contract: `specs/115-predict-live-game-views/contracts/gateway-sports-api.md`.
Measurements behind every bound: `specs/115-predict-live-game-views/research.md`.

## Sources (both public, keyless, on NO service agreement)

| id | what | how it is read |
| :-- | :-- | :-- |
| `venue` | the venue's sports feed: status, score, period, clock, side in possession | ONE upstream WebSocket for the whole gateway, opened by the first request, closed after 5 idle minutes, reconnect with capped backoff |
| `plays` | ESPN site API: scoreboard (identity, score cross-check, situation) + summary (plays) | polled **only on behalf of a request**; scoreboard cache >= 10 s, summary >= 5 s, single-flight, failures cached for the same window |

Upstream load is a function of games being viewed, never of members. There is no background poller, so a
game nobody asks about is not read; an ended game is read once more and then frozen.

## Rules that are the point

- **A number exists only where a source gave one.** Numbers go through `normalize.js#intOrNull` — `Number('')`
  is 0, and a blank is not a score. A venue score is `{home, away}` only for a league in `leagues.js` whose
  ordering was measured against ESPN; everything else is `scoreText`.
- **Each source fails alone and is named** (`sources.venue`, `sources.plays`); a failed source's data is
  omitted, never zeroed, never stale-as-live.
- **`confirmedAt` is this gateway's clock when a source last said the thing.** An open socket confirms
  nothing: the feed has no heartbeat and a quiet game is silent. Trust bounds are `sports/bounds.js#TRUST_BOUNDS`.
- **Disagreement returns the venue's score** and `agree: false`.
- **Source text is forwarded as text.** No HTML, URL, image or logo field is ever copied across.
- **Matching is exactly-one-or-`not-matched`** (`match.js`); the team-code alias table (`leagues.js`) holds
  only differences that were observed.

## Operating it

Config is documented in the header of `src/config/index.js` (`SPORTS_*`). To take ESPN out while keeping scores:
`SPORTS_PLAYS_ENABLED=false`. To take the module out: `SPORTS_KILLSWITCH=true`. Before pinning an image,
confirm `/status` carries a `sports` block — a flag with no code behind it looks enabled and does nothing.
FinOps: `espn-sports-api` and `polymarket-sports-feed` (modelled $0; see
`docs/runbooks/finops-operations.md#sports-sources-cost`).

Adding a league: verify BOTH its score ordering and its team-code differences against the ESPN scoreboard at
the same moment, add the row to `leagues.js` with the numbers in research.md, and nothing else.
