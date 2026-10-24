# Feature Specification: ClearPath Standard DAOs & External DAO Connectors

**Feature Branch**: `feat/clearpath-standard-daos-030`

**Created**: 2026-06-24

**Status**: Draft

**Input**: User description: "ClearPath Standard DAOs — the foundation of the ClearPath module, shipped before the futarchy spec (029). Two pillars: (A) members launch native standard (traditional-governance) DAOs — token- or NFT-membership voting, a USDC treasury, propose→vote→timelock→execute, roles/ownership — using OpenZeppelin Governor + Timelock; (B) members register, track, and manage DAOs deployed by other platforms, with an Olympia DAO connector first (OZ Governor on Ethereum Classic), designed against the standard IGovernor interface so it generalizes. Embedded as its own My Account (Account Center) tab, wired into membership, notifications, and sanctions, on new UUPS contracts (OZ 5.4.0) for Mordor + Amoy. No futarchy in this spec."

## Overview

ClearPath is the platform's DAO governance module, embedded as its own tab in the
My Account (Account Center) pages. This spec delivers the **standard
(traditional-governance) DAO foundation** and the ability to **connect to DAOs from
other platforms** — so members get a working DAO home immediately. The advanced
**futarchy** governance mode (LMSR conditional markets + welfare-metric resolution)
is a follow-on (spec 029) layered on top of this foundation.

Two pillars:

- **Native standard DAOs** — a member launches a traditional-governance DAO with
  voting weight from a governance **token** or a **membership NFT**, a **USDC
  treasury**, and a standard proposal lifecycle (propose → vote → timelock/queue →
  execute), plus scoped roles, parameter configuration, and ownership
  transfer/renounce. ClearPath uses **standard, audited governance (OpenZeppelin
  Governor + TimelockController)** rather than a bespoke scheme.
- **External DAO registry + connectors** — a member registers an existing DAO
  deployed elsewhere by its address, ClearPath validates it is a recognized
  governance contract, and then **tracks** its real treasury, proposals, vote
  tallies, and membership, and lets the member take **native governance actions**
  (propose / vote / queue / execute) where the external DAO's own rules authorize
  their wallet. The first connector targets **Olympia DAO** on Ethereum Classic (an
  OpenZeppelin Governor + soulbound-NFT-membership treasury DAO); because it is
  built against the standard **IGovernor** interface, it generalizes to any
  Governor-based DAO. ClearPath takes **no custody or authority** over external
  DAOs — it is a registry, dashboard, and action-router.

Because ClearPath's own standard DAOs are themselves OZ Governor, **the same
governance UI serves both native and external DAOs**, and they appear together in
the member's "My DAOs" list, clearly labeled by type/framework and network-scoped.

Like Token Mint (spec 028), ClearPath lives as **its own tab in the My Account
(Account Center)** pages, is gated by **MembershipManager** tiers, surfaces every
action through the **app-level notification system**, enforces **SanctionsGuard**
non-bypassably on value-moving actions, is **theme-aware** (light/dark) and
accessible, runs entirely within the platform's **no-backend** footprint, and shows
**real on-chain state only** — never mock data.

## Clarifications

### Session 2026-06-24

- Q: For native standard DAOs, what determines voting power? → A: **Both, selectable at creation** — a governance token (`ERC20Votes`, may reuse the spec-028 token factory) or a membership NFT (1 member = 1 vote); the **default presented option is membership-NFT** (mirrors Olympia).
- Q: How are registered external DAOs stored / discovered? → A: A lightweight **on-chain, network-scoped `ExternalDAORegistry`** records `(address, framework, label)` for shared discovery + subgraph indexing (fits the no-backend footprint); ClearPath still holds **no authority** over the external DAO.
- Q: What's in the first external-DAO deliverable — track-only or also management? → A: **Include signed native management actions** (create proposal / vote / queue / execute via the connector, user-signed) **from the start**, alongside read-only tracking — not deferred to a later phase.

### Session 2026-06-24 (expansion — as-built alignment)

- External-first sequencing: OpenZeppelin 5.4.0 `GovernorUpgradeable` transitively uses the Cancun `mcopy` opcode (via `SignatureChecker` → `Bytes.sol`), so **native OZ-Governor DAOs cannot compile/deploy on pre-Cancun ETC/Mordor**. Per the user's decision, the **external-DAO connector ships first** (Mordor + Amoy); **native ClearPath DAOs (US1, US4, US6) are DEFERRED** pending a governance-base choice (OZ Governor on Cancun chains / a custom paris-safe governor / vendor OZ 5.1). The external connector is unaffected — the on-chain `ExternalDAORegistry` imports only the `IGovernor` *interface*, so it is paris-safe; reads/actions go through the `IGovernor` ABI.
- Subgraph-less networks get **limited live on-chain indexing** (a bounded, chunked `eth_getLogs` scan of `ProposalCreated`, enriched with live `state()`/`proposalVotes()`) — the concrete realization of the truthful-fallback requirement, with truthful empty / partial / error states (never fabricated).
- Treasury tracking surfaces the Governor's **timelock AND known extra vaults** (e.g. the real OlympiaTreasury on Mordor) with **native + per-network USDC** balances.
- The proposal builder is a **rich, no-calldata-required** composer (named action types, multiple actions, asset-aware amounts, encoded-call preview, pre-sign guards) over the existing `IGovernor.propose()` — **no new contract**.

