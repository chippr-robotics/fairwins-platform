# Feature Specification: Hardware Wallet Cold Storage (Protect ▸ Off chain)

**Feature Branch**: `claude/hardware-wallet-protect-ojldc1`
**Created**: 2026-08-15
**Status**: In progress
**Input**: Complete the Protect page: the "Off chain" mode becomes real cold storage backed by
hardware wallets (Ledger and Trezor), with a guided bottom-sheet flow for adding an account,
app-wide availability of the added account, accordion sections to keep the view clean, honest
copy, documentation, and wiring into notifications and the activity ledger.

## Why

The Protect page today has an "Off chain" section that is a disabled placeholder ("Off-chain
custody is coming later."). Members who keep long-term funds on a Ledger or Trezor cannot see
those accounts anywhere in the app, cannot watch their balances alongside their other accounts,
and cannot receive to them without leaving the platform. Cold storage is the natural completion
of Protect: **On chain** (Safe multisig vaults) covers shared/programmatic custody, **Verify**
covers identity proofs, and **Off chain** covers keys that never touch a browser.

## What (user-facing)

### US1 — Add a hardware wallet account

A member opens Protect ▸ Off chain and taps "Add hardware wallet". A guided bottom-sheet flow
walks them through: choosing the vendor (Ledger or Trezor), preparing the device (unlocked,
Ethereum app open for Ledger; Trezor Connect popup for Trezor), connecting over WebUSB/WebHID
(Ledger) or Trezor Connect (Trezor), reviewing the derived accounts (address + balance +
derivation path, with more pages loadable), selecting one or more accounts, and saving them with
an optional label. The saved account records **public data only** — address, vendor, derivation
path, label. No secret ever exists in the browser; that is the point of the device.

### US2 — Cold-storage accounts are usable app-wide

A saved hardware account appears wherever the member's other account types (passkey account,
vaults, legacy recovered accounts) appear: it is added to the address book (usable in every
address field), listed in Protect ▸ Off chain with its vendor badge, and joins the account
switcher. Choosing it reconnects the device (the derived address must match the saved one) and
the member then operates as the account — every signature is a physical confirmation on the
device screen; the app never signs silently.

### US3 — The Protect page stays scannable

The Protect page's three areas — On chain, Verify, Off chain — become collapsible sections using
the same accordion pattern as the Recovery and Settings tabs (one open at a time, summary line
while collapsed). Long narrative paragraphs are removed from the sections; each section carries
at most a one-line summary in its collapsed header. Full explanations move to the documentation.

### US4 — Removal and audit

A member can remove a saved hardware account (a confirmation states that removal only forgets
the reference — the device still controls the funds). Adding and removing accounts is recorded
in the activity ledger (address + vendor + path only) and surfaced through the notification
system like other account events.

## Functional Requirements

- **FR-001**: Protect ▸ Off chain replaces the disabled placeholder with a live cold-storage
  section: an "Add hardware wallet" action plus the list of saved hardware accounts.
- **FR-002**: The add flow runs in the shared bottom sheet (`ActionSheet`) as a guided,
  step-by-step wizard: vendor → prepare → connect → pick accounts → saved.
- **FR-003**: Ledger connects over WebHID (preferred) or WebUSB; Trezor connects via Trezor
  Connect. On a browser without the needed transport, the vendor option is disabled with an
  honest reason (never a dead control).
- **FR-004**: Account discovery lists derived accounts for both standard Ethereum path schemes —
  Ledger Live's account-per-hardened-index `m/44'/60'/x'/0/0` and the BIP-44 address-index
  `m/44'/60'/0'/0/x` convention (Trezor/MEW/pre-Live tooling) — pageable, each with address and
  native balance on the connected network. The flow starts on the vendor's own default scheme.
- **FR-005**: Only public data is persisted: `{ address, vendor, path, label, addedAt }` under
  the member's account storage, riding the spec-032 backup as a synced object. Never any key
  material, xpub, or device identifier beyond vendor name.
- **FR-006**: Saved accounts register in the member's address book (source `hardware`), making
  them available in every address entry across the app.
