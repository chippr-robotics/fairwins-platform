# Feature Specification: Passkey Wallet Accounts & Site-Wide Login Management

**Feature Branch**: `041-passkey-wallet-login` (working branch: `claude/passkey-wallet-login-lyiv8c`)

**Created**: 2026-07-04

**Status**: Draft

**Amended**: 2026-08-29 — release 1.14.0 adds an optional, off-by-default
**app lock** (User Story 7, FR-025–FR-028, SC-010). The amendment is additive:
no existing FR is renumbered or reworded, and FR-003 / clarification Q4
(sessions never self-expire) stand exactly as written.

**Input**: User description: "our apps login currently relies on a third party plug-in to allow a user to connect to a browser wallet or wallet connect. with the latest update on ethereum and rip7212 in place on polygon network, we need to offer users the ability to create passkey wallets to interact with the blockchain and manage their accounts. this will enable the highest user adoption for our app. we do not have a relayer deployed yet. explore options and then use /speckit-specify to define a site wide login management which enables passkey accounts for the users"

## Summary

Today "login" on FairWins is pure wallet connection: a user must already have a
browser-extension wallet or a WalletConnect-compatible mobile wallet, wired
through the app's connect surface (`WalletButton`/`WalletContext`). That
excludes the mainstream user who has no crypto wallet, no seed phrase, and no
native gas token — the exact audience the platform wants to reach.

Device biometrics (Face ID, Touch ID, Windows Hello) create and guard
**passkeys** — cryptographic credentials that sign on the P-256 curve. With the
P-256 verification upgrade (RIP-7212) live on the platform's primary network
(Polygon PoS) and its testnet (Amoy), it is now cheap enough to verify those
signatures on-chain, which makes **passkey-controlled on-chain accounts**
practical. Because passkeys cannot control a classic externally-owned address,
a passkey account is necessarily a **smart-contract account** owned by the
user's passkey credential.

This feature delivers a **site-wide login manager**: one consistent connect and
session surface where a brand-new user can create a FairWins account with just
a passkey — no extension, no seed phrase, no native gas token — while existing
browser-wallet and WalletConnect users keep working unchanged. A passkey
account is a **first-class FairWins identity**: it holds and stakes the
platform stablecoin, purchases membership (roles bind to the account address),
creates/accepts/claims wagers, joins pools, and is subject to the same
compliance screening and role gating as any classic wallet. Users manage the
account itself in-app: name it, see the devices/passkeys that control it, add
a second passkey, remove a compromised one, link an external wallet as an
additional owner/recovery method, and recover access without FairWins's help.

### Options explored & posture recorded (context for planning)

The following postures were weighed before this spec and are recorded here so
planning starts from the same decisions:

- **Custodial / embedded-wallet service (third party holds or shards the
  key)** — rejected. It would put a vendor between users and their escrowed
  funds and conflicts with the platform's self-custody ethos and its
  no-application-backend rule (spec 007).
- **Wait for the platform relayer (spec 036) before shipping passkeys** —
  rejected as a blocker. Specs 035 (intent signatures) and 036 (self-hosted
  relayer) are drafts; **no relayer is deployed**. Passkey accounts must work
  in v1 **without any FairWins-operated gas sponsorship or submission
  service**, and must compose with 035/036 when those ship (the platform
  stablecoin accepts contract-account signatures for signed transfer
  authorizations, so a passkey account will be able to sign intents).
- **Standards-based self-custodial smart account, submitted through
  third-party, user-replaceable on-chain submission infrastructure** —
  **chosen**. This is the same trust class as the RPC endpoints and
  WalletConnect relay the app already depends on: an outside service that can
  delay but can never move funds or impersonate the user. It adds no
  FairWins-operated backend.
- **Network fees in v1** — users pay their own network fees. The design target
  is that a passkey user can pay fees **from their stablecoin balance** and
  never needs to hold the native gas token; where that is temporarily
  impossible the UI must say so honestly rather than strand the user silently.
- **Networks** — Polygon (137) and Amoy (80002) first, where cheap P-256
  verification exists. ETC (61) and Mordor (63) are a **later increment**
  (no P-256 precompile there; needs a costlier deployed verifier — same
  posture as spec 034's original plan of self-deploying missing primitives
  on Classic later).

## Clarifications

### Session 2026-07-04

