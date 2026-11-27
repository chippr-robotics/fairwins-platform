# Tasks: Predict live game views (spec 115)

## Research

- [x] R1 Measure the venue feed through a live game: messages per game per minute by league, what
  arrives on connect, control frames, behaviour across a reconnect, which side of `score` is home.
  Record in `research.md`; set the trust bounds from it.
- [x] R2 Team-code differences between the venue and the play source for NFL and college football;
  build the alias table from observed data only.
- [ ] R3 (slice 3) Watch the UFC source through the 2026-12-05 card.

## Slice 1 — scoreboard

- [x] T001 Event normaliser: `EventRow.game` (contract § "The event listing gains `game`") + tests.
- [x] T002 `sports/venueFeed.js`: one lazy connection, idle close, backoff, per-game readings.
- [x] T003 `sports/espn.js` scoreboard + `match.js`; cache, single-flight, request assertions.
- [x] T004 `sports/routes.js` `GET /v1/sports/games`, config, quotas, killswitch, `/health` block.
- [x] T005 FinOps catalogue entries for each source (modelled $0, visible) + upstream label.
- [x] T006 `lib/sports/gameReading.js` + `gameFeed.js` (visible-only polling, server clock).
- [x] T007 `GameScoreboard` on the event page; four trust states; text for everything.
- [x] T008 Boundary test: no ticket/plan/trade module imports the game view.
- [x] T009 Cypress no-chain spec + matrix row to `covered`; screenshots, both widths and themes.
- [x] T010 Developer guide + runbook section + CLAUDE.md paragraph.

## Slice 2 — field and plays

- [x] T011 `GET /v1/sports/games/:gameId` detail from the play source.
- [x] T012 `FootballField` (SVG + text equivalent) and `PlayList`.
- [x] T013 Disagreement handling (FR-008 as amended) end to end.
- [ ] T013a Add leagues beyond NFL to the play source (each needs its score order and team codes
  verified at the same moment).
- [ ] T013b Observe overtime, a red-zone situation and a dead-but-open venue connection.

## Slice 3 — fight view (ships off)

- [x] T014 `fight-api.md`, gateway `fight.js` against completed cards.
- [x] T015 `FightView`: rounds, clock, per-round figures side by side, result with judges' scores.
- [x] T016 Leave `SPORTS_FIGHT_ENABLED` off; R3 decides.
