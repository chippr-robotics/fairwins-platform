# Feature Specification: Predict — live markets, market pages and an amount-first order ticket

**Feature Branch**: `114-predict-live-markets`

**Created**: 2026-11-26

**Status**: Draft

**Input**: User description: "Update the Predict experience to be as quick to navigate as a
dedicated prediction-market site: a member should reach useful market information fast and place
orders responsibly. Markets should be real time, and the data behind them robust enough to make
informed decisions on. Order handling should happen behind the scenes." (issue #1747)

## Relationship to existing specs

- **Spec 057 (Predict — Polymarket)** stands for custody (FR-004), fee disclosure (FR-003,
  FR-010–FR-012), eligibility (FR-017, FR-018, FR-021), passkey signing (FR-019) and the
  never-stranded rule (FR-015). This spec **replaces its presentation**: browse (057 FR-001), the
  ticket (057 FR-002, FR-008) and the positions and open-orders views (057 FR-006, FR-009).
- **Spec 007 (compliance gating)** decides who may reach the app at all. Nothing here relaxes it.
- **Spec 082 (Perps)** and the Trade swap view are not changed. FR-030 asks only that the live
  feed this spec introduces be usable by them later.
- **Specs 090/091 (brand)**, **094 (end-to-end policy)** and **081 (navigation)** bind the
  interface as they bind every other surface.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Find a market quickly and see what it says now (Priority: P1)

A member opens Predict and sees markets grouped the way people think about them: by topic, and by
event, so that the four possible outcomes of one central-bank meeting sit on one card rather than
being four unrelated rows. They filter by category, search by words, and sort by what is most
traded, newest or closing soonest. Prices on the cards change while they look.

**Why this priority**: Today's list is one page of questions sorted by volume with a single price
each. A member cannot find a topic, cannot see that markets belong together and cannot tell
whether a price is from now or from when the page loaded. Nothing else in this feature matters to
someone who cannot find the market.

**Independent Test**: Open Predict, choose a category, and confirm the list narrows to it; search
a phrase and confirm matching events appear; confirm a multi-market event renders as one card
with one row per market; change a price at the source and confirm the card follows without a
reload.

**Acceptance Scenarios**:

1. **Given** Predict is open, **When** the member selects a category, **Then** only events in
   that category are listed and the selection is reflected in the address so it can be shared or
   returned to.
2. **Given** an event contains several markets, **When** it is listed, **Then** it appears once,
   with its most likely markets as rows, each showing its current probability, and a count of
   the rest.
3. **Given** a listed price changes at the venue, **When** the member is looking at the list,
   **Then** the card shows the new price without the member acting, and the change is perceivable
   without relying on colour alone.
4. **Given** the member types in the search field, **When** they pause, **Then** matching events
   across all categories are listed, and an empty result says so and offers to clear the search.

---

### User Story 2 - Understand one market before acting (Priority: P1)

A member opens an event and gets a page, with its own address, that answers: what are the
outcomes and their probabilities now, how did they move over the last hour, day, week and month,
how much has been traded, when does it close, and exactly what decides the result and who says
so. For the outcome they are considering they can see how much is offered at which prices.

**Why this priority**: A decision needs context, and today the detail view is a modal with a
question and a price. Volume, closing date and resolution rules are what distinguish an
informative market from a thin or ambiguous one.

**Independent Test**: Open a multi-market event by its address in a fresh session and confirm
the outcomes, a probability chart with selectable ranges, volume, closing time, the resolution
source and a depth view all render; confirm a closed or resolved market says so and offers no
order.

**Acceptance Scenarios**:

1. **Given** an event address, **When** it is opened directly, **Then** the event page renders
   without first visiting the list.
2. **Given** an event page, **When** the member selects a time range, **Then** the chart shows
   each outcome's probability over that range and extends as new prices arrive.
3. **Given** an event whose markets are independent of one another, **When** it is shown,
   **Then** their probabilities are not presented as shares of one whole.
4. **Given** a market has closed or resolved, **When** its page is shown, **Then** the state and,
   if resolved, the winning outcome are stated, and no order control is offered.

---

### User Story 3 - Know how far a price can be trusted (Priority: P1)

Every price a member sees carries one of three plain states: live; delayed, with how old it is;
or last known. The member never has to wonder whether the number moved or the app stopped
listening. When the app cannot vouch for a price it will not let the member build an order on it,
and says what it is waiting for.

