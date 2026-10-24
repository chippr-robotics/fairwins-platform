# Feature Specification: Passkey-native Solana

**Feature Branch**: `100-passkey-solana`

**Created**: 2026-08-29

**Status**: Draft

**Input**: User description: "Give every passkey member a native Solana account inside their
existing FairWins identity, mirroring spec 061's Bitcoin shape: the SOL keypair derives
client-side from the spec-041 passkey PRF master seed (no new seed phrase), surfaced as
portfolio + send/receive ONLY — no wagers, no membership, no gasless, no SPL tokens in v1.
Solana stays a string-id non-EVM network parallel to the numeric NETWORKS map. The optional
relay-gateway module proxies the public RPC and every Solana surface hides or degrades
honestly when it is unconfigured. Spec 063 US3 (Solana recovery from an imported legacy
seed) stays additive and untouched: recovery-imported SOL accounts and the passkey-native
SOL account coexist."

## Overview

Spec 063 gave members Solana *recovery*: import an old BIP-39 seed and the app derives the
SOL accounts that seed controls. But a member who never had an external Solana wallet still
has no SOL address at all — nowhere to receive, nothing in the portfolio. This feature
closes that gap the same way spec 061 did for Bitcoin: **one FairWins identity**. The
passkey PRF master seed (spec 041) deterministically yields exactly one Solana account per
member — no new seed phrase, no backup artifact, restored automatically on account
recovery — surfaced exactly where Solana is functionally useful:

- **Receive**: the member's own Solana address (text + QR + share), clearly labeled and
  visually distinct from their EVM and Bitcoin addresses. Solana is account-based: the
  address is stable by design (no rotation — the protocol norm, stated honestly).
- **Portfolio**: native SOL balance with USD value, marked stale — never zero — when the
  balance source is unreachable.
- **Send**: native SOL to any structurally valid Solana address, with the network fee and
  Solana's rent-exemption minimum disclosed honestly before signing. SOL sends are never
  gasless; the member pays the network fee.

Solana follows the non-EVM rules Bitcoin established (spec 061): string network ids
(`'solana'`, `'solana-devnet'`) in a registry parallel to — never inside — the numeric
`NETWORKS` map; key material never leaves the client; the gateway module is optional
infrastructure with a public-RPC fallback and honest degradation. Native SOL only in v1:
**SPL tokens are out of scope** for display and send (see Assumptions), and no surface may
imply otherwise.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive SOL at a passkey-native address (Priority: P1)

A passkey member wants to move SOL into FairWins. From the receive surface they pick
Solana and see their Solana address — copyable text, scannable QR, share action — derived
from their existing account with no setup beyond the familiar passkey unlock ceremony.
The address is the same every time (Solana is account-based; the app says so rather than
pretending rotation exists), and it is the same address after account recovery on a new
device.

**Why this priority**: Receiving is the on-ramp; nothing else in this feature is useful
until a member can get SOL into their account. It is also the derivation's proving ground —
the address must be deterministic from day one because funds land at it.

**Independent Test**: On a passkey account, open the receive surface, select Solana, and
verify a valid base58 address renders; send devnet SOL to it from an external wallet and
confirm the balance appears; recover the account on a clean profile and verify the same
address is shown.

**Acceptance Scenarios**:

1. **Given** a signed-in passkey member with a PRF-capable authenticator, **When** they
   select Solana on the receive surface, **Then** they see a valid Solana address as
   copyable text, a scannable QR code, and a share action, clearly labeled as a Solana
   address and visually distinct from their EVM and Bitcoin addresses.
2. **Given** a member who has seen their Solana address, **When** they return to the
   receive surface later or on another device after account recovery, **Then** the same
   address is shown, with a plain statement that Solana addresses are stable (no rotation).
3. **Given** SOL sent to the member's address from an external wallet, **When** the member
   views their balance, **Then** the deposit is reflected.
4. **Given** a member whose authenticator does not support PRF, **When** they select
   Solana, **Then** the surface is unavailable with the honest PRF reason (exactly like
   Bitcoin), and no address is fabricated from any other material.

---

### User Story 2 - See SOL in the portfolio (Priority: P1)

A member who holds SOL at their passkey-native address opens the portfolio and sees a
Solana row: their SOL balance and its USD value, alongside their existing assets. If the
balance source is unreachable, the row is marked stale/unavailable — never rendered as
zero.

