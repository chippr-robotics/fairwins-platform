# Implementation Plan: End-to-End Coverage Expansion

**Branch**: `claude/issue-1228-e2e-testing-cqx3lj` | **Date**: 2026-08-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/094-e2e-coverage-expansion/spec.md`, tracking issue
[#1228](https://github.com/chippr-robotics/fairwins-platform/issues/1228)

## Summary

Turn the end-to-end suite from a collection of specs into a system with a stated shape: one
machine-readable coverage matrix that names every shipped feature's member-facing flows and what
validates them; a written tiering policy with two admission rules and a runtime budget; gates that
fail the build on the specific dishonesty that produced 33 vacuous assertions; a shared harness that
runs every no-chain flow at a phone width as well as a desktop one and scans it with a real
accessibility ruleset; a Lighthouse audit that measures both profiles and fails when it measured
nothing; and the on-chain tier split across four independent shards before the backlog doubles it.

This branch ships that foundation. Each uncovered flow ships against its own tracked sub-issue of
#1228, prioritised by money-at-risk — recorded in `tasks.md` and filed on GitHub.

## Scope Decisions

Taken with the requester before planning; they bound everything below.

| Decision | Choice | Consequence |
|---|---|---|
| What this branch delivers | **Foundation only** | Matrix, policy, gates, harness, CI wiring, sharding. No new flow specs — the diff stays reviewable and the on-chain tier does not grow before it is split. |
| The backlog | **Filed as sub-issues of #1228** | Meets the issue's acceptance criterion; a gap in a document nobody is assigned is not tracked work. |
| On-chain tier runtime | **Measure, then shard in this branch** | Per-spec durations recorded; 4-way matrix with a private chain per leg. |
| Gate strength | **a11y blocks, performance reports** | Serious/critical axe violations fail (constitution V). Lighthouse budgets are baselined and reported — but an *unmeasured* route fails. |

## Technical Context

**Language/Version**: JavaScript (ES modules), Node 22 — matching the runners and the workspace.

**Primary Dependencies**: Cypress 15 (installed), `axe-core` 4.13 (installed, a frontend
devDependency), `@lhci/cli` 0.13 (installed globally in CI), Vitest (installed). **No new
dependency is added** — see research R3 and spec 075's lockfile hazard.

**Storage**: Two committed JSON files under `frontend/cypress/coverage/` — the matrix and the
per-spec duration weights. No service, no database.

**Testing**: Vitest for the policy gates (they ride the existing Frontend Unit Tests job); Cypress
for the tiers themselves; `lhci` for the performance audit.

**Target Platform**: GitHub Actions `ubuntu-latest`, Electron/Chrome headless, plus local
development.

**Project Type**: Test infrastructure and developer documentation for a React SPA with Solidity
contracts behind it.

**Performance Goals**: No-chain tier under 6 minutes per viewport leg; on-chain tier under 15
minutes per shard (from ~30 minutes serial); account-native tier under 5 minutes.

**Constraints**: The gates must fail loudly and must not be addable to a job that can be skipped;
no external service; nothing may depend on a live network or a funded account.

**Scale/Scope**: 96 spec directories to enumerate in the matrix, 34 existing Cypress specs across
three tiers, ~10 routes under performance budget, 4 on-chain shards.

## Constitution Check

*GATE: passed before Phase 0, re-checked after Phase 1.*

| Principle | Assessment |
|---|---|
| **I. Security-First Smart Contracts** | No `contracts/` change. The feature raises the evidence bar on the paths that spend member funds, which is the direction this principle points. No security review trigger. |
| **II. Test-First and Comprehensive Coverage** | This *is* the principle, applied to the tier the principle did not previously reach. The matrix makes the coverage claim checkable rather than asserted, and R2's gates enforce that "a test exists" is not accepted as "behaviour is proven". |
| **III. Honest State, No Mocks in Shipped Paths** | Nothing ships to production. Inside the suite the same rule is applied to *test* honesty: a skipped flow is recorded with a reason, an unmeasured route fails, and a passing assertion that cannot fail is a build error. The one hazard to watch is the accessibility injection — `axe-core` is loaded into the app window at run time and must never reach a production bundle. It is injected by the test runner, never imported by `frontend/src`, and the R8 gate asserts that. |
| **IV. Fail Loudly in CI** | New gates ride existing jobs; none carries `continue-on-error`. `test/config/CiGates.test.js` already rejects `continue-on-error` and bare `exit 0` in merge-gating steps, and the new shard legs inherit that. FR-026 exists precisely so an unmeasured route cannot read as a pass — the same defect the e2e gate carried for months. |
| **V. Accessible, Consistent Frontend** | Directly advances it: the standard moves from a component-level check plus a cold-load Lighthouse score to a ruleset run against real member journeys at two widths, blocking on serious and critical violations, with suppressions that must name an issue. |

**Complexity**: no violations to track. The feature adds two JSON files, one generated document, one
policy document, four small scripts and a set of Vitest gates — and deliberately adds no
dependency, no workflow, and no service.

## Project Structure

### Documentation (this feature)

```text
specs/094-e2e-coverage-expansion/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 — R1..R9 decisions
├── data-model.md        # Phase 1 — matrix record types and enums
├── quickstart.md        # Phase 1 — how to run and validate each piece
├── contracts/
│   ├── coverage-matrix.md   # The matrix file's schema and its gate
│   ├── test-harness.md      # cy.a11yScan, viewport profiles, precondition helpers
│   └── tiering-policy.md    # Tier definitions, admission rules, budgets, anti-patterns
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source code (repository root)

