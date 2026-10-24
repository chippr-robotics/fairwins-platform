# Research: Multisig chain abstraction (spec 102)

Consolidated from four scoped research passes over the current tree (2026-09-03). File:line
references are to the pre-102 tree; the plan cites them as the seams the feature attaches to.

## R1 — The Protect ▸ On chain surface today

- `components/custody/CustodyPanel.jsx:35-120` (`OnChainSection`) renders ONE "Vault actions"
  button (`custody-open-vault-actions`) → `VaultActionSheet` (create/load/propose/approve), then
  `VaultList`.
- `VaultList.jsx` renders one `AccordionSection` **per `(chainId, address)` reference**. Its title
  packs kind pill + label + short address + `PolicyBadge`; `badge` is the chain name; `summary` is
  `"T-of-N · owner|view-only"`; the body is the full `VaultDetail` (facts `<dl>`, owners list,
  policy panel, remove) plus `VaultProposalsPanel` when expanded. Selecting = expanding.
- **Consequence for multi-chain**: a Safe deployed at the same address on 6 networks is SIX cards,
  each carrying its own chain badge, each with its own expanded detail. The screenshot's "This
  address is a Safe on 6 networks. Polygon was added — pick another" prompt (`LoadVaultForm.jsx:67-83`)
  is the entry point to that model: the member is asked to choose a chain before they have any
  reason to care which one.
- The store (`lib/custody/vaultReferences.js`) keys references by `vaultKey(chainId, address)`;
  records are `{address, chainId, label, addedAt, role}` under `custody_vault_references`
  (userStorage, wallet-scoped, synced via spec 032 backup). `useCustodyVaults.js:90-135` enriches
  each reference with a per-chain read (`getProvider(chainId)`; failure isolates to ONE row:
  `reachable:false`). **The store shape does not need to change** — grouping by address is a view.
- `useCustodyVaults.loadByAddress` (`:164-214`) already searches every custody chain
  (`findVaultAcrossChains`, `lib/custody/safeVault.js:245`), returns `{matches, unreachable}`, and
  upserts exactly ONE reference (the "picked" chain). Adding every match is a one-loop change.
- Proposal discovery (`hooks/useVaultProposals.js`) reads ONLY when the connected wallet is on the
  vault's chain (`onVaultChain`, `:44`) using the wallet's provider. `readVerifiedProposals`
  (`lib/custody/proposalHub.js:104`) itself is provider-agnostic — it takes `{hubAddress,
  safeAddress, chainId, provider, fromBlock}` — so a per-chain read through `getProvider(chainId)`
  is a hook change, not a lib change. Hub deploy block per chain is mandatory
  (`getDeploymentBlockForChain('safeProposalHub', chainId)`) else discovery is honestly
  "not configured".
- Acting identity: `contexts/CustodyContext.jsx:81-92` `operateAsVault({address, chainId, label})`
  stores ONE chainId; `hooks/useActiveAccount.js:68-80` `submit()` in vault mode uses
  `active.chainId` for hub/safe contracts and `canActAsVault` requires the wallet to be on that
  chain. `useAccountSwitcher.js:28-36` lists one switcher entry per vault reference (so a 6-chain
  Safe is 6 entries with the same label).
- `VaultDetail.jsx:126-136` deliberately has no "Operate as this vault" button — the account menu
  is the one switcher. Spec 102 keeps the account menu as A switcher and adds the vault sheet's
  Details view as another door to the same `choose()`.

## R2 — Primitives to reuse (no new primitives)

- **Bottom sheet**: `components/account/ActionSheet.jsx` is the only sheet with a focus trap,
  Escape, scroll lock and mobile safe-area padding (`ActionSheet.css`, z 1500; true bottom sheet
  under 640px). `VaultActionSheet.jsx` is the precedent for a multi-view sheet (title per view,
  derive-state-during-render for `initialAction`, scroll-to-top on view change, disabled options
  carry their reason). **No portal anywhere** — sheets render inline on `position: fixed`.
- **Segmented views**: `components/ui/PillSelect.jsx` (`role=radiogroup`, roving tabindex) or the
  ad-hoc `role=tablist` pattern (`earn/VaultSheet.jsx:352-380`). A tablist is the semantically
  right one for three *views* of one object.
- **Compact card**: `components/account/AccountCard.jsx` (spec 086) — THE account tile: avatar,
  kind tag, label, address, `network` line, optional `balance` node, active state, tint/pattern
  from `accountProfilesStore` (`fw_account_profiles_v1`, keyed by **lowercased address**, device
  local, absent from `syncedObjects` by test). It is a single `role=option` button; the
  carousel's "⋯" lives OUTSIDE it (`AccountCardsCarousel.jsx:178-187`, `account-customize-open`).
- **Card styling**: `AccountCustomizeSheet.jsx` (picture / shade / pattern / reset) — its body is
  the styling surface; the sheet chrome is `ActionSheet`. Because the profile store keys by address,
  a vault's cosmetics are already chain-independent.
