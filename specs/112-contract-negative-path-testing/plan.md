# Implementation Plan: Contract negative-path test hardening

**Spec**: [spec.md](spec.md) · **Parent issue**: #1673 · **Reservation**: #1672

## Summary

Make CI fail when a value-bearing contract loses a negative-path test. Four changes do that:

- **Gates**: every value contract sits under a coverage floor, and every named revert must be asserted.
- **Tests**: every guard is exercised on its failing branch.
- **Fuzzing**: property fuzzing runs on contract PRs.
- **Adversarial suites**: the escrow contracts get attacker-sequence tests.

Nothing in this plan changes production bytecode.

## Technical context

- **Unit tests**: Hardhat with `@nomicfoundation/hardhat-chai-matchers`, specifically `revertedWithCustomError` / `revertedWith` / `revertedWithPanic`. No Foundry migration.
- **Coverage**: `solidity-coverage` → `coverage/coverage-summary.json` + `lcov.info`, enforced by `scripts/coverage/check-thresholds.js` against `coverage-threshold-policy.json`.
- **Fuzzing**: Medusa v1.5.1, the `property_*` harnesses in `contracts/test/`, and `medusa.json`.
- **Gate style**: dependency-free `node --test` suites with must-fail fixtures, as in `scripts/specs`, `scripts/ci` and `scripts/finops`.

## Constitution check

| Principle | Status |
|---|---|
| I. Security-first contracts | ✅ Strengthens it. No contract logic changes. Slither is unaffected. |
| II. Test-first, failure and edge cases tested | ✅ This feature *is* Principle II's "failure and edge cases" clause, made enforceable. |
| III. No mocks in shipped paths | ✅ New mocks and harnesses live only in `contracts/mocks/` and `contracts/test/`. |
| IV. Fail loudly in CI | ✅ Removes the weekly Medusa job's `continue-on-error`, a standing IV violation. Every new gate is blocking. |
| V. Accessible frontend | N/A. No UI. |
| Byte gates (spec 075) | ✅ Production bytecode is byte-identical. The baseline gains ADDED entries for test-only harnesses and mocks only, re-recorded deliberately. |

## Design

### Workstreams

Each workstream is a sub-issue with a disjoint file scope, so they can run in parallel.

| ID | Issue | Owner agent | Scope | FRs |
|---|---|---|---|---|
| A | #1674 | mark | `coverage-threshold-policy.json`, `scripts/coverage/**`, new gate scripts, workflows | 001 002 003 006 007 009 |
| B1 | #1675 | latch | `test/negative/account/**` (new) | 004 005 |
| B2 | #1676 | keel | `test/negative/**` (new): intents, setters, unasserted reverts | 004 006 |
| B3 | #1677 | augur | `test/negative/oracles/**` (new) | 004 006 |
| C | #1678 | keel | assertion lines in existing `test/**` files | 008 |
| D | #1679 | keel | `contracts/test/*FuzzTest.sol` (new), `medusa.json` targets | 010 |
| E | #1680 | keel | `test/adversarial/**` (new), optional hostile mock | 011 |

### Ratchets

These gates go in before the gaps are closed. Every one is shrink-only, so A can merge first and the others close their own entries:

- **Revert allowlist**: seeded with the measured gaps, each entry citing its closing issue. An entry that becomes asserted, or stops being raised, fails the check, which forces its deletion.
- **Bare-revert baseline**: per-file counts, which can only fall.
- **Coverage `min` floors**: start at measured values and are raised after B1/B2/B3 land (FR-005).

### Integration order

1. **A first.** Each later PR deletes its own allowlist/baseline entries, which the shrink-only rule then requires.
2. **B1, B2, B3, C, D, E** in any order, each re-checked against the bytecode gate and the new gates.
3. **Close-out.** Raise the floors to the new measured coverage, and record the mutation evidence (SC-002) and the #1667 must-fail proof (SC-006) in the parent issue.

## Verification

- Every new gate has must-fail fixtures.
- Each B workstream records a **mutation table**: for each guard, neutralize it and confirm a test goes red, then restore it.
- E records the **#1667 regression proof**: revert the fix and confirm the suite fails.
- D records a **must-fail medusa run** per harness.
- The bytecode digest is compared on every PR.
