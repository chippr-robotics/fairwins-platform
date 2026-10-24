# Feature Specification: Funding Pools on the Receive View

**Feature Branch**: `103-funding-pools`

**Created**: 2026-09-02

**Status**: Draft

**Input**: User description: "Add a new spec-driven feature to the payments/receive view with e2e
testing and an actor/critic review of the visuals. We need a function that allows a group of users
to pool funds and distribute them. This is very similar to the wager pools without any wager
necessary: one user starts a pool and invites others, they contribute, the user closes the pool and
the funds go to them in the happy path. In the unhappy path the funds are returned to all users.
Add a pool option on the receive view: reuse wager pools; a user creates a pool with a stated
purpose and goal; members can see a progress bar towards the goal; a shared activity feed lets
everyone see who has contributed; the organizer can send a single link (4-word phrase) where the
context and goal are clear; the organizer can close the pool at any time, whether the goal is fully
met or not; add a refund option the organizer or a majority of participants can trigger, with a
progress/status bar; add a "my pools" bottom sheet similar to the my wagers bottom sheet."

## Overview

Today the **Request** mode of the Payments home (the receive side of Pay / Request / Wager) builds a
one-time payment request: one payer, one amount, one QR. A member who wants to collect a group gift,
split a deposit, or fund a shared expense has nothing: they send the same request to ten people and
reconcile by hand, with no shared picture of who has paid and no way to hand the money back if the
plan falls through.

This feature adds a **Pool** option to that same Request surface. A member (the **organizer**)
opens a pool with a stated **purpose** ("Dana's surprise party") and a **goal** amount in the
platform's stablecoin. The organizer shares one link — or the four ordinary words behind it — and
anyone who opens it sees the purpose, the goal, the live progress and who has already chipped in.
Contributors put in whatever amount they choose. When the organizer is ready they **close** the
pool and the whole pot lands in their account, goal met or not. If the plan falls through, the
organizer — or a majority of the contributors — can flip the pool to **refunding**, and every
contributor takes back exactly what they put in.

The design deliberately **reuses the wager-pool machinery** of spec 034: an immutable per-pool
escrow cloned by a factory, the four-word share phrase resolved on-chain, the same sanctions and
membership screening on the real wallet, the same two-deadline timing so a pool that is never
closed can never trap funds, and the same "…WithSig" relayer readiness baked into the clone. What
is removed is the wager: there is no payout matrix, no vote on an outcome, no winner. What is
added is a variable contribution, a goal, a purpose, an organizer close, and a majority-triggered
refund.

### Terminology

- **Organizer** — the member who creates the pool. The only party who can close it.
- **Contributor** — a member who has put value into the pool (the organizer may contribute too).
- **Purpose** — a short, public, plain-language line the organizer writes at creation.
- **Goal** — the target amount. Informational: contributions are accepted past it, and closing
  does not require it.
- **Closing** — the organizer collects the pot. Terminal.
- **Refunding** — the pot is returned; each contributor collects their own contribution. Terminal.
- **Share phrase** — four words that identify the pool, rendered in the member's chosen language.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start a pool from the Request view (Priority: P1)

An organizer switches the Request view from **Direct** to **Pool**, writes the purpose, enters the goal, picks
how long contributions stay open, and creates the pool. They immediately get the share link, the
four words and a QR, and can open the pool page.

**Why this priority**: Nothing else exists without a pool. This is the receive-side entry the
feature request names.

**Independent Test**: Create a pool from the Request view and confirm the on-chain pool records the
organizer, purpose, goal and deadlines, and that the share view shows the phrase and the link.

**Acceptance Scenarios**:

1. **Given** a connected member on the Request view, **When** they choose Pool, enter a purpose,
   a goal above zero and a contribution window, and confirm, **Then** a pool exists whose organizer
   is that member, whose purpose and goal match what was typed, and the share view shows a
   four-word phrase, a link and a QR.
2. **Given** the Pool form, **When** the purpose is empty, the goal is zero, or the wallet is
   disconnected, **Then** the create action is unavailable and the form says why.
3. **Given** a created pool, **When** the organizer taps "Open my pool", **Then** they land on the
   pool page showing the purpose, the goal, a zero-progress bar and an empty activity feed that
   says what to do next.
4. **Given** a disconnected visitor on the Request view, **When** they choose Pool, **Then** the
   form is visible but the primary action offers to connect.

