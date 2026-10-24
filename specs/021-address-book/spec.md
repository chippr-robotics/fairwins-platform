# Feature Specification: Address Book

**Feature Branch**: `021-address-book`

**Created**: 2026-06-19

**Status**: Draft

**Input**: User description: "to make it easier to find friends, i would like to add an 'address book' feature where a member can store addresses with a nickname, network and notes.  this will be stored clientside. the addresses should be checked against the compliance and sanctions oracle contracts and any member address which is restricted should show a warning tag to the member. the addresses should be searchable/selectable anywhere within the app a user must enter an address and the user should be prompted to save addresses after entering a new one. the address book should be accessable as a tab in the 'my account' where users can perform crud operations on their address book. members should be able to tag multiple addresses to one name since friends may use several addresses and networks to interact. the addressbok als needs an encrypted import and export to allow the member portability."

## Overview

Members of FairWins regularly need to type or paste a counterparty's wallet
address to create or accept a wager. Re-entering long hexadecimal addresses is
error-prone and makes it hard to recognise who you are actually wagering with.
This feature adds a personal **Address Book**: a member can save the addresses of
people they interact with under a friendly name, organise multiple addresses and
networks under that same name (because a friend may use several wallets), and
then find and reuse those contacts anywhere the app asks for an address.

Because FairWins operates under a compliance and sanctions regime, every saved
address is screened against the on-chain compliance/sanctions oracle so the
member is clearly warned when a contact is restricted — without the address book
becoming a way to evade the on-chain enforcement that already exists. The address
book lives entirely on the member's own device (it is private contact data, not
shared protocol state) and can be exported and re-imported in encrypted form so a
member can move their contacts between devices or back them up safely.

## Clarifications

### Session 2026-06-19

- Q: How is the encrypted export/import keyed? → A: Wallet-signature-derived key — the encryption key is derived deterministically from a member's wallet signature (reusing the project's deterministic key-generation pattern); a backup is restorable only with the same wallet, with no passphrase to remember.
- Q: How does import resolve overlaps with the existing book? → A: Additive merge keyed on address — import adds addresses not already present and keeps existing ones (no duplicates); when an imported address carries a different nickname/notes, the member is prompted to keep existing or take imported, and existing data is never silently deleted.
- Q: Is a network required for each saved address? → A: Required, with a default — every saved address must have a network; the field is pre-filled with the currently active network so the member rarely has to choose. The unique key for an entry is (address + network).
- Q: When is the member prompted to save a newly-entered address? → A: Non-blocking toast after the action succeeds — once the underlying action (e.g., wager created/accepted) confirms on-chain, a dismissible "Save to address book?" toast appears; it never interrupts the flow, and is only offered for addresses not already saved.
- Q: When are saved addresses (re-)screened against the sanctions oracle? → A: On view/selection with a short-lived session cache — addresses are screened when the book is opened and when an address is selected in a flow, with results cached briefly within the session to avoid redundant on-chain reads; no background/periodic refresh.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Manage contacts in the My Account address book (Priority: P1)

A connected member opens the **Address Book** tab inside **My Account** and
manages their personal list of contacts. They can add a contact under a friendly
name, attach one or more wallet addresses to that name (each with the network it
is used on and optional notes), edit any contact or address, and delete contacts
or individual addresses they no longer need. The list persists on their device
between visits.

**Why this priority**: This is the core of the feature and the smallest viable
slice — a member can store and retrieve their contacts. Everything else
(selection elsewhere, save prompts, import/export) builds on the existence of a
managed, persistent address book.

**Independent Test**: Open My Account → Address Book on a connected wallet, create
a contact named "Alex" with two addresses on two networks plus a note, reload the
app, and confirm the contact and both addresses are still present and editable.

**Acceptance Scenarios**:

1. **Given** a connected member on the Address Book tab, **When** they add a
   contact with a nickname, one wallet address, a network, and a note, **Then**
   the contact appears in their list and is still present after a page reload.
2. **Given** an existing contact, **When** the member adds a second address (with
   its own network and note) under the same nickname, **Then** both addresses are
   shown grouped under that one contact name.
3. **Given** an existing contact, **When** the member edits the nickname, an
   address, a network, or a note, **Then** the change is saved and reflected
   immediately and after reload.
