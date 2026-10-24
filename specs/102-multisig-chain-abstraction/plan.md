# Implementation Plan: Multisig Chain Abstraction (spec 102)

**Branch**: `claude/multichain-experience-improvements-7z3wti` | **Date**: 2026-09-03 | **Spec**: `spec.md`
**Input**: `spec.md`, `research.md`

## Summary

Turn "one card per (chain, address)" into "one card per vault" in Protect, move every per-vault
action behind a three-view bottom sheet (Queue / Style / Details), read the proposal queue on
every chain the vault lives on with a per-row network tag, switch the wallet at the moment of an
action instead of asking up front, and let the member pick the acting account from the sheet.
Plus the one shared display formatter the Wrap/Transfer surfaces were missing. Frontend only.

## Technical Context

**Language/Version**: JavaScript (ES2022), React 19, Vite 8, Vitest, Cypress
**Primary Dependencies**: ethers v6 (already), wagmi (already), no additions — a new dependency
would re-resolve the root lockfile (spec 075 hazard) and nothing here needs one
**Storage**: existing `custody_vault_references` (userStorage) and `fw_account_profiles_v1`
(device); NO new keys
**Testing**: Vitest (unit/component, `vitest-axe`), Cypress fast tier (+ one on-chain case),
actor-critic screenshots (`scripts/ui/capture-vault-sheet.mjs`)
**Target Platform**: PWA, mobile-first (390px) and desktop
**Project Type**: web frontend (workspace member `frontend/`)
**Constraints**: constitution III (three-state reads, never zero-for-failed), spec 068 (state
changes on the vault's own chain, strict `NETWORKS[chainId]`), spec 088 (no signer fall-through,
address-only switching), spec 086 (one `AccountCard`, cosmetics unsynced), spec 090/091 (tokens
only in CSS), spec 094 (matrix row, assertion depth)

## Constitution Check

| Principle | Status | Note |
|---|---|---|
| I. Security-first contracts | n/a | No contract change. |
| II. Test-first | PASS | Unit tests for every new lib/hook; component tests per view; Cypress fast tier VS-01…VS-09 and on-chain CV-08; matrix row. |
| III. Honest state | PASS | Per-chain queue read is four-state (`read`/`unreadable`/`not-configured`/`not-supported`); totals labelled partial and named; threshold "varies by network" when instances disagree; formatter never coerces `null` to 0. |
| IV. Fail loudly in CI | PASS | New tests join existing gates; no `continue-on-error`. |
| V. Accessible, consistent UI | PASS | `ActionSheet` (focus trap), `role=tablist` with arrow keys, axe in Vitest + Cypress, both viewports in screenshots; `AccountCard` reuse. |
| Simplicity | PASS | No new primitives, no new store, no new dependency. Two modules (`vaultGroups`, `format/amount`) are pure functions with tests. |

**Complexity tracking**: none required.

## Project Structure (this feature)

```
specs/102-multisig-chain-abstraction/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md, tasks.md
└── screenshots/ (README.md + PNGs from the actor-critic loop)

frontend/src/
├── lib/custody/vaultGroups.js                 NEW  pure grouping + chain pick + queue summary
├── lib/format/amount.js                       NEW  formatUnitsForDisplay
├── hooks/useVaultQueueAcrossChains.js         NEW  per-instance proposal reads
├── hooks/useCustodyVaults.js                  MOD  groups, load-all, forgetVault(address), probe
├── hooks/useActiveAccount.js                  MOD  vault submit auto-switch; canActAsVault
├── hooks/useAccountSwitcher.js                MOD  one entry per vault address (chainIds)
├── contexts/CustodyContext.jsx                MOD  operateAsVault({chainIds}); follow wallet chain
├── components/account/AccountCustomizeSheet.jsx MOD  body extracted to AccountCustomizeBody.jsx
├── components/account/AccountCustomizeBody.jsx NEW  (sheet-less body; used by Style view)
├── components/custody/VaultCardList.jsx       NEW  listbox of AccountCard tiles + "⋯"
├── components/custody/VaultSheet.jsx          NEW  ActionSheet + tablist + three views
├── components/custody/VaultQueueView.jsx      NEW
├── components/custody/VaultStyleView.jsx      NEW
├── components/custody/VaultDetailsView.jsx    NEW  (+ VaultOwnerRow.jsx)
├── components/custody/VaultSheet.css          NEW
├── components/custody/CustodyPanel.jsx        MOD  wire list + sheet + ?vault= deep link
├── components/custody/LoadVaultForm.jsx       MOD  load-all copy; "Check again"
├── components/custody/VaultDetail.jsx         MOD  `variant="network"` (facts+policy only)
├── components/custody/VaultList.jsx           DEL  (replaced by VaultCardList)
├── components/wallet/WrapView.jsx             MOD  formatter
├── components/wallet/TransferForm.jsx         MOD  formatter
├── components/ui/UniversalAssetSelect.jsx     MOD  formatter
└── test/…                                     see tasks.md

frontend/cypress/e2e/fast/42-protect-vault-sheet.cy.js   NEW
frontend/cypress/e2e/full/29-protect-custody.cy.js       MOD (CV-08)
frontend/cypress/coverage/matrix.json                    MOD (+ generated doc)
scripts/ui/capture-vault-sheet.mjs                       NEW
docs/developer-guide/protect-policies.md                 MOD (section: one vault, every network)
```