**Why this priority**: Real-time data is only worth having if its failures are visible. A frozen
price that looks current is worse than an honest delay, because the member acts on it.

**Independent Test**: With prices flowing, confirm the live state; interrupt the live source and
confirm prices are marked delayed with an age that grows, then marked last-known; confirm the
order ticket refuses to quote in either non-live state and names the reason; restore the source
and confirm recovery without a reload.

**Acceptance Scenarios**:

1. **Given** the live source stops, **When** the configured bound passes, **Then** every affected
   price is visibly marked delayed with its age, and no price keeps its live presentation.
2. **Given** a price is not live, **When** the member opens the ticket for it, **Then** no
   average price or payout is computed from it, and the ticket states that it is waiting for a
   current price.
3. **Given** the live source is unavailable from the start, **When** Predict opens, **Then** the
   surface still works from the venue's ordinary data, marked delayed, and nothing is shown as
   zero or blank that is merely unknown.

---

### User Story 4 - Say how much, see what it means, then sign (Priority: P2)

A member enters the amount they want to spend, or for a sale the amount they want to sell. The
ticket tells them, from what is actually on offer: the average price they would pay, how many
shares that buys, what they receive if they are right, the most they can lose, how much of the
available depth their order would take, and every fee as its own line. If something would stop
the order, they learn it before signing anything. A member who wants a specific price can set
one and leave the order resting.

**Why this priority**: The current ticket asks for a share count at a fixed price and leaves the
arithmetic, and the risk, to the member. It follows the first three stories because it depends
on prices that can be trusted.

**Independent Test**: Enter an amount on a liquid outcome and confirm average price, shares,
payout, maximum loss and itemised fees appear and change with the amount; enter an amount larger
than the visible depth and confirm the ticket says so; confirm the review step repeats the
figures and names the price limit the signature will carry.

**Acceptance Scenarios**:

1. **Given** a live price, **When** the member enters an amount, **Then** the ticket shows
   average price, shares, payout if right, maximum loss and each fee, computed from the depth on
   offer, before any signature is requested.
2. **Given** the order would consume a large share of the visible depth, **When** the figures are
   shown, **Then** the ticket states how far the order moves the price.
3. **Given** the outcome's price is near certainty, **When** the figures are shown, **Then** the
   ticket states the amount at risk beside the amount to be gained in plain currency.
4. **Given** the member proceeds, **When** the review step is shown, **Then** it states the worst
   price the signature allows and that the order cannot execute beyond it.
5. **Given** the price moves beyond the member's tolerance between review and signature,
   **When** they attempt to sign, **Then** the ticket shows the new figures and asks again.
6. **Given** a condition that would prevent the order is known, **When** the member reaches
   review, **Then** it is stated there and no signature is requested.

---

### User Story 5 - Follow an order after signing (Priority: P2)

After signing, the member sees where the order is: sent, resting, partly filled, matched, settled
on chain, or ended, and why. Their positions and open orders update on their own. If they close
the app and return, the order's progress is still there.

**Why this priority**: Order handling is meant to be invisible when it works and legible when it
does not. Today there is a refresh button.

**Independent Test**: Place a marketable order and a resting order; confirm each advances through
its states without a manual refresh; reload mid-way and confirm the state is restored; cancel
the resting order and confirm it ends as cancelled.

**Acceptance Scenarios**:

1. **Given** an order has been signed, **When** its status changes, **Then** the tracker shows
   the new state without the member acting.
2. **Given** an order was sent and no confirmation has arrived, **When** it is shown, **Then** it
   is presented as unconfirmed, not as failed, and the member is told not to submit it again.
3. **Given** an order is matched but not yet settled, **When** it is shown, **Then** the two are
   distinguished.
4. **Given** the member reloads, **When** Predict opens, **Then** orders still in progress are
   shown with their current state.

---

### User Story 6 - Set limits on oneself (Priority: P3)

A member can set a spending limit for a day or a week, or pause Predict for a period. The ticket
shows how much of the limit an order would use and declines to proceed past it. Making a limit
stricter takes effect at once; relaxing one takes effect only after a waiting period.

**Why this priority**: It is the part of "responsibly" the member chooses for themselves. It
follows the ticket because that is where it acts.

**Independent Test**: Set a daily limit, place orders up to it, and confirm the next order is
declined at review with the limit named; attempt to raise the limit and confirm the old limit
still applies until the waiting period ends.

**Acceptance Scenarios**:

