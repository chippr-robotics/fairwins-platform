# Security Model

Understanding how FairWins preserves trust, protects participants, and maintains system integrity.

## Operator powers

The protocol is permissionless at the wager level, but the operator team
retains a narrow set of on-chain powers, each bound to a distinct
OpenZeppelin AccessControl role. These exist so the team can respond to
incidents and abuse without holding blanket authority over user funds.

### Emergency pause (GUARDIAN_ROLE)

A holder of `GUARDIAN_ROLE` on `WagerRegistry` can call `pause()`. While
paused, **all** wager creation and acceptance reverts protocol-wide.
Settlement paths (`declareWinner`, `autoResolveFromPolymarket`,
`claimPayout`, `claimRefund`) are not gated by Pausable, so already-active
wagers can continue to resolve and pay out.

Pause is intended only for emergency response: a credible exploit report, a
discovered vulnerability, an oracle compromise. The same role calls
`unpause()` to restore creation/acceptance once the issue is resolved.

A pause shows up in MetaMask as a revert with the OpenZeppelin custom error
`EnforcedPause`.

### Account moderation (ACCOUNT_MODERATOR_ROLE)

A holder of `ACCOUNT_MODERATOR_ROLE` on `WagerRegistry` can freeze or
unfreeze an individual account. A frozen account cannot create, accept,
cancel, declare, claim, or refund on `WagerRegistry` — the contract reverts
with the custom error `AccountFrozenError(address user)`.

A freeze is per-account, not protocol-wide. It does not affect funds in the
user's wallet outside `WagerRegistry`, does not seize escrowed stakes, and
does not expire the user's tier early. Every freeze and unfreeze emits a
public event (`AccountFrozen` / `AccountUnfrozen`) with the moderator's
address and, for freezes, the reason text.

See the dedicated [Account Moderation Policy](account-moderation.md) for the
full disclosure, including illustrative grounds and the unfreeze path.

### Membership management (ROLE_MANAGER_ROLE)

A holder of `ROLE_MANAGER_ROLE` on `MembershipManager` can `grantMembership`
or `revokeMembership` outside the purchase flow. This is the support /
gift / dispute-resolution surface. It cannot grant or revoke admin roles.

### Default admin (DEFAULT_ADMIN_ROLE)

Configures tier prices, treasury, payment token, and authorised registry
hooks. **Only** this role can grant or revoke the three roles above. Held by
the project multisig.

For the full role / privilege matrix, see [Roles and Tiers](roles-and-tiers.md).

## Contract upgradeability

The core value-bearing contracts — `WagerRegistry` (spec 025) and
`MembershipManager` (spec 027) — are UUPS-upgradeable. The frontend and subgraph
always point at a **stable proxy address**; the logic implementation behind it
can be replaced without changing that address or moving escrowed state (wagers or
memberships/accrued fees). Future logic ships as an in-place upgrade, never a
fresh redeploy that would strand existing wagers or memberships.

Upgrades are governed under least privilege:

- **`UPGRADER_ROLE`** — the only role that can replace the implementation
  behind the proxy. It is separate from `DEFAULT_ADMIN_ROLE` so day-to-day
  configuration and upgrade authority are not held by the same key. Upgrade
  transactions are signed with the air-gapped floppy keystore. Authorization is
  non-brickable: the role cannot be configured into a state that locks out
  future upgrades.
- **Initializer protection** — implementations call `_disableInitializers()` in
  their constructor so the logic contract can never be initialized directly, and
  the proxy's `initialize` runs exactly once. This closes the classic
  uninitialized-implementation takeover.
- **Append-only storage** — storage layout is append-only across upgrades;
  existing slots are never reordered or repurposed. `npm run check:storage-layout`
  validates this and gates CI, so an incompatible layout fails before deploy.

See [ADR 004: Upgradeable registry (UUPS)](../adr/004-upgradeable-registry-uups.md)
for the decision record and the [Contract upgrades runbook](../runbooks/contract-upgrades.md)
for the operational procedure.

## Threat model

FairWins is a peer-to-peer wager layer, so its threats are about **settlement
and escrow integrity between two parties** — not the manipulation risks of an
order book or a prediction market. The main ones, and how the protocol handles
them:

