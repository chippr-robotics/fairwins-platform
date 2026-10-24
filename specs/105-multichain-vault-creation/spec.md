# Feature Specification: Guided Multichain Vault Creation — One Vault, Chosen Networks

**Feature Branch**: `claude/multichain-experience-improvements-7z3wti`

**Created**: 2026-09-05

**Status**: Draft

**Input**: User description: "Guided multichain vault creation, one vault card everywhere. Vaults are chain-abstracted like every other multichain surface: identical rules on all chains, one details card with network badges instead of one card per network, network switching only at the moment an action needs a specific chain. Creation becomes a four-sheet guided flow for non-technical members: (1) choose how it works — 'Joint account' (1-of-2), 'Controlled' (n-of-n), 'Complex' (custom m-of-n); (2) set rules as a tappable tile grid — daily cap, wait between sends, allowed money, big sends; (3) pick networks and watch the app orchestrate deployment with per-network live status, same predicted address on every network, safe to leave mid-flow; (4) done. Details view offers deploying to additional networks later. Load-a-vault sheet needs a visual refresh. Rules are one semantic config per vault applied on every chain; per-chain drift is disclosed, never papered over."

## The problem in one paragraph

Spec 102 made a **loaded** vault one card and one sheet — but a **new** vault is still created the old way: one form, one network (whichever the wallet happens to be connected to), owners and a threshold as raw numbers, and a policy composer written for people who already know what a policy is. A member who wants "a shared account with my partner, on the networks we use" has to understand thresholds, switch networks before starting, run the flow once per network, and then discover that the Details view shows them one repeated card per network — each with a "switch network" prompt — for what they think of as *one* account. Creation, details, and later growth must speak the same language the rest of the app now speaks: a vault is one thing; a network is a property of a transaction.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Guided creation: type → rules → networks → done (Priority: P1)

A non-technical member opens Protect and taps Create. Instead of a form, they get a four-step guided flow of bottom sheets:

1. **Choose how it works.** Three plain-language presets: **Joint account** ("either of you can move funds" — two owners, one signature), **Controlled** ("everyone must approve — nothing moves unless all owners sign"), and **Complex** ("custom votes — pick any m-of-n threshold yourself"). Each preset states its behaviour in one sentence; owners are entered with the platform's shared address entry (self / address book / QR).
2. **Set rules.** A tappable tile grid, not a rule composer: **Daily cap** (an amount of the everyday stable token per 24 hours), **Wait between sends** (a pause between outgoing transactions), **Allowed money** (the token that moves freely under the rules; others need a full vote), and **Big sends** (amounts over the daily cap require every owner to sign). Tapping a tile edits it in place. A one-line live summary states the resulting arrangement.
3. **Pick networks + watch it deploy.** A multi-select of the networks vaults are offered on. The member picks any set; the app orchestrates deployment to each one, showing per-network status as it goes: **queued → awaiting signature → deploying → confirming → live**, or **failed** with a retry. The predicted address — the same on every network — is shown before anything is signed. The member can leave at any point; nothing is lost.
4. **Done.** One card, one address, badges for every network it lives on, and an honest statement of anything still pending (a network still confirming, or rules awaiting co-owner approval where the chosen type requires everyone to sign them in).

**Why this priority**: This is the feature — creation is the door to custody, and today it filters out exactly the members Protect exists for.

**Independent Test**: Create a Joint vault on two networks in one sitting; verify the same address is live on both, the rules the member chose govern both, and no step asked the member to pick or switch a network before the moment a signature needed one.

**Acceptance Scenarios**:

1. **Given** a connected member on the create flow, **When** they choose Joint account and add a second owner, **Then** the flow proceeds with two owners and a one-signature arrangement without ever showing the word "threshold" as a bare number they must invent.
2. **Given** the rules sheet, **When** the member changes the daily cap and the wait, **Then** the summary line updates to describe the new arrangement in plain language before anything is signed.
3. **Given** three selected networks, **When** deployment runs, **Then** each network shows its own live status, a signature is requested per network exactly when that network needs it, and one network failing leaves the others' progress untouched.
4. **Given** a deployment in progress, **When** the member closes the sheet or the app, **Then** networks already live stay live, and reopening the vault shows current per-network status with the remaining networks still offered.
5. **Given** the flow completes, **Then** the vault appears as ONE card with the address and a badge per live network — never one card per network.

---

### User Story 2 - One details card, network rows, drift disclosed (Priority: P2)

