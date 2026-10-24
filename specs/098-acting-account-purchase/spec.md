# Feature Specification: Acting-Account Membership Purchase

**Feature Branch**: `098-acting-account-purchase`

**Created**: 2026-08-29

**Status**: Draft

**Input**: Spec 088 made every acting account instantly navigable and routed wrap/send/swap
through the acting-account submit seam, but deliberately left membership purchase behind a
blanket refusal: while operating as ANY other account, PremiumPurchaseModal disables the buy
button and tells the member to switch back to their personal wallet. That refusal was honest —
`MembershipManager.purchaseTier` credits `msg.sender` and takes NO beneficiary, so a purchase
signed by the connected wallet would land the membership on the wrong account. But it is also
a gap: a member who recovered a legacy account, added a hardware account, or runs a vault has
no way to buy, upgrade, or extend a membership FOR that account, even though every one of
those accounts can be `msg.sender` on the membership chain. This spec threads the purchase
through the acting account on every rail, and keeps the refusal — with its reason stated —
for the accounts that genuinely cannot be `msg.sender` there.

## Overview

Membership is an on-chain fact about ONE address: `purchaseTier(role, tier)` (and its
`WithTerms`, `upgradeTier`, `extendMembership` siblings) credit `msg.sender`, and the relayed
`…WithAuthorization` twins credit the recovered intent/authorization **signer** (spec 035 twin
invariant — `actorField: 'member'` in `@fairwins/intent-types`). There is no beneficiary
parameter anywhere, and this spec does NOT add one: a "buy for" parameter on a contract that
holds the platform's access control is a gifting/griefing surface (buying a sanctioned tier
onto someone else's address, terms acceptance recorded against an address that never consented)
and a storage-layout risk on a live UUPS proxy for zero necessity. The constraint drives the
whole design instead:

> **A membership lands on the acting account if and only if the acting account is the one
> that signs — as `msg.sender` on a self-submitted transaction, as the Safe that executes a
> proposal, or as the recovered signer of a relayed intent + EIP-3009 authorization.**

So the feature is routing, not contract change: every purchase rail must obtain its signature
from the ACTING account (spec 088's deferred-ceremony broker for hardware/legacy, a Safe
proposal for vaults, `sendCalls` only when the acting account IS the passkey account), and the
rails that cannot do that — derived BTC/SOL/ZEC addresses with no EVM key path, an account
that only exists on a chain other than the membership chain — keep a refusal that names the
account and says WHY.

Spec 071's pinning is untouched: membership has ONE home (`membershipChainId()`), every
purchase settles there, and nothing in this spec reads or writes membership anywhere else.

**No contract changes.** `MembershipManager` already has every entry point each rail needs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Buying a membership for a recovered or hardware account (Priority: P1)

A member operating as a recovered legacy account (spec 062) or a hardware account (spec 085)
opens the membership modal. It shows THAT account's current tier and price, discloses that the
purchase settles on the membership chain and is credited to that account, and on confirm runs
the spec-088 deferred ceremony (unlock passphrase / connect device) at the moment the first
signature is needed. The approve + pay transactions are signed by the acting account's own
signer; the membership lands on the acting address.

**Why this priority**: This is the largest blocked cohort — spec 088 gave these accounts full
send/swap capability, and a purchase is just two more transactions from the same signer. It is
also the path with no waiting state: value lands in one session.

**Independent Test**: Operate as a recovered account with USDC on the membership chain,
purchase Bronze, and read `getUserTierOnChain(actingAddress)` — the tier is active on the
acting address and absent on the connected wallet.

**Acceptance Scenarios**:

1. **Given** a member operating as a recovered legacy account with sufficient USDC and no
   allowance, **When** they confirm a purchase, **Then** the unlock ceremony runs once, the
   approve and pay transactions are both sent from the acting address, and the tier becomes
   active on the acting address — never on the connected wallet.
2. **Given** a member operating as a hardware account, **When** they confirm a purchase,
   **Then** the device-connect ceremony runs at confirm time (not at account-switch time), each
   transaction is physically confirmed on the device, and the tier lands on the hardware
   address.
3. **Given** the acting account already holds sufficient allowance for the price, **When** the
   flow starts, **Then** no approve step is shown or sent (allowance is read for the ACTING
   address, not the connected wallet).
