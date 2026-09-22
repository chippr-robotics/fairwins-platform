# Governance

How FairWins is operated today, and the direction of travel toward reducing
that operator authority over time. FairWins is a peer-to-peer wager protocol —
there is **no on-chain token governance, no DAO, and no proposal/voting
process**. "Governance" here means the small set of bounded operator roles and
how they are custodied.

## On-chain operator roles

The protocol's privileged actions are split across five OpenZeppelin
AccessControl roles, deliberately separated so no single key carries blanket
authority. For the full privilege matrix see
[Roles and Tiers](roles-and-tiers.md).

| Role | Power | Holder |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Tier configuration, treasury withdrawal, grant/revoke all other admin roles | Guardian Multisig |
| `GUARDIAN_ROLE` | Pause / unpause `WagerRegistry` in response to security incidents | Guardian Multisig + on-call signer(s) |
| `ACCOUNT_MODERATOR_ROLE` | Per-account freeze / unfreeze on `WagerRegistry`. See [Account Moderation Policy](account-moderation.md). | Trust-and-safety multisig |
| `ROLE_MANAGER_ROLE` | Grant / revoke `WAGER_PARTICIPANT` memberships outside the purchase flow | Ops multisig |
| `UPGRADER_ROLE` | Authorize UUPS implementation upgrades on `WagerRegistry` / `MembershipManager` (logic swaps at stable addresses; state preserved) | Air-gapped floppy-keystore admin |

**No role can move escrowed stakes or redirect a payout.** Escrow is held by
`WagerRegistry` and only ever flows to a wager's own participants via the
resolution and refund paths.

### The right to pause

`GUARDIAN_ROLE` holders can pause `WagerRegistry`, halting wager creation and
acceptance protocol-wide. Already-active wagers can still settle and pay
out — pause is not a fund freeze. Every `pause()` and `unpause()` emits the
OpenZeppelin `Paused` / `Unpaused` events with the caller's address.

### The right to freeze

`ACCOUNT_MODERATOR_ROLE` holders can freeze an individual account on
`WagerRegistry`. A frozen account cannot create, accept, settle, claim, or
refund wagers until unfrozen. Every freeze emits `AccountFrozen(user,
moderator, reason)`; every unfreeze emits `AccountUnfrozen(user, moderator)`.
The full disclosure is in [Account Moderation Policy](account-moderation.md).

## Operator custody

During the guarded launch the admin roles are held by a **project multisig**,
which also tunes the only on-chain parameters that exist — tier prices, the
allowlisted stake tokens, and the treasury address. `UPGRADER_ROLE` is held
separately, on an **air-gapped floppy keystore**, so day-to-day configuration
and the authority to replace contract logic are never the same key.

This separation is the point: a guardian can stop the protocol but cannot seize
an account; a moderator can freeze an account but cannot pause the protocol or
move treasury funds; a role manager can hand out memberships but cannot touch
admin roles; an upgrader can ship new logic behind a proxy but holds no other
privilege and cannot grant itself one.

## Emergency pause

`GUARDIAN_ROLE` is for incident response, not policy. Legitimate grounds are a
credible exploit report, a discovered vulnerability, or an oracle/adapter
compromise — **not** disagreement with how people are using the protocol. The
process is:

1. The guardian multisig detects or receives a credible report.
2. A threshold of signers agree and activate the pause.
3. A public notice explains what was paused and why.
4. The issue is investigated and fixed (a fix ships as a UUPS upgrade — see the
   [Contract upgrades runbook](../runbooks/contract-upgrades.md)).
5. The same role calls `unpause()` to restore creation/acceptance.

Because pause does not gate settlement or refunds, escrowed wagers continue to
resolve and remain refundable even while creation/acceptance is halted.

## Decentralization direction

FairWins launches operator-guarded and aims to reduce that authority as the
system proves out. The roles are already bounded (no role can move user funds),
and the intended path is to move `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE`
behind a **timelock and/or a broader multisig** before scaling on mainnet, so
upgrades and parameter changes carry a public delay window. There is no token,
and no plan to gate the protocol behind one.

## Historical note

This repository began as *prediction-dao-research*, an exploration of
**futarchy-based DAO governance** (the "ClearPath" design: welfare-metric
oracles, conditional-token prediction markets, proposal bonds, and
ragequit). That governance design is **not deployed and not maintained** — it
is preserved for reference under
[`docs/archived/`](https://github.com/chippr-robotics/fairwins-platform/tree/main/docs/archived)
and `contracts-archive/`. The live product is the peer-to-peer wager system
these docs describe; its only "governance" is the bounded operator roles above.

## For More Details

- [Introduction](introduction.md)
- [How It Works](how-it-works.md)
- [Security Model](security.md)
- [Account Moderation Policy](account-moderation.md)
- [Contributing Guidelines](../developer-guide/contributing.md)
