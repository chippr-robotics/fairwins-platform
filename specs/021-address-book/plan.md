# Implementation Plan: Address Book

**Branch**: `claude/address-book-feature-9zncr7` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/021-address-book/spec.md`

## Summary

Add a personal, client-side **Address Book** so members can save counterparties
under a friendly name, group multiple addresses/networks per contact, see a
sanctions/compliance warning tag on restricted addresses, reuse contacts anywhere
an address is entered, be invited (via a non-blocking toast) to save new addresses
after a successful action, and move their book between devices via a
wallet-signature-encrypted export/import.

**Technical approach**: A frontend-only feature on the existing React + Vite stack.
Contacts persist in `localStorage`, scoped per connected wallet through the existing
`userStorage` helper. A small pure data layer (`addressBookStore`) owns the schema,
CRUD, address normalisation, and (address+network) identity. A `useAddressBook`
hook exposes it to React. Sanctions screening reuses the existing
`utils/sanctionsScreen.js` (read-only `SanctionsGuard` reads) behind a
`useAddressScreening` hook with a short-lived in-session cache. Reuse across the app
is delivered by extending the existing `AddressInput` with an address-book
picker/search affordance, plus a post-action "save?" toast. Encrypted export/import
reuses the existing `@noble` ChaCha20-Poly1305 primitives (`crypto/primitives.js`)
with a symmetric key derived from a wallet signature over a new, domain-separated
address-book signing message. The book is surfaced as a new "Address Book" section
in the existing `WalletPage` (My Account) tab menu. **No smart-contract, subgraph,
or backend changes.**

## Technical Context

**Language/Version**: JavaScript (ES2022) + React 18, built with Vite (existing
frontend toolchain). No TypeScript in this package.

**Primary Dependencies**: React, react-router-dom, wagmi/ethers (wallet + reads),
`@noble/ciphers` (ChaCha20-Poly1305) and `@noble/hashes` (keccak) via the existing
`utils/crypto/*` modules. No new runtime dependencies anticipated.

**Storage**: Browser `localStorage`, per-wallet, via `utils/userStorage.js`
(`fw_user_<address>_addressBook`). No server-side storage.

**Testing**: Vitest + @testing-library/react + `vitest-axe` (existing setup at
`frontend/src/test/`). Pure logic (store, crypto, screening cache) unit-tested;
components tested for behaviour and accessibility.

**Target Platform**: Browser SPA (the FairWins web app), all supported networks.

**Project Type**: Web application (frontend only for this feature).

**Performance Goals**: Search over ≥200 saved addresses returns with no perceptible
delay (client-side filter, target <50ms). Screening reads are de-duplicated and
cached per session to avoid redundant on-chain calls.

**Constraints**: Must meet WCAG 2.1 AA; warnings conveyed by more than colour. No
new backend (project deployment footprint is fixed). Contract addresses/ABIs come
from generated config (`config/contracts.js`), never hardcoded. Restriction status
is network-scoped and must never leak across networks. Client screening is advisory
only — the on-chain `SanctionsGuard` remains the enforcement layer.

**Scale/Scope**: Single-user local dataset (tens–hundreds of contacts typical).
One new tab section, one new store + 2–3 hooks, one extension to `AddressInput`, a
save toast, and an import/export module.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applies? | How this plan complies |
|-----------|----------|------------------------|
| **I. Security-First Smart Contracts** | **No contract changes** | This feature adds no `contracts/` code and deploys nothing. It only performs read-only `SanctionsGuard.isAllowed` calls via the existing screening util. No Slither/Medusa/security-agent gate is triggered. The client warning explicitly does **not** replace on-chain enforcement (FR-013). |
| **II. Test-First & Coverage** | Yes | Vitest unit tests for the store (CRUD, normalisation, identity, merge), crypto round-trip (export→import, wrong-wallet failure), and screening cache; component + axe tests for the panel, picker, and toast. Tests authored alongside the behaviour. |
| **III. Honest State, No Mocks in Shipped Paths** | Yes | Real `localStorage` and real on-chain screening; mocks confined to tests. Fail-closed screening (uncertain ≠ clear, FR-011). Restriction status scoped to the screened network (FR-014). No placeholder data in shipped paths. |
| **IV. Fail Loudly in CI** | Yes | New lint/test files run under existing CI; no `continue-on-error` added. |
| **V. Accessible, Consistent Frontend** | Yes | WCAG 2.1 AA, axe tests, ESLint-clean. Warning tag uses icon + text, not colour alone. Contract addresses sourced from `config/contracts.js` sync artifacts. |

**Additional constraints**: Tech stack unchanged (React+Vite+Vitest); no new core
technology. No secrets/keys committed — the export key is derived at runtime from a
wallet signature and never persisted. Archived code untouched.

**Gate result: PASS** — no violations; Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/021-address-book/
├── plan.md              # This file (/speckit-plan)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (module/UI interface contracts)
│   ├── address-book-store.md
│   ├── address-screening.md
│   ├── export-format.md
│   └── ui-contracts.md
├── checklists/
│   └── requirements.md  # Created by /speckit-specify
└── tasks.md             # /speckit-tasks (NOT created here)
```

### Source Code (repository root)

```text
frontend/src/
├── lib/
│   └── addressBook/
│       ├── addressBookStore.js      # Pure data layer: schema, CRUD, normalise, (addr+network) identity, merge
│       ├── addressBookFile.js       # Plain-text export/import (issue #1550; reads legacy encrypted files)
│       └── constants.js             # Storage key, export file/version, address-book signing message
├── hooks/
│   ├── useAddressBook.js            # React binding over addressBookStore (per-wallet, reactive)
│   └── useAddressScreening.js       # Screens addresses via sanctionsScreen.js with short-lived session cache
├── components/
│   ├── account/
│   │   ├── AddressBookPanel.jsx     # My Account → Address Book tab body (CRUD UI, import/export)
│   │   ├── AddressBookPanel.css
│   │   ├── ContactCard.jsx          # One contact: name + grouped addresses, warning tags
│   │   ├── ContactEditModal.jsx     # Create/edit contact + addresses (network defaults to active)
│   │   └── RestrictionTag.jsx       # Reusable warning/uncertain tag (icon + text)
│   └── ui/
│       ├── AddressInput.jsx         # EXTENDED: address-book picker/search + warning surfacing
│       ├── AddressBookPicker.jsx    # Searchable contact/address dropdown used by AddressInput
│       └── SaveAddressToast.jsx     # Non-blocking post-action "save to address book?" prompt
└── test/
    └── addressBook/                 # Vitest unit + component + axe tests for the above
```

Integration points (existing files touched):
- `frontend/src/pages/WalletPage.jsx` — add `{ id: 'addressbook', label: 'Address Book' }` to `WALLET_TABS` and render `<AddressBookPanel>`.
- `frontend/src/components/ui/AddressInput.jsx` — add optional address-book picker + warning surfacing (backward-compatible props).
- `frontend/src/components/fairwins/FriendMarketsModal.jsx` — opt in to the picker on the opponent/arbitrator inputs and trigger the save toast after a successful create/accept.

**Structure Decision**: Frontend-only web-app feature. Pure logic lives under
`frontend/src/lib/addressBook/` (framework-agnostic, easily unit-tested), React
state in `frontend/src/hooks/`, and UI under `components/account` (the My Account
home) and `components/ui` (the reusable input + toast). This mirrors the existing
separation used by spec 020 (`lib/account`, `hooks/useAccountStats`,
`components/account`).

## Complexity Tracking

> No constitution violations — section intentionally empty.
