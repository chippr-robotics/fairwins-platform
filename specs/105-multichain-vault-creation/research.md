# Research — Spec 105: Guided Multichain Vault Creation

All decisions verified against the live tree on 2026-09-05 (branch base `staging@67dad225`).

## D1 — Same address on every network: chain-independent initializer

**Decision**: Multichain vaults deploy with the spec-043 initializer — owners + threshold +
canonical fallback handler, **no policy setup delegatecall** — and a per-vault `saltNonce` fixed at
creation. The canonical Safe v1.4.1 set (`config/safeContracts.js`) is byte-identical on all six
custody chains (verified: singletonL2 `0x29fcB4…`, proxyFactory `0x4e1DCf…`, fallbackHandler
`0xfd0732…` on 10/61/63/137/8453/42161), so an identical initializer + saltNonce yields an identical
CREATE2 address everywhere (`computeVaultAddress` is already pure and unit-tested).

**Rationale**: The rules payload embeds the chain's own stable-token address
(`starterStableAsset(chainId)` → per-chain `paymentToken`), so a policy-bearing initializer is
byte-different per chain and the addresses diverge — the exact thing the feature forbids. Rules that
are *semantically* identical must therefore be installed per network, post-deploy (D2).

**Alternatives rejected**: (a) policy-in-initializer (spec-049 path) — breaks address identity;
kept only as the code path existing single-network vaults already used. (b) Per-chain addresses —
contradicts spec 102's "a vault is an ADDRESS" and the user's explicit ask.

## D2 — Installing rules per network

**Decision**: After each network's proxy deploys, the orchestrator installs the realized rules with
the existing two-step, ordered pair `buildAdoptV2Txs(vault, chainId, rules, cooldown)` —
`setRules` on the guard **then** `setGuard` on the Safe (rules exist before the guard activates; no
half-set gap, the established spec-068 ordering).

- **Creator alone meets threshold** (Joint 1-of-2, Complex m=1): execute directly via
  `execTransaction` with the pre-validated signature encoding (`v=1`, owner == msg.sender —
  `buildApprovedHashSignatures` in `vaultTransaction.js` already builds it). Two transactions per
  network on the signer rail; the passkey rail batches deploy + both installs in ONE `sendCalls`
  (the CREATE2 address is known before deployment, so calldata can target it).
- **Creator alone does NOT meet threshold** (Controlled n-of-n, Complex m>1): propose both txs
  through the existing `safeProposalHub` queue + `approveHash` by the creator. Co-owners approve
  from their own devices via the existing queue; every surface shows the rules as **awaiting
  approval** on that network until executed (spec FR-010).

**Rationale**: Reuses the propose/approve/execute machinery and its tests wholesale; the only new
logic is sequencing. The guard address (`safePolicyGuardV2` = `0xf18B81…`) and setup lib
(`policyGuardSetup` = `0xD0CB9D…`) are identical on all six chains (verified in `deployments/`),
but that identity is NOT relied on — per-chain resolution stays `getPolicyEngineV2Addresses`.

## D3 — Realizing the tile grid in V2 rules

**Decision**: One semantic config `{cap, cooldown, allowedMoney, bigSends}` realizes per chain as:

1. `{asset: stable(chain), perTxLimit: cap, banded: true, windowLimit: cap}` — the everyday lane.
   `banded: true` makes `perTxLimit` a **match bound** (SafePolicyGuardV2.sol L108, `BandedNeedsLimit`
   guard L280), so an over-cap send does not match this rule at all.
2. `{asset: stable(chain), approvers: all owners, approvalsRequired: N}` — the big-send lane an
   over-cap amount falls to; identical asset scope, so the engine's one fall-through applies.
3. `{asset: ANY_ASSET, approvers: all owners, approvalsRequired: N}` — "other money needs a full
   vote" (the Allowed-money tile's default; the tile can relax it to a permissive catch-all,
   which is today's starter behaviour).

Cooldown = the Wait tile. Everything validates through the existing `validateRulesConfig` (with
`owners`, so approvers-not-owners is caught at build time) and describes through `describeRulesV2`
for the live summary line. Networks with no configured stable (`starterStableAsset → null`) drop
rules 1–2 and disclose it per the spec edge case.

**Alternatives rejected**: extending the guard contract (not needed — the vocabulary already
expresses every tile); reusing V1 `configureRules` (V1 exists on Polygon only; never created fresh
per spec 068 FR-020).

