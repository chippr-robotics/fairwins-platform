# Feature Specification: ZK-Wager Pools

**Feature Branch**: `claude/wager-pool-group-gateway-u4g0zq`

**Created**: 2026-06-27

**Status**: Draft

**Input**: User description: "A new wager management flow that allows larger groups while staying simple to share among members. Pools are discovered and joined with a four-word phrase built from the BIP-39 wordlist, with a word-list language selector in My Account. Members get anonymous two-word nicknames decoupled from their wallet. Resolution is by anonymous m-of-n consensus. Launched from a new quick-action button. The privacy mechanics may later be reused elsewhere in the app."

## Overview

FairWins today supports one-to-one wagers escrowed and resolved through the
`WagerRegistry`. This feature adds **group wager pools**: a creator opens a pool,
many members buy in, and the group reaches an outcome together — while sharing
nothing more complicated than four ordinary words and never exposing which
on-chain wallet cast which vote.

The guiding product principle is **"Web2 friction, Web3 sovereignty"**: members
keep self-custody of their funds and identity, but never have to copy a contract
address, manage a native gas token, or read a hex string to participate.

This ships as a **parallel system** to the existing `WagerRegistry` (a separate
group-pool surface), with shared compliance and membership interfaces so it can
converge with the wider wager ecosystem later. The anonymous-identity and
nickname layer is designed as a **reusable module** that could improve privacy
for existing one-to-one wagers in a future feature (out of scope here).

## Redesign addendum (round 7): address-based pools, Semaphore removed

**Supersedes the anonymity requirements below.** After testers rejected the
private per-member "claim code" (a Semaphore nullifier the winner had to hand the
creator, not derivable from public data — see implementation-notes round 6), the
feature was pivoted (confirmed with the user) to **drop pool anonymity entirely**.
The `Semaphore V4` / Groth16 / in-browser-WASM stack is **removed from both the
pool and the factory**; membership, voting, and claims are now by **public wallet
address**. The contracts were renamed `ZKWagerPool → WagerPool` /
`ZKWagerPoolFactory → WagerPoolFactory` (interfaces `IWagerPool` /
`IWagerPoolFactory`); deployment keys `zkWagerPoolFactory → wagerPoolFactory`,
`zkWagerPoolFactoryImpl → wagerPoolFactoryImpl` (`poolImpl` unchanged). The rest of
this document is retained for history; where it conflicts with this addendum, the
addendum governs.

### Requirements superseded (restated address-based)

- **FR-010 (vote unlinkability) — SUPERSEDED.** Votes are **not** unlinkable; a
  member `approve(proposalId)`s the current proposal (the id is bound, so a revision cannot retarget it — #1667) with their **real wallet** (`msg.sender`,
  or the recovered EOA on a `…WithSig` relay), and the `Approved(proposalId, member)`
  event records that address. There is no wallet↔identity boundary to protect and no
  "relayed path breaks the link" property.
- **FR-011 / FR-012 (nickname from a public identity commitment) — SUPERSEDED.** The
  two-word nickname is now derived deterministically from the member's **public
  wallet address** (still client-side display only, never on-chain — FR-009 stands).
- **FR-013 ("anonymous fraction-of-joined" resolution) — SUPERSEDED as to
  anonymity.** The fraction-of-joined threshold semantics are **retained** (denominator
  = joined count frozen at close; approvals required = `ceil(frozenDenominator *
  thresholdBips / 10000)`, min 1), but approvals are plain, address-attributed on-chain
  votes — nothing anonymous.
- **FR-014 (one vote per outcome) — RETAINED, address-based.** Enforced per
  `(proposalId, member address)` via `approvedBy[pid][member]`; a repeat approval
  reverts. No nullifier.
- **FR-015 (Semaphore-proof anonymous vote) — SUPERSEDED.** A vote is a plain
  transaction from a joined member address (membership checked via `hasJoined[member]`);
  there is no zero-knowledge proof and the "voter identity is anonymous" clause no
  longer holds. The approved outcome remains public.