- Q: How should encrypted features (signature-derived encryption keys) be handled for passkey accounts at launch? → A: Device-dependent parity — encrypted features work for passkey users whenever their authenticator supports deterministic key material; on devices that can't, those specific features are explicitly marked unavailable. Action-parity success criteria are measured on capable devices.
- Q: Should sanctions screening also apply to external wallet addresses linked as account controllers? → A: Yes — a linked wallet address is screened at link time (flagged → link refused) and re-checked with the account's own screening; a controller that becomes flagged flags the account for gated actions. Passkey credentials have no address and are not screened.
- Q: When the stablecoin-denominated fee path is unavailable, what fallback does a passkey user get? → A: Native-token fallback + retry — the user may pay that action's fee in the native gas token if their account holds any (with guidance on acquiring it), or wait and retry the stablecoin path. Funds are never inaccessible solely because a third-party fee service is down.
- Q: Does a passkey login session ever expire on its own? → A: No — it persists until explicit sign-out, matching classic wallet-connection behavior; the per-transaction passkey ceremony (FR-008) is the security boundary for anything value-moving.
- Q: Must a passkey account have the same address on every platform network? → A: Yes — hard requirement: one deterministic address per account across all current and future platform networks (including ETC/Mordor when they arrive), so a user's address is chain-independent exactly like a classic EOA and cross-chain sends still land at an address the user controls.

### Session 2026-08-29 — Amendment (release 1.14.0): optional app lock

- Q: Does the optional app lock change the answer to Q4 (does a session ever expire on its own)? → A: No — Q4 and FR-003 stand exactly as written. The lock is a **UI gate over an intact session**: the session cookie stays; the screen goes dark. Nothing about the persisted session, account, credential, or cached-role state is expired, cleared, or altered by locking or by the passage of locked time. Unlock is not sign-in, and locking is not sign-out — explicit sign-out remains the only way to clear the session.
- Q: Is unlocking ever a substitute for the per-transaction ceremony (FR-008)? → A: No — the unlock ceremony authorizes nothing; it only lifts the overlay. Any value-moving action still requires its own fresh FR-008 ceremony afterwards.
- Q: Is the app lock offered to every login method? → A: It is offered wherever a WebAuthn re-prompt is actually possible (a usable passkey credential on a capable authenticator, per the FR-004 capability-detection posture); where it is not possible the setting is hidden or disabled with an honest explanation, never silently non-functional.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - From nothing to wagering with only a passkey (Priority: P1)

A brand-new user with no crypto wallet, no browser extension, and no seed
phrase lands on FairWins. They choose "Sign up with passkey", approve a
Face ID / Touch ID / device-PIN prompt, and immediately have a FairWins
account with its own on-chain address. They fund it with the platform
stablecoin (shown via address + QR, as any wallet), purchase membership, and
create and accept wagers — confirming each action with a biometric prompt.
They never see a seed phrase, never install anything, and never need to
acquire the native gas token.

**Why this priority**: This is the entire point of the feature — the adoption
ceiling today is "must already have a wallet". Removing that barrier for the
platform's primary revenue actions (membership, wagers) is the largest
possible onboarding win.

**Independent Test**: On a clean browser profile with a platform
authenticator, complete: create passkey account → receive stablecoin →
purchase membership → create a wager → (from a second account) accept it →
resolve and claim. Every confirmation is a biometric prompt; the user's
stablecoin balance is the only balance they ever hold.

**Acceptance Scenarios**:

1. **Given** a visitor with no wallet software, **When** they choose passkey
   sign-up and approve the device prompt, **Then** they have a FairWins
   account with a stable on-chain address, shown in the same connected state
   the app shows classic wallets, in under a minute.
2. **Given** a freshly created passkey account that has received stablecoin
   but has never transacted, **When** the user performs their first paid
   action (e.g. membership purchase), **Then** the action completes on-chain
   correctly even though the account had no prior on-chain history, and any
   one-time account activation is bundled invisibly into that first action.
3. **Given** a passkey user with stablecoin but zero native gas token,
   **When** they perform any supported action, **Then** the action completes
   with fees paid from value they actually hold, and the fee is disclosed
   before they confirm.
4. **Given** a passkey user purchasing membership, **When** the flow requires
   both a spending authorization and the purchase itself, **Then** the user
   confirms **once** (a single biometric prompt covers the whole action), not
   once per underlying step.
5. **Given** any point in the passkey journey, **When** the user looks for a
   seed phrase, private key, or "backup phrase" step, **Then** there isn't
   one — credential safekeeping is handled by their device/platform.

---

### User Story 2 - One site-wide login surface for every account type (Priority: P1)

Any user — passkey or classic wallet — encounters **one** connect surface
site-wide: it offers "Continue with passkey", "Browser wallet", and
"WalletConnect". Whichever they pick, the app behaves identically downstream:
one connected-account state, the same membership/role gating, the same
compliance screening, the same header widget, the same session persistence
across pages and reloads, and one explicit sign-out that fully clears the
session. Existing wallet users notice nothing except a new option.

**Why this priority**: The feature is "site-wide login management", not a
bolt-on. If passkey users hit code paths that assume an extension wallet (or
vice versa), gating and compliance become inconsistent — which is a
correctness and compliance problem, not just UX.