## D4 — Creation record: a new synced object

**Decision**: New store `lib/custody/vaultCreationRecords.js` (userStorage, account-scoped,
**non-network-scoped** — the record is precisely the chain-independent facts), registered in
`lib/backup/syncedObjects.js`. Shape per record (keyed by vault address):
`{ address, owners[], threshold, saltNonce, presetType, rules: semanticConfig, createdAt }`.
Records are **immutable once written**; sync merge is union-by-address with existing-entry-wins.
No key material, no secrets — addresses and public parameters only.

**Rationale**: FR-016 (survives device moves) and FR-007 (later networks hit the same address)
both require replaying the ORIGINAL initializer; `saltNonce` and owners-at-creation exist nowhere
on-chain in readable form (`ProxyCreation` logs neither). The spec-062 `legacyRecoveredKeys`
precedent covers the synced-object mechanics.

**Consequence made explicit**: a vault loaded by address has no record ⇒ "Add a network" states the
honest unavailability reason (FR-018). Owner drift since creation ⇒ FR-017's original-owners
disclosure, computed by diffing the record against the live owner set the details view already reads.

## D5 — Deployment orchestration + status truth

**Decision**: A hook (`useVaultDeployment`) drives networks **sequentially** — per network:
resolve write rail (`resolveWriteRail`, signer-first) → switch wallet at that network's turn
(spec-102 switch-first submit precedent) → deploy → install rules (D2) → next. Status per network:
`not-selected / queued / awaiting-signature / deploying / confirming / live / already-live / failed`.
In-flight states are session-local; **durable truth is re-derived from the chain** (`getCode` at the
predicted address ⇒ live; hub/guard reads ⇒ rules active vs pending), so reopening on any device
shows honest status with no shared draft (FR-009, SC-005). `already-live` comes from the getCode
probe before sending (FR-019). Per-network failures isolate; retry re-enters that network's step.

**Alternatives rejected**: parallel deploys (one wallet, one active chain — a signer can only be on
one network at a time; parallelism would mean racing switch requests); a persisted orchestration
draft (a second source of truth that can lie about chains; the chain already holds the answer).

## D6 — Presets

**Decision**: Joint = exactly 2 owners, threshold 1. Controlled = threshold == ownerCount (n ≥ 2).
Complex = free m-of-n via the existing threshold control. The existing 1-of-1-no-rules refusal is
preserved verbatim (spec FR-003); with rules installed post-deploy, a Complex 1-of-1 with rules has
a disclosed window where the vault is live before its rules land — the flow keeps the vault out of
"done" until that network's installs are sent, and the Done sheet names anything still pending.

## D7 — Details: one card, network rows

**Decision**: Rebuild `VaultDetailsView`'s per-network accordion into: address block ("same address
on every chain" only when the deployed set genuinely shares it), a NETWORKS section of compact rows
(status + per-network arrangement + inline Deploy for cohort chains absent from the reference store,
gated on a creation record), OWNERS once (identity-resolved — existing address book > callsign >
ENS > generated), RULES once from the record's semantic config cross-checked against per-chain
`readPolicyV2` (drift ⇒ named disclosure; unreadable ⇒ row-level retry + "shared facts cover only
the networks that answered"). Acting-as radio and Remove stay as-is. Cross-chain reads reuse the
`useVaultQueueAcrossChains` pattern (per-chain isolation, 20 s ceiling, four-state).

## D8 — Queue readability

**Decision**: New pure module `lib/custody/describeProposal.js`: ERC-20 `transfer`/native sends →
"Send <amount> <symbol>" + recipient; owner-management (`addOwnerWithThreshold`/`removeOwner`/
`changeThreshold`) → "Add owner"/"Remove owner"/"Change approvals"; policy txs via the existing
`classifyPolicyProposalV2`; anything else → `null` ⇒ the current honest raw rendering. "Needs you"
= pending ∧ member is owner ∧ member ∉ `approvers` (both already read by `vaultProposalReads`).
Filter chips (All / Needs you / per-network-with-items) are pure view state over the existing
cross-chain read — the four-state honesty and partial-total naming are untouched.

## D9 — What this feature does NOT touch

No contract changes. No new dependency (constitution: no new core tech). No subgraph change. No
gateway change. The spec-073 host object is untouched. `CreateVaultWizard`'s single-form flow is
replaced; `RuleComposer` remains for advanced policy governance on the details/policy surfaces.
