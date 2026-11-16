# Feature Specification: Single Submission Engine — relayer-sent operations with zero-fee sponsorship

**Feature Branch**: `113-single-submission-engine`

**Created**: 2026-11-16

**Status**: Draft — a spike on Mordor is required before planning (see *Assumptions to validate first*)

**Tracking issue**: #1700

**Input**: User description: "We need to determine the most cost effective way to run bundlers for the
networks we support. All networks will send sponsored transactions, so if alto is not the best tool we
should investigate alternatives as well. We should have one bundler stack, not defender and alto also,
to simplify management." Followed by: "Write up the bundler recommendation as a spec. The no-fee
userop is the preferred path. It will simplify operations."

---

## Context: what this feature is and is not

The platform submits transactions on a member's behalf in two shapes, through two engines that share
nothing:

| | Account operations (passkey smart accounts) | Relayed intents and pay-per-request settlement |
|---|---|---|
| Engine | alto bundler | OpenZeppelin Relayer ("the relayer") |
| Networks served today | Polygon only | Polygon and Mordor |
| Runs as | One process **per network** | One process for all its networks |
| Signing keys | Raw private keys delivered to the process | Keys held in the cloud key service, never exported |
| Sponsorship needs | A paymaster contract, a funded deposit and a paymaster signer **per network** | One funded gas wallet per network |

Three consequences follow, and they are the reason for this feature:

1. **Sponsorship exists on two networks.** The paymaster is deployed on Polygon and Amoy only. "All
   networks send sponsored transactions" under today's model means six more paymaster deployments and
   six more deposits to fund and watch — on top of a bundler process and an executor key per network.
2. **Passkey members cannot transact at all on Ethereum Classic or Mordor.** The account contracts
   are deployed there; there is no bundler. The app tells them so before the tap, which is honest,
   and is also a product gap.
3. **Each network has up to three separately funded pools** — the paymaster deposit, the bundler's
   executor wallet and the relayer's gas wallet — each of which can run dry independently and each of
   which is alerted on separately.

Research on 2026-11-16 — vendor documentation and live probes of the public endpoints, not a
hands-on test — established the constraints that pick the design:

- No hosted bundler service supports Ethereum Classic or Mordor. Any hosted option therefore leaves
  a second, self-run stack.
- No maintained bundler serves more than one network per process, and none signs with the cloud key
  service the platform already uses.
- Ethereum Classic has legacy fees, an older instruction set than every other target, and public
  endpoints with no tracing support — the conditions bundlers are least tested under.
- The published data on live networks shows that more than nine in ten bundles carry a single
  operation. Bundling, the thing a bundler is for, is not doing work at this platform's volume.

**What this feature is.** One engine. The relayer the platform already runs becomes the only thing
that sends a transaction on its behalf, for every network, in both shapes. The platform's gateway
answers the same requests the app's account-operation client already makes, checks each operation,
and hands it to the relayer. alto is retired.

**The sponsorship model changes with it.** A paymaster exists so that an *independent* bundler can
trust it will be reimbursed. When the sponsor and the submitter are the same party, that guarantee
has nobody to protect: it is a contract, a deposit, a signer and extra cost on every operation, per
network, for nothing. Sponsorship is instead a **zero-fee operation**: the member signs an operation
whose fee is zero, and the platform's gas wallet for that network pays to include it. The decision
to sponsor *is* the decision to submit.

**What this feature is not.**

- It is not a change to any account, wager, pool or token contract. Nothing deployed is upgraded.
- It is not a change to the relayed-intent rail members with ordinary wallets use. That rail already
  runs on the relayer and keeps doing so.
- It is not the counterparty-screening and durable-lifecycle work proposed in
  `docs/architecture/streaming-backbone.md`. It creates the single point that work would attach to,
  and does not depend on it.
- It is not a move to a newer account-operation standard. The platform stays on the version its
  accounts are deployed against.