A member opens the Details view of a vault that lives on several networks. They see **one** card: the address (with "same address on every chain" stated where true), a **Networks** section listing one compact row per network — its status (live with its arrangement, confirming, view-only, unreadable with retry, or **not deployed with an inline Deploy action**) — the owners listed once with the platform's identity resolution (address book > callsign > ENS > generated), the rules stated once, and the acting-as choice. Where a fact genuinely differs on one network (owners changed on one chain, rules edited on another), the card says so, naming the network — it never averages, hides, or repeats the whole card per network. A single up-front line MAY state which network the wallet is on and offer the switch, but actions that need a specific chain ask at the moment of the action, exactly as the Queue already does.

**Why this priority**: The repeated per-network card with its "switch network to view" prompts is the loudest remaining leak of chain plumbing into a member surface.

**Independent Test**: Load a vault deployed on 3+ networks; Details shows one card with a network row per instance, and no forced "switch network" gate before content renders.

**Acceptance Scenarios**:

1. **Given** a vault with identical owners/threshold/rules on all its networks, **When** Details renders, **Then** the shared facts appear exactly once, and the Networks section is one row per network carrying only that network's status and arrangement.
2. **Given** cohort networks the vault is not deployed on, **When** Details renders, **Then** those networks appear as "Not deployed" rows with an inline Deploy action (US3) — for vaults with a creation record — and with the honest unavailability reason otherwise.
3. **Given** a vault whose rules were changed on one network only, **When** Details renders, **Then** the card states the shared rules AND names the differing network with its differing value — never a silent merge.
4. **Given** a network whose state could not be read, **When** Details renders, **Then** that network's row says it could not be read (with retry) and shared facts are labelled as covering only the networks that answered.
5. **Given** any owner-set or rules action from Details, **When** the member confirms it, **Then** the wallet network switch happens at that moment, on the named chain, per the established at-tap-time behaviour.

---

### User Story 3 - Deploy to more networks later (Priority: P3)

From the Details view of a vault created through this flow, a member taps "Add a network", picks from the supported networks the vault is not yet on, and the same orchestration deploys it there — same address, same rules. If the vault's owners have changed since creation, the flow says plainly that the new network starts from the vault's **original** owner arrangement and shows what that is, before anything is signed. A vault that was created outside this flow (loaded by address) is told honestly that adding networks isn't available for it and why.

**Why this priority**: Networks-later completes the abstraction — the network set becomes a property the member grows over time, not a one-shot decision.

**Independent Test**: Create a vault on one network, then add a second network from Details; the address matches and rules arrive with it.

**Acceptance Scenarios**:

1. **Given** a vault created here on Polygon, **When** the member adds Base later, **Then** the deployment lands at the identical address and the per-network status UI is the same one used at creation.
2. **Given** a vault whose owners changed since creation, **When** the member adds a network, **Then** the sheet states the new network will start with the original owners (listing them) and requires explicit confirmation.
3. **Given** a vault loaded by address that this app did not create, **When** the member looks for "Add a network", **Then** the option explains it needs the vault's original creation details, which this app does not hold — not a dead control, not silence.

---

### User Story 4 - Load-a-vault visual refresh (Priority: P4)

The Load-a-vault sheet is restyled to the app's current look and feel — the platform's field chrome, buttons, spacing, and theme tokens — with unchanged behaviour: address / %callsign / ENS entry, address book and QR helpers, private label, and probing every network for the address.

**Why this priority**: Cosmetic, but it is the sibling entry point to Create and currently reads as unstyled.

**Independent Test**: Visual pass in both themes and both viewports; behaviour unchanged in existing tests.

**Acceptance Scenarios**:

1. **Given** the Load sheet, **When** rendered in light and dark themes at phone and desktop widths, **Then** every control uses the app's shared styling with no browser-default chrome.

---

### User Story 5 - Queue that reads like a to-do list (Priority: P3)

The vault Queue gains a readability pass: filter chips — **All**, **Needs you** (with a count), and one per network the vault has queued items on — and each proposal is described in plain language where the app can decode it ("Send 200 USDC on Base · to Studio treasury", "Add owner on Optimism") with the proposer and signers shown through the platform's identity resolution and a clear "N of M signed · needs you / waiting on <owner>" line. Undecodable proposals keep today's honest raw presentation. The primary action on an item that needs the member is a single prominent "Review & sign". A footer states the abstraction honestly: queued items stay on their own chain; the list is all of them.

**Why this priority**: The queue is where multichain custody is actually lived in day to day; the abstraction is only as good as the list members act from. It builds on the existing cross-chain queue and ships independently of creation.

**Independent Test**: A vault with pending items on two networks shows both under All, the member's actionable items under Needs you, and a decoded USDC send reads as an amount + recipient rather than calldata.

**Acceptance Scenarios**:

