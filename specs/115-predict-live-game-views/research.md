# Research: Predict live game views (spec 115)

All measurements were taken on **2026-11-27** from one container, outbound through a proxy, against the two public
sources the gateway reads. Unauthenticated, no subscribe message. Raw captures were kept outside the repository; the
small fixtures the gateway tests use (`services/relay-gateway/test/fixtures/sports/`) are cut from them.

**Sample, stated once:** one NFL game watched end to end (PHI @ DAL, venue gameId 19618, ESPN 401873080, 00:00Z–01:37Z,
with a 7-minute hole at 00:27–00:34Z), plus the first ~10 minutes of KC @ BUF (venue 19621); 4 overlapping connections
to the venue feed totalling ~141 socket-minutes; 940 ESPN polls (10 s scoreboard, 15 s summary), none non-200. Nothing
here is a statement about other leagues' ESPN data, other days, or load. Numbers below are NFL unless a league is named.

## R1 — the venue feed (`wss://sports-api.polymarket.com/ws`)

- **Shape.** One JSON object per game state: `gameId` (integer), `leagueAbbreviation`, `homeTeam`, `awayTeam`, `status`,
  `score`, `elapsed`, `period`, `live`, `ended`; NFL adds `turn` (lower-case team code) and `turnProviderId`; final frames
  add `finishedTimestamp`. Bare JSON `null` control frames: 536 seen, ignored. Cricket frames carry `metadataGameId`
  (a string) and **no** `gameId` — they cannot be keyed and are dropped. No ping, no heartbeat.
- **What arrives on connect.** First connection: a burst of **531 distinct `ufc` games, all `ended: true`**, within ~50 s
  (103 in the first 10 s); zero live games. Five later connections: 1–4 frames in the first 10 s, all e-sports/tennis/
  football-other, **never an NFL frame**. So a freshly opened socket knows nothing about a given game until that game's
  next frame — this is why a first request returns an all-null row (contract). Whether the first-connection UFC burst
  is a replay-on-first-connect or a one-off was not determined.
- **Cadence (NFL).** Frames land on whole-minute ticks (:08–:10 s past the minute) and only when something changed. Gaps
  between consecutive NFL frames, 2 games, 46 gaps (hole-spanning gaps excluded): **min 60 s, p50 60 s, p90 302 s,
  p99/max 723 s; 61 % ≤ 61 s.** An 8-minute silence (00:04:03 → 00:12:08) happened while ESPN's state changed ~6 times,
  so silence is **not** "nothing happened". Other leagues, gaps p50 / p90 / max (s): cbb 60/241/966 (6 games),
  cwbb 60/181/1567, cfb 51/313/375, cricket 61/121/364, bra 60/181/241, mex 60/65/236, challenger 42/105/356,
  wta challenger 42/115/141, val 40/60/221, **cs2 20/40/61 (100 % ≤ 61 s)**. E-sports/tennis frames repeat identically
  (`identical-repeats` up to 99 % for val/cs2); NFL, cbb, cwbb, cricket never repeated an identical frame.
- **Lag behind ESPN.** For 38 NFL frames whose exact (clock, score) state ESPN had shown first, receive time minus ESPN's
  first-seen time (ESPN sampled every 10 s): **min −5 s, median 34 s, max 203 s.** The venue is a minute-tick sample of a
  state ESPN already held; it is never ahead by more than sampling noise.
- **End of game.** ESPN went `post`/`STATUS_FINAL` between 01:33:50 and 01:34:00Z. The venue sent `period: "End Q4"`,
  `live: true, ended: false` at 01:34:29Z and its real final — `status:"Final"`, `period:"FT"`, `live:false`, `ended:true`,
  `turn:""`, `elapsed:""` — at **01:37:30Z, ≈ 3.5 min after ESPN**. Between those the venue's own listing still said
  live. A venue-only reading therefore says "in progress" for minutes after the game is over; the gateway keeps the
  venue's status (it is the venue's market state that members trade against) and `agree`/plays show ESPN's.
- **Which side of `score` is home: the first number is AWAY.** 40 of 40 deduplicated NFL frames matched the nearest ESPN
  sample only with `score = away-home` (PHI 10, DAL 28 read `10-28`; DAL's field goal read `10-31`, PHI's touchdown
  `17-31`; final `39-38` = PHI 39, DAL 38). A second game confirms it: CHI 39 @ DET 35 final read `39-35`. **Other
  leagues were not compared against ESPN** (their ESPN team codes differ — Creighton is `CREIGH` at the venue), so only
  `nfl` gets an integer score; everything else is `scoreText`. E-sports/tennis scores are not two integers at all
  (`000-000|1-1|Bo3`, `6-3, 3-1`, `6-6(2-1)`, `192-15`).