---

### User Story 2 - Contribute through the shared link (Priority: P1)

A contributor opens the organizer's link (or types the four words), sees the purpose, goal and
progress, chooses an amount and contributes. The progress bar and the activity feed update for
everyone.

**Why this priority**: A pool with no contributors is a request nobody answered. This is the
money-in path and the reason the link must carry its context.

**Independent Test**: Open a pool by link and by phrase as a second account, contribute, and
confirm the pool's raised total and the contributor's recorded amount on-chain, and that the
feed lists the contribution.

**Acceptance Scenarios**:

1. **Given** a pool link, **When** a member opens it, **Then** the page shows the purpose, the goal,
   the amount raised so far as a progress bar with a percentage, the number of contributors, the
   time left to contribute, and an amount control.
2. **Given** four words typed into the app's phrase lookup, **When** they resolve to a funding
   pool, **Then** the member lands on that pool page; **When** they resolve to nothing, **Then**
   the member is told the words match no pool.
3. **Given** an open pool, **When** a member contributes an amount above zero, **Then** the raised
   total increases by exactly that amount, the contributor count increases only on their first
   contribution, and the activity feed shows their entry (address, alias, amount, time) to every
   viewer.
4. **Given** an open pool, **When** the same member contributes a second time, **Then** their
   recorded contribution is the sum and the feed shows both entries.
5. **Given** a pool whose contribution window has passed, or that is closed or refunding, **When**
   a member opens it, **Then** the contribute control is absent and the page states the reason.
6. **Given** a pool on a network where the member's wallet is not connected to that network,
   **When** they try to contribute, **Then** they are asked to switch networks and no transaction
   is sent.

---

### User Story 3 - Organizer closes the pool and collects (Priority: P1)

The organizer closes the pool at any time while it is open; the full pot is paid to the organizer
in the same action, goal met or not.

**Why this priority**: This is the happy-path exit named in the request. Without it the pool is an
escrow with no purpose.

**Independent Test**: With two contributions in place, close as the organizer and confirm the
organizer's balance rose by the pot and the pool balance is zero; confirm a non-organizer cannot
close.

**Acceptance Scenarios**:

1. **Given** an open pool with contributions, **When** the organizer confirms "Close & collect",
   **Then** the pot transfers to the organizer, the pool shows as Closed with the final amount, and
   the feed records the close.
2. **Given** an open pool below its goal, **When** the organizer closes, **Then** it closes exactly
   as in scenario 1 — the goal never blocks closing.
3. **Given** a contributor who is not the organizer, **When** they view the pool, **Then** no close
   control is offered, and an attempt to close is refused.
4. **Given** a closed or refunding pool, **When** anyone tries to close or contribute, **Then** the
   action is refused and the page reflects the terminal state.
5. **Given** the confirm step, **When** it renders, **Then** it names the exact amount, says it goes
   to the organizer's own account, and states that closing is final.

---

### User Story 4 - Refund by the organizer or a majority (Priority: P2)

The organizer can hand everything back at any time. Independently, contributors can vote to
refund; when more than half of the contributors have voted, the pool flips to refunding. In either
case each contributor collects their own contribution back. The pool page shows a refund status
bar: votes so far, votes needed, and — once refunding — who has collected.

**Why this priority**: The unhappy path is what makes contributing safe, but it is exercised only
after a pool exists and has money in it.

**Independent Test**: With three contributors, cast two refund votes and confirm the pool is
refunding after the second; collect as each contributor and confirm each balance is restored;
separately confirm an organizer refund works from an open pool, that a non-contributor cannot
vote, and that nobody can collect twice.

**Acceptance Scenarios**:

1. **Given** an open pool, **When** the organizer confirms "Refund everyone", **Then** the pool is
   refunding and every contributor can collect their contribution.
2. **Given** an open pool with N contributors, **When** contributors vote to refund, **Then** the
   status bar shows votes / needed, where needed is the smallest number greater than N/2, and the
   pool becomes refunding the moment votes reach it.
3. **Given** a refunding pool, **When** a contributor collects, **Then** they receive exactly what
   they contributed, once; a second collect is refused; a non-contributor has nothing to collect.
4. **Given** a member who has not contributed, **When** they view an open pool, **Then** no vote
   control is offered and a vote attempt is refused.
5. **Given** a member who already voted, **When** they view the pool, **Then** their vote is shown
   as cast and cannot be cast again.