### Session 2026-08-30 — Amendment (issue #1268): pillar A ships on Cancun chains

The 2026-06-24 deferral of native standard DAOs is **resolved, not carried forward**. The
maintainer's decision on issue #1268 is: **use the latest in-tree OpenZeppelin Governor
(5.4.0) and drop pre-Cancun chain support for this contract.** The amendment is additive —
every requirement below stands as written except where this block names it.

- Q: Which governance base ships for native DAOs? → A: **The stock OZ 5.4.0 `Governor`**
  (`GovernorSettings` + `GovernorCountingSimple` + `GovernorVotes` +
  `GovernorVotesQuorumFraction` + `GovernorTimelockControl`) with `TimelockController`. Not a
  bespoke paris-safe governor and not a vendored OZ 5.1: a member's DAO must be a contract
  every wallet, explorer, indexer and other DAO tool already understands, and a hand-rolled
  governor would be an unaudited one-off holding a real treasury.
- Q: What happens to ETC 61 and Mordor 63? → A: **They do not get native DAO creation.** The OZ
  Governor closure reaches `utils/Bytes.sol`, which uses the Cancun `mcopy` opcode; no compiler
  flag emulates it. This is an **exclusion by decision, not a deferral** — nothing is pending,
  and the surface must say so honestly rather than implying "coming soon". **Pillar B is
  unaffected**: `ExternalDAORegistry` imports only the `IGovernor` *interface*, stays `paris`,
  and keeps serving every chain unchanged, so an ETC/Mordor member can still register, track and
  govern DAOs — they simply cannot mint a new one on those chains.
- Q: Does FR-018 (upgradeable pattern) apply to the DAOs a member creates? → A: **No — only to
  the factory.** The `StandardDAOFactory` holds state and authority and is UUPS, mirroring
  `WagerPoolFactory` (spec 034). The **created governor, timelock and token are IMMUTABLE**: a
  platform-held upgrade key over a member's governor is a key over their treasury, since the
  timelock's entire guarantee is that only its own governance can move funds. A new template
  ships as a **new factory**, never as a swap under a live DAO. This is the `SafePolicyGuard`
  (spec 043) reasoning applied to governance.
- Q: How is the voting-weight choice of FR-001 realised? → A: **Two modes at creation** — the
  factory deploys a fresh fixed-supply `ERC20Votes` (`StandardDAOToken`), or it accepts an
  **existing `IVotes`** address, which covers both a member's own `ERC20Votes` and an
  `ERC721Votes`/soulbound membership NFT (the Olympia-style 1-member-1-vote source). The factory
  does not itself mint membership NFTs; that remains a separate primitive.
- Q: Does the creation slice ship the administration surfaces of US6? → A: **No.** US6
  (role grants, parameter changes, ownership transfer/renounce as a member-facing screen) stays
  out of this slice. On-chain the created DAO already administers itself — the timelock's admin
  role is the timelock — so US6 is a UI over proposals, not new authority.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Launch a standard DAO (Priority: P1) — *Amendment 2026-08-30: SHIPS on Cancun chains*

> **Deferred (2026-06-24):** native OZ-Governor DAOs can't run on pre-Cancun ETC/Mordor (the `mcopy` blocker). Implement after the external-DAO pillar, once the governance base is chosen. Requirements retained below unchanged.
>
> **Resolved (2026-08-30, issue #1268):** the governance base is the stock OZ 5.4.0 Governor and
> the chain set is **Cancun-capable chains only** — Polygon 137, Ethereum 1, Optimism 10, Base
> 8453, Arbitrum One 42161 and Amoy 80002. **ETC 61 and Mordor 63 are excluded by decision**, not
> deferred: on those chains this surface is absent and says why, while pillar B keeps working.
> The requirements below stand unchanged; the acceptance scenarios are exercised against a real
> deployed governor + timelock in `test/clearpath/StandardDAOFactory.test.js`.

An authorized member creates a native standard DAO, choosing its name, purpose,
voting-weight source (a governance token or a membership NFT), a USDC treasury, and
governance parameters (voting delay/period, quorum, timelock). The transaction is
submitted on-chain and, once confirmed, the DAO appears in the member's "My DAOs"
list with its real deployed governor + treasury.

**Why this priority**: The smallest end-to-end slice that proves the full create →
deploy → list → govern loop against real on-chain state, and the foundation the
proposal lifecycle (US4) and futarchy (spec 029) build on. The MVP.

**Independent Test**: Connect an authorized wallet, create a token-voted standard
DAO, confirm the transaction, and verify the deployed governor + timelock + treasury
exist on-chain and appear in My DAOs — no mock data anywhere.

**Acceptance Scenarios**:

1. **Given** an authorized member, **When** they submit a valid DAO creation (name,
   purpose, voting source, treasury, params), **Then** a governor + timelock + USDC
   treasury are deployed on-chain and the confirmed DAO address is shown.
2. **Given** a creation form, **When** the member picks token-weighted vs
   NFT-membership voting, **Then** the deployed DAO uses exactly that voting source.
3. **Given** a pending creation, **When** it is unconfirmed, **Then** the UI shows
   it pending and does not present the DAO as finalized until the chain confirms.
4. **Given** a wallet below the required membership tier or a sanctioned wallet,
   **When** it attempts to create a DAO, **Then** the action is blocked with a
   surfaced reason (before signing and on-chain).

---

### User Story 2 - Discover, inspect & join DAOs (Priority: P1)

From the My Account → **ClearPath** tab, a member browses DAOs on the active
network (native + external, clearly labeled), opens a DAO's detail view (purpose,
treasury, proposals, members, roles), and joins or follows a DAO they are eligible
for.