**Why this priority**: The portfolio is where members verify a receive worked; without it
Story 1 is unverifiable inside the product.

**Independent Test**: Fund the passkey-native address on devnet, open the portfolio, and
verify the SOL row shows the correct balance and USD value; kill the balance source and
verify the row renders stale, not zero.

**Acceptance Scenarios**:

1. **Given** a member with SOL at their passkey-native address, **When** they open the
   portfolio, **Then** the Solana position shows the balance and its USD value from the
   platform's existing SOL price source.
2. **Given** a member with zero SOL and no Solana activity, **When** they view the
   portfolio, **Then** no misleading Solana balance appears (absent or explicitly zero,
   consistent with other zero assets).
3. **Given** the Solana balance source is temporarily unreachable, **When** the portfolio
   loads, **Then** the Solana position is marked unavailable/stale rather than shown as
   zero.
4. **Given** an inbound transfer that is broadcast but not yet at the app's confirmed
   commitment level, **When** the member views their balance, **Then** pending value is
   distinguished from confirmed value (no false finality).

---

### User Story 3 - Send SOL to any valid address (Priority: P2)

A member pays someone in SOL. From the send surface they select Solana, paste or scan the
destination (any structurally valid base58 Solana address — including off-curve
program-derived addresses), enter an amount (or MAX), review a confirmation showing
amount, destination, and the network fee as its own line, then approve with their passkey.
The transaction is signed on the member's device, broadcast, and shown pending until the
network confirms it.

**Why this priority**: Sending completes the money loop but is only useful once receiving
and balances (Stories 1–2) work, and it carries the most risk.

**Independent Test**: With a devnet-funded passkey-native account, send SOL to an external
address; verify the transaction confirms, the fee shown at confirm time was honest, the
balance decreases by amount + fee, and each rejection case (invalid address, EVM `0x…`,
Bitcoin `bc1…`, shortfall, rent-minimum) blocks before signing with a specific reason.

**Acceptance Scenarios**:

1. **Given** a funded member on the send surface, **When** they enter a structurally
   valid Solana destination (base58, 32 bytes; on- or off-curve), **Then** it is accepted.
2. **Given** an invalid destination (bad base58, wrong length, EVM `0x…` address, Bitcoin
   address), **When** entered, **Then** the send is blocked before confirmation with a
   specific reason.
3. **Given** a valid destination and amount, **When** the member reaches confirmation,
   **Then** the network fee is displayed as its own line (in SOL and USD) before any
   signing, the total debit (amount + fee) is explicit, and the surface states the member
   pays the Solana network fee — never "gasless" or "sponsored".
4. **Given** an amount that would leave a brand-new recipient account below Solana's
   rent-exemption minimum, or exceeds the spendable balance once fees are included,
   **When** the member tries to proceed, **Then** the app explains the specific shortfall
   instead of failing at broadcast; **and** MAX computes the largest sendable amount net
   of the fee.
5. **Given** the signed transaction's validity window (recent-blockhash lifetime) expires
   before broadcast, or the fee basis changes beyond the disclosed quote, **When** the
   member approves, **Then** the app re-quotes and requires fresh confirmation rather
   than silently signing against stale terms.
6. **Given** a broadcast send, **When** the member views activity/balance, **Then** the
   transaction shows as pending until confirmed, and a second send cannot double-commit
   the same lamports while the first is pending.

---

### User Story 4 - Honest capability disclosure for Solana (Priority: P3)

A member exploring networks sees Solana listed with an accurate capability statement:
portfolio, send, and receive supported; wagers, pools, membership, gasless sponsorship,
SPL tokens, and all contract-based features not supported. When the optional gateway
module is unconfigured, Solana surfaces degrade honestly (public-RPC fallback where safe,
or an honest unavailable state) — never silent zeros, never fabricated data.

**Why this priority**: Trust surface. Cheap to build; prevents the worst outcome — a
member misled about what Solana can do on the platform.

**Independent Test**: Review every surface where networks/features are listed or
selected; verify Solana appears only where supported, its capability card states scope
truthfully (including "native SOL only — SPL tokens not supported"), and unsetting the
gateway config produces honest degradation on each surface.

**Acceptance Scenarios**:

