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

## `GET /v1/sports/games?ids=19618,19620` (1–10 ids)

```jsonc
{
  "serverNow": 1795737600000,
  "sources": {
    "venue": { "state": "read" },                         // or "unreadable" + "reason"
    "plays": { "state": "read" }                          // or "unreadable" + "reason" | "off" | "not-needed"
  },
  "games": [
    {
      "gameId": 19618,
      "league": "nfl",
      "status": "in-progress",          // "scheduled" | "in-progress" | "ended" | null (not known)
      "score": { "home": 28, "away": 10 },   // null when not known; never 0 for "not known"
      "scoreText": null,                // the venue's own string, ONLY when `score` is null and it sent one
      "period": "Q3",                   // the venue's own label, or null
      "clock": "10:39",                 // or null
      "possession": "home",             // "home" | "away" | null
      "confirmedAt": 1795737597000,     // server ms of the newest confirmation; null ⇒ unknown
      "confirmedBy": "venue",           // "venue" | "plays" | "both"
      "agree": true                     // true | false | null (only one source spoke)
    }
  ]
}
```

- A requested id the gateway has nothing for is returned with every field `null` — it is not
  dropped, and it is not an error. The gateway learns a game's identity (league, team codes) ONLY from
  the venue's own frames for it, and the venue feed pushes nothing on connect (research R1): a game the
  feed has not yet spoken about since the gateway's socket opened is this all-null row, with
  `sources.venue` saying `read` (socket open, game silent) or `unreadable` (`connecting`/`reconnecting`/
  `not_connected`). The app asks again; it is not an error and the row never carries a made-up figure.
- `sources.plays.state`: `read` — every league needed by the requested games was read; `unreadable` +
  `reason` (`upstream_unreachable` | `upstream_error`) — a needed read failed, and every figure that
  source would have supplied is omitted; `off` — `SPORTS_PLAYS_ENABLED=false`; `not-needed` — no
  requested game has a covered league (or none has been identified yet), so nothing was read.
- `score` is `{home, away}` ONLY for a league whose venue ordering has been verified against the play
  source (today: `nfl`, where the venue's string is **away-home**: `PHI @ DAL` reads `10-28`). For any
  other league the venue's string is returned as `scoreText` and `score` is `null` — which number is
  whose is never inferred.
- `possession` comes from the venue's `turn` code and is `null` unless it equals one of the two team
  codes the frame names.
- `confirmedAt`/`confirmedBy`: the venue's `confirmedAt` is the gateway's clock when it last received a
  frame for THAT game (an open socket confirms nothing). When the plays source read the same score, the
  newer of the two counts and `confirmedBy` is `both`; on disagreement or one voice it is the venue's
  own time. A row carries the venue's fields whenever the venue has spoken; the plays source supplies a
  row only for a game the venue has not spoken about.
- Trust bounds (ONE constant, `services/relay-gateway/src/sports/bounds.js#TRUST_BOUNDS`, mirrored by the
  frontend; ages on the server clock against `confirmedAt`): `live` while age <= `liveMs`, `delayed`
  while <= `delayedMs`, `last-known` beyond. See research.md R1 for where the numbers come from.
- `score` for a sport whose venue score is not two integers (sets, maps) is `null` and
  `scoreText` carries the venue's own string. No surface parses `scoreText`.
- `agree: false` ⇒ `score` is the venue's (FR-008).
- Ended is the GAME's state. Nothing here says anything about a market's resolution.

## `GET /v1/sports/games/:gameId` (slice 2)

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
  ],
  "behindVenue": false              // true when this source's score differs from the venue's
}
```

`not-covered` = the league has no play source. `not-matched` = the gateway could not identify
exactly one game at the play source for this venue game (`reason`: `no_candidate`, `ambiguous`,
`no_team_codes`, or `no_identity` when the venue has not yet spoken about the game). Both are final for
the request and neither is a failure; `unreadable` (+ `reason`) is a failure and names itself — the
situation, the plays and `behindVenue` are then omitted, the row is unaffected. `situation.yardLine` is
derived from the source's own text ("PHI 25" is the 25 of PHI) and cross-checked against its numeric
field; if the two disagree, or the team is not one of the two, it is `null`. `lineToGain` is `null`
when it would lie beyond a goal line (goal-to-go). An ended game is read once more and then served from
memory — no further upstream call is made for it (FR-016).

Text fields are the source's text, returned as text. The gateway forwards no HTML, image or URL
from a source.

## Fight routes (slice 3, `SPORTS_FIGHT_ENABLED`, default off)

Specified in `fight-api.md` when slice 3 starts; off ⇒ `503 sports_fight_unconfigured`, with no
effect on the routes above.