1. **Given** pending proposals on two networks, **When** the Queue renders, **Then** All shows both (each tagged with its network), and each network chip filters to its own items — with the four-state per-chain read honesty unchanged.
2. **Given** a proposal the member has not yet signed whose progress their signature would advance, **When** the Queue renders, **Then** it counts under "Needs you" and carries the needs-you state; one the member already signed shows whom it waits on instead.
3. **Given** a stable-token transfer proposal, **When** it renders, **Then** it reads as an amount, token, recipient (identity-resolved) and network; **Given** an arbitrary contract call the app cannot decode, **Then** it renders with today's honest raw form, never a guessed description.

---

### Edge Cases

- **A wallet refuses the network switch mid-orchestration** → that network's row reports it (naming both chains, per the established per-row alert), stays retryable, and no other network is affected.
- **The member's signing rail cannot act on a selected network** (established: the rail is a property of the signer) → the network is shown with the reason and the way out before any signature is attempted, not discovered by a failure.
- **Rules require approvals the creator alone cannot give** (Controlled / Complex where more than one signature installs rules) → the flow completes with the rules honestly marked "awaiting co-owner approval" per network, visible in the existing queue; never silently dropped, never falsely shown as active.
- **A network has no everyday stable token configured** → the daily-cap tile for that network's deployment is stated as not applicable there, named, rather than silently skipped.
- **The member selects only one network** → the flow is identical minus the multi-network status; nothing about the vault forecloses adding networks later.
- **Deployment succeeds but rule installation fails on one network** → the vault is live there with the failure named and retryable; the Done sheet and Details both disclose it.
- **The same address is already occupied on a target network** (the vault already exists there, e.g. deployed from another device) → detected and reported as already live, not as a failure.
- **Testnet/mainnet cohort** → creation and add-a-network offer only networks in the member's build cohort; a loaded vault that also exists outside the cohort continues to display those instances read-only as today.
- **Mid-flow state on another device** → per-network deployment state is re-derived from the networks themselves on load, so a second device shows truthful status without any shared draft.

## Requirements *(mandatory)*

### Functional Requirements

**Creation flow**

- **FR-001**: Vault creation MUST be a guided sequence of four bottom sheets — how it works, rules, networks + deployment, done — replacing the single-form flow.
- **FR-002**: The first sheet MUST offer exactly three presets — Joint account (two owners, either signs), Controlled (all owners sign), Complex (member-chosen m-of-n) — each described in one plain-language sentence, with owner entry through the platform's shared address entry. Presets set the arrangement; Complex exposes the threshold control.
- **FR-003**: The flow MUST NOT produce a single-owner, single-signature vault with no rules (the existing refusal stands, stated in plain language).
- **FR-004**: The rules sheet MUST present rules as a grid of tappable tiles — daily cap, wait between sends, allowed money, big sends — each editable in place, each stating its current value, with a live plain-language summary of the whole arrangement. "Big sends" MUST mean: amounts above the daily cap require every owner's signature.
- **FR-005**: Rules MUST be captured once as a single semantic configuration for the vault and applied to every network the vault deploys to; the member MUST never be asked to configure rules per network.
- **FR-006**: The networks sheet MUST offer a multi-select of every network vaults are offered on within the member's build cohort, with none preselected as a function of the connected wallet's current chain beyond a sensible default; the member MUST be able to proceed with any non-empty selection.
- **FR-007**: The predicted vault address MUST be shown before the first signature and MUST be identical on every selected network and on any network added later.
- **FR-008**: Deployment MUST be orchestrated by the app across the selected networks with per-network status — queued, awaiting signature, deploying, confirming, live, failed (with retry) — updating live, with per-network failure isolation and any needed network switch performed at the moment that network's signature is requested.
- **FR-009**: Leaving the flow (or the app) mid-deployment MUST lose nothing: networks already deployed remain live and discoverable, and current status MUST be re-derivable when the vault is next opened.
- **FR-010**: Where installing the rules on a network requires more signatures than the creator's own, the flow MUST complete with those installations queued for co-owner approval through the existing proposal queue, and every surface that states the rules MUST distinguish "active" from "awaiting approval" per network.
- **FR-011**: The done sheet MUST show the single resulting vault card — one address, one badge per network — and every fact still pending (confirming networks, rules awaiting approval, failed networks with retry).

**Details view**

- **FR-012**: The Details view MUST render one card per vault: address, network badge per deployed network, ownership arrangement, and rules stated once — never a repeated per-network card and never an up-front "switch network" prompt.
- **FR-013**: Where owners, threshold, or rules differ between networks, the card MUST disclose the difference naming the network(s) and the differing value; shared facts MUST be labelled as shared only across the networks actually read, and an unreadable network MUST be shown as unreadable with retry — never folded into the shared statement.
- **FR-014**: Every action needing a specific chain MUST request the network switch at action time, on the named chain, per the established at-tap-time behaviour and signer-first write rail.