1. **Given** the network information surface, **When** a member views Solana, **Then**
   supported capabilities (portfolio, send, receive) and unsupported ones (wagers, pools,
   membership, gasless, SPL tokens) are each explicitly stated, and no wallet-switch
   affordance is offered.
2. **Given** wager/pool/membership creation flows, **When** a member selects assets or
   networks, **Then** Solana is never offered.
3. **Given** the gateway Solana module is disabled or unreachable, **When** the member
   uses a Solana surface, **Then** it either serves via the public-RPC fallback or shows
   an honest degraded/unavailable state — never a zero balance or a fake success.
4. **Given** a member holding SPL tokens at their address, **When** they view the
   portfolio, **Then** the app does not display them and the Solana capability statement
   already told the member SPL tokens are unsupported (value is not hidden silently —
   scope is disclosed up front).

---

### User Story 5 - Passkey-native and recovery-imported SOL coexist (Priority: P3)

A member who previously recovered a legacy Solana account (spec 063 US3) and now also
uses the passkey-native account sees both, clearly distinguished: the recovered account(s)
remain selectable derived accounts with their own balances and send paths, and the
passkey-native account is the member's own stable identity account. Neither replaces,
merges with, or signs for the other.

**Why this priority**: Spec 063 US3 is shipped behavior; this feature must be strictly
additive to it. The failure mode — one surface silently shadowing the other, or a send
signed with the wrong account's key — is a fund-safety bug.

**Independent Test**: On an account with a spec-063 recovered Solana account, enable the
passkey-native account; verify both appear with distinct addresses and labels, each send
flow signs with its own key, and removing the recovered key leaves the passkey-native
account untouched (and vice versa: a non-PRF member keeps full recovery functionality).

**Acceptance Scenarios**:

1. **Given** a member with both a recovered SOL account and the passkey-native account,
   **When** they view balances, **Then** both appear, labeled distinctly, and are never
   summed into one position without per-account visibility.
2. **Given** a send from either account, **When** it is signed, **Then** the signature
   comes from that account's own key — the passkey-native derivation never signs for a
   recovered address and vice versa.
3. **Given** a member whose authenticator lacks PRF, **When** they use spec-063 Solana
   recovery, **Then** it works exactly as before — the passkey-native surface being
   unavailable never degrades recovery.

---

### Edge Cases

- Account recovery on a new device: the passkey-native SOL address MUST be byte-identical
  (deterministic from the master seed) — losing a device must not lose SOL.
- Same address on mainnet and devnet: Solana derivation is not network-scoped, so the one
  keypair addresses both clusters. Balances, activity, and sends MUST be strictly scoped
  to the active cluster (cohort), and the UI must label which cluster it is showing —
  devnet SOL must never render in a mainnet context or vice versa.
- Destination is the member's own address: allowed (self-transfer), but disclosed.
- Destination is off-curve (program-derived): structurally valid and accepted; on-curve
  is not a validity gate.
- Dust send to a fresh address: the network rejects account creation below the
  rent-exemption minimum; the app must pre-explain rather than fail at broadcast.
- MAX empties the account to exactly zero: allowed (a zero-lamport system account simply
  ceases to exist; that is protocol-normal), but the confirmation says the account will
  be emptied.
- Blockhash lifetime expiry between quote and broadcast: re-quote + fresh confirmation;
  a stale signed transaction is discarded, never retried silently.
- Concurrent sends: a second send started before the first confirms must account for the
  pending debit; the app must not present a spendable balance that double-counts.
- RPC answering for the wrong cluster (misconfigured member endpoint or upstream): reads
  must not be attributed to the active cluster when the source's cluster identity cannot
  be trusted; fail to stale/degraded, never to a wrong-cluster balance.
- Non-PRF authenticator or external EVM wallet: every passkey-native Solana surface is
  `unavailable` with the honest reason; no derivation from any other material.

## Requirements *(mandatory)*

### Functional Requirements

**Wallet & account model**

- **FR-001**: Each passkey member account MUST have exactly one passkey-native Solana
  account, derived deterministically from the member's existing spec-041 PRF master seed
  — no new seed phrase, password, or backup artifact.
- **FR-002**: Solana private keys MUST exist only on the member's device, in memory only;
  FairWins services MUST never receive, store, or be able to reconstruct them. Only the
  public address and signed transactions ever cross the client boundary.
