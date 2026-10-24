# Tasks: Guided Multichain Vault Creation — One Vault, Chosen Networks

**Feature**: 105 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

Ordered by dependency. `[P]` marks tasks touching disjoint files that may run in parallel.

---

## Phase A: pure logic (everything testable without a wallet)

- [ ] **T-001** `frontend/src/lib/custody/vaultCreationRecords.js` — synced record store
  (contracts/creation-record.md): load/get/save/merge; save refuses overwriting a differing record;
  merge is union-by-address, existing-wins, deterministic. Register in `lib/backup/syncedObjects.js`
  (non-network-scoped, spec-062 precedent).
- [ ] **T-002** `frontend/src/lib/custody/vaultRulesConfig.js` — SemanticRules ⇄ per-chain V2 rules
  (research D3): banded everyday lane + identical-scope big-send lane + catch-all per
  `allowedMoney`; validates via `validateRulesConfig(rules, cooldown, { owners })`; summary via
  `describeRulesV2`; `{ inapplicable }` for a chain with no stable; `compareRealizedRules` for
  drift detection against `readPolicyV2` output.
- [ ] **T-003** `frontend/src/lib/custody/vaultDeployment.js` — pure orchestration
  (contracts/deployment-states.md): plan builder (chain-independent initializer via
  `buildSetupInitializer` + canonical fallback handler, NO policySetup; per-vault saltNonce),
  per-network step list (probe → deploy → install setRules → install setGuard OR propose+approve),
  state reducer with `already-live`, per-stage `failed{stage,reason}`, rules sub-state.
- [ ] **T-004** `frontend/src/lib/custody/describeProposal.js` — plain-language decode (D8):
  native/ERC-20 transfer, addOwnerWithThreshold/removeOwner/swapOwner/changeThreshold, policy via
  `classifyPolicyProposalV2`; unknown ⇒ `null`, never a guess. Plus `needsYou(proposal, member)`.
- [ ] **T-005** [P] Vitest for T-001..T-004 under `frontend/src/test/custody/`. The refusing/honest
  cases are the feature: record overwrite refused; initializer replay reproduces the recorded
  address on two chainIds (pure `computeVaultAddress`); over-cap send matches the big-send lane in
  `matchPreview` (band verified); no-stable chain discloses inapplicable tiles; reducer never
  fabricates progress (a probe failure is `unreadable`, not `not-deployed`); `describeProposal`
  returns null for unknown calldata; needs-you truth table (owner/approved/pending).

## Phase B: the orchestrator hook

- [ ] **T-006** `frontend/src/hooks/useVaultDeployment.js` — drives T-003 steps: per network
  resolve `resolveWriteRail` first (reason rendered before any attempt), switch wallet at that
  network's turn (spec-102 switch-first precedent), signer rail sequential txs / passkey rail one
  `sendCalls` batch where creator meets threshold, propose+approveHash via existing machinery
  where not; re-derives status on mount (getCode probe + `readPolicyV2` + hub read); records the
  creation record ONCE on first successful deploy; upserts vault references per live network.
- [ ] **T-007** [P] Hook tests: rail-unavailable renders reason and attempts nothing; refused
  switch fails only that network's row naming both chains; retry re-enters the failed stage only;
  reopen re-derives (a live network never re-deploys; `already-live` from a probe).

## Phase C: the four sheets (US1)

- [ ] **T-008** `components/custody/createflow/CreateVaultFlow.jsx` + `TypeSheet.jsx` — controller +
  presets (Joint 2-owners/1-sig; Controlled n-of-n; Complex m-of-n with the existing threshold
  control), owners via `CustodyAddressField`, the 1-of-1-no-rules refusal in plain language.
- [ ] **T-009** `RulesSheet.jsx` — tile grid (Daily cap / Wait / Allowed money / Big sends), edit in
  place, live summary line from T-002; tiles are real buttons with visible state.
- [ ] **T-010** `NetworksSheet.jsx` — cohort custody multi-select, predicted address before first
  signature, per-network status rows driven by T-006 (shared component with deploy-later),
  rail-unavailable reasons in place, safe-to-leave copy.
- [ ] **T-011** `DoneSheet.jsx` — one card, badges per live network, pending disclosures
  (confirming / rules awaiting approval / failed+retry).
- [ ] **T-012** Swap `VaultActionSheet` create branch to `CreateVaultFlow`; retire
  `CreateVaultWizard` mount (file removed with its tests migrated); keep `onPreview`/`onCreate`
  seams in `useCustodyVaults` (extended for multi-network via T-006, single-chain path preserved
  for the on-chain fixtures).
- [ ] **T-013** [P] Component tests per sheet: preset semantics, tile edits update summary,
  network rows honesty, done-sheet pending states, refusal copy.

## Phase D: Details one card (US2/US3)

- [ ] **T-014** Rework `VaultDetailsView.jsx` (D7): address block + "same address on every chain"
  (only when true over READ instances); NETWORKS rows (live w/ arrangement / confirming /
  unreadable+retry / not-deployed+Deploy) — Deploy gated on a creation record, honest reason
  otherwise (FR-018); OWNERS once, identity-resolved; RULES once from record cross-checked per
  chain (drift names the network; coverage labelled); acting-as + Remove unchanged.
- [ ] **T-015** Deploy-later path: network row → NetworksSheet preselected to that chain; FR-017
  original-owners disclosure when live owners differ from the record; FR-019 already-live.
- [ ] **T-016** [P] Tests: one-card render for N networks; drift disclosure; unreadable coverage
  label; no-record reason; original-owners confirmation gate.

## Phase E: Queue readability (US5)

- [ ] **T-017** Rework `VaultQueueView.jsx`: chips (All / Needs you+count / per-network-with-items)
  as pure view state over `useVaultQueueAcrossChains` (four-state honesty untouched); rows through
  `describeProposal` (null ⇒ existing raw rendering); "N of M signed · needs you"/"waiting on
  <owner>" via identity resolution; primary Review & sign; footer sentence.
- [ ] **T-018** [P] Tests: chip filtering never hides the partial-total disclosure; needs-you
  count; decoded vs raw rows; existing queue tests stay green.

## Phase F: Load restyle (US4)

- [ ] **T-019** [P] Restyle `LoadVaultForm.jsx` to the app field chrome (tokens only; both themes;
  36px targets); behaviour untouched — existing tests must pass unmodified.

## Phase G: e2e + matrix + docs

- [ ] **T-020** `frontend/cypress/e2e/fast/43-vault-create-flow.cy.js` — no-chain: sheet
  navigation, presets, tiles+summary, network honesty states, details one-card + drift (loopback
  RPC stubs, spec-102 pattern), queue chips/decoded rows, load restyle, `cy.a11yScan` per sheet.
  Update `fast-tier` weights note (unmeasured spec is announced).
- [ ] **T-021** On-chain tier: extend the custody full spec — create Joint via the flow, address
  matches prediction, rules installed (three-lane `readPolicyV2`), over-cap send refused by
  preview, deploy-later same address, Controlled leaves rules queued as awaiting-approval.
- [ ] **T-022** `frontend/cypress/coverage/matrix.json` rows for spec 105 + `npm run e2e:matrix`
  regenerate; tierSharding/assertionDepth policies satisfied.
- [ ] **T-023** Docs: `docs/developer-guide/protect-policies.md` § creation flow + creation
  records; CLAUDE.md guardrail bullet (one vault created everywhere; record store; rules install
  post-deploy; never put policy in a multichain initializer).
- [ ] **T-024** Gates + validation: scoped Vitest suites, frontend lint + build, actor-critic
  screenshots (both themes × viewports) recorded under `screenshots/`.
