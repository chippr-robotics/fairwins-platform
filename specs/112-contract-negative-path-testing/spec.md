# Feature Specification: Contract negative-path test hardening

**Feature Branch**: `112-contract-negative-path-testing`

**Created**: 2026-10-26

**Status**: Draft

**Input**: User description: "Review our smart contract testing. CI testing needs to be robust enough to cover negative paths as well as positive paths."

## Context

A review of the contract test suite on `staging` @ `10e82f76` found the following:
- 1,165 Hardhat tests pass.
- 867 assertions name a specific revert reason.
- A blocking coverage gate holds 26 contracts to statement and branch floors.

That is strong on happy paths and on reverts the authors already knew about. It is weak in three places. The most important is that **coverage does not measure adversarial ordering**: `WagerPool` stood at 100% statements and 93% branches while #1667 was live. That bug was a re-proposal landing between a member reading the payout matrix and their approval executing.

The measured gaps, all reproducible with `npm run test:coverage` and a static scan of revert sites against test assertions:

1. **Ungated value contracts.** Ten contracts that hold, route or spend value are absent from `coverage-threshold-policy.json`:
   - `CallsignRegistry` 62% branch
   - `FairWinsVerifyingPaymaster` 64%
   - `LiquidityRouter` 70%
   - `StakingRouter` 80%
   - `StandardDAOFactory` 50%
   - `FundingPoolFactory` 86%
   - `FundingPool` 94%
   - `BridgeRouter` 95%
   - `FeeRouter` 98%
   - `MiniAppRegistry` 98%

   They count only toward the blended total. Nothing requires a new contract to be listed.
2. **Guards no test ever triggers.** These branches are never taken in any test:
   - `CoinbaseSmartWallet` (26% branch, gate floor 26%): the EntryPoint-only rejection, upgrade to a codeless implementation, and the replayable-nonce-key checks.
   - `WagerRegistryIntents`: `notFrozen` and `whenNotPaused` on every gasless intent twin.
   - `FairWinsVerifyingPaymaster`: `onlyEntryPoint` on `postOp`, and `onlyOwner` on stake management.
   - Admin setters on `MembershipManager`, `StakingRouter` and `LiquidityRouter`: the role checks and zero-address checks.
3. **Revert reasons no test asserts by name.** 42 of the 318 reasons production contracts can raise are never asserted. This is a lower bound, because names shared across contracts are counted once.
4. **Assertions that can't tell reverts apart.** 47 assertions are a bare `.to.be.reverted`, which passes on any revert, including one for the wrong reason.
5. **Fuzzing never gates.**
   - Medusa runs weekly only, with `continue-on-error: true`, which conflicts with Constitution IV (CI fails loudly).
   - It targets 4 of the 6 existing harnesses.
   - There are no harnesses for `WagerPool`, `FundingPool`, the routers, the policy guards or the paymaster.
6. **No adversarial-sequence tests** for escrow-holding contracts.

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are the people and agents who change contracts and review those changes. "Value" means a regression in a guard fails CI before it can merge.

### User Story 1 - Every value-bearing contract is held to a coverage floor (Priority: P1)

A contributor changes a contract that holds, routes or spends value. CI fails if that contract's statement or branch coverage drops below its recorded floor. CI also fails if a new contract is added under a value directory without a policy entry.

**Why this priority**: an ungated contract can lose its negative tests silently. It is the cheapest gap to close, and it protects everything that follows.

**Independent Test**: delete one negative test from an ungated contract today and CI stays green. After this story, the same deletion fails the coverage gate. Adding an unlisted contract under `contracts/bridge/` fails the new completeness check.

**Acceptance Scenarios**:

1. **Given** a contract under `contracts/{wagers,pools,bridge,liquidity,staking,fees,account,custody,access,naming,apps,clearpath}/`, **When** it has no entry in `gated`, `reportOnly` or `excluded`, **Then** the policy check fails and names the contract.
2. **Given** a gated contract at its floor, **When** a change lowers its branch coverage, **Then** the coverage gate fails and names the contract and the metric.

