# Implementation Plan: Predict live game views

**Spec**: [spec.md](./spec.md) | **Tracking**: #1756

## Summary

A read-only game view on the Predict event page: a scoreboard for every game the venue reports
(slice 1), a football field and the last plays (slice 2), and a fight view (slice 3, built and left
off until its source has been watched through a live card — FR-020). The device asks the gateway
and nothing else; the gateway reads three public sources behind one seam and answers with one
envelope. No contract changes, no new dependency, no lockfile change, nothing signed, no fee.

## Technical context

- **Gateway**: `services/relay-gateway/src/sports/` (Node 22 ESM, Express). The fifth read proxy,
  shaped like `news/` (spec 109): mounts unconditionally, `SPORTS_ENABLED` default off ⇒
  `503 sports_unconfigured`, own quotas, killswitch, `/health` block.
- **Frontend**: `frontend/src/lib/sports/` + `components/predict/game/`, mounted by `EventPage.jsx`.
- **Sources** (all public, none under a service agreement — each has its own off-switch):
  | id | what | transport | supplies |
  | :-- | :-- | :-- | :-- |
  | `venue` | Polymarket sports feed | one upstream WebSocket, Node's built-in client | status, score, period, clock, side in possession |
  | `plays` | ESPN site API | polled by the gateway, cached | situation, drives, plays (football); scoreboard cross-check |
  | `fight` | UFC event/fight JSON (+ ESPN MMA card for matching) | polled, cached | round, clock, per-round figures, result |
- **Testing**: gateway `node --test` with recorded fixtures (assert on the REQUEST as well as the
  answer — spec 089 rule 6); Vitest scoped to the new files; Cypress no-chain spec for the page with
  the gateway stubbed; capture harness screenshots at both widths and themes.

## Constitution check

- Security-first / no custody: read-only, no signer, no key, no member data upstream. PASS.
- Honest state (III): four trust states on the server clock; per-source three-state reads; absent
  is never zero. PASS by construction (see "The reading type").
- No value path gated on advisory data: FR-010 enforced structurally — nothing under
  `lib/sports/` or `components/predict/game/` is imported by a ticket, plan or trade module, and a
  boundary test fails if that changes. PASS.
- Dependencies: none added. PASS.

## Design

### The game's identity

The venue's event listing already carries the game (`gameId`, league, start time, both teams). The
gateway's event normaliser passes it through as `EventRow.game` (`null` when the event names no
game). The page shows a game view only when `game` is present — a futures market gets nothing.

### The reading type

`lib/sports/gameReading.js` mirrors `lib/markets/priceReading.js`: a reading is `live`, `delayed`,
`last-known` or `unknown`, aged on the server's clock (`lib/markets/serverClock.js`). Constructors
for the last two take no "live" flag, and `unknown` carries no figures at all.

**What "confirmed" means differs by source, and the bounds come from measurement, not taste.**
The plays source is polled: confirmed = the moment the gateway last read it. The venue feed is
pushed, speaks about a game only when it changes, and its only heartbeat is a bare `null` every
15 s — a 45 s listen on 2026-11-26 during an NFL third quarter delivered
nothing for that game, while e-sports games repeated about every 20 s. So research task R1 measures
the feed's per-league cadence through a full game before the bounds are fixed, and the gateway
cross-checks the venue against the plays source where one exists. **R1 settled it (2026-11-27):** the
venue ran a median 34 s behind the plays source, so the plays source leads where it is read and a
venue reading is never drawn as live (contract § "Whose figures", spec FR-008 as amended).

### The gateway module

```
sports/
  venueFeed.js    one WebSocket, lazily opened on first request, closed after 5 idle minutes;
                  per-game last message + when; reconnect with backoff; never throws to a request
  espn.js         league → path table; scoreboard (≥10 s cache) → match → event id; summary (≥5 s
                  cache, single-flight); stops polling an ended game and keeps its final answer
  match.js        venue game ↔ ESPN event by league + start time (±30 min) + both team codes
                  through an alias table; anything short of exactly one match is `not-matched`
  normalize.js    upstream → the envelope; numbers stay numbers only when the source gave one
  fight.js        slice 3
  routes.js       GET /v1/sports/games?ids=…   GET /v1/sports/games/:gameId   (fight routes: slice 3)
```

FR-015/016: upstream requests are a function of games being viewed, never of members (single-flight
+ cache), a game nobody has asked about for 2 minutes is not polled, and an ended game is read once
more and frozen.

### The surfaces

`GameScoreboard` (teams, score, period, clock, status, trust chip with age) → `FootballField`
(SVG: yard line, possession, direction, down and distance, line to gain; a text equivalent beside
it always) → `PlayList` (newest first, period + clock, "Scored:" in words). One sentence under any
play detail: it can be behind the broadcast and the market. No motion on a score, no call to
action, no countdown (FR-011). Colours are `theme.css` tokens only; team colours are NOT used
(third-party identity is the one exemption in spec 091 and it is not needed here).

## Slices

1. **Scoreboard** — event normaliser `game`, gateway module with the `venue` source and ESPN
   scoreboard cross-check, `GameScoreboard`, FinOps entries, docs. Ships off.
2. **Field and plays** — ESPN summary, `FootballField`, `PlayList`.
3. **Fight view** — against completed cards; `SPORTS_FIGHT_ENABLED` stays off until 2026-12-05
   confirms the live fields.

## Risks

- **No service agreement.** Either public source can change shape or refuse us. Each fails alone,
  names itself, and has an off-switch; FR-014's seam is where a licensed provider goes later.
- **A member trades on a late picture.** The view is beside a ticket and is slower than the
  broadcast and than professional feeds. It states its own age, says so in words, and feeds nothing
  to the ticket.