**Independent Test**: Walk the full product surface (wagers, pools,
membership, account pages, address book, notifications) once connected via
passkey and once via a classic wallet; every gate, balance, role check, and
screen resolves against the active account identically. Disconnect/reconnect
and reload preserve or clear session state identically for both.

**Acceptance Scenarios**:

1. **Given** an existing browser-wallet or WalletConnect user, **When** this
   feature ships, **Then** their connect, session, role, and transaction
   flows behave exactly as before.
2. **Given** a user connected with a passkey account, **When** any part of
   the app asks "who is the user / what may they do", **Then** the answer is
   derived from the passkey account's address exactly as it would be from a
   classic wallet address (membership tier, admin roles, sanctions screening,
   entry gate, network scoping).
3. **Given** a connected session (either type), **When** the user reloads or
   navigates, **Then** the session persists without re-prompting; **When**
   they sign out, **Then** all locally persisted session/account state is
   cleared.
4. **Given** a user with both a passkey account and a classic wallet,
   **When** they switch the active login method, **Then** the app cleanly
   switches the active identity (balances, roles, history) with no state
   bleeding between the two accounts.

---

### User Story 3 - Returning user signs back in, on any of their devices (Priority: P2)

A passkey user returns days later — same device or another device signed into
the same platform credential ecosystem (e.g. phone + laptop with synced
passkeys) — chooses "Continue with passkey", approves the biometric prompt,
and is back in the **same** account: same address, same funds, same
membership, same wager history. On a device outside their sync ecosystem,
they can use their phone to approve the sign-in (cross-device passkey flow)
or add that device as a new passkey from a signed-in session.

**Why this priority**: Onboarding is worthless if return visits are lossy.
Account continuity across devices is what makes a passkey account a real
wallet rather than a per-browser toy.

**Independent Test**: Create an account on device A; sign in on device B via
credential sync or cross-device authentication; verify identical address,
balances, membership, and history; then add device B's own passkey and verify
either passkey signs transactions.

**Acceptance Scenarios**:

1. **Given** a returning user on the same device, **When** they choose
   passkey sign-in, **Then** they are connected to their existing account in
   seconds with a single biometric prompt.
2. **Given** a user on a second device with access to their synced passkey,
   **When** they sign in, **Then** they reach the same on-chain account with
   full funds, roles, and history.
3. **Given** a user whose device offers multiple passkeys for the site,
   **When** they sign in, **Then** they can pick which account to use, and
   the app connects to the address that credential controls.

---

### User Story 4 - Managing the account: devices, names, linked wallet (Priority: P2)

From an account management page, a passkey user sees their account (address,
display name, QR), the list of passkeys/devices that can control it, and any
linked external wallet. They can rename the account (local nickname), add a
second passkey (e.g. their partner device or a hardware security key), remove
a passkey they no longer trust, and link an external classic wallet as an
additional owner — usable both as a recovery path and as a bridge to
wallet-native tooling. Changes to who controls the account take effect
on-chain; a removed passkey can no longer sign anything.

**Why this priority**: Self-custody without management tools is a trap.
Multi-passkey + linked-wallet is also the platform's non-custodial answer to
device loss (Story 5), so it must exist before passkey accounts hold serious
value.

**Independent Test**: Add a second passkey and verify both sign successfully;
remove the first and verify it can no longer sign (on-chain enforced, not
just hidden in UI); link an external wallet and verify it can operate the
account; verify every control change required a confirmation from an
existing controller.

**Acceptance Scenarios**:

1. **Given** a signed-in passkey user, **When** they open account management,
   **Then** they see their account address, nickname, every credential/owner
   that can control the account, and when each was added.
2. **Given** an account with one passkey, **When** the user adds a second
   passkey or links an external wallet, **Then** the addition is authorized
   by an existing controller, takes effect on-chain, and both controllers can
   subsequently operate the account.
3. **Given** an account with two controllers, **When** one is removed,
   **Then** the removal is authorized by a remaining controller and the
   removed credential can no longer authorize anything — verified on-chain,
   not merely in the UI.
4. **Given** the last remaining controller of an account, **When** the user
   attempts to remove it, **Then** the app refuses (an account can never
   reach a controller-less, funds-stranded state).

---

### User Story 5 - Losing a device is not losing the money (Priority: P2)

A user loses their phone. Because their passkey was synced by their platform
credential manager (or because they had added a second passkey or linked
wallet), they sign in from another device and immediately regain full control
— without contacting FairWins, because FairWins holds nothing. If they had
only a single device-bound passkey and no second controller, the app has
warned them of exactly this risk beforehand, prominently and at the right
moments (account creation, first meaningful balance, membership purchase).

**Why this priority**: Funds-safety story for the new account type. It cannot
be P1 because it rides on Story 4's mechanics, but shipping passkey accounts
that hold escrowed wagers without a recovery story would be irresponsible.

