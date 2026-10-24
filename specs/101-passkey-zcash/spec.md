# Feature Specification: Passkey-native Zcash

**Feature Branch**: `101-passkey-zcash`

**Created**: 2026-08-29

**Status**: Draft

**Input**: User description: "Give every passkey member a native Zcash (ZEC) wallet inside their
existing FairWins account, mirroring the spec-061 Bitcoin shape: portfolio, send, and receive only.
Transparent t-addresses (t1/P2PKH) only — shielded pools (Sapling/Orchard) are out of scope for
send/receive and must be disclosed honestly, never rendered as a zero balance. Keys derive
client-side from the spec-041 passkey master seed; addresses rotate with gap-limit discovery;
signing uses the ZIP-244 (NU5+) transaction digest for v5 transactions; the gateway proxy module is
optional and every surface degrades honestly when it is unconfigured."

## Overview

FairWins members already hold native Bitcoin inside their passkey account (spec 061): one FairWins
identity, no new seed phrase, keys derived on-device from the PRF-recoverable master seed. Zcash is
the next non-EVM network members hold elsewhere, and its **transparent** layer behaves like
Bitcoin's UTXO model — the platform already has the account model, the UI surfaces, the gateway
pattern, and the honest-degradation rules this feature needs.

This feature gives every passkey member a native Zcash wallet surfaced exactly where Zcash is
functionally useful:

- **Portfolio**: the member's transparent ZEC balance appears alongside existing assets, priced in
  USD, explicitly labeled as a *transparent* balance.
- **Receive**: fresh, never-reused transparent addresses (`t1…`) on demand, shown as text + QR +
  payment link, with all previously issued addresses still watched and counted.
- **Send**: pay any valid transparent Zcash destination (`t1…` P2PKH or `t3…` P2SH) with the
  network fee honestly disclosed and confirmed before signing.
- **Shielded honesty**: Zcash's defining feature — the shielded pools (Sapling/Orchard) — is
  exactly what this version does *not* support. Any detected shielded involvement renders as an
  explicit `unsupported-holdings` disclosure, never as an empty or zero balance. A balance the
  client cannot see must never read as "no funds".

Like Bitcoin, Zcash supports **only** portfolio, send, and receive — no wagers, no pools, no
gasless sponsorship, no membership actions — and the product says so plainly wherever a member
could otherwise expect those features. The feature is strictly additive: spec 061's Bitcoin wallet,
spec 063's (unstarted) legacy-seed Zcash recovery story, and every EVM surface are untouched.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Receive Zcash with rotating transparent addresses (Priority: P1)

A member wants to move ZEC into FairWins. From the receive surface they pick Zcash, and the app
shows a fresh transparent address (`t1…`) as text + QR + share link. The next time they ask to
receive, they get a *new* address — addresses are never handed out twice — yet funds sent to any
previously issued address still arrive and count toward their balance. The surface states plainly
that FairWins issues transparent addresses and does not receive to shielded (`zs…`/`u1…`)
addresses.

**Why this priority**: Receiving is the on-ramp; nothing else is useful until a member can get ZEC
into their wallet, and rotation cannot be retrofitted onto a reused-address history.

**Independent Test**: With a funded external Zcash wallet, request a receive address in FairWins,
send a small amount to it, confirm the balance appears; request a second address, confirm it
differs; send to the first (older) address again and confirm the balance still updates.

**Acceptance Scenarios**:

1. **Given** a signed-in passkey member on the receive surface, **When** they select Zcash,
   **Then** they see a valid transparent Zcash address as copyable text, a scannable QR code, and a
   share action, clearly labeled as a Zcash transparent address (mainnet vs testnet).
2. **Given** a member who has been shown a receive address, **When** they request a new receive
   address, **Then** the address shown is one never previously displayed for this account.
3. **Given** a member with several previously issued addresses, **When** ZEC is sent to any of them
   (including the oldest), **Then** the member's portfolio balance reflects the deposit.
4. **Given** the receive surface, **When** displayed, **Then** it discloses that shielded
   (`zs…`/`u1…`) receiving is not supported — a sender shielding to the member is not implied to
   work.
5. **Given** a receive QR code, **When** scanned by a common external Zcash wallet, **Then** the
   wallet recognizes the address (and amount, when the member specified one via the payment link)
   without manual correction.