**What it supersedes.** The sponsorship model of spec 050 (a verifying paymaster reimbursing the
bundler) for the account-operation rail, and with it the "two gasless rails" framing: there is one
engine with two entry shapes. The rule that at most one bundler may serve a given network and
executor key retires with the bundler and is replaced by the equivalent rule for the relayer
(FR-021).

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A passkey member sends a sponsored transaction on any supported network (Priority: P1)

A member whose account is controlled by a passkey sends value, claims a wager or approves a vault
action on any network the platform supports — including Ethereum Classic and Mordor, where today
they are told it cannot be done. They hold none of the network's native coin. The confirmation
screen says the fee is sponsored; they confirm once with their passkey; the transaction lands.

**Why this priority**: This is the feature. It is the only story that delivers something a member
cannot do today, and every other story exists to make it safe or cheap to operate.

**Independent Test**: On each supported network, an account holding zero native coin completes a
transfer; afterwards it still holds zero native coin, the recipient has been paid, and the
platform's gas wallet for that network has paid the fee.

**Acceptance Scenarios**:

1. **Given** a passkey member with zero native coin on Mordor, **When** they send a supported token
   to another address, **Then** the confirmation states the fee is sponsored, one passkey prompt is
   shown, and the transfer is confirmed on chain with the member's native balance still zero.
2. **Given** the same member on each of the other seven networks, **When** they repeat the action,
   **Then** the outcome is the same on every one.
3. **Given** a member's very first action on a network where their account is not yet deployed,
   **When** they confirm, **Then** the account is created and the action performed in the same
   sponsored operation.
4. **Given** an operation that would fail when executed (for example, a transfer exceeding the
   balance), **When** the member tries to confirm, **Then** they are told before the passkey prompt
   and nothing is signed or submitted.
5. **Given** a submitted operation, **When** the member reloads the app or returns later, **Then**
   its outcome can still be read — confirmed, failed, or not yet known — and "not yet known" is never
   shown as success.

---

### User Story 2 — A refused sponsorship never strands the member (Priority: P1)

Sponsorship can be unavailable: paused by an operator, over a limit, or because the network's gas
wallet cannot cover the operation. The member learns this **before** they are asked to sign, is told
plainly that they would pay the network fee themselves, and — if they hold enough native coin —
completes the same action self-funded.

**Why this priority**: The platform's standing rule is that no FairWins-operated component may be
the only way out. A sponsorship model that works only when the platform says yes would break it.

**Independent Test**: With sponsorship paused, an account holding native coin completes a transfer;
the confirmation screen stated that the member pays the fee, the member's native balance fell by the
fee, and the platform's gas wallet is no worse off.

**Acceptance Scenarios**:

1. **Given** sponsorship is paused, **When** a member with native coin starts an action, **Then**
   the confirmation says they pay the network fee, and after one passkey prompt the action lands and
   the platform is reimbursed for the fee it advanced.
2. **Given** sponsorship is refused and the member holds no native coin, **When** they start an
   action, **Then** they are told why it cannot proceed and what would let it — and nothing is
   signed.
3. **Given** a member who was told the fee is sponsored and has signed, **When** sponsorship is
   withdrawn before submission, **Then** the member is told, nothing is submitted on the old terms,
   and they are offered the self-funded path — never switched to it silently.
4. **Given** a self-funded operation the member has signed, **When** it is presented to any
   standards-conforming submission service for that network, **Then** it is accepted there too: the
   platform has added nothing that makes it valid only through FairWins.

---

### User Story 3 — An operator runs one engine and funds one pool per network (Priority: P2)

The operator who keeps the platform running has one submission engine to deploy, monitor, upgrade
and reason about during an incident. Each network has one gas wallet to fund and one runway figure
to watch. Adding a network is configuration and funding one wallet — not a new process, a new
contract deployment and three new pools.

