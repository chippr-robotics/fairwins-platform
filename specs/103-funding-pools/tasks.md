# Tasks: Funding Pools on the Receive View

**Input**: Design documents from `/specs/103-funding-pools/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Required by the constitution (Principle II) and by FR-028/FR-029 — every phase carries
its tests.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [x] T001 Spec, plan, research, data-model, contracts, quickstart written under `specs/103-funding-pools/`
- [x] T002 `.specify/feature.json` points at `specs/103-funding-pools`

## Phase 2: Foundational (blocking)

- [x] T003 [P] `contracts/pools/interfaces/IFundingPool.sol` + `IFundingPoolFactory.sol` per contracts/funding-pool.md
- [x] T004 `contracts/pools/FundingPool.sol` — clone template: contribute (+EIP-3009), close, cancel, voteRefund, claimRefund, pokeDeadline, …WithSig twins, events, CEI + nonReentrant
- [x] T005 `contracts/pools/FundingPoolFactory.sol` — UUPSManaged + SignerIntentBase: createPool(+WithSig), phrase gateway, registry, screen/requireMembership, forwarders, admin; `contracts/mocks/FundingPoolFactoryV2Mock.sol`
- [x] T006 [P] `packages/intent-types/src/index.js` — domains `fundingPool` / `fundingPoolFactory` + DOMAIN_SOURCES + structs CloseFundingPool, CancelFundingPool, VoteRefund, ClaimRefund, CreateFundingPool
- [x] T007 [P] `test/helpers/fundingpool.js` — deploy, token, params, createPool, sign* helpers
- [x] T008 `test/pools/FundingPool.test.js` — lifecycle + every revert (US1–US5 chain semantics)
- [x] T009 [P] `test/pools/FundingPool.withsig.test.js` — twins, replay/expiry/wrong-signer, EIP-3009 contribute
- [x] T010 [P] `test/pools/FundingPool.security.test.js` — invariants I1–I5, randomized sequences (SC-003/SC-004), reentrancy probe with a malicious token
- [x] T011 [P] `test/pools/FundingPoolFactory.test.js` + `FundingPoolFactory.forwarders.test.js` + `test/upgradeable/FundingPoolFactory.upgrade.test.js`
- [x] T012 `npm run compile` + `npx hardhat test test/pools test/upgradeable test/intent` green; `scripts/codegen/abi-manifest.json` + `npm run codegen:abis`; `scripts/deploy/check-storage-layout.js` registration; bytecode baseline re-recorded
- [x] T013 `scripts/deploy/deploy-funding-pool-factory.js`; `package.json` `deploy:local:funding` appended to `setup:e2e` + `setup:local`; `scripts/utils/sync-frontend-contracts.js` key; `.github/workflows/torture-test.yml` step
- [x] T014 `frontend/src/abis/FundingPool.js` + `FundingPoolFactory.js` from artifacts; `frontend/src/config/contracts.js` `fundingPoolFactory` on every chain map (+ HARDHAT from a real `setup:e2e` run, + deploy blocks); `frontend/src/config/serviceCatalog.js` row
- [x] T015 [P] `frontend/src/lib/funding/{fundingContracts,deepLink,progress,myFundingPools}.js` + `frontend/src/test/funding/*.test.js`
- [x] T016 `frontend/src/hooks/useFundingPools.js` + `useMyFundingPools.js` + tests (`useFundingPools.test.jsx`)

## Phase 3: US1 — Start a pool from the Request view (P1)

- [x] T017 [US1] `components/funding/FundingPoolCreatePanel.jsx` + `FundingShareView.jsx` + `funding.css`
- [x] T018 [US1] `components/fairwins/RequestPanel.jsx` — kind switch Request | Pool (one-time flow untouched), "My Pools" button in Pool kind
- [x] T019 [US1] Vitest: `test/funding/FundingPoolCreatePanel.test.jsx`, `RequestPanel.pool.test.jsx` (kind switch, validation, connect CTA, share view contents, axe)

## Phase 4: US2 — Contribute through the shared link (P1)

- [x] T020 [US2] `pages/FundingPoolPage.jsx` + route `/fund/:ref` in `App.jsx`; `FundingProgress.jsx`, `ContributeControl.jsx`, `FundingActivityFeed.jsx`
- [x] T021 [US2] `lib/lookup/resolvePhraseLookup.js` — also resolve against the funding factory (kind `funding`); `UnifiedLookupModal` navigates to `/fund/<addr>`
- [x] T022 [US2] `config/navSearchIndex.js` destination "Pool money" → `/app` (kind pool)
- [x] T023 [US2] Vitest: `FundingPoolPage.test.jsx` (loading/unreadable/open/closed/refunding, wrong network, contribute), `FundingProgress.test.jsx` (a11y), `FundingActivityFeed.test.jsx`, `resolvePhraseLookup.funding.test.js`

## Phase 5: US3 — Organizer closes and collects (P1)

- [x] T024 [US3] Close action + confirm step in `FundingPoolPage.jsx` (amount, destination, finality)
- [x] T025 [US3] Vitest coverage of the close confirm + non-organizer absence

## Phase 6: US4 + US5 — Refunds (organizer, majority, deadline) (P2)

- [x] T026 [US4] `RefundStatusBar.jsx`; vote / cancel / claim / poke actions on the page
- [x] T027 [US4] Vitest: `RefundStatusBar.test.jsx` (votes/needed, collected/total, own standing, a11y)

## Phase 7: US6 — My Pools sheet (P2)

- [x] T028 [US6] `components/funding/MyFundingPoolsSheet.jsx` on `ActionSheet` (find field, Active/Finished, next action, empty state)
- [x] T029 [US6] Vitest: `MyFundingPoolsSheet.test.jsx` (+ axe)

## Phase 8: E2E + visuals + docs

- [x] T030 `frontend/cypress.config.js` chainTx tasks: `createFundingPool`, `contributeFunding`, `voteFundingRefund`, `fundingInfo`, `fundingMemberInfo`
- [x] T031 `frontend/cypress/e2e/fast/42-funding-pools.cy.js` (no chain: kind switch, validation, connect CTA, My Pools empty, deep-link honest unreadable state, a11y)
- [x] T032 `frontend/cypress/e2e/full/39-funding-pools.cy.js` (FP-01 create+contribute, FP-02 close, FP-03 majority refund + collect, FP-04 deadline refund, FP-05 organizer refund) judged by chain reads
- [x] T033 `frontend/cypress/coverage/matrix.json` row `103-funding-pools`; `npm run e2e:matrix`; e2e-policy Vitest suites green
- [x] T034 `scripts/ui/capture-funding-pools.mjs`; run the loop; `specs/103-funding-pools/screenshots/README.md`
- [x] T035 `docs/developer-guide/funding-pools.md`, `mkdocs.yml`, `CLAUDE.md` guardrail bullet, `specs/103-funding-pools/implementation-notes.md` (security self-review + gate results)
- [x] T036 Gate sweep: compile, bytecode compare, check:deps, storage-layout, check:abis, contract tests, scoped vitest, frontend lint; commit, push, PR

## Dependencies

T003→T004→T005→(T008..T011)→T012→T013→T014→(T015,T016)→T017..T029→T030..T036. T006 and T007 in
parallel with T004/T005. US1 and US2 are the MVP; US3–US6 layer on the same page/hook.