1. **Given** a limit is set, **When** an order would exceed it, **Then** the ticket says so at
   review and requests no signature.
2. **Given** a limit is set, **When** the member lowers it, **Then** the lower limit applies
   immediately.
3. **Given** a limit is set, **When** the member raises or removes it, **Then** the existing
   limit continues to apply until the stated waiting period has passed, and the date it changes
   is shown.

### Edge Cases

- A market's minimum price step changes while a ticket is open: the figures are recomputed and
  the member is asked to review again.
- An outcome has no offers on one side: the ticket says there is nothing to buy (or sell) at any
  price, and does not show zero as a price.
- An event has more markets than fit a card or a chart: the most likely are shown and the rest
  are reachable; the chart never draws so many series that they cannot be told apart.
- Outcome prices of an event do not sum to one: they are shown as they are, never rescaled.
- The live source recovers after a gap: prices return to live and the chart does not draw a
  straight line through the period it did not observe as if it had.
- A member on a chain or in a state where trading is not offered: browsing and market pages
  remain available where they are permitted, with the reason orders are not.
- A very small amount, below the venue's minimum: stated at entry, not at signature.
- The member's device clock is wrong: ages are measured from the feed's own time, not the
  device's.

## Requirements *(mandatory)*

### Functional Requirements

**Finding markets**

- **FR-001**: The list MUST group markets by event and present an event with several markets as
  one item showing its leading markets and their current probabilities.
- **FR-002**: Members MUST be able to filter by category, search by text across categories, and
  sort by at least trading volume, newest and closing soonest.
- **FR-003**: Category, search and sort MUST be reflected in the address so a view can be
  returned to or shared, and each event MUST have its own address.
- **FR-004**: Each listed event MUST show its traded volume and when it closes.

**Understanding a market**

- **FR-005**: An event page MUST show every outcome with its current probability, traded volume,
  closing time, and the venue's stated resolution source and rules.
- **FR-006**: An event page MUST show probability over time for selectable ranges and MUST extend
  the chart as new prices arrive.
- **FR-007**: For a selected outcome, the page MUST show the size on offer at the nearest prices
  on both sides.
- **FR-008**: Markets that are independent of one another MUST NOT be presented as shares of a
  whole, and probabilities MUST NOT be rescaled to sum to one.
- **FR-009**: A closed or resolved market MUST state that, name the winning outcome when known,
  and offer no order control.

**Trusting a price**

- **FR-010**: Every displayed price MUST carry one of three states — live, delayed, last known —
  and the non-live states MUST show the price's age.
- **FR-011**: A price's state MUST be derived from how recently it was confirmed, never from the
  mere presence of a value; a value that has stopped being confirmed MUST leave the live state
  within a bounded time.
- **FR-012**: An unknown value MUST be shown as unknown. It MUST NOT be shown as zero, as blank
  where a number is expected, or as its last value without that being stated.
- **FR-013**: The order ticket MUST NOT compute an average price, shares or payout from a price
  that is not live, and MUST say what it is waiting for.
- **FR-014**: Price changes MUST be perceivable without relying on colour or motion alone, and
  the surface MUST respect a reduced-motion preference.
- **FR-015**: The headline probability shown for an outcome MUST follow the venue's own rule for
  it, so that the app and the venue do not disagree about what a market says.

**Placing an order**

- **FR-016**: The ticket MUST accept an amount to spend (or to sell) as its primary input and
  derive average price and shares from the depth on offer.
- **FR-017**: Before any signature is requested the ticket MUST show: average price, shares,
  payout if the outcome occurs, maximum loss, the share of visible depth the order would take,
  and each fee as its own line per spec 057.
- **FR-018**: The review step MUST state the worst price the signature permits and that the order
  cannot execute beyond it.
- **FR-019**: Members MUST be able to place an order at a price they name, to rest until filled,
  cancelled or expired, and MUST be told that it rests.
- **FR-020**: Any known condition that would prevent the order MUST be surfaced at review, before
  signature.
- **FR-021**: If the figures shown at review are no longer achievable within the member's
  tolerance at the moment of signing, the ticket MUST show the new figures and ask again.
- **FR-022**: The member's wallet MUST remain the only signer of an order. No FairWins-operated
  component may hold a member's key or sign for them.

**Following an order**

- **FR-023**: After signature the surface MUST show the order's progress through distinct states
  that separate sent, resting, partly filled, matched, settled and each way an order can end.