6. **Given** a member on a non-PRF authenticator or an injected/WalletConnect EVM wallet, **When**
   they open the Zcash receive surface, **Then** they see an honest `unavailable` state naming the
   PRF/passkey requirement (same wording model as Bitcoin) — never a broken or empty surface.

---

### User Story 2 - See transparent ZEC in the portfolio (Priority: P1)

A member who holds ZEC (received via Story 1) opens their portfolio and sees a "Zcash" row: total
transparent ZEC across all their issued addresses and its USD value. The row and its detail view
label the figure as the *transparent* balance.

**Why this priority**: The portfolio is where members verify a receive worked; without it Story 1
is unverifiable inside the product.

**Independent Test**: Fund a member's Zcash addresses (multiple addresses), open the portfolio, and
verify one Zcash row whose ZEC quantity is the sum across addresses and whose USD value matches
quantity × current ZEC/USD price; pull the balance source down and verify stale-marking, not zero.

**Acceptance Scenarios**:

1. **Given** a member with ZEC spread across three issued addresses, **When** they open the
   portfolio, **Then** the Zcash position shows the summed transparent balance and its USD value.
2. **Given** a member with zero ZEC and no Zcash activity, **When** they view the portfolio,
   **Then** no misleading Zcash balance appears (row absent or explicitly zero, consistent with
   other zero assets).
3. **Given** the Zcash balance source is temporarily unreachable, **When** the portfolio loads,
   **Then** the Zcash position is marked unavailable/stale rather than silently shown as zero.
4. **Given** a deposit that is broadcast but not yet confirmed, **When** the member views their
   balance, **Then** pending value is distinguished from confirmed value (no false finality).
5. **Given** any Zcash surface showing a balance, **When** displayed, **Then** the balance is
   labeled as the transparent balance — the product never implies it is the member's total Zcash
   position.

---

### User Story 3 - Send ZEC to any transparent address (Priority: P2)

A member wants to pay someone in ZEC. From the send surface they select Zcash, paste or scan the
destination (`t1…` P2PKH or `t3…` P2SH), enter an amount (or MAX), review a confirmation showing
the amount, the destination and its recognized type, and the network fee as its own line, then
approve. The transaction is signed on-device (ZIP-244 digest, v5 transaction) and reported as
pending until the Zcash network confirms it — or as expired if it never does within its expiry
window, with the funds released back to spendable.

**Why this priority**: Sending completes the money loop but is only useful once receiving and
balances work; it also carries the most risk (a consensus-critical sighash), so it builds on a
proven foundation and a vector-gated signing module.

**Independent Test**: With a funded FairWins Zcash wallet on testnet, send ZEC to one external
address of each supported type (`tm…`/`t2…` on testnet); verify each transaction confirms, the fee
paid equals the fee the member confirmed, and the portfolio balance decreases by amount + fee.

**Acceptance Scenarios**:

1. **Given** a funded member on the send surface, **When** they enter a valid transparent
   destination of either standard type (P2PKH, P2SH), **Then** the address is accepted and its
   type recognized.
2. **Given** a shielded destination (Sapling `zs1…` or unified `u1…`), **When** entered, **Then**
   the send is blocked before confirmation with a *specific* reason — "shielded destinations are
   not supported", never a generic "invalid address".
3. **Given** an invalid or wrong-network destination (typo, checksum failure, testnet `tm…` on
   mainnet, EVM `0x…`, Bitcoin `bc1…`), **When** entered, **Then** the send is blocked before
   confirmation with a clear reason.
4. **Given** a valid destination and amount, **When** the member reaches the confirmation step,
   **Then** the network fee is displayed as its own line (in ZEC and USD) before any signing, the
   total debit (amount + fee) is explicit, and the confirmed fee is a hard ceiling — the signed
   transaction never pays more than the member confirmed.
5. **Given** an amount that exceeds spendable balance once the fee is included, **When** the member
   tries to proceed, **Then** the app explains the shortfall; **and** MAX computes the largest
   sendable amount net of the fee.
6. **Given** a broadcast send, **When** the member views activity/balance, **Then** the transaction
   shows as pending until confirmation; **and** if it reaches its expiry height unconfirmed, it is
   reported as expired (not silently dropped) and the committed coins return to spendable.
