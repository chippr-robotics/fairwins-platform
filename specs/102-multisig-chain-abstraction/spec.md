# Feature Specification: Multisig Chain Abstraction — one vault, every network

**Feature Branch**: `claude/multichain-experience-improvements-7z3wti`

**Created**: 2026-09-03

**Status**: Implemented (this branch)

**Input**: "The multichain experience is not good on the app currently. Make the multisig
experience intuitive and abstract away chain selection from the user. The card in the Protect
section should have a compact view of the card as we have in the Portfolio section. The action
ellipsis on a multisig should open a bottom sheet where the user can see the transaction queue
with a chain log indicating which network any pending transactions are on, a view for the card's
styling, and a view with all the additional Safe information with relevant address-book
cross-referencing, and let the user choose the active account they would be acting as."
Two staging screenshots accompanied the request: the "This address is a Safe on 6 networks —
pick another" prompt in Protect, and an 18-decimal balance overflowing the Wrap form.

## The gap this closes

A Safe deployed with the same address on several networks is, to the member, **one vault**. The
app models it as six: one card per `(chainId, address)` reference, each with its own chain badge,
its own expanded detail, its own switcher entry, and — before any of that — a prompt asking which
network to add. Chain is the first question the member is asked and the last thing they care
about: what they want to know is *what is waiting for my signature*, *who else can sign*, and
*am I acting as this vault right now*. The network is a fact about each pending transaction, not
about the vault.

The second screenshot is the same theme at a smaller scale: a raw 18-decimal balance rendered
verbatim, so the member's own balance does not fit on their screen.

## Design principle

> **A vault is an address. A network is a property of a transaction.** The member sees one card
> per vault, one queue that says which network each pending transaction is on, and one
> "act as this vault" choice. Every place the app needs a chain, it resolves or switches to it at
> the moment of the action, states which chain it is using, and never asks the member to pick one
> up front.

Nothing here changes what the chain enforces. Spec 068's rule — a state-changing action is sent
on the vault's own chain, with the wallet connected there — holds; the difference is that the
switch happens when the member taps **Approve**, not before they are allowed to see the queue.
Constitution III (honest state) governs every read: a chain that cannot be read is named, never
rendered as zero pending.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — One compact card per vault (Priority: P1)

A member opens Protect ▸ On chain and sees one compact card per vault they hold, in the same
visual language as the Portfolio account cards: avatar, "Multisig" tag, label, short address, a
network line ("Polygon" or "3 networks"), the threshold ("2 of 3"), the policy badge, a pending
count when there is one, and an "Active" mark when they are acting as it. Nothing expands inline.
A "⋯" on each card, and the card itself, open the vault sheet.

**Why this priority**: The list is the surface every other story starts from, and it is where
the six-cards-for-one-vault problem is visible.

**Independent Test**: Seed two references for the same address on two chains and one for a
different address; the list renders exactly two cards; the multi-chain card says "2 networks".

**Acceptance Scenarios**:

1. **Given** references to the same address on Polygon and Base, **When** Protect loads, **Then**
   ONE card renders with network line "2 networks" and the threshold from a readable instance.
2. **Given** a vault whose only network is unreachable, **When** the list renders, **Then** the
   card still renders, names the unreachable network, and does not show a threshold it could
   not read.
3. **Given** the member is acting as a vault, **When** the list renders, **Then** that card carries
   the "Active" mark and no other card does.
4. **Given** the member has customised the vault's card (picture / shade / pattern) anywhere,
   **When** the list renders, **Then** the compact card shows the same cosmetics — the same
   address-keyed profile the Portfolio card reads.

### User Story 2 — Loading a vault adds every network it lives on (Priority: P1)

A member pastes a Safe address. The app searches every custody network and adds the vault on
**all** of them, then says so: "Found on Polygon, Base and Optimism". If some networks could not
be reached it names them and offers to check again later. The member is never asked to pick a
network.

**Independent Test**: With a probe stub returning matches on three chains, load the address; three
references are stored under one address; the form closes; the list shows one card, "3 networks".

**Acceptance Scenarios**:

1. **Given** the address is a Safe on N ≥ 2 networks, **When** the member loads it, **Then** all N
   references are stored, the confirmation names every network, and the form closes.
2. **Given** some networks were unreachable during the probe, **When** the result renders, **Then**
   those networks are named as "not checked" with a "Check again" action; nothing is added for them.
