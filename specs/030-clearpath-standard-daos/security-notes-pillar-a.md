# Security notes — spec 030 pillar A (`StandardDAOFactory`)

**Date**: 2026-08-30 · **Decision**: issue #1268 · **Scope**: the contracts added for native standard
DAO creation — `StandardDAOFactory`, `StandardDAOGovernor`, `StandardDAOToken` and the three
creation-code modules in `StandardDAODeployers.sol`.

This is the security review pass required before merge (`.github/agents/`, CLAUDE.md guardrail 1).
It records what the contracts are trusted to do, what they deliberately cannot do, and the two or
three places where a plausible "improvement" would create a hole.

---

## 1. The trust model in one paragraph

The factory is a **deployer and an index**, never a custodian and never an authority. In one
transaction it deploys a `TimelockController` (the DAO's treasury), a stock OpenZeppelin `Governor`,
and — unless the member brings their own `IVotes` token — a fixed-supply `ERC20Votes`. It then grants
the governor the timelock's proposer and canceller roles, opens execution, and **renounces the
timelock's admin role**. From the moment the transaction returns, the only holder of authority over
that DAO is the DAO.

FairWins retains exactly two things: `DEFAULT_ADMIN_ROLE`/`UPGRADER_ROLE` on the **factory proxy**
(which governs future creations and the membership/sanctions wiring), and nothing at all on any DAO
already created.

## 2. Upgradeability — and why the two halves differ

| Contract | Upgradeable? | Reason |
|---|---|---|
| `StandardDAOFactory` | **Yes (UUPS, `UUPSManaged`)** | It holds state (the DAO index) and authority (the gating wiring). Spec 030 FR-018 requires the pattern for exactly that, and the mini-app resolves it by a stable deployment key. Precedent: `WagerPoolFactory` (spec 034) — an upgradeable factory minting immutable products. |
| `StandardDAOGovernor` | **No** | An upgrade key over a member's governor is a key over their treasury. |
| `TimelockController` | **No** (stock OZ) | Same, more directly: the timelock's entire guarantee is that only its own governance can move funds. A platform-held implementation slot would silently outrank that guarantee, and no proposal, delay or quorum would constrain it. |
| `StandardDAOToken` | **No** | An upgradeable votes token is an electorate somebody else can rewrite. There is also **no mint function and no owner** — the supply is fixed at construction, so the electorate cannot be diluted after the fact. |

This is the `SafePolicyGuard` reasoning (spec 043/068) applied to governance: *an upgrade key over a
policy or governance contract is a backdoor across every instance it governs*. A corrected template
ships as a **new factory**, never as a swap under a live DAO. Spec 030 FR-018 named "native
governance/treasury" among the contracts to make upgradeable; the 2026-08-30 amendment reverses that
for created instances and explains why.

**Residual risk, stated plainly**: `DEFAULT_ADMIN_ROLE` on the factory proxy currently sits on the
deploy EOA, as it does for every other proxy in the estate pending the Safe handoff (issue #966). Its
blast radius here is bounded to **future** creations — it cannot reach a DAO that already exists.

## 3. Reentrancy

`createDAO` is `nonReentrant` (`ReentrancyGuardUpgradeable`) and follows checks-effects-interactions:

1. **Checks** — membership tier, sanctions screen, parameter validation, votes-token probe.
2. **Deploy** — three `CREATE`s through the deployer modules. No attacker-supplied code runs: the
   creation code is fixed at compile time and the constructors are OZ's own.
3. **Effects** — `daoCount` increments and the record, governor index and creator index are written.
4. **Interactions** — the four role calls on the just-deployed timelock, then the events.

The one place attacker-chosen code executes is `_requireVotesToken`, which `try`-calls
`IVotes(token).getVotes(address(0))` on an address the caller supplies. A malicious token could
reenter — and is stopped by the guard. Even without the guard the damage would be bounded (a nested
call would create a second, independent DAO and increment `daoCount` normally; there is no balance,
no allowance and no partially-updated struct to observe), but a guard that costs one storage slot is
cheaper than that argument being right forever.

`StandardDAOToken`'s constructor calls `_mint` then `_delegate` on the **recipient**, which is
`msg.sender` of `createDAO` — an address that has already passed the sanctions screen. Neither call
hands control to it (`ERC20` has no transfer hook; `Votes._delegate` is internal bookkeeping).

## 4. Griefing and spam

- **Who can create**: any wallet holding `DAO_MEMBER_ROLE` at tier **Silver or above** and passing
  the sanctions screen. Deliberately the *same* gate pillar B's `ExternalDAORegistry` uses for
  registration, rather than a new tier policy invented here.
- **Spam cost is the creator's alone.** Creation deploys three contracts and is expensive —
  **6,340,772 gas measured** for the new-token path. It writes one `DAORecord`, one index entry and
  one array push, all paid by the caller.
  Nothing in the factory is a shared resource an attacker can exhaust: there is no per-block cap to
  hit, no queue to fill, no allowance to drain, and enumeration is by explicit id, so a large
  `daoCount` never makes an existing read more expensive. A spammer buys memberships and burns their
  own gas to add rows nobody has to read.
- **`getDAOsByCreator` is unbounded per creator**, by construction. It is a `view` reached from an
  RPC read, so growth costs the caller's own node, not a transaction; and it is bounded in practice
  by that creator's own gas spend. It is deliberately not paginated — the alternative (a mapping the
  app pages through) buys nothing a subgraph or an event scan does not already give.
- **`purpose` is emitted, never stored** (`StandardDAOPurpose`), so an arbitrarily long string costs
  the creator calldata + log gas and consumes no storage.
- **Parameter bounds exist to protect the creator from themselves, not the chain**:
  `quorumPercent` must be 1..100 (OZ would reject >100 anyway; 0 would make every proposal pass with
  no votes), `votingPeriod` must be non-zero (a zero-period DAO can never pass anything), and
  `timelockDelay` is capped at **30 days**. That cap is the one that matters: raising a timelock delay
  is itself a timelocked proposal, so a mistyped delay locks a member's own treasury for the duration
  with no way back.

## 5. Timelock role hygiene — the security core

`_wireAndRelinquish` is four calls, and each one is load-bearing:

```
proposer  := governor          only a passed proposal can schedule against the treasury
canceller := governor          Governor._cancel can withdraw a scheduled operation
executor  := address(0)        OPEN execution
admin     := renounced         the timelock is left as its own only admin
```

- **Open execution adds no authority.** What executes was fixed at queue time by the passed proposal;
  execution is a permissionless crank. What it removes is a way for a DAO to strand a passed proposal
  behind an executor who has gone away — the standard OZ recommendation.
- **Admin renounce is the invariant.** `TimelockController`'s constructor grants
  `DEFAULT_ADMIN_ROLE` to the timelock itself *and* to the `admin` argument. The factory passes
  itself so it can perform the three grants above, then renounces in the same transaction. **If that
  renounce were ever removed, the factory would hold root over every treasury it had ever created** —
  it could grant itself proposer and executor and move funds without a vote. This is asserted
  directly in `test/clearpath/StandardDAOFactory.test.js` ("renounces the timelock admin role"), by
  reading `hasRole(DEFAULT_ADMIN_ROLE, factory)` on chain rather than by inspecting the call list.
- **The creator gets nothing either.** The tests assert that neither the factory, nor the creator,
  nor the platform admin holds proposer, canceller or admin. A creator's only advantage is that they
  hold the initial token supply, which is a *governance* position, not an *authority* one.

## 6. Integrity of what gets deployed

Because the creation code lives in three separate modules (EIP-170 — see §8), the factory reads their
addresses from storage. An admin could repoint them (`setDeployers`). That grants no new authority —
`DEFAULT_ADMIN_ROLE` already implies `UPGRADER_ROLE` over the whole implementation — but it is a
quieter lever than an upgrade, so `createDAO` verifies what it is handed:

```solidity
if (address(gov.token()) != votes || gov.timelock() != address(lock)) revert InvalidParams();
```

A mis-set or hostile module fails creation loudly instead of producing a DAO whose treasury is some
other timelock. `setDeployers` also emits `DeployersUpdated`, and it affects **future** DAOs only.

## 7. Sanctions and fail-closed behaviour

`_checkAuthorized` runs the tier gate and then `sanctionsGuard.checkBlocked(msg.sender)`.
`ISanctionsGuard` is fail-closed by contract — an unreachable or erroring oracle answers "not
allowed" — so a screening outage **refuses** creation rather than waving it through. The deploy script
refuses to deploy the factory on a chain with no recorded `sanctionsGuard`, because a factory wired to
`address(0)` would revert on every creation *or*, if the check were made optional, silently become an
ungated path.

The mini-app performs no screening of its own and must not: screening happens inside
`host.wallet.submit`, before any write rail is touched, which is strictly stronger than an app-side
check a package could skip.

## 8. Code size (EIP-170)

Inlining `new TimelockController/Governor/Token` compiled the factory to **44,706 bytes** against the
24,576-byte limit — deployable on a Hardhat node with `allowUnlimitedContractSize` and on no real
chain. Splitting the creation code into `StandardDAODeployers.sol` brings every contract under:

| Contract | Deployed bytes |
|---|---|
| `StandardDAOFactory` | 8,787 |
| `StandardDAOGovernor` | 14,868 |
| `StandardDAOToken` | 7,264 |
| `StandardDAOTimelockDeployer` | 6,807 |
| `StandardDAOTokenDeployer` | 11,862 |
| `StandardDAOGovernorDeployer` | 18,521 |

The deployer modules are stateless, permissionless and hold nothing. Anyone may call them; the result
is a stock OpenZeppelin contract owned by nobody, which confers no authority over anything that
exists. **Authority in this system is created only by the role wiring in §5**, never by who called a
deployer.

## 9. The Cancun decision, as a security fact

`StandardDAOFactory` and everything it deploys target **`cancun`**, against a repo-wide `paris` pin.
That pin is not stylistic: `shanghai` emits `PUSH0` and `cancun` emits `MCOPY`, and neither is
available on the live ETC 61 / Mordor 63 networks. OZ 5.4.0's `Governor` reaches `utils/Bytes.sol`,
which uses `mcopy`, so it cannot be compiled for those chains at all.

The exception is therefore enumerated file-by-file in `hardhat.config.js` and **pinned in both
directions** by `test/config/CompilerTargets.test.js`: a file added to the cancun set silently
becomes undeployable on ETC/Mordor, and an over-broad cancun target produces a perfectly successful
build with no other signal. Everything outside that list still fails the gate unless it declares
`paris`.

`TimelockController` and `StandardDAOToken` are in the set for a *different* reason worth keeping
straight: they do not use `mcopy`, but the factory **deploys** them, so their creation code is
embedded from its cancun job. Left on the default target their committed artifacts would describe
bytes that are not the bytes on chain — a source-verification mismatch on a live treasury contract.

## 10. What is explicitly NOT in this slice

- **No member-facing DAO administration console** (US6). On-chain the DAO already administers itself;
  what is missing is a screen, not an authority.
- **No rescue, sweep or pause on the factory.** It holds no funds — there is no `receive` and no
  `fallback`, and value sent to it reverts (asserted in the tests). The absence of a rescue function
  is the design, the same argument as `IBridgeRouter`'s missing claim-refund (spec 067).
- **No membership-NFT minting.** Bringing an existing `ERC721Votes`/soulbound token is supported;
  minting one is a separate primitive.
- **No fee.** `createDAO` registers no `FeeRouter` service and takes no value. If a creation fee is
  ever wanted it must go through the spec-060 `FeeRouter` and be catalogued under spec 089 — not
  hardcoded here.

## 11. Test coverage of the above

`test/clearpath/StandardDAOFactory.test.js` — 24 tests:

- creation, event shape, governor↔token↔timelock wiring, parameter round-trip;
- both token modes (fresh `ERC20Votes` with self-delegation; an existing `IVotes`);
- validation: EOA and non-`IVotes` contract rejected, empty name/symbol, zero voting period,
  quorum outside 1..100, timelock beyond the cap;
- gating: sub-tier refused, sanctioned wallet refused, `daoCount` unchanged in both cases;
- **role hygiene**: proposer/canceller are the governor and nobody else, executor open, admin
  renounced by the factory and held only by the timelock, the factory cannot `schedule`, the factory
  holds no funds and refuses value;
- **full lifecycle**: propose → vote → queue → execute moves treasury USDC exactly once (a second
  execute reverts, and execution before the delay elapses reverts); a defeated proposal can neither
  be queued nor executed and moves nothing;
- **registry linkage**: a factory-created governor passes `ExternalDAORegistry`'s validation and
  registers cleanly, and answers both probes it falls back through. This is what lets the created DAO
  reuse every existing ClearPath governance surface instead of growing a parallel one — and it is
  asserted on chain because the mini-app offers that registration *after* the member has already paid
  for the creation.

The package side is covered by `frontend/miniapps/clearpath/src/__tests__/CreateStandardDao.test.jsx`
— 17 tests, including the two honest-absence branches (pre-Cancun vs not-deployed) and the three
states that must never render as a created DAO (vault proposal, unread receipt, timeout).