- **FR-017 / FR-018 (payout keyed by anonymous in-pool identity, claimed by proof)
  — SUPERSEDED.** The payout matrix is `PayoutEntry{ address winner, uint256 amount }`
  keyed by the **winner's public address** — the address is the claim code, derivable
  by every party straight from the public roster with no off-chain secret exchange. A
  winner `claim(entries, index, recipient)`s by being `entries[index].winner`; funds go
  to any `recipient` they choose. Claims are tracked **per row index**
  (`claimedIndex[index]`), not per address, so a matrix listing the same winner in
  multiple rows is fully claimable and never strands escrow (security fix; see plan
  Constitution addendum + tasks Phase 8). The matrix preimage must hash to the locked
  outcome and its amounts must sum to the escrow.
- **FR-021d (anonymity must not bypass compliance) — MOOT.** With no anonymization
  step, sanctions + `POOL_PARTICIPANT_ROLE` membership are simply enforced on the acting
  wallet at create/join (FR-021/FR-021a/FR-021b/FR-021c unchanged; `screeningRequired`
  gate stands).
- **FR-002a (anonymity-set capacity) — RETAINED as a plain member cap.** The
  ~1,000-member cap (`MAX_MEMBERS_CAP`) remains, but its rationale is no longer a fixed
  anonymity set — there is no per-proof verification cost to hold constant.
- **Privacy-boundary language throughout (Overview, Assumptions "Privacy boundary
  (honest scope)", the two 2026-06-27-analyze clarifications on vote unlinkability, and
  SC-004 / SC-012 / SC-013) — SUPERSEDED.** Pools make no anonymity claim; membership
  and governance footprint are fully public on-chain, exactly like 1v1 wagers.

### Retained / newly reaffirmed

- **Configurable timing, matching WagerRegistry.** Replacing the old `joinDeadline` +
  relative resolution window, pools now carry **two absolute `uint64` deadlines** —
  `acceptDeadline` (joining/acceptance closes) and `resolveDeadline` (resolution must
  complete by). The factory validates them with `_checkDeadlines` mirroring
  `WagerRegistry`: `acceptDeadline ∈ (now, now + 30 days]`; `resolveDeadline ∈
  (acceptDeadline, now + 180 days]`. This makes acceptance/close/resolution times
  configurable exactly as they are for 1v1/oracle wagers (explicit user requirement)
  and fixes the resolution-window drift of the round-6 design. After `resolveDeadline`
  with no locked outcome, the pool is refund-only (FR-019 stands).
- **Mordor/ETC is now IN launch scope.** Removing Semaphore removes the only reason ETC
  was deferred (no more self-deploying the anonymity primitive); the contracts compile
  paris/shanghai-safe. Launch sequence is **Mordor (ETC testnet) → Polygon mainnet** — no Amoy
  (supersedes the Polygon/Amoy-only launch in Assumptions "Network").
- **Relayer-ready (spec 035/036 alignment).** A reusable base
  `contracts/upgradeable/SignerIntentBase.sol` (EIP-712 + ERC-7201-namespaced,
  single-use replay nonce, `_verifyIntent`) backs a `…WithSig` twin for every
  actor-attributed action — `approveWithSig` / `claimWithSig` / `proposeOutcomeWithSig`
  / `closeJoiningWithSig` / `cancelWithSig` / `refundWithSig` — authorizing the recovered
  EOA signer instead of `msg.sender`, so a relayer can submit on a member's behalf. The
  money-in join keeps its gasless form `joinWithAuthorization` (EIP-3009). Self-submit
  entrypoints remain the primary path; the twins are additive and, because clones are
  immutable, are baked into the template at deploy time.

## Clarifications

### Session 2026-06-27

- Q: Is the resolution threshold an absolute approval count or a fraction, and measured against what? → A: A **fraction of the members who actually joined** (denominator = the joined-participant count captured when resolution opens), not an absolute count and not a fraction of maximum slots.
- Q: When does joining close and the threshold denominator freeze? → A: When the pool **fills to max OR the creator explicitly closes it OR a creator-set join deadline passes** (whichever comes first); joins after close are rejected and the pool enters its resolution phase.
- Q: What is the maximum group size per pool? → A: A protocol cap of **~1,000 members per pool** (fixed anonymity-set capacity); the creator's chosen max members must not exceed it.
- Q: How are payout recipients designated, and how do winners claim while staying anonymous? → A: The payout outcome assigns shares to **anonymous in-pool identities/nicknames**; a winner proves ownership of a winning identity and is paid to **any address they choose**, so payout never links back to their join wallet.

