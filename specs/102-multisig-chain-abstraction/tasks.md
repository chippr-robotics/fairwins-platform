# Tasks: Multisig Chain Abstraction (spec 102)

Legend: `[P]` parallel-safe; `US#` user story from spec.md. Paths relative to repo root.

## Phase 1 — Pure logic + hooks (lane A)

- [x] T001 [P] `frontend/src/lib/custody/vaultGroups.js`: `groupVaults`, `pickVaultChain`,
      `summarizeQueue` per data-model.md. Tests `frontend/src/test/custody/vaultGroups.test.js`.
- [x] T002 `frontend/src/hooks/useCustodyVaults.js`: expose `groups`; `loadByAddress` adds EVERY
      match (US2); `forgetVault(address)`; `probeVault(address)`; `activeVault` = connected
      instance else pinned. Update `frontend/src/test/custody/loadVaultAcrossChains.test.jsx` +
      `useCustodyVaults.multichain.test.jsx`.
- [x] T003 `frontend/src/hooks/useVaultQueueAcrossChains.js` (D5) + test.
- [x] T004 `frontend/src/contexts/CustodyContext.jsx`: `operateAsVault({chainIds})`, follow
      wallet chain (D6) + `CustodyContext.followChain.test.jsx`.
- [x] T005 `frontend/src/hooks/useActiveAccount.js`: vault submit auto-switch, `canActAsVault`,
      `actingVaultChainName` + `useActiveAccount.vaultSwitch.test.jsx`.
- [x] T006 [P] `frontend/src/hooks/useAccountSwitcher.js`: one entry per vault address with
      `chainIds` + test.
- [x] T007 `frontend/src/components/custody/LoadVaultForm.jsx`: load-all copy, "Check again",
      remove "Use X" buttons; update `LoadVaultForm.test.jsx`.

## Phase 2 — Components (lane B)

- [x] T010 [P] `components/account/AccountCustomizeBody.jsx` extracted from
      `AccountCustomizeSheet.jsx` (sheet wraps body; existing tests unchanged).
- [x] T011 `components/custody/VaultCardList.jsx` + CSS in `VaultSheet.css` (US1, FR-002) + test.
- [x] T012 `components/custody/VaultSheet.jsx` (ActionSheet + tablist, re-resolve, deep-link
      prop) + test.
- [x] T013 `components/custody/VaultQueueView.jsx` (US3, FR-005…008) + test.
- [x] T014 [P] `components/custody/VaultStyleView.jsx` (US4) + test.
- [x] T015 `components/custody/VaultDetailsView.jsx` + `VaultOwnerRow.jsx` (US5, FR-010…012,
      FR-015) + `VaultDetail.jsx variant="network"` + tests.
- [x] T016 `components/custody/CustodyPanel.jsx`: replace `VaultList` with `VaultCardList` +
      `VaultSheet`; `?vault=` deep link (FR-017); delete `VaultList.jsx`; update
      `CustodyPanel.test.jsx`, `VaultDetail.test.jsx`.

## Phase 3 — Formatter (lane C)

- [x] T020 [P] `frontend/src/lib/format/amount.js` + `frontend/src/test/format/amount.test.js`.
- [x] T021 `components/wallet/WrapView.jsx`, `components/wallet/TransferForm.jsx`,
      `components/ui/UniversalAssetSelect.jsx` render through it (US7); tests extended.

## Phase 4 — E2E + matrix

- [x] T030 `frontend/cypress/e2e/fast/42-protect-vault-sheet.cy.js` VS-01…VS-09 + VS-A11Y, with
      the JSON-RPC intercept helper in `frontend/cypress/support/vaultRpcStub.js`.
- [x] T031 `frontend/cypress/e2e/full/29-protect-custody.cy.js` CV-08.
- [x] T032 `frontend/cypress/coverage/matrix.json` row + `npm run e2e:matrix`.

## Phase 5 — Visual validation + docs

- [x] T040 `scripts/ui/capture-vault-sheet.mjs`; actor-critic rounds recorded in
      `specs/102-multisig-chain-abstraction/screenshots/README.md`.
- [x] T041 `docs/developer-guide/protect-policies.md` section "One vault, every network";
      CLAUDE.md guardrail bullet.
- [x] T042 Gates: scoped vitest, `npm run lint --workspace frontend`, brand guards, e2e-policy
      tests, `check:e2e-matrix`.