3. **Given** the address is a Safe on exactly one network, **When** loaded, **Then** behaviour is
   byte-identical to today (one reference, form closes).
4. **Given** a vault the member already holds on Polygon is later found on Base via "Check again"
   from the sheet's Details view, **When** the probe returns, **Then** the Base reference is added
   to the same card; the Polygon one is untouched.

### User Story 3 — The vault sheet: Queue with a chain log (Priority: P1)

Tapping "⋯" (or the card) opens a bottom sheet titled with the vault's label, with three views:
**Queue**, **Style**, **Details**. Queue lists every pending or ready proposal across every network
the vault is on, newest first, each row tagged with its network. Approve / Execute / Cancel on a
row does the right thing on that row's network: if the wallet is elsewhere, the app switches it
first and says so; if the member refuses the switch, the action is refused with the reason and
nothing is signed. Below the queue, a per-network read status states what was read: "Polygon:
2 pending", "Base: none pending", "Optimism: could not be read — Retry", "Ethereum Classic:
proposal history is not configured on this network".

**Independent Test**: With hub logs stubbed on two chains, the Queue shows rows from both, each
with the right network pill; a chain whose RPC fails shows a named read failure, not "none
pending".

**Acceptance Scenarios**:

1. **Given** proposals pending on two networks, **When** Queue opens, **Then** both appear with
   their network pills, and the totals line says "3 pending across 2 networks".
2. **Given** one network's read failed, **When** Queue renders, **Then** that network is listed as
   unreadable with a Retry control, its rows are absent, and the total is labelled partial and
   names the network.
3. **Given** the wallet is on Polygon and the member taps Approve on a Base row, **When** the tap
   lands, **Then** the app requests a switch to Base, and on success sends the approval on Base.
4. **Given** the member refuses the switch, **When** the wallet rejects, **Then** the row shows
   "Approval not sent — this proposal is on Base and the wallet stayed on Polygon", nothing is
   signed, and the queue is unchanged.
5. **Given** the member is not an owner on a network, **When** its rows render, **Then** they are
   read-only there (no Approve control), stated as "view-only on Base".
6. **Given** no proposals anywhere, **When** Queue renders, **Then** the empty state says "Nothing
   waiting for a signature" and every network's read status is still listed.

### User Story 4 — The vault sheet: Style (Priority: P2)

The Style view is the spec-086 customize surface (picture, shade, pattern, reset) for this vault's
card. Changes render immediately on the compact card behind the sheet and on the Portfolio card.

**Acceptance Scenarios**:

1. **Given** the member picks a shade, **When** they close the sheet, **Then** the compact card and
   the Portfolio card both show it (one address-keyed profile).
2. **Given** the vault exists on three networks, **When** the member styles it, **Then** there is
   one style — cosmetics never fork per chain.

### User Story 5 — The vault sheet: Details with address-book cross-reference and acting account (Priority: P1)

The Details view shows everything else about the vault: the full address with copy, each network
the vault is on (Safe version, threshold, your role, reachability, policy state per network),
and the owner list. Every owner is cross-referenced: "You" for the connected wallet, the
address-book nickname where one exists, then callsign, then ENS, then the generated two-word name,
with the source shown; an owner not in the address book has an inline "Add to address book"
action. An **Acting account** section lists every account the member can act as (personal, every
vault, recovered, hardware) with the current one marked; choosing this vault makes it the acting
account instantly (spec 088: address-only, no ceremony). A "Remove from Protect" action forgets
the vault on every network after confirmation.

**Acceptance Scenarios**:

1. **Given** one owner is the connected wallet, one is in the address book as "Alice", and one is
   unknown, **When** Details renders, **Then** the rows read "You", "Alice · address book", and the
   generated name with an "Add to address book" action.
2. **Given** the member taps "Add to address book" on an owner, **When** the contact is created,
   **Then** the owner row updates to the new nickname without reloading.
3. **Given** the vault is on Polygon and Base and the wallet is on Polygon, **When** the member
   chooses this vault as the acting account, **Then** the header avatar switches, `active` binds
   to the vault address with `chainId` 137, and the Portfolio shows the vault's balances.
4. **Given** the member is acting as this vault and switches the wallet to Base, **When** the
   chain change lands, **Then** the acting identity follows to Base (the vault exists there) with
   no prompt; **When** they switch to a network the vault is NOT on, **Then** the acting identity
   stays pinned to its previous chain and any send auto-switches back (User Story 6).