4. **Given** an existing contact, **When** the member deletes a single address,
   **Then** only that address is removed and the rest of the contact remains;
   **When** they delete the whole contact, **Then** the entire contact and all its
   addresses are removed.
5. **Given** the member enters a value that is not a valid wallet address, **When**
   they try to save it, **Then** they are shown a clear validation error and the
   invalid entry is not saved.

---

### User Story 2 - Sanctions/compliance warning on restricted contacts (Priority: P1)

When viewing their address book, a member sees a clear **warning tag** on any
saved address that is restricted according to the compliance/sanctions oracle, so
they understand that interacting with that address will be blocked or carries
compliance risk — before they attempt to transact.

**Why this priority**: FairWins is compliance-gated; surfacing restricted
addresses is a safety and legal-protection requirement, not a nicety. It must
ship with the address book itself so the book never quietly normalises a
restricted contact. It is tied for P1 because storing contacts without screening
them would create risk.

**Independent Test**: Save an address that the sanctions oracle reports as
restricted and an address it reports as clear; confirm the restricted one shows a
warning tag and the clear one does not, and that an unscreenable/unknown result is
shown as an uncertain (not "clear") state.

**Acceptance Scenarios**:

1. **Given** a saved address that the compliance/sanctions oracle reports as
   restricted, **When** the member views their address book, **Then** that address
   displays a visible warning tag indicating it is restricted.
2. **Given** a saved address the oracle reports as clear, **When** the member views
   their address book, **Then** no restriction warning is shown for that address.
3. **Given** the oracle cannot be reached or is not configured for the active
   network, **When** the member views an address, **Then** its status is shown as
   uncertain/unscreened rather than implying it is clear (fail-closed UX).
4. **Given** a contact has multiple addresses where at least one is restricted,
   **When** the member views the contact, **Then** the restricted address is
   individually flagged and the contact is visibly marked as containing a
   restricted address.

---

### User Story 3 - Select a saved contact wherever an address is required (Priority: P2)

Anywhere in the app where a member must enter a wallet address (for example,
creating or accepting a wager), they can search their address book by name or
address and select a saved contact instead of typing the raw address. The
selection populates the field with the correct address, and any restriction
warning travels with the selection.

**Why this priority**: This is where the address book delivers day-to-day value —
faster, less error-prone address entry. It depends on US1 (a populated book) but
is a distinct, independently demonstrable slice.

**Independent Test**: With at least one saved contact, open a flow that requires
an address, search the address book by the contact's name, select an address, and
confirm the field is populated with that exact address and any warning is shown.

**Acceptance Scenarios**:

1. **Given** a member on a screen with an address field and at least one saved
   contact, **When** they search by a contact's nickname or partial address,
   **Then** matching contacts/addresses are shown for selection.
2. **Given** matching results, **When** the member selects one, **Then** the
   address field is populated with that contact's selected address.
3. **Given** the selected address is restricted, **When** it is chosen, **Then**
   the restriction warning is surfaced in that flow before the member proceeds.
4. **Given** a member has no saved contacts, **When** they open an address field,
   **Then** the field still works for manual entry with no errors and offers no
   misleading empty results.

---

### User Story 4 - Prompt to save a newly entered address (Priority: P2)

After a member manually enters a new address (one not already in their address
book) and the action they used it for succeeds on-chain, a dismissible,
non-blocking toast invites them to save it to their address book with a nickname,
network, and optional notes, so their book grows naturally as they use the app
without interrupting their flow.

**Why this priority**: This is the growth mechanism that keeps the book useful
without forcing members to curate it manually. It depends on the book existing
(US1) and is valuable but not required for the MVP.

**Independent Test**: Enter a brand-new address, complete the action so it confirms
on-chain, and confirm a dismissible save toast appears; accept it, then confirm the
new contact is in the address book; repeat with an address already saved and confirm
no toast appears.

**Acceptance Scenarios**:

1. **Given** a member used an address not already in their book, **When** the
   underlying action succeeds on-chain, **Then** a dismissible, non-blocking toast
   invites them to save it with a nickname, network, and optional notes.
2. **Given** the save toast, **When** the member confirms, **Then** the address is
   added to their address book (creating a new contact or attaching to an existing
   name they choose).
