# Gateway contract: `GET /v1/sports/fights/:gameId` (spec 115 slice 3)

Read-only, origin-locked, same estate error envelope as `gateway-sports-api.md`. **Switched off**
(`SPORTS_FIGHT_ENABLED`, default false): off ⇒ `503` code `sports_fight_unconfigured` on THIS route only, with no
effect on `/v1/sports/games*` (FR-020). The module's own checks come first (`sports_unconfigured`,
`sports_paused`, `killswitch_active`), then parameters (`400 invalid_params`), then quota.

> **Everything about a LIVE fight is unverified** until the 2026-12-05 card has been watched (research R3 is
> open). The shape below was written from COMPLETED cards (UFC 334 on 2026-11-14 and seven others). Fields that
> have only ever been seen in their finished state are listed at the end; no surface may rely on them being
> right mid-fight.

## Request

`:gameId` is the venue's id (positive integer). Optional identity claim, from the event listing:
`?a=<fighter name>&b=<fighter name>&start=<ISO time>` — `a` and `b` together (2–60 letters, marks, space, `. ' ’ -`),
`start` optional and within [now − 45 d, now + 30 d] (it chooses a day range asked of ESPN, so it is bounded). Same rules
as the game claim: validated, **request-scoped, never stored against the gameId**, ignored once the venue's own frame
has named the fight, and never echoed back (a name in the answer is always a source's own text).

## Response

```jsonc
{
  "serverNow": 1795737600000,
  "sources": {                                   // each fails alone and is named
    "venue":   { "state": "read", "label": "Polymarket" },  // read | unreadable + reason  (the feed; identity + its own words)
    "card":    { "state": "read", "label": "ESPN" },        // read | unreadable + reason | not-matched + reason | not-covered | off
    "figures": { "state": "read", "label": "UFC" }          // same set; the UFC source: figures, method, judges, official outcome
  },
  "fight": {
    "gameId": 13140,
    "source": "card",             // whose status/round/clock the next fields are: "card" | "figures" | "venue" | null
    "status": "ended",            // "scheduled" | "in-progress" | "ended" | "cancelled" | null
    "scheduledRounds": 5,         // or null
    "weightClass": "Heavyweight", // the source's own text, or null
    "round": 5, "clock": "5:00",  // current (or, once ended, ending) round and clock; null when not known / not started
    "confirmedAt": 1795737597000, // server ms when `source` last said this; null ⇒ unknown
    "changedAt": null,            // venue source only: the fight's last frame
    "fighters": [ { "name": "Ciryl Gane" }, { "name": "Josh Hokit" } ],   // see order, below
    "result": null,               // see below
    "venue": null,                // when source != "venue" and the venue has spoken: { status, scoreText, clock, changedAt }
    "rounds": null,               // [ { "round": 1, "figures": [ <figures of fighters[0]>, <figures of fighters[1]> ] }, … ]
    "overall": null               // [ <figures>, <figures> ] — the source's own whole-fight figures, never a sum of ours
  }
}
```

**Order.** `fighters[0]`/`[1]` follow the venue's frame (`homeTeam`, `awayTeam` — NOT corners; UFC's red/blue is not used),
else the claim's `a`, `b`, else the card source's order. Every per-fighter array (`result.winner`, `judges[].scores`,
`rounds[].figures`, `overall`) is in THAT order. With nothing identifying the fight, `fighters` is
`[{name:null},{name:null}]`.