5. **Given** the member chooses a different account (personal or another vault) from the Acting
   account list, **When** they choose, **Then** the acting identity changes to that account and the
   sheet's list marks it.
6. **Given** "Remove from Protect" is confirmed, **When** it runs, **Then** every reference for
   that address is removed, and if the member was acting as it the identity resets to personal.

### User Story 6 — Sending as a vault never asks for a chain (Priority: P2)

A member acting as a vault uses Transfer. If the wallet is on a network the vault is on, the
proposal goes there. If not, the app switches to the vault's pinned chain at submit time, states
it, and proceeds; a refused switch is a stated refusal, never a silent no-op or a wrong-chain send.

**Acceptance Scenarios**:

1. **Given** the acting vault is pinned to Polygon and the wallet is on Ethereum (no instance),
   **When** the member submits a transfer, **Then** the app switches to Polygon and creates the
   proposal there; the confirm UI names Polygon before signature.
2. **Given** the switch is refused, **When** the wallet rejects, **Then** the error names both
   chains and nothing is signed.

### User Story 7 — Balances fit on the screen (Priority: P2)

Every balance in the Wrap, Transfer and asset-picker surfaces renders through one display
formatter: up to 6 decimals below 1, 4 above, dust stated as "< 0.000001", an unread balance still
"—" (never 0). The 18-decimal raw string never reaches the DOM as display text.

**Acceptance Scenarios**:

1. **Given** a native balance of `2.006441459389172406`, **When** Wrap renders, **Then** the tile
   and the Balance line show `2.0064`.
2. **Given** the balance is `null`, **When** Wrap renders, **Then** it shows "—" (existing test
   `WrapView.test.jsx` keeps passing).
3. **Given** MAX is tapped, **When** the amount fills, **Then** it is still the full-precision
   spendable value (display formatting never rounds what is sent).

### Edge Cases

- A vault on two networks with different owner sets or thresholds: the compact card shows the
  threshold from the FIRST readable instance and "varies by network" when instances disagree;
  Details shows each network's values.
- Same address, Safe on one chain, an EOA / non-Safe on another: only Safe instances are added;
  the non-Safe chain is simply not listed (a probe match requires `isSafe`).
- A reference on a chain the build no longer knows (`NETWORKS[chainId]` undefined): still one
  card row, network named "Chain <id>", read status "not supported in this build", never dropped.
- A chain with a Safe but no `safeProposalHub` deploy block: queue status "proposal history is
  not configured on this network", never zero pending; Approve still possible on that chain if a
  proposal is reached another way (unchanged).
- The acting vault is removed from Protect: identity resets to personal.
- Sheet open while the list refreshes: the sheet re-resolves its vault from the live group each
  render (the Portfolio `AssetDetailSheet` precedent) — a vanished vault closes the sheet.
- Deep link `/wallet?tab=custody&vault=<address>` opens the sheet for that vault (address only —
  no chain in the URL, by design).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** (grouping): Protect ▸ On chain renders exactly one card per distinct vault address
  (case-insensitive), aggregating every `(chainId, address)` reference for it. The reference store
  schema is unchanged.
- **FR-002** (compact card): The vault card is the spec-086 `AccountCard` visual language —
  avatar, kind tag, label, short address, network line, threshold, policy badge, pending count,
  active mark, cosmetics — with no inline expansion. A "⋯" control per card opens the vault sheet;
  it lives outside the card's own button (an option contains no interactive children).
- **FR-003** (load-all): Loading an address adds a reference for EVERY network on which it is a
  Safe. Unreachable networks are named and re-probeable; nothing is added for them. The
  "pick another network" prompt is removed.
- **FR-004** (sheet): The vault sheet is built on the shared `ActionSheet` (focus trap, Escape,
  scroll lock, mobile bottom-sheet) with three views (Queue / Style / Details) as a `tablist`;
  the initial view is a prop; the sheet re-resolves its vault from the live list.
- **FR-005** (queue, all chains): Queue reads proposals for every instance through a provider for
  THAT instance's chain, never only the connected chain. Each chain resolves to one of
  `read` / `unreadable` / `not-configured` / `not-supported`; rows exist only for `read`.
- **FR-006** (chain log): Every queue row carries its network as a `NetworkPill`; the totals line
  states pending count and network count; a total missing any chain is labelled partial and names
  the chain(s).