7. **Given** a second send started before the first confirms, **When** built, **Then** it never
   commits the same coins as the in-flight send.

---

### User Story 4 - Shielded funds disclosed, never zeroed (Priority: P2)

A member whose Zcash activity involves the shielded pools — a deposit funded from a shielded
address, or history that moved value into shielding — sees an explicit disclosure that FairWins
can only read the transparent layer. The app renders a distinct `unsupported-holdings` state:
"some of this wallet's activity involves Zcash's shielded pools, which FairWins cannot read;
shielded funds, if any, are not shown and are not zero." A shielded balance the client cannot see
must never read as "no funds".

**Why this priority**: This is the honest-state core of the feature (constitution III). Zcash is
*defined* by shielding; silently showing a transparent-only number as the member's Zcash position
would be a fabricated fact. It depends on Stories 1–2 existing but must ship before the feature is
broadly promoted.

**Independent Test**: Credit a member's t-address from a shielded source (deshielding
transaction); verify the transparent deposit counts normally AND the shielded-involvement
disclosure appears; verify a wallet with only shielded-involved history never renders a bare
zero/empty state without the disclosure.

**Acceptance Scenarios**:

1. **Given** a transaction crediting or debiting the member's addresses that carries shielded
   components (Sapling/Orchard bundles or legacy JoinSplits), **When** the wallet processes it,
   **Then** the transparent value is accounted normally and the wallet enters the
   `unsupported-holdings` disclosure state.
2. **Given** the `unsupported-holdings` state, **When** the portfolio Zcash row or detail is
   shown, **Then** the disclosure is visible and the balance is labeled transparent-only — never
   presented as the member's total Zcash holdings.
3. **Given** a wallet whose only detected activity involves shielded pools and whose transparent
   balance is zero, **When** viewed, **Then** the app shows the disclosure state — never a plain
   empty/zero balance implying "no funds".
4. **Given** shielded-involvement detection is degraded (the data source cannot report shielded
   components), **When** balances render, **Then** the app discloses that shielded involvement
   could not be checked rather than asserting the balance is complete.

---

### User Story 5 - Honest capability disclosure and optional infrastructure (Priority: P3)

A member exploring networks sees Zcash listed with an accurate capability statement: portfolio,
send, and receive of transparent ZEC are supported; shielded transactions, wagers, pools,
memberships, gasless sponsorship, and all contract-based features are not. When the operator has
not configured the Zcash gateway module, every Zcash surface hides or degrades honestly — no
broken screens, no zeros, no implied support.

**Why this priority**: Trust surface; cheap to build; prevents a member being misled about what
Zcash can do on the platform or whether the feature is live in their deployment.

**Independent Test**: Review every surface where networks/features are listed; verify Zcash appears
only where supported and its network page states capabilities truthfully. Boot the app with the
gateway module unconfigured and verify every Zcash surface hides or shows an honest
"unavailable" state.

**Acceptance Scenarios**:

1. **Given** the network information surface, **When** a member views Zcash, **Then** supported
   capabilities (transparent portfolio/send/receive) and unsupported ones (shielded, wagers,
   pools, membership, gasless) are each explicitly stated.
2. **Given** wager/pool/membership creation flows, **When** a member selects assets or networks,
   **Then** Zcash is not offered.
3. **Given** the send confirmation for Zcash, **When** displayed, **Then** it never describes the
   transaction as gasless or fee-sponsored; the member always pays the Zcash network fee and is
   told so.
4. **Given** a deployment where the Zcash gateway module is unconfigured or killswitched, **When**
   a member navigates the app, **Then** Zcash surfaces are hidden or show an honest unavailable
   state — never an error page, a spinner forever, or a zero balance.

---

### Edge Cases

- Member restores their account (passkey recovery / new device): all previously issued addresses
  and their funds MUST be recoverable deterministically from the account itself; the rotation
  cursor rebuilds from discovery and never decreases.
- A sender pays the same issued address twice, or pays an address ahead of the rotation sequence
  (within the discovery gap limit): funds are still detected and counted.
