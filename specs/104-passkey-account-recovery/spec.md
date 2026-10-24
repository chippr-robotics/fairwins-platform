# Feature Specification: Passkey account recovery — find the account, never guess it

**Feature Branch**: `spec/104-passkey-account-recovery`

**Created**: 2026-09-04

**Status**: Draft

**Input**: "i am however seeing this error when trying to use a key from the old install. if a
user loses a device and attempts to sign in with another device the key should work. we need to
identify when this edge case occures and how to recover" — reported against the installed PWA
after an uninstall/reinstall, with a screenshot of the sign-in sheet showing:

> This passkey controls an account that this browser cannot identify. Sign in on the device where
> it was set up, or use a linked wallet to recover access.

## The gap this closes

**The app does not know which account a passkey controls. It guesses, then checks the guess.**

`resolveAccountForCredential` (`frontend/src/connectors/passkey.js`) resolves an account from a
passkey the browser has no record of by *deriving* an address — `deriveAddress([ownerBytes])` —
on the assumption that this passkey is the account's **sole initial owner**. It then reads the
chain to sanity-check the guess. That assumption holds for the common case and fails for every
other one, and the failure is silent in one direction and a dead end in the other:

| the passkey is… | derived address | what the member gets today |
|---|---|---|
| the sole initial owner, still an owner | their account, deployed, lists the key | **works** |
| not the sole initial owner (added later, or created alongside another owner), and the derived address happens to be deployed | someone else's account, or an unrelated one of theirs | the error above — a **dead end** |
| not the sole initial owner, and the derived address is undeployed | an address nobody has ever used | **signed into a brand-new empty account, with no warning** |
| rotated off the account it used to control | their old account, deployed, no longer lists the key | the error above — a **dead end** |

The third row is the worst outcome and the quietest: the guard only refuses when the derived
address is *deployed and does not list the key*, so an undeployed derived address is returned as
"your account". A member whose funds are in the account this passkey actually controls is shown a
fresh, empty one. Nothing tells them what happened.

**The recovery the error advertises does not exist.** The sibling message —

> This passkey is not yet linked to an account on this browser. Enter your account address to
> relink.

— names a flow that is a string and nothing else: there is no UI, no handler, and no code path
that accepts an account address. Controllers are not indexed in the subgraph either. So both
failure modes are terminal, and the app tells the member to do something it does not offer.

This matters because the situation it fails in is the one passkeys exist to survive: **a member
who lost a device, signing in on another one.** The passkey syncs, the ceremony succeeds, the
signature is valid — and the app cannot name the account it opens.

## Design principle

> **A passkey's account is looked up, never derived.** The chain already knows which accounts
> list a given owner; the app asks it. Derivation stays only as the counterfactual answer for a
> key that controls no deployed account yet — and when the app is not certain, it says so and
> offers a way forward instead of returning an address it has not verified.

The member may supply a *hint* (an account address they remember). The hint is never trusted:
the chain decides whether that key is an owner of that account. What the member knows can narrow
a search; only the chain can settle it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A member signs in on a new device and lands on the right account (Priority: P1)

A member's phone is lost or reset. On a new device the passkey is available through their
platform password manager. They sign in to FairWins and reach the account that passkey controls —
including when that passkey was added to the account later, rather than being the key that
created it.

**Why this priority**: This is the promise of a synced passkey and the reason the feature exists.
Today it works only when the passkey created its own account and still controls it; every other
shape either dead-ends or silently opens an empty account. Nothing else in this spec matters if
the member cannot get back to their funds.

**Independent Test**: With an empty local credential book, complete a ceremony with a passkey
that is a non-initial owner of a deployed account, and confirm the session opens **that** account
and can transact.

**Acceptance Scenarios**:

1. **Given** a passkey that is the sole initial owner of a deployed account and still an owner,
   **When** the member signs in with an empty local book, **Then** the session opens that account
   — behaviour identical to today.
2. **Given** a passkey that was added to a pre-existing account as a later controller,
   **When** the member signs in with an empty local book, **Then** the session opens the account
   that lists it, not the address derived from the key.
3. **Given** a passkey that controls more than one account, **When** the member signs in,
   **Then** the app presents the accounts it found and the member picks; the app never picks for
   them.