---

### User Story 2 - Every guard is exercised on its failing side (Priority: P1)

For every access check, pause/freeze modifier, and input-validation check on a value path, a test triggers the failing branch and asserts the **specific** error.

**Why this priority**: these are the checks whose removal would be a security regression, and today some can be deleted without failing a single test.

**Independent Test**: comment out each guard listed in Context item 2. Each one must turn at least one test red.

**Acceptance Scenarios**:

1. **Given** a frozen account or a paused registry, **When** a relayer submits any `…WithSig` / `…WithAuthorization` intent for it, **Then** the call reverts with the freeze or pause error, matching the self-submit path.
2. **Given** a `CoinbaseSmartWallet`, **When** a non-EntryPoint caller invokes an EntryPoint-only function, or an upgrade targets an address with no code, or a replayable-nonce op uses a disallowed selector, **Then** each reverts with its named error.
3. **Given** any admin setter, **When** called by an account without the required role, **Then** it reverts with `AccessControlUnauthorizedAccount` (or the contract's own error).

---

### User Story 3 - Reverts are asserted precisely and completely (Priority: P2)

Every revert reason a production contract can raise is asserted by name in at least one test, or is recorded on a justified allowlist as unreachable. No test uses a bare `.to.be.reverted` unless it carries a reason.

**Why this priority**: a bare revert assertion passes when the code fails for the wrong reason. Precision is what makes a negative test mean something.

**Independent Test**: add a new custom error to a contract and raise it in one place. CI fails until a test asserts it or an allowlist entry explains why it cannot be reached.

**Acceptance Scenarios**:

1. **Given** a production contract that declares and raises `error X`, **When** no test asserts `X` and no allowlist entry names it, **Then** the revert-coverage check fails and names the contract and `X`.
2. **Given** a test using bare `.to.be.reverted` with no `// ANY-REVERT: <reason>` annotation, **When** CI runs, **Then** the check fails and names the file and line.

---

### User Story 4 - Property fuzzing gates contract changes (Priority: P2)

On a pull request that touches `contracts/`, a bounded Medusa run executes every harness and fails the PR if any property is violated. The weekly run keeps its longer budget and also fails loudly.

**Why this priority**: example tests check the cases authors thought of. Invariants check the ones they didn't, which is the class #1667 belonged to.

**Independent Test**: break an invariant (for example, let a pool pay out more than it escrowed) and the PR fuzz job fails.

**Acceptance Scenarios**:

1. **Given** a PR touching `contracts/`, **When** CI runs, **Then** Medusa runs every harness in `contracts/test/` within a bounded time budget, and any failed property fails the job.
2. **Given** `WagerPool` and `FundingPool`, **Then** harnesses assert at least these properties:
   - escrow conservation: paid out + refunded ≤ deposited, with no residue once settled;
   - no double claim or refund;
   - a locked outcome only ever equals a proposal each approver approved by id;
   - state only moves forward.
3. **Given** `BridgeRouter`, `LiquidityRouter`, `StakingRouter` and `FeeRouter`, **Then** harnesses assert the router never retains member funds after a call, and the fee taken never exceeds the cap.

---

### User Story 5 - Adversarial sequences are tested on escrow contracts (Priority: P3)

Each escrow-holding contract has a test file written as attacker scenarios rather than feature checks.

**Why this priority**: valuable, but it builds on stories 1–4 and is open-ended. It is scoped to the escrow contracts.

**Independent Test**: reintroduce the #1667 defect (`approve()` not bound to `proposalId`) and the adversarial suite fails.

**Acceptance Scenarios**:

1. **Given** a `WagerPool` or `FundingPool`, **When** the creator or organizer changes state between a member's read and that member's action, **Then** the member's action reverts, never lands on state they didn't see.
2. **Given** a hostile ERC-20 that re-enters on transfer, **When** it is used in a claim or refund, **Then** reentrancy is refused and balances are conserved.
3. **Given** actions submitted at the exact deadline boundary, **Then** behaviour matches the documented inclusive/exclusive rule on both sides.

### Edge Cases

- Vendored code (`contracts/account/lib/**`) is excluded from the revert-coverage and policy checks. It is upstream's to test.
- A revert that really is unreachable (defence in depth behind an earlier check) goes on the allowlist with a reason, rather than getting a contrived test.
- Coverage instrumentation changes gas costs. Negative tests that depend on exact gas must not be added.
- Medusa's PR budget must fit CI runtime. A property that needs a long campaign stays weekly-only, and that must be stated next to it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `coverage-threshold-policy.json` MUST list every first-party contract under the value directories in `gated`, `reportOnly` (with rationale) or `excluded` (with reason).
- **FR-002**: A CI check MUST fail when a contract under a value directory is absent from the policy.
- **FR-003**: Newly gated contracts MUST start with `min` floors equal to the measured coverage (no regression), with a target `tier`.
- **FR-004**: The guards enumerated in Context item 2 MUST each have a test that triggers the failing branch and asserts the specific error.
- **FR-005**: After FR-004, the `CoinbaseSmartWallet` and `FairWinsVerifyingPaymaster` floors MUST be raised to the new measured coverage.
- **FR-006**: A CI check MUST fail when a production contract raises a named revert that no test asserts and no allowlist entry covers. The allowlist MUST require a reason per entry and MUST only shrink: entries whose error becomes asserted, or is no longer raised, fail the check.
- **FR-007**: A CI check MUST fail on bare `.to.be.reverted` / `.to.be.revertedWithoutReason` without an `// ANY-REVERT: <reason>` annotation on the same or the preceding line.
- **FR-008**: All 47 existing bare revert assertions MUST be converted to specific assertions or annotated.
- **FR-009**: A PR-time Medusa job MUST run all harnesses, bounded in time, without `continue-on-error`. The weekly job MUST drop `continue-on-error`.
- **FR-010**: New Medusa harnesses MUST exist for `WagerPool`, `FundingPool` and the four routers, asserting the properties in Story 4.
- **FR-011**: Adversarial test files MUST exist for `WagerPool` and `FundingPool` covering the Story 5 scenarios, including a regression for #1667.
- **FR-012**: No change under this spec may modify production contract bytecode. This feature adds tests, harnesses, policy and CI only; the bytecode-digest gate MUST stay byte-identical. Test-only contracts (`contracts/test/**`, `contracts/mocks/**`) are exempt.

### Key Entities

- **Coverage policy**: per-contract tier, enforced floor and rationale (`coverage-threshold-policy.json`).
- **Revert allowlist**: named reverts recorded as unreachable, each with a reason (new, beside the policy).
- **Fuzz harness**: a test-only contract wrapping a production contract with `property_*` invariants (`contracts/test/`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every first-party contract under the value directories appears in the coverage policy. Ungated value contracts drop from 10 to 0.
- **SC-002**: Every guard in Context item 2 fails at least one test when commented out. This is verified by a recorded mutation check in the PR.
- **SC-003**: Named reverts with no test and no allowlist entry drop from 42 to 0.
- **SC-004**: Bare revert assertions without annotation drop from 47 to 0.
- **SC-005**: Medusa runs on every contract PR. Fuzzed value contracts rise from 4 to at least 10.
- **SC-006**: Reintroducing #1667 fails CI.
- **SC-007**: The bytecode digest is unchanged across the whole feature.

## Assumptions

- Hardhat plus chai matchers stay the unit-test stack; Medusa stays the fuzzer. No Foundry migration.
- The `CoinbaseSmartWallet` family is vendored from Coinbase, but FairWins deploys it, so it is in scope.
- Fork tests remain a separate workflow and are out of scope.
- The Slither baseline triage (17 High findings) is out of scope and tracked separately.
