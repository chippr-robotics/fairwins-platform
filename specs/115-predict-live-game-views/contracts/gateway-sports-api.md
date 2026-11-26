# Gateway contract: `/v1/sports/*`

Read-only. Origin-locked like every other proxy. Module off ⇒ every route answers
`503 { "error": "sports_unconfigured" }`; killswitch ⇒ `503 { "error": "sports_paused" }`. A gateway
that predates the module answers 404. The app treats all three the same way: no game view (FR-013).

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
    "plays": { "state": "read" }                          // or "unreadable" | "off"
  },
  "games": [
    {
      "gameId": 19618,
      "league": "nfl",
      "status": "in-progress",          // "scheduled" | "in-progress" | "ended" | null (not known)
      "score": { "home": 28, "away": 10 },   // null when not known; never 0 for "not known"
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
  dropped, and it is not an error.
- `score` for a sport whose venue score is not two integers (sets, maps) is `null` and
  `scoreText` carries the venue's own string. No surface parses `scoreText`.
- `agree: false` ⇒ `score` is the venue's (FR-008).
- Ended is the GAME's state. Nothing here says anything about a market's resolution.

## `GET /v1/sports/games/:gameId` (slice 2)

The row above, plus:

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
exactly one game at the play source for this venue game. Both are final for the request and neither
is a failure; `unreadable` is a failure and names itself.

Text fields are the source's text, returned as text. The gateway forwards no HTML, image or URL
from a source.

## Fight routes (slice 3, `SPORTS_FIGHT_ENABLED`, default off)

Specified in `fight-api.md` when slice 3 starts; off ⇒ `503 sports_fight_unconfigured`, with no
effect on the routes above.