**Independent Test**: Simulate device loss (discard local credential) for
(a) a synced-passkey user, (b) a two-passkey user, (c) a linked-wallet user —
all recover full control unaided. For (d) a single device-bound passkey with
no second controller, verify the user saw the explicit warnings before value
was at risk.

**Acceptance Scenarios**:

1. **Given** a user with a synced passkey, second passkey, or linked wallet,
   **When** their primary device is lost, **Then** they regain full account
   control from another device without any FairWins involvement.
2. **Given** a user about to hold meaningful value protected by a single
   passkey, **When** they reach account creation, first funding, and
   membership purchase, **Then** the app has clearly warned them and offered
   to add a second passkey or recovery wallet at those moments.
3. **Given** any recovery flow, **When** it completes, **Then** no step
   involved FairWins or any third party being able to move the user's funds.

---

### User Story 6 - Compliance and gating apply to passkey accounts unchanged (Priority: P3)

For regulators, guardians, and the platform itself: a passkey account is
screened and gated exactly like a classic wallet. The entry-gate notice,
sanctions screening (advisory client-side and authoritative on-chain),
membership-role purchase requirements, and network scoping all key off the
passkey account's address. Nothing about signing with a biometric bypasses —
or double-applies — any control.

**Why this priority**: Must hold at launch, but it is mostly parity
verification of existing controls against a new account type rather than new
user-facing capability.

**Independent Test**: Run the compliance test matrix (entry gate, screening
verdicts including a flagged address, membership-gated actions,
testnet/mainnet scoping) against a passkey account and confirm identical
outcomes to a classic wallet account.

**Acceptance Scenarios**:

1. **Given** a passkey account flagged by sanctions screening, **When** it
   attempts a gated action, **Then** it is blocked exactly as a flagged
   classic wallet would be.
2. **Given** a passkey account without the participant membership role,
   **When** it attempts a members-only action, **Then** it is refused with
   the same messaging and upgrade path as for classic wallets.

---

### User Story 7 - Optional app lock: the screen goes dark, the session stays (Priority: P3) — *Amendment, release 1.14.0*

A member who shares a device (or just wants defense-in-depth against
shoulder-surfing an unattended browser) enables the optional **app lock**
setting. From then on, after 15 minutes of inactivity — or immediately when
the app is backgrounded or exited (`visibilitychange`/`pagehide`) — the UI is
covered by a lock overlay that obscures all account content, and a successful
WebAuthn ceremony is required before the UI is usable again. Underneath the
overlay nothing has changed: the session persists exactly as FR-003
guarantees, and after unlocking the member is precisely where they left off.
A member who never enables the setting sees today's behavior, unchanged.

**Why this priority**: Pure additive hardening for members who opt in. It
cannot outrank the launch stories because the security boundary for value is
already the per-transaction ceremony (FR-008); the lock protects *visibility
and casual use* of an unattended signed-in UI, not funds.

**Independent Test**: Enable the setting; verify the overlay appears after 15
minutes idle and immediately on tab hide/background; verify unlock requires a
successful WebAuthn ceremony and restores the exact prior UI state; verify
throughout (via storage/session inspection) that no session, credential, or
cached-role state was cleared or expired; verify a fresh profile with the
setting off shows no lock behavior at all.

**Acceptance Scenarios**:

1. **Given** any member who has not enabled the app lock, **When** they idle
   for any duration, background the app, or exit and return, **Then** no lock
   overlay ever appears and session behavior is byte-for-byte today's
   (FR-003) behavior.
2. **Given** a member with the app lock enabled, **When** 15 minutes pass
   with no interaction, **Then** the lock overlay covers the UI, obscuring
   account content (balances, addresses, history), and no interaction with
   the app is possible except unlocking and signing out.
3. **Given** a member with the app lock enabled, **When** the app is
   backgrounded or the page is hidden/exited (`visibilitychange`/`pagehide`),
   **Then** the app is locked immediately, without waiting for the idle
   timer.
4. **Given** a locked app, **When** the member completes a successful
   WebAuthn ceremony, **Then** the overlay lifts and the UI resumes exactly
   where it was — same route, same connected account, same session — with no
   re-login and no state loss.
5. **Given** a locked app, **When** the underlying session is inspected,
   **Then** it is intact and unexpired: locking, and any amount of time spent
   locked, MUST NOT clear or expire session, account, or cached-role state
   (FR-003 unchanged — the session cookie stays; the screen goes dark).
6. **Given** a locked app, **When** the WebAuthn prompt is cancelled or
   fails, **Then** the app stays locked with a clear retry option — never a
   sign-out, never a cleared session, never a partially usable UI.
7. **Given** a locked app, **When** the member chooses sign-out from the
   lock overlay instead of unlocking, **Then** the full FR-003 sign-out runs
   (all locally persisted session/account state cleared) — sign-out remains
   the only way to clear the session.