4. **Given** the member dismisses the unlock/device ceremony, **Then** the pay step fails with
   the stated dismissal reason, nothing has been signed or sent, and Retry re-offers the
   ceremony.
5. **Given** a relayer is live on the membership chain and the acting signer can produce
   typed-data signatures, **When** the member confirms, **Then** the purchase MAY ride the
   relayed rail — the `PurchaseTierIntent` and its stapled EIP-3009 authorization are both
   signed by the ACTING account, and the contract credits the acting address as the recovered
   signer. When the relayer is absent or the signer cannot sign typed data, the flow
   self-submits (never-stranded) with no behavioural difference in outcome.

---

### User Story 2 - A vault buys its own membership (Priority: P2)

A member operating as a multisig vault (spec 043) confirms a membership purchase. Because a
Safe has no key, the flow produces a threshold-gated Safe PROPOSAL that batches
approve + purchase via MultiSendCallOnly; on execution `msg.sender` is the vault, so the
membership is credited to the vault address and paid from the vault's USDC. The modal reports
"proposed", never "paid".

**Why this priority**: Vaults are the accounts most likely to WANT their own standing (a
shared treasury wagering as itself), but the flow has a waiting state and a smaller cohort
than US1.

**Independent Test**: Operate as a 2-of-N vault on the membership chain, confirm a purchase,
verify the proposal appears in the vault queue with a decodable approve+purchase batch, execute
it with a second owner, and read the tier on the vault address.

**Acceptance Scenarios**:

