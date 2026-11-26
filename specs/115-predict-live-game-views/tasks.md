# Tasks: Predict live game views (spec 115)

## Research

- [ ] R1 Measure the venue feed through a live game: messages per game per minute by league, what
  arrives on connect, control frames, behaviour across a reconnect, which side of `score` is home.
  Record in `research.md`; set the trust bounds from it.
- [ ] R2 Team-code differences between the venue and the play source for NFL and college football;
  build the alias table from observed data only.
- [ ] R3 (slice 3) Watch the UFC source through the 2026-12-05 card.

## Slice 1 — scoreboard

- [ ] T001 Event normaliser: `EventRow.game` (contract § "The event listing gains `game`") + tests.
- [ ] T002 `sports/venueFeed.js`: one lazy connection, idle close, backoff, per-game readings.
- [ ] T003 `sports/espn.js` scoreboard + `match.js`; cache, single-flight, request assertions.
- [ ] T004 `sports/routes.js` `GET /v1/sports/games`, config, quotas, killswitch, `/health` block.
- [ ] T005 FinOps catalogue entries for each source (modelled $0, visible) + upstream label.
- [ ] T006 `lib/sports/gameReading.js` + `gameFeed.js` (visible-only polling, server clock).
- [ ] T007 `GameScoreboard` on the event page; four trust states; text for everything.
- [ ] T008 Boundary test: no ticket/plan/trade module imports the game view.
- [ ] T009 Cypress no-chain spec + matrix row to `covered`; screenshots, both widths and themes.
- [ ] T010 Developer guide + runbook section + CLAUDE.md paragraph.

## Slice 2 — field and plays

- [ ] T011 `GET /v1/sports/games/:gameId` detail from the play source.
- [ ] T012 `FootballField` (SVG + text equivalent) and `PlayList`.
- [ ] T013 Disagreement handling (FR-008) end to end.

## Slice 3 — fight view (ships off)

- [ ] T014 `fight-api.md`, gateway `fight.js` against completed cards.
- [ ] T015 `FightView`: rounds, clock, per-round figures side by side, result with judges' scores.
- [ ] T016 Leave `SPORTS_FIGHT_ENABLED` off; R3 decides.