6. **Given** a refunding pool, **When** anyone views it, **Then** the status bar shows how many
   contributors have collected out of how many, and the organizer's own uncollected contribution
   (if any) is listed like everyone else's.

---

### User Story 5 - Never-stranded: the deadline refund (Priority: P2)

If the organizer never closes, the pool cannot hold funds forever. After the settlement deadline,
anyone can mark the pool refunding and contributors collect as in Story 4.

**Why this priority**: A funds-never-stuck guarantee is a constitution-level property, but it is
the fallback of a fallback.

**Independent Test**: Advance time past the settlement deadline on an open pool, trigger the
deadline path as an unrelated account, and confirm contributors can collect.

**Acceptance Scenarios**:

1. **Given** an open pool past its settlement deadline, **When** anyone triggers the deadline
   check, **Then** the pool is refunding.
2. **Given** an open pool before its settlement deadline, **When** someone triggers the deadline
   check, **Then** it is refused and the pool stays open.
3. **Given** a pool whose contribution window has passed but whose settlement deadline has not,
   **When** the organizer views it, **Then** closing is still offered, contributing is not, and the
   page says when the refund fallback becomes available.

---

### User Story 6 - My Pools bottom sheet (Priority: P2)

From the Pool view, a member opens **My Pools**: a bottom sheet listing the pools they organized
and the pools they contributed to, with status, progress and the one action that matters for each
(collect, close, vote, share), grouped into active and finished.

**Why this priority**: Members must be able to find a pool again without the link; the request
names this surface explicitly.

**Independent Test**: Create one pool and contribute to another on this device; open My Pools and
confirm both are listed with the correct role, status and progress; close one and confirm it moves
to finished.

**Acceptance Scenarios**:

1. **Given** a member with organized and contributed pools, **When** they open My Pools, **Then**
   each pool appears once with purpose, role (Organizer / Contributor), status, raised-of-goal, and
   opens the pool page when tapped.
2. **Given** a member with no pools, **When** they open My Pools, **Then** the sheet says so and
   points at creating one or opening a link.
3. **Given** a pool that has been closed or fully refunded, **When** My Pools renders, **Then** it
   is under Finished, not Active.
4. **Given** a refunding pool where the member still has an uncollected contribution, **When** My
   Pools renders, **Then** the row offers "Collect refund" directly.
5. **Given** the sheet on a phone, **When** it opens, **Then** it fits the viewport, is dismissible
   by the close control, backdrop and Escape, and traps focus while open.

---

### Edge Cases

- A pool with zero contributions is closed: it closes with nothing to transfer, and the page says
  so honestly rather than announcing a payout.
- Contributions past the goal: accepted; the bar reads 100% with the raised amount shown above the
  goal, and the page says the goal is met.
- The organizer contributes to their own pool: they are a contributor for counting, voting and
  refunds like anyone else.
- A refund vote count is reached, then more members would have joined: irrelevant — a refunding
  pool accepts no contributions.
- A refund vote is cast, then the organizer closes before the majority is reached: the close
  stands; the vote never took effect. The organizer's right to close at any time is the stated
  rule, and the confirm copy for a vote says so.
- The four words are in a different language than the organizer used: the words render in the
  reader's language and resolve to the same pool, because the identity is the index tuple.
- The words are mistyped or match a wager pool rather than a funding pool: the lookup says which
  kind it found, or that it found nothing; it never opens the wrong pool type silently.
- The network is unreachable when the page loads: the page states that it could not read the
  pool and offers a retry; it never renders zero raised as if that were a fact.
- The activity feed cannot be read (an endpoint that refuses log queries): the totals still render
  from state reads and the feed says it could not load, with retry.
- The member is on the wrong network for the pool in the link: the page names the pool's network
  and offers to switch before any control is enabled.
- The member is operating as a vault or other acting account: contribution and close follow that
  account's submit rail; a rail that cannot sign for that account refuses with the reason (spec 088
  pattern), never silently signing with the personal wallet.
- Someone sends value to the pool address directly, outside the contribute action: it is not a
  contribution, is not refundable, and is not counted; the page shows only recorded contributions.

## Requirements *(mandatory)*

### Functional Requirements

**Creating a pool**

- **FR-001**: The Request view MUST offer a Pool option alongside the one-time request, on the
  same surface and with the same visual chrome, without changing the one-time request flow.