- **FR-007**: Adding and removing a hardware account emits a client-ledger audit entry
  (`hardware_account_added` / `hardware_account_removed`; refs: address, vendor, path) with a
  stable idempotent entryId, and a toast notification.
- **FR-008**: Removing an account requires confirmation and states that only the reference is
  forgotten; funds remain controlled by the device.
- **FR-009**: The three Protect areas render as `AccordionSection`s inside one `AccordionGroup`
  (exclusive). Collapsed headers carry a one-line live summary (e.g. vault count, last verify
  outcome, hardware account count). The On chain section opens by default.
- **FR-010**: Narrative paragraphs inside sections are removed (e.g. the Verify intro sentence);
  explanations live in `docs/developer-guide/hardware-wallets.md` and the user guide.
- **FR-011**: Duplicate accounts cannot be saved twice (same address, case-insensitive); saving
  an already-known address updates its label instead.
- **FR-012**: Every connect/discovery failure path ends in a stated, human-readable outcome in
  the sheet (device locked, wrong app, permission denied, transport unsupported, user cancelled)
  — never a spinner that hangs or a silent close.
- **FR-013**: The flows are testable without hardware: the vendor adapters sit behind one
  interface with an injectable seam; unit/component tests drive mock adapters; real-device
  validation is a staging checklist documented in the runbook.
- **FR-014**: WCAG 2.1 AA: the wizard is keyboard-operable, focus-trapped in the sheet, all
  states announced; accordion semantics come from the shared `AccordionSection`
  (`aria-expanded` + `inert` collapsed region).

### Amendment — Ledger over Bluetooth (release 1.14.0)

- **FR-015**: The Ledger transport is chosen **inside the adapter** from what the browser exposes
  (`ledgerTransportKind`): WebHID where it exists — so a desktop keeps exactly the transport it
  always used — otherwise Web Bluetooth (`@ledgerhq/hw-transport-web-ble`) where `navigator.bluetooth`
  exists, otherwise WebUSB. Bluetooth outranks WebUSB only in the WebHID-less case, which is a
  phone: Android Chrome exposes WebUSB, but reaching a Ledger that way needs an OTG cable while
  BLE is the rail the device itself offers. Everything above the adapter stays transport-agnostic —
  `HardwareSigner` must never learn what a transport is.
- **FR-016**: Member-facing connect copy is **derived from the transport that would be opened**
  (`connectCopy.js#connectGuidance`), never assumed: the vendor hint, the connect checklist and the
  reconnect sentence all come from that one function, so a phone pairing over Bluetooth is never
  told to plug anything in. Trezor has no Bluetooth rail and its copy is unchanged — no vendor may
  claim a capability it lacks.
- **FR-017**: A browser with neither rail (iOS Safari, old browsers) refuses honestly and names
  both: the option renders disabled with the stated reason and the connect step shows that reason
  in place of a checklist that could not succeed. BLE-specific failures reuse the existing
  vocabulary — a dismissed pairing chooser is `permission-denied`, a dropped link is
  `disconnected` — with one addition, `bluetooth-unavailable`, for a radio that is switched off
  (checked via `navigator.bluetooth.getAvailability()` before any chooser is shown).

## Out of scope

- Bitcoin/Solana hardware accounts — Ethereum-family accounts only for now (the spec-061
  Bitcoin derivation constants are wallet-breaking and stay untouched).
- Hardware devices as vault (Safe) owners' signing rail — vault approvals keep their existing
  flow; a hardware key can hold a Safe ownership externally without this feature knowing.
- Any gateway/contract/subgraph change. The feature is frontend-only.

## Security notes

- No key material, seed, xpub, or PIN ever reaches the app: Ledger/Trezor protocols expose
  addresses per derivation path; the app stores those public artifacts only.
- The stored record is deliberately too little to fingerprint a device (vendor name only).
- Sanctions screening applies where funds move; adding/removing account references moves none.
  Acting as a hardware account routes through the same submit seams every acting account uses.
- Trezor Connect loads vendor code in a `window.open` popup on trezor.io — a separate browsing
  context, so no `script-src`/`frame-src` grant is needed and none is added (see
  docs/developer-guide/hardware-wallets.md). The Ledger path uses only local WebHID/WebUSB and
  ships no remote code.
