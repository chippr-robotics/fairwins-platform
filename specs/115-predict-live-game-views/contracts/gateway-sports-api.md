# Gateway contract: `/v1/sports/*`

Read-only. Origin-locked like every other proxy. Errors use the estate envelope
`{ "error": { "code", "reason" } }`: module off ⇒ every route answers `503` code `sports_unconfigured`;
module killswitch ⇒ `503` `sports_paused`; the global killswitch ⇒ `503` `killswitch_active`; a bad id
list ⇒ `400 invalid_params`; over quota ⇒ `429 quota_exceeded` + `Retry-After`. A gateway that predates
the module answers 404. The app treats all of them the same way: no game view (FR-013). Order of checks:
liveness, then parameters, then quota — a refused module never spends quota.

## The event listing gains `game`

`GET /v1/polymarket/events` and `/events/:slug` rows carry:

```jsonc
"game": null            // the event names no game — the common case
"game": {
  "gameId": 19618,                       // the venue's id; the key for everything below
  "league": "nfl",                       // lower case, as the venue spells it
  "startTime": "2026-11-26T21:30:00Z",   // or null
  "home": { "name": "Cowboys", "code": "DAL" },   // code upper case; either field may be null
  "away": { "name": "Eagles",  "code": "PHI" }
}
```

Home/away is stated only when the venue states it. If the listing gives two teams and does not say
which is at home, `home`/`away` are replaced by `"teams": [ … , … ]` in the venue's order and no
surface says "home" or "away".


`game` also carries what the listing itself said about the game, for the moment before the game
route has an answer:

```jsonc
"listed": { "status": "in-progress", "scoreText": "10-28", "period": "Q3", "clock": "10:39" }
// each field null when the listing did not give it; `listed` is null when it gave none of them
```

It is the venue's own text, unparsed, and it is as old as the listing (the listing's own
`confirmedAt`). The app may show it only as a venue reading (never live), and only until the game
route answers with a `source`.

## `GET /v1/sports/games?ids=19618,19620` (1–10 ids)

```jsonc
{
  "serverNow": 1795737600000,
  "sources": {
    "venue": { "state": "read", "label": "Polymarket" },   // or "unreadable" + "reason"
    "plays": { "state": "read", "label": "ESPN" }           // or "unreadable" + "reason" | "off" | "not-needed"
  },
  "games": [
    {
      "gameId": 19618,
      "league": "nfl",
      "source": "plays",                // whose figures the next six fields are: "plays" | "venue" | null
      "status": "in-progress",          // "scheduled" | "in-progress" | "ended" | null (not known)
      "score": { "home": 28, "away": 10 },   // null when not known; never 0 for "not known"
      "scoreText": null,                // the source's own string, ONLY when `score` is null and it sent one
      "period": "Q3",
      "clock": "10:39",
      "possession": "home",             // "home" | "away" | null
      "confirmedAt": 1795737597000,     // server ms when `source` last confirmed this; null ⇒ unknown
      "changedAt": null,                // venue source only: when the venue last sent a frame for this game
      "agree": true,                    // true | false | null (only one source spoke)
      "venue": null                     // see below
    }
  ]
}
```

**Whose figures.** Measured (research R1): the venue's feed sends a frame for a game only when
something changed, on whole-minute ticks, and ran a median 34 s and up to 203 s behind the play
source, never ahead. So:

- A game the play source read and matched: `source: "plays"`. Status (including `ended`), score,
  period, clock and possession are the play source's. `confirmedAt` is the gateway's clock at its
  last successful read.
- Otherwise, a game the venue has spoken about: `source: "venue"`. `changedAt` is the gateway's
  clock when the venue last sent a frame for THAT game. `confirmedAt` is the last moment the venue's
  connection proved itself alive (it sends a heartbeat every 15 s; any frame counts) — but only if
  the game's frame arrived on the connection that is open now; after a reconnect the feed re-sends
  nothing, so `confirmedAt` falls back to `changedAt` until the game's next frame.
- Otherwise `source: null` and every figure is `null`. The row is not dropped and it is not an error.