- **FR-024**: An order whose outcome is not yet known MUST be shown as unconfirmed, MUST NOT be
  shown as failed, and the member MUST be told not to resubmit.
- **FR-025**: Positions and open orders MUST update without a manual refresh, and orders in
  progress MUST survive a reload.

**Restraint**

- **FR-026**: Members MUST be able to set a spending limit per period and a pause, and the ticket
  MUST decline at review an order that would exceed a limit.
- **FR-027**: Tightening a limit MUST take effect immediately. Relaxing or removing one MUST take
  effect only after a stated waiting period, and the surface MUST show when.
- **FR-028**: The surface MUST NOT use streaks, leaderboards, countdown pressure, celebratory
  effects on a fill, or defaults that increase the amount at risk. Where the price of an outcome
  is near certainty the ticket MUST state the amount at risk beside the amount to be gained.

**The live feed**

- **FR-029**: Live prices, depth and order progress come from a FairWins-operated market feed
  that MUST be optional: when it is unreachable or cannot vouch for a value, the surface MUST
  continue from the venue's ordinary data, marked delayed, and every order path MUST remain
  available to the member without it.
- **FR-030**: The app's seam to that feed MUST be independent of any one venue or kind of market,
  so that other market surfaces can adopt it without a second implementation.
- **FR-031**: The app MUST hold at most one live connection for market data however many prices
  are on screen, and MUST stop receiving prices for markets the member is no longer viewing.
- **FR-032**: Eligibility checks that depend on where the member is MUST continue to be made from
  the member's device.

**Standing rules**

- **FR-033**: The surface MUST meet WCAG 2.1 AA, at phone and desktop widths, in both themes.
- **FR-034**: Nothing in this feature may alter who may trade, what fees apply, or how they are
  disclosed under specs 007 and 057.

### Key Entities

- **Event**: A question or occasion at a venue that groups one or more markets; has a title,
  category, closing time and traded volume.
- **Market**: One question within an event with two or more outcomes, a resolution source and a
  trading status.
- **Outcome**: One tradable result of a market, with a current price read as a probability.
- **Price reading**: A price, the depth around it, when it was last confirmed, and its trust
  state. Only a live reading may be used to compute an order.
- **Order plan**: What an amount would buy at current depth — average price, shares, worst price,
  fees — as shown to the member before signature.
- **Order progress**: The sequence of states an order has passed through and its current one.
- **Self-limit**: A member's own spending ceiling or pause, with the time a pending relaxation
  takes effect.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From opening Predict, a member can reach the page of a named, currently listed
  event in under 15 seconds using category or search.
- **SC-002**: A price change at the venue on a market the member is viewing is visible in the app
  within 2 seconds for 95% of changes while the live feed is healthy.
- **SC-003**: When the live source stops, 100% of affected prices leave the live state within 10
  seconds, and none is shown as live again until confirmed.
- **SC-004**: In usability testing, 9 of 10 members can state, before signing, how much they
  could lose on the order in front of them.
- **SC-005**: No order is signed whose figures were computed from a non-live price.
- **SC-006**: A member can tell an unconfirmed order from a failed one in testing, and fewer than
  1 in 100 unconfirmed orders are resubmitted.
- **SC-007**: With the live feed switched off entirely, every flow in this spec except real-time
  updating still completes.
- **SC-008**: The app's requests to outside services for market data, per member session on
  Predict, fall compared with the surface it replaces.

## Assumptions

- The venue remains Polymarket on Polygon, as in spec 057. A second venue is a later spec; FR-030
  only keeps the door open.
- The bounds in FR-011 and the waiting period in FR-027 are set in planning. Starting points:
  live within 5 seconds, last-known after 30, and 24 hours to relax a limit.
- Whether self-limits are kept on the member's device or held by FairWins against the member's
  account is decided in clarification. The second is harder to circumvent and is the first
  member-keyed preference FairWins would store.
- A limit binds orders placed through FairWins. A member who goes to the venue directly is not
  bound by it, and the surface says so rather than implying otherwise.
- Chart history comes from the venue's own published price history.
- The order ticket's builder-fee line, rates and caps are unchanged from spec 057.

## Out of scope

- Any change to custody, to contracts, or to who signs.
- Creating, resolving or making markets; combinations of markets; cross-venue comparison.
- Perps and swap surfaces (follow-up specs adopting the feed).
- Price alerts and notifications when the app is closed.
- Commentary, social features and rankings of members.