- A deshielding transaction (shielded → member's t-address): the transparent output counts as a
  normal deposit; shielded involvement is disclosed (Story 4).
- A member's counterparty asks for a shielded address: the receive surface's disclosure (Story 1,
  scenario 4) is the answer; the product never fabricates one.
- Zcash network upgrade activates (new consensus branch id): the app MUST NOT sign with a stale
  branch id — if the current branch id cannot be confirmed, sends are blocked with an honest
  reason (funds remain safe and visible; see FR-019).
- Transaction reaches its expiry height unconfirmed: reported as expired, coins unlock; never
  silently vanishes from activity.
- Dust-level deposits and dust change: the send flow avoids creating uneconomical outputs and
  never strands value silently.
- Testnet/mainnet separation: Zcash testnet activity is never mixed with mainnet balances,
  mirroring the platform's existing pairing rules; testnet addresses (`tm…`/`t2…`) are rejected as
  mainnet destinations and vice versa.
- A `zcash:` payment URI (ZIP-321) is pasted or scanned: transparent-recipient URIs populate
  destination and amount; URIs whose recipient is shielded are rejected with the shielded-specific
  reason.
- Concurrent sends: a second send started before the first confirms must not double-spend the same
  coins.
- The member also holds wrapped/exchange ZEC representations elsewhere: out of scope — no
  wrapped-ZEC aggregation exists on the platform today and none is introduced.

## Requirements *(mandatory)*

### Functional Requirements

**Wallet & account model**

- **FR-001**: Each passkey member account MUST have exactly one Zcash wallet, derived
  deterministically from the member's existing FairWins account credentials (the spec-041 master
  seed) — no new seed phrase, password, or backup artifact.
- **FR-002**: Zcash private keys MUST exist only on the member's device, memory-only; FairWins
  services MUST never receive, store, or be able to reconstruct them. The gateway sees bare
  t-addresses and signed raw transactions only — never keys, xpubs, or descriptors.
- **FR-003**: After account recovery on a new device, the member's Zcash wallet — all issued
  addresses, balances, and rotation position — MUST be restored without any Zcash-specific backup
  step, via deterministic derivation plus gap-limit discovery.
- **FR-004**: On a non-PRF authenticator or a non-passkey (injected/WalletConnect) account, the
  Zcash wallet MUST present an honest `unavailable` state naming the PRF/passkey requirement —
  the same availability matrix and wording model as Bitcoin (spec 061). Never a fallback
  derivation from any other material.

**Receiving & address rotation**

- **FR-005**: The receive surface MUST offer Zcash and display, for each request, a fresh
  transparent P2PKH address never previously shown for that account, as copyable text, QR code,
  and shareable payment link (with optional amount).
- **FR-006**: All previously issued addresses MUST remain monitored indefinitely; funds arriving
  at any of them MUST appear in the member's balance and activity. The rotation cursor per
  network MUST never decrease; recovery sets it from discovered usage (gap limit 20), never below
  a cached value.
- **FR-007**: Receive addresses MUST be clearly labeled as Zcash transparent addresses (mainnet vs
  testnet) and MUST be visually/textually distinct from the member's EVM and Bitcoin addresses.
  The receive surface MUST disclose that shielded (`zs…`/`u1…`) receiving is unsupported.

**Portfolio**

- **FR-008**: The portfolio MUST show the member's total confirmed transparent ZEC across all
  issued addresses, with USD value from the platform's price-feed source, explicitly labeled as
  the transparent balance.
- **FR-009**: Pending (unconfirmed) inbound and outbound value MUST be distinguished from
  confirmed balance; the portfolio MUST never present unconfirmed value as final.
- **FR-010**: When Zcash balance data cannot be fetched, the portfolio MUST mark the position
  stale/unavailable rather than showing zero or cached data as current.

**Shielded honesty (unsupported-holdings)**

- **FR-011**: When any transaction touching the member's addresses carries shielded components
  (Sapling or Orchard bundles, or legacy JoinSplits), the wallet MUST enter an
  `unsupported-holdings` disclosure state: the portfolio row/detail states that some activity
  involves Zcash's shielded pools, which the app cannot read, and that shielded funds — if any —
  are not included and are not zero. A shielded balance the client cannot see MUST never render
  as an empty or zero balance.