- **FR-003**: After account recovery on a new device, the member's passkey-native Solana
  address MUST be restored byte-identically with no Solana-specific backup step.
- **FR-004**: When the master seed is unavailable (non-PRF authenticator, injected/
  WalletConnect EVM wallet, uninitialized seed), the passkey-native Solana surface MUST
  be `unavailable` with the honest reason — never a fallback derivation from any other
  material. All non-Solana functionality is unaffected.
- **FR-005**: The derivation constants (HKDF info string, SLIP-0010 path) are normative
  per `contracts/key-derivation-sol.md`; any change is wallet-breaking and requires a
  versioned migration path.

**Receiving**

- **FR-006**: The receive surface MUST offer Solana and display the member's
  passkey-native address as copyable text, QR code, and share action, clearly labeled as
  a Solana address and visually/textually distinct from the member's EVM and Bitcoin
  addresses.
- **FR-007**: The receive surface MUST state honestly that the Solana address is stable
  (account-based; no rotation) — it must not imply the rotation behavior Bitcoin has.
- **FR-008**: Receive surfaces MUST label the active cluster (mainnet vs devnet) per the
  platform's cohort rules; the same address serving both clusters MUST never cause
  cross-cluster display of balances or activity.

**Portfolio**

- **FR-009**: The portfolio MUST show the member's native SOL balance at the
  passkey-native address with USD value from the platform's existing SOL price source.
- **FR-010**: When Solana balance data cannot be fetched, the portfolio MUST mark the
  position stale/unavailable rather than showing zero or stale data as current.
- **FR-011**: Value not yet at the app's confirmed commitment level MUST be
  distinguished from confirmed balance; the portfolio MUST never present unconfirmed
  value as final.

**Sending**

- **FR-012**: Members MUST be able to send native SOL to any structurally valid Solana
  address (base58, 32 bytes; off-curve accepted). Invalid, wrong-chain (EVM `0x…`,
  Bitcoin), or malformed destinations MUST be rejected before confirmation with a
  specific reason.
- **FR-013**: The send confirmation MUST disclose, before any signing: amount,
  destination, the network fee as its own line in SOL and USD, and total debit. The fee
  committed MUST NOT exceed the disclosed quote without re-confirmation, and an expired
  transaction-validity window (recent-blockhash lifetime) MUST force a re-quote — a
  stale signed transaction is never silently rebuilt or rebroadcast.
- **FR-014**: The send flow MUST support MAX (largest sendable amount net of fee), MUST
  block sends that cannot cover amount + fee with a clear shortfall explanation, and
  MUST pre-check Solana rent-exemption: a transfer that would create a recipient account
  below the rent-exemption minimum is blocked with the minimum stated.
- **FR-015**: Sends MUST be signed on the member's device and broadcast; the app MUST
  show the transaction as pending until confirmed and MUST NOT double-count lamports
  committed to a pending send in the spendable balance.
- **FR-016**: Solana sends are never gasless or fee-sponsored; every fee-related surface
  MUST state that the member pays the Solana network fee.

**Capability honesty, scope & coexistence**

- **FR-017**: Solana MUST self-disclose its capabilities wherever networks are described:
  portfolio, send, receive supported; wagers, pools, membership, gasless, SPL tokens,
  and all contract-based features unsupported. Solana MUST NOT be offered in any flow it
  does not support, and no wallet-switch affordance is presented for it.
- **FR-018**: Solana networks are string ids (`'solana'`, `'solana-devnet'`) in the
  registry parallel to the numeric `NETWORKS` map; a Solana id MUST never be assigned a
  numeric chainId and MUST never reach numeric-chainId consumers (contract resolution,
  wagmi, subgraph) — boundaries are guarded by `isSolanaNetworkId`.
- **FR-019**: Solana mainnet and devnet MUST be strictly separated following the
  platform's testnet/mainnet cohort rules; devnet balances/activity never appear in
  mainnet contexts or vice versa.
- **FR-020**: The gateway Solana module is optional infrastructure. When configured, it
  is the preferred RPC route; when unset/disabled, Solana surfaces either serve via the
  public cluster endpoint (never-stranded) or degrade honestly — never silent zeros,
  never fabricated data, and a member RPC read whose cluster identity cannot be trusted
  resolves to stale/degraded rather than a wrong-cluster value.