- **FR-006a** (re-read): The Queue reads when it opens and does not poll, so it offers a Refresh
  that re-reads every network, whatever each chain's state is, and says while it is reading. A
  queue one block stale must not be indistinguishable from a settled one.
- **FR-007** (switch-at-action): Approve / Execute / Cancel on a row whose chain differs from the
  wallet's requests a network switch first; success proceeds on that chain; refusal produces a
  stated per-row error naming both chains and signs nothing.
- **FR-008** (ownership per chain): Row controls require ownership on THAT chain; a non-owner
  instance is read-only and says so.
- **FR-009** (style): The Style view renders the spec-086 customize body against the vault
  address; one profile per address, never per chain.
- **FR-010** (details): Details lists the full address (copy), every network with Safe version /
  threshold / role / reachability / policy state, and the owners.
- **FR-011** (owner cross-reference): Each owner resolves in the mandated priority (address book >
  callsign > ENS > generated) with its source shown; the connected wallet reads "You"; an owner
  absent from the address book gets an inline "Add to address book" that creates the contact on
  the vault's networks and re-renders the row.
- **FR-012** (acting account): Details includes the full acting-account list (personal, vaults,
  recovered, hardware — the `useAccountSwitcher` list, deduplicated to one entry per vault
  address) with the current one marked; choosing is instant and address-only.
- **FR-013** (acting identity follows the wallet where it can): `operateAsVault` stores the set of
  chains the vault is on; `active.chainId` is the wallet's chain when the vault has an instance
  there, else the vault's pinned chain; a wallet chain change re-evaluates this without a prompt.
- **FR-014** (submit auto-switch): A vault-mode `submit` whose wallet chain differs from
  `active.chainId` switches the wallet first (awaited; refusal rejects with both chains named).
  `canActAsVault` becomes "the vault exists on the connected chain OR a switch is possible".
- **FR-015** (remove-all): Removing a vault from Protect removes every reference for the address
  after confirmation; acting identity resets to personal when it was that vault.
- **FR-016** (switcher dedupe): The account switcher lists one entry per vault address.
- **FR-017** (deep link): `?vault=<address>` on the custody tab opens that vault's sheet.
- **FR-018** (display formatter): One `formatUnitsForDisplay(raw, decimals, opts)` helper; Wrap,
  Transfer and the universal asset picker render balances through it; `null` stays `null`
  (rendered "—"); amounts that are SENT are never rounded by it.
- **FR-019** (honesty): No surface renders a failed or unconfigured read as zero pending, zero
  networks, or a missing threshold as "0 of 0".
- **FR-020** (a11y): The sheet passes axe (serious/critical) in both viewports; the tablist is
  keyboard-navigable; every icon-only control has a name.
- **FR-021** (tests): Vitest for the grouping, queue aggregation, identity-follow logic, formatter
  and each sheet view; Cypress fast-tier coverage for every member flow that needs no chain and an
  on-chain case for the cross-chain approve; coverage matrix row for this spec.

### Non-functional / Security

- No contract changes. No new persistent store. Cosmetics remain device-local and unsynced.
- Reads use `getProvider(chainId)` per instance (per-vault failure isolation, spec 068 FR-003).
- The acting identity never falls through to the connected wallet's signer under a vault label
  (spec 088 FR-002 unchanged); the auto-switch adds a wallet prompt, never removes one.
- Address-book writes from the owner rows are the member's explicit tap, on the vault's networks
  only.

## Out of scope

- Cross-chain execution of one proposal on several networks (each proposal is one chain's).
- Vault creation on several networks at once (create stays single-chain; the card groups later).
- A URL-addressable chain for a vault (deliberately: the address is the identity).
- Reformatting balances outside Wrap / Transfer / asset picker (Pools, Admin, Recovery keep their
  own rendering; tracked as follow-ups).

## Success Criteria

- **SC-001**: A member with a Safe on 6 networks sees ONE card and is never asked to pick a
  network on load.
- **SC-002**: The Queue view lists pending work from every network the vault is on, each tagged,
  with any unreadable network named.
- **SC-003**: Approving a proposal on another network is one tap plus the wallet's own switch
  prompt; a refusal is stated.
- **SC-004**: Every owner row shows a resolved name and its source; unknown owners can be added
  to the address book in place.
- **SC-005**: The Wrap form's balance fits a 390px viewport.
- **SC-006**: All new surfaces pass the actor-critic screenshot loop with zero findings in the
  final round (`specs/102-multisig-chain-abstraction/screenshots/README.md`).