### Session 2026-06-27 (analyze remediation)

- Q: Are nicknames computed from the member's secret or from public data, and are they written on-chain? → A: Nicknames are derived from the member's **public identity commitment** (so any member can render them for leaderboards) and are **client-side display only — never emitted or stored on-chain**.
- Q: What exactly is decoupled from the wallet on-chain, given the direct (non-relayed) join is a wallet transaction? → A: **Votes** are unlinkable to the wallet on-chain (Semaphore). On the **direct join path**, an observer can associate the joining wallet with its commitment/nickname (this is the already-disclosed "pool membership is visible" boundary). The **relayed/gasless path (P2)** additionally breaks the wallet↔commitment link. Full nickname/payout unlinkability is therefore a **relayed-path property**.
- Q: May a pool run with sanctions screening disabled? → A: No on any value-bearing network. A pool MUST be deployed with a configured sanctions guard and MUST reject create/join if screening cannot be performed (no silent bypass). Disabling is permitted **only on local/dev/test networks**.
- Q: Which membership budget do pools consume? → A: A **dedicated `POOL_PARTICIPANT_ROLE`** with its own tier limits, separate from `WAGER_PARTICIPANT_ROLE`, so pool activity is gated and tuned independently.
- Q: Are vote choices private? → A: No — the **approved outcome (vote choice) is public** on-chain; only the **voter's identity** is anonymous.
- Q: Does launch target Ethereum Classic? → A: Launch targets **Polygon/Amoy**; ETC/Mordor (technically feasible) is a **later increment**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create and join a group pool with four words (Priority: P1)

A creator starts a group wager pool from a new quick-action button, sets the
buy-in amount and group size, and receives a memorable **four-word phrase**
(e.g. `crystal-orbit-harbor-violet`) to share. Friends open FairWins, type the
four words, see the pool details (buy-in, members joined, slots remaining), and
join by paying the buy-in. On joining, each member is shown a stable, friendly
**two-word nickname** (e.g. "Prismatic Fox") that represents them inside that
pool without revealing their wallet. The group then reaches an outcome by
anonymous **m-of-n consensus**: enough members independently agree on how the
pot is split, the pool locks that result, and winners claim their share.