**Why this priority**: Establishes the Account Center module home and makes launched
and registered DAOs visible/usable; paired with US1/US3 it yields the complete
"create or add a DAO, find it, engage" loop.

**Independent Test**: After a DAO is created/registered, open the ClearPath tab,
find it in the explorer, open its detail view and confirm the displayed
treasury/members/proposals match real on-chain values, then join/follow it.

**Acceptance Scenarios**:

1. **Given** DAOs exist on the active network, **When** a member opens the ClearPath
   explorer, **Then** each DAO shows name, type/framework (native vs external),
   member/holder count, treasury balance, and active-proposal count from chain/index.
2. **Given** a DAO detail view, **When** a member opens it, **Then** treasury,
   members, proposals, and roles are shown truthfully from chain.
3. **Given** an eligible member, **When** they join/follow a DAO, **Then** it appears
   in their "My DAOs" list (native + external unified, labeled).
4. **Given** the active network, **When** DAOs are listed, **Then** only that
   network's DAOs appear and data never leaks across networks; on a network without
   ClearPath deployed, the feature is disabled with a truthful message.

---

### User Story 3 - Register & track an external DAO (Priority: P1)

A member registers an existing DAO deployed by another platform (e.g. **Olympia
DAO**) by its address; ClearPath validates it is a recognized governance contract,
adds it to the registry with an optional label, and tracks its real treasury,
proposals + vote tallies + states, and membership — read-only.

**Why this priority**: The user emphasized that adding and tracking DAOs from other
platforms is important; this is independently valuable (a multi-DAO dashboard) even
before native creation, and it shares the unified My DAOs surface with US1/US2.

**Independent Test**: Register a real external DAO (Olympia on Mordor) by address,
confirm it is validated and added, and confirm its treasury balance, proposals, and
membership shown match the external DAO's real on-chain state — with a truthful
"unavailable" state if the data source is unreachable, never fabricated rows.

**Acceptance Scenarios**:

1. **Given** the address of a recognized external governance contract, **When** a
   member registers it, **Then** it is validated, added to the network-scoped
   registry with its framework/type and label, and appears in My DAOs / Explorer.
2. **Given** an address that is not a recognized governance contract, **When** a
   member tries to register it, **Then** registration is rejected with a truthful
   reason and nothing is added.
3. **Given** a registered external DAO, **When** its detail view is opened, **Then**
   its treasury, proposals + vote tallies + states, and membership are shown
   truthfully from the external DAO's on-chain state/index.
4. **Given** a network without indexing for the external DAO, **When** its data is
   requested, **Then** ClearPath falls back to on-chain reads or shows a truthful
   "unavailable on this network" state — never fabricated data.

---

### User Story 4 - Run a proposal on a native DAO (Priority: P2) — *Amendment 2026-08-30: on-chain lifecycle proven; UI reuses the external-DAO surfaces*

