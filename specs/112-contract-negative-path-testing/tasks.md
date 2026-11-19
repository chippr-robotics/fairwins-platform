# Tasks: Contract negative-path test hardening

Spec: [spec.md](spec.md) · Plan: [plan.md](plan.md) · Parent: #1673

## Phase 1 — Gates (A, #1674) — blocks nothing; merge first

- [ ] T001 Gate the 10 ungated value contracts at their measured floors; place the 3 `StandardDAO*` helpers (FR-001, FR-003)
- [ ] T002 Policy-completeness check with must-fail fixtures; wire into CI (FR-002)
- [ ] T003 Revert-coverage check + shrink-only allowlist seeded with current gaps; must-fail fixtures; CI (FR-006)
- [ ] T004 Bare-revert check + shrink-only per-file baseline; must-fail fixtures; CI (FR-007)
- [ ] T005 Bounded Medusa job on contract PRs; drop `continue-on-error` from the weekly job (FR-009)

## Phase 2 — Close the gaps (parallel)

- [ ] T010 [P] B1 #1675 Account-stack negative tests + mutation table (FR-004)
- [ ] T011 [P] B2 #1676 Intents freeze/pause, admin setters, unasserted reverts + mutation table (FR-004, FR-006)
- [ ] T012 [P] B3 #1677 Oracle adapter negative tests + mutation table (FR-004, FR-006)
- [ ] T013 [P] C #1678 Convert or annotate the 47 bare revert assertions; report any that passed for the wrong reason (FR-008)
- [ ] T014 [P] D #1679 Medusa harnesses: WagerPool, FundingPool, 4 routers; target the 2 untargeted harnesses; must-fail proof per harness (FR-010)
- [ ] T015 [P] E #1680 Adversarial suites for WagerPool and FundingPool; #1667 must-fail proof (FR-011)

Each Phase 2 PR deletes the allowlist and baseline entries it closes.

## Phase 3 — Close-out

- [ ] T020 Raise coverage `min` floors to the new measured values; raise CoinbaseSmartWallet and the paymaster (FR-005)
- [ ] T021 Confirm the allowlist holds only justified unreachable entries and the bare-revert baseline is 0 (SC-003, SC-004)
- [ ] T022 Record SC-001…SC-007 evidence on #1673 and close it