8. **Given** a member who just unlocked, **When** they perform a
   value-moving action, **Then** that action still requires its own fresh
   FR-008 ceremony — the unlock ceremony never doubles as transaction
   authorization.

---

### Edge Cases

- **No passkey support**: Browser/device lacks passkey capability → the
  passkey option is hidden or shown disabled with an honest explanation;
  classic wallet paths remain fully usable.
- **Prompt declined / interrupted**: User cancels the biometric prompt
  mid-signup or mid-transaction → clean abort, no partial account state, no
  stuck "pending" UI; the action is re-attemptable.
- **Funds sent before first transaction**: Stablecoin arrives at a passkey
  account address that has never transacted on-chain → funds are safe and
  visible; the first outgoing action still works (activation is bundled).
- **Insufficient balance for fees**: Passkey user's stablecoin can't cover
  action + fees → clear pre-flight message stating the shortfall, not an
  opaque on-chain failure.
- **Submission infrastructure outage**: The third-party path that carries
  passkey transactions is down or degraded → the app detects it within a
  bounded time, tells the user honestly, and offers whatever fallback exists
  (retry, alternate provider, or fee payment in native token if the user has
  it) rather than spinning forever. No silent fund-risking retries.
- **Duplicate sign-up**: User with an existing passkey account taps "Sign up"
  again on the same device → flows into sign-in with their existing
  credential rather than silently creating a second orphan account; creating
  a genuinely separate second account remains possible but explicit.
- **Multiple accounts / multiple passkeys**: Credential picker shows
  distinguishable entries; the app never guesses which account the user meant.
- **Cleared browser data**: Site data/localStorage wiped → passkey (held by
  the platform authenticator) still works; user signs back into the same
  account; only local niceties (nickname, cached roles) need re-sync.
- **Encrypted features**: Platform features that derive per-user encryption
  keys from a wallet signature must have a passkey-account equivalent that is
  deterministic per account and non-custodial. Where a user's
  authenticator cannot support deterministic key material, encrypted features
  degrade honestly (feature marked unavailable) instead of producing keys
  that can never be re-derived. **Planning must treat this as a hard design
  checkpoint**: passkey signatures are inherently non-repeatable, so the
  existing "same signature → same key" approach cannot be assumed.
- **Unsupported networks**: User switches a passkey session to ETC/Mordor
  (v1: unsupported for passkey accounts) → the app states passkey support is
  not yet available there and prevents fund-stranding actions, mirroring the
  network-capabilities pattern already used per-chain.
- **Legacy assumptions about "one signer = one EOA"**: Flows that verify
  signatures off-chain (e.g. signed intents later, message-based proofs) must
  accept contract-account signatures for passkey accounts or exclude them
  explicitly — never fail ambiguously.
- **App lock — unlock prompt fails or is cancelled** *(release 1.14.0
  amendment)*: The WebAuthn ceremony errors, times out, or the member
  cancels → the app stays locked and offers retry; repeated failure never
  degrades to an unlocked UI and never clears the session. Sign-out remains
  reachable from the overlay as the explicit escape hatch.
- **App lock — authenticator unavailable at unlock time** *(release 1.14.0
  amendment)*: The credential that would unlock is not usable on this
  device/context (authenticator removed, capability lost, non-PRF/no-platform-
  authenticator environment) → the overlay says so honestly and offers
  sign-out; it never silently unlocks and never pretends a retry will
  succeed. Correspondingly, the setting is only offered where a WebAuthn
  re-prompt is possible (FR-004 posture), so a member cannot enable a lock
  they could never open.
- **App lock — lock fires while a transaction confirmation is open**
  *(release 1.14.0 amendment)*: The idle timer or a background event triggers
  while an FR-008 confirmation modal (or any in-flight action UI) is
  showing → the overlay covers it; nothing is confirmed, submitted, or
  silently dropped by the act of locking. After unlock the pending
  confirmation is either re-presented or cleanly aborted per the existing
  "prompt declined / interrupted" edge case (no partial state, action
  re-attemptable) — and confirming still requires its own fresh FR-008
  ceremony. A transaction already broadcast before the lock proceeds
  on-chain normally; locking gates the UI, not the chain.
- **App lock — multiple tabs** *(release 1.14.0 amendment)*: Several tabs
  share the same session → lock state is consistent across them: a lock
  event locks every tab of that session, and one successful unlock ceremony
  unlocks them all (never one ceremony per tab, and never a locked tab
  sitting beside an unlocked one exposing the same account).

## Requirements *(mandatory)*

### Functional Requirements

**Login manager (site-wide)**

- **FR-001**: The platform MUST present a single, site-wide login surface
  offering passkey sign-up/sign-in alongside the existing browser-wallet and
  WalletConnect options, replacing nothing for existing users.
- **FR-002**: Whatever login method is active, the platform MUST expose one
  unified connected-account state (address, balances, roles, network) that
  every feature consumes identically; no feature may branch on "wallet
  brand" except where a capability genuinely differs, and such differences
  MUST be explicit and user-visible.