**Why this priority**: This is the core product — a shareable, larger-group
wager whose participants and votes are unlinkable to wallet addresses. It is the
minimum that delivers the headline value ("larger groups, simple to share,
private") and is independently demonstrable end to end.

**Independent Test**: Create a pool, share the four words to a second device,
join from it, have a quorum agree on a payout split, lock the result, and claim
winnings — all without sharing a contract address and without any participant's
vote being attributable to their wallet.

**Acceptance Scenarios**:

1. **Given** a creator on the dashboard, **When** they use the new pool
   quick-action and set buy-in and maximum members, **Then** the system creates
   an isolated pool and returns a unique four-word phrase that maps to it.
2. **Given** a valid four-word phrase, **When** a participant enters it, **Then**
   the pool's buy-in, current member count, and remaining slots are displayed
   before they commit funds.
3. **Given** a participant viewing a pool with open slots, **When** they join and
   pay the buy-in, **Then** their stake is escrowed, the member count increments,
   and they are assigned a deterministic two-word nickname stable for that pool.
4. **Given** a participant attempting to join a full pool, **When** they submit,
   **Then** the join is rejected and they are told the pool is full.
5. **Given** a joined member, **When** they vote on a payout outcome, **Then**
   their vote counts toward consensus exactly once and cannot be linked to their
   wallet address.
6. **Given** a member who has already voted on an outcome, **When** they attempt
   to vote again on the same outcome, **Then** the second vote is rejected.
7. **Given** a pool where an m-of-n majority has agreed on the same payout
   outcome, **When** the threshold is reached, **Then** the pool locks that
   outcome and no further votes change the result.
8. **Given** a locked, resolved pool, **When** a member entitled to a payout
   claims, **Then** they receive their share and cannot claim twice.

---

### User Story 2 - Choose a word-list language in My Account (Priority: P1)

A member opens **My Account** and selects their preferred **word-list language**
(for example English, Spanish, Japanese, French) from a language selector. The
four-word pool phrases and the join field then read in their chosen language,
because the same underlying pool can be expressed in any supported language's
standard wordlist.

**Why this priority**: The four-word gateway is the primary onboarding surface;
international members must be able to read and type phrases in their own
language for the gateway to be usable. It is small but tightly coupled to the P1
gateway.

**Independent Test**: Change the word-list language in My Account, create or open
a pool, and confirm the four-word phrase renders in the selected language and
that entering the phrase in that language resolves to the correct pool.

**Acceptance Scenarios**:

1. **Given** the My Account settings, **When** a member opens word-list
   preferences, **Then** they can choose from the supported languages and the
   choice persists for their account.
2. **Given** a member with a selected language, **When** a pool phrase is shown,
   **Then** the four words are drawn from that language's wordlist.
3. **Given** a phrase generated in one language, **When** it identifies a pool,
   **Then** the same pool is resolvable regardless of which member's language is
   active (the phrase identifies the pool, not the language).
4. **Given** no explicit selection, **When** a member first uses the gateway,
   **Then** a sensible default language is applied.

---

### User Story 3 - Gasless join without a native gas token (Priority: P2)

A member joins a pool and pays the buy-in **without ever holding the network's
native gas token**. They approve the buy-in with a single off-chain signature,
and the transaction is submitted and paid for on their behalf. From the member's
perspective, joining is one tap and one signature.

**Why this priority**: Removing the native-gas-token hurdle is essential to the
"Web2 friction" promise and meaningfully widens who can participate, but the pool
is already viable (P1) with members paying their own gas. It layers on top of P1.

**Independent Test**: From a wallet holding only the buy-in currency (no native
gas token), join a pool with a single signature and confirm the stake is
escrowed and membership recorded, with the member paying no native gas.

**Acceptance Scenarios**:

1. **Given** a member with sufficient buy-in currency but no native gas token,
   **When** they join via the gasless flow, **Then** the buy-in is authorized and
   pulled in a single confirmed transaction and the member pays no native gas.
2. **Given** a signed gasless join request, **When** the relaying service is
   temporarily unavailable, **Then** the member is informed and no funds are
   moved until the request succeeds.
3. **Given** a gasless join request, **When** its authorization signature has
   expired, **Then** the join is rejected and the member is prompted to re-sign.
4. **Given** a replayed or duplicate gasless request, **When** it is submitted
   again, **Then** it does not result in a second buy-in or double charge.

---

### User Story 4 - Live unresolved leaderboard for multi-round formats (Priority: P3)

For tournaments, multi-round games, or elimination brackets, the creator runs a
visual dashboard where they update scores or eliminate players using the
**two-word nicknames**. All members watch the standings change in near real time
without sending any transaction or revealing their wallet, until the format
concludes and the group resolves the final payout on-chain (per User Story 1).

**Why this priority**: It enriches the experience for structured competitions and
showcases the nickname layer, but simple pools resolve fine without it. It is the
most independent and least critical slice.

**Independent Test**: In an active pool, have the creator update scores and
eliminate a player from the dashboard, and confirm every member sees the updated
standings by nickname in near real time with no member transaction required.

**Acceptance Scenarios**:

1. **Given** an active pool, **When** the creator updates a score or eliminates a
   player, **Then** members see the revised standings (by nickname) without
   sending a transaction.
2. **Given** live standings, **When** a member views the leaderboard, **Then**
   players are identified only by two-word nickname, never by wallet address.
3. **Given** the leaderboard reflects an interim, non-final state, **When** it is
   displayed, **Then** the UI clearly marks it as unresolved/off-chain and not a
   settled on-chain outcome.

---

### Edge Cases

- **Phrase collision**: Two pools must never share the same four-word phrase at
  the same time; the system must guarantee uniqueness when generating phrases.
- **Invalid / mistyped phrase**: Entering words not in the wordlist, the wrong
  word count, or a phrase that maps to no pool must produce a clear "not found"
  message, not a confusing error.
- **Stale phrase**: Opening the phrase for a pool that is already full, resolved,
  or cancelled must surface that state rather than offering to join.
- **Under-quorum pool**: A pool that never reaches its consensus threshold (too
  few members vote) needs a defined outcome — e.g. a timeout that allows members
  to recover their buy-in.
- **Contested proposal**: If members withhold approval from the creator's
  proposed outcome and the approval threshold is never reached, the pool remains
  unresolved until the creator revises to an outcome the group will approve to
  threshold, or the timeout/refund path triggers.
- **Creator abandonment**: A pool whose creator disappears (P3 leaderboard never
  finalized) must still allow the group to resolve or recover funds.
- **Nickname collision**: Two members deriving the same two-word nickname within
  one pool should be disambiguated so standings remain unambiguous.
- **Lost identity secret**: A member who loses the local secret behind their
  anonymous identity may be unable to vote; the consequences (and any recovery)
  must be made clear.
- **Late join during resolution**: Once joining has closed (pool full,
  creator-closed, or join deadline passed), any further join attempt MUST be
  rejected; resolution operates on the frozen member set.
- **Refund/cancellation**: A pool cancelled before it fills must return every
  member's buy-in.

## Requirements *(mandatory)*

### Functional Requirements

#### Group pools & the four-word gateway

- **FR-001**: The system MUST let a member create a group wager pool by
  specifying at least a buy-in amount, a buy-in currency, a maximum number of
  members, a **join deadline**, and the consensus threshold required to resolve,
  expressed as a **fraction/percentage of the members who have joined** (not an
  absolute count).
- **FR-002**: Each pool MUST have **isolated state** so that one pool's data and
  funds cannot be affected by another pool, and so total on-chain footprint stays
  bounded regardless of how many pools exist.
- **FR-002a**: The protocol MUST enforce a maximum of **~1,000 members per pool**
  (a fixed anonymity-set capacity); a creator's chosen maximum members MUST NOT
  exceed this cap. Per-proof verification cost MUST remain constant regardless of
  how many members (up to the cap) have joined.
- **FR-003**: On creation, the system MUST generate a **unique four-word phrase**
  drawn from the BIP-39 wordlist that maps to exactly one pool, with guaranteed
  uniqueness among active pools.
- **FR-004**: A member MUST be able to discover and load a pool by entering its
  four-word phrase, with no need to handle a contract address.
- **FR-005**: Before committing funds, a joining member MUST be shown the pool's
  buy-in amount, currency, current member count, and remaining slots.
- **FR-006**: The system MUST let a member join an open pool by paying the buy-in,
  escrowing that stake until the pool resolves, refunds, or is cancelled.
- **FR-007**: The system MUST reject joins to a pool that is full, resolved, or
  cancelled, with a clear reason.
- **FR-007a**: A pool's joining phase MUST close — freezing the joined-member
  count used as the resolution denominator (FR-013) — when the pool **fills to its
  maximum members**, the **creator explicitly closes it**, or the **join deadline
  passes**, whichever occurs first. After joining closes, further joins MUST be
  rejected and the pool enters its resolution phase.
- **FR-008**: The new pool flow MUST be launchable from a **new quick-action
  button** on the dashboard alongside the existing quick actions.

#### Anonymous identity & nicknames

- **FR-009**: When a member joins, the system MUST assign them a **stable two-word
  nickname** that is consistent for the duration of that pool. The nickname is a
  **client-side display label only — it MUST NOT be emitted to, or stored on, the
  chain**.
- **FR-010**: A member's **votes** MUST NOT be linkable to their wallet address by
  other members or observers of on-chain data (enforced by the anonymous-proof
  mechanism). For the nickname/in-pool identity, the unlinkability boundary is the
  join path: on the **direct (member-paid) join** an observer may associate the
  joining wallet with its in-pool identity (the same "pool membership is visible"
  boundary stated in Assumptions); the **relayed/gasless path (P2)** additionally
  breaks the wallet↔in-pool-identity link. No nickname is ever derived from, or
  stored alongside, a wallet address.
- **FR-011**: The nickname MUST be derived deterministically from the member's
  **public identity commitment** so that **any** member can reproduce it (e.g. to
  render a leaderboard), and it is stable for that member in that pool.
- **FR-012**: Nicknames MUST be unique-enough within a pool that standings and
  leaderboards are unambiguous; collisions within a pool MUST be disambiguated
  (e.g. a short commitment-derived suffix).

#### Resolution by anonymous consensus

- **FR-013**: Each pool MUST support resolution by an **anonymous fraction-of-joined
  approval threshold** (colloquially "m-of-n"): the threshold is a configured
  **fraction of the members who have joined** — the denominator is the
  joined-participant count captured when resolution opens — and at least that
  fraction of members must independently approve the same payout outcome for it to
  take effect. (E.g. a 60% threshold in a pool with 10 joined members requires 6
  approvals.)
- **FR-014**: Each member MUST be able to vote on a payout outcome **exactly once**
  per outcome; repeat votes MUST be rejected (no double-voting).
- **FR-015**: A member's vote MUST be verifiable as coming from a legitimate pool
  member without revealing which member or which wallet cast it. The **vote choice
  (the approved outcome) is public** on-chain; only the **voter's identity** is
  anonymous.
- **FR-016**: When the consensus threshold is reached for an outcome, the pool
  MUST lock that outcome as final and prevent further changes to the result.
- **FR-017**: After resolution, a member entitled to a payout MUST be able to
  claim their share by **proving ownership of a winning in-pool identity**, and be
  paid to **any address they choose** (which need not be their join wallet). Each
  winning share MUST be claimable at most once. The payout MUST NOT link to the
  member's **join wallet** (the recipient is freely chosen and, on the relayed
  path, the wallet↔identity link is broken). Note: v1 MAY reveal **which in-pool
  identity** won (not which wallet); fully hiding the winning identity at claim time
  is a possible future enhancement requiring a custom proof circuit — the exact
  claim construction is finalized in the plan (design spike).