- **Does `turn` track possession?** Mostly: it equalled ESPN's possession team in **31 of 33** comparable frames. The two
  misses were within seconds of a possession change at a quarter boundary. `turn` can be `""` (final).
- **Status words** seen: `InProgress`, `inprogress`, `running`, `Final`, `Canceled`; period labels include `Q1…Q4`,
  `End Q4`, `FT`, `H1/H2`, `S1/S2`, `TB1`, `1/3`, `Live`, `CAN`, `VFT` (listing). **Not observed:** any frame for a
  game before kickoff (KC @ BUF sent nothing until it was `InProgress`, Q1 15:00, at 01:29:28Z), any overtime frame, any
  `Scheduled`-style status. The mapping to `scheduled` is therefore from the listing's `NS` and is **unverified** for frames.
- **Connection stability.** 4 unexpected closes (code 1006) in ~141 socket-minutes, each followed by a clean reconnect
  that took < 3 s here. A drop loses nothing a re-ask cannot rebuild except the next-frame wait above.

### Trust bounds (one constant: `services/relay-gateway/src/sports/bounds.js#TRUST_BOUNDS`)

| source | live | delayed | beyond | basis |
| :-- | :-- | :-- | :-- | :-- |
| `venue` (age of the newest frame for THAT game) | ≤ 75 s | ≤ 300 s | last-known | tick is 60 s (min gap 60 s, p50 60 s); +15 s for jitter. A bound under 60 s would call the healthy feed delayed most of the time. 300 s ≈ the p90 NFL gap (302 s); the 485/663/723 s silences are `last-known`, said so. |
| `plays` (age of the last successful ESPN read) | ≤ 30 s | ≤ 120 s | last-known | scoreboard cache floor is 10 s; 30 s is three cache windows, 120 s a few missed polls. ESPN failed 0 of 940 polls, so there is no failure-rate basis — these are cache-window multiples, not measured outages. |

`live` means the **age** is small, not that the picture is current: the venue's median lag behind ESPN is 34 s on top
of its age, and neither is the broadcast. The surface says so in words (spec FR-011).

## R2 — team codes, venue vs ESPN (NFL)

Venue codes from the event listing for all 32 teams (28 upcoming games, series 12185) against ESPN's `/teams` and
scoreboard codes: **30 of 32 identical; 2 differ — venue `WAS` ↔ ESPN `WSH`, venue `LA` ↔ ESPN `LAR`.** That is the whole
alias table (`leagues.js`). Venue frames carry codes upper-case (`DAL`), the listing lower-case (`dal`); both normalised.
Home/away: the listing marks each team `ordering: "home" | "away"` and every NFL game had one of each; the frame's
`homeTeam`/`awayTeam` agreed with ESPN's `homeAway` for PHI @ DAL and KC @ BUF (CHI @ DET has a listing, no frame). The venue frame carries **no
start time**, so the ±30 min test in `match.js` only runs when a caller supplies one (none does today); within one ESPN
scoreboard week a team pair is unique. **Not checked:** a week where the same two teams meet twice; the playoffs; any
non-NFL league's codes. Anything short of exactly one match is `not-matched`.

## R3 — ESPN scoreboard / summary

- `situation.yardLine` is **already on the home-goal axis** (0 = home goal line) regardless of possession: PHI (away) on
  its own 21 reads 79, DAL (home) on its own 41 reads 41, PHI 40 with DAL possessing reads 60. (An early assumption that
  it counted yards to the attacked goal was wrong; the cross-check in `deriveYardLine` caught it by returning null.)
  22 distinct captured situations (12 away-possession, 8 home, 2 with **no** `possession` field — right after a score —
  and 1 at midfield, text `"50"`) all derive, and the text-derived and numeric values agree on every one. Red-zone
  situations were not captured (`isRedZone` was always false).
- The scoreboard changed state ~once a minute (87 distinct states in the 101-minute span, holes included). Plays live in
  `summary.drives.previous[].plays` + `drives.current.plays` (no top-level `plays`); a play carries no team, the drive does.
  Play text has a leading space and, for scoring plays, `scoringPlay: true`.
- ESPN's summary is ~440 KB per call; only ≤ 12 plays are forwarded. A game stays on the scoreboard after it ends (CHI @ DET
  was still listed ~7 h after kickoff, final); **how long** was not measured, so a game that has dropped off and was never
  frozen is `not-matched`.

## What was NOT verified

- Any league other than NFL (ESPN paths, code tables, score order); fights/UFC (slice 3, nothing implemented).
- Frames before kickoff, overtime, `scheduled` status words, suspended/delayed games.
- Behaviour under load (the gateway has no background poller; the numbers above are for one viewer).
- ESPN's rate limits and terms — it is public and keyless with no service agreement; nothing here asserts it will stay so.
- The venue first-connection UFC burst (replay vs one-off).
- Stability across days: everything is one evening.