- **FR-003**: Sessions MUST persist across page navigation and reloads
  without re-prompting and MUST NOT expire on their own (parity with
  classic wallet connections) — the per-transaction passkey ceremony
  (FR-008) is the security boundary; an explicit sign-out MUST clear all
  locally persisted session, account, and cached-role state for the active
  account.
- **FR-004**: The login surface MUST detect passkey capability and present
  the passkey option only where usable, with an honest explanation where not.

**Passkey account lifecycle**

- **FR-005**: A user MUST be able to create a new FairWins account using only
  a passkey (platform biometric/PIN), with no seed phrase, extension,
  download, or pre-existing crypto assets, and receive a stable on-chain
  account address upon creation.
- **FR-006**: The passkey account MUST be self-custodial: only the user's
  registered credentials can authorize actions; neither FairWins nor any
  service provider may ever move funds, alter control, or sign on the user's
  behalf.
- **FR-007**: A passkey account address MUST be able to receive funds before
  the account has ever transacted, with no loss of funds; any one-time
  on-chain activation MUST be bundled into the user's first action rather
  than exposed as a separate step.
- **FR-008**: Every transaction from a passkey account MUST be authorized by
  a fresh passkey ceremony (biometric/PIN prompt) showing what is being
  authorized (action, amount, counterparty where applicable, and fee) before
  the user confirms.
- **FR-009**: Returning users MUST be able to sign in with their passkey on
  the original device, on devices sharing their credential sync ecosystem,
  and via cross-device authentication, always reaching the same on-chain
  account.

**First-class identity & feature parity**

- **FR-010**: A passkey account MUST be usable everywhere a classic wallet
  is: staking and receiving the platform stablecoin, purchasing membership
  (role binds to the account address), creating/accepting/declining/claiming
  /refunding wagers, joining pools, address book, stats, notifications, and
  QR receive flows.
- **FR-011**: All compliance and gating controls — entry-gate notice,
  advisory and on-chain sanctions screening, membership-role gating, admin
  roles, per-network data scoping — MUST key off the passkey account address
  exactly as they do for classic wallet addresses.
- **FR-012**: Platform features that derive per-user encryption keys from
  wallet signatures MUST provide a passkey-account equivalent that yields
  the same keys on every device the user signs in from, without custody by
  any third party. Launch posture is **device-dependent parity**: on
  authenticators that support deterministic key material the encrypted
  features MUST work; on authenticators that cannot, those specific
  features MUST be explicitly marked unavailable (with the reason) while
  all non-encrypted functionality remains fully usable. Lack of universal
  device support is NOT a launch blocker.

**Fees & transaction submission (no relayer deployed)**

- **FR-013**: Passkey accounts MUST be able to transact in v1 without any
  FairWins-operated relayer, sponsorship, or new always-on FairWins backend
  (preserving the spec 007 no-backend posture); any submission
  infrastructure used MUST be third-party, non-custodial ("can delay, cannot
  steal"), and replaceable via configuration.
- **FR-014**: A passkey user MUST be able to complete all supported actions
  while holding only the platform stablecoin; network fees MUST be payable
  from that balance, disclosed in stablecoin terms before confirmation. If a
  temporary condition makes stablecoin fee payment impossible, the app MUST
  say so and offer the defined fallbacks: pay that action's fee in the
  native gas token from the account's own balance (with guidance on
  acquiring it), or wait and retry the stablecoin path. A third-party fee
  service being down MUST never be the sole reason a user cannot reach
  their funds.
- **FR-015**: Users MUST pay their own network fees in v1 (no FairWins gas
  sponsorship); the design MUST NOT preclude later composition with the
  platform's intent-signature and relayer roadmap (specs 035/036), including
  passkey accounts signing stablecoin transfer authorizations as contract
  accounts.
- **FR-016**: Multi-step token flows (spending authorization + action) MUST
  collapse to a single user confirmation for passkey accounts wherever the
  account type makes that possible.
- **FR-017**: The app MUST detect submission-path failure within a bounded
  time and surface honest status; a transaction MUST never be silently
  dropped, silently resubmitted with different effect, or shown as final
  before it is on-chain (honest-state principle).

**Account management, multi-device & recovery**

- **FR-018**: Users MUST be able to view their account's controllers (each
  passkey/credential and any linked wallet, with added-date), rename the
  account with a local nickname, and display address + QR for receiving.
- **FR-019**: Users MUST be able to add additional passkeys (including
  hardware security keys) and link an external classic wallet as an
  additional controller; every controller change MUST be authorized by an
  existing controller and take effect on-chain. A linked wallet address
  MUST pass sanctions screening at link time (a flagged address is refused
  as a controller), and linked controller addresses MUST be re-screened
  whenever the account itself is screened — an account with a flagged
  controller is treated as flagged for gated actions.