- **FR-002**: A member MUST be able to create a pool by providing a purpose (1–200 characters,
  plain text), a goal amount greater than zero in the platform stablecoin, and a contribution
  window from a bounded set of choices.
- **FR-003**: The purpose and goal MUST be recorded with the pool so that anyone opening the link
  sees them without any off-chain lookup. The purpose is public; the form MUST say so.
- **FR-004**: Every pool MUST carry two absolute deadlines: contributions close (within 30 days of
  creation) and settlement (within 180 days of creation, strictly after contributions close),
  mirroring the wager-pool bounds so the two pool kinds behave alike.
- **FR-005**: Every pool MUST be assigned a unique four-word share phrase on creation, resolvable
  back to the pool in every supported language, distinct from wager-pool phrases.
- **FR-006**: The creator MUST be screened (sanctions; membership where the network requires it)
  on their real wallet before a pool exists, exactly as wager pools screen creators.

**Contributing**

- **FR-007**: Any screened member MUST be able to contribute any amount above zero while the pool
  is open and before contributions close, any number of times; contributions accumulate per
  address.
- **FR-008**: The pool MUST record, per contributor, the total contributed, and MUST record the
  number of distinct contributors.
- **FR-009**: Every contribution MUST be visible to every viewer as an activity entry showing the
  contributor, the amount and when, in order. Closing, refund votes, the refunding transition and
  refund collections MUST appear in the same feed.
- **FR-010**: The pool page MUST show progress toward the goal as a bar with an accessible
  percentage, the raised amount, the goal, the contributor count and the time remaining, and MUST
  state plainly when the goal has been met or exceeded.
- **FR-011**: Contributions MUST be refused, with a stated reason, once the contribution window has
  passed or the pool is closed or refunding.

**Closing**

- **FR-012**: Only the organizer MUST be able to close the pool, at any time while it is open —
  before or after contributions close, up to the settlement deadline — regardless of whether the
  goal is met.
- **FR-013**: Closing MUST transfer the entire pot to the organizer's own account in the same
  action and MUST be final: no further contributions, votes, or refunds are possible.
- **FR-014**: The close confirmation MUST show the exact amount, the destination (the organizer's
  account) and that the action is final, before anything is signed.

**Refunding**

- **FR-015**: The organizer MUST be able to switch an open pool to refunding at any time.
- **FR-016**: Each contributor MUST be able to cast one refund vote per pool while it is open. The
  pool MUST switch to refunding as soon as more than half of the distinct contributors have
  voted (needed = ⌊N/2⌋ + 1). Non-contributors MUST NOT be able to vote.
- **FR-017**: Once refunding, each contributor MUST be able to collect exactly their recorded
  contribution, once. Refunds are collected, never pushed, so a large contributor set can never
  block the others.
- **FR-018**: The pool page MUST show a refund status bar: while open, votes cast of votes needed;
  while refunding, contributors collected of contributors total; and the member's own standing
  (voted / not yet, collected / not yet).
- **FR-019**: After the settlement deadline, anyone MUST be able to switch a still-open pool to
  refunding, so funds are never stranded by an absent organizer.

**Sharing and finding**

- **FR-020**: The organizer MUST be able to share one link that opens the pool page directly, and
  the same page MUST be reachable by typing the four words into the app's existing phrase lookup.
  The link, the words and a QR of the link MUST all be offered from the share view and the pool
  page.
- **FR-021**: The phrase lookup MUST distinguish a funding pool from a wager pool sharing the same
  entry point, and MUST report "no pool" for words that resolve to neither.
- **FR-022**: A My Pools bottom sheet MUST list the member's organized and contributed pools for
  the active network, grouped Active / Finished, each with purpose, role, status, progress and its
  next action, and MUST show an honest empty state.
- **FR-023**: Pools a member organized or contributed to on this device MUST be findable in My
  Pools even where no indexer exists for the network (device-recorded addresses with on-chain
  reads), matching how wager pools are found.

**Honesty, scope and safety**

- **FR-024**: Every state shown (raised, contributors, votes, collected) MUST come from the chain;
  an unreadable pool MUST render as unreadable with a retry, never as zeros.
- **FR-025**: Pool data MUST be scoped to the active network; a link for another network MUST name
  it and offer a switch rather than reading the wrong chain.
- **FR-026**: The pool escrow MUST be reachable only through contribute (in), close (out to the
  organizer) and collect-refund (out to each contributor). No other party and no admin MUST be
  able to move pool funds.