**Why this priority**: It is the stated motive — cost and simplicity — and it is what makes story 1
affordable on eight networks. It ranks below the member stories only because a member never sees it.

**Independent Test**: An inventory of what is running and what holds funds shows one submission
engine and exactly one platform-funded pool per network; the bundler, its executor keys, the
paymaster deposits and the paymaster signer are gone.

**Acceptance Scenarios**:

1. **Given** the feature is live on every network, **When** the running estate is inventoried,
   **Then** there is one submission engine and no bundler process on any node.
2. **Given** the same estate, **When** every credential that can sign a transaction is listed,
   **Then** each is held in the key service and none is a raw key delivered to a process.
3. **Given** a network's gas wallet is running low, **When** its remaining runway crosses the
   warning threshold, **Then** exactly one alert names that network and that wallet.
4. **Given** a network not yet served, **When** an operator enables it, **Then** the steps are:
   declare the network, create its key, fund its wallet — and nothing is deployed on chain.
5. **Given** the engine is stuck on one network, **When** members act on another, **Then** they are
   unaffected, and the stuck network is reported as such rather than as healthy.

---

### User Story 4 — Members with ordinary wallets notice nothing (Priority: P2)

A member using an ordinary wallet who relies on gasless wager, pool or transfer actions — and a
paying caller of the pay-per-request interface — sees no change. Those flows already ride the
relayer.

**Why this priority**: The single engine now carries everything, so a regression here would be a
regression for every gasless member at once.

**Independent Test**: The existing gasless-intent and pay-per-request suites pass unmodified against
the engine in its new configuration.

**Acceptance Scenarios**:

1. **Given** a member with an ordinary wallet, **When** they perform a gasless action, **Then** it
   is accepted, submitted and confirmed exactly as before, with the same fallback to paying their
   own fee.
2. **Given** heavy account-operation traffic on a network, **When** a relayed intent arrives for the
   same network, **Then** it is not starved: each shape has its own limits.

---

### User Story 5 — Polygon moves from two engines to one without a gap or an overlap (Priority: P3)

Polygon is the one network where members use sponsored account operations today. It moves to the new
model with no period in which neither engine serves it and no period in which both do. Funds parked
in the retired model are recovered.

**Why this priority**: It is a one-time event, but it is the only step that touches live members,
and the failure it guards against — two submitters on one network — is silent.

**Independent Test**: Through the cutover, a continuous stream of test operations on Polygon shows
none lost and none submitted twice; afterwards the old deposit has been withdrawn to the treasury.

**Acceptance Scenarios**:

1. **Given** the cutover is in progress, **When** a member submits an operation, **Then** it is
   handled by exactly one engine.
2. **Given** an operation accepted by the old engine before cutover, **When** cutover completes,
   **Then** it has either landed or been reported as failed — never left unaccounted for.
3. **Given** cutover is complete, **When** the old sponsorship deposit and the old executor wallets
   are inspected, **Then** their balances have been returned to the treasury and recorded.
4. **Given** a problem during the soak period, **When** the operator rolls back, **Then** Polygon
   returns to the previous model without members losing the ability to transact.

---

### Edge Cases

- **A member invalidates their own operation after it is checked** — for example by changing the
  account's controllers, or by getting another operation with the same sequence number included
  first. The submission fails on chain and the platform has paid for it. The loss is bounded per
  operation (FR-013) and counts against that account's allowance (FR-014).
- **Someone else submits the member's zero-fee operation first.** They pay for it; the member's
  action still happens; the platform's own submission fails cheaply. There is nothing to steal: a
  zero-fee operation reimburses nobody.
- **A sponsored operation is delayed past the point the member gave up.** The platform stops
  trying after a stated deadline and says so; it never lands an operation later than it promised
  (FR-012).
- **A member has two operations in flight on one network.** They are submitted in the order the
  account requires; the second is not sent in a way that makes the first fail.