- **FR-020**: Users MUST be able to remove a controller; removal MUST be
  enforced on-chain (a removed credential can sign nothing), and removing
  the last controller MUST be impossible.
- **FR-021**: At account creation, first funding, and membership purchase,
  users protected by a single device-bound passkey MUST be clearly warned
  about device-loss risk and offered to add a second passkey or recovery
  wallet; recovery MUST never depend on FairWins or grant any third party
  control of funds.

**Networks & scope**

- **FR-022**: Passkey accounts MUST launch on the platform's primary network
  and its paired testnet (Polygon 137 / Amoy 80002); on networks without
  affordable P-256 verification (ETC 61 / Mordor 63), the passkey option
  MUST be honestly presented as not yet available and MUST NOT allow
  fund-stranding actions. Extending to those networks is a later increment.
- **FR-023**: A user's passkey account MUST have the same on-chain address
  on every network the platform supports, now and in future increments
  (including ETC/Mordor when passkey support arrives there), so the
  user's address is chain-independent exactly as a classic wallet's is;
  account state (roles, balances, history) MUST remain strictly scoped
  per network.
- **FR-024**: Classic-wallet users MUST experience zero behavioral change
  from this feature, and a user with both account types MUST be able to
  switch the active identity cleanly with no cross-account state leakage.

**App lock (optional) — Amendment, release 1.14.0**

- **FR-025**: The platform MUST offer an optional **app lock** setting,
  **off by default**. When enabled, the platform MUST present a lock
  overlay — obscuring all account content and blocking all interaction
  except unlock and sign-out — (a) after **15 minutes** without member
  interaction, and (b) immediately when the app is backgrounded or exited
  (page `visibilitychange` to hidden / `pagehide`). A successful WebAuthn
  ceremony MUST be required before the UI is usable again. A member who
  never enables the setting MUST see today's behavior, unchanged. The
  setting MUST only be offered where a WebAuthn re-prompt is actually
  possible (per the FR-004 capability-detection posture); elsewhere it is
  hidden or disabled with an honest explanation.
- **FR-026**: Locking is a UI gate over an intact session and MUST NOT
  interact with session lifetime: engaging the lock, remaining locked for
  any duration, unlocking, or failing to unlock MUST NOT expire, clear, or
  modify the persisted session, account, credential, or cached-role state.
  **FR-003 and clarification Q4 stand unchanged** — sessions still never
  self-expire, and explicit sign-out remains the only way to clear the
  session; the session cookie stays, the screen goes dark. Unlock is not
  sign-in, and the lock MUST NOT be presented to the member as session
  expiry (no "session expired" language).
- **FR-027**: A failed or cancelled unlock ceremony MUST leave the app
  locked with a clear retry path — never an unlocked UI, never a cleared
  session, never a stuck state without options. The lock overlay MUST
  always offer explicit sign-out (which performs the full FR-003 sign-out),
  including when the unlocking credential is unavailable on the device. The
  unlock ceremony authorizes nothing beyond lifting the overlay: any
  value-moving action after unlock still requires its own fresh FR-008
  ceremony, and a lock firing over an in-flight confirmation MUST NOT
  confirm, submit, or silently drop it (post-unlock, the pending action is
  re-presented or cleanly aborted per the existing interrupted-prompt edge
  case). A transaction already broadcast before locking proceeds on-chain
  normally.
- **FR-028**: Lock state MUST be consistent across all tabs/windows sharing
  the same session: a lock event locks all of them, and a single successful
  unlock ceremony unlocks all of them — never one ceremony per tab, and
  never a locked and an unlocked view of the same account coexisting.

### Key Entities

- **Passkey Credential**: A device/platform-held P-256 keypair guarded by
  biometrics/PIN; identified to the platform by a credential identifier and
  public key; never leaves the authenticator; may be synced by the user's
  platform credential manager.
- **Passkey Account**: The user's on-chain smart account — the FairWins
  identity. Attributes: stable address, ordered set of controllers
  (credentials and/or linked wallet addresses), activation state
  (address-reserved vs. on-chain-active), per-network scope. All funds,
  roles, and history bind to this address.
- **Account Controller**: An authorization entry on a Passkey Account — a
  passkey credential or an external wallet address — with added-date and
  revocation state; changes are themselves controller-authorized on-chain
  events.
- **Login Method**: The connector class of an active session (passkey,
  browser wallet, WalletConnect); determines signing ceremony, never
  identity semantics.
- **Login Session**: The persisted association between a browser and an
  active account (either type): active address, login method, network,
  cached role/screening state; cleared in full on sign-out.
- **Account Profile**: Local, non-authoritative niceties for an account —
  nickname, preferred network — never used for authorization.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time visitor with no wallet software reaches a
  connected, fundable account (address + QR visible) in under 60 seconds and
  at most 3 interactions from choosing the passkey option, seeing no seed
  phrase at any point.