**Whose figures.** `source: "card"` (ESPN) where it was read and matched; else `"figures"` (UFC's own status — only
`Final`/`Upcoming`, i.e. `ended`/`scheduled`; its round/clock are the result's ending round/time); else `"venue"`
(`status` ended or cancelled, `clock` its own text, `round` null); else null. *Why ESPN leads:* on eight completed
cards (105 fights) ESPN and UFC agreed on every ending round, ending clock and winner, so the completed data cannot
separate them (research R3); ESPN leads because one cached read answers a whole card and it says `completed` itself.
`post` without `completed` is not `ended` (`status: null`). `cancelled` is only ever the venue's word (research R3).

**`result`** (FR-019) — present only once the fight is finished (`status` `ended`/`cancelled`, or UFC says Final):

```jsonc
{ "source": "figures",            // "figures" (UFC, official) | "card" (ESPN's single winner flag) | "venue"
  "outcome": "win",               // "win" | "draw" | "no-contest" | "cancelled" | null (not known)
  "winner": 0,                    // index into `fighters`; null unless outcome is "win"
  "method": "Decision - Unanimous", "endingRound": 5, "endingTime": "5:00",   // each null when the source gave none
  "judges": [ { "name": "Adrian Castro", "scores": [48, 47] } ] }              // [] when none (a KO has none)
```

A draw, a no contest and a cancelled fight each have `winner: null`. **`draw` and `no-contest` exist only from UFC
(`figures`)**: ESPN marks a draw, a no contest and a fight not yet fought identically (both competitors `winner: false`),
so with the UFC source down the result is absent or ESPN's one winner — never "no winner, so a draw". Nothing in this body
refers to a market's resolution.

**Figures** (FR-018). Each figure object has EXACTLY these keys, ours (`FIGURE_NAMES` in `ufc.js`), each a non-negative
integer the source reported or `null`; **never 0 for absent** (a reported 0 stays 0): `knockdowns`,
`sigStrikesLanded/Attempted`, `totalStrikesLanded/Attempted`, `headStrikesLanded/Attempted`,
`bodyStrikesLanded/Attempted`, `legStrikesLanded/Attempted` (the source's significant-strike head/body/leg counts),
`takedownsLanded/Attempted`, `reversals`, `submissionsAttempted`, `controlSeconds` (the source's `m:ss` control time as
seconds — a unit change, not a derivation). Nothing else crosses: no accuracy, no source field names, no sum, no score, no
lead, no "winning". Only rounds the source reported are listed. Figures are requested only for a fight UFC says has begun
or ended.

**Trust bounds** (the ONE constant, `bounds.js#TRUST_BOUNDS`; mirrored by the frontend): `card` live ≤ 30 s / delayed
≤ 120 s; `figures` **never live** / delayed ≤ 120 s; `venue` never live / delayed ≤ 75 s. All provisional until a live card.

## Matching and discovery

A fight matches only when BOTH fighters' names are equal after Unicode NFD, diacritics stripped, case, punctuation and
whitespace folding (either order): exactly one fight, else the source's state is `not-matched` with `reason`
`no_candidate` | `ambiguous` | `no_identity`. Never the nearest. The UFC source has no event index: the gateway probes ids
up from a configured anchor (`SPORTS_UFC_ANCHOR_ID`) and stops after `SPORTS_UFC_PROBE_MAX` consecutive empty answers
(`200 {"LiveEventDetail":{}}`); candidates are cards within 36 h of the claim's `start`, or — with none — live or within three
days of now. ESPN is asked for a three-day range around the matched card's own start. Final cards and official final fights
are read once and kept. Worst case upstream requests: cold `(highest − anchor + 1) + probeMax` event reads (22 with
today's data: anchor 1340, highest 1355, probeMax 6), then `probeMax` per 6 h discovery window plus one per new card; per
distinct viewed fight one ESPN range read per ≥ 10 s and, until final, one UFC fight read per ≥ 15 s.

## Only ever seen in their finished state (unverified live)

`status`/`round`/`clock` of an in-progress fight from either source; ESPN's period/clock for a running round; the UFC
event's `LiveFightId`/`LiveRoundNumber`/`LiveRoundElapsedTime` (always null so far); `RoundStats` for a round in progress
and whether `OfficialStats` is false until the fight ends; the venue's live frame for a fight (never observed); any
`cancelled` shape from ESPN or UFC (only the venue's `Canceled`/`CAN`); how fast any of it updates.