- **FR-018**: The payout outcome MUST encode how the escrowed pot is divided among
  recipients **identified by their anonymous in-pool identity/nickname** (not by
  wallet address), and claims MUST be validated against the locked outcome.
- **FR-019**: The system MUST define a fallback for pools that never reach
  consensus within a bounded time, allowing members to recover their buy-in
  (refund/timeout path) so funds are never permanently stuck.
- **FR-020**: The **pool creator is the sole proposer** of the payout outcome.
  The group resolves by members anonymously **approving** that single proposed
  outcome; when approvals reach the consensus threshold (m-of-n), the outcome
  locks (per FR-016). Competing member-submitted proposals are NOT supported.
- **FR-020a**: If a proposed outcome has not yet locked, the creator MAY revise
  and re-propose; revising resets the approval tally for that pool so members
  approve the current proposal, never a superseded one.
- **FR-020b**: If the creator's proposal never reaches the approval threshold
  within the resolution window, the timeout/refund path (FR-019) applies so funds
  are recoverable; the creator MUST NOT be able to force a payout without member
  approval reaching the threshold.

#### Compliance, membership & funds safety

- **FR-021**: Pool participation MUST enforce the platform's compliance posture
  **at full parity with one-to-one wagers**: both sanctions screening and
  membership gating are paramount and MUST apply. Specifically:
  - **FR-021a**: Every joining wallet MUST pass sanctions screening before its
    buy-in is accepted; a screened-out wallet cannot join and no funds move. A pool
    MUST be deployed with a **configured sanctions guard** and MUST **reject
    create/join if screening cannot be performed** (no silent bypass). Disabling
    screening is permitted **only on local/dev/test networks**, never on a network
    holding real value.
  - **FR-021b**: Pool participation MUST be gated by the member's membership
    tier/limits using the same `MembershipManager` mechanism as `WagerRegistry`,
    via a **dedicated `POOL_PARTICIPANT_ROLE`** with its own tier limits (separate
    from `WAGER_PARTICIPANT_ROLE`) so pool activity is gated and tuned
    independently of one-to-one wagers.
  - **FR-021c**: The creator MUST pass the same sanctions and membership checks at
    pool creation.
  - **FR-021d**: These checks are performed against the **real wallet at
    join/creation time** (before the member's in-pool identity is anonymized).
    Anonymity protects a member's votes, nickname, and standing from other members
    and on-chain observers — it MUST NOT be used to bypass sanctions or membership
    controls. Even in the gasless/relayer flow (P2), the relayer MUST NOT submit a
    join for a wallet that has not passed these checks.
- **FR-022**: Escrowed funds MUST only ever be released via a resolved payout
  claim or a refund/cancellation path; there MUST be no path for the creator or
  any party to unilaterally withdraw other members' stakes.
- **FR-023**: A pool cancelled before it fills (or otherwise voided) MUST refund
  every member's buy-in in full.
- **FR-024**: The buy-in currency for pools is USDC (the platform's stable buy-in
  currency); support for other allowlisted currencies is out of scope for this
  feature unless later specified.

#### Gasless participation (P2)

- **FR-025**: The system MUST let a member authorize and pay their buy-in with a
  single off-chain signature, such that they need not hold the network's native
  gas token to join.
- **FR-026**: Gasless join requests MUST be single-use and resistant to replay, so
  a member is never charged twice for one join.
- **FR-027**: An expired or malformed gasless authorization MUST be rejected
  cleanly and the member prompted to retry, with no partial fund movement.
- **FR-028**: If the gas-relaying service is unavailable, the member MUST be
  informed and no funds MUST move until the request is successfully processed.

#### Live leaderboards (P3)

- **FR-029**: For multi-round/elimination formats, the creator MUST be able to
  update scores and eliminate players, identified by two-word nickname, without
  requiring members to send transactions.
- **FR-030**: Members MUST be able to watch live standings update in near real
  time, with players shown only by nickname.
- **FR-031**: Interim, off-chain standings MUST be visually distinguished from a
  final, settled on-chain outcome so members are never misled about finality.

#### Indexing & data availability

- **FR-032**: Because pools are created dynamically, the system MUST index each
  new pool's activity (joins, allocations, nickname references, and final
  payouts) automatically once the pool is created, without manual reconfiguration
  per pool.
