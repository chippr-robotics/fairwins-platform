# Runbook: hand admin roles to the multisig

Moving `DEFAULT_ADMIN_ROLE`, `UPGRADER_ROLE` and every other privileged role from the deployer EOA
to the admin Safe, one network at a time.

**This is the most dangerous procedure in the repo.** A mistake here is not "redeploy and try
again" — an AccessControl contract whose last admin renounces is permanently unadministrable, and a
UUPS proxy whose last `UPGRADER_ROLE` holder renounces can never be upgraded again. Read the whole
runbook before running anything.

Tooling: `scripts/ops/transfer-roles.js`. Design notes are in its header.

---

## Before you start

| Check | Why it matters |
|---|---|
| The Safe exists **on this chain** with bytecode | Granting admin to an address that is a Safe elsewhere but nothing here bricks the contract. The script aborts on this, but know it first. |
| You can actually sign with the Safe | 2-of-3, and all three owners are **EOAs**, so any two sign on any chain: KMS HSM (`0x26235546…`, the `admin-signer-polygon` key — despite the name, secp256k1 is chain-agnostic and this is the owner on all 8 chains), Ledger (`0x12151853…`), Trezor (`0x48cBca63…`). This replaced an owner set that included a passkey CONTRACT with code only on Polygon, which made the old Safe an effective 2-of-2 everywhere else. |
| Fee services are registered | Renouncing FeeRouter admin with a service unregistered leaves routers reverting `ServiceUnknown` and nobody able to fix it. The script refuses, but plan around it. |
| You are not mid-deploy | Deploy scripts need `DEFAULT_ADMIN_ROLE` on the FeeRouter to register services. Finish deploying, then hand off. |

> ### ⚠ Read this before you copy an address out of this page
>
> **Current admin Safe: `0xcf76db7aa9Fb1BFe08E010468F3344bB45830447`** — 2-of-3, same address on
> Ethereum, Optimism, Polygon, Base, Arbitrum, ETC, Mordor and Amoy. Recorded per chain in
> `deployments/admin-safe.json`, which is what `transfer-roles.js` actually reads.
>
> Until 2026-09-01 this line named `0x8cc564E3dF4003c2F0a33C679c8DfE6237c5c3fa` as "current". That
> Safe was **superseded on 2026-08-22** and its owner set includes the compromised deploy EOA. The
> tooling was never wrong — it resolves the Safe per chain from the record — but an operator who
> pasted the address from this page into `MULTISIG=…` would have granted admin to the superseded
> Safe. Prefer the default resolution; reach for `MULTISIG=` only when you have a reason, and then
> take the value from `deployments/admin-safe.json`, never from prose.

The superseded Safe is **not decommissioned**: it still co-holds **79 (contract, role) pairs**
across chains 1 / 10 / 63 / 137 / 8453 / 42161 (measured 2026-09-01), including `UPGRADER_ROLE` on
every UUPS proxy. Removing it is a **revoke executed from the current Safe**, not a renounce — see
"Revoking the superseded Safe" below.

---

## The procedure

### 1. Plan — read-only, no transactions

```bash
npx hardhat run scripts/ops/transfer-roles.js --network <net>
```

Prints every managed contract on that network, every role it exposes, and who holds each. Roles are
**discovered from the ABI**, not hardcoded, so a role added later cannot be silently left behind.

Read it. Confirm the contract list matches what you expect that chain to host, and that the EOA
holds what you think it holds.

### 2. Grant — the multisig gains the roles

```bash
MODE=grant CONFIRM=<net> npx hardhat run scripts/ops/transfer-roles.js --network <net>
```

Without `CONFIRM=<net>` this is still a dry run and prints `WOULD GRANT`. With it, each role is
granted and then **re-read from the chain** — a mined receipt is not accepted as proof the role is
held.

After this step **both** the EOA and the multisig hold every role. Nothing is lost yet, and nothing
is protected yet. This is the safe resting state, and it is fine to stay here for a while.

### 3. Verify — independently, and not in the same sitting

Re-run step 1 and confirm every row reads `EOA=yes multisig=yes`.

Then prove the multisig can actually *use* a role, on a low-stakes one first. From the Safe, execute
something harmless and observable — e.g. `setFeeBps` on a service to its current value, or a pause
followed immediately by an unpause on a network with nothing live. If the Safe cannot execute, stop.
You have not lost anything yet; renouncing now is what would make it permanent.

> Do steps 2 and 3 on **Mordor first**. It is a testnet with the same contracts and the same Safe
> address, so a mistake there costs nothing and teaches you the same lesson.

### 4. Renounce — the EOA gives up the roles

```bash
MODE=renounce CONFIRM=<net> npx hardhat run scripts/ops/transfer-roles.js --network <net>
```

For each role the script re-reads the chain and **refuses** unless the multisig verifiably holds it
right now. It does not trust step 2's output, the deployment record, or its own earlier run.

It additionally refuses to renounce `DEFAULT_ADMIN_ROLE` on the FeeRouter while any known fee
service is unregistered.

Restrict the blast radius while you build confidence:

```bash
MODE=renounce ONLY=feeRouter CONFIRM=<net> npx hardhat run scripts/ops/transfer-roles.js --network <net>
```

### 5. Confirm the end state

Re-run step 1. Every row should read `EOA=no multisig=yes`. Anything still showing `EOA=yes` was
skipped for a reason the output states — read it rather than forcing it.

---

## Order of networks

Cheapest and least consequential first, so every mistake is made where it does not matter:

**Mordor 63** (testnet, full rehearsal) → **ETC 61** → **Optimism 10** → **Base 8453** →
**Arbitrum 42161** → **Polygon 137** (most live members) → **Ethereum 1** (most expensive).