- **SC-002**: A passkey user holding only the platform stablecoin completes
  the full journey — fund, purchase membership, create wager, accept wager
  (counterparty), claim payout — with 100% of actions succeeding without the
  user ever holding the native gas token, and with exactly one confirmation
  prompt per user action.
- **SC-003**: 100% of product actions available to classic-wallet users on
  the launch networks are available to passkey users, verified by running
  the existing end-to-end product test matrix under a passkey session on an
  authenticator that supports deterministic key material; on authenticators
  that don't, the only permitted gaps are encrypted features, each
  explicitly marked unavailable with the reason.
- **SC-004**: Zero regressions for classic-wallet users: the pre-existing
  connect/session/transaction test suites pass unchanged after the login
  manager ships.
- **SC-005**: A returning passkey user is signed in and transacting within
  10 seconds and one biometric prompt of choosing "Continue with passkey".
- **SC-006**: The total network fee a passkey user pays for a typical action
  is no more than 2× what a classic-wallet user pays for the equivalent
  action on the same network at the same time.
- **SC-007**: In device-loss simulations, 100% of users with a synced
  passkey, second passkey, or linked recovery wallet regain full account
  control without any FairWins involvement; 100% of single-credential users
  encountered the device-loss warning at all three mandated moments.
- **SC-008**: Compliance parity: the sanctions/membership/entry-gate test
  matrix produces identical outcomes for passkey and classic accounts across
  100% of cases, including flagged-address blocks.
- **SC-009**: The platform operates v1 passkey login with zero new
  FairWins-operated always-on services (no relayer, no key custody, no
  session backend).
- **SC-010** *(release 1.14.0 amendment)*: With the app lock **disabled**
  (the default), 100% of the pre-amendment session/connect test suite passes
  unchanged and no lock overlay is ever shown. With it **enabled**, the
  overlay appears within the specified triggers (15-minute idle;
  hide/background) in 100% of trials, every failed/cancelled unlock leaves
  the app locked with retry available, and zero trials show any session,
  account, or cached-role state cleared or expired by locking or unlocking
  — sign-out remains the only observed path that clears session state.

## Assumptions

- **Identity = account address.** The passkey account's on-chain address is
  the user identity everywhere (membership, screening, history); individual
  credentials are interchangeable controllers of that identity.
- **Third-party submission infrastructure is acceptable for v1** on the same
  trust footing as existing third-party RPC and WalletConnect services:
  configurable, replaceable, non-custodial, no FairWins backend. The spec 036
  relayer, when deployed, becomes a first-party alternative — not a
  prerequisite.
- **Users pay their own fees in v1.** Gas sponsorship (free transactions) is
  explicitly out of scope until specs 035/036 ship; the win delivered here is
  "no native token needed", not "free".
- **Platform credential sync (e.g. iCloud Keychain, Google Password Manager)
  is the primary cross-device path**; multi-passkey and linked-wallet are the
  platform-independent backstops. FairWins never stores credential material.
- **The platform stablecoin on launch networks supports contract-account
  signature verification for signed transfer authorizations** (needed only
  for later 035 composition, not for v1 delivery).
- **Deterministic per-account secret derivation for encrypted features may
  not be available on every authenticator**; where unavailable, encrypted
  features degrade explicitly (this is the honest-state principle applied to
  crypto capability).
- **ETC (61) / Mordor (63) passkey support is deferred**, matching the
  platform's precedent of shipping Polygon-first and self-deploying missing
  primitives on Classic later (spec 034 posture).
- **Out of scope for this feature**: custodial or email/social login, MPC or
  key-sharding services, FairWins-sponsored gas, automatic migration of an
  existing EOA's balances into a passkey account (linking a wallet as
  controller is in scope; moving its funds is the user's ordinary transfer),
  and passkey support on ETC/Mordor.

## Dependencies

- **Spec 007 (compliance gating)** — the no-backend posture and gating
  controls this feature must preserve and extend to a new account type.
- **Spec 027 (MembershipManager)** — roles bind to the passkey account
  address; purchase flow must work from a contract account.
- **Spec 034 (wager pools; address-based since PR #793)** — pool
  participation gates on the real wallet; for passkey users the passkey
  account is that wallet.
- **Specs 035/036 (intent signatures, relayer)** — implemented and merged
  (PR #800, 2026-07-04) after this spec was written; the maintainer
  sequenced 041 to follow them, so this feature composes with the live
  rails (contract-account intent signing, relay gateway as first-party
  submission path). Note: the merged rails verify intent signers with ECDSA
  only — accepting contract-account (ERC-1271) signatures is enabling work
  tracked in this feature's plan/tasks.
- **Spec 011 (wallet address QR)** — receive flows reused for passkey
  account funding, including the never-transacted state.