- **FR-033**: Pool data presented to members MUST be scoped to the active network
  and MUST NOT leak across testnet/mainnet boundaries.

### Key Entities *(include if data involved)*

- **Wager Pool**: An isolated group wager. Attributes: buy-in amount and currency,
  maximum members, current member count, join deadline, consensus threshold (as a
  fraction of joined members), the frozen joined-member denominator once joining
  closes, lifecycle state (joining-open / joining-closed (resolving) / resolved /
  cancelled), creation time, escrowed balance, and the locked payout outcome once
  resolved. Has exactly one four-word phrase while active.
- **Four-Word Phrase**: A human-readable identifier drawn from a BIP-39 wordlist
  that maps one-to-one to an active pool. Language-independent in identity; can be
  rendered in any supported language's wordlist.
- **Pool Member**: A participant who has paid the buy-in. Holds an anonymous
  in-pool identity and a derived two-word nickname; entitled to vote once per
  outcome and to claim any payout owed.
- **Anonymous Identity**: Local, member-held identity material that lets a member
  prove pool membership and cast an unlinkable vote, and from which their nickname
  is deterministically derived.
- **Two-Word Nickname**: A stable, friendly label representing a member within one
  pool, derived deterministically from the member's **public identity commitment**
  (reproducible by any member for leaderboards). **Client-side display only — never
  emitted to or stored on-chain**; not derived from or stored with a wallet address.