**`venue`** is non-null only when `source` is `"plays"` and the venue has spoken about the game:
`{ "status", "score", "scoreText", "period", "clock", "changedAt" }` — what the venue's feed last
said. With `agree: false` the page says, in words, that the venue's feed shows something else.

**Trust bounds** (ONE constant, `services/relay-gateway/src/sports/bounds.js#TRUST_BOUNDS`, mirrored by
the frontend; ages on the server clock against `confirmedAt`):

| source | live while age ≤ | delayed while age ≤ | beyond |
| :-- | :-- | :-- | :-- |
| `plays` | 30 s | 120 s | last known |
| `venue` | never | 75 s | last known |

A venue reading is NEVER live: a healthy connection confirms only that the venue has said nothing
new, and the venue itself was measured minutes behind the game.

- `sources.plays.state`: `read` — every league needed by the requested games was read; `unreadable` +
  `reason` (`upstream_unreachable` | `upstream_error`) — a needed read failed, and every figure that
  source would have supplied is omitted (the row falls back to the venue); `off` —
  `SPORTS_PLAYS_ENABLED=false`; `not-needed` — no requested game has a covered league.
- `score` is `{home, away}` only where the gateway knows which number is whose: from the play source,
  or from the venue for a league whose ordering has been verified against a play source (today:
  `nfl`, **away-home**: `PHI @ DAL` reads `10-28`). Otherwise the venue's string is `scoreText` and
  `score` is `null`. No surface parses `scoreText`.
- Venue `possession` comes from the venue's `turn` code and is `null` unless it equals one of the two
  team codes the frame names.
- Ended is the GAME's state. Nothing here says anything about a market's resolution.

## `GET /v1/sports/games/:gameId` (slice 2)

Optional query: `league`, `home`, `away` (team codes), `start` (ISO time) — the game's identity
from the event listing, so the play source can be matched before the venue's feed has spoken about
the game (it sends nothing on connect). They are validated (`league` in the gateway's table, codes
`^[A-Z0-9]{2,5}$`, a parseable time), used ONLY while the venue has not named the game itself, and
never stored against the `gameId`: the venue's own frame, once it arrives, is the identity. A match
needs exactly one play-source game for those two teams, within 30 minutes of `start` when given.
Anything the gateway remembers about a matched game is keyed by the play source's own event id.

The same envelope (`serverNow`, `sources`) with one element in `games`: the row above, plus:

```jsonc
"detail": {
  "state": "read",                  // "read" | "unreadable" | "not-covered" | "not-matched" | "off"
  "confirmedAt": 1795737596000,
  "situation": {                    // null between plays / when not reported
    "possession": "home",
    "yardLine": 37,                 // 0–100 measured from the HOME goal line; null if unknown
    "yardLineText": "DAL 37",
    "down": 4, "distance": 18,
    "downDistanceText": "4th & 18 at DAL 37",
    "lineToGain": 55,               // same axis as yardLine; null when not derivable
    "redZone": false
  },
  "plays": [                        // newest first, at most 12
    { "id": "…", "period": "Q3", "clock": "10:44", "text": "…", "scoring": false, "side": "home" }
  ]
}
```

`not-covered` = the league has no play source. `not-matched` = the gateway could not identify
exactly one game at the play source for this venue game (`reason`: `no_candidate`, `ambiguous`,
`no_team_codes`, or `no_identity` when neither the venue nor the request named the game). Both are final for
the request and neither is a failure; `unreadable` (+ `reason`) is a failure and names itself — the
situation and the plays are then omitted, and the row falls back to the venue. `situation.yardLine` is
derived from the source's own text ("PHI 25" is the 25 of PHI) and cross-checked against its numeric
field; if the two disagree, or the team is not one of the two, it is `null`. `lineToGain` is `null`
when it would lie beyond a goal line (goal-to-go). An ended game is read once more and then served from
memory — no further upstream call is made for it (FR-016).

Text fields are the source's text, returned as text. The gateway forwards no HTML, image or URL
from a source.

## Fight routes (slice 3, `SPORTS_FIGHT_ENABLED`, default off)

Specified in `fight-api.md` when slice 3 starts; off ⇒ `503 sports_fight_unconfigured`, with no
effect on the routes above.
