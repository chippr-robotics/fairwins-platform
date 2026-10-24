# FairWins / Prediction DAO Constitution

This constitution defines the non-negotiable standards that every feature, spec,
plan, and pull request in this repository must uphold. Spec Kit artifacts
(`spec.md`, `plan.md`, `tasks.md`) and all generated code are bound by these
principles. When guidance here conflicts with convenience, this document wins.

## Core Principles

### I. Security-First Smart Contracts (NON-NEGOTIABLE)

All on-chain code is adversarial-by-default and handles user funds. Every change
to `contracts/` MUST:

- Follow the checks-effects-interactions pattern and guard against reentrancy,
  integer over/underflow, and access-control bypass.
- Target the Ethereum Trust Alliance Security Levels (EthTrust-SL); new value-
  bearing contracts aim for at least L2 (comprehensive testing, secure patterns,
  documentation) and document any gap.
- Be reviewed against the project's smart-contract security agent
  (`.github/agents/smart-contract-security.agent.md`) before merge.
- Pass static analysis (Slither) and, for stateful logic, fuzzing (Medusa) with
  no new high/critical findings. Findings that are accepted MUST be documented
  with rationale.

Access control, fund custody, and oracle-resolution paths are the highest-risk
surfaces and require explicit reasoning in the spec and plan.

### II. Test-First and Comprehensive Coverage (NON-NEGOTIABLE)

Tests are written or updated alongside the behavior they describe; behavior is
not "done" until tests prove it.

- Smart contracts: unit tests in `test/`, plus integration and (where oracles or
  external protocols are involved) fork tests. Resolution, claim, refund, and
  timeout paths MUST be tested including their failure and edge cases.
- Frontend: unit/integration tests via Vitest for all non-trivial logic.
- A change that alters a contract interface MUST update the corresponding
  contract/integration tests in the same PR.
- The full test suite MUST pass locally and in CI before merge.

### III. Honest State, No Mocks or Placeholders in Shipped Paths

Production code and user-facing UX MUST reflect real on-chain state and honest
finality.

- No mock data, stubbed responses, hardcoded placeholders, or testnet-only
  shortcuts in mainline production paths. Mocks live only under dedicated test
  scopes (`contracts/mocks/`, test fixtures).
- UX MUST NOT imply finality that the chain has not reached (e.g. challenge
  periods, oracle timeouts, and pending resolutions are surfaced truthfully).
- Network-scoped data (wagers, membership, balances) MUST be scoped to the
  active network and never leak across testnet/mainnet boundaries.

### IV. Fail Loudly in CI

CI is the enforcement layer for these principles and MUST surface failures, never
hide them. Per `.github/CI_ERROR_HANDLING_POLICY.md`:

- Linting, type-checking, build, and test steps MUST fail the pipeline on error.
  `continue-on-error: true` is forbidden on these steps.
- Only genuinely auxiliary steps (coverage upload, optional scans, docs
  generation) may continue on error, and each MUST carry a comment explaining
  why.
- Security scans MUST fail the pipeline on critical vulnerabilities.

### V. Accessible, Consistent Frontend

The frontend is the trust surface for non-technical users.

- New UI MUST meet WCAG 2.1 AA; accessibility audits (axe, Lighthouse) MUST pass
  in CI.
- ESLint errors block the build; warnings are minimized, not accumulated.
- Contract addresses, ABIs, and network config consumed by the frontend come
  from the generated sync artifacts — never hand-copied or hardcoded.

## Additional Constraints

- **Tech stack**: Solidity + Hardhat for contracts; React + Vite + Vitest for the
  frontend; The Graph subgraph for indexing. Introducing a new core technology
  requires justification in the feature's `plan.md`.
- **Key management**: Deployer and admin keys follow the air-gapped floppy
  keystore workflow; private keys, mnemonics, and secrets MUST NEVER be committed
  or printed in logs. `.env` stays local; `.env.example` documents required vars.
- **Archived code**: `contracts-archive/` and `test-archive/` are reference only
  and MUST NOT be imported by, or deployed from, active code.
- **Deployments**: Deterministic deployment scripts and recorded `deployments/`
  artifacts are the source of truth for on-chain addresses.

## Development Workflow

1. **Constitution check** — every `plan.md` begins by confirming the design does
   not violate these principles; deviations are logged in a Complexity Tracking
   section with explicit justification.
2. **Spec → Plan → Tasks → Implement** — features flow through the Spec Kit
   workflow. Skip steps only for trivial changes, and never skip the spec for
   anything touching funds, access control, or oracle resolution.
3. **Review gates** — PRs MUST pass CI (build, lint, tests, security scans),
   carry a smart-contract security review when `contracts/` changes, and update
   docs/specs affected by the change.
4. **Simplicity** — prefer the smallest change that satisfies the spec (YAGNI).
   Added complexity must earn its place in the plan.
5. **Coordinated multi-agent work** — this repository is worked by several agents
   concurrently, and the coordination protocol is binding, not advisory
   (`docs/developer-guide/multi-agent-workflow.md`):
   - A spec number is claimed by **merging** a reservation PR into `staging` that
     contains only the new `specs/<NNN>-<slug>/spec.md` and its e2e coverage-matrix
     row. Computing a number claims nothing:
     `max(existing) + 1` is correct exactly once per merge, which is how five
     numbers came to name two features each — the most recent while the gate that
     catches it was in review. `npm run check:specs` gates this.
   - Feature work branches from `staging`. Only a promotion or a declared hotfix
     reaches `main`.
   - An issue's state is read from state GitHub already keeps exactly once — its
     assignee, its linked pull requests, and whether it is closed — never from a
     mirrored status label, which is a second copy and therefore drifts. Claiming is
     assigning; closing is `Closes #N` in the PR body, applied on the `staging` merge
     by `close-linked-issues.yml` because GitHub honours closing keywords only on the
     default branch — and verified by reading the issue back. Delegated work gets a
     **sub-issue**, the only representation the parent issue and the next agent can
     both read.
   - A subagent's report is a claim. The diff is read and the affected gates are run
     before the work is accepted; work that was not reviewed is not done.

## Governance

This constitution supersedes other practices and conventions in the repository.

- Amendments are made by editing this file via a PR that states the change, its
  rationale, and any migration impact on existing specs/plans/templates.
- Versioning follows semantic rules: **MAJOR** for removing or redefining a
  principle, **MINOR** for adding a principle or materially expanding guidance,
  **PATCH** for clarifications and wording.
- All PRs and reviews are expected to verify compliance with these principles.
  Unjustified complexity or principle violations are grounds to block a merge.
- Runtime, day-to-day agent guidance lives in `CLAUDE.md` and the relevant Spec
  Kit plan; this document holds the durable, repeatable standards.

**Version**: 1.1.0 | **Ratified**: 2026-06-05 | **Last Amended**: 2026-09-05
