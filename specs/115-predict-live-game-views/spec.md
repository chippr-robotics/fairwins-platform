# Feature Specification: Predict — live game views for sports markets

**Feature Branch**: `115-predict-live-game-views`

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Dedicated venues show live game views (a football field, a
scoreboard) beside their sports markets. Do the same for our sports from public sources. We have
no funding for licensed data yet; that can be added at scale." (issue #1756)

## Clarifications

### Session 2026-11-26

- Q: Which sources may be used? → A: **Public ones only, for now.** The venue's own public sports
  feed for score, clock, period and possession; public scoreboard endpoints for play-level detail.
  A provider with a service agreement is added later, at scale, behind the same seam (FR-014).
- Q: May the game view influence an order? → A: **No.** It is information beside the market. It
  never feeds a figure on the ticket, never enables or disables a control, and never prompts a
  trade (FR-010, FR-011).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - See the score and clock of a live game beside its market (Priority: P1)

A member opens a sports market whose game is in progress and sees the teams, the score, the period
and the game clock, with whether that information is current.

**Why this priority**: It is what the price is reacting to, it is available for every sport the
venue lists, and it comes from the venue itself.

**Independent Test**: Open the event page of a game in progress; the scoreboard shows the score,
period and clock the source reports, and its age. Open one that has not started and one that has
ended; each says so.

**Acceptance Scenarios**:

1. **Given** a game in progress, **When** its event page is open, **Then** the scoreboard shows
   both teams, the score, the period and the clock, and updates without a refresh.
2. **Given** the game has not started, **When** the page is open, **Then** it shows the start time
   and no score.
3. **Given** the game has ended, **When** the page is open, **Then** it says the game has ended
   with the final score, and does not say the market has resolved unless the venue says so.
4. **Given** the source stops answering, **When** the last state grows old, **Then** the
   scoreboard is marked delayed with its age, then last known, and is never drawn as live.

---

### User Story 2 - See where the ball is in a football game (Priority: P2)

For a football game in progress, the member sees a field with the ball's position, which team has
it and which way they are going, the down and distance, and the line to gain.

**Why this priority**: It is the picture members expect from a sports venue, but it depends on a
play-level source that may not answer.

**Independent Test**: With play-level detail available, the field shows the yard line, possession
and down and distance the source reports. With it unavailable, the field is absent, the scoreboard
remains, and a sentence names what could not be read.

**Acceptance Scenarios**:

1. **Given** a football game in progress and play-level detail available, **When** the page is
   open, **Then** the field shows the ball at the reported yard line, the team in possession, the
   direction of play, the down and distance and the line to gain.
2. **Given** play-level detail is unavailable, **When** the page is open, **Then** no field is
   drawn, the scoreboard is unaffected, and the page says play detail could not be read.
3. **Given** the two sources disagree about the score, **When** the page is open, **Then** the
   venue's score is shown and the play detail is marked as possibly behind.
4. **Given** a member who does not see colour, or uses a screen reader, **When** they read the
   field, **Then** the same facts are available as text.

---

### User Story 3 - Read the last plays (Priority: P3)

The member sees the most recent plays of the game as text, newest first, each with its clock time.

**Why this priority**: It explains a price move after the fact. It adds little without the first
two stories.

**Independent Test**: With play-level detail available, the list shows the reported plays in
order, newest first. It never shows a play the source did not report.

**Acceptance Scenarios**:

1. **Given** plays have been reported, **When** the list is open, **Then** it shows them newest
   first with the period and clock of each.
2. **Given** a scoring play, **When** it is listed, **Then** it is marked as scoring in text.
3. **Given** play-level detail is unavailable, **When** the page is open, **Then** the list is
   absent and the page says so once.

### Edge Cases

- A market's event has no game attached: no game view is drawn and nothing is said about it.
- The game cannot be matched between the two sources: the scoreboard is drawn from the venue's
  feed alone.
- Overtime, a delay or a postponement: the period and status are shown in the source's words; a
  status this surface does not recognise is shown as text, never mapped to a guess.
- A sport with no play-level source: scoreboard only.
- The member's device clock is wrong: ages are measured against the server's clock.
- The gateway module is off, or the gateway predates it: no game view is drawn.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: For a sports market whose event names a game, the event page MUST show both teams,
  the score, the period and the game clock when the game is in progress.
- **FR-002**: The game view MUST distinguish not started, in progress and ended, and MUST NOT
  describe an ended game as a resolved market.
- **FR-003**: The game view MUST update without a manual refresh while the page is visible, and
  MUST stop asking for updates when it is not.
- **FR-004**: Every game state shown MUST carry its age, measured on the server's clock, and one
  of four states: live, delayed, last known, unknown. Only a state confirmed within its bound may
  be drawn as live.
- **FR-005**: For a football game with play-level detail, the page MUST show the ball's yard line,
  the team in possession, the direction of play, the down and distance and the line to gain.
- **FR-006**: The page MUST show the most recent plays as text, newest first, with period and
  clock, and MUST mark scoring plays in text.
- **FR-007**: Each source MUST fail independently. A source that cannot be read is named in a
  sentence, the fields it would have supplied are absent, and no absent field is drawn as zero.
- **FR-008**: Where the sources disagree about the score, the venue's MUST be shown and the play
  detail MUST be marked as possibly behind.
- **FR-009**: Everything a graphic conveys MUST also be available as text, and no state may be
  carried by colour alone.
- **FR-010**: The game view MUST NOT supply, change or gate any figure or control of an order
  ticket.
- **FR-011**: The game view MUST NOT prompt a trade, count down, animate a score as a celebration,
  or tie any call to action to a play.
- **FR-012**: The surface MUST say, wherever play detail is shown, that it can be behind the
  broadcast and the market.
- **FR-013**: With the gateway module off, unreachable or absent, the Predict surface MUST be
  exactly what it is without this feature.
- **FR-014**: Sources MUST sit behind one seam, so that a provider with a service agreement can
  replace a public source without a change to any surface.
- **FR-015**: Requests to the public sources MUST be made by the gateway, never by a member's
  device, cached so that the number of upstream requests does not grow with the number of members.
- **FR-016**: The gateway MUST read only games that a member is looking at or that the venue
  reports as in progress, and MUST stop reading a game that has ended.

### Key Entities

- **Game**: one fixture — league, the two teams, start time, the venue's game id.
- **Game reading**: the state of a game as last confirmed — status, score, period, clock,
  possession — with when it was confirmed and by which source.
- **Situation** (football): yard line, down, distance, line to gain, team in possession.
- **Play**: one reported play — period, clock, text, whether it scored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member on a live game's event page sees the score and clock within 3 seconds of
  the page opening.
- **SC-002**: A score change reported by the source is on screen within 10 seconds.
- **SC-003**: With play-level detail unavailable, the scoreboard still renders for every live
  game, and no screen shows a zero that was not reported.
- **SC-004**: No game state older than its bound is ever drawn as live.
- **SC-005**: Upstream requests per minute are the same with 1 member and with 1,000 members
  viewing the same game.
- **SC-006**: With the module off, no request for game data leaves the app and no element of the
  game view is in the page.

## Assumptions

- The venue's public sports feed and the public scoreboard endpoints stay reachable from the
  gateway. Neither comes with a service agreement; FR-007 and FR-013 are what the surface relies
  on when one stops answering.
- Play-level detail is football first. Other sports get the scoreboard, and their plays as text
  where the source reports them.
- Polygon only, as Predict is.