- **The network's gas wallet is empty.** Sponsorship is refused before signing with that reason;
  self-funded operations are refused too, because the platform must advance their fee — and the
  member is told the platform, not their account, is the obstacle.
- **Screening cannot be performed.** The operation is not submitted and the member is told to
  retry. This is not reported as a refusal of the member.
- **Ethereum Classic verifies passkey signatures in contract code** rather than natively, at many
  times the cost. Operations there need a larger allowance than elsewhere, and must still fit in a
  block.
- **A testnet and a mainnet build.** Each sees only the networks of its own cohort, as everywhere
  else in the platform.
- **The app's built-in fallback list of submission services.** A self-funded operation remains
  usable at any of them (US2 scenario 4), so configuring an independent one stays possible.

---

## Requirements *(mandatory)*

### Functional Requirements

**One engine**

- **FR-001**: Every transaction the platform submits on behalf of a member or a paying caller —
  account operations, relayed intents and pay-per-request settlements — MUST be sent by one
  submission engine. No other component may send a transaction.
- **FR-002**: The engine MUST serve all eight supported networks — Ethereum, Optimism, Polygon,
  Base, Arbitrum, Ethereum Classic, Mordor and Amoy — from one deployment, on networks with either
  fee model.
- **FR-003**: The app's existing account-operation client MUST work against the platform without a
  change to how members' accounts sign, and without a new signature format.
- **FR-004**: Every key that signs a submitted transaction MUST be held in the platform's key
  service and MUST NOT be exportable. No raw signing key may be delivered to a running process.
- **FR-005**: A failure or stall of the engine on one network MUST NOT prevent submission on
  another, and MUST be detectable by a check that asserts on the engine's behaviour rather than on
  whether it is listening.

**Zero-fee sponsorship**

- **FR-006**: A sponsored account operation MUST be one whose signed fee is zero. The platform's
  gas wallet for that network pays for its inclusion. No paymaster is involved.
- **FR-007**: Sponsoring MUST NOT require any contract deployment, on-chain deposit or dedicated
  signer per network. Each network has exactly one platform-funded pool: its gas wallet.
- **FR-008**: The decision to sponsor MUST be made, and communicated to the member, **before** the
  member is asked to sign. In the ordinary case a member signs once per action.
- **FR-009**: Before sponsoring, the platform MUST apply, at minimum: the operator pause; a ceiling
  on what a single operation may cost; per-account and platform-wide allowances over time; a
  per-network spending cap; and a check that the network's gas wallet can cover the operation.
  Every refusal MUST carry a reason the app can act on.
- **FR-010**: The platform MUST check, before submitting, both that an operation is valid and that
  it would succeed when executed. An operation that would fail MUST be refused before the member
  signs, with the reason where one can be determined.
- **FR-011**: The confirmation screen MUST state whether the fee is sponsored or paid by the
  member. It MUST NOT describe a self-funded action as free, nor a sponsored one as costing the
  member anything.
- **FR-012**: The platform MUST stop attempting to submit an operation after a stated deadline, and
  MUST NOT submit one later than that. The deadline MUST be visible to the member's app, so that an
  operation reported as expired cannot subsequently land through the platform.

**Bounding what the platform can lose**

- **FR-013**: The most the platform can spend on one operation — including one that fails on
  chain — MUST be bounded by the per-operation ceiling of FR-009, per network.
- **FR-014**: An operation that the platform paid for and that failed on chain MUST be recorded,
  and MUST count against the submitting account's allowance exactly as a successful one does.
- **FR-015**: Sponsorship allowances MUST NOT be defeated by the mere creation of new accounts.
  Creating an account costs nothing, so an allowance keyed only on the account is not a limit.

**Never stranded**

- **FR-016**: When sponsorship is unavailable, a member holding enough native coin MUST be able to
  complete the same action self-funded through the platform, with the platform reimbursed for the
  fee it advanced.
