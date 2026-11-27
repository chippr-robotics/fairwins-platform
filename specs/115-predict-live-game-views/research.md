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
  (a string) and **no** `gameId` — they cannot be keyed and are dropped. No ping from our side.
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

- **Heartbeat (checked across all four capture files).** The bare `null` frame IS a heartbeat: **540 of them**, gap between
  consecutive nulls min 1.5 s, median 15.3–15.7 s (per file), max 27.6 / 29.2 / 44.4 / 42.9 s. Within one connection, across
  **2,602** gaps between frames of ANY kind: p99 **20.8 s**, max **41.5 s** (the first file alone peaked at 18.7 s; the later
  files, captured while three sockets shared the machine, had longer gaps — a capture-side stall is not ruled out).
  **Bound derived:** a connection is dead after **60 s** with no frame of any kind (≈ 4 heartbeats, 1.4× the worst gap
  seen), checked every 15 s, so detection takes 60–75 s; it is then closed and reconnected. Hence the earlier "silence is not
  an outage" holds for a GAME, not for the CONNECTION: `confirmedAt` of a venue row is the last frame of any kind on the open
  connection (only if the game's frame arrived on it), `changedAt` the game's own last frame. Not observed: a connection that
  stayed open but silent (every drop seen was a clean code-1006 close); the watchdog's value is untested against a real one.

### Trust bounds (one constant: `services/relay-gateway/src/sports/bounds.js#TRUST_BOUNDS`)

| source | live | delayed | beyond | basis |
| :-- | :-- | :-- | :-- | :-- |
| `plays` (age of the last successful ESPN read) | ≤ 30 s | ≤ 120 s | last known | scoreboard cache floor is 10 s; 30 s is three cache windows, 120 s a few missed polls. ESPN failed 0 of 940 polls, so these are cache-window multiples, not measured outages. |
| `venue` (age of `confirmedAt`) | **never** | ≤ 75 s | last known | the venue was a median 34 s (max 203 s) behind ESPN and sends a game only on change, so even a fresh venue figure is not "now". With heartbeat-based `confirmedAt`, 75 s = five heartbeats. |

`live` (plays only) means the **age** is small, not that the picture is current: neither source is the broadcast. The surface says so in words (spec FR-011).

### Whose figures (amended FR-008)

Because the venue never led ESPN (min lag −5 s = sampling noise, median 34 s, max 203 s) and its final came 3.5 min later, a
row is the play source's wherever it was read AND matched; the venue's own figures ride beside it (`venue`), `agree`
compares scores. **ESPN period text mapping:** the game row uses ESPN's own `status.type.shortDetail` with its leading
"clock - " removed (`"9:44 - 3rd"` → `3rd`; `"Final"` → `Final`); a scheduled game's `shortDetail` is a date, so period is null,
and its filler score `0` / clock `0:00` are dropped (null). Seen: `3rd`, `4th`, `1st`, `Final`, scheduled. **Not seen:**
overtime (`Final/OT`?), halftime, "End of 3rd", delayed/suspended — whatever ESPN sends is forwarded as its text, never
re-labelled. The play list (summary) gives only a period NUMBER, so plays carry Q1–Q4 for 1–4 and null otherwise.

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

## Slice 3 — fights (2026-11-27; completed cards only)

**R3 is OPEN: nothing about a LIVE fight has been observed** (no live UFC frame, no in-progress ESPN competition, UFC's
`LiveFightId`/`LiveRoundNumber`/`LiveRoundElapsedTime` null on every card read). The next chance is the 2026-12-05 card.

### R3a — the three sources, from real payloads

- **Venue.** 531 `ufc` frames, all `ended: true`: `Final` / `FT` with `score: "<home wins>-<away wins>|<method>"`
  (`0-1|KO/TKO`; 421 of 421 matched against UFC's winner with home first), `Canceled` / `CAN` (88, no score), and a few
  `Final` with `0-0` (draws) or no score at all. `elapsed` is the ENDING time (`02:08`), never a round; there is no round field.
  Names are the fighters' (`"Alatengheili "` carries a trailing space; `Uroš` keeps its diacritic).
- **ESPN** `…/mma/ufc/scoreboard`: one `competitions[i]` per fight with `status.period` (= round), `displayClock`,
  `type.state`/`completed`, `format.regulation.periods`, `type.abbreviation` (weight class), `competitors[].athlete.displayName`
  and `winner`. `?dates=YYYYMMDD` and a `YYYYMMDD-YYYYMMDD` range both return past cards (no param = the next card).
  A scheduled fight prints period 0, clock `-`; a draw, a no contest and an unfought fight are ALL `winner: false/false`.
  130 competitions across 7 cards were all `STATUS_FINAL`/`completed: true`.
- **UFC** `…/api/v3/event/live/{id}.json` (card: fighters, `Outcome` Win/Loss/Draw/No Contest, `Result` Method/EndingRound/
  EndingTime/FightScores per judge, `RuleSet.PossibleRounds`) and `…/fight/live/{id}.json` (`FightStats` + `RoundStats` per
  fighter per round, 66 keys each). Methods seen in 1,227 fights over 113 cards (40 of them upcoming, no result): KO/TKO 444, Decision-Unanimous 437,
  Submission 202, Decision-Split 78, Decision-Majority 12, TKO-Doctor's Stoppage 7, Could Not Continue 4, Overturned 2, DQ 1.
  **Draw/Draw: 9. No Contest/No Contest: 6** (methods `Could Not Continue`, `Overturned`, and `KO/TKO`). **Cancelled: none** —
  a cancelled bout simply leaves the card, so a cancellation is visible only as the venue's `Canceled`, and UFC and ESPN
  contradict it for a fight that did happen (Nunes v Harrison, UFC 334: venue `Canceled`, UFC `Submission` R4 1:29). Judges
  exist only for decisions (and the Overturned NC); a KO/submission has none.
- **Missing event ids answer `200 {"LiveEventDetail":{}}`** (not 404) for every id beyond the last, so "found" must be tested on
  the body. Ids are near date order only: 1345 = 2026-11-14, 1348 = 11-21, 1349 = 12-12 (upcoming), 1352 = 12-05 (the next card),
  1355 = 2027-02-13; 1356 and up are empty (probed to 99999).
- **Fight-view figure keys.** `FightStats`/`RoundStats` carry 66 per-fighter fields; the fixed list of ours is 16
  (`ufc.js#FIGURE_KEYS` + `controlSeconds`). `TakedownsAccuracy` is null on fights with no takedown attempt and is not forwarded.

### R3b — who leads status/round/clock, and why

On **eight completed cards, 105 fights**, ESPN and UFC agreed on the ending round, ending clock and winner in **105 of 105**
(and on "finished" in 105 of 105), so completed data cannot rank them. ESPN leads because: one cached read answers the whole card
(UFC needs an event read per card plus a fight read per fight), `completed` is explicit, and it is the transport that was measured
on football. UFC leads the RESULT and FIGURES because method, judges and draw/no-contest exist nowhere else. If ESPN is down the row
falls back to UFC's `Final`/`Upcoming` only (never its live fields: they have never been seen non-null). The venue is last and never live.

### R4 — matching across the three sources (names, normalised; exactly one or not-matched)

- **UFC ↔ ESPN, 8 completed cards, 105 fights: 105 matched (100 %)**, including `Uroš Medić`/`Uros Medic` and `Ode' Osbourne`/
  `Ode Osbourne`. Cards: 1343, 1345, 1348, 1332, 1339 (Oct–Nov 2026), 1297 (2026-02-21), 1293 (2025-12-06), 1259 (2025-06-14).
- **Venue frames ↔ UFC fight, all 531 frames vs 113 cards (ids 1240–1352): 434 matched exactly one, 5 ambiguous, 92 none.**
  The 92: 78 are `Canceled` frames (no such fight on any card, as above) and 14 `Final` frames whose pair is on no card read
  (older than the ids probed, or a bout UFC never carded). The 5 ambiguous are rematches on two cards (e.g. Dvalishvili v Yan,
  cards 1293 and 1336; Volkanovski v Lopes, 1251 and 1295): **a venue frame carries no date, so a rematch with no claim `start` is
  `not-matched` (`ambiguous`)** — which is why the candidate window exists.
- **All three sources on the same fight, 8 cards / 105 fights: 48 (46 %).** Every miss is on the venue side: **no frame for that
  pair in the capture** (cards 1343/1345/1348/1332/1339: 3/6/4/7/5 missing; the two 2025 cards 11–13 missing). Whether the venue
  never listed those bouts, listed and dropped them, or the capture simply began after their frames is **not determined**.
  ESPN↔UFC misses: none.

### R5 — UFC event discovery without an index: worst case

Probe up from a configured anchor, stop after `probeMax` consecutive empty answers. Cold: `(highest − anchor + 1) + probeMax`
event reads — **22 today** (anchor 1340, highest answering id 1355, probeMax 6) — once per process and shared. Refresh: after
`discoveryTtlMs` (6 h, only if a fight request arrives) `probeMax` reads past the highest known id plus one per new card; a Final
card is never re-read, a non-final one at most every 15 s (live) / 10 min (otherwise). Per viewed fight: one ESPN range read per
≥ 10 s window, one UFC fight read per ≥ 15 s until the fight is Final and `OfficialStats` (then never). No background polling.
A stale anchor costs more probes; an anchor above a card makes that card unreachable (`not-matched`).

### Fight listings (`EventRow.game`)

`normalizeGame` already yields a usable `game` for a fight, unchanged: gamma lists a fight as an event with `gameId`, `sport.sport`
`ufc`, two `teams[]` with `ordering` home/away (the venue's, NOT corners; `abbreviation` is a meaningless slug such as `diy`/`ali8`,
so a surface must show `name`, not `code`) and the same `score`/`period`/`elapsed`/`live`/`ended` fields as a game. Real example:
event slug `ufc-diy-ali8-2026-11-21` (series 38). **Every fight event found was `closed: true`** (series 38, newest first, all
already finished) and `normalizeEventPage` drops closed events, so the shape of an OPEN fight listing — and which fights the venue
lists a market for ahead of a card — was **not observed**; nothing is assumed about it.

### What was NOT verified

Anything live (above); an open fight listing; a `cancelled` status from ESPN or UFC; ESPN's behaviour for a card straddling UTC
midnight beyond the ±1 day range; the UFC source's rate limits and terms; stability across days.
