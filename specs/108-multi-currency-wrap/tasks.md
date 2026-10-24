# Tasks: Multi-Currency Wrap/Unwrap

**Input**: Design documents from `/specs/108-multi-currency-wrap/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md (all present)

**Tests**: included — constitution II binds (money path; behavior is not done until tests prove it), and the two reserved matrix rows must flip to `covered` with real specs in this feature.

**Organization**: grouped by the spec's two user stories. US1 (wrap any base coin from one picker) is the MVP; US2 (honest balances and honest absences) hardens the read layer and is testable independently.

## Phase 1: Setup

*(No project initialization needed — existing workspace member, no new dependencies. The spec-075 rule stands: nothing here may touch package.json/lockfile.)*

- [ ] T001 Re-read the seams the plan binds to before changing them: `frontend/src/config/wrappedNative.js`, `frontend/src/hooks/useWrapNative.js`, `frontend/src/hooks/useEarnSend.js` (settle loop), `frontend/src/contexts/WalletContext.jsx` (`sendCalls` `{chainId}` override), `frontend/src/config/passkeySupport.js`, `frontend/src/lib/portfolio/batchBalances.js`, `frontend/src/components/ui/UniversalAssetSelect.jsx`

## Phase 2: Foundational (blocking for both stories)

- [ ] T002 Add `listWrappableCoins()` to `frontend/src/config/wrappedNative.js`: `cohortChainIds().filter(hasWrappedNative)` → WrappableCoin options per data-model.md (native + wrapped keys, network name, verbatim `getWrappedNative` twin); returns `[]` when none
- [ ] T003 [P] Unit-cover it in `frontend/src/test/wallet/wrappedNative.test.js`: mainnet cohort lists 1/10/61/137/8453/42161; Sepolia/Hoodi absent (absent, not disabled); never crosses the cohort; wrapped twin is the resolver's own object

## Phase 3: US1 — Wrap any base coin from one picker (P1, MVP)

**Goal**: pick any cohort coin you hold; the app resolves the wrapper and retargets the write at submit time. **Independent test**: quickstart's on-chain leg — wallet on chain A, wrap chain B's coin end-to-end with the switch prompt, plus the refused-switch arm.

- [ ] T004 [US1] Give `useWrapNative` an explicit target in `frontend/src/hooks/useWrapNative.js`: accept `{ chainId }` (default = wallet chain, byte-compatible); re-bind ALL reads to the target (`getWrappedNative(target)`, `getReadProvider(target)` — replacing the hand-built `makeReadProvider(net.rpcUrl)`, fee-data gas reserve, sponsorship, on-chain `symbol()`)
- [ ] T005 [US1] Add the write-rail derivation + retargeting in `frontend/src/hooks/useWrapNative.js` per data-model's WrapWriteRail: classic same-chain (plain), classic cross-chain (switch-then-settle: `switchNetwork(target)`, 150 ms poll on a render-updated `latestRef` until `chainId === target && signer`, 20 s timeout, refusal names BOTH chains and sends nothing), passkey `sendCalls(calls, { chainId: target })` gated on `isPasskeySupported(target)` with `getPasskeySupport(target).reason` exposed, acting-account refusals unchanged
- [ ] T006 [P] [US1] Unit-cover the retargeted hook in `frontend/src/test/wallet/useWrapNative.test.jsx`: target rebinding, switch-refusal arm (error names both chains, `sendTransaction` never called), settle-timeout arm, passkey chain override passed through, unsupported-passkey rail exposed as `unavailable` + reason, default-target callers byte-compatible
- [ ] T007 [US1] Rework `frontend/src/components/wallet/WrapView.jsx`: coin picker (`UniversalAssetSelect`, options from T009's hook, network name on every row, `pinPredicate` = non-zero read balance) replaces the implicit connected chain; amount CLEARS on selection/direction change; submit copy discloses a pending switch ("Wrap on <network> — your wallet will switch"); `unavailable` rail renders its reason in place of the button; fee line names the target coin
- [ ] T008 [P] [US1] Unit-cover the view in `frontend/src/test/wallet/WrapView.test.jsx`: picker renders cohort coins, amount resets on re-selection, switch disclosure appears exactly when wallet chain ≠ target, refusal/`unavailable` states render their reasons, existing single-chain assertions still pass

## Phase 4: US2 — Honest balances and honest absences (P2)

**Goal**: the picker's numbers are settled per-chain reads with failure isolation. **Independent test**: fast-tier spec with one chain's RPC stub refusing — its row shows "—", others unaffected.

- [ ] T009 [US2] Create `frontend/src/hooks/useWrapCoinOptions.js`: candidates from `listWrappableCoins()`, per-chain balances via `readBalancesSettled` + `getReadProvider(chainId)` (direction decides native vs wrapped leg), CoinBalanceReading states per data-model (`null` survives; `pending`/`read`/`unreadable`), refresh on `useEndpointsRevision`
- [ ] T010 [P] [US2] Unit-cover it in `frontend/src/test/wallet/useWrapCoinOptions.test.jsx`: one rejecting chain isolates (others read), `null` never becomes `0n`, provider absence = `unreadable`, options stay selectable while unreadable

## Phase 5: E2E + coverage bookkeeping

- [ ] T011 [P] Fast-tier spec `frontend/cypress/e2e/fast/<NN>-wrap-multi-currency.cy.js`: picker lists cohort coins with network names; a refused-RPC chain renders "—" (assert NOT "0"); unconfigured chains absent; both-rails RPC stubs (`publicnode|drpc`, issue #1463 rule); amount resets on re-selection
- [ ] T012 Full-tier spec (extend `frontend/cypress/e2e/full/` per the tier split): cross-chain wrap — wallet on the local chain A fixture, select chain B's coin, approve the switch, wrap executes against B's wrapper (assert wrapped balance read from B); refused-switch leg asserts the both-chains error and zero movement; unwrap leg back
- [ ] T013 Flip both matrix rows to `covered` with their test references in `frontend/cypress/coverage/matrix.json`, then `npm run e2e:matrix` (regenerate `docs/developer-guide/e2e-coverage-matrix.md`) and `npm run check:e2e-matrix`

## Phase 6: Polish & cross-cutting

- [ ] T014 [P] Actor-critic screenshot loop over the reworked Wrap view (both themes × both viewports) via the `actor-critic-screens` skill; record under `specs/108-multi-currency-wrap/screenshots/`
- [ ] T015 [P] Document the surface in `docs/developer-guide/` (extend the Trade/wrap section wherever it lives; note the one-resolver rule and the submit-time switch) and add the spec-108 guardrail paragraph to `CLAUDE.md`
- [ ] T016 Gates: scoped Vitest (`src/test/wallet/`, `src/test/e2e-policy/`), `npm run check:specs`, `npm run check:e2e-matrix`, monorepo-verify pass (byte gates expected no-op — no dependency changes); then push and open the feature PR into `staging` with line-anchored `Closes #1439`

## Dependencies

- T002 → everything (the candidate list is the spine)
- T004 → T005 → T007; T009 → T007 (view consumes both hooks)
- T011 depends on T007+T009; T012 on T005+T007; T013 on T011+T012
- US1 and US2 are independently testable once Phase 2 lands: US1 with a stub option list, US2 against the read layer alone

## Parallel opportunities

- T003 beside T004 (different files); T006/T008/T010 in parallel once their subjects exist; T011 beside T012 (different tiers); T014/T015 in parallel after Phase 5

## MVP scope

Phases 2+3 (T002–T008): the picker with retargeted submit on the classic and passkey rails, unit-proven. Phases 4–6 complete the honesty layer, e2e admission-rule obligations, and shipping polish.