- **FR-012**: The disclosure wording MUST be affirmative about what IS shown ("transparent balance
  only") and honest about what is unknown ("shielded funds, if any, are not shown"); it MUST NOT
  claim the member has shielded funds (the client cannot know that either).
- **FR-013**: When shielded-involvement detection itself is degraded (the data source cannot
  report shielded components), the app MUST disclose that completeness could not be checked
  rather than asserting the transparent figure is the whole picture.

**Sending**

- **FR-014**: Members MUST be able to send ZEC to any syntactically valid transparent destination
  of the standard types: P2PKH (`t1…` mainnet / `tm…` testnet) and P2SH (`t3…` mainnet / `t2…`
  testnet). Invalid, checksum-failing, wrong-network, or non-Zcash destinations MUST be rejected
  before confirmation with a specific reason; shielded destinations (`zs…`, `u1…`) MUST be
  rejected with a shielded-specific reason, never a generic "invalid address".
- **FR-015**: The send confirmation MUST disclose, before any signing: amount, destination (with
  recognized type), the network fee as its own line in ZEC and USD, and total debit. The
  member-confirmed fee is a hard signing ceiling: the client MUST refuse to sign a transaction
  whose actual fee exceeds it (fee-overrun refusal, mirroring Bitcoin's `FeeOverrunError`), and a
  fee quote MUST expire (60s) and be re-confirmed if inputs change.
- **FR-016**: The send flow MUST support MAX (largest spendable amount net of the fee), MUST block
  sends that cannot cover amount + fee with a clear shortfall explanation, and MUST avoid
  creating uneconomical (dust) change.
- **FR-017**: Sends MUST be signed on the member's device as Zcash v5 (NU5+) transactions using
  the ZIP-244 transaction digest, and broadcast via the gateway. The app MUST show the
  transaction as pending until confirmed, MUST set an expiry height and report expiry honestly
  (releasing the committed coins), and MUST prevent the same coins from being committed to two
  concurrent sends.
- **FR-018**: Zcash sends are never gasless or fee-sponsored; every fee-related surface MUST state
  that the member pays the Zcash network fee.
- **FR-019**: The consensus branch id used for signing MUST be obtained from current network state
  — never hardcoded. If the current branch id cannot be confirmed (source unreachable, or network
  height beyond the app's known-upgrades knowledge), signing MUST be refused with an honest
  reason; balances and receiving remain available.
- **FR-020**: The app MUST accept `zcash:` payment URIs (ZIP-321, scan or paste) with a
  transparent recipient, populating destination and amount; URIs with shielded recipients are
  rejected per FR-014.

**Capability honesty, scope & infrastructure**

- **FR-021**: Zcash MUST self-disclose its capabilities wherever networks are described:
  transparent portfolio/send/receive supported; shielded transactions, wagers, pools, membership,
  gasless, and all contract-based features unsupported. Zcash MUST NOT be offered in any flow it
  does not support.
- **FR-022**: Zcash testnet and mainnet MUST be strictly separated, following the platform's
  existing testnet/mainnet pairing rules; testnet balances and addresses never appear in mainnet
  contexts or vice versa.
- **FR-023**: The Zcash gateway module is OPTIONAL infrastructure: when unconfigured, disabled, or
  killswitched, every Zcash surface MUST hide or degrade honestly (unavailable states, stale
  marking, blocked sends with reasons) — never crash, spin forever, or render zeros.
- **FR-024**: Existing functionality MUST be unaffected: EVM surfaces, the spec-061 Bitcoin wallet
  (its frozen derivation vectors byte-identical), and spec 063's unstarted Zcash-recovery story
  (US4) all remain intact. This feature's registry, gateway module, and signing library MUST be
  reusable by 063-US4 when it is implemented (additive, not blocking).

### Key Entities

- **Zcash Wallet**: The per-member transparent Zcash key context, derived from the member's
  existing account; owns the rotation state and all issued addresses; carries the
  `unsupported-holdings` disclosure flag.
- **Issued Address**: A transparent receive address handed to the member at a point in time;
  attributes: derivation index, network (mainnet/testnet), first-shown timestamp; permanently
  monitored.
- **Coin (UTXO)**: A discrete piece of spendable transparent value at an issued address;
  attributes: amount (zatoshis), confirmation status, in-flight lock.
- **Zcash Transaction**: An inbound or outbound transfer; attributes: direction, amount, fee
  (outbound), destination/source, confirmation state (pending / confirmed / expired), and a
  shielded-involvement flag; appears in the activity surface.
- **Fee Quote**: The deterministic network fee for a proposed send (ZIP-317 conventional fee over
  the transaction's shape), with freshness; what the member confirms against and the hard signing
  ceiling.
- **Consensus State**: The current chain height and consensus branch id; required for signing;
  its absence blocks signing honestly (FR-019).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A member can go from opening the receive surface to holding a scannable transparent
  Zcash address in under 15 seconds (including the PRF ceremony), and 100% of consecutive receive
  requests produce distinct addresses.
- **SC-002**: Deposits to any previously issued address (tested across at least 10 rotated
  addresses per account) appear in the member's balance with zero missed deposits.
- **SC-003**: 100% of test sends to each supported destination type (P2PKH, P2SH) confirm on the
  Zcash network, and in every case the fee paid equals the fee the member confirmed (never
  above).
- **SC-004**: The ZIP-244 signature-digest implementation passes 100% of the official ZIP-244
  reference vectors AND matches an independent implementation on a differential test corpus
  before any mainnet send is possible.
- **SC-005**: Portfolio transparent balances match an independent Zcash block explorer for the
  same addresses in 100% of checks, with pending vs confirmed value correctly distinguished.
- **SC-006**: After account recovery on a fresh device, 100% of previously issued addresses and
  funds are restored with no Zcash-specific user action.
- **SC-007**: In every test case involving shielded components (deshielding deposits,
  shielded-touching history, shielded-only activity with zero transparent balance), the
  `unsupported-holdings` disclosure renders and no surface shows a bare zero/empty state — 100%
  of an honesty review checklist passes.
- **SC-008**: With the gateway module unconfigured, 100% of Zcash surfaces hide or show honest
  unavailable states (no errors, no zeros, no permanent spinners).
- **SC-009**: Members not using Zcash experience no regression: existing portfolio/send/receive
  and Bitcoin test suites pass unchanged, and the spec-061 frozen derivation vectors are
  byte-identical.

## Assumptions

- **Custody model**: v1 follows the platform's non-custodial, passkey-first account model; the
  Zcash wallet derives deterministically from the spec-041 master seed. Members wanting
  self-managed keys continue to use external wallets; members recovering *legacy* seeds with Zcash
  funds are spec 063's US4 (unstarted, additive to this feature).
- **Transparent-only scope**: v1 supports transparent (t-address) receive, hold, and send only.
  Shielded receiving, shielded sending, auto-shielding, and unified addresses are out of scope;
  the product discloses this rather than hiding it. A shielded follow-up would be its own spec
  with its own security lifecycle (a shielded wallet requires trial-decryption scanning and
  proving keys — a different system, not an increment).
- **Address types**: FairWins issues P2PKH (`t1…`) receive addresses only (the task's t1/P2PKH
  rule); it *pays to* both P2PKH and P2SH destinations. No P2SH receiving in v1 (no script
  wallets exist on this path).
- **Address rotation**: mirrors Bitcoin's rules — rotate receive addresses, gap-limit-20
  discovery, never-decreasing cursor. No Zcash-specific reason to differ was found: transparent
  Zcash inherits Bitcoin's address-reuse privacy weakness, and the shared BIP-44 external-chain
  layout makes the Bitcoin discovery convention directly applicable. (Rotation matters *more* on
  a transparent-only Zcash wallet, since members may wrongly assume Zcash implies privacy.)
- **Fees**: no FairWins platform fee on Zcash sends in v1 — members pay only the Zcash network fee
  (ZIP-317 conventional fee). If a platform fee is ever added it goes through the FeeRouter
  (spec 060) and the FinOps catalogue (spec 089); none is registered now.
- **Wagering scope**: ZEC is not a wager/pool/membership asset; no contract features extend to it.
- **Balance data**: balance/UTXO/broadcast/consensus data comes from public Zcash data sources
  proxied through the optional relay-gateway module with quotas and honest degradation,
  consistent with Bitcoin (spec 061).
- **Price data**: ZEC/USD pricing reuses the platform's existing price-feed configuration seam; if
  no ZEC/USD feed is configured, the USD column degrades honestly (quantity shown, USD marked
  unavailable) rather than showing $0.
- **Networks**: Zcash mainnet plus the public Zcash testnet; no other networks or forks.
- **No wrapped aggregation**: unlike BTC/WBTC, no wrapped-ZEC instance exists in the platform's
  asset taxonomy; the Zcash row is native-only and no aggregation behavior is introduced.