- **FR-017**: A self-funded operation MUST be a standard one: anything able to submit operations
  for that network and account type MUST be able to submit it. The platform MUST NOT add a
  requirement that makes a member's signed operation usable only through FairWins.
- **FR-018**: The platform MUST NOT switch a member from sponsored to self-funded, or the reverse,
  without the member confirming the new terms.

**Screening and honesty**

- **FR-019**: Every operation the platform submits — sponsored **or self-funded** — MUST pass
  sanctions screening of the acting account first. An account that fails is refused. Screening that
  cannot be performed MUST stop the submission and MUST be reported as retryable, never as a
  refusal of the member and never as a pass.
- **FR-020**: The status of a submitted operation MUST be reportable as *pending*, *confirmed*,
  *failed* or *not known*, MUST be derived from the network's own record rather than from the
  platform's memory, and MUST therefore survive a restart. *Confirmed* MUST NOT be reported before
  the network has included the operation.

**Operating it**

- **FR-021**: At most one engine instance may submit for a given network and signing key. The
  platform MUST refuse to start a second, and MUST detect one that is already running. This
  replaces the equivalent rule for the retired bundler.
- **FR-022**: Each network's gas wallet MUST be alerted on by remaining runway, not by a fixed
  balance, consistent with the platform's existing cost-monitoring rules. Retired pools MUST be
  removed from monitoring in the same change that retires them, and the new ones added, so that the
  cost catalogue never describes a pool that does not exist or omits one that does.
- **FR-023**: Enabling a network MUST require only configuration, a key and funding. Disabling one
  MUST leave members' accounts and funds on it untouched.
- **FR-024**: Account operations and relayed intents on the same network MUST have separate
  allowances, so that neither shape can exhaust the other's.

**Retiring what this replaces**

- **FR-025**: The bundler MUST be removed from every node, together with its keys, its ingress and
  its deployment configuration. Its executor wallets MUST be drained to the treasury.
- **FR-026**: The paymaster deposits on Polygon and Amoy MUST be withdrawn to the treasury and the
  paymaster signing key retired, after the soak period of FR-028. The deployment record MUST show
  the paymasters as retired rather than silently dropping them.
- **FR-027**: During cutover on a network, exactly one engine MUST accept operations for it at any
  moment.
- **FR-028**: Polygon MUST run on the new model for a stated soak period with a tested rollback
  before anything in FR-025 or FR-026 is made irreversible.
- **FR-029**: Documentation and the agent guide that describe two gasless rails, the paymaster
  model or the single-bundler rule MUST be corrected in the same change that makes them untrue.

### Key Entities

- **Account operation**: A member-signed instruction for their smart account, carrying the account,
  a sequence number, what to do, and the fee the member agrees to — zero when sponsored.
- **Sponsorship decision**: The platform's answer, given before signing, to "will you pay for this
  operation?" — yes, or no with a reason. It has a deadline.
- **Submission**: One attempt by the engine to include an operation, with an outcome: confirmed,
  failed, or expired.
- **Gas wallet**: The one platform-funded account per network that pays for everything the engine
  submits there. It has a balance, a burn rate and a runway.
- **Allowance**: A limit on sponsored operations over time, held per account, per funding source
  and platform-wide, separately for each entry shape.
- **Network**: One of the eight supported networks, with its fee model, its cost ceiling and
  whether it is enabled.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A passkey member holding zero native coin completes a sponsored transfer on all eight
  supported networks, up from one.
- **SC-002**: The number of separately deployed submission engines is one, down from two; the number
  of platform-funded pools per network is one, down from as many as three.
- **SC-003**: The number of raw transaction-signing keys delivered to any running process is zero.
- **SC-004**: Between operations, the submission path makes no recurring requests to network
  providers. (Measured on Polygon before and after: the retired bundler polls continuously.)
- **SC-005**: On Polygon, the time from a member confirming to the transaction being included is no
  worse than the baseline measured on the current model immediately before cutover, at the 95th
  percentile.