- **FR-027**: Every organizer and contributor action MUST have a signed-intent twin so a relayer
  can submit it on the member's behalf later, and contribution MUST additionally be expressible as
  a signed stablecoin authorization — baked into the immutable pool so the property cannot be
  added afterwards. The self-submitted path is the primary path in this release.
- **FR-028**: The visual surfaces (Pool form, share view, pool page, refund status bar, My Pools
  sheet) MUST be reviewed through the actor–critic screenshot loop in both themes and both
  viewports before ship, with findings and fixes recorded.
- **FR-029**: End-to-end coverage MUST include no-chain flows (form validation, share view shape,
  phrase parsing, empty My Pools, degraded reads) and on-chain flows (create → contribute → close;
  organizer refund; majority refund; deadline refund) with assertions judged by chain state.

### Key Entities

- **Funding Pool**: an isolated escrow with organizer, purpose, goal, token, contributions-close
  time, settlement deadline, state (Open / Closed / Refunding), raised total, contributor count,
  refund-vote count, and per-contributor contributed / voted / collected records.
- **Contribution**: an amount moved from a contributor into a pool at a time; accumulates per
  contributor; the unit of the activity feed and of refunds.
- **Share Phrase**: the four-word identity of a pool (a language-independent index tuple rendered
  in the member's language) and the link built from it.
- **My Pools Item**: a pool as seen by one member — role, status bucket, progress, next action —
  assembled from on-chain reads and device-recorded addresses.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can go from the Request view to a shareable pool link in under 90 seconds
  with no address or amount arithmetic entered by hand.
- **SC-002**: A contributor opening the link sees the purpose, goal and live progress before any
  wallet action, and can contribute in three taps or fewer once connected.
- **SC-003**: 100% of value that enters a pool leaves it only to the organizer (close) or to the
  contributor who put it in (refund); property tests over random contribute / vote / close /
  refund sequences find no other path.
- **SC-004**: No pool can hold funds past its settlement deadline without every contributor
  being able to collect a refund.
- **SC-005**: Every member-facing pool surface passes automated accessibility checks at
  WCAG 2.1 AA in both themes and at 390 px and 1280 px widths, and the actor–critic loop ends on a
  round with zero findings.
- **SC-006**: The e2e coverage matrix carries a row for this feature with on-chain coverage for
  every money-moving flow, and the fast tier covers every non-chain flow at both viewport
  profiles.

## Assumptions

- **Stablecoin only.** Pools escrow the network's allow-listed stablecoin (USDC where it exists,
  the local payment token on Mordor/localhost), as wager pools do. Multi-asset pools are out of
  scope.
- **Reuse means the wager-pool architecture, not the wager-pool contract.** The live `WagerPool`
  template is fixed to equal buy-ins and an approved payout matrix; the funding pool is a sibling
  clone template behind its own factory, sharing the factory pattern, compliance hooks, phrase
  gateway, timing bounds and relayer twins. Storage of the live wager factory is not touched.
- **Majority is by contributor count**, not by amount, per the request ("a majority of
  participants"). The trade-off (amount-weighted resists many-small-address griefing; count-based
  matches the plain meaning and keeps a whale from forcing a refund alone) is recorded in
  research; screening on every contributor bounds the griefing surface and the organizer can
  close at any time.
- **Overfunding is allowed.** The goal is a target for the group, not a cap.
- **Purpose is public and on-chain.** The form says so; members are told not to write private
  details.
- **The organizer's payout goes to the organizer's own address.** No "pay to" parameter: the
  simplest safe surface, and the organizer can move funds afterwards with Pay.
- **Settlement deadline defaults** to 30 days after contributions close, from a short set of
  contribution-window choices, so the form stays one screen; advanced timing reuses the wager
  timeline only if a later spec asks for it.
- **Relayed (gasless) submission ships later.** Contracts are relayer-ready (FR-027); the release
  ships self-submit and the passkey account rail. The relay gateway action table is untouched.
- **Indexing** is not required: totals are state reads and the feed is the pool's own event log.
  A subgraph entity is a follow-up where The Graph is available (Polygon).
- **Launch order** follows wager pools: Mordor first, then Polygon; localhost carries it for e2e.
- Nicknames shown beside addresses in the feed are the spec-034 client-side aliases, never
  on-chain.