- **Payout Outcome (Proposal)**: A proposed division of the escrowed pot among
  recipients **identified by anonymous in-pool identity/nickname** (not wallet
  address), identified by a fixed reference that members approve; becomes the
  locked result when it reaches consensus. Each winning share is claimed by
  proving ownership of the corresponding in-pool identity and paid to any address.
- **Vote**: A single, anonymous, member-authenticated endorsement of a payout
  outcome, counted at most once per member per outcome.
- **Word-List Language Preference**: A per-member account setting selecting which
  language's wordlist is used to render and read four-word phrases.
- **Leaderboard State (P3)**: Off-chain, creator-maintained interim standings for
  multi-round formats, expressed by nickname and explicitly non-final.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A creator can open a new pool and obtain its shareable four-word
  phrase in under 60 seconds from the dashboard.
- **SC-002**: A new participant who is given only the four words can find and join
  the correct pool in under 2 minutes, without ever seeing or entering a contract
  address.
- **SC-003**: 100% of generated four-word phrases are unique among concurrently
  active pools (zero collisions).
- **SC-004**: No member's **vote** can be linked to their wallet address using
  on-chain data alone (verified by review/audit). The nickname/in-pool identity is
  likewise unlinkable to the wallet **on the relayed/gasless path**; on the direct
  join path, only pool membership is observable (per the privacy boundary), never
  the vote.
- **SC-005**: Each member can vote at most once per payout outcome; 0% of pools
  resolve on duplicated or double-counted votes.
- **SC-006**: A pool with a quorum of agreeing members resolves and locks its
  outcome, and entitled members can claim their full share with no double-claims.