- **SC-006**: In every case where sponsorship is refused, the member is told before signing. Across
  the soak period, zero operations are submitted after their deadline and zero are switched between
  sponsored and self-funded without the member confirming.
- **SC-007**: Across the soak period, fewer than 1% of sponsored operations fail on chain after
  passing the platform's checks, and no single failed operation costs the platform more than its
  per-operation ceiling.
- **SC-008**: The Polygon cutover loses no operation and at no moment has two engines accepting
  operations for that network.
- **SC-009**: A sponsored operation costs the platform measurably less gas than under the current
  model, by at least the overhead the paymaster added, verified on Polygon.
- **SC-010**: Enabling a further network takes an operator under one hour and deploys nothing on
  chain.

---

## Assumptions

- **The preferred sponsorship path is zero-fee operations**, as directed. The paymaster model is
  retired rather than kept as a dormant alternative; keeping both would preserve exactly the
  per-network overhead this feature removes.
- **Every supported network is sponsored**, including Ethereum mainnet, where an operation costs
  roughly ten times what it does elsewhere. The per-network ceiling and spending cap of FR-009 are
  what make that a bounded commitment; their values are an operating decision, not part of this
  specification.
- **Screening covers the acting account**, as it does today for sponsored operations. Extending it
  to the addresses an operation pays is the subject of the streaming-backbone proposal and is not
  required here. FR-019 does close one existing gap: self-funded operations are not screened by the
  platform today, and will be.
- **The platform stays on the account-operation standard version its accounts are deployed
  against.** That version lets an operation be checked with an ordinary read of the network, which
  is what makes this design work on Ethereum Classic without tracing support. A later version
  removes that, and Ethereum Classic cannot run the newest ones at all. Moving versions is a
  separate decision with its own specification.
- **When the platform's own engine is down, passkey members cannot transact through the app.** That
  is true today and this feature does not change it. FR-017 keeps the way out open — a member's
  self-funded operation remains usable elsewhere — but offering an independent service inside the
  app is out of scope.
- **Members with ordinary wallets always keep self-submission**, as now.
- **Volume is low** — tens to low hundreds of operations a day — so submitting operations one at a
  time, rather than bundling them, costs nothing material. A change in that assumption is a reason
  to revisit, not a reason to bundle now.
- **The relayer's known tendency to stall a network's queue under a sharp fee spike applies to
  account operations too** once they ride it. FR-005 and FR-012 are how that is contained: the
  stall is detected, other networks are unaffected, and an operation is never landed late.
- **The engine's software remains open source and is used unmodified.**

### Assumptions to validate first

These rest on documentation and remote probes, not on a hands-on test. Each is cheap to check and
would change the plan if wrong, so a spike on Mordor — the most constrained network — precedes
planning:

1. A passkey account operation, submitted by the relayer with an explicit gas allowance, is included
   on Mordor inside the block limit. (Passkey verification in contract code is reported at around
   three hundred thousand gas, from a single secondary source.)
2. The app's existing account-operation client works unmodified against the platform's answers.
3. A deliberately invalidated operation costs the platform no more than the ceiling assumes.
4. Reading an operation's outcome from the network's record is practical on the public Ethereum
   Classic endpoints, which limit how much history one request may scan.
5. A zero-fee operation is accepted by the account contracts as deployed, on every network.

## Dependencies

- **Spec 036** (relayer infrastructure) — the engine this builds on.
- **Spec 041 / 050** (passkey accounts; sponsored paymaster) — the accounts are unchanged; the
  sponsorship model of 050 is superseded.
- **Spec 087** (infrastructure as code) and **spec 089** (cost monitoring) — the node, key and pool
  changes are declared there, and the cost catalogue must change in step (FR-022).
- **Spec 110** (the single write seam) — the place the pre-signature sponsorship decision of FR-008
  belongs in the app.
