# Feature Specification: Seamless multichain UX — chain-abstracted writes on a single EVM seam

**Feature Branch**: `110-multichain-write-seam`

**Created**: 2026-09-12

**Status**: Draft (reserved — see issue #1552; plan and tasks follow in the feature PR)

**Input**: Issue #1552 — "viem as the single EVM seam — chain-abstracted writes and the ethers
migration as ONE deliverable". Goal: a seamless multichain UX for the digital asset platform
across all flows and member surfaces — the member never manages a network by hand; the chain is a
property of the asset or the action, and the write path learns what the read path already knows.

## Problem statement

Reads went estate-wide (specs 071, 092, 102); writes did not. The chain is an *argument* on the
read path (`getReadProvider(chainId)`) and *ambient state* on the write path — there is no write
equivalent of the chain-parameterized read seam. Members still manage networks by hand in 14
member-facing components (26 `switchNetwork`/`switchChain` call sites), the switch-and-settle loop
exists three times with divergent constants, and the three write seams
(`submitAsActiveAccount`, `sendCalls`, `sendOnChain`) have three incompatible chain contracts: the
rail that can target a chain cannot carry an identity, and the rail that carries an identity cannot
target a chain. Anything needing both — a vault, recovered, or hardware account on another chain —
falls in the gap.

Underneath sits a dependency problem with the same shape: three EVM stacks ship (ethers + viem +
wagmi), and the one holding the ambient chain is the one making the constraint structural. The ~65
signer-touching files are the *same* files both efforts rewrite, so the chain-abstract write seam
and the ethers→viem migration are ONE deliverable: every file is touched at most once, because
"move a call site onto the seam" and "get that call site off ethers" are the same edit.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The action knows its network (Priority: P1)

As a member, when I act on an asset or a wager, the app puts my transaction on the network the
*action* belongs to — the same way my balances, activity and vaults already span my whole estate
without my choosing a network first.

**Why this priority**: This is the member-facing promise of the whole deliverable. The surfaces
that require an action (Claim / Refund / Resolve) are exactly the ones still pinned to the ambient
chain.

**Independent Test**: With an open wager on network A and the wallet on network B, tapping Claim
completes the claim with no separate "switch network" step in the app.

**Acceptance Scenarios**:

1. **Given** an open wager on network A **and** my wallet connected to network B, **When** I tap
   Claim, **Then** the app resolves the target chain from the wager, moves the wallet if it must,
   and completes the claim — with no separate "switch network" step in the app.
2. **Given** the same, **When** my wallet declines the network change, **Then** nothing is signed
   and a single message names both networks and what would fix it.
3. **Given** any member-facing surface, **When** I inspect it, **Then** it contains no
   "Switch to \<network\>" control; switch call sites resolve to declared target chains.
4. **Given** my wallet is on a chain absent from this build (e.g. BNB), **When** any surface
   renders a network, **Then** it says so honestly and never names a chain the wallet is not on.

---

### User Story 2 - Every acting identity reaches every chain its rail can (Priority: P1)

As a member acting as a recovered, hardware, or vault account, an action targeting a chain my
wallet is not on is performed *as that account* on the target chain — not refused, and never
signed by the connected wallet under someone else's label.

**Why this priority**: The identity/chain gap is the structural blocker — spec 102 filled one cell
of the matrix by hand; spec 105 composed all three concerns once, locally, inside one hook.

**Acceptance Scenarios**:

1. **Given** I am acting as a recovered or hardware account and the action targets a chain my
   wallet is not on, **When** I submit, **Then** the action is performed as that account on the
   target chain.
2. **Given** an action whose rail is a relayed EIP-712 intent for network A, **When** I sign it
   while connected to network B, **Then** no network change is requested at all, because the chain
   is in the signature domain.
3. **Given** a passkey session and a target chain with no bundler (ETC 61, Mordor 63), **When** I
   open the action, **Then** the unavailability is stated *before* the tap, names the chain, and
   names the way out — never a submit-time chain-support error.

---

### User Story 3 - One EVM seam for maintainers (Priority: P2)

As a maintainer, I want one EVM library at the core, so that adding a network or a rail is a
config change rather than a negotiation between three client models.

**Why this priority**: Every surface built before this lands is a surface touched twice; the
migration is what makes the chain abstraction the default shape rather than a per-surface effort.

**Acceptance Scenarios**:

1. **Given** the codebase at the end of the write-seam phase, **When** the import ratchet is run
   with an empty ethers allowlist for `frontend/src`, **Then** it passes — no shipped frontend
   path imports `ethers`.
2. **Given** `verifyMessage` after migration, **When** its signature is inspected, **Then** it is
   still **synchronous** and takes no client (spec 084 invariant).
3. **Given** any read of platform state, **When** the target chain is not the connected chain,
   **Then** it resolves without a wallet interaction, exactly as the estate reads do today.

---

### Edge Cases

- A wallet that refuses `wallet_addEthereumChain` / `wallet_switchEthereumChain`: the refusal is
  reported before anything is signed, naming both chains and the way out.
- A wallet that reports the switch accepted but never settles on the target chain: the
  switch-and-settle loop times out honestly; nothing is signed on the wrong chain.
- A passkey member acting as a vault on a chain with a bundler, and on one without: the rail
  resolution states availability before the tap in both cases (spec 088's writeRail precedent,
  generalized).
- Non-EVM network identity (Bitcoin 061; Solana 100 / Zcash 101 in draft) stays out of the EVM
  seam; network identity must stop being a bare number at the seam boundary so string-id networks
  are refused by type, not by grep.
- Mini-app packages built against the host's published `ethers` singleton keep working through the
  transition (additive host-module change first; removal is a major host-API bump with rebuild and
  re-approval).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Every member-facing write MUST resolve its target chain from the action or asset,
  never from ambient wallet state; the connected chain is an input to *how* the write is routed,
  never to *where* it lands.
- **FR-002**: There MUST be exactly one chain-parameterized write seam, carrying the acting
  identity through all three rails (signer, passkey, relayed intent); it replaces — not sits
  beside — the chain-blind personal branch of `submitAsActiveAccount`.
- **FR-003**: The switch-and-settle loop MUST exist exactly once, with one set of constants; a
  refused or unsettled switch signs nothing and names both networks and the way out.
- **FR-004**: Relayed EIP-712 intents MUST sign the target chain's domain without any wallet
  network change.
- **FR-005**: Rail availability MUST be verified and stated before the tap (per spec 088), never
  asserted and discovered at submit time; an unavailable rail names the chain and the way out.
- **FR-006**: Member-facing surfaces MUST NOT render a "Switch to \<network\>" control; operator
  surfaces (spec 071's single-chain writes) are explicitly exempt and keep naming their chain.
- **FR-007**: Reads MUST remain wallet-free on any target chain; the read seam becomes
  chain-parameterized contract reads (one seam, one provider factory), preserving member RPC
  overrides and failover (spec 069).
- **FR-008**: `frontend/src` MUST converge to one EVM client library, enforced by an import
  ratchet whose allowlist only shrinks; the ambient-chain hook (`useChainId`) is banned and the
  wallet's actual chain is read from the connection, with the target chain taken from the action.
- **FR-009**: `verifyMessage` MUST remain offline and synchronous (spec 084); it is rebuilt on a
  synchronous primitive, never swapped for an async library equivalent.
- **FR-010**: The mini-app host-module surface changes additively first (new module available at a
  minor host-API bump); removing the legacy library from the host scope is a major host-API bump
  shipped only after all first-party packages are rebuilt, re-recorded, and re-approved.
- **FR-011**: Estate-wide reads MUST extend to the wager/pool surfaces that carry actions, so the
  Claim/Refund/Resolve buttons have a target chain to name.
- **FR-012**: Custom signing identities (hardware, recovered/legacy with nonce management) MUST
  survive the migration with their stated semantics intact — including "a refused transaction
  never consumed its nonce" — re-derived against the new account model, not transliterated.
- **FR-013**: Money-path flows touched by any phase keep (or gain) on-chain e2e coverage per the
  spec 094 admission rules; the coverage-matrix rows move with the work.

### Key Entities

- **Target chain**: the network an action belongs to, resolved from the asset/wager/vault record —
  a value that exists at every write call site.
- **Acting identity**: the account a write is performed as (wallet signer, passkey account,
  hardware, recovered, vault) — carried through the seam, orthogonal to the target chain.
- **Write rail**: how a write reaches its chain (direct signer, passkey/AA batch, relayed EIP-712
  intent) — a property of the signer and the target chain, never of the login method.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero member-facing "Switch to \<network\>" controls; the 26 switch call sites across
  14 components resolve to declared target chains or are deleted.
- **SC-002**: One switch-and-settle implementation (down from three); one write seam (down from
  three incompatible ones).
- **SC-003**: Ethers import count in shipped `frontend/src` paths: 188 → 0, ratchet-enforced;
  `useChainId` call sites: 27 → 0.
- **SC-004**: A member with assets on N chains completes claim/refund/resolve/send on all of them
  without ever opening a network selector.
- **SC-005**: Every acting-identity × target-chain combination either works or states its
  unavailability before the tap; zero submit-time chain-support errors in the e2e suite.

## Assumptions

- Atomicity still holds: a single write lands on a single chain. "Writes never span chains" was
  correct; "a write must be on the *connected* chain" was the weaker claim this spec retires.
- The operator console's manual chain scope (spec 071) is deliberate and out of scope.
- Non-EVM rails (Bitcoin, Solana, Zcash) keep their own namespaces; only network *identity* at the
  seam boundary is in scope for them.
- `services/` (relay-gateway, finops-exporter) is the deliberate laggard — Node paths with no
  bundle pressure, migrated last or consciously left as a second model.
- Delivery is phased, one sub-issue of #1552 per phase: #1591 (free wins + ratchet) →
  #1592 (read seam) → #1593 (write seam) → #1594 (ambient-chain ban) → #1595 (surfaces name
  their target) → #1596 (packages, then services).