- **FR-021**: Spec 063 US3 recovery is untouched and coexists additively: recovery-
  imported SOL accounts and the passkey-native account both appear, distinctly labeled,
  each signing only with its own key; neither's availability ever degrades the other.
- **FR-022**: Existing functionality MUST be unaffected: a member who never touches
  Solana sees no behavioral change beyond the new network appearing in supported
  surfaces, and existing EVM + Bitcoin test suites pass unchanged.

### Key Entities

- **Passkey-native Solana Account**: The single per-member ed25519 keypair derived from
  the spec-041 master seed; attributes: address (base58 public key), availability status
  (`ready`/`locked`/`unavailable` + reason). Keys memory-only.
- **Recovery-imported Solana Account** (spec 063, unchanged): a derived external account
  from an imported BIP-39 seed; coexists with, and is never merged into, the
  passkey-native account.
- **Solana Network**: A string-id registry entry (`'solana'`, `'solana-devnet'`);
  attributes: cluster endpoints, gateway segment, explorer, capability set, testnet
  pairing.
- **Solana Transaction**: An inbound or outbound native transfer; attributes: direction,
  lamports, fee (outbound), signature, commitment state; appears in activity.
- **Fee Quote**: Point-in-time fee + recent-blockhash validity window for a proposed
  send; what the member confirms against; expiry forces re-confirmation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A passkey member goes from opening the receive surface to holding a
  scannable Solana address in under 15 seconds (including the PRF ceremony), and the
  address is byte-identical across devices and recoveries in 100% of checks against the
  pinned derivation vectors.
- **SC-002**: Deposits to the passkey-native address appear in the member's balance with
  zero missed deposits across the devnet test matrix.
- **SC-003**: 100% of test sends (external address, self, off-curve destination, MAX)
  confirm on the cluster, and in every case the fee paid equals the quote the member
  confirmed; every rejection case (invalid/EVM/Bitcoin destination, shortfall,
  rent-minimum) blocks before signing with a specific reason.
- **SC-004**: Portfolio SOL balances match an independent Solana explorer for the same
  address in 100% of checks, with a source outage rendering stale — never zero — in
  100% of degraded runs.
- **SC-005**: Every surface listing Solana capabilities passes an honesty review: no
  surface offers or implies wagers, pools, membership, gasless, or SPL support on
  Solana.
- **SC-006**: With both a recovered and the passkey-native account present, 100% of
  sends sign with the correct account's key, and disabling either account leaves the
  other fully functional.
- **SC-007**: Members not using Solana experience no regression: existing portfolio/
  send/receive and Bitcoin suites pass unchanged.

## Assumptions

- **Custody model**: v1 follows the platform's non-custodial, passkey-first account
  model (spec 041); the Solana account derives from the master seed exactly as Bitcoin
  does (spec 061). Members wanting externally-managed Solana keys use spec-063 recovery
  or external wallets.
- **SPL tokens are out of scope for v1** — display and send. Native SOL only. The
  capability surface says so explicitly (FR-017); SPL support would be a follow-up spec
  with its own token-account (ATA) data model.
- **Single account**: one derived account (index 0) in v1; additional account indices
  are reserved in the derivation contract, not exposed.
- **No staking, no Solana Pay invoices, no versioned-transaction features beyond what
  the send path needs**: a plain `solana:` address share/URI is in scope only as address
  text; richer payment-request semantics are out of scope.
- **Fees**: no FairWins platform fee on Solana sends in v1 — members pay only the
  network fee. A future platform fee would go through the FeeRouter (spec 060), not a
  new fee path.
- **Networks**: Solana mainnet-beta plus devnet as the testnet-cohort cluster (the
  spec-063 registry already models both); no testnet cluster, no other SVM chains.
- **Balance/broadcast data**: flows through the optional relay-gateway proxy when
  configured, else the public cluster endpoint — mirroring the spec-061/063 posture.
- **Price data**: SOL/USD reuses the platform's existing SOL price source (the `SOL`
  baseline already exists in the asset taxonomy).
- **Recovery-imported accounts** (spec 063) remain the separate, additive surface they
  are today; this spec adds no migration, merging, or sweeping between the two.
