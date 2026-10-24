# Implementation Plan: Guided Multichain Vault Creation — One Vault, Chosen Networks

**Branch**: `claude/multichain-experience-improvements-7z3wti` | **Date**: 2026-09-05 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/105-multichain-vault-creation/spec.md`

## Summary

Replace the single-form vault creation with a four-sheet guided flow (type preset → rules tile grid
→ networks + orchestrated deployment → done) that deploys the SAME Safe address on every selected
custody network; consolidate the Details view into one card with per-network status rows (including
inline deploy-later); add queue readability (filter chips, needs-you, decoded intents); restyle the
Load sheet. Frontend-only: the chain-independent spec-043 initializer + a per-vault saltNonce give
address identity (research D1); one semantic rules config realizes per network through the existing
V2 ordered-rules engine and installs post-deploy through the existing propose/approve/execute
machinery (D2/D3); a new synced creation record makes later growth possible (D4). **No contract,
subgraph, gateway, or dependency changes.**

## Technical Context

**Language/Version**: JavaScript (ES2022), React 18, Vite (rolldown) — existing frontend stack

**Primary Dependencies**: ethers v6, wagmi/viem (already present); NO new dependencies (spec-075 lockfile rules)

**Storage**: userStorage synced objects (`lib/backup/syncedObjects.js`) — new `vaultCreationRecords`; existing `vaultReferences` unchanged

**Testing**: Vitest (unit), Cypress fast tier (no-chain, both viewport profiles) + on-chain tier (hardhat + Safe fixtures via `scripts/e2e/setup-custody-fixtures.js`)

**Target Platform**: Web/PWA + Capacitor shells (no native-seam work: no new device capability)

**Project Type**: Web application (frontend workspace member)

**Performance Goals**: Creation flow interactive < 1 s per sheet; per-network status updates as receipts land; cross-chain reads keep the existing 20 s per-chain ceiling

**Constraints**: Constitution III (honest state — statuses re-derived from chain, never fabricated; drift disclosed); spec-102 chain abstraction invariants; spec-069 provider seam; write rail is signer-first (writeRail.js); brand tokens only (spec 090/091)

**Scale/Scope**: ~6 custody networks; 4 new sheets, 1 orchestrator hook, 1 store, 1 describe module, Details/Queue/Load rework; ~15 files touched in `frontend/src`

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-checked post-design — PASS (no violations to track).*

- **I. Security-first contracts**: No `contracts/` change. The flow composes EXISTING audited
  primitives (SafeProxyFactory.createProxyWithNonce, SafePolicyGuardV2 setRules/setGuard, Safe
  execTransaction with pre-validated signatures). Fund-custody reasoning: the deployer never holds
  vault funds; rules install through the vault's own threshold machinery; the creation record holds
  public parameters only (no key material, no secrets).
- **II. Test-first**: Every new pure module (records store, rules realization, describeProposal,
  orchestrator reducer) lands with Vitest; sheets get component tests; flows get Cypress in the
  tier admission rules of spec 094 (creation costs money ⇒ on-chain tier coverage; sheet navigation
  and honesty states ⇒ no-chain tier, both viewports). Existing custody suites must stay green (SC-008).
- **III. Honest state**: The core of the design — statuses re-derived from chain (D5), `unreadable`
  never rendered as zero/absence, drift named, "awaiting approval" never shown as active, partial
  shared-facts labelled. No mocks in shipped paths; fixtures live under test scopes.
- **IV. Fail loudly in CI**: no workflow changes; new tests join existing gating jobs.
- **V. Accessible, consistent frontend**: WCAG 2.1 AA; sheets reuse `ActionSheet` semantics; tile
  grid is buttons with visible state, not divs; `cy.a11yScan` on each new sheet; theme tokens only
  (`noHardcodedColors` / `noUndefinedTokens` gates); addresses/ABIs via existing config seams.

**Post-design re-check**: PASS — design adds no new technology, no authoritative second store
(chain remains truth; the record holds only what the chain cannot), and no rule relaxations.

## Project Structure

### Documentation (this feature)

```text
specs/105-multichain-vault-creation/
├── spec.md
├── checklists/requirements.md
├── plan.md              # this file
├── research.md          # Phase 0 (D1–D9)
├── data-model.md        # Phase 1
├── quickstart.md        # Phase 1
├── contracts/
│   ├── creation-record.md        # synced-object schema + merge contract
│   └── deployment-states.md      # per-network state machine + UI contract
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
frontend/src/
├── lib/custody/
│   ├── vaultCreationRecords.js      # NEW — synced record store (D4)
│   ├── vaultRulesConfig.js          # NEW — semantic config ⇄ per-chain V2 rules (D3) + drift compare
│   ├── vaultDeployment.js           # NEW — pure orchestration steps/reducer (D5): probe, deploy, install
│   ├── describeProposal.js          # NEW — plain-language proposal decode (D8)
│   ├── safeVault.js                 # unchanged CREATE2 core (consumed)
│   └── policyV2.js / policyTemplates.js  # consumed; small export additions only if needed
├── hooks/
│   ├── useVaultDeployment.js        # NEW — drives vaultDeployment steps with wallet/rail/switch
│   └── useVaultQueueAcrossChains.js # consumed (chips/needs-you are view state in components)
├── components/custody/
│   ├── createflow/
│   │   ├── CreateVaultFlow.jsx      # NEW — four-sheet controller (replaces CreateVaultWizard mount)
│   │   ├── TypeSheet.jsx            # NEW — Joint / Controlled / Complex + owners
│   │   ├── RulesSheet.jsx           # NEW — tile grid + live summary
│   │   ├── NetworksSheet.jsx        # NEW — multi-select + per-network status (shared w/ deploy-later)
│   │   └── DoneSheet.jsx            # NEW — one card + pending disclosures
│   ├── VaultDetailsView.jsx         # REWORK — one card, network rows, inline Deploy, drift (D7)
│   ├── VaultQueueView.jsx           # REWORK — chips, needs-you, decoded rows (D8)
│   ├── LoadVaultForm.jsx            # RESTYLE — app field chrome (FR-020)
│   └── VaultActionSheet.jsx         # swap CreateVaultWizard → CreateVaultFlow
├── lib/backup/syncedObjects.js      # + vaultCreationRecords registration
└── test/…                           # Vitest beside each module; fixtures under test scope

frontend/cypress/e2e/
├── fast/43-vault-create-flow.cy.js  # NEW — no-chain: sheets, honesty states, a11y (both viewports)
└── full/…                           # on-chain: create-on-2-networks + rules install + deploy-later
frontend/cypress/coverage/matrix.json # + spec 105 rows
```

**Structure Decision**: Frontend workspace member only; new creation UI grouped under
`components/custody/createflow/` so the four sheets and their controller version together; pure
logic in `lib/custody/` so every rule of the orchestration is unit-testable without a wallet.

## Complexity Tracking

No constitution violations. One deliberate scope note: the flow replaces `CreateVaultWizard`
rather than adding a parallel path (Assumption: "no separate legacy create form remains") — two
creation paths would double the money-path test surface for zero member value.