4. **Given** the lookup found an account, **When** the session is established, **Then** the
   credential record is written with the account address and the owner index, so subsequent
   sign-ins need no lookup.

---

### User Story 2 — A member is never silently placed in the wrong account (Priority: P1)

When the app cannot verify which account a passkey controls, it says so plainly and does not
present an unverified address as the member's account.

**Why this priority**: Same priority as US1 because it is the failure half of the same promise.
A member shown an empty account they have never used will reasonably conclude their money is
gone. An honest refusal is recoverable; a confident wrong answer is not. This is
constitution III (honest state) applied to identity rather than balances.

**Independent Test**: With an empty local book, complete a ceremony with a passkey that controls
no deployed account, and confirm the app does not claim an address is the member's account
without saying what it could not verify.

**Acceptance Scenarios**:

1. **Given** a passkey with no deployed account found by lookup, **When** sign-in resolves,
   **Then** the member is told no existing account was found for this passkey and is offered the
   recovery entry points — never signed straight into a derived address as though it were theirs.
2. **Given** the chain could not be read at all (RPC failure), **When** sign-in resolves,
   **Then** the outcome is reported as *unverified*, distinct from *no account exists* — an
   unreachable chain is not evidence of absence.
3. **Given** a passkey that a lookup shows was rotated off an account, **When** sign-in resolves,
   **Then** the member is told the key no longer controls that account and pointed at the
   controllers that do.
4. **Given** any of these outcomes, **When** it is shown, **Then** the member can still reach
   every other sign-in method without restarting the app.

---

### User Story 3 — A member recovers by naming their account (Priority: P2)

A member who knows their account address can enter it, and the app signs them in if — and only
if — the chain says the passkey they just used is an owner of it.

**Why this priority**: The fallback for when lookup is unavailable, incomplete, or returns
nothing, and the concrete implementation of the promise the current error already makes. P2
because US1 should make it unnecessary in the common case, but it is the path that works when
scanning cannot run.

**Independent Test**: Enter a known account address after a ceremony and confirm sign-in succeeds
for an address that lists the key and is refused for one that does not.

**Acceptance Scenarios**:

1. **Given** an address the member entered and a completed ceremony, **When** the chain lists the
   recovered owner bytes among that account's current owners, **Then** the session opens that
   account at the owner index the chain reports.
2. **Given** an address that does not list the key, **When** the member submits it, **Then** they
   are refused with a reason that distinguishes "that account exists but this passkey does not
   control it" from "there is no account at that address".
3. **Given** an address that cannot be read, **When** the member submits it, **Then** the failure
   is reported as unverified and the member may retry — it is never treated as a refusal.
4. **Given** a successful relink, **When** it completes, **Then** the credential record is
   written exactly as a lookup-resolved sign-in would write it.

---

### User Story 4 — An operator can tell these cases apart after the fact (Priority: P3)

Each distinct outcome is distinguishable in the client audit ledger, so a support conversation
starts from what happened rather than from a screenshot.

**Why this priority**: Valuable and cheap, but nobody's access depends on it.

**Independent Test**: Drive each outcome and confirm a distinct, address-only audit entry.

**Acceptance Scenarios**:

1. **Given** any recovery outcome, **When** it resolves, **Then** an audit entry records which
   outcome occurred and the account address involved, and **never** key material, the credential
   id, or the user handle.

## Requirements *(mandatory)*

### Functional

- **FR-001**: The app MUST resolve a passkey's account by asking the chain which accounts list its
  owner bytes, rather than by deriving an address and assuming.
- **FR-002**: Lookup MUST find accounts where the passkey was an **initial** owner and accounts
  where it was **added later**. `AccountCreated(address indexed account, bytes[] owners, uint256)`
  carries the initial set; `AddOwner(uint256 indexed index, bytes owner)` carries later additions.
  Neither event indexes the owner, so neither can be filtered by topic on the owner value — the
  search strategy is a `plan.md` concern, but covering both origins is a requirement.
- **FR-003**: Every candidate account MUST be confirmed against its **current** owner set before
  it is offered. An account that once listed the key but no longer does MUST NOT be offered as a
  destination.
- **FR-004**: Resolution MUST report one of exactly four outcomes: `resolved` (one or more
  verified accounts), `none-found` (the chain was read and lists no account for this key),
  `unverified` (the chain could not be read), or `not-controller` (a named account exists and
  does not list this key). A value exists only for `resolved`.