- **Chain tags**: `components/ui/NetworkPill.jsx` (`chainId`, `name`; per-chain hue in
  `NetworkPill.css`, an accepted exemption to the no-hardcoded-colour rule). `AssetLogo`'s
  `NETWORK_BADGES` is the other chain glyph. `config/networks.js` has no icon/colour field.
- **Identity resolution**: `hooks/useOpponentName.js` → `{displayName, source}` in the mandated
  priority address book > callsign > ENS > generated. `hooks/useAddressBook.js` exposes
  `findByAddress`, `addContact`, `addAddress`. Contact identity is `(address, chainId)`.
- `shortAccountAddr` (`hooks/useAccountSwitcher.js`) is the address shortener to standardise on.

## R3 — Network switching precedent

`contexts/WalletContext.jsx:756` `switchNetwork(chainId)` awaits the wagmi async mutate and REJECTS
on member refusal (spec 088 fix). `hooks/useEarnSend.js#sendOnChain` and `usePredictTrade.js:108`
switch at submit time. That is the pattern for "abstract chain selection": an action states the
chain it needs and switches on tap; the member never pre-selects.

## R4 — Test + validation conventions

- Fast-tier Cypress precedent: `frontend/cypress/e2e/fast/41-protect-vault-actions.cy.js`
  (`cy.mockWeb3Provider({account, preAuthorized:true, networkId:137})`, `/wallet?tab=custody`,
  `.custody-panel` anchor, scoped `[role=dialog]` a11y scans, testids `vault-action-*`).
  Vault references seed through `fw_user_<lower addr>_custody_vault_references` (localStorage; the
  store passes `useLocalStorage=true`). Fast tier has NO chain: every vault read fails →
  `reachable:false`, which is a state the surface must render honestly anyway.
- `frontend/cypress/coverage/matrix.json` needs a row for `102-…` or CI fails; `npm run e2e:matrix`
  regenerates the doc; new specs are auto-estimated by the sharder and announced.
- `frontend/src/test/e2e-policy/assertionDepth.test.js` bans unconditional truths.
- Brand guards (`frontend/src/test/brand/`): only `theme.css` states a colour; no
  `var(--x, #hex)`; fill+label move together on disabled.
- Unit precedent with CustodyContext mocks: `frontend/src/test/custody/VaultDetail.test.jsx`.
- Screenshot harness precedent: `scripts/ui/capture-account-cards.mjs`; findings README format:
  `specs/086-account-cards/screenshots/README.md`.

## R5 — The balance overflow (second screenshot)

`components/wallet/WrapView.jsx:51-54` formats balances with an unrounded `ethers.formatUnits`
and renders the 18-decimal string into `.pt-wrap-balance-val` (`PayTransfer.css:471`) and the
`Balance:` line (`:210`). Same class of bug in `TransferForm.jsx:536` (via `useTransfer.js:161,169`)
and `ui/UniversalAssetSelect.jsx:151-182` (via `useSwapBalances.js:64`). The repo has no shared
display formatter for `(raw, decimals)` — Portfolio's `lib/portfolio/aggregate.js#formatAssetAmount`
takes a decimal string and is dust-safe; Earn's `lib/earn/format.js#formatTokenAmount` compacts
large values. One shared `formatUnitsForDisplay(raw, decimals)` (null → null, never `|| 0`) is the
fix; the WrapView test at `src/test/wallet/WrapView.test.jsx:149` already asserts an unread balance
renders `—`, never `0`, and must keep passing.

## Decisions

| # | Decision | Why |
|---|---|---|
| D1 | Vault identity in the UI is the **address**; the chain is a property of each **transaction**. | A Safe at one address on N chains is one thing to the member. The store stays `(chainId,address)` so per-chain reads, failure isolation and backup are untouched. |
| D2 | Loading a vault adds **every** network it exists on. | The "pick another" prompt asks a question the member cannot answer yet. Unreachable chains are named and can be re-probed later. |
| D3 | One compact `AccountCard`-shaped tile per vault; "⋯" opens the vault sheet. | Matches the Portfolio carousel (spec 086) so a vault reads as the same account everywhere. |
| D4 | The queue reads every instance's chain through `getProvider(chainId)`, three-state per chain. | The member's pending work is not a function of which chain their wallet happens to be on. |
| D5 | Approve/Execute on a row switches the wallet to that row's chain at tap time. | Spec 088 precedent; the member never pre-selects a network. Refusal is stated, never silent. |
| D6 | Acting as a vault binds to the address; `active.chainId` follows the wallet's chain **where the vault exists**, else the vault's home chain, and submit auto-switches. | Consumers that read `active.chainId` keep working; the member no longer picks "the Polygon copy". |
| D7 | Balance formatting gets ONE shared helper, applied to Wrap / Transfer / asset picker. | Three components rolled their own or none. |
| D8 | No contract change; no new store; cosmetics stay in `fw_account_profiles_v1`. | YAGNI; the profile store is already address-keyed. |
