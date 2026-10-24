# Phase 0 research: passkey account recovery

Every unknown the spec left open, resolved against the repository and the deployment records.
Where something could not be settled from here it says so and names what would settle it.

---

## R1 — How can the chain be asked "which accounts list this owner?"

**Decision**: three search legs of very different cost, sequenced so the cheap ones ship first.

The two events exist and are the only on-chain record of ownership history:

| event | emitted by | owner indexed? | reachable how |
|---|---|---|---|
| `AccountCreated(address indexed account, bytes[] owners, uint256 nonce)` | the **factory** (one address) | **no** | `getLogs` filtered by factory address + topic0, decode `owners` |
| `AddOwner(uint256 indexed index, bytes owner)` | **each account** | **no** | `getLogs` filtered by topic0 with **no address filter** |

Neither indexes the owner, so neither can be filtered on the value being searched for. The
difference that matters is the *address* filter:

- `AccountCreated` is bounded to one contract. Log volume is one entry per account ever created.
- `AddOwner` has no address to filter on — a topic-only scan spans every contract on the chain.

**Alternatives considered**

- *Index the owner in the contracts.* Rejected: requires a contract change and would only cover
  accounts created after the upgrade, which is the opposite of what recovery needs.
- *Scan `AddOwner` client-side on Polygon.* Rejected as a launch strategy — see R3.

---

## R2 — Where does a log scan start?

**Decision**: it cannot start anywhere yet. **`accountFactory` has no recorded deploy block on any
chain**, and recording one is a prerequisite task, not an implementation detail.

Verified across every deployment record: the factory is present and CREATE2-identical everywhere —

```
accountFactory = 0xd519C25e9dEd0DAC586B764574100479CB318734   (137, 1, 80002, 10, 8453, 42161, 61, 63)
```

— but `deployBlocks` carries `safeProposalHub`, `feeRouter`, `miniAppRegistry`,
`backupPointerRegistry`, `wagerRegistry`, `membershipManager`, … and **never `accountFactory`**.

This repository already knows what that costs. `CLAUDE.md` records it for the sibling case:

> `safeProposalHub` needs a recorded deploy block per chain or proposal discovery is silently dead.

and every consumer degrades the same way — `scripts/ops/find-safe-proposals.js:40`,
`scripts/ops/verify-backup-pointer.js:36`, `scripts/ops/register-fee-service.js:221` all read
`record.deployBlocks?.X || 0`. A missing entry does not fail; it starts the scan at **block 0**,
which on Polygon is a scan that never completes. `register-fee-service.js:109` even prints a hint
about it, which is the honest version of the same degradation.

**Consequence for this plan**: recording `deployBlocks.accountFactory` per chain is **T-001**, and
no discovery leg may ship before it. Deriving it at runtime is not acceptable — that is the same
unbounded scan the block exists to avoid.

---

## R3 — Is the subgraph the answer?

**Decision**: not at launch, and it is a bigger change than it appears.

The subgraph indexes **no account entities at all**. `subgraph/subgraph.yaml` declares
`WagerRegistry`, `MembershipVoucher`, `MembershipManager` and the oracle adapters; there is no
`accountFactory` data source, and `schema.graphql` has no `Account` or owner type — the entities are
`Wager`, `Voucher`, `Pool`, `Token`, `Holder` and friends. Adding account indexing means a new data
source, new entities, a redeploy, and a backfill from the very deploy block R2 says is unrecorded.

It is also **Polygon-only** (start blocks in the 87–89M range are Polygon), while accounts exist on
every chain in the cohort. A subgraph-only strategy would recover an account on Polygon and fail on
Base with no honest way to say why.

**Alternatives considered**

- *Ship the subgraph first.* Rejected: it is the slowest path to a member who is locked out today,
  and it does not cover the estate.
- *Never use it.* Not adopted either — see the `AddOwner` leg in R4. It stays the likely long-term
  home for the expensive search, as a follow-up with its own spec.

---

## R4 — What is actually buildable now, and what does each leg cover?