## Design

### D1 — Grouping is a view over the unchanged store

`lib/custody/vaultGroups.js#groupVaults(vaults, { walletChainId })` folds the enriched per-chain
vault objects from `useCustodyVaults` into one `VaultGroup` per lowercased address (shape in
`data-model.md`). `useCustodyVaults` exposes `groups` (memo) beside the existing `vaults`, so
every consumer that still wants instances (VaultActionSheet's propose/approve, the policy panels)
keeps its input. `activeVault` keeps meaning "the instance on the connected chain for the
selected address, else the pinned instance".

### D2 — Load-all

`loadByAddress` upserts a reference for EVERY `matches[i]` (role computed per instance) and
`ensureVaultContact` for each chain; returns `{ added: [chainIds], unreachable }`. `LoadVaultForm`
closes on success and reports "Found on Polygon, Base and Optimism"; when `unreachable.length`,
it shows "Not checked on X, Y — Check again" and stays open only if nothing was added.
`probeVault(address)` (new) re-runs the probe for an existing group and adds new matches only.

### D3 — Compact card

`VaultCardList` renders `<ul role="listbox" aria-label="Your vaults">`; each `<li>` holds an
`AccountCard` (`account={{kind:'vault', address, label}}`, `active={isActing}`,
`network={group.networkLine}`, `balance={<VaultCardMeta/>}` — threshold · policy badge · pending)
and, OUTSIDE the option, the "⋯" button (`aria-label="Open <label> vault"`,
`data-testid="vault-menu-<lower addr>"`). Selecting the option and pressing "⋯" both call
`onOpen(address, view)`; the option opens on Queue.

### D4 — The sheet

`VaultSheet({ open, address, initialView, onClose })` re-resolves `group` from
`useCustodyVaults().groups` each render (a vanished vault closes). Built on `ActionSheet`
(`title` = label, `className="vault-sheet"`). Header: avatar + label + short address + network
line; then `<div role="tablist" aria-label="Vault views">` with three `role="tab"` buttons
(Arrow keys move, Home/End), `aria-controls` → the one mounted `role="tabpanel"`.

**Queue** — `useVaultQueueAcrossChains(group)` (D5) → rows sorted newest-first, each a
`ProposalQueue`-style row plus `<NetworkPill chainId name/>`. Row actions go through
`useVaultProposals(activeInstance)` (the instance on the connected chain). Tap on a row whose
chain ≠ wallet chain: `await switchNetwork(row.chainId)` → set `pendingAction` → an effect runs
the action once `useVaultProposals` reports `onVaultChain` for that chain, then
`queue.refresh(row.chainId)`. Refusal → per-row `role="alert"` naming both chains. Below the rows,
a `<ul>` of per-chain read status lines with Retry on `unreadable`.

**Style** — `AccountCustomizeBody` (extracted verbatim from `AccountCustomizeSheet`, which now
wraps it) with `account={{address, label, kind:'vault'}}`.

**Details** — full address + copy; per-network `<section>` list: Safe version, threshold, role,
reachability, and the policy block (`VaultDetail variant="network"` → `PolicyPanelV2`/`PolicyPanel`
with `onPropose` only when connected there); owners (`VaultOwnerRow` → `useOpponentName` +
"You" + source chip + "Add to address book" → `addContact({nickname: generated label,
addresses: group.chainIds.map(...)})`); **Acting account** `<ul role="radiogroup">` from
`useAccountSwitcher` (deduped); **Remove from Protect** with inline confirm →
`forgetVault(address)`.

### D5 — Cross-chain queue reads

`useVaultQueueAcrossChains(group)` runs, per instance with `isSafe`: hub address + deploy block
for that chain → `not-configured` if either missing; `NETWORKS[chainId]` missing →
`not-supported`; else `readVerifiedProposals` + `readExecutionOutcomes` + `approvedHashes` through
`getProvider(chainId)` (the connected provider when on that chain) → `read` (with `partial` from
`complete:false`) or `unreadable` (error message kept). Returns `{ byChain, rows, pending, partial,
missing:[chainIds], refresh(chainId?) }`. Request-id guard per chain (the `reqId` pattern).

### D6 — Acting identity follows the wallet where it can

`operateAsVault({ address, chainIds, chainId?, label })` stores `chainIds` and computes
`chainId = pickVaultChain({ chainIds, walletChainId, preferred: chainId })`. An effect in
`CustodyProvider` re-runs `pickVaultChain` on wallet chain change and updates `active.chainId`
only when the wallet's chain is in `chainIds` (otherwise the pin holds). `useActiveAccount.submit`
(vault branch): when `Number(chainId) !== active.chainId`, mirror `useEarnSend.sendOnChain` —
`switchNetwork(active.chainId)`, then poll a `latestRef` until `chainId` and `signer` settle
(same timeouts), then `submitAsActiveAccount` with the settled signer/provider. `canActAsVault`
= `isVault && (onChain || canSwitch)`; a new `actingVaultChainName` is exposed for confirm UIs.

### D7 — Formatter

`lib/format/amount.js#formatUnitsForDisplay(raw, decimals, { maxFractionDigits } = {})`:
`null/undefined → null`; bigint/string base units → `Number` of `formatUnits`; `0 → '0'`;
`0 < v < 1e-6 → '< 0.000001'`; `< 1 → up to 6 fraction digits`; else up to 4; `toLocaleString`
with `useGrouping`. Wrap tiles/Balance line/gas-reserve hint, Transfer `Balance:`, and
`UniversalAssetSelect` option balances render through it. `MAX` and anything passed to
`parseUnits` keep full precision.

### D8 — Deep link

`CustodyPanel` reads `vault` from the URL search params (the tab already reads `tab`); a
matching group opens the sheet on Queue; the param is removed on close (history replace).

## Testing strategy

- **Unit** (`frontend/src/test/custody/`): `vaultGroups.test.js` (grouping, varies-by-network,
  unreachable-only group, `pickVaultChain`, `summarizeQueue` partial naming);
  `useVaultQueueAcrossChains.test.jsx` (four states, per-chain isolation, refresh one chain);
  `CustodyContext.followChain.test.jsx`; `useActiveAccount.vaultSwitch.test.jsx` (switch then
  submit; refusal names both chains; no fall-through); `useAccountSwitcher.dedupe.test.jsx`;
  `VaultCardList.test.jsx` (one card per address, active mark, "⋯" outside the option, axe);
  `VaultSheet.test.jsx` (tabs + keyboard, re-resolve, close on vanish, axe);
  `VaultQueueView.test.jsx` (pills, partial total, switch-then-act, refusal alert, view-only row);
  `VaultDetailsView.test.jsx` (owner sources, "You", add-to-book re-render, acting list, remove-all);
  `LoadVaultForm.test.jsx` updated (load-all copy; no "Use X" buttons);
  `format/amount.test.js`; `WrapView.test.jsx` + `TransferForm` + `UniversalAssetSelect` cases.
- **Cypress fast** `42-protect-vault-sheet.cy.js`: seeds `fw_user_<addr>_custody_vault_references`
  with two chains for one address and one for another; stubs the two chains' JSON-RPC endpoints
  with `cy.intercept` (ABI-encoded `getOwners`/`getThreshold`/`nonce`/`approvedHashes`/`getLogs`)
  so the queue is REAL data through the app's own read path — VS-01 one card per vault;
  VS-02 "⋯" opens the sheet on Queue with network-tagged rows from both chains; VS-03 an
  unreadable chain is named, total partial; VS-04 Approve on the other chain requests a switch
  and a refusal is stated (`rejectChainSwitch`); VS-05 Style changes the card behind the sheet;
  VS-06 Details owner cross-reference + add to address book; VS-07 acting account chosen from the
  sheet, header avatar follows, switcher shows ONE entry for the vault; VS-08 Remove from Protect
  removes both references; VS-09 load-all copy (probe stubbed on 2 chains); VS-A11Y.
- **Cypress full** `29-protect-custody.cy.js` CV-08: the sheet's Queue approves and executes a
  proposal on the private chain (money path — on-chain tier).
- **Screenshots**: `capture-vault-sheet.mjs`, scenarios `cards`, `sheet-queue`, `sheet-style`,
  `sheet-details`, `load-all`, `wrap-balance` × 2 viewports × 2 themes.

## Risks

- `useVaultProposals` actions close over the connected signer: the "pending action after switch"
  effect exists precisely so the action runs with the REBOUND hook, never a stale signer.
- The Cypress RPC stub must answer `eth_chainId` correctly per URL or ethers refuses the
  provider; the helper asserts this.
- `AccountCard` is `role=option`; the wrapping `listbox` must be the ONLY parent with a role.