- **SC-007**: Pools that fail to reach consensus within the defined window always
  return every member's buy-in; 0% of buy-ins become permanently unrecoverable.
- **SC-008**: At least 4 word-list languages are selectable in My Account, and a
  phrase generated under one member's language resolves to the same pool for a
  member using a different language.
- **SC-009 (P2)**: A member holding only the buy-in currency and no native gas
  token can join a pool successfully with a single signature.
- **SC-010 (P3)**: When the creator updates standings, every viewing member sees
  the change within a few seconds and never sends a transaction to do so.
- **SC-011**: On-chain storage per pool stays bounded — the cost of operating the
  system does not grow without limit as the number of pools increases.
- **SC-012**: A single pool supports up to ~1,000 members, and the cost to verify
  a member's vote does not increase as more members join (constant per-proof cost).
- **SC-013**: A winner can receive their payout at an address unlinked to their
  join wallet; on-chain data alone does not reveal which **join wallet** a payout
  belongs to (the recipient is freely chosen; on the relayed path the
  wallet↔identity link is also broken). v1 may reveal which in-pool identity won,
  but never the wallet behind it.

## Assumptions

- **Parallel to existing wagers**: Pools ship as a separate group-pool surface
  alongside `WagerRegistry`, not as a modification of the one-to-one wager
  contract. Shared membership/compliance interfaces are designed for future
  convergence but the two systems operate independently for now. This is an
  intentional, documented exception to the usual "route escrow through
  `wagerRegistry`" guidance and will be reflected in `CLAUDE.md`.
- **Reusable privacy module (future)**: The anonymous-identity + nickname layer is
  designed to be reusable so a later feature could bring it to one-to-one wagers;
  that integration is explicitly out of scope here.
- **Buy-in currency**: USDC is the buy-in currency for v1 pools.
- **Phrase source**: The four words come from the standard BIP-39 wordlist, which
  has equivalent lists across supported languages — this is what enables the
  language selector.
- **Default language**: English is the default word-list language when a member
  has not chosen one.
- **Identity custody**: Members are responsible for their local anonymous-identity
  material (consistent with self-custody); recovery of a lost identity secret is
  out of scope unless raised in clarification.
- **Quorum/timeout configured at creation**: The consensus threshold and the
  resolution timeout window are set when the pool is created.
- **Network**: Pools target the platform's standard L2 deployment networks, with
  data strictly scoped per active network. **Launch targets Polygon and Amoy**
  (canonical Semaphore deployments); Ethereum Classic / Mordor support is
  technically feasible but ships as a **later increment** (it requires
  self-deploying the anonymity primitive).
- **Compliance is paramount and enforced on the wallet**: Sanctions screening and
  membership gating apply to every joining wallet (and the creator) at full parity
  with one-to-one wagers, checked against the real wallet at join/creation time.
- **Privacy boundary (honest scope)**: Anonymity decouples a member's *votes,
  nickname, and standing* from their wallet within the pool — it does NOT
  necessarily hide that a given wallet joined a given pool, since the join is
  screened against the real wallet. The privacy claim is about the governance
  footprint (who voted how), not about concealing pool membership from compliance.
- **Gasless is additive (P2)**: P1 pools are fully usable with members paying their
  own gas; the gasless relayer is a P2 enhancement, not a P1 dependency.
- **Leaderboard authority (P3)**: The pool creator is the off-chain authority for
  interim standings; standings are advisory until the group resolves the final
  payout on-chain.

## Out of Scope

- Bringing anonymous identity/nicknames to existing one-to-one `WagerRegistry`
  wagers (designed-for, not implemented).
- Buy-in currencies other than USDC.
- Automated/oracle-based pool resolution (pools resolve by member consensus, not
  Polymarket/Chainlink/UMA oracles).
- Recovery of a lost local anonymous-identity secret.
- On-chain enforcement of interim leaderboard standings (P3 standings are
  off-chain and advisory).

## Dependencies

- The platform's existing membership and compliance/sanctions screening surfaces
  (FR-021): pool join and creation reuse these at full parity with one-to-one
  wagers, enforced on the real wallet at join/creation time.
- The dashboard quick-action surface (for the new pool button).
- The My Account settings surface (for the word-list language selector).
- Per-network address/config sync used by the frontend (pool data must come from
  generated sync artifacts, never hardcoded).