1. **Given** a member operating as a vault that exists on the membership chain, with the
   wallet connected to that chain, **When** they confirm, **Then** a Safe proposal is created
   (preimage emitted to the proposal hub + proposer's `approveHash` recorded) whose batch is
   `[approve(membershipManager, price), purchaseTierWithTerms(...)]`, and the modal's terminal
   state says the membership activates when the vault threshold executes — it does NOT claim
   the membership is active.
2. **Given** the vault's threshold is later met and the proposal executes, **Then**
   `getUserTierOnChain(vaultAddress)` shows the tier active, with no further action in the
   modal required.
3. **Given** the connected wallet is on a different chain than the membership chain, **When**
   the member confirms, **Then** the flow offers the named-chain switch first and creates no
   proposal until the wallet is actually there (declining leaves nothing proposed anywhere).
4. **Given** the vault already holds sufficient allowance, **Then** the proposed batch
   contains only the purchase call (no approve leg).
5. **Given** the member closes the modal after proposing, **Then** the proposal remains in the
   vault queue (spec 043 FR-022b) and reopening the modal shows the acting vault's tier from
   chain state — pending-proposal awareness is the queue's job, not a modal-local memory.

---

### User Story 3 - Passkey member, acting as themself (Priority: P2)

A passkey member (spec 041) who is NOT operating as another account keeps today's behaviour
byte-for-byte: approve + purchase batched into one `sendCalls` WebAuthn ceremony. The same
member operating as a vault gets a proposal (US2); operating as hardware/legacy gets the acting
signer's sequential rail (US1). The batch rail is valid ONLY when the acting account IS the
passkey account, because `sendCalls` executes as the passkey smart account — using it under an
acting label would credit the passkey account while the screen says otherwise.

**Why this priority**: Regression protection for the largest existing purchase path plus the
identity-first rule from spec 073's `wallet.submit` precedent.

**Independent Test**: Purchase as a passkey member with no acting selection (one ceremony, one
batch, membership on the passkey address); then operate as a hardware account from the same
session and verify the flow routes to the hardware rail, never `sendCalls`.

**Acceptance Scenarios**:

1. **Given** a passkey member acting as themself, **When** they purchase, **Then** the flow is
   unchanged from spec 041 FR-016 (one batched ceremony, no approve step shown, membership on
   the passkey address).
2. **Given** a passkey member operating as ANY non-personal account, **When** they purchase,
   **Then** `sendCalls` is never invoked for the purchase — the flow routes to the acting
   account's own rail (proposal / ceremony-signed transactions), or refuses with the stated
   reason if that kind has no rail.

---

### User Story 4 - The accounts that cannot buy still learn why (Priority: P3)

A member operating as a derived Bitcoin/Solana/Zcash address, or as an account that only
exists on a chain other than the membership chain, sees the purchase refused BEFORE any
signature, with the reason named: this account cannot be the sender of a transaction on the
membership chain, and a membership can only be credited to the account that sends. The refusal
names the account and the membership chain; it never silently substitutes the connected wallet.

**Why this priority**: The refusal already exists; this story narrows it and makes its reason
specific instead of blanket. It ships value only in honesty, not capability.

**Acceptance Scenarios**:

1. **Given** a member operating as a derived non-EVM address (BTC/SOL/ZEC), **When** they open
   the membership modal, **Then** the buy control is disabled with a reason naming the account
   and stating that it has no sending identity on the membership chain — not the spec-088-era
   "switch back to your personal wallet" blanket text.
2. **Given** a member operating as a vault whose `chainId` is not the membership chain,
   **When** they open the modal, **Then** the refusal states that memberships live on
   <membership network> and this vault exists only on <vault network>, so a purchase cannot be
   credited to it. No proposal is offered.
3. **Given** any refused state, **Then** nothing is signed, sent, or proposed, and the refusal
   copy is specific enough that the member knows whether switching accounts, switching chains,
   or nothing at all would unblock them.

### Edge Cases

- **Mid-flow acting-account switch**: the flow binds the acting identity at confirm time. If
  the acting selection (or the connected account) changes while a purchase is in flight, any
  pending ceremony is cancelled with its parked action rejected (spec 088 FR-006), the current
  step fails naming the account the flow was bound to, and no subsequent step may re-resolve to
  the NEW identity. If `pay` had already confirmed, the membership is already honestly on the
  original acting address — the completion screen still names that address.
- **Vault proposal pending when the modal closes**: closing loses nothing — the proposal is in
  the vault queue and executes there. The modal never claims an active membership for a
  proposed-not-executed purchase, including on reopen.
- **Tier already active on the acting account**: the modal reads the ACTING address's tier and
  offers upgrade/extend accordingly — it must never quote a fresh-purchase price because the
  CONNECTED wallet happens to be tierless (or vice versa). An unreadable acting-account tier
  blocks purchase with a retry, exactly as today (a purchase against an unknown current tier
  charges for the wrong thing).
- **Allowance already sufficient on the acting account**: approve step omitted (US1 #3,
  US2 #4). Allowance/balance pre-flights are address-reads against the acting address via the
  membership chain's read provider — never `signer`-implicit reads that silently answer for
  the connected wallet.
- **Acting account has USDC but no gas**: the classic rail fails at the acting account's own
  gas, stated honestly. Where the relayed rail is live the flow may take it (gasless for the
  member); the connected wallet's gas is never spent on the acting account's transactions
  except for the vault rail's `approveHash`/proposal writes, which are the proposer's own acts
  and are disclosed as such.
- **Sanctions-screen failure**: the acting account (the future member) is what gets screened.
  On relayed rails the gateway screen is fail-closed as it is for every relayed action. On
  self-submit, the contract's own sanctions guard is the enforcement; an UNREADABLE app-side
  pre-screen must not fabricate a denial (an RPC timeout is not a sanctions hit) — the flow may
  proceed to the rail whose enforcement is on-chain, or state that screening could not be
  confirmed, but never render "blocked" from a failed read.
- **Price changes between vault proposal and execution**: the batch approves the quoted price;
  if the on-chain price rises before execution, the purchase leg reverts and the proposal
  fails honestly (no partial approve-only execution — the batch is atomic via MultiSend). The
  queue's failure surface reports it; re-proposing re-quotes.
- **Ceremony signer bound to the wrong chain**: a cached acting signer bound to a network the
  wallet has left is dropped and the ceremony re-runs (spec 088 FR-005); for purchase the
  binding target is always the membership chain.
- **Key registration (sign/register steps) for non-personal purchasers**: a vault cannot sign
  a key-derivation message (spec 084 refuses vault signing by design), so those steps are
  skipped with the honest "encrypted features unavailable" disclosure and the membership stays
  fully valid. Hardware/legacy purchasers are OFFERED the sign/register steps through the same
  broker ceremony (spec 088 FR-008); declining degrades, never fails the purchase.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A membership purchase, upgrade, or extension started while operating as another
  account MUST be credited to the ACTING account — the account whose tier the modal displays —
  on every rail. No rail may sign or submit as the connected wallet under an acting label
  (spec 088 FR-002's no-fall-through rule extended to the purchase flow).
- **FR-002**: The membership modal MUST read current tier, price basis (purchase vs upgrade vs
  extend), USDC balance, and allowance for the ACTING address, via the membership chain's read
  provider — never signer-implicit reads that answer for the connected wallet.
- **FR-003**: Eligibility replaces the blanket refusal. An acting account is purchase-eligible
  if and only if it can be `msg.sender` on `membershipChainId()`: a vault whose recorded
  `chainId` IS the membership chain; a recovered legacy account; a hardware account; or the
  personal (including passkey) account. Every other acting state — derived non-EVM addresses
  (BTC/SOL/ZEC), a vault on any other chain, and any acting kind with no signing path — MUST be
  refused before any signature, with copy that names the account and states the specific
  reason (no sending identity on the membership chain / exists only on <chain>).
- **FR-004**: **Classic rail (acting EOA-like accounts)**: approve (when needed) + pay are
  signed by the ACTING account's signer, obtained on demand through the spec-088 ceremony
  broker at confirm time — never at modal-open or account-switch time — and sent as sequential
  transactions each awaited to inclusion. One ceremony serves the whole flow (the session
  cache), and dismissal fails the step with the stated reason and nothing signed.
- **FR-005**: **Vault rail**: the purchase becomes ONE threshold-gated Safe proposal whose
  batch is `[approve(membershipManager, quotedPrice)?, purchase/upgrade/extend call]` via
  MultiSendCallOnly, so `msg.sender` on execution is the vault and payment comes from the
  vault's USDC. The proposer's wallet MUST be connected to the membership chain (named-chain
  switch offered first; declining proposes nothing). The flow's terminal state is
  **proposed**, visually and verbally distinct from paid/active, and MUST state that the
  membership activates when the vault executes.
- **FR-006**: **Passkey-batch rail**: `sendCalls` batching is used ONLY when the acting
  account IS the passkey account (personal mode in a passkey session). Operating as any
  non-personal account in a passkey session MUST route to that account's own rail per
  FR-004/FR-005, never through the passkey smart account.
- **FR-007**: **Relayed-intent rail**: where the relayer is live on the membership chain and
  the acting signer can produce EIP-712 typed-data signatures, the purchase MAY be relayed:
  the `PurchaseTierIntent`/`UpgradeTierIntent`/`ExtendMembershipIntent` AND its stapled
  EIP-3009 `ReceiveWithAuthorization` payment MUST both be signed by the ACTING account, so
  the contract's twin invariant credits the acting address as the recovered signer and pulls
  the price from the acting account's USDC. The gasless seam MUST accept an explicit acting
  signer for this — it must be impossible for the relayed rail to fall back to the connected
  wallet's signer while an acting account is selected.
- **FR-008**: **Never-stranded**: every gasless/relayed path keeps a self-submit fallback on
  the same acting identity (specs 035/036 rule). An acting signer that cannot produce
  typed-data signatures (a hardware seam without EIP-712 support) degrades to the classic rail
  silently and correctly — it never prompts the connected wallet as a "fallback signer".
- **FR-009**: Membership chain pinning is unchanged (spec 071): every rail settles on
  `membershipChainId()` only; ceremony signers for a purchase bind to that chain; the
  settlement network is disclosed before signature always, not only when wrong.
- **FR-010**: Pre-signature disclosure MUST name, in one place: which account the membership
  is credited to, which account pays the price, which network the purchase settles on, and —
  for the vault rail — that the outcome is a proposal requiring the vault's threshold.
- **FR-011**: Sanctions screening applies to the ACTING account (the future member). Relayed
  rails keep the gateway's fail-closed screen; self-submitted rails rely on the contract's
  on-chain guard as the enforcement, and an unreadable app-side pre-screen MUST NOT be
  rendered as a denial (a failed read is not a sanctions hit).
- **FR-012**: The encryption-key steps (sign/register) follow the purchaser: for a vault they
  are SKIPPED with the honest "encrypted features unavailable for this account" disclosure
  (spec 084 refuses vault signing by design) and the membership remains fully valid; for
  hardware/legacy purchasers they are OFFERED through the same acting-signer ceremony, and
  declining or failing them degrades exactly as today's non-blocking steps do (Retry AND
  Continue anyway).
- **FR-013**: The flow binds its acting identity at confirm time. A change of acting selection
  or connected account mid-flow cancels any pending ceremony (rejecting its parked action,
  spec 088 FR-006), fails the in-flight step naming the bound account, and MUST NOT allow any
  later step (sign, register, retry) to run under the new identity. A completed payment stays
  truthfully attributed to the bound acting address.
- **FR-014**: Closing the modal after a vault proposal loses nothing and claims nothing: the
  proposal lives in the vault queue (spec 043 FR-022b), the modal never reports an active
  membership it cannot read from chain, and reopening reflects on-chain state only.
- **FR-015**: The approve step is omitted whenever the ACTING account's live allowance already
  covers the quoted price — on the classic rail (no approve transaction), and on the vault rail
  (no approve leg in the batch).
- **FR-016**: All existing behaviour for the personal (non-acting) path is byte-identical:
  step machine, passkey batch, gasless seam, retry/continue semantics, tier-unreadable block,
  and named-chain switch are unchanged when `isActingAccount` is false.
- **FR-017**: The spec-088-era blanket refusal strings and the `actingBlocksPurchase`
  always-true gate are removed; refusal remains ONLY for FR-003's ineligible states, and the
  existing acting-refusal test is replaced by per-rail coverage (each acceptance scenario
  above as a testable statement) plus refusal tests for each ineligible kind. Purchase is a
  money-costing signature, so the covered flows join the on-chain e2e tier per the spec-094
  admission rule.

### Key Entities

- **Acting purchase binding**: the identity captured at confirm time — kind
  (personal/vault/legacy/hardware), address, and (for vaults) chainId — that every step,
  ceremony, retry, and completion message resolves against. Immutable for the life of one flow
  run.
- **Purchase rail**: one of classic (acting-signer sequential approve+pay), vault proposal
  (MultiSend batch, terminal state `proposed`), passkey batch (`sendCalls`, personal-only),
  or relayed intent (acting-signed intent + EIP-3009, self-submit fallback). Exactly one rail
  is chosen per run, from the binding — never from the login method alone.
- **Refusal**: a pre-signature terminal state carrying the acting account's name/kind and the
  specific ineligibility reason. Produces no signature, transaction, or proposal.

## Security review *(mandatory for this feature)*

Access control and fund custody are constitution-I highest-risk surfaces; this section is the
explicit reasoning the constitution requires. No contract changes ship, so the review is about
which key signs what, and what a wrong routing would do.

- **Who pays, who receives**: on every rail the payer and the credited member are the SAME
  address — the acting account. Classic: `transferFrom(msg.sender=acting, …)` against the
  acting account's own approval. Vault: the vault approves and the vault is `msg.sender` on
  execution. Relayed: the EIP-3009 authorization is signed by the acting account, and the
  contract credits the recovered signer. There is no rail where the connected wallet's funds
  buy an acting account's tier, and no rail where the acting account's funds buy the connected
  wallet's tier. This symmetry is the invariant every test should pin.
- **The passkey-batch rail is valid ONLY for the passkey account itself** (FR-006). This is
  the single most likely implementation bug: `sendCalls` is the convenient path in a passkey
  session, and using it while acting would execute as the passkey smart account — funds and
  tier both land on the passkey address while the UI names the acting account. Identity is
  resolved FIRST, rail second (spec 073 `wallet.submit` precedent).
- **Vault allowance risk**: the batch approves the exact quoted price, atomically with the
  purchase that consumes it, so no standing allowance to `membershipManager` outlives a
  successful execution. Two residual cases: (a) price rises before execution → the purchase
  leg reverts and, because MultiSend reverts atomically, the approve never lands either — no
  orphaned allowance; (b) a proposal that is never executed leaves nothing on-chain at all.
  Never propose an unlimited approve, and never split approve and purchase into two proposals
  (the gap between them is a live allowance controlled by a shared queue).
- **Replay/domain for relayed rails**: the intent structs come from `@fairwins/intent-types`
  (spec 075 single source; TypehashParity + actionCoverage gates) and carry
  actor/nonce/validAfter/validBefore; the EIP-3009 authorization carries its own nonce with
  the token's `authorizationState` as the durable replay guarantee. The acting-signer change
  MUST NOT introduce a second type table or a hand-built domain — the known hand-synced-domain
  hazard (issue #1038) applies verbatim, and the verifying contract must remain resolved via
  `getContractAddressForChain('membershipManager', membershipChainId())` so the relayed target
  can never diverge from the self-submit one.
- **The acting signer is ECDSA-only on relayed rails**: the membership twins recover an EOA
  signature, and USDC's EIP-3009 likewise. A vault therefore has NO relayed path — its only
  rail is the proposal (which is why FR-005 exists), and any future "1271 for membership
  intents" idea is a separate spec with its own review, not an extension here.
- **Ceremony scope**: the deferred ceremony hands the flow a signer for the acting account
  bound to the membership chain. The broker's existing guarantees carry the weight: dismissal
  rejects (nothing signed), identity change cancels (FR-013), and the cached signer is dropped
  on chain mismatch. The purchase flow must never hold the acting signer beyond the flow run
  or pass it outside the submit seam.
- **Sanctions**: screening the ACTING account is what matters — it is the address acquiring
  platform standing. Screening the connected wallet instead would let a screened account gain
  a tier through an unscreened operator. Fail-closed on relayed rails; on-chain guard as
  enforcement on self-submit; a failed read never renders as a hit (FR-011).
- **Refusal honesty**: every ineligible state refuses BEFORE any signature and produces
  nothing on-chain. The dangerous alternative — silently substituting the connected wallet —
  is exactly the bug class spec 088 FR-002 eliminated; this spec must not reintroduce it under
  a purchase-specific code path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member operating as a recovered or hardware account can complete a purchase in
  one session, and the tier reads active on the acting address (and NOT on the connected
  wallet) from every network's UI afterwards.
- **SC-002**: A vault purchase produces exactly one queue proposal whose execution activates
  the tier on the vault address; at no point between confirm and execution does any surface
  claim the membership is active.
- **SC-003**: Zero code paths exist in which a purchase transaction, intent, or authorization
  is signed by an account other than the flow's bound acting identity — asserted by unit tests
  on the rail chooser and by on-chain e2e coverage for each rail (spec 094 money-path rule).
- **SC-004**: Every ineligible acting state shows a refusal that names the account and the
  reason before any signature; the blanket "switch back to your personal wallet" copy no
  longer appears for eligible kinds.
- **SC-005**: The personal-path purchase flow (classic, passkey, relayed) is behaviourally
  unchanged — existing purchase tests pass without modification except where they asserted the
  blanket acting refusal.

## Assumptions

- `MembershipManager` needs no changes: `purchaseTier`/`purchaseTierWithTerms`/`upgradeTier`/
  `extendMembership` credit `msg.sender`, and the `…WithAuthorization` twins credit the
  recovered signer. Adding a beneficiary parameter is explicitly rejected (see Overview).
- Vault eligibility means the vault's recorded `chainId` equals `membershipChainId()`. There
  is no cross-chain proposal rail and none is wanted (spec 071: writes never span chains).
- Hardware typed-data (EIP-712) support is capability-dependent per device seam; FR-008's
  degradation covers its absence. Shipping the relayed rail for hardware accounts is optional
  scope — the classic rail is the guaranteed path.
- `derived` acting accounts remain refused even where a derived EVM address exists, because
  spec 088 deliberately gave `derived` no submit branch; granting derived accounts a signing
  path is its own feature, and this spec's refusal copy simply states the current truth.
- The sign/register key steps' degradation states ("skipped", "unavailable") already exist in
  the step machine; the vault path reuses them rather than inventing a new outcome.
- Fees: membership pricing is the contract's own tier pricing; no FeeRouter service is added
  or read by this spec.

## Out of scope

- Any `MembershipManager` contract change, including a beneficiary/purchase-for parameter or
  ERC-1271 acceptance on the intent twins.
- A signing path for `derived` accounts (BTC/SOL/ZEC or derived-EVM) — refusal stands.
- Voucher redemption (spec 026) and admin grant flows — unchanged.
- Gifting a membership to an arbitrary third-party address.
- Changes to how membership is READ anywhere (spec 071 estate reads are untouched).