- **FR-005**: An `unverified` outcome MUST NOT be reported as `none-found`. An unreachable chain
  is not evidence that no account exists.
- **FR-006**: When resolution is not `resolved`, the app MUST NOT establish a session on a derived
  address. Derivation remains available only to *create* a new account, which the member must
  choose explicitly.
- **FR-007**: When more than one account is verified for a passkey, the member MUST choose. The
  app MUST NOT pick one.
- **FR-008**: The app MUST accept an account address from the member as a hint and MUST verify it
  against the chain before use. A hint MUST NOT be able to establish a session on an account whose
  current owner set does not include the recovered key.
- **FR-009**: A successful recovery MUST write the credential record — account address, public
  key, owner index — so that later sign-ins resolve locally and need no lookup.
- **FR-010**: Every failure MUST name what the app could not do and leave every other sign-in
  method reachable. No failure may leave the member unable to retry without restarting the app.
- **FR-011**: Audit entries MUST record the outcome and the account address only. Key material,
  credential ids, and user handles MUST NOT be written to the ledger.
- **FR-012**: Chain reads MUST go through the shared read-provider seam (spec 069) rather than
  hand-built clients, so a member's own RPC endpoints and failover apply. *(Note: today's
  `readControllers` builds its own client from `NETWORKS[chainId].rpcUrl`; bringing it onto the
  seam is in scope.)*
- **FR-013**: Recovery MUST stay within the build's cohort (constitution III). A mainnet build
  MUST NOT search testnet chains, or the reverse.

### Non-functional

- **NFR-001**: A lookup that cannot complete within a bounded time MUST resolve as `unverified`
  rather than hang. Spec 103's lesson applies: an unbounded wait on an external system is how a
  sign-in becomes a lockout.
- **NFR-002**: Recovery surfaces MUST meet WCAG 2.1 AA and pass the axe and Lighthouse gates.
- **NFR-003**: No change to `contracts/`. The events this feature reads already exist; this is a
  client-side change against deployed contracts.

### Key entities

- **Recovered key** — the P-256 public key recovered from the member's assertion, expressed as
  owner bytes. The only identity the chain can be asked about.
- **Candidate account** — an address the search associates with the recovered key, before
  confirmation.
- **Verified account** — a candidate whose *current* owner set includes the recovered key,
  together with the owner index. The only thing a session may be opened on.
- **Resolution outcome** — `resolved` | `none-found` | `unverified` | `not-controller`.

## Success criteria

- **SC-001**: A passkey that is a non-initial owner of a deployed account signs in to that
  account on a browser with an empty credential book.
- **SC-002**: No sign-in path establishes a session on an address whose owner set has not been
  read and confirmed to include the key.
- **SC-003**: An unreachable chain during recovery produces a retryable, clearly-worded
  unverified state, and never a claim that no account exists.
- **SC-004**: A member who knows their account address can recover with it, and a member who
  enters an address they do not control is refused.
- **SC-005**: The strings `Enter your account address to relink` and `this browser cannot
  identify` no longer describe unimplemented behaviour — each surface either performs what it
  offers or says plainly what it cannot do.

## Out of scope

- Changing `contracts/` in any way. The required events exist on the deployed accounts and
  factory.
- Indexing controllers in the subgraph. It may turn out to be the right search strategy, but that
  is a `plan.md` decision, and this spec must be satisfiable without new infrastructure.
- Recovering an account whose owner set no longer contains any key the member holds. That is the
  linked-wallet and social-recovery problem, not this one.
- Changing how accounts are created, or the derivation itself. Derivation stays correct for what
  it is: the counterfactual address of a not-yet-deployed account.

## Assumptions

- The deployed account implementation exposes `nextOwnerIndex` / `ownerAtIndex`, as
  `readControllers` already relies on.
- `AccountCreated` and `AddOwner` are emitted by the deployed factory and accounts as declared in
  `contracts/account/`. **Their historical coverage on each live chain has not been verified and
  MUST be confirmed during planning** — a search strategy is only as good as the log history it
  can actually reach.
- The reported failure is one of the shapes in the table above. Which one has **not** been
  established for the reporter's specific key: it would need a chain read against their account,
  which was not available when this spec was written. The spec deliberately covers all of them
  rather than betting on one.