| Threat | Mitigation |
|--------|------------|
| The loser refuses to pay | Both stakes are escrowed in `WagerRegistry` at acceptance; the contract pays the winner directly. No counterparty action is needed to get paid. |
| The parties disagree on the outcome | The settler is fixed **at creation** (you, your opponent, a named arbitrator, or an oracle). A draw requires mutual consent (or the arbitrator's ruling) and returns each side's own stake. |
| An oracle never reports, or reports an invalid/tied result | After the resolve deadline anyone can trigger a refund — both stakes return to their owners. Tied/invalid oracle outcomes settle as a draw. Funds are never stranded. |
| Funds get stuck in a half-finished flow | Every state has an exit: un-accepted offers refund after the acceptance deadline (and `batchExpireOpen` sweeps stale ones); active wagers refund after the resolve deadline. Payouts are pull-based and idempotent. |
| Sanctioned or restricted use | `SanctionsGuard` screens both parties on create and accept against the Chainalysis oracle plus an operator deny list, and is **fail-closed** — an unreachable oracle means *not allowed*. |
| Operator overreach | Powers are split across bounded roles (above); none can move escrowed stakes, redirect a payout, or forge a result. |
| Smart-contract exploit | Checks-effects-interactions, audited OpenZeppelin primitives, reentrancy guards, pull payments, and a CI security pipeline (below). A guardian can pause new activity while a fix ships as a UUPS upgrade. |
| Front-running / MEV | Stakes are fixed amounts with no order book and no price to move, so the usual trade-ordering MEV does not apply. Wager terms can be end-to-end encrypted so the mempool reveals only a hash. |

Out of scope: attacks on the underlying chain, physical coercion, and
compromise of a user's own wallet or keys. Those are addressed at the
infrastructure and user-operational-security layers.

## Smart-contract security practices

- **Audited libraries.** The contracts build on OpenZeppelin primitives
  (`AccessControl`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, and the UUPS
  proxy machinery) rather than re-implementing core functionality.
- **Checks-effects-interactions and pull payments.** State is updated before
  external calls, and winners *claim* their pot (`claimPayout`) rather than
  receiving a push transfer — eliminating reentrancy and forced-send footguns.
- **Reentrancy guards** on the value-moving functions, as defence in depth.
- **Overflow safety.** Solidity 0.8+ reverts on overflow/underflow by default.
- **Comprehensive access control.** Every privileged function is gated by an
  explicit role; the sensitive `MembershipManager` hooks only accept calls from
  the authorised `WagerRegistry`.
- **CI security pipeline.** Every change must pass the unit / integration /
  fork test suites, **Slither** static analysis, and **Medusa** fuzzing — these
  gates are not allowed `continue-on-error`. See
  [Security Testing](../security/index.md) and the binding standards in
  `.specify/memory/constitution.md`.
- **Upgrade safety.** Storage-layout compatibility is validated
  (`npm run check:storage-layout`) before any UUPS upgrade, so a
  state-corrupting layout fails in CI rather than on-chain.

## Private wager terms

The on-chain record (addresses, stakes, token, deadlines, status) is public,
like all blockchain data. The **terms** of a wager can be end-to-end encrypted
client-side: the chain stores only a keccak hash and an IPFS pointer, and only
the participants (plus the arbitrator, if any) hold keys to decrypt the
content. Envelopes use the X-Wing hybrid KEM (X25519 + ML-KEM-768), with public
keys published in the on-chain `KeyRegistry`. Full detail:
[Privacy Mechanisms](privacy.md).

(The earlier research design for *position* privacy — Poseidon commitments,
zero-knowledge proofs, and MACI-style anti-collusion — belonged to the archived
futarchy/governance system and is **not** part of the deployed wager protocol.)

## Best practices for users

- **Use a hardware wallet** for meaningful balances; browser-extension wallets
  are more exposed to phishing and malware.
- **Verify contract addresses** against the records in
  [`deployments/`](https://github.com/chippr-robotics/fairwins-platform/tree/main/deployments)
  before interacting — phishing sites mimic the UI but point at malicious
  contracts.
- **Never share** private keys, seed phrases, or keystore files. No legitimate
  FairWins flow ever asks for them.
- **Watch for impersonation** in email, social media, and chat; confirm through
  official channels before trusting unfamiliar communications.

## Security testing and disclosure

The contract suite runs the security pipeline above on every change, and all
deployed addresses are recorded in the repository's `deployments/` directory so
you can verify exactly what you are interacting with. Hardening continues as the
protocol scales on mainnet — including moving admin and upgrade authority behind
a timelock/multisig (see [Governance](governance.md#decentralization-direction)).

For security concerns requiring confidential disclosure, email
**security@fairwins.app** with a detailed description and reproduction steps.

## For More Details

- [Privacy Mechanisms](privacy.md) — envelope encryption for wager terms.
- [Introduction](introduction.md) — system overview context.
- [How It Works](how-it-works.md) — the wager lifecycle and exit paths.
- [Governance](governance.md) — operator roles and the decentralization direction.
- [Account Moderation Policy](account-moderation.md) — the freeze power in full.