3. **Given** the save toast, **When** the member dismisses or ignores it, **Then**
   the address is not saved and nothing about the completed action is affected.
4. **Given** the entered address already exists in the book, **When** the action
   succeeds, **Then** no save toast is shown.

---

### User Story 5 - Encrypted export and import for portability (Priority: P3)

> **Superseded by the 2026-09-10 amendment (issue #1550).** The export is plain text and
> needs no wallet; this story is kept as the record of the original design. See
> *User Story 7* and the replaced FR-019–FR-021 at the end of this document.

A member can export their entire address book to an encrypted file and later
import it — on the same device or a different one — to restore or move their
contacts. The exported data is unreadable without the member's secret, and import
restores the contacts (names, addresses, networks, notes) accurately.

**Why this priority**: Portability and backup protect a member against device
loss and let them move between devices, but the feature is fully usable on one
device without it, so it is the lowest priority of the set.

**Independent Test**: Populate an address book, export it, clear local data (or
use a second browser/profile), import the file with the correct secret, and
confirm all contacts and their addresses/networks/notes are restored; then
confirm importing with a wrong secret fails safely.

**Acceptance Scenarios**:

1. **Given** a member with saved contacts, **When** they export their address
   book, **Then** they receive an encrypted file that does not expose addresses,
   names, or notes in readable form.
2. **Given** an exported file and the correct secret, **When** the member imports
   it, **Then** all contacts and their addresses, networks, and notes are restored
   accurately.
3. **Given** an exported file and an incorrect secret, **When** the member tries
   to import it, **Then** the import fails with a clear error and the existing
   address book is left unchanged.
4. **Given** an import that overlaps with existing contacts, **When** it is
   applied, **Then** new addresses are added and existing ones are kept without
   duplicates, and **When** an imported address has a differing nickname/notes,
   **Then** the member is prompted to keep the existing or take the imported values
   (nothing is silently lost).

---

### Edge Cases

- **Duplicate address under a different name**: the same address is saved under
  two different contacts — the member is warned about the duplicate at save time
  and can choose to proceed or consolidate.
- **Same address on multiple networks**: an address legitimately used on more than
  one network is allowed (network is part of what distinguishes an entry).
- **Address normalisation**: addresses that differ only by capitalisation/checksum
  formatting are treated as the same address for duplicate detection and matching.
- **A clear contact later becomes restricted**: the warning appears the next time the
  book is opened (or the address is selected) and the short-lived cache has expired —
  without the member re-saving the contact.
- **Restricted address selected in a transaction flow**: the client warning is
  advisory; the on-chain enforcement (existing sanctions guard) remains the actual
  block, and the UX must not imply the client warning alone is the enforcement.
- **Large address book**: search and listing remain responsive with a large number
  of contacts/addresses.
- **No connected wallet**: the address book is unavailable or read-restricted in a
  way consistent with the rest of My Account, without errors.
- **Corrupted or wrong-format import file**: rejected with a clear error, leaving
  the current book intact.
- **Switching active network**: restriction status is shown for the network being
  screened and never leaks a result from one network as if it applied to another.

## Requirements *(mandatory)*

### Functional Requirements

#### Address book data & CRUD

- **FR-001**: Members MUST be able to create a contact identified by a
  human-friendly nickname.
- **FR-002**: Members MUST be able to associate one or more wallet addresses with a
  single contact (one name, many addresses), so a friend's multiple wallets are
  grouped together.
- **FR-003**: Each stored address MUST carry a required network designation (the
  entry field defaults to the currently active network) and optional free-text
  notes. The unique identity of an entry is the combination of (address + network).
- **FR-004**: Members MUST be able to view, edit, and delete contacts, and add,
  edit, or delete individual addresses within a contact (full CRUD).
- **FR-005**: The system MUST validate that an entered address is a well-formed
  wallet address before saving and reject invalid input with a clear message.
- **FR-006**: The address book MUST persist on the member's device between sessions
  without requiring any server-side storage of contact data.
- **FR-007**: The system MUST detect and warn on duplicate addresses (matching
  regardless of address capitalisation/checksum formatting), while still allowing
  the same address to be recorded under different networks.

#### Access & placement

- **FR-008**: The address book MUST be accessible as a dedicated tab within the
  **My Account** area.
- **FR-009**: Contact data MUST be scoped to the member (the connected wallet) and
  MUST NOT leak between different members using the same device.

#### Compliance / sanctions screening

- **FR-010**: The system MUST screen each saved address against the project's
  compliance/sanctions oracle when the address book is opened and when an address is
  selected in a flow, and display a clear warning tag on any address reported as
  restricted. Results MAY be cached briefly within the session to avoid redundant
  on-chain reads, but the system MUST NOT rely on a status stored at save time as the
  only source (no stale-only behaviour) and does not require background/periodic
  refresh.
- **FR-011**: When screening cannot be performed (oracle unreachable or not
  configured for the active network), the system MUST present the address status as
  uncertain/unscreened and MUST NOT imply the address is clear (fail-closed UX).
- **FR-012**: A contact with at least one restricted address MUST be visibly marked
  as containing a restricted address, with the specific restricted address(es)
  individually flagged.
- **FR-013**: The client-side warning MUST be presented as advisory and MUST NOT
  weaken, bypass, or replace the existing on-chain sanctions enforcement; selecting
  a restricted contact MUST NOT enable a member to circumvent on-chain blocking.
- **FR-014**: Restriction status MUST be scoped to the network it was screened on
  and MUST NOT be presented as applying to a different network.

#### Reuse across the app

- **FR-015**: Anywhere a member must enter a wallet address, they MUST be able to
  search their address book (by nickname or address) and select a saved contact in
  place of typing the address.
- **FR-016**: Selecting a saved address MUST populate the target address field with
  that exact address, and any restriction warning MUST be surfaced in that flow.
- **FR-017**: After a member uses an address that is not already in their book and
  the underlying action confirms on-chain, the system MUST surface a dismissible,
  non-blocking toast inviting them to save it (nickname, network, optional notes),
  and MUST NOT surface it when the address is already saved.
- **FR-018**: The save toast MUST be non-blocking — dismissing or ignoring it MUST
  NOT block or alter the member's completed action, and it MUST never interrupt the
  flow.

#### Portability (encrypted import/export) — *superseded, see the 2026-09-10 amendment*

- **FR-019**: Members MUST be able to export their entire address book to an
  encrypted file that does not expose names, addresses, or notes in readable form.
  The encryption key MUST be derived deterministically from the member's wallet
  signature (reusing the project's deterministic key-generation pattern), so the
  export requires no separately-remembered passphrase.
- **FR-020**: Members MUST be able to import a previously exported file, restoring
  all contacts with their addresses, networks, and notes intact, by re-deriving the
  key from the same wallet that produced the export.
- **FR-021**: Import attempted with a different/incorrect wallet, or with a
  corrupted/invalid file, MUST fail with a clear error (and MUST NOT reveal contact
  data) and MUST leave the existing address book unchanged.
- **FR-022**: When an import overlaps with existing contacts, the system MUST perform
  an additive merge keyed on the address: addresses not already present are added,
  already-present addresses are kept without creating duplicates, and existing data
  is never silently deleted. When an imported address carries a nickname or notes
  that differ from the stored ones, the member MUST be prompted to keep the existing
  values or take the imported values.

#### Quality

- **FR-023**: All address book UI MUST meet the project's accessibility standard
  (WCAG 2.1 AA), including the restriction warning being conveyed by more than colour
  alone.

### Key Entities *(include if feature involves data)*

- **Contact**: A named person/entity in a member's address book. Has a nickname and
  a collection of associated addresses. Belongs to exactly one member (the owner).
- **Saved Address**: A single wallet address belonging to a contact, with a required
  network designation (defaulted to the active network), optional notes, and a
  derived (screened) restriction status. A contact may have many; an entry's unique
  identity is (address + network), so the same address on two networks is two
  entries.
- **Address Book**: The full collection of a member's contacts, scoped to the owning
  member, persisted on-device, and the unit of encrypted export/import.
- **Restriction Status**: The screened compliance/sanctions result for an address on
  a given network — one of clear, restricted, or uncertain/unscreened — used to drive
  warning tags.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can add a contact with at least one address, network, and note
  in under 30 seconds, and the contact survives a page reload.
- **SC-002**: A member can populate an address field from a saved contact in 3 or
  fewer interactions, instead of typing or pasting the full address.
- **SC-003**: 100% of saved addresses that the oracle reports as restricted display a
  visible warning tag; 0% of addresses with an unknown/unscreenable status are shown
  as "clear".
- **SC-004**: A member who transacts with a brand-new address is offered the save
  toast 100% of the time after the action succeeds, and never offered it for an
  address already in their book.
- **SC-005**: A member can export and then import their address book onto a different
  device/profile and recover 100% of contacts, addresses, networks, and notes; an
  import with the wrong secret never reveals contact data and never corrupts the
  existing book.
- **SC-006**: Searching an address book of at least 200 saved addresses returns
  matches effectively instantly (no perceptible delay) to the member.
- **SC-007**: The address book UI passes the project's automated accessibility checks
  with no new violations.

## Assumptions

- **Scope of "compliance and sanctions oracle"**: Screening reuses the project's
  existing on-chain sanctions/compliance screening surface (the same source that
  gates wagers today) rather than introducing a new oracle; the address book is a
  consumer of that signal, not a new enforcement layer.
- **Client-side storage**: "Stored clientside" means contact data lives in the
  member's browser/device storage only; no FairWins backend stores address book
  contents (consistent with the project's no-new-backend constraint).
- **Per-member scoping**: The book is associated with the connected wallet so that
  different members on a shared device do not see each other's contacts; this mirrors
  the project's network-/member-scoping principle.
- **Encryption secret for export/import**: Export/import is protected by a key
  derived deterministically from the member's wallet signature (reusing the project's
  deterministic key-generation pattern), so there is no separate passphrase to
  remember. A consequence is that a backup is restorable only with the **same
  wallet** that created it — portability is across devices for that wallet, not
  across different wallets.
- **Restriction is advisory in the client**: Consistent with existing behaviour, the
  client warning is a pre-check for UX; the authoritative block remains the on-chain
  guard, so the address book never needs to "enforce" anything itself.
- **Networks**: The set of selectable networks corresponds to the networks FairWins
  already supports/configures; the address book does not introduce new networks.
- **Address format**: Addresses are EVM-style wallet addresses; address validation
  and normalisation follow the conventions already used elsewhere in the app
  (including any existing name-resolution support for entry).
- **No sharing**: Address books are private to the member; sharing contacts between
  members is out of scope for this feature (portability is via encrypted
  export/import only).

---

## Amendment 2026-09-06 — estate-wide screening (issue #1458)

**Problem.** FR-010–FR-014 screened an address against ONE list — the FairWins `SanctionsGuard`
on the wallet's chain — and the guard is deployed on three chains (Polygon, Amoy, Mordor). On the
other four mainnets the app could only ever say *Unscreened*, and a clear result was shown as
nothing at all. A member entering a recipient had no way to learn that the address was frozen by
a stablecoin issuer on another network, or sanctioned according to a list the guard on their
chain does not consult, until the funds were already gone or stuck.

**Scope.** Advisory only. No contract change, no new enforcement, no change to which read gates
a submission (FR-013 stands: the guard on the chain the value moves on remains the enforcement,
and the surfaces that gate a button on it still read it live — the *timing* of that read, forced
past the cache at submission, is **spec 067** FR-032, not FR-013). This amendment changes what the
member is TOLD when they enter an address, and what that statement rests on.

### User Story 6 — Know that an address is flagged anywhere before sending (Priority: P1)

As a member entering an address, I want to see whether it is flagged on any known list on any
network this build can read, so that I do not send value to an address that will be refused
on-chain or whose funds will be frozen — regardless of which network the list lives on.

**Acceptance Scenarios**:

1. **Given** a valid address is entered, **When** the sweep completes, **Then** every configured
   screening source on every chain in the build's cohort has been asked, and the member can
   expand the result to see each source, its network, and its answer.
2. **Given** ANY source answers that the address is listed, **Then** a warning pill reading
   **Flagged** is shown with `role="alert"`, and the sentence names the list and the network.
3. **Given** EVERY configured source answered and none flagged the address, **Then** a green pill
   reading **Screened clear** is shown, with the count of sources and networks it rests on.
4. **Given** no source flagged the address but at least one could not be read, **Then** the pill
   reads **Partly screened** (amber, never green) and the sentence names the missing source.
5. **Given** no source answered at all, or no source exists for the chains asked, **Then** the
   pill reads **Unscreened** and the sentence says which networks have no source.

### Functional Requirements (added)

- **FR-024**: The system MUST screen an entered address against every screening source configured
  for every chain in the build's cohort (`cohortChainIds()`), never across the testnet/mainnet
  boundary (constitution III), and never against a chain the cohort does not include.
- **FR-025**: Screening sources are: the FairWins `SanctionsGuard` (`isAllowed`) where deployed;
  the Chainalysis Sanctions Oracle (`isSanctioned`) where published; and issuer freeze lists
  (`isBlacklisted` on Circle USDC, `isBlackListed` on Tether USDT) for the native issuer contracts
  the platform lists. Each source is a named, provenance-documented on-chain read; no off-chain
  risk provider is consulted in this amendment.
- **FR-026**: Every source read MUST resolve to one of `read` (with a boolean flag) or `unreadable`
  (with a reason); a chain with no source is reported as **uncovered**. A missing answer MUST
  NEVER be presented as a clear one.
- **FR-027**: The verdict MUST be derived from the readings, never stored: `flagged` on any flag;
  `screened` ONLY when every configured source answered and none flagged; `partial` when nothing
  flagged and at least one source is unreadable; `unscreened` when no source answered.
- **FR-028**: The pill MUST convey its verdict by icon and text (WCAG 1.4.1), the flagged state
  MUST be an alert, and the member MUST be able to expand it to see every source, per network,
  with its answer or the reason it gave none, and the networks that have no source.
- **FR-029**: Every source read MUST be bounded by a deadline, isolated from every other read
  (one dead endpoint never fails the sweep), and MUST obtain its provider through the spec-069
  endpoint seam (`readProviderFor`), never from `NETWORKS[chainId].rpcUrl`.
- **FR-030**: The estate screen is advisory. It MUST NOT replace the per-chain live read that gates
  a submission on the chain the value moves on (FR-013 keeps that read advisory; **spec 067**
  FR-032 is what requires it to be taken again, forced, at submission — see the 2026-09-10
  amendment), and it MUST NOT be presented as enforcement: the on-chain guard and the issuing
  token remain the only things that block.

### Key Entities (added)

- **Screening Source**: one on-chain list on one chain — kind (`fairwins-guard` /
  `chainalysis-oracle` / `issuer-freeze`), chain, contract address, maintainer label, and the read
  that answers "is this address listed?".
- **Source Reading**: one source's answer about one address — `read` + `flagged` + optional
  detail, or `unreadable` + reason.
- **Estate Screening Result**: the readings for one address across the cohort, the uncovered
  chains, and the derived verdict.

### Success Criteria (added)

- **SC-009**: On a mainnet build with all endpoints reachable, an address on the OFAC SDN list
  (verified: the Ronin-bridge exploiter, `0x098B…2f96`) renders **Flagged**, naming at least the
  Chainalysis oracle and the Circle USDC freeze list, on every mainnet in the cohort.
- **SC-010**: With one cohort endpoint unreachable and no source flagging, the pill renders
  **Partly screened** and names the unreachable source — it is never green.
- **SC-011**: 100% of pill states are distinguishable with colour removed.

### Out of scope (recorded)

- Subgraph indexing of `DenyListUpdated` (reason + timestamp for a FairWins deny-list entry): a
  single-address verdict is a point read; the subgraph would add a deploy dependency and no new
  fact to the verdict. Follow-up if the reason text is wanted in the UI.
- Bring-your-own risk providers (TRM, Chainalysis KYT, Elliptic). The source shape
  (`read(provider, account) → { flagged, detail }`) is what such a source would implement, behind
  a member-held credential.

---

## Amendment 2026-09-10 — plain-text, wallet-free export (issue #1550)

**Problem.** FR-019–FR-021 keyed the export file to a wallet signature over
`ADDRESS_BOOK_BACKUP_MESSAGE_V1`. That key can only be derived from an ethers signer, and a
passkey session has none — `WalletContext` nulls it for that login — so `deriveBackupKey` threw
`Wallet not connected` and BOTH Export and Import were dead for every passkey member, with an
account signed in and a book full of contacts on the screen behind the error. The sentence was
untrue twice over: the member's wallet was connected, and no wallet was ever going to help. It is
the same defect class as the custody write rail — asking "is there an injected EOA?" while
appearing to ask "is a member signed in?".

The second failure is quieter and older. The clarified answer to "how is the export keyed?"
(Session 2026-06-19, Q1: same wallet, no passphrase) bought convenience by making the file
readable by exactly one key on earth, and that is the wrong trade for what members actually do
with the file. A member who wants to hand their contacts to a teammate, carry them to an account
under a different key, or simply read them, cannot; what they get is *"Could not decrypt this
backup — it may belong to a different wallet or be corrupted"*, which names a mechanism and
guesses at a cause.

**Decision.** The export is **plain JSON**. No signature, no passphrase, no key, no envelope. A
member exports contacts to a file anyone can open, and imports one the same way, on every account
type the app supports. The confidentiality the envelope provided is not replaced by something
weaker — it is **dropped, deliberately and in writing**, and the member is told so at the moment
they export.

**Scope.** The export FILE only. Nothing about where the address book LIVES changes: it is still
per-member device storage (FR-006, FR-009), and the spec-032 encrypted backup — the mechanism that
actually protects a member's contacts at rest and across devices — is untouched and still
encrypted. Screening (FR-010–FR-014, FR-024–FR-030) is untouched. The additive merge and its
conflict prompt (FR-022) are untouched and now carry more weight than they did: they are the only
thing standing between an imported file and the member's existing data.

### User Story 7 — Move or share contacts as a plain file (Priority: P3)

As a member on any kind of account — injected wallet, hardware wallet, or passkey — I want to
export my address book to a file I can open, keep, or hand to someone else, and import one back,
so that my contacts are portable without depending on which key signs my transactions.

**Independent Test**: Sign in with a passkey, open My Account → Address Book, export, and confirm
a `.json` file downloads and opens in a text editor with the nicknames readable. Import that file
in a second profile signed in as a different member and confirm the contacts arrive. Confirm no
surface says "Wallet not connected" at any point in either direction.

**Acceptance Scenarios**:

1. **Given** a signed-in member with contacts, on a passkey account, **When** they export,
   **Then** a JSON file downloads with no signature prompt, and no surface reports a missing or
   disconnected wallet.
2. **Given** that file, **When** it is imported by any member on any account type, **Then** the
   contacts, addresses, networks and notes arrive, merged additively (FR-022).
3. **Given** the member is about to export, **When** the control is shown, **Then** the surface
   states in words, before the file is produced, that anyone who opens it can read it.
4. **Given** a file produced by the ENCRYPTED format that shipped before this amendment, **When**
   it is imported in a session that can produce the original wallet's signature, **Then** it opens
   as it always did.
5. **Given** that same encrypted file in a session that cannot produce that signature (a passkey
   account, or no signer), **When** it is imported, **Then** the refusal names the real reason —
   an older encrypted export, openable only by the wallet that created it — and says what to do
   about it, and NEVER attributes the failure to the wrong wallet, a different wallet, or a
   disconnected one.
6. **Given** an import that is malformed, is not an address book, or carries an unknown format,
   **When** it is imported, **Then** it is rejected with a message naming what was wrong and the
   existing book is unchanged (FR-021).
7. **Given** a book with no contacts, **When** the member exports, **Then** the surface says there
   is nothing to export rather than writing an empty file that reads as a broken export.

### Functional Requirements (replaced)

- **FR-019** *(replaces FR-019)*: Members MUST be able to export their entire address book to a
  **plain JSON file** — self-describing (`format` + `version`), human-readable, carrying the
  nicknames, addresses, networks and notes as text. The export MUST NOT require a wallet
  signature, a passphrase, or any key material, and MUST behave identically on every account type
  the app supports, passkey accounts included.
- **FR-020** *(replaces FR-020)*: Members MUST be able to import a plain JSON export and recover
  every contact with its addresses, networks and notes, without a signature and without regard to
  which member or account type produced the file. The importing member need not be the exporting
  one.
- **FR-021** *(replaces FR-021)*: An import that is malformed, is not an address book, or carries
  an unrecognised `format`/`version` MUST fail with a message naming what was actually wrong, and
  MUST leave the existing address book unchanged. The pre-amendment encrypted envelope
  (`fairwins-address-book-backup`, version 1) remains importable wherever the original wallet's
  signature can be produced; where it cannot, the refusal MUST say that the file is an older
  encrypted export openable only by the wallet that made it, and MUST NOT say the wallet is wrong,
  different, missing, or disconnected.

FR-022 stands unchanged, and its standing is now load-bearing: an import adds and never
overwrites, and a differing nickname or note is a question put to the member, not a write.

### Functional Requirements (added)

- **FR-031**: The export surface MUST disclose, in words and before the file is produced, that the
  exported file is **not encrypted** — that every nickname, address and note in it is readable by
  anyone who opens the file. The file itself MUST carry the same statement, so the fact survives
  the file leaving the app.
- **FR-033**: The Export and Import controls MUST each carry an icon alongside their word label.
  The icon is decorative (`aria-hidden`) and never the sole carrier of the control's meaning; where
  the responsive layout hides the word, the control MUST still expose an accessible name
  (FR-023, WCAG 1.4.1 / 4.1.2).

*FR-032 is deliberately not minted here, and — corrected on review — it should not be minted at
all.* `docs/developer-guide/address-screening.md` and the root `CLAUDE.md` both cited a bare
"FR-032" for the forced, live screen at submission time, next to the words "spec 021", which read
as a spec-021 requirement that had never been written down. It is not one: the requirement exists
verbatim as **spec 067 FR-032** — *"Screening MUST occur on the real acting wallet … and MUST be
enforced at the point of submission — not only at display time — so a wallet deny-listed between
quote and submission is still refused"* — and both citations have been corrected to name it. This
is the same cross-spec number bleed that mislabels spec 067's FR-044 as spec 071's in four places.

Minting a spec-021 FR-032 would therefore create a second requirement, under the same number in a
different spec, saying what 067 already says — and it would not even be true as written: only
Bridge, Supply, group pay and the mini-app host `submit` force a re-read past the cache. Transfer
and Pay (single-recipient) screen advisorily at render and rely on the gateway and the on-chain
guard, which spec 021 permits (FR-013 is a ceiling on what the client may claim, not a floor on
what it must check). The number is left unused rather than filled.

### Success Criteria (added)

- **SC-012**: A member signed in with a passkey completes a full export → import round-trip with
  100% of contacts, addresses, networks and notes recovered, and zero signature prompts. No surface
  displays "Wallet not connected" at any point in either direction.
- **SC-013**: An export file opened in a plain text editor shows nicknames and addresses as
  readable text — and the surface that produced it said so before producing it.
- **SC-014**: An encrypted pre-amendment file imported in a session that cannot sign for the
  original wallet produces a message naming the file's format as the cause. The strings "wrong
  wallet", "different wallet" and "not connected" appear nowhere in it.

### What this amendment stops claiming

The following were true of the encrypted envelope and are **no longer true of the export file**.
They must not be restated in the spec, the contracts, the user guide, or the UI:

- **Confidentiality at rest.** The file is plain text and protects nothing. Emailed, dropped in
  shared storage, or left in `~/Downloads` on a shared machine, every contact a member has saved is
  legible to whoever finds it. That is the accepted cost of a file a member can actually read and
  share, and it is the whole reason FR-031 exists.
- **Authenticity.** The AEAD tag also proved a file had not been altered since export. Plain JSON
  proves nothing about itself: import validates *shape*, not *truth*. A file received from someone
  else can put any address under any nickname. FR-022's never-overwrite merge and the estate
  screening pill (FR-024–FR-028) on every imported address are what carry that weight now — an
  address book entry is a convenience, never an assertion that an address is safe or is who it says.
- **"Same wallet" as an access control.** There is no longer any sense in which a file belongs to a
  wallet. The only file that still does is a pre-amendment envelope, and only until the member
  re-exports it.

### Out of scope (recorded)

- An optional passphrase-encrypted export alongside the plain one. It would restore
  confidentiality for members who want it, at the cost of a second format, a second failure mode,
  and a passphrase to remember — none of which the reported problem needs. Follow-up if members
  ask for it.
- Signing an export so a recipient can verify who produced it. Spec 084's Verify surface is the
  natural home for that, and nothing in this feature depends on it.
