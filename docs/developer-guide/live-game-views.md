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
- **`confirmedAt` is this gateway's clock when a source last said the thing.** Trust bounds are
  `sports/bounds.js#TRUST_BOUNDS` (plays 30/120 s; venue never live, delayed to 75 s).
- **Whose figures (amended FR-008):** the play source's where read and matched (`source: "plays"`), else the venue's,
  else null. The venue was measured a median 34 s behind ESPN and never ahead, so the older figure never goes on top; the
  venue's own figures ride beside the row (`venue`) and `agree` compares scores. Figures from two moments are never mixed.
- **Venue liveness is the connection's, not the game's:** `changedAt` = the game's last frame; `confirmedAt` = the last
  frame of any kind (the ~15 s `null` heartbeat) on the open connection, only if the game's frame arrived on it. 60 s of
  total silence = dead connection, reconnect. A venue reading is never `live`.
- **A device claim never outlives its request.** The detail route's `league/home/away/start` is used only while the
  venue has not named the game; nothing is keyed by gameId from a claim (`frozen` is keyed by the play source's event
  id; `identified` is written only from venue frames).
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