**Decision**: three legs, deliberately sequenced by cost, each honest about what it does *not* find.

| leg | RPC cost | finds | does **not** find |
|---|---|---|---|
| **A. Nonce enumeration** | N × `getCode` (N ≈ 8) | accounts this key created at a nonce other than 0 | anything where the key was not the **sole** initial owner |
| **B. `AccountCreated` scan** | chunked `getLogs` over one address, from the factory's deploy block | every account this key was an **initial** owner of, including alongside other owners | keys **added later** |
| **C. `AddOwner` discovery** | topic-only scan across all addresses — or an index | keys added to an account after creation | — |

**Leg A is cheap and honest but narrow.** It must not be oversold: the headline failure in the spec
is a key that is *not the sole initial owner*, and nonce enumeration does not address that at all.
It is included because it costs almost nothing and closes one real sub-case.

**Leg B is the first leg that addresses the spec's headline case**, and it is gated on R2.

**Leg C is the expensive one** and is where the subgraph earns its place. It is explicitly **out of
this plan's first release** — the spec's US1 is satisfied for initial owners by leg B, and a key
added later is covered by the member-supplied address (US3) until C exists.

---

## R5 — What unblocks a locked-out member *today*, with no new infrastructure?

**Decision**: US3 (address entry) and US2 (never open an unverified session) ship **first**, before
any discovery leg.

Both are pure client changes over machinery that already exists:

- `readControllers` already reads `nextOwnerIndex` / `ownerAtIndex` and returns
  `{ deployed, controllers }`.
- The verification a member-supplied address needs is exactly the check
  `resolveAccountForCredential` already performs — the only change is *what the address came from*
  and *what happens when it does not match*.

This inverts the spec's own priority ordering (US1 is P1, US3 is P2) for **delivery sequence only**,
not for importance: US3 is the cheapest complete answer for a member who knows their address, and
US2 stops the silent wrong-account outcome that the spec identifies as the worst and quietest
failure. Neither waits on a deploy block, a scan strategy, or an index.

---

## R6 — Chain reads must move onto the spec-069 seam

**Decision**: migrate `readControllers` as part of this work (spec FR-012), not as a follow-up.

`smartAccount.js#readControllers` calls `defaultPublicClient(chainId)`, which builds a viem client
from `getNetwork(chainId).rpcUrl`. That is precisely what spec 069 forbids:

> **Never hand-build a provider from `NETWORKS[chainId].rpcUrl`.**

A member who configured their own endpoint gets their reads honoured everywhere except the one flow
that decides whether they can reach their account — and recovery is read-heavy, so it is the flow
most likely to hit a rate-limited default endpoint. Failover matters here for the same reason: an
`unverified` outcome that a working member endpoint would have turned into `resolved` is a member
told to go away for no reason.

---

## R7 — Bounding the search so it cannot become the next lockout

**Decision**: every leg is deadline-bounded and resolves `unverified` on expiry, never `none-found`.

This is not a general principle borrowed from elsewhere — it is the lesson of the incident that
produced this spec. v1.16.1 shipped because an unbounded wait on an external system (a WebAuthn
ceremony the platform never answered) turned a single failure into a permanent lockout. A log scan
across a busy chain is the same shape of risk: slow, external, and capable of never returning.

`unverified` must remain distinguishable from `none-found` all the way to the member, per spec
FR-004/FR-005, for the same reason spec 095 keeps `auth_unverifiable` out of the denial path and
spec 071 keeps `unreadable` out of the zero path.

---

## Open, and named as open

- **The historical log coverage of `AccountCreated` on each live chain is unverified.** It could not
  be checked from the planning environment — outbound RPC is not reachable here (`polygon-rpc.com`
  returned `HTTP request failed`). T-002 makes measuring it a task with a recorded result, because
  leg B's feasibility is a function of a number nobody has looked at.
- **Which failure shape the original report is in remains unestablished**, exactly as the spec says.
  Nothing in this plan depends on the answer: legs A, B and the address fallback cover all four
  shapes between them.