> **Resolved (2026-08-30, issue #1268):** the full propose → vote → queue → execute lifecycle is
> exercised against a factory-created governor + timelock in
> `test/clearpath/StandardDAOFactory.test.js`, including the two negative cases this story asks
> for (a defeated proposal moves nothing; a passed one executes exactly once). No new UI is
> needed for it: a natively created DAO **is** a stock `IGovernor`, so ClearPath's existing
> `ExternalDaoView` + `ProposalBuilder` serve it byte-identically once it is registered in the
> `ExternalDAORegistry` — which is why the creation flow offers that registration as its next
> step rather than growing a parallel governance surface.

A member of a native standard DAO submits a proposal (a USDC treasury action or a
parameter change), other members vote during the voting period, and after the
timelock the passed proposal is queued and executed.

**Why this priority**: Proposals are the unit of governance; this completes the
native standard-DAO lifecycle on top of US1, and is the standard counterpart the
futarchy spec later swaps the decision mechanism into.

**Independent Test**: Submit a treasury-funding proposal, cast enough votes to reach
quorum and succeed, advance past the timelock, queue and execute it, and confirm the
recipient is funded on-chain; separately, a defeated proposal performs no action.

**Acceptance Scenarios**:

1. **Given** an eligible member, **When** they submit a valid proposal, **Then** it
   is recorded with a voting schedule and its state progresses (pending → active).
2. **Given** an active proposal, **When** members cast votes, **Then** tallies
   update on-chain and the proposal succeeds iff quorum + majority are met.
3. **Given** a succeeded proposal, **When** the timelock elapses and it is queued
   and executed, **Then** the treasury action executes on-chain (recipient funded /
   parameter changed) exactly once.
4. **Given** a defeated or expired proposal, **When** execution is attempted, **Then**
   it is rejected and no treasury action occurs.

---

### User Story 5 - Manage an external DAO (Priority: P2)

For a registered external DAO, where the connected wallet is authorized by the
external DAO's own rules, the member takes native governance actions — create a
proposal, cast a vote, queue, execute — constructed by the connector and signed by
the member; ClearPath holds no authority of its own.

**Why this priority**: "Connect with and manage" the external DAO is the second half
of the external-DAO ask; it depends on registration/tracking (US3) and reuses the
same IGovernor surface as native DAOs (US4).

**Independent Test**: On a registered Olympia DAO, as a wallet holding its
membership NFT, cast a vote on an open proposal through ClearPath and confirm the
vote is recorded on the external DAO; as a wallet without authority, confirm the
action is rejected by the external DAO's own rules.

**Acceptance Scenarios**:

1. **Given** a registered external DAO and an authorized wallet, **When** the member
   casts a vote / creates a proposal / queues / executes through ClearPath, **Then**
   the action is executed on the external DAO's own contract, signed by the member.
2. **Given** a wallet not authorized by the external DAO's rules, **When** it
   attempts such an action, **Then** the external DAO rejects it and the reason is
   surfaced.
3. **Given** an external action that moves value through a ClearPath-mediated path,
   **When** the actor or recipient is sanctioned, **Then** sanctions screening blocks
   it.
4. **Given** a framework ClearPath has no connector for, **When** management is
   requested, **Then** ClearPath tracks read-only and offers a truthful deep-link to
   the external app rather than a broken action.

**Rich proposal builder (expanded)** — the create-proposal surface MUST let a member
compose a proposal without hand-writing calldata:

5. **Given** the proposal builder, **When** a member adds a "Send native" or "Send
   USDC/ERC-20" action with a recipient and a human amount, **Then** the system
   encodes the correct on-chain call (native: value + empty calldata; token: a
   `transfer` call with `value` 0 and the amount scaled by the token's decimals) — the
   member never types hex.
6. **Given** the builder, **When** a member adds multiple actions, **Then** they are
   submitted as one proposal with parallel `targets`/`values`/`calldatas` arrays of
   equal length, and the builder shows a live preview of each encoded call plus the
   exact `targets`/`values`/`calldatas`/`description` (and `descriptionHash`) that will
   be submitted.
7. **Given** an action that would send more than the treasury holds, **When** the
   member reviews it, **Then** a **non-blocking** warning is shown (the proposal can
   still be created; execution would revert if unfunded) — it does not fake success.
8. **Given** invalid input (bad address, unparseable amount, malformed custom
   calldata, empty title/description, or zero actions), **When** the member tries to
   submit, **Then** submit is blocked with a truthful field-level reason.
9. **Given** the connected wallet is not authorized by the DAO's own rules (e.g. below
   the proposer threshold), **When** the member submits, **Then** the DAO's revert
   reason is surfaced — ClearPath does not imply success.

---

### User Story 6 - Administer a DAO: roles, parameters & ownership (Priority: P2) — ⏸️ STILL DEFERRED (UI)

> **Amendment 2026-08-30 (issue #1268):** deferred for a NEW reason. The `mcopy` blocker is gone,
> but this story is a member-facing administration console, and the creation slice deliberately
> does not grow one. On-chain the answer is already in place and is stronger than what this story
> describes: a created DAO's timelock roles are held by its governor, its admin role is the
> timelock itself, and the factory renounced everything — so every role grant, parameter change
> and hand-off is *already* a governance proposal, expressible today through the existing
> proposal builder. What remains is the screen, not the authority.

A native-DAO administrator grants/revokes scoped roles (e.g. proposer, treasurer,
canceller), configures governance parameters, and transfers or renounces
administrative ownership.

**Why this priority**: Delegated least-privilege administration and safe hand-off
are required for real organizations operating a DAO.

**Independent Test**: Grant the proposer role to a second wallet and confirm only it
(and admins) can propose; revoke it and confirm proposing is blocked; transfer
ownership and confirm the prior admin loses authority.

**Acceptance Scenarios**:

1. **Given** a DAO, **When** an admin grants a role, **Then** that address can
   perform exactly the actions the role authorizes and nothing more (on-chain).
2. **Given** a role holder, **When** an admin revokes the role, **Then** the address
   can no longer perform that action.
3. **Given** governance parameters, **When** an admin updates them (within the rules),
   **Then** subsequent proposals use the updated parameters.
4. **Given** ownership transfer/renounce, **When** an admin assigns a new owner or
   renounces, **Then** authority moves accordingly (renounce irreversible, behind a
   clear warning) and unauthorized callers are rejected on-chain.

---

### User Story 7 - Review activity & event history (Priority: P3)

Any user reviewing a DAO (native or external) sees its on-chain governance history —
DAO created/registered, member joined, proposal created, votes, queued, executed —
with type, actor, transaction, and time, filterable by category.

**Why this priority**: An auditable governance trail builds trust but is read-only
and depends on event indexing.

**Independent Test**: Create and execute a proposal, then open the activity history
and confirm both events appear with the correct actor, transaction, and time, and
that category filters narrow the list.

**Acceptance Scenarios**:

1. **Given** a DAO with on-chain actions, **When** the activity view is opened,
   **Then** each event shows type, detail, actor, transaction, and time from indexed
   on-chain data.
2. **Given** the activity view, **When** the user filters by category, **Then** only
   matching events are shown.
3. **Given** a network without indexing, **When** the activity view is opened, **Then**
   it falls back to on-chain reads or is disabled with a truthful message — never
   fabricated events.

---

### User Story 8 - Inspect the contract surface (Priority: P3)

Any user can view a DAO's contract surface: its governor/treasury/voting-token
addresses, framework/type, per-network deployment, and (for native DAOs) metadata;
and can copy addresses or the governor ABI, with explorer deep links.

**Why this priority**: Transparency about the underlying contracts supports trust and
integration, and is read-only.

**Independent Test**: Open a DAO's contract view and confirm the displayed
governor/treasury addresses and framework match the real deployment/registry and
explorer; copy an address/ABI and confirm correctness.

**Acceptance Scenarios**:

1. **Given** a native or external DAO, **When** the contract view is opened, **Then**
   its governor/treasury/token addresses, framework, and explorer links reflect the
   real on-chain/registry state.
2. **Given** the contract view, **When** the user copies an address or ABI, **Then**
   the copied value matches the deployed contract.
3. **Given** an external DAO, **When** the view is shown, **Then** it is clearly
   labeled as externally deployed (ClearPath holds no authority over it).

---

### Edge Cases

- **Invalid DAO/proposal metadata**: empty name/purpose, invalid voting source,
  a funding amount exceeding the treasury, or an invalid recipient are rejected
  before submission.
- **Invalid external address**: registering an EOA, a non-governance contract, or a
  contract on the wrong network is rejected with a truthful reason; nothing is added.
- **Transaction failure / rejection**: a reverted or user-rejected create, register,
  propose, vote, queue, or execute leaves no phantom DAO/proposal in any list.
- **Membership revoked mid-session**: a member whose tier drops below the requirement
  can no longer create/register, reflected on next action.
- **Sanctioned actors**: a sanctioned wallet cannot create a DAO, fund a treasury,
  execute a disbursement, or be a disbursement recipient, in every ClearPath-mediated
  flow.
- **External DAO not authorizing the wallet**: a management action the external DAO's
  rules forbid is rejected by the external DAO; ClearPath surfaces the reason and
  does not imply success.
- **Unsupported external framework**: ClearPath tracks read-only and deep-links to
  the external app rather than offering a broken action.
- **Treasury underfunded for an executed action**: execution that would exceed the
  treasury balance is rejected; an executed proposal cannot overdraw the vault.
- **Network without support / subgraph-less**: the feature self-disables truthfully,
  and tracking falls back to on-chain reads or a truthful "unavailable" state — never
  fabricated rows.
- **Duplicate proposal**: composing an action set + description identical to an
  existing proposal yields the same proposal id; the builder detects this and warns
  ("this exact proposal already exists") instead of paying gas for a guaranteed revert.
- **ERC-20 transfer with a native value**: the builder forces `value` = 0 for token
  transfers so native coin is never stranded in the executor.
- **Description edited after submit**: changing the description string changes its hash
  and thus the proposal id; the stored exact string is reused for queue/execute so the
  ids line up (a near-identical description is a *different* proposal).
- **Proposer below threshold / votes not yet snapshotted**: surfaced pre-sign where the
  threshold is readable; otherwise the DAO's own revert reason is surfaced.

## Requirements *(mandatory)*

### Functional Requirements

**Native standard DAOs (US1/US4)**

- **FR-001**: The system MUST allow an authorized member to create a native standard
  DAO specifying at least name, purpose, a **voting-weight source selectable at
  creation — a governance token (`ERC20Votes`) or a membership NFT (1 member = 1
  vote), defaulting to membership-NFT** — a USDC treasury, and governance parameters
  (voting delay, voting period, quorum, timelock delay), deploying the governance +
  treasury contracts on-chain.
- **FR-002**: A native DAO MUST support a standard proposal lifecycle — submit a
  proposal (a USDC treasury action or a parameter change), vote during the voting
  period, and (after the timelock) queue and execute a passed proposal — with vote
  tallies and proposal state read truthfully from chain.
- **FR-003**: A native DAO's treasury MUST be disbursable only by an executed
  proposal, MUST reject an action that would overdraw it, and MUST execute a passed
  proposal's action **exactly once**.
- **FR-004**: DAO and proposal creation MUST execute as real on-chain transactions
  and MUST NOT present a DAO/proposal as finalized before the chain confirms it. No
  mock-only flow may ship in production paths.

**External DAO registry & connectors (US3/US5)**

- **FR-005**: The system MUST allow a member to register an existing external DAO by
  (network, address, framework/type) with an optional label into a lightweight
  **on-chain, network-scoped registry** (shared discovery + subgraph-indexable), MUST
  validate that the address is a recognized governance contract (e.g. responds to the
  standard IGovernor interface) before adding, and MUST reject unrecognized/invalid
  addresses. The registry grants ClearPath **no authority** over the external DAO.
- **FR-006**: The system MUST track a registered external DAO **read-only** — its
  treasury balance, proposals + vote tallies + proposal states, and membership —
  sourced from the external DAO's on-chain state/indexing, strictly network-scoped
  and truthful.
- **FR-007**: Where the connected wallet is authorized by the external DAO's **own**
  rules, the system MUST allow native governance actions (create proposal, cast
  vote, queue, execute) constructed through a per-framework connector and signed by
  the member; the system MUST take no custody or authority of its own over external
  DAOs and MUST surface the external DAO's rejection reason when an action is not
  authorized.
- **FR-008**: The system MUST ship an **Olympia** connector first, designed against
  the standard IGovernor interface so it generalizes to other Governor-based DAOs;
  for frameworks without a connector, the system MUST track read-only and offer a
  truthful deep-link rather than a broken action.

**Unified discovery & administration (US2/US6/US7/US8)**

- **FR-009**: The system MUST present native and external DAOs together in a member's
  DAO list and an active-network explorer, each clearly labeled by type/framework and
  network-scoped, and MUST let an eligible member join/follow a DAO.
- **FR-010**: A native DAO MUST be administered through scoped, least-privilege roles
  (e.g. proposer, treasurer, canceller, admin); the system MUST allow an admin to
  grant/revoke roles and configure governance parameters, with every role-gated
  action enforced on-chain, and MUST allow ownership transfer and irreversible
  renounce (behind a clear warning).
- **FR-011**: The system MUST present a per-DAO activity/event history (type, detail,
  actor, transaction, time) with category filtering, and a contract surface
  (governor/treasury/token addresses, framework, per-network deployment, explorer
  links, copy address/ABI), sourced from real on-chain/indexed/registry state.

**Platform integration & cross-cutting (parity with spec 028)**

- **FR-012**: ClearPath MUST be presented as **its own section/tab within the My
  Account (Account Center)** pages — not a standalone sub-app and not a top-level app
  navigation tab — consistent with the Token Mint module (spec 028). This spec
  establishes the ClearPath module home.
- **FR-013**: Authorization MUST integrate with the platform's **existing
  membership/access-control system** (MembershipManager tiers/roles) to gate creating
  a native DAO, registering an external DAO, and privileged actions — not a parallel
  permission system.
- **FR-014**: Every user-initiated action (create DAO, register external DAO, join,
  propose, vote, queue, execute, role grant/revoke, ownership transfer) MUST surface
  through the **app-level notification system** with honest submitted/confirmed/failed
  state; passive background data loads MUST use accessible inline status/alerts rather
  than toasts.
- **FR-015**: The platform's **sanctions screening** MUST be enforced non-bypassably
  and fail-closed on every ClearPath-mediated value-moving action (create a DAO, fund
  a treasury, execute a disbursement) and on disbursement recipients, using the same
  sanctions system as the rest of the platform; read-only tracking of external DAOs
  is not gated.
- **FR-016**: ClearPath data MUST be **scoped to the active network** and MUST NOT
  leak across networks; on networks where the feature is not deployed it MUST be
  disabled with a truthful explanation.
- **FR-017**: The feature MUST surface honest transaction state and MUST NOT leave
  phantom DAOs, proposals, or registry entries in any list when a transaction does
  not confirm.
- **FR-018**: The contracts that hold authority/state over the ClearPath system
  (factory, registry, native governance/treasury) MUST follow the project's
  **upgradeable-contract pattern** where they hold state or authority, preserving
  state across logic upgrades, with append-only storage validated by the
  storage-layout gate.
- **FR-019**: The ClearPath UI MUST be **theme-aware** (respecting the app's
  light/dark theme variables) and MUST meet WCAG 2.1 AA, following the token module's
  theming approach.
- **FR-020**: The feature MUST operate within the platform's **no-backend footprint**
  (no app server added); DAO/proposal/member/activity enumeration (native and
  external) MUST use subgraph indexing with an on-chain RPC fallback or a **truthful
  disable** on subgraph-less networks (Mordor/ETC) — it MUST NOT display fabricated
  DAOs, proposals, members, or events.

**Live indexing, treasury & proposal builder (expansion)**

- **FR-021**: On subgraph-less networks the system MUST provide **limited live
  on-chain indexing** of a Governor's proposals — a bounded, chunked scan of
  `ProposalCreated` events enriched with live proposal `state` and vote tallies — and
  MUST present truthful empty / partial (RPC-limited) / error states; it MUST NOT
  fabricate proposals.
- **FR-022**: The system MUST present a tracked DAO's treasury holdings across its
  Governor **timelock and any known extra vault** (e.g. OlympiaTreasury), showing
  **native and per-network USDC** balances read from chain.
- **FR-023**: The proposal builder MUST let a member compose a Governor proposal
  **without hand-writing calldata**: named action types (send native, send a
  USDC/ERC-20 token by address, and a custom-call escape hatch), **multiple actions in
  one proposal**, **asset-aware human amounts** (scaled by the token's decimals), and a
  **live preview** of each encoded call plus the exact `targets`/`values`/`calldatas`/
  `description`/`descriptionHash` that will be submitted.
- **FR-024**: The builder MUST apply **field-level validation** (valid addresses,
  parseable amounts, well-formed custom calldata, non-empty description, at least one
  action) and **pre-sign guards**: a **non-blocking** warning when an action exceeds
  the treasury's balance (the proposal may still be created; execution would revert),
  and surfacing the DAO's **own authorization/threshold revert** rather than implying
  success.
- **FR-025**: The system MUST preserve Governor proposal **correctness invariants**:
  the **exact description string** is reused byte-for-byte across propose → queue →
  execute (so `descriptionHash` matches and the proposal id resolves); ERC-20 transfer
  actions carry **`value` = 0** (the amount is in calldata; the executing
  timelock/treasury holds the funds, not the proposer); `targets`/`values`/`calldatas`
  arrays are equal length and non-empty; and a **duplicate proposal** (identical
  targets/values/calldatas/descriptionHash) is detected and surfaced truthfully
  ("this exact proposal already exists") rather than reverting blindly. Proposal
  building is pure client-side ABI encoding (paris-safe; no Cancun dependency).

### Key Entities *(include if feature involves data)*

- **Standard DAO (native)**: A traditional-governance DAO created through the
  feature. Attributes: name, purpose, voting source (governance token or membership
  NFT), governor + timelock + treasury addresses, governance parameters, network,
  creator/admins.
- **Voting Source**: A governance token (token-weighted) or a membership NFT
  (membership-weighted) that determines voting power for a native DAO.
- **Treasury / Vault**: A native DAO's USDC funds, disbursable only by an executed
  proposal.
- **Proposal**: A funded action (treasury action = amount + recipient, or a
  parameter change) with a standard state lifecycle (pending → active →
  succeeded/defeated → queued → executed/expired) and a voting schedule.
- **Vote**: A member's cast vote on a proposal, weighted by the voting source.
- **Administrative Role**: A scoped authority over a native DAO (e.g. proposer,
  treasurer, canceller, admin), least-privilege, tracked with grant time.
- **External DAO**: A registry entry for a DAO deployed by another platform —
  network, address, framework/type, label, and discovered governor/treasury/token
  references; tracked read-only, managed via the user's own authority.
- **DAO Connector / Adapter**: A per-framework read+act interface (Olympia / OZ
  Governor first) ClearPath uses to read an external DAO's state and construct native
  actions for the user to sign.
- **DAO Registry / List**: The per-network record of native DAOs created and external
  DAOs registered through the feature, used for discovery and a member's DAO list.
- **Governance Activity Event**: An indexed on-chain event (created/registered,
  joined, proposed, voted, queued, executed) powering the activity history.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized member can create a native standard DAO and see it
  confirmed with its real on-chain governor + treasury, end-to-end, in under 3
  minutes on a supported network.
- **SC-002**: 100% of DAOs/proposals/registry entries shown as created/registered in
  the UI correspond to confirmed on-chain state — zero phantom or mock entries appear.
- **SC-003**: A member can register a real external DAO (e.g. Olympia on Mordor) and
  see its actual treasury, proposals, and membership from chain in 100% of supported
  cases; an unrecognized address is rejected, and an unreadable data source yields a
  truthful "unavailable" state — never fabricated rows.
- **SC-004**: Treasury safety holds for native DAOs: only an executed proposal
  disburses funds, the treasury can never overdraw, and a passed proposal executes
  exactly once — verified by tests.
- **SC-005**: No sanctioned address can create a DAO, fund a treasury, execute a
  disbursement, or be a disbursement recipient, in any ClearPath-mediated flow.
- **SC-006**: Authorization holds: only members with the required tier/role can
  create/register/administer, and unauthorized callers are rejected on-chain (not only
  in the UI), verified for both authorized and unauthorized paths.
- **SC-007**: An external management action taken through ClearPath succeeds only when
  the external DAO's own rules authorize the wallet, is signed by the member, and
  leaves ClearPath with no authority over the external DAO — verified against a real
  Governor DAO.
- **SC-008**: ClearPath data never crosses network boundaries: switching networks
  shows only that network's DAOs in 100% of cases, and unsupported networks disable
  the feature with a clear message.
- **SC-009**: Every user-initiated ClearPath action is a real on-chain transaction
  with honest pending/confirmed/failed state surfaced through the app notification
  system — verified by tests covering success and failure paths.
- **SC-010**: DAO/proposal/member/activity data shown matches real on-chain/indexed
  state (no fabricated rows); on networks without indexing the affected view falls
  back to on-chain reads or disables truthfully in 100% of cases.
- **SC-011**: The ClearPath UI renders correctly in light and dark themes and passes
  automated accessibility (axe) checks with no violations.
- **SC-012**: The full automated test suite (contract unit + integration +
  upgrade-lifecycle, subgraph Matchstick, frontend Vitest incl. axe) passes in CI,
  and security static analysis/fuzzing report no new high/critical findings.
- **SC-013**: A member can compose a multi-action Governor proposal (e.g. send native +
  send USDC) entirely through the builder **without writing any calldata**, and the
  encoded `targets`/`values`/`calldatas` exactly match the chosen actions (token amounts
  scaled by the correct decimals; ERC-20 `value` = 0) — verified by tests.
- **SC-014**: On a subgraph-less network, the live indexer shows a DAO's real proposals
  (with live state + tallies) or a truthful empty/partial/error state — never fabricated
  rows — verified against a real Governor DAO.

## Assumptions

- **Governance basis**: Native standard DAOs use **OpenZeppelin Governor +
  TimelockController** with OZ Votes-based voting power — a governance token
  (`ERC20Votes`, which may reuse the spec-028 token factory) or a membership NFT
  (`ERC721Votes`/soulbound), selectable at creation. The default presented option is
  membership-NFT (1 member = 1 vote), mirroring Olympia; token-weighted is the
  alternative. OZ Governor on OZ 5.4.0 / EVM `paris` (ETC/Mordor-compatible) is
  assumed deployable — to be confirmed in planning (OZ ≥ 5.5 needs Cancun `mcopy`).
- **External connector**: The Olympia connector targets the standard OZ **IGovernor**
  interface (`propose`, `castVote`, `state`, `proposalVotes`, `queue`, `execute`) plus
  reading the treasury balance and membership token, so it generalizes to any
  Governor-based DAO. Olympia is OZ Governor v5.1.0 (soulbound NFT = 1 vote) +
  TimelockController + OlympiaTreasury + OlympiaExecutor + SanctionsOracle, deployed on
  ETC mainnet + Mordor (demo_v0.2; github.com/olympiadao). Additional frameworks
  (Aragon/Moloch/Safe) are later connectors.
- **No authority over external DAOs**: "Manage" means ClearPath constructs native
  governance actions the member **signs** with their own wallet, gated by the external
  DAO's own access control; ClearPath holds no keys, roles, or custody, and offers a
  deep-link to the external app as a fallback. A lightweight on-chain registry records
  registered external DAOs (network-scoped, for shared discovery + indexing) but
  grants ClearPath no power over them. **Signed management actions are in scope for
  this spec from the start** (clarified 2026-06-24) — not deferred to a later phase —
  alongside read-only tracking.
- **Reuse of platform infrastructure**: Integrates with the existing
  `MembershipManager` (authorization) and `SanctionsGuard` (screening) and reuses the
  per-network **USDC** as the native treasury asset, `UUPSManaged`,
  `lib/upgradeable.js`, `check:storage-layout`, `sync:frontend-contracts`, the
  subgraph data-source-template pattern, and the app notification/theme systems.
- **On-chain stack & networks**: New upgradeable contracts target OpenZeppelin 5.4.0
  / Solidity ^0.8.24 / EVM `paris`, inherit `UUPSManaged`, use a one-time
  `initialize`, keep storage append-only with a trailing gap (storage-layout gated),
  and deploy to **Mordor (63) + Amoy (80002)** first (Polygon later).
- **Account Center placement**: ClearPath is embedded as a tab in the My Account
  (Account Center) pages exactly like the spec-028 Tokens tab — not a standalone app
  and not a top-level nav item; the old dual-app architecture is not revived.
- **Archived designs are reference only**: `contracts-archive/core/DAOFactory.sol` and
  `docs/archived/` inform the design but are **not** imported or deployed; new active
  contracts are written against current standards. `docs/system-overview/
  governance.md` (which currently states "no DAO") is updated to reflect ClearPath as
  an opt-in module.
- **Sequencing**: This standard-DAO foundation ships first; the **futarchy** governance
  mode (spec 029 — LMSR conditional markets + welfare-metric resolution) is the
  follow-on layered on top. Native standard DAOs being OZ Governor means the same
  governance UI serves native and external DAOs.
- **Indexing dependency**: Discovery, proposal/member lists, and activity history
  depend on subgraph indexing; on subgraph-less networks (Mordor/ETC) they fall back
  to on-chain reads where feasible or disable truthfully — never fabricated
  (Constitution III).
- **External-first sequencing (clarified 2026-06-24)**: native OZ-Governor DAOs are
  blocked on pre-Cancun ETC/Mordor by the OZ-5.4.0 `mcopy` dependency, so US1/US4/US6
  are **deferred**; the external-DAO pillar (US2/US3/US5) ships first on Mordor + Amoy.
  Revisit native DAOs with one of: OZ Governor on Cancun chains, a custom paris-safe
  governor, or a vendored OZ 5.1 Governor.
- **Live indexing**: the subgraph-less proposal fallback is a **bounded, chunked
  `eth_getLogs` scan** of `ProposalCreated` enriched with live `state`/`proposalVotes`;
  it is best-effort (truthful partial/error states) and not a full historical index.
- **Proposal builder**: it is a **pure client-side ABI-encoding layer** over the
  existing `IGovernor.propose()` — **no new contract**. It composes named action types
  (send native / send token / custom) into the parallel arrays; token decimals are read
  live; the description string is treated as opaque bytes and reused verbatim for
  queue/execute so the proposal id resolves.