```text
frontend/
├── cypress/
│   ├── coverage/
│   │   ├── matrix.json                 # NEW — source of truth, one entry per spec directory
│   │   └── full-tier-weights.json      # NEW — measured seconds per on-chain spec
│   ├── support/
│   │   ├── a11y.js                     # NEW — cy.a11yScan, axe injection, severity policy
│   │   ├── viewports.js                # NEW — phone/desktop profiles, reachability assert
│   │   ├── commands.js                 # EDIT — remove the old checkA11y
│   │   └── e2e.js                      # EDIT — apply the viewport profile, load the new support
│   ├── e2e/fast/22-accessibility.cy.js # EDIT — run the ruleset instead of hand-rolled checks
│   └── ...
├── lighthouserc.desktop.json           # NEW — replaces lighthouserc.json
├── lighthouserc.mobile.json            # NEW
├── lighthouse-routes.json              # NEW — the one route list both configs read
└── src/test/e2e-policy/                # NEW — gates, in the existing unit-test job
    ├── assertionDepth.test.js          #   unconditional-truth + contradictory-terms
    ├── coverageMatrix.test.js          #   schema, set-equality with specs/, generated doc current
    └── harnessBoundary.test.js         #   axe-core never imported from frontend/src

scripts/
├── e2e/
│   ├── generate-coverage-matrix.js     # NEW — matrix.json -> docs/…/e2e-coverage-matrix.md
│   ├── split-full-tier.js              # NEW — LPT split of specs across shards
│   └── check-lighthouse-coverage.js    # NEW — every route x profile produced a report
└── ...

docs/developer-guide/
├── e2e-coverage-matrix.md              # NEW — GENERATED, committed, regenerate-and-diff
└── e2e-testing-policy.md               # NEW — tiers, rules, budgets, anti-patterns

.github/workflows/
├── test.yml                            # EDIT — viewport matrix on fast tier; 4-way shard on full
└── frontend-testing.yml                # EDIT — desktop + mobile Lighthouse, coverage check
```

**Structure Decision**: everything lands in directories that already exist and are already read.
The matrix and weights sit beside the suite they describe (`frontend/cypress/`), the gates sit with
the other structural gates (`frontend/src/test/`), the scripts follow the `scripts/<domain>/` +
`check:*` npm-script idiom used by `check:deps`, `check:iac` and `check:finops`, and both documents
land in `docs/developer-guide/` where the other developer guides are.

## Implementation phases

### Phase A — Inventory (User Story 1)

Build `matrix.json` with one entry per spec directory, `memberFacing: false` plus a reason where
that is the truth. Read each shipped spec's member-facing surface, list its flows, and record tier,
assertion depth, status and money-at-risk. Re-read the four specs holding the 33 vacuous branches
and record their real depth — several rows will read `covered` / depth `smoke`, which is the point.
Generate the document; gate the pair.

### Phase B — Policy and gates (User Story 2)

Write `docs/developer-guide/e2e-testing-policy.md`: the three tiers with purpose and cost, the two
admission rules, the runtime budgets, the six anti-patterns each with the failure it caused, and the
precondition/fixture conventions. Land the Vitest gates. Expect the unconditional-truth gate to fail
on first run against the 33 existing branches — that is the measurement SC-002 asks for, and those
lines are annotated with the tracking issue rather than silently rewritten here (they are money-path
tests and get their own reviewed change).

### Phase C — Harness (User Stories 4 and 5)

`cy.a11yScan` with axe injection and the serious/critical policy; viewport profiles applied from the
environment with a reachability assertion; the old `checkA11y` deleted rather than left as a weaker
twin; `22-accessibility.cy.js` converted to the ruleset. Split the Lighthouse config into two
profiles over one route list and add the coverage check.

### Phase D — Runtime (User Story 3's precondition)

Record per-spec durations, write the LPT splitter, convert `cypress-full-e2e` into a 4-leg matrix
with a private chain per leg and a per-leg timeout, add the viewport matrix to the fast tier, and
record the before/after in the policy.

### Phase E — Backlog

Order the absent flows by money-at-risk and file them as sub-issues of #1228, each naming its flow,
tier, risk and the matrix row it closes.

## Risks

| Risk | Mitigation |
|---|---|
| The unconditional-truth gate fails the build on the 33 existing branches the day it lands. | Annotate each with `// EITHER-WAY:` naming the tracking issue for the rewrite. The count is then visible and shrinking rather than invisible. Not silently exempting the directory: an exemption is how this became invisible the first time. |
| Sharding changes which tests pass. | Per-spec chain isolation already makes specs order-independent (#1222). Run the sharded matrix and the serial tier once each and compare the pass sets before removing the serial job. |
| The accessibility ruleset lights up on surfaces nobody has audited. | Severity floor at serious/critical; anything that must wait gets a suppression naming its issue, which the gate requires. The count of suppressions is reported, so this is a shrinking list, not a hiding place. |
| Lighthouse noise on shared runners. | Budgets report rather than block, by the requester's decision. Only the *unmeasured* case fails. |
| The matrix is a large hand-written artefact that could be wrong. | Every row is checkable against the suite; the gate enforces schema and set-equality, and a wrong row is a normal review comment. Being wrong in public beats being unstated. |