**Growth**

- **FR-015**: Details MUST offer deploying the vault to supported cohort networks it is not yet on — surfaced as inline Deploy actions on the "Not deployed" network rows — reusing the same orchestration and status UI as creation, landing at the same address with the same rules.
- **FR-016**: The information needed to add networks later MUST be retained per vault created through this flow, and MUST survive the member moving devices via the platform's existing backup.
- **FR-017**: When the vault's live owner arrangement differs from its arrangement at creation, adding a network MUST disclose — before any signature — that the new network starts from the original arrangement, listing it, and require explicit confirmation.
- **FR-018**: For vaults this app did not create (loaded by address), the add-a-network affordance MUST state honestly that it is unavailable and why, rather than being absent or inert.
- **FR-019**: A target network where the address is already live MUST be reported as already live, not as a deployment failure.

**Load sheet**

- **FR-020**: The Load-a-vault sheet MUST be restyled to the platform's shared field chrome, buttons, and theme tokens in both themes and both viewport profiles, with behaviour unchanged.

**Queue**

- **FR-021**: The Queue MUST offer filter chips — All, Needs you (with a live count), and one chip per network with queued items — over the existing cross-chain read (four-state per chain, partial totals named, unchanged).
- **FR-022**: Proposals the app can decode MUST be described in plain language (action, amount + token, counterparty via the platform's identity resolution, network); undecodable proposals MUST keep the honest raw presentation — never a guessed description.
- **FR-023**: Each pending item MUST state its signature progress and whether it needs the member ("N of M signed · needs you") or whom it waits on, with signers/proposer shown through identity resolution; the primary action for a needs-you item is a single Review & sign.

### Key Entities

- **Vault type preset**: a named ownership arrangement (Joint / Controlled / Complex) resolving to owners + how many must sign.
- **Rule set (semantic)**: the vault's one rules configuration — daily cap amount, wait duration, allowed money, big-send behaviour — independent of any network, realized on each network in that network's own terms.
- **Creation record**: the per-vault memory of how it was created (original owners, arrangement, deployment identity) that makes same-address growth to new networks possible; backed up with the member's other synced data.
- **Per-network deployment status**: the live state of the vault on one network — queued / awaiting signature / deploying / confirming / live / failed / already-live — always re-derivable from the network itself.
- **Vault details card**: the single per-vault presentation — address, network badges, arrangement, rules, and per-network drift/pending disclosures.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member with no crypto vocabulary creates a two-owner shared vault live on two networks in under three minutes of active interaction, without being asked to pick or switch a network before a signature needs one.
- **SC-002**: The vault's address is byte-identical on every network it is deployed to, at creation and when networks are added later — 100% of the time.
- **SC-003**: Details renders exactly one card for a vault on N networks, for every N ≥ 1 (today: N cards).
- **SC-004**: A deployment failure on one network never alters another network's outcome, and every failure surface names the network and offers a retry — verified for each failure mode in the edge cases.
- **SC-005**: Closing the app mid-deployment and reopening shows truthful per-network status with zero lost deployments.
- **SC-006**: Every drift case (owners, threshold, rules differing on one network) is disclosed naming the network; zero cases render a merged value without disclosure.
- **SC-007**: A member can tell from the Queue alone, without opening an item, what each pending action does (for decodable actions), on which network, and whether it needs them — verified for transfer and owner-change proposals.
- **SC-008**: All existing custody behaviours not named here (queue, policy governance, style, acting-as, write rail) pass their existing tests unchanged.

## Assumptions

- The networks vaults are offered on remain the existing custody set; this feature adds no new network.
- "Daily cap" and "allowed money" default to each network's everyday stable token (the one the platform already uses for that network); the member sets one amount, and each network realizes it in its own token. Networks without a configured stable token are disclosed per the edge case.
- The rules tiles map to the existing ordered rules engine's vocabulary; the flow offers only arrangements that engine can express, and the tile grid is the member-facing face of the same starter-policy machinery members already get today.
- Same-address deployment relies on the vault's creation parameters being identical on every network — which is why rules (whose realization is network-specific) take effect through per-network installation after deployment rather than being baked into the deployment itself, and why the creation record must be retained for later growth. This is stated here because it produces member-visible behaviour (rules "awaiting approval", original-owners disclosure), not as an implementation choice.
- Push/remote notification of deployment completion ("we'll ping you") is limited to the app's existing in-app notification surface; nothing here adds a new notification channel.
- The existing single-network creation entry (deploy on the connected chain) is subsumed by this flow; no separate legacy create form remains.