Do not batch. One network, verified end to end, before the next.

---

## If something goes wrong

**"multisig does not hold it. Run MODE=grant first"** — working as intended. The grant did not land
for that role. Re-run step 2 and read its output rather than reaching for the renounce.

**"has NO BYTECODE on chain N"** — the Safe is not deployed there. Run
`scripts/ops/deploy-admin-safe.js` for that network first. Do not override with `MULTISIG=` unless
you have verified that address is a live Safe *on that chain*.

**"REFUSING — fee services not registered"** — finish the deploy
(`scripts/ops/register-fee-service.js`, or re-run the router deploy) before handing off the
FeeRouter.

**The EOA renounced but the multisig cannot sign.** There is no recovery. This is the failure the
runbook exists to prevent, which is why step 3 is not optional and why Mordor comes first.

**A grant landed on the wrong address.** Not fatal by itself: the EOA still holds the role at that
point. Revoke the bad grant (`revokeRole`) *before* renouncing anything.

---

## Revoking the superseded Safe

**This is now the main outstanding work of the handoff, and it is a different operation from the
one above.** Measured on 2026-09-01, across the eight managed contracts on every chain that hosts
them:

| Holder | (contract, role) pairs |
|---|---|
| Deploy EOA `0x52502d04…` | **1** — Mordor 63 `feeRouter` `DEFAULT_ADMIN_ROLE` |
| Superseded Safe `0x8cc564E3…` | **79** — chains 1 (11), 10 (11), 63 (12), 137 (23), 8453 (11), 42161 (11) |

Steps 1–5 above move roles off the **EOA**, and after the Mordor renounce there is nothing left
there. They cannot move roles off the **old Safe**: `renounceRole` is self-only, so a renounce
would have to be executed *by* the old Safe — assembling a 2-of-3 whose owner set includes the
compromised deploy key, which is precisely what we are trying to stop relying on.

**The current Safe does not need it.** It holds `DEFAULT_ADMIN_ROLE` on every one of those
contracts, and in OpenZeppelin AccessControl a role's admin may `revokeRole` any account. So the
removal is a **`revokeRole` executed from `0xcf76db7a…`**, unilateral, with the old Safe's signers
never involved.

The tool is `scripts/ops/revoke-stale-admin.js` (`npm run ops:revoke-stale-admin`). It is separate
from `transfer-roles.js` on purpose: that script signs with an EOA and its only removal verb is
self-only `renounceRole`, neither of which fits an operation executed by a multisig against a third
party.

```bash
# 1. plan — read-only, no signing, no transactions
node scripts/ops/revoke-stale-admin.js --chain 63 --target superseded

# 2. build — compute the MultiSend batch + safeTxHash, write a local proposal
node scripts/ops/revoke-stale-admin.js --chain 63 --target superseded --mode build

# 3. approve — the KMS owner calls approveHash (1 of 2)
node scripts/ops/revoke-stale-admin.js --chain 63 --target superseded --mode approve --confirm 63

# 4. a second owner approves on the Ledger or Trezor (2 of 2) — hardware, not this tool

# 5. execute — anyone may send it once the threshold is met
node scripts/ops/revoke-stale-admin.js --chain 63 --target superseded --mode execute --confirm 63
```

`--target` takes `superseded`, `deployer`, or an address.

**Four things that will bite you, in the order they will:**

- **The KMS owner needs GAS on the chain it approves.** `approveHash` must be sent *by* the
  approving owner. Measured 2026-09-02, `0x26235546…` held gas on **Polygon 137 only** and zero on
  1 / 10 / 63 / 8453 / 42161 — so on five of six chains this stops at step 3 until it is funded.
  The tool preflights the balance and says so rather than failing as an opaque "insufficient funds"
  from inside the signer. Two *hardware* owners approving instead needs no KMS gas at all.
- **The safeTxHash is pinned to the Safe's nonce.** Any other Safe transaction that executes first
  invalidates it, and approvals do **not** carry over — rebuild and re-approve. The estate usually
  has both a superseded Safe and a retired EOA to clear on a chain, and building both before
  executing either produces two hashes at the same nonce of which only one can ever run. The tool
  detects that case and names the sibling.
- **`DEFAULT_ADMIN_ROLE` goes last, per contract.** It is the admin *of* the other roles, so
  revoking it first inside the same batch removes the authority the later revokes need and they
  revert — leaving the stale holder holding exactly what you most wanted gone. The tool orders the
  batch this way; do not reorder it.
- **`execTransaction` returns false on inner failure instead of reverting.** A mined receipt is not
  proof. The tool re-reads every role off the chain afterwards and reports what is still held; treat
  anything else as unverified.

The tool refuses outright if the target is the current Safe, or if any role in the batch is one the
current Safe does not itself hold — that second case would remove the last holder and leave the role
unadministrable forever.

Not covered here and still open: `feeRouter.treasury()` points at the superseded Safe on chains
1 / 10 / 8453 / 42161. That is a `setTreasury` call, not a role change — see issue #966.

---

## What this does not cover

- **Wager Pools have no pause and no admin.** `WagerPool` clones are immutable and unpausable, and
  the factory's levers cannot reach pools already holding funds. No handoff changes that; it needs
  its own work.
- **The Safe's own owners.** Changing who controls the Safe is a Safe transaction, not this script.
- **Contracts with no AccessControl.** Skipped automatically and reported as such.

Related: [fee operations](./fee-operations.md) · [bridge & liquidity operations](./bridge-liquidity-operations.md) · [Protect policy operations](./protect-policy-operations.md)
